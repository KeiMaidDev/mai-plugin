import { StatusPageError } from '../providers/status-page'
import { StatusPageEmptyError, type StatusHealth, type StatusSnapshot } from '../services/status-service'

export const STATUS_BULLETIN_TITLE = '舞萌 DX 服务器状态'

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
  if (!date) return '未知'
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

/** The plain-text bulletin: the verdict, then the freshness of the answer. */
export function formatStatusText(snapshot: StatusSnapshot) {
  return [statusVerdictLine(snapshot), statusTimeLine(snapshot)].join('\n\n')
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
