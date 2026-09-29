import { StatusPageError } from '../providers/status-page'
import {
  HEALTHY_MONITOR_STATUS,
  StatusPageEmptyError,
  type StatusGroupView,
  type StatusHealth,
  type StatusMonitorView,
  type StatusSnapshot,
} from '../services/status-service'

export const STATUS_BULLETIN_TITLE = '舞萌 DX 服务器状态'

/** Every field the status page leaves empty reads as this. */
const UNKNOWN_VALUE = '未知'

const verdictLabels: Record<StatusHealth, string> = {
  normal: '移动线路正常',
  degraded: '部分线路异常',
  offline: '移动线路全部离线',
}

export function statusVerdictLabel(health: StatusHealth) {
  return verdictLabels[health]
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

function uptimeField(uptime: number) {
  return `24h ${(uptime * 100).toFixed(1)}%`
}

/**
 * One monitor per line: `- <icon> <name>（<state>，<latency>）`. A monitor that
 * is not healthy appends its 24-hour availability; a healthy one stays short.
 */
function formatMonitorLine(monitor: StatusMonitorView) {
  const state = monitorState(monitor.status)
  const fields = [state.label, latencyField(monitor.ping)]
  if (monitor.status !== HEALTHY_MONITOR_STATUS && monitor.uptime !== null) {
    fields.push(uptimeField(monitor.uptime))
  }
  return `- ${state.icon} ${monitor.name}（${fields.join('，')}）`
}

/** A group heading followed by one line per monitor. */
function formatStatusGroup(group: StatusGroupView) {
  return [group.name, ...group.monitors.map(formatMonitorLine)].join('\n')
}

const INCIDENT_LABEL = '公告与故障'
const MAINTENANCE_LABEL = '计划维护'

/**
 * One line per list, so several titles share a line. Both lists empty yields an
 * empty block, which the bulletin drops together with its blank line.
 */
function statusNoticeBlock(snapshot: Pick<StatusSnapshot, 'incidents' | 'maintenance'>) {
  const lines: string[] = []
  if (snapshot.incidents.length > 0) lines.push(`${INCIDENT_LABEL}：${snapshot.incidents.join('；')}`)
  if (snapshot.maintenance.length > 0) lines.push(`${MAINTENANCE_LABEL}：${snapshot.maintenance.join('；')}`)
  return lines.join('\n')
}

/**
 * The plain-text bulletin: the verdict, one block per displayed group, the
 * notices when there are any, then the freshness of the answer.
 */
export function formatStatusText(snapshot: StatusSnapshot) {
  return [
    statusVerdictLine(snapshot),
    ...snapshot.groups.map(formatStatusGroup),
    statusNoticeBlock(snapshot),
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
