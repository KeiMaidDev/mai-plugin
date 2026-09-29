import { CallbackStore } from '../server/callback-store'
import { resolveLxnsCallbackPath } from '../server/lxns-callback'
import type { DivingFishOAuth } from '../providers/diving-fish-oauth'
import type { DebugTracer } from '../utils/debug'

const LXNS_AUTHORIZE_ORIGIN = 'https://maimai.lxns.net'
const LXNS_AUTHORIZE_PATH = '/oauth/authorize'

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

interface LxnsState extends UpdateSessionLocator {}

export interface UpdateServiceOptions {
  publicBaseUrl: string
  oauth: {
    enabled: boolean
    authorizationUrl: string
    callbackPath?: string
    clientId: string
    clientSecret: string
    tokenCipherKey: string
  }
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

function validatedLxnsAuthorizationUrl(
  rawUrl: string,
  clientId: string,
  redirectUri: string,
) {
  let authorize: URL
  try {
    authorize = new URL(rawUrl.trim())
  } catch {
    throw new PublicCallbackUnavailableError('oauth.authorizationUrl 不是有效 URL。')
  }
  const uniqueParameter = (name: string) => authorize.searchParams.getAll(name).length === 1
  if (authorize.origin !== LXNS_AUTHORIZE_ORIGIN || authorize.pathname !== LXNS_AUTHORIZE_PATH) {
    throw new PublicCallbackUnavailableError(
      'oauth.authorizationUrl 必须使用 https://maimai.lxns.net/oauth/authorize。',
    )
  }
  if (authorize.username || authorize.password || authorize.hash) {
    throw new PublicCallbackUnavailableError('oauth.authorizationUrl 不能包含账号信息或 URL 片段。')
  }
  if (!uniqueParameter('response_type') || authorize.searchParams.get('response_type') !== 'code') {
    throw new PublicCallbackUnavailableError('oauth.authorizationUrl 必须包含唯一的 response_type=code。')
  }
  if (!uniqueParameter('client_id')) {
    throw new PublicCallbackUnavailableError('oauth.authorizationUrl 必须包含唯一的 client_id。')
  }
  if (authorize.searchParams.get('client_id') !== clientId.trim()) {
    throw new PublicCallbackUnavailableError(
      'oauth.authorizationUrl 中的 client_id 与 oauth.clientId 不一致。',
    )
  }
  if (!uniqueParameter('redirect_uri')) {
    throw new PublicCallbackUnavailableError('oauth.authorizationUrl 必须包含唯一的 redirect_uri。')
  }
  if (authorize.searchParams.get('redirect_uri') !== redirectUri) {
    throw new PublicCallbackUnavailableError(
      'oauth.authorizationUrl 中的 redirect_uri 与插件实际回调地址不一致。',
    )
  }
  if (!uniqueParameter('scope') || !authorize.searchParams.get('scope')?.trim()) {
    throw new PublicCallbackUnavailableError('oauth.authorizationUrl 必须包含非空且唯一的 scope。')
  }
  return authorize
}

export function lxnsAuthorizationUrl(
  rawUrl: string,
  clientId: string,
  redirectUri: string,
  state: string,
) {
  const authorize = validatedLxnsAuthorizationUrl(rawUrl, clientId, redirectUri)
  authorize.searchParams.set('state', state)
  return authorize.href
}

export class UpdateService {
  private readonly lxnsStates: CallbackStore<LxnsState>
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

  async beginLxnsOAuth(session: UpdateSessionLocator) {
    this.assertActive()
    this.options.debug?.event('oauth.lxns.begin', {
      session,
      oauth: this.options.oauth,
      publicBaseUrl: this.options.publicBaseUrl,
    })
    const missing = [
      !this.options.oauth.enabled && 'oauth.enabled',
      !this.options.oauth.authorizationUrl.trim() && 'oauth.authorizationUrl',
      !this.options.oauth.clientId.trim() && 'oauth.clientId',
      !this.options.oauth.clientSecret.trim() && 'oauth.clientSecret',
      !this.options.oauth.tokenCipherKey.trim() && 'oauth.tokenCipherKey',
    ].filter((name): name is string => Boolean(name))
    if (missing.length) {
      throw new PublicCallbackUnavailableError(
        `未完成 LXNS OAuth 配置，缺少或未启用：${missing.join('、')}。`,
      )
    }
    const redirectUri = lxnsCallbackUrl(
      this.options.publicBaseUrl,
      this.options.oauth.callbackPath,
    )
    const authorize = validatedLxnsAuthorizationUrl(
      this.options.oauth.authorizationUrl,
      this.options.oauth.clientId,
      redirectUri,
    )
    const state = this.lxnsStates.issue(session)
    authorize.searchParams.set('state', state)
    this.options.debug?.event('oauth.lxns.ready', {
      session,
      state,
      redirectUri,
      authorizationUrl: authorize.href,
      oauth: this.options.oauth,
    })
    return authorize.href
  }

  async unbindLxns(userId: string) {
    this.assertActive()
    this.lxnsStates.deleteWhere(session => session.userId === userId)
    await this.options.lxns.removeOAuthToken(userId)
  }

  async completeLxnsOAuth(state: string, code: string) {
    this.assertActive()
    this.options.debug?.event('oauth.lxns.callback', { state, code })
    const session = this.lxnsStates.consume(state)
    const redirectUri = lxnsCallbackUrl(
      this.options.publicBaseUrl,
      this.options.oauth.callbackPath,
    )
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

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lxnsStates.dispose()
    this.options.divingFishOAuth.dispose()
  }

  private assertActive() {
    if (this.disposed) throw new UpdateFlowError('绑定服务已停止。')
  }
}
