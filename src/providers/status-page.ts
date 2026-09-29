import { findCancellationError } from './errors'

/**
 * The status page is a community service, not a score backend. Its failures
 * deliberately do not reuse the score-provider error classes: those carry a
 * `ProviderId` that also decides the player-facing score-provider options, so
 * a status-page request would show up as a selectable score provider.
 */

export const STATUS_PAGE_STATUS_PATH = '/api/status-page/maimai'
export const STATUS_PAGE_HEARTBEAT_PATH = '/api/status-page/heartbeat/maimai'

export interface StatusPageHttpResponse<T = unknown> {
  status: number
  data: T
}

export interface StatusPageRequestConfig {
  timeout?: number
  validateStatus?: (status: number) => boolean
}

/** The smallest slice of `ctx.http` this provider needs, so it can be faked. */
export interface StatusPageHttp {
  <T = unknown>(
    url: string,
    config?: StatusPageRequestConfig,
  ): Promise<StatusPageHttpResponse<T>>
}

export interface StatusPageMonitor {
  id: number
  name: string
  type?: string
}

export interface StatusPageGroup {
  id: number
  name: string
  monitorList?: StatusPageMonitor[]
}

export interface StatusPageNotice {
  title?: string
  active?: boolean
}

export interface StatusPageDocument {
  publicGroupList?: StatusPageGroup[]
  incidents?: StatusPageNotice[]
  maintenanceList?: StatusPageNotice[]
}

export interface StatusHeartbeat {
  status?: number
  time?: string
  msg?: string
  ping?: number | null
}

export interface StatusHeartbeatDocument {
  heartbeatList?: Record<string, StatusHeartbeat[]>
  uptimeList?: Record<string, number>
}

export interface StatusPagePayloads {
  page: StatusPageDocument
  heartbeat: StatusHeartbeatDocument
}

export type StatusPageFailureKind = 'connection' | 'timeout' | 'malformed'

export class StatusPageError extends Error {
  constructor(
    readonly kind: StatusPageFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'StatusPageError'
  }
}

export interface StatusPageLogger {
  warn(message: string): void
}

export interface StatusPageProviderOptions {
  http: StatusPageHttp
  baseUrl: string
  timeoutMs: number
  logger?: StatusPageLogger
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatusPageDocument(value: unknown): value is StatusPageDocument {
  return isRecord(value) && Array.isArray(value.publicGroupList)
}

function isStatusHeartbeatDocument(value: unknown): value is StatusHeartbeatDocument {
  return isRecord(value) && isRecord(value.heartbeatList)
}

/**
 * A local cause walk rather than a shared helper: the score providers classify
 * a timeout into their own error class, which this module deliberately does not
 * reuse. Keep the two apart so neither can drag the other's hierarchy along.
 */
function timeoutFromCause(error: unknown) {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    if ((current as { code?: unknown }).code === 'ETIMEDOUT') return true
    if ((current as { name?: unknown }).name === 'TimeoutError') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

export function statusPageEndpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

/**
 * The newest heartbeat is chosen by comparing the `time` strings, never by
 * array position. The status page currently returns heartbeats in ascending
 * time order, so reading `[0]` reports a status hours out of date next to a
 * current timestamp; comparing the strings stays correct either way.
 */
export function newestHeartbeat(
  list: readonly StatusHeartbeat[] | null | undefined,
): StatusHeartbeat | null {
  let newest: StatusHeartbeat | null = null
  let newestTime = ''
  for (const entry of list ?? []) {
    if (!isRecord(entry)) continue
    const time = typeof entry.time === 'string' ? entry.time : ''
    if (newest === null || time > newestTime) {
      newest = entry as StatusHeartbeat
      newestTime = time
    }
  }
  return newest
}

export class StatusPageProvider {
  constructor(private readonly options: StatusPageProviderOptions) {}

  async fetch(): Promise<StatusPagePayloads> {
    const [page, heartbeat] = await Promise.all([
      this.request('status page', STATUS_PAGE_STATUS_PATH, isStatusPageDocument),
      this.request('status page heartbeat', STATUS_PAGE_HEARTBEAT_PATH, isStatusHeartbeatDocument),
    ])
    return { page, heartbeat }
  }

  private async request<T>(
    label: string,
    path: string,
    isDocument: (value: unknown) => value is T,
  ): Promise<T> {
    const url = statusPageEndpoint(this.options.baseUrl, path)
    let response: StatusPageHttpResponse<unknown>
    try {
      response = await this.options.http(url, {
        timeout: this.options.timeoutMs,
        validateStatus: () => true,
      })
    } catch (error) {
      const cancellation = findCancellationError(error)
      if (cancellation) throw cancellation
      return this.fail(
        timeoutFromCause(error) ? 'timeout' : 'connection',
        `${label} request failed.`,
        error,
      )
    }
    if (!(response?.status >= 200 && response.status < 300)) {
      return this.fail('connection', `${label} responded with an error status.`, undefined, response?.status)
    }
    // A 200 with the wrong body still says nothing about the servers, so it is
    // reported as a malformed response rather than read as "everything is down".
    if (!isDocument(response.data)) {
      return this.fail('malformed', `${label} response is not the expected shape.`)
    }
    return response.data
  }

  private fail(
    kind: StatusPageFailureKind,
    message: string,
    cause?: unknown,
    status?: number,
  ): never {
    const error = new StatusPageError(kind, message, status)
    if (cause !== undefined) error.cause = cause
    this.options.logger?.warn(
      `[mai-plugin] ${message} (${kind}${status === undefined ? '' : `, status ${status}`})`,
    )
    throw error
  }
}
