import { StatusPageError } from '../providers/status-page'
import {
  HEALTHY_MONITOR_STATUS,
  StatusPageEmptyError,
  type StatusGroupView,
  type StatusHealth,
  type StatusMonitorView,
  type StatusSnapshot,
} from '../services/status-service'
import { createQqMarkdownImageContent } from './qq-markdown-image'

export const STATUS_BULLETIN_TITLE = '舞萌 DX 服务器状态'

/** Every field the status page leaves empty reads as this. */
const UNKNOWN_VALUE = '未知'

const verdictStyles: Record<StatusHealth, { icon: string, label: string }> = {
  normal: { icon: '✅', label: '移动线路正常' },
  degraded: { icon: '⚠️', label: '部分线路异常' },
  offline: { icon: '❌', label: '移动线路全部离线' },
}

/**
 * The status artwork that accompanies the verdict, relative to the packaged
 * `assets/` directory. The source plugin shipped only the normal and offline
 * files; the degraded one is this plugin's own, drawn from the normal artwork
 * so the three keep one style.
 */
const bannerAssets: Record<StatusHealth, string> = {
  normal: 'generated/status-normal.png',
  degraded: 'generated/status-degraded.png',
  offline: 'generated/status-offline.png',
}

/** Declared banner size, so the two source files render at one size despite their own. */
export const STATUS_BANNER_SIZE = 96
export const STATUS_BANNER_ALT = 'maimai-status'

/** Reads the artwork a verdict selects, resolved from the package's own assets. */
export type StatusBannerLoader = (health: StatusHealth) => Promise<Buffer>

/** Path of a verdict's artwork, relative to the package's `assets/` directory. */
export function statusBannerAsset(health: StatusHealth) {
  return bannerAssets[health]
}

export function statusVerdictLabel(health: StatusHealth) {
  return verdictStyles[health].label
}

const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function twoDigits(value: string) {
  return value.padStart(2, '0')
}

export function formatStatusTime(date: Date | null) {
  if (!date) return UNKNOWN_VALUE
  const parts: Record<string, string> = {}
  for (const part of shanghaiFormatter.formatToParts(date)) parts[part.type] = part.value
  return `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`
    + ` ${twoDigits(parts.hour)}:${twoDigits(parts.minute)}:${twoDigits(parts.second)}`
}

export function statusTimeLine(snapshot: StatusSnapshot) {
  return `更新时间：${formatStatusTime(snapshot.updatedAt)}`
}

export function statusVerdictLine(snapshot: StatusSnapshot) {
  return `${STATUS_BULLETIN_TITLE}：${statusVerdictLabel(snapshot.health)}`
}

interface MonitorState {
  icon: string
  label: string
}

/** The status page's monitor states: 0 offline, 1 up, 2 degraded, 3 maintenance. */
const monitorStates: Record<number, MonitorState | undefined> = {
  0: { icon: '❌', label: '离线' },
  1: { icon: '✅', label: '正常' },
  2: { icon: '⚠️', label: '异常' },
  3: { icon: '🛠️', label: '维护中' },
}

const UNKNOWN_STATE: MonitorState = { icon: '❔', label: UNKNOWN_VALUE }

/** A monitor with no heartbeat, or with a state the status page does not define. */
function monitorState(status: number | null): MonitorState {
  return (status === null ? undefined : monitorStates[status]) ?? UNKNOWN_STATE
}

function latencyField(ping: number | null) {
  return ping === null ? UNKNOWN_VALUE : `${ping}ms`
}

/** 24-hour availability, one decimal place, as both bulletins print it. */
function uptimePercent(uptime: number) {
  return `${(uptime * 100).toFixed(1)}%`
}

/**
 * One monitor per line: `- <icon> <name>（<state>，<latency>）`. A monitor that
 * is not healthy appends its 24-hour availability; a healthy one stays short.
 */
function formatMonitorLine(monitor: StatusMonitorView) {
  const state = monitorState(monitor.status)
  const fields = [state.label, latencyField(monitor.ping)]
  if (monitor.status !== HEALTHY_MONITOR_STATUS && monitor.uptime !== null) {
    fields.push(`24h ${uptimePercent(monitor.uptime)}`)
  }
  return `- ${state.icon} ${monitor.name}（${fields.join('，')}）`
}

/** A group heading followed by one line per monitor. */
function formatStatusGroup(group: StatusGroupView) {
  return [group.name, ...group.monitors.map(formatMonitorLine)].join('\n')
}

const INCIDENT_LABEL = '公告与故障'
const MAINTENANCE_LABEL = '计划维护'

/** One line per list, so several titles share a line. Both lists empty yields nothing. */
function noticeLines(snapshot: Pick<StatusSnapshot, 'incidents' | 'maintenance'>) {
  const lines: string[] = []
  if (snapshot.incidents.length > 0) lines.push(`${INCIDENT_LABEL}：${snapshot.incidents.join('；')}`)
  if (snapshot.maintenance.length > 0) lines.push(`${MAINTENANCE_LABEL}：${snapshot.maintenance.join('；')}`)
  return lines
}

/**
 * The plain-text bulletin: the verdict, one block per displayed group, the
 * notices when there are any, then the freshness of the answer.
 */
export function formatStatusText(snapshot: StatusSnapshot) {
  return [
    statusVerdictLine(snapshot),
    ...snapshot.groups.map(formatStatusGroup),
    noticeLines(snapshot).join('\n'),
    statusTimeLine(snapshot),
  ].filter(block => block.length > 0).join('\n\n')
}

const TABLE_HEADER = ['服务器', '状态', '延迟', '24h'] as const
const EMPTY_CELL = '-'

/** A table cell cannot carry a line break or a pipe without breaking the row. */
function tableCell(value: string) {
  return value.replaceAll('|', '\\|').replaceAll(/\s+/gu, ' ').trim()
}

function tableRow(cells: readonly string[]) {
  return `| ${cells.map(tableCell).join(' | ')} |`
}

/**
 * A healthy row leaves the 24h cell blank, so a healthy bulletin stays narrow;
 * an abnormal row carries the availability the status page reports for it.
 */
function markdownUptimeCell(monitor: StatusMonitorView) {
  return monitor.status === HEALTHY_MONITOR_STATUS || monitor.uptime === null
    ? EMPTY_CELL
    : `${(monitor.uptime * 100).toFixed(1)}%`
}

function markdownMonitorRow(monitor: StatusMonitorView) {
  const state = monitorState(monitor.status)
  return tableRow([
    monitor.name,
    `${state.icon} ${state.label}`,
    monitor.ping === null ? EMPTY_CELL : `${monitor.ping}ms`,
    markdownUptimeCell(monitor),
  ])
}

function markdownGroupSection(group: StatusGroupView) {
  return [
    `### ${group.name}`,
    '',
    tableRow(TABLE_HEADER),
    tableRow(TABLE_HEADER.map(() => '---')),
    ...group.monitors.map(markdownMonitorRow),
  ].join('\n')
}

/**
 * The Markdown bulletin: the verdict as a heading, the banner, one table per
 * group, the notices when there are any, then the freshness of the answer. The
 * banner URL is resolved by the caller, which owns the upload.
 */
export function formatStatusMarkdown(snapshot: StatusSnapshot, bannerUrl: string) {
  const verdict = verdictStyles[snapshot.health]
  return [
    `## ${verdict.icon} ${verdict.label}`,
    createQqMarkdownImageContent(bannerUrl, STATUS_BANNER_SIZE, STATUS_BANNER_SIZE, STATUS_BANNER_ALT),
    ...snapshot.groups.map(markdownGroupSection),
    noticeLines(snapshot).map(line => `> ${line}`).join('\n'),
    statusTimeLine(snapshot),
  ].filter(block => block.length > 0).join('\n\n')
}

/**
 * Status-page failures read as neutral sentences. They never name a score
 * backend, because the status page is not one.
 */
const failureTexts: Record<StatusPageError['kind'], string> = {
  connection: '暂时无法连接状态页，请稍后重试。',
  timeout: '状态页响应超时，请稍后重试。',
  malformed: '状态页返回的数据格式异常，请稍后重试。',
}

const EMPTY_TEXT = '状态页没有返回可用数据。'
const UNKNOWN_TEXT = '查询失败，请重试。'

export function mapStatusError(error: unknown) {
  if (error instanceof StatusPageEmptyError) return EMPTY_TEXT
  if (error instanceof StatusPageError) return failureTexts[error.kind]
  return UNKNOWN_TEXT
}
