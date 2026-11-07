import { CALLBACK_TOKEN_TTL_MS, CallbackStore } from '../server/callback-store'
import { resolveLxnsCallbackPath } from '../server/lxns-callback'
import type { DivingFishOAuth } from '../providers/diving-fish-oauth'
import { ProviderOAuthRequiredError } from '../providers/errors'
import type { DebugTracer } from '../utils/debug'
import type { Config, LxnsOAuthMode } from '../config'

const LXNS_AUTHORIZE_ORIGIN = 'https://maimai.lxns.net'
const LXNS_AUTHORIZE_PATH = '/oauth/authorize'
export const LXNS_OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'

export type { LxnsOAuthMode } from '../config'
export type LxnsAuthorizationRequest = {
  mode: LxnsOAuthMode
  url: string
}

export class PublicCallbackUnavailableError extends Error {
  constructor(message = '未完成 LXNS OAuth 配置。') {
    super(message)
    this.name = 'PublicCallbackUnavailableError'
  }
}

export class UpdateFlowError extends Error {
  constructor(message = '绑定服务流程失败。') {
    super(message)
    this.name = 'UpdateFlowError'
  }
}

export interface UpdateSessionLocator {
  userId: string
  platform: string
  channelId: string
  direct: boolean
  pendingCommand?: string
  send(text: string, options?: { retryCommand?: string }): Promise<void>
  replay(command: string): Promise<void>
}

interface LxnsState extends UpdateSessionLocator {
  redirectUri: string
}

interface LxnsPendingAuthorization {
  mode: LxnsOAuthMode
  redirectUri: string
  pendingCommand?: string
  expiresAt: number
}

export interface UpdateServiceOptions {
  publicBaseUrl: string
  lxnsOAuth: Config['lxnsOAuth']
  lxns: {
    exchangeOAuthCode(userId: string, code: string, redirectUri: string): Promise<unknown>
    removeOAuthToken(userId: string): Promise<void>
    hasOAuthToken(userId: string): Promise<boolean>
  }
  divingFishOAuth: Pick<DivingFishOAuth, 'begin' | 'hasActiveAuthorization' | 'unbind' | 'dispose'>
  lxnsStates?: CallbackStore<LxnsState>
  debug?: DebugTracer
}

function publicBaseUrl(value: string) {
  if (!value) {
    throw new PublicCallbackUnavailableError('缺少 publicBaseUrl 或 Koishi Server selfUrl。')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PublicCallbackUnavailableError('publicBaseUrl 或 Koishi Server selfUrl 不是有效 URL。')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PublicCallbackUnavailableError('publicBaseUrl 或 Koishi Server selfUrl 必须是无账号信息的 HTTP(S) 地址。')
  }
  url.hash = ''
  url.search = ''
  return url
}

function publicRoute(base: string, path: string) {
  return new URL(path, publicBaseUrl(base)).href
}

export function lxnsCallbackUrl(publicUrl: string, callbackPath?: string) {
  return publicRoute(publicUrl, resolveLxnsCallbackPath(callbackPath))
}

export function lxnsAuthorizationUrl(clientId: string, redirectUri: string) {
  const authorize = new URL(LXNS_AUTHORIZE_PATH, LXNS_AUTHORIZE_ORIGIN)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('client_id', clientId.trim())
  authorize.searchParams.set('redirect_uri', redirectUri)
  authorize.searchParams.set('scope', 'read_player')
  return authorize.href
}

export class UpdateService {
  private readonly lxnsStates: CallbackStore<LxnsState>
  private readonly lxnsPending = new Map<string, LxnsPendingAuthorization>()
  private disposed = false

  constructor(private readonly options: UpdateServiceOptions) {
    this.lxnsStates = options.lxnsStates ?? new CallbackStore<LxnsState>()
  }

  async beginDivingFishOAuth(session: UpdateSessionLocator) {
    this.assertActive()
    return this.options.divingFishOAuth.begin(session)
  }

  async getBindingStatus(userId: string) {
    const [lxns, divingFish] = await Promise.all([
      this.options.lxns.hasOAuthToken(userId),
      this.options.divingFishOAuth.hasActiveAuthorization(userId),
    ])
    return { lxns, divingFish }
  }

  async unbindDivingFish(userId: string) {
    this.assertActive()
    await this.options.divingFishOAuth.unbind(userId)
  }

  async beginLxnsOAuth(session: UpdateSessionLocator): Promise<LxnsAuthorizationRequest> {
    this.assertActive()
    this.options.debug?.event('oauth.lxns.begin', {
      session,
      lxnsOAuth: this.options.lxnsOAuth,
      publicBaseUrl: this.options.publicBaseUrl,
    })
    const mode = this.options.lxnsOAuth.mode
    const missing = [
      !this.options.lxnsOAuth.enabled && 'lxnsOAuth.enabled',
      !this.options.lxnsOAuth.clientId.trim() && 'lxnsOAuth.clientId',
      !this.options.lxnsOAuth.clientSecret.trim() && 'lxnsOAuth.clientSecret',
      !this.options.lxnsOAuth.tokenCipherKey.trim() && 'lxnsOAuth.tokenCipherKey',
    ].filter((name): name is string => Boolean(name))
    if (missing.length) {
      throw new PublicCallbackUnavailableError(
        `未完成 LXNS OAuth 配置，缺少或未启用：${missing.join('、')}。`,
      )
    }
    const redirectUri = mode === 'callback'
      ? lxnsCallbackUrl(this.options.publicBaseUrl, this.options.lxnsOAuth.callbackPath)
      : LXNS_OOB_REDIRECT_URI
    const authorize = new URL(lxnsAuthorizationUrl(
      this.options.lxnsOAuth.clientId,
      redirectUri,
    ))
    let state: string | undefined
    if (mode === 'callback') {
      state = this.lxnsStates.issue({ ...session, redirectUri })
      authorize.searchParams.set('state', state)
    }
    this.pendingAuthorization(session.userId, mode, redirectUri, session.pendingCommand)
    this.options.debug?.event('oauth.lxns.ready', {
      session,
      state,
      mode,
      redirectUri,
      authorizationUrl: authorize.href,
      lxnsOAuth: this.options.lxnsOAuth,
    })
    return { mode, url: authorize.href }
  }

  async unbindLxns(userId: string) {
    this.assertActive()
    this.lxnsStates.deleteWhere(session => session.userId === userId)
    this.lxnsPending.delete(userId)
    await this.options.lxns.removeOAuthToken(userId)
  }

  async completeLxnsOAuth(state: string, code: string) {
    this.assertActive()
    this.options.debug?.event('oauth.lxns.callback', { state, code })
    const session = this.lxnsStates.consume(state)
    this.lxnsPending.delete(session.userId)
    const redirectUri = session.redirectUri
    try {
      await this.options.lxns.exchangeOAuthCode(session.userId, code, redirectUri)
    } catch (error) {
      this.options.debug?.failure('oauth.lxns.failure', error, {
        state,
        code,
        session,
        redirectUri,
      })
      await session.send(
        '落雪授权绑定失败，请重试。',
        { retryCommand: '/mai 绑定落雪' },
      )
      throw error
    }
    this.options.debug?.event('oauth.lxns.success', {
      state,
      code,
      session,
      redirectUri,
    })
    await session.send('落雪授权绑定成功。')
    if (session.pendingCommand) await session.replay(session.pendingCommand)
  }

  async completeLxnsOAuthCode(
    userId: string,
    code: string,
    session: UpdateSessionLocator,
  ) {
    this.assertActive()
    const normalizedCode = code.trim()
    if (!normalizedCode) throw new UpdateFlowError('落雪授权码不能为空。')
    const pending = this.takePendingAuthorization(userId)
    const redirectUri = pending?.redirectUri ?? LXNS_OOB_REDIRECT_URI
    const pendingCommand = pending?.pendingCommand
    this.options.debug?.event('oauth.lxns.code', { userId, redirectUri, hasPendingCommand: Boolean(pendingCommand) })
    try {
      await this.options.lxns.exchangeOAuthCode(userId, normalizedCode, redirectUri)
    } catch (error) {
      if (!(error instanceof ProviderOAuthRequiredError)) throw error
      this.options.debug?.failure('oauth.lxns.failure', error, { userId, redirectUri })
      await session.send(
        '落雪授权码无效或已过期，请重新发送“/mai 绑定落雪”获取新的授权链接。',
        { retryCommand: '/mai 绑定落雪' },
      )
      return
    }
    this.options.debug?.event('oauth.lxns.success', { userId, redirectUri })
    await session.send('落雪授权绑定成功。')
    if (pendingCommand) await session.replay(pendingCommand)
  }

  hasPendingLxnsOAuthCode(userId: string) {
    this.prunePendingAuthorizations()
    return this.lxnsPending.get(userId)?.mode === 'authorization-code'
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lxnsStates.dispose()
    this.lxnsPending.clear()
    this.options.divingFishOAuth.dispose()
  }

  private pendingAuthorization(
    userId: string,
    mode: LxnsOAuthMode,
    redirectUri: string,
    pendingCommand?: string,
  ) {
    this.prunePendingAuthorizations()
    this.lxnsPending.set(userId, {
      mode,
      redirectUri,
      pendingCommand,
      expiresAt: Date.now() + CALLBACK_TOKEN_TTL_MS,
    })
  }

  private takePendingAuthorization(userId: string) {
    this.prunePendingAuthorizations()
    const pending = this.lxnsPending.get(userId)
    this.lxnsPending.delete(userId)
    return pending
  }

  private prunePendingAuthorizations() {
    const now = Date.now()
    for (const [userId, pending] of this.lxnsPending) {
      if (pending.expiresAt <= now) this.lxnsPending.delete(userId)
    }
  }

  private assertActive() {
    if (this.disposed) throw new UpdateFlowError('绑定服务已停止。')
  }
}
