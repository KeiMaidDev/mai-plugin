import type {
  DivingFishImportRecord,
  DivingFishUpdateResponse,
} from '../providers/diving-fish'
import { CallbackStore } from '../server/callback-store'
import { resolveLxnsCallbackPath } from '../server/lxns-callback'
import { load } from 'cheerio'
import type { Context } from 'koishi'
import type { DebugTracer } from '../utils/debug'
import type { DivingFishOAuth } from '../providers/diving-fish-oauth'
import { ProviderConsentScopeError, ProviderOAuthRequiredError, ProviderRateLimitError, ProviderScopeError, ProviderPrivacyError } from '../providers/errors'

const WAHLAP_ORIGIN = 'https://tgk-wcaime.wahlap.com'
const LXNS_AUTHORIZE_ORIGIN = 'https://maimai.lxns.net'
const LXNS_AUTHORIZE_PATH = '/oauth/authorize'
const WAHLAP_AUTHORIZE_PATH = '/wc_auth/oauth/authorize/maimai-dx'
const WAHLAP_CALLBACK_PATH = '/wc_auth/oauth/callback/maimai-dx'
const WAHLAP_MOBILE_ORIGIN = 'https://maimai.wahlap.com'
const WAHLAP_RECORD_PATH = '/maimai-mobile/record/musicSort/search/'
const WAHLAP_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const WAHLAP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/132 Safari/537.36 MicroMessenger/7.0'

export class PublicCallbackUnavailableError extends Error {
  constructor(message = '未完成 LXNS OAuth 配置。') {
    super(message)
    this.name = 'PublicCallbackUnavailableError'
  }
}

export class UpdateBindingRequiredError extends Error {
  constructor() {
    super('请先发送“/mai 绑定水鱼”完成账号授权。')
    this.name = 'UpdateBindingRequiredError'
  }
}

export class UpdateFlowError extends Error {
  constructor(message = '成绩更新流程失败。') {
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
interface DivingFishState extends UpdateSessionLocator {}

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
  divingFishOAuth: Pick<DivingFishOAuth, 'begin' | 'hasBinding' | 'hasActiveAuthorization' | 'unbind' | 'dispose'>
  fetchAuthorizationRedirect(): Promise<string>
  fetchDivingFishRecords(callbackUrl: string): Promise<DivingFishImportRecord[]>
  importDivingFishRecords(
    userId: string,
    records: DivingFishImportRecord[],
  ): Promise<DivingFishUpdateResponse>
  lxnsStates?: CallbackStore<LxnsState>
  updateTokens?: CallbackStore<DivingFishState>
  debug?: DebugTracer
}

export interface WahlapResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface WahlapRequestOptions {
  headers?: Record<string, string>
  redirect?: 'follow' | 'manual'
}

export interface WahlapRecordFetcherOptions {
  request(url: string, options: WahlapRequestOptions): Promise<WahlapResponse>
}

function safeWahlapUrl(raw: string, allowedOrigins: readonly string[]) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UpdateFlowError('invalid Wahlap redirect')
  }
  if (!allowedOrigins.includes(url.origin) || url.username || url.password) {
    throw new UpdateFlowError('invalid Wahlap redirect')
  }
  return url
}

function headerValues(value: string | string[] | undefined) {
  return Array.isArray(value) ? value : value ? [value] : []
}

const SET_COOKIE_BOUNDARY = /,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/gu

function splitSetCookie(value: string) {
  if (value.length > 16_384) throw new UpdateFlowError('Wahlap login cookie was unavailable.')
  return value.split(SET_COOKIE_BOUNDARY).map(cookie => cookie.trim())
}

function cookieHeader(headers: WahlapResponse['headers']) {
  const values = headerValues(headers['set-cookie']).flatMap(splitSetCookie)
  if (values.length > 32) throw new UpdateFlowError('Wahlap login cookie was unavailable.')
  const cookies = values.map(value => value.split(';', 1)[0].trim()).filter(value => (
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\r\n;]{0,2048}$/.test(value)
  ))
  const result = cookies.join('; ')
  if (!result || result.length > 4_096) throw new UpdateFlowError('Wahlap login cookie was unavailable.')
  return result
}

function iconValue(source: string) {
  const value = source.split('music_icon_').at(-1)?.split('.')[0] ?? ''
  return value === 'back' ? '' : value
}

function parseWahlapRecords(html: string, difficulty: number): DivingFishImportRecord[] {
  if (Buffer.byteLength(html, 'utf8') > WAHLAP_MAX_RESPONSE_BYTES) {
    throw new UpdateFlowError('Wahlap response exceeded the configured size limit.')
  }
  if (html.includes('错误码：')) throw new UpdateFlowError('Wahlap rejected the score request.')
  const $ = load(html)
  const records: DivingFishImportRecord[] = []
  const forms = $("form[action='https://maimai.wahlap.com/maimai-mobile/record/musicDetail/']")
  if (forms.length > 5_000) throw new UpdateFlowError('Wahlap returned too many score records.')
  forms.each((_index, element) => {
    const form = $(element)
    const title = form.find('.music_name_block').first().text().trim()
    const achievements = Number(form.find('.music_score_block.w_112').first().text().replace(/%$/u, '').trim())
    const scoreParts = form.find('.music_score_block.w_190').first().text()
      .split('/')
      .map(value => Number(value.replaceAll(',', '').trim()))
    const kind = form.find('.music_kind_icon').first().attr('src')?.split('/').at(-1)?.split('.')[0]
    const type = kind === 'music_standard' ? 'SD' : kind === 'music_dx' ? 'DX' : null
    const icons = form.find("img[src*='music_icon_']").toArray().map(image => (
      iconValue($(image).attr('src') ?? '')
    ))
    const fs = icons[0] ?? ''
    const fc = icons[1] ?? ''
    if (!title
      || !Number.isFinite(achievements)
      || achievements < 0
      || achievements > 101
      || scoreParts.length !== 2
      || !Number.isSafeInteger(scoreParts[0])
      || scoreParts[0] < 0
      || !type
      || !['', 'fc', 'fcp', 'ap', 'app'].includes(fc)
      || !['', 'sync', 'fs', 'fsp', 'fsd', 'fsdp'].includes(fs)) return
    records.push({
      title,
      achievements,
      dxScore: scoreParts[0],
      fc: fc as DivingFishImportRecord['fc'],
      fs: fs as DivingFishImportRecord['fs'],
      level_index: difficulty,
      type,
    })
  })
  return records
}

export class WahlapRecordFetcher {
  constructor(private readonly options: WahlapRecordFetcherOptions) {}

  async fetch(callbackUrl: string) {
    const callback = safeWahlapUrl(callbackUrl, [WAHLAP_ORIGIN])
    if (callback.pathname !== WAHLAP_CALLBACK_PATH || callback.searchParams.has('token')) {
      throw new UpdateFlowError('invalid Wahlap callback URL')
    }
    const redirect = await this.options.request(callback.href, { redirect: 'manual' })
    const loginLocation = headerValues(redirect.headers.location)[0]
    if (!loginLocation) throw new UpdateFlowError('invalid Wahlap redirect')
    const loginUrl = safeWahlapUrl(loginLocation, [WAHLAP_ORIGIN, WAHLAP_MOBILE_ORIGIN])
    const login = await this.options.request(loginUrl.href, { redirect: 'manual' })
    const cookie = cookieHeader(login.headers)
    const records: DivingFishImportRecord[] = []
    for (let difficulty = 0; difficulty <= 4; difficulty += 1) {
      const page = new URL(WAHLAP_RECORD_PATH, WAHLAP_MOBILE_ORIGIN)
      page.searchParams.set('search', 'A')
      page.searchParams.set('sort', '1')
      page.searchParams.set('playCheck', 'on')
      page.searchParams.set('diff', String(difficulty))
      const response = await this.options.request(page.href, {
        redirect: 'manual',
        headers: { Cookie: cookie, 'User-Agent': WAHLAP_USER_AGENT },
      })
      if (response.status < 200 || response.status >= 300) {
        throw new UpdateFlowError('Wahlap score request failed.')
      }
      records.push(...parseWahlapRecords(response.body, difficulty))
    }
    return records
  }
}

async function boundedResponseText(raw: Response) {
  const declared = Number(raw.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > WAHLAP_MAX_RESPONSE_BYTES) {
    throw new UpdateFlowError('Wahlap response exceeded the configured size limit.')
  }
  if (!raw.body) return ''
  const reader = raw.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > WAHLAP_MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new UpdateFlowError('Wahlap response exceeded the configured size limit.')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function responseCookies(headers: Headers) {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.()
  if (values?.length) return values
  const combined = headers.get('set-cookie')
  return combined ? [combined] : []
}

export function createKoishiWahlapRequester(
  http: Context['http'],
  debug?: DebugTracer,
) {
  return async (url: string, options: WahlapRequestOptions): Promise<WahlapResponse> => {
    const startedAt = Date.now()
    const request = { url, options }
    debug?.event('wahlap.request.start', { request })
    try {
      const response = await http<string>(url, {
        method: 'GET',
        headers: options.headers,
        redirect: options.redirect,
        timeout: 60_000,
        validateStatus: () => true,
        responseType: boundedResponseText,
      })
      const result = {
        status: response.status,
        headers: {
          location: response.headers.get('location') ?? undefined,
          'set-cookie': responseCookies(response.headers),
        },
        body: response.data,
      }
      debug?.event('wahlap.request.success', {
        durationMs: Date.now() - startedAt,
        request,
        response: result,
      })
      return result
    } catch (error) {
      debug?.failure('wahlap.request.failure', error, {
        durationMs: Date.now() - startedAt,
        request,
      })
      throw error
    }
  }
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

function validateCallbackUrl(callbackPath: string) {
  if (!callbackPath.startsWith('/')) throw new UpdateFlowError()
  const callback = new URL(callbackPath, WAHLAP_ORIGIN)
  if (callback.origin !== WAHLAP_ORIGIN || callback.pathname !== WAHLAP_CALLBACK_PATH) {
    throw new UpdateFlowError()
  }
  callback.searchParams.delete('token')
  callback.hash = ''
  return callback.href
}

export class UpdateService {
  private readonly lxnsStates: CallbackStore<LxnsState>
  private readonly updateTokens: CallbackStore<DivingFishState>
  private disposed = false

  constructor(private readonly options: UpdateServiceOptions) {
    this.lxnsStates = options.lxnsStates ?? new CallbackStore<LxnsState>()
    this.updateTokens = options.updateTokens ?? new CallbackStore<DivingFishState>()
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

  async beginDivingFishUpdate(session: UpdateSessionLocator) {
    this.assertActive()
    const updateRoute = publicRoute(this.options.publicBaseUrl, '/mai-plugin/update')
    this.options.debug?.event('update.diving-fish.begin', {
      session,
      publicBaseUrl: this.options.publicBaseUrl,
      updateRoute,
    })
    if (!await this.options.divingFishOAuth.hasBinding(session.userId)) {
      throw new UpdateBindingRequiredError()
    }
    const token = this.updateTokens.issue(session)
    const url = new URL(updateRoute)
    url.searchParams.set('token', token)
    this.options.debug?.event('update.diving-fish.ready', {
      session,
      token,
      url: url.href,
    })
    return url.href
  }

  async createUpdateRedirect(token: string) {
    this.assertActive()
    const session = this.updateTokens.peek(token)
    this.options.debug?.event('update.diving-fish.redirect.begin', { token, session })
    const upstream = new URL(await this.options.fetchAuthorizationRedirect())
    if (upstream.origin !== WAHLAP_ORIGIN || upstream.pathname !== WAHLAP_AUTHORIZE_PATH) {
      throw new UpdateFlowError('授权服务器返回了无效的重定向地址。')
    }
    const callback = new URL(publicRoute(this.options.publicBaseUrl, WAHLAP_CALLBACK_PATH))
    callback.searchParams.set('token', token)
    upstream.searchParams.set('redirect_uri', callback.href)
    this.options.debug?.event('update.diving-fish.redirect.ready', {
      token,
      session,
      callbackUrl: callback.href,
      authorizationUrl: upstream.href,
    })
    return upstream.href
  }

  async completeDivingFishUpdate(token: string, callbackPath: string) {
    this.assertActive()
    this.options.debug?.event('update.diving-fish.callback', { token, callbackPath })
    const session = this.updateTokens.consume(token)
    const callbackUrl = validateCallbackUrl(callbackPath)
    if (!await this.options.divingFishOAuth.hasBinding(session.userId)) {
      await session.send('水鱼账号授权已失效，请重新绑定。')
      throw new UpdateBindingRequiredError()
    }
    await session.send('正在爬取数据中……')
    try {
      const records = await this.options.fetchDivingFishRecords(callbackUrl)
      const result = await this.options.importDivingFishRecords(session.userId, records)
      await session.send(`更新成功，已更新${result.updates + result.creates}条记录。`)
      this.options.debug?.event('update.diving-fish.success', {
        token,
        callbackPath,
        callbackUrl,
        session,
        result,
      })
    } catch (error) {
      this.options.debug?.failure('update.diving-fish.failure', error, {
        token,
        callbackPath,
        callbackUrl,
        session,
      })
      const text = error instanceof ProviderOAuthRequiredError
        ? '水鱼授权已失效，请发送“/mai 绑定水鱼”重新授权。'
        : error instanceof ProviderScopeError
          ? '水鱼应用缺少成绩写入权限，请联系部署者确认 prober.records.write 已获批并重新授权。'
          : error instanceof ProviderConsentScopeError
            ? '水鱼账号授权未包含成绩写入权限，请发送“/mai 绑定水鱼”重新授权并同意读写权限。'
          : error instanceof ProviderRateLimitError
            ? '水鱼请求已达限额，请稍后重试。'
            : error instanceof ProviderPrivacyError
              ? '水鱼账号尚未同意查分器协议，请先在水鱼账号设置中同意。'
              : '更新失败，请稍后重试。'
      await session.send(text)
      throw error
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lxnsStates.dispose()
    this.updateTokens.dispose()
    this.options.divingFishOAuth.dispose()
  }

  private assertActive() {
    if (this.disposed) throw new UpdateFlowError('成绩更新服务已停止。')
  }
}
