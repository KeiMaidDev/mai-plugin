import { StatusSourceError } from '../providers/status-source'
import {
  StatusSourceEmptyError,
  type StatusServiceView,
  type StatusSnapshot,
} from '../services/status-service'
import { createQqMarkdownImageContent } from './qq-markdown-image'

export const STATUS_BULLETIN_TITLE = '舞萌 DX 服务器状态'

/** Every field the status source leaves empty reads as this. */
const UNKNOWN_VALUE = '未知'

export const STATUS_SOURCE_ATTRIBUTION = '数据来源：isMaiDown'

/**
 * The three pieces of artwork a verdict selects. Six verdicts share them: the
 * source's `nodata` has no image of its own and borrows the offline one, and
 * the wording is what keeps "nothing is reporting" apart from "all lines down".
 */
export type StatusBannerArt = 'normal' | 'degraded' | 'offline'

const verdictStyles: Record<string, { icon: string, label: string, art: StatusBannerArt }> = {
  normal: { icon: '✅', label: '一切正常', art: 'normal' },
  recovering: { icon: '🔄', label: '性能恢复中', art: 'normal' },
  degraded: { icon: '⚠️', label: '部分服务性能下降', art: 'degraded' },
  maintenance: { icon: '🛠️', label: '服务器维护中', art: 'degraded' },
  outage: { icon: '❌', label: '部分服务宕机', art: 'offline' },
  nodata: { icon: '❔', label: '暂无数据', art: 'offline' },
}

/** The blank shape a verdict we cannot name falls back to. */
const UNNAMED_VERDICT: { icon: string, label: string, art: StatusBannerArt } = {
  icon: '❔',
  label: UNKNOWN_VALUE,
  art: 'offline',
}

function verdictStyle(verdict: string) {
  return verdictStyles[verdict] ?? UNNAMED_VERDICT
}

/**
 * The source's own state labels, used only when it omits `state_text`. Keeping
 * the table here means a lost label degrades to the same wording rather than to
 * a blank cell, and a state neither table knows still prints its raw value.
 */
const serviceStateLabels: Record<string, string> = {
  ok: '正常',
  down: '宕机',
  degraded: '性能下降',
  recovering: '性能恢复',
  maintenance: '维护中',
  nodata: '无数据',
}

const serviceStateIcons: Record<string, string> = {
  ok: '✅',
  down: '❌',
  degraded: '⚠️',
  recovering: '🔄',
  maintenance: '🛠️',
  nodata: '❔',
}

interface ServiceState {
  icon: string
  label: string
  /** The source's machine state, used to decide what deserves an icon at all. */
  state: string
}

/**
 * The source's label wins when it sends one; otherwise the plugin's own tables
 * stand in. A state neither place knows prints `❔ <state>`, so a state added
 * upstream reads as its own name instead of as a generic unknown.
 */
function serviceState(service: StatusServiceView): ServiceState {
  const { state, stateText } = service
  if (!state) return { icon: '❔', label: stateText || UNKNOWN_VALUE, state }
  if (stateText) return { icon: serviceStateIcons[state] ?? '❔', label: stateText, state }
  const label = serviceStateLabels[state]
  if (label) return { icon: serviceStateIcons[state], label, state }
  return { icon: '❔', label: state, state }
}

const bannerAssets: Record<StatusBannerArt, string> = {
  normal: 'generated/status-normal.png',
  degraded: 'generated/status-degraded.png',
  offline: 'generated/status-offline.png',
}

/**
 * Declared banner size. The artwork is 33px wide (`status-offline.png` is 37×35),
 * so 33 is the largest square that never scales a file up: the client draws the
 * banner at its own pixels instead of enlarging them, which is what made it soft.
 */
export const STATUS_BANNER_SIZE = 33

/**
 * Reads the artwork a verdict selects, resolved from the package's own assets.
 * The verdict is the source's own key, so the caller hands it over unchanged.
 */
export type StatusBannerLoader = (verdict: string) => Promise<Buffer>

/** The artwork a verdict selects. Kept private so verdict is the only entry point. */
function statusBannerArt(verdict: string): StatusBannerArt {
  return verdictStyle(verdict).art
}

/** Path of the artwork a verdict selects, relative to the package's `assets/`. */
export function statusBannerAsset(verdict: string) {
  return bannerAssets[statusBannerArt(verdict)]
}

/** The short Chinese label of a verdict, or the source's sentence when nameless. */
export function statusVerdictLabel(snapshot: Pick<StatusSnapshot, 'verdict' | 'verdictText'>) {
  const style = verdictStyles[snapshot.verdict]
  if (style) return style.label
  return snapshot.verdictText || UNKNOWN_VALUE
}

export function statusVerdictIcon(verdict: string) {
  return verdictStyle(verdict).icon
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

export function statusFooterLines(snapshot: StatusSnapshot) {
  return [statusTimeLine(snapshot), STATUS_SOURCE_ATTRIBUTION]
}

function latencyField(latency: number | null) {
  return latency === null ? UNKNOWN_VALUE : `${latency}ms`
}

/** The source's broadcast message, or an empty list when it has none. */
export function statusNoticeLines(snapshot: StatusSnapshot) {
  return snapshot.broadcast ? [`公告：${snapshot.broadcast}`] : []
}

/** One service per line: `- <icon> <name>（<state>，<latency>）`. */
function formatServiceLine(service: StatusServiceView) {
  const state = serviceState(service)
  const fields = [state.label, latencyField(service.latency)]
  if (service.durationText) fields.push(service.durationText)
  return `- ${state.icon} ${service.name}（${fields.join('，')}）`
}

/**
 * The plain-text bulletin: the verdict, one line per service, the broadcast when
 * there is one, then the age of the answer and where it came from.
 */
export function formatStatusText(snapshot: StatusSnapshot) {
  const sections = [
    `${STATUS_BULLETIN_TITLE}：${statusVerdictLabel(snapshot)}`,
    snapshot.services.map(formatServiceLine).join('\n'),
    statusNoticeLines(snapshot).join('\n'),
    statusFooterLines(snapshot).join('\n'),
  ]
  return sections.filter(block => block.length > 0).join('\n\n')
}

const TABLE_HEADER = ['服务器', '状态', '延迟', '备注'] as const
const EMPTY_CELL = '-'

/** A table cell cannot carry a line break or a pipe without breaking the row. */
function tableCell(value: string) {
  return value.replaceAll('|', '\\|').replaceAll(/\s+/gu, ' ').trim()
}

function tableRow(cells: readonly string[]) {
  return `| ${cells.map(tableCell).join(' | ')} |`
}

function markdownServiceRow(service: StatusServiceView) {
  const state = serviceState(service)
  return tableRow([
    service.name,
    `${state.icon} ${state.label}`,
    service.latency === null ? EMPTY_CELL : `${service.latency}ms`,
    service.durationText || EMPTY_CELL,
  ])
}

function markdownTable(snapshot: StatusSnapshot) {
  return [
    tableRow(TABLE_HEADER),
    tableRow(TABLE_HEADER.map(() => '---')),
    ...snapshot.services.map(markdownServiceRow),
  ].join('\n')
}

/**
 * The Markdown bulletin: the verdict as a heading the artwork opens, the service
 * table, the broadcast as a quote line, then the age of the answer and where it
 * came from as a second quote line. The banner URL is resolved by the caller,
 * which owns the upload.
 */
/** One Markdown quote block, so the notice and the footer share their shape. */
function quoteBlock(lines: readonly string[]) {
  return lines.map(line => `> ${line}`).join('\n')
}

export function formatStatusMarkdown(snapshot: StatusSnapshot, bannerUrl: string) {
  // The artwork stands where the verdict emoji used to, and carries that emoji
  // as its alt text so a client that cannot draw it still shows the verdict.
  const artwork = createQqMarkdownImageContent(
    bannerUrl,
    STATUS_BANNER_SIZE,
    STATUS_BANNER_SIZE,
    statusVerdictIcon(snapshot.verdict),
  )
  return [
    `## ${artwork} ${statusVerdictLabel(snapshot)}`,
    markdownTable(snapshot),
    quoteBlock(statusNoticeLines(snapshot)),
    quoteBlock(statusFooterLines(snapshot)),
  ].filter(block => block.length > 0).join('\n\n')
}

/**
 * Status-source failures read as neutral sentences that name the platform, so
 * a reader can tell the source being down from the bot being broken. They never
 * name a score backend, because the status source is not one.
 */
const failureTexts: Record<StatusSourceError['kind'], string> = {
  connection: '暂时无法连接 isMaiDown 状态服务，请稍后重试。',
  timeout: 'isMaiDown 状态服务响应超时，请稍后重试。',
  malformed: 'isMaiDown 状态服务返回的数据格式异常，请稍后重试。',
}

const EMPTY_TEXT = 'isMaiDown 状态服务没有返回可用数据。'
const UNKNOWN_TEXT = '查询失败，请重试。'

export function mapStatusError(error: unknown) {
  if (error instanceof StatusSourceEmptyError) return EMPTY_TEXT
  if (error instanceof StatusSourceError) return failureTexts[error.kind]
  return UNKNOWN_TEXT
}
