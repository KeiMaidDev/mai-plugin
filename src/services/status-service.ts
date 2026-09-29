import {
  newestHeartbeat,
  type StatusHeartbeat,
  type StatusPagePayloads,
} from '../providers/status-page'

/** The overview group aggregates the groups below it and carries a `[测试]` probe. */
export const OVERVIEW_GROUP_NAME = 'Overall / 总览'

/** Shared prefix of every line-group name; the community-service group has none. */
export const LINE_GROUP_NAME_PREFIX = '舞萌DX 核心游戏服务器 - '

/** Trailing carrier annotation a line-group monitor carries; community monitors do not. */
export const MONITOR_CARRIER_SUFFIX_PATTERN = / \[上海[^\]]*代理\]$/u

export type StatusHealth = 'normal' | 'degraded' | 'offline'

export interface StatusMonitorView {
  id: number
  /** Display name, with the carrier annotation the group heading already states removed. */
  name: string
  /** Newest heartbeat's `status`, or null when the monitor reports no heartbeat. */
  status: number | null
  ping: number | null
  /** 24-hour availability in `0..1`, or null when the status page reports none. */
  uptime: number | null
}

export interface StatusGroupView {
  /** Display name, with the shared line prefix removed. */
  name: string
  /** Whether this group is a line group, and therefore decides the verdict. */
  line: boolean
  healthy: boolean
  monitors: StatusMonitorView[]
}

export interface StatusSnapshot {
  health: StatusHealth
  groups: StatusGroupView[]
  incidents: string[]
  maintenance: string[]
  /** Newest heartbeat time across every monitor, or null when none reports one. */
  updatedAt: Date | null
}

export interface StatusPageSource {
  fetch(): Promise<StatusPagePayloads>
}

export interface StatusServiceOptions {
  source: StatusPageSource
  verdictGroups: readonly string[]
  cacheTtlMs: number
  now?: () => Date
}

/** Raised when the response carries no line group, so no verdict can be stated. */
export class StatusPageEmptyError extends Error {
  constructor(message = 'The status page returned no line group.') {
    super(message)
    this.name = 'StatusPageEmptyError'
  }
}

interface StatusCacheEntry {
  payloads: StatusPagePayloads
  fetchedAt: number
}

/** `time` is UTC without a zone marker, so the `Z` suffix is added before parsing. */
export function parseStatusPageTime(value: string) {
  if (!value) return null
  const normalized = value.endsWith('Z') ? value : `${value.replace(' ', 'T')}Z`
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? null : date
}

export function monitorDisplayName(name: string) {
  return name.replace(MONITOR_CARRIER_SUFFIX_PATTERN, '')
}

export function groupDisplayName(name: string) {
  return name.startsWith(LINE_GROUP_NAME_PREFIX)
    ? name.slice(LINE_GROUP_NAME_PREFIX.length)
    : name
}

function noticeTitles(notices: { title?: string, active?: boolean }[] | undefined) {
  return (notices ?? [])
    .filter(notice => notice?.active === true)
    .map(notice => (typeof notice.title === 'string' ? notice.title.trim() : ''))
    .filter(title => title.length > 0)
}

function monitorView(monitor: { id: number, name: string }, heartbeats: Record<string, StatusHeartbeat[]> | undefined, uptimes: Record<string, number> | undefined): StatusMonitorView {
  const heartbeat = newestHeartbeat(heartbeats?.[String(monitor.id)])
  const uptime = uptimes?.[`${monitor.id}_24`]
  return {
    id: monitor.id,
    name: monitorDisplayName(monitor.name),
    status: typeof heartbeat?.status === 'number' ? heartbeat.status : null,
    ping: typeof heartbeat?.ping === 'number' ? heartbeat.ping : null,
    uptime: typeof uptime === 'number' ? uptime : null,
  }
}

function isGroupHealthy(monitors: readonly StatusMonitorView[]) {
  return monitors.length > 0 && monitors.every(monitor => monitor.status === 1)
}

function latestTime(payloads: StatusPagePayloads) {
  let newest = ''
  for (const heartbeats of Object.values(payloads.heartbeat.heartbeatList ?? {})) {
    for (const heartbeat of heartbeats ?? []) {
      if (typeof heartbeat?.time === 'string' && heartbeat.time > newest) newest = heartbeat.time
    }
  }
  return newest
}

function matchesVerdictGroup(name: string, patterns: readonly RegExp[]) {
  return patterns.some(pattern => pattern.test(name))
}

export class StatusService {
  private cache: StatusCacheEntry | null = null

  constructor(private readonly options: StatusServiceOptions) {}

  private now() {
    return this.options.now?.() ?? new Date()
  }

  private verdictPatterns() {
    return this.options.verdictGroups
      .map(source => source.trim())
      .filter(source => source.length > 0)
      .map(source => new RegExp(source))
  }

  /**
   * The cache holds the two raw payloads and re-derives the snapshot on a hit,
   * so changing the bulletin or the verdict rule never needs a cache flush.
   */
  private async payloads(): Promise<StatusPagePayloads> {
    if (this.options.cacheTtlMs > 0 && this.cache) {
      const age = this.now().getTime() - this.cache.fetchedAt
      if (age < this.options.cacheTtlMs) return this.cache.payloads
    }
    const payloads = await this.options.source.fetch()
    this.cache = this.options.cacheTtlMs > 0
      ? { payloads, fetchedAt: this.now().getTime() }
      : null
    return payloads
  }

  async snapshot(): Promise<StatusSnapshot> {
    return this.derive(await this.payloads())
  }

  private derive(payloads: StatusPagePayloads): StatusSnapshot {
    const patterns = this.verdictPatterns()
    const { heartbeatList, uptimeList } = payloads.heartbeat
    const groups: StatusGroupView[] = []
    for (const group of payloads.page.publicGroupList ?? []) {
      if (!group || group.name === OVERVIEW_GROUP_NAME) continue
      const monitors = (group.monitorList ?? [])
        .filter(monitor => Boolean(monitor))
        .map(monitor => monitorView(monitor, heartbeatList, uptimeList))
      groups.push({
        name: groupDisplayName(group.name),
        line: matchesVerdictGroup(group.name, patterns),
        healthy: isGroupHealthy(monitors),
        monitors,
      })
    }

    const lineGroups = groups.filter(group => group.line)
    if (lineGroups.length === 0) throw new StatusPageEmptyError()
    const healthyLines = lineGroups.filter(group => group.healthy).length
    const health: StatusHealth = healthyLines === lineGroups.length
      ? 'normal'
      : healthyLines === 0 ? 'offline' : 'degraded'

    return {
      health,
      groups,
      incidents: noticeTitles(payloads.page.incidents),
      maintenance: noticeTitles(payloads.page.maintenanceList),
      updatedAt: parseStatusPageTime(latestTime(payloads)),
    }
  }
}
