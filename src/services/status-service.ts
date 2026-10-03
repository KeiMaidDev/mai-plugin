import type { StatusSourceDocument } from '../providers/status-source'

export type StatusVerdict = string

export interface StatusServiceView {
  key: string
  /** Display name; falls back to the source's own key when it reports no name. */
  name: string
  /** The source's machine state, empty when it reports none. */
  state: string
  /** The source's own Chinese label, empty when it reports none. */
  stateText: string
  /** Milliseconds, or null when the source reports none. */
  latency: number | null
  /** How long the state has lasted, empty on a service the source calls fine. */
  durationText: string
}

export interface StatusSnapshot {
  /** The source's own verdict key; unknown keys still reach the presenter. */
  verdict: StatusVerdict
  /** The source's verdict sentence, used only when the key is one we cannot name. */
  verdictText: string
  services: StatusServiceView[]
  /** The source's broadcast message, empty when it has none. */
  broadcast: string
  /** The source's own report time, or null when it reports none we can read. */
  updatedAt: Date | null
}

export interface StatusSource {
  fetch(): Promise<StatusSourceDocument>
}

export interface StatusServiceOptions {
  source: StatusSource
  cacheTtlMs: number
  now?: () => Date
}

/** Raised when the source answers without a single service to show. */
export class StatusSourceEmptyError extends Error {
  constructor(message = 'The status source returned no service.') {
    super(message)
    this.name = 'StatusSourceEmptyError'
  }
}

interface StatusCacheEntry {
  document: StatusSourceDocument
  fetchedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A trimmed string, or an empty one when the field is absent or not a string. */
function optionalText(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

/** A finite number, or null. `NaN` and infinities are not measurements. */
function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The source documents `timestamp` as ISO 8601 with an offset, so unlike the
 * probe pages this replaced it needs no zone marker appended. An unreadable
 * value is reported as unknown rather than guessed at.
 */
export function parseStatusTime(value: string | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function serviceView(entry: unknown): StatusServiceView | null {
  if (!isRecord(entry)) return null
  const key = optionalText(entry.key)
  const name = optionalText(entry.name)
  // A service with neither a name nor a key cannot be labelled, so showing it
  // would put an anonymous row in the table.
  if (!name && !key) return null
  return {
    key,
    name: name || key.toUpperCase(),
    state: optionalText(entry.state),
    stateText: optionalText(entry.state_text),
    latency: optionalNumber(entry.latency),
    durationText: optionalText(entry.duration_text),
  }
}

export class StatusService {
  private cache: StatusCacheEntry | null = null

  constructor(private readonly options: StatusServiceOptions) {}

  private now() {
    return this.options.now?.() ?? new Date()
  }

  /**
   * The cache holds the raw document and re-derives the snapshot on a hit, so
   * changing the labels or the bulletin layout never needs a cache flush.
   */
  private async document(): Promise<StatusSourceDocument> {
    if (this.options.cacheTtlMs > 0 && this.cache) {
      const age = this.now().getTime() - this.cache.fetchedAt
      if (age < this.options.cacheTtlMs) return this.cache.document
    }
    const document = await this.options.source.fetch()
    this.cache = this.options.cacheTtlMs > 0
      ? { document, fetchedAt: this.now().getTime() }
      : null
    return document
  }

  async snapshot(): Promise<StatusSnapshot> {
    return this.derive(await this.document())
  }

  private derive(document: StatusSourceDocument): StatusSnapshot {
    const services: StatusServiceView[] = []
    for (const entry of document.services) {
      const view = serviceView(entry)
      if (view) services.push(view)
    }
    // The verdict the source states is the whole answer; with nothing to show
    // under it, the reply would be a heading over an empty table.
    if (services.length === 0) throw new StatusSourceEmptyError()

    return {
      verdict: document.verdict.trim(),
      verdictText: optionalText(document.verdict_text),
      services,
      broadcast: isRecord(document.broadcast) ? optionalText(document.broadcast.msg) : '',
      updatedAt: parseStatusTime(document.timestamp),
    }
  }
}
