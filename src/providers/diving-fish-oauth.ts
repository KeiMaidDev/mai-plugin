import { createHash } from 'node:crypto'
import type { Config } from '../config'
import type { BindRepository } from '../database/repositories'
import { ProviderHttpClient, type ProviderContext, type ProviderLogger } from './types'
import { ProviderMalformedPayloadError, ProviderTransportError } from './errors'

const AUTH = 'https://auth.diving-fish.com'
const SCOPES = 'prober.records.read prober.records.write'

type Scope = 'prober.records.read' | 'prober.records.write' | typeof SCOPES
export type OAuthSubject = `sub:${string}` | `username:${string}`

export class DivingFishOAuthError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'DivingFishOAuthError'
  }
}

interface BindSession {
  userId: string
  send(text: string): Promise<void>
}

interface PendingBind {
  cancelled: boolean
  timer?: ReturnType<typeof setTimeout>
  wake?: () => void
}

interface Token {
  value: string
  expiresAt: number
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oauthCode(value: unknown) {
  if (!object(value) || typeof value.error !== 'string') return null
  if (value.error === 'consent_required' && typeof value.error_description === 'string'
    && value.error_description.includes('scope not granted')) return 'scope_not_granted'
  return value.error
}

export class DivingFishOAuth {
  private readonly http: ProviderHttpClient
  private readonly pending = new Map<string, PendingBind>()
  private readonly tokens = new Map<string, Token>()
  private readonly exchanges = new Map<string, Promise<string>>()
  private readonly generations = new Map<string, number>()
  private readonly bindingTails = new Map<string, Promise<void>>()
  private disposed = false

  constructor(
    ctx: ProviderContext,
    private readonly config: Config['divingFishOAuth'],
    private readonly bind: Pick<BindRepository,
      'setDivingFishAccount' | 'getDivingFishAccount' | 'removeDivingFishAccount' | 'divingFishAccountsForQq'>,
    logger?: ProviderLogger,
    private readonly now: () => number = Date.now,
  ) {
    this.http = new ProviderHttpClient('diving-fish', ctx, logger)
  }

  private credentials() {
    if (!this.config?.clientId?.trim() || !this.config?.clientSecret?.trim()) {
      throw new DivingFishOAuthError('not_configured')
    }
    return { client_id: this.config.clientId.trim(), client_secret: this.config.clientSecret.trim() }
  }

  private async post(path: string, fields: Record<string, string>) {
    const response = await this.http.json({
      label: path,
      method: 'POST',
      url: `${AUTH}${path}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: new URLSearchParams(fields),
    })
    if (response.status >= 200 && response.status < 300) return response.data
    const code = oauthCode(response.data)
    if (code) throw new DivingFishOAuthError(code)
    if (response.status === 429) throw new DivingFishOAuthError('slow_down')
    throw new ProviderTransportError('diving-fish', 'OAuth request failed.', response.status)
  }

  private subjectRef(userId: string) {
    return createHash('sha256').update(`${this.config.clientId.trim()}:${userId}`).digest('hex')
  }

  private bindingLabel(userId: string) {
    const visible = userId.length <= 4 ? `${userId.slice(0, 1)}***` : `${userId.slice(0, 2)}***${userId.slice(-2)}`
    return `Koishi ${visible}`.slice(0, 64)
  }

  async begin(session: BindSession) {
    if (this.disposed) throw new DivingFishOAuthError('disposed')
    const data = await this.post('/oauth/device_authorization', {
      ...this.credentials(),
      scope: SCOPES,
      subject_ref: this.subjectRef(session.userId),
      binding_label: this.bindingLabel(session.userId),
    })
    if (!object(data) || typeof data.device_code !== 'string' || typeof data.user_code !== 'string'
      || typeof data.verification_uri_complete !== 'string'
      || !Number.isFinite(data.expires_in) || !Number.isFinite(data.interval)) {
      throw new ProviderMalformedPayloadError('diving-fish')
    }
    if (this.disposed) throw new DivingFishOAuthError('disposed')
    const url = new URL(data.verification_uri_complete)
    if (url.origin !== AUTH || url.pathname !== '/device') throw new ProviderMalformedPayloadError('diving-fish')
    this.cancel(session.userId)
    const pending: PendingBind = { cancelled: false }
    this.pending.set(session.userId, pending)
    void this.poll(session, pending, data.device_code, Math.max(1, Number(data.interval)),
      this.now() + Number(data.expires_in) * 1000).catch(() => {})
    return { url: url.href, code: data.user_code }
  }

  private wait(pending: PendingBind, seconds: number) {
    return new Promise<void>((resolve) => {
      pending.wake = resolve
      pending.timer = setTimeout(resolve, seconds * 1000)
    })
  }

  private async poll(session: BindSession, pending: PendingBind, code: string, interval: number, expiresAt: number) {
    try {
      while (!pending.cancelled && !this.disposed && this.now() < expiresAt) {
        await this.wait(pending, interval)
        if (pending.cancelled || this.disposed || this.now() >= expiresAt) break
        try {
          const data = await this.post('/oauth/token', {
            ...this.credentials(), grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code,
          })
          if (!object(data) || (typeof data.sub !== 'string' && typeof data.sub !== 'number')) {
            throw new ProviderMalformedPayloadError('diving-fish')
          }
          if (pending.cancelled || this.disposed) return
          const bound = await this.serializeBinding(session.userId, async () => {
            if (pending.cancelled || this.disposed) return false
            await this.bind.setDivingFishAccount(session.userId, String(data.sub))
            return true
          })
          if (!bound || pending.cancelled || this.disposed) return
          await session.send('水鱼授权绑定成功。')
          return
        } catch (error) {
          if (error instanceof DivingFishOAuthError && error.code === 'authorization_pending') continue
          if (error instanceof DivingFishOAuthError && error.code === 'slow_down') {
            interval += 5
            continue
          }
          if (pending.cancelled || this.disposed) return
          const message = error instanceof DivingFishOAuthError && error.code === 'access_denied'
            ? '水鱼授权已拒绝，请发送“/mai 绑定水鱼”重试。'
            : '水鱼授权失败或已过期，请发送“/mai 绑定水鱼”重试。'
          await session.send(message)
          return
        }
      }
      if (!pending.cancelled && !this.disposed) {
        await session.send('水鱼授权已过期，请发送“/mai 绑定水鱼”重试。')
      }
    } finally {
      if (this.pending.get(session.userId) === pending) this.pending.delete(session.userId)
    }
  }

  private cancel(userId: string) {
    const pending = this.pending.get(userId)
    if (!pending) return
    pending.cancelled = true
    if (pending.timer) clearTimeout(pending.timer)
    pending.wake?.()
    this.pending.delete(userId)
  }

  private async serializeBinding<T>(userId: string, operation: () => Promise<T>) {
    const previous = this.bindingTails.get(userId) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => pending)
    this.bindingTails.set(userId, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.bindingTails.get(userId) === tail) this.bindingTails.delete(userId)
    }
  }

  async hasBinding(userId: string) {
    return Boolean(await this.bind.getDivingFishAccount(userId))
  }

  async hasActiveAuthorization(userId: string) {
    const accountId = await this.bind.getDivingFishAccount(userId)
    if (!accountId) return false
    try {
      await this.accessToken(`sub:${accountId}`, SCOPES)
      return true
    } catch (error) {
      if (error instanceof DivingFishOAuthError && error.code === 'scope_not_granted') return false
      if (error instanceof DivingFishOAuthError && error.code === 'consent_required') {
        await this.serializeBinding(userId, async () => {
          if (await this.bind.getDivingFishAccount(userId) === accountId) {
            await this.bind.removeDivingFishAccount(userId)
          }
        })
        this.dropSubject(`sub:${accountId}`)
        return false
      }
      throw error
    }
  }

  async unbind(userId: string) {
    this.cancel(userId)
    const accountId = await this.serializeBinding(userId, async () => {
      const existing = await this.bind.getDivingFishAccount(userId)
      await this.bind.removeDivingFishAccount(userId)
      return existing
    })
    if (accountId) this.dropSubject(`sub:${accountId}`)
  }

  async subjectForUser(userId: string): Promise<OAuthSubject> {
    const accountId = await this.bind.getDivingFishAccount(userId)
    if (!accountId) throw new DivingFishOAuthError('consent_required')
    return `sub:${accountId}`
  }

  async subjectForQq(qq: string): Promise<OAuthSubject> {
    const accounts = await this.bind.divingFishAccountsForQq(qq)
    if (accounts.length !== 1) throw new DivingFishOAuthError(accounts.length ? 'ambiguous_qq' : 'consent_required')
    return `sub:${accounts[0]}`
  }

  private dropSubject(subject: OAuthSubject) {
    this.generations.set(subject, (this.generations.get(subject) ?? 0) + 1)
    for (const key of this.tokens.keys()) if (key.startsWith(`${subject}\0`)) this.tokens.delete(key)
  }

  async accessToken(subject: OAuthSubject, scope: Scope) {
    if (this.disposed) throw new DivingFishOAuthError('disposed')
    const key = `${subject}\0${scope}`
    const combinedKey = `${subject}\0${SCOPES}`
    const cached = [this.tokens.get(key), scope === SCOPES ? undefined : this.tokens.get(combinedKey)]
      .find(token => token && token.expiresAt - 30_000 > this.now())
    if (cached) return cached.value
    const running = this.exchanges.get(key)
    if (running) return running
    const generation = this.generations.get(subject) ?? 0
    const exchange = (async () => {
      const data = await this.post('/oauth/token', {
        ...this.credentials(), grant_type: 'urn:diving-fish:params:oauth:grant-type:on-behalf-of',
        subject, scope,
      })
      if (!object(data) || typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in)) {
        throw new ProviderMalformedPayloadError('diving-fish')
      }
      if (this.disposed || (this.generations.get(subject) ?? 0) !== generation) {
        throw new DivingFishOAuthError('consent_required')
      }
      this.tokens.set(key, { value: data.access_token, expiresAt: this.now() + Number(data.expires_in) * 1000 })
      return data.access_token
    })()
    this.exchanges.set(key, exchange)
    try {
      return await exchange
    } catch (error) {
      if (error instanceof DivingFishOAuthError && error.code === 'consent_required') this.dropSubject(subject)
      throw error
    } finally {
      if (this.exchanges.get(key) === exchange) this.exchanges.delete(key)
    }
  }

  invalidate(subject: OAuthSubject) {
    this.dropSubject(subject)
  }

  dispose() {
    this.disposed = true
    for (const userId of this.pending.keys()) this.cancel(userId)
    this.tokens.clear()
    this.exchanges.clear()
  }
}
