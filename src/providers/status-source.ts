import { findCancellationError } from './errors'

/**
 * The status source is a community aggregation platform, not a score backend.
 * Its failures deliberately do not reuse the score-provider error classes:
 * those carry a `ProviderId` that also decides the player-facing score-provider
 * options, so a status request would show up as a selectable score provider.
 */

/** The one endpoint the status source exposes for reading server status. */
export const STATUS_SOURCE_PATH = '/api/bot'

export interface StatusSourceHttpResponse<T = unknown> {
  status: number
  data: T
}

export interface StatusSourceRequestConfig {
  timeout?: number
  validateStatus?: (status: number) => boolean
}

/** The smallest slice of `ctx.http` this provider needs, so it can be faked. */
export interface StatusSourceHttp {
  <T = unknown>(
    url: string,
    config?: StatusSourceRequestConfig,
  ): Promise<StatusSourceHttpResponse<T>>
}

export interface StatusSourceService {
  key?: string
  name?: string
  state?: string
  state_text?: string
  /** Milliseconds; the source documents this as int or null. */
  latency?: number | null
  duration_text?: string
}

export interface StatusSourceLatency {
  /** Milliseconds; the source documents this as int or null. */
  current_ms?: number | null
  load_text?: string
  volatility_text?: string
}

export interface StatusSourceReports {
  anomaly_count?: number | null
  normal_count?: number | null
}

export interface StatusSourceLog {
  time_ago?: string
  region?: string
  type?: string
}

/**
 * Every field the source documents, all optional except the two the provider
 * insists on. The source omits optional fields rather than sending nulls, and a
 * missing section must cost the bulletin that section only — never the whole
 * reply — so nothing beyond `verdict` and `services` is treated as required.
 */
export interface StatusSourceDocument {
  version?: string
  /** ISO 8601 with an offset, unlike the probe pages this replaced. */
  timestamp?: string
  status?: string
  status_text?: string
  incident_level?: string
  verdict: string
  verdict_text?: string
  services: StatusSourceService[]
  summary?: string
  latency?: StatusSourceLatency
  reports?: StatusSourceReports
  recent_logs?: StatusSourceLog[]
  broadcast?: { msg?: string } | null
}

export type StatusSourceFailureKind = 'connection' | 'timeout' | 'malformed'

export class StatusSourceError extends Error {
  constructor(
    readonly kind: StatusSourceFailureKind,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'StatusSourceError'
  }
}

export interface StatusSourceLogger {
  warn(message: string): void
}

export interface StatusSourceProviderOptions {
  http: StatusSourceHttp
  baseUrl: string
  timeoutMs: number
  logger?: StatusSourceLogger
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The expected shape stops at the two keys the bulletin cannot work without: a
 * verdict to state and a service list to show. An empty service list is still a
 * usable body — the verdict says nothing is reporting — so only a missing or
 * mistyped key counts as malformed.
 */
function isStatusSourceDocument(value: unknown): value is StatusSourceDocument {
  return isRecord(value)
    && typeof value.verdict === 'string'
    && value.verdict.length > 0
    && Array.isArray(value.services)
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

export function statusSourceEndpoint(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`
}

export class StatusSourceProvider {
  constructor(private readonly options: StatusSourceProviderOptions) {}

  async fetch(): Promise<StatusSourceDocument> {
    const url = statusSourceEndpoint(this.options.baseUrl, STATUS_SOURCE_PATH)
    let response: StatusSourceHttpResponse<unknown>
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
        'status source request failed.',
        error,
      )
    }
    if (!(response?.status >= 200 && response.status < 300)) {
      return this.fail(
        'connection',
        'status source responded with an error status.',
        undefined,
        response?.status,
      )
    }
    // A 200 with the wrong body still says nothing about the servers, so it is
    // reported as a malformed response rather than read as "everything is down".
    if (!isStatusSourceDocument(response.data)) {
      return this.fail('malformed', 'status source response is not the expected shape.')
    }
    return response.data
  }

  private fail(
    kind: StatusSourceFailureKind,
    message: string,
    cause?: unknown,
    status?: number,
  ): never {
    const error = new StatusSourceError(kind, message, status)
    if (cause !== undefined) error.cause = cause
    this.options.logger?.warn(
      `[mai-plugin] ${message} (${kind}${status === undefined ? '' : `, status ${status}`})`,
    )
    throw error
  }
}
