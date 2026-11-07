import { Argv, type Context, type Session } from 'koishi'
import { parseComboQuery } from '../query/combo-parser'

export interface ComboCommandExecution {
  name: string
  args?: any[]
  options?: Record<string, any>
}

export type ComboCommandResolution =
  | { type: 'none' }
  | { type: 'invalid' }
  | { type: 'command', execution: ComboCommandExecution }

interface TextSuffix {
  suffix: string
  command: string
  argument: 'filter' | 'score-list' | 'user' | 'target'
}

const COMBO_ERROR = '未找到有效的随心配条件。'

const TEXT_SUFFIXES = ([
  { suffix: '未完成列表', command: 'mai.incomplete-table', argument: 'user' },
  { suffix: '未完成表', command: 'mai.incomplete-table', argument: 'user' },
  { suffix: '分数列表', command: 'mai.score-list', argument: 'score-list' },
  { suffix: '分数表', command: 'mai.score-list', argument: 'score-list' },
  { suffix: '成绩列表', command: 'mai.score-list', argument: 'score-list' },
  { suffix: '成绩表', command: 'mai.score-list', argument: 'score-list' },
  { suffix: '进度表', command: 'mai.complete-table', argument: 'user' },
  { suffix: '完成表', command: 'mai.complete-table', argument: 'user' },
  { suffix: '定数表', command: 'mai.level-table', argument: 'filter' },
  { suffix: '进度', command: 'mai.progress', argument: 'target' },
] satisfies readonly TextSuffix[]).sort((left, right) => right.suffix.length - left.suffix.length)

const TEXT_SUFFIX_PATTERN = new RegExp(
  `^(.*?)(${TEXT_SUFFIXES.map(entry => entry.suffix).join('|')})`
  + String.raw`(?=\s|$|(?=<at\s))(?:[\s]+([\s\S]*))?$`,
)
const RATING_SUFFIX_PATTERN = /^(.*?)(?:b(40|50)|(40|50))(?:[\s]+([\s\S]+))?$/i
const SCORE_LIST_PAGE_PATTERN = /(^|\s)(\d{1,2})(?=\s|$)/

function validFilter(filter: string) {
  return !filter || parseComboQuery(filter) !== null
}

function textExecution(suffix: TextSuffix, filter: string, rest: string): ComboCommandExecution | null {
  if (!validFilter(filter)) return null
  if (suffix.argument === 'filter') {
    return rest.trim() ? null : { name: suffix.command, args: [filter], options: {} }
  }
  if (suffix.argument === 'score-list') {
    const pageMatch = rest.match(SCORE_LIST_PAGE_PATTERN)
    const page = pageMatch ? Number(pageMatch[2]) : 1
    const target = pageMatch
      ? `${rest.slice(0, pageMatch.index)}${rest.slice((pageMatch.index ?? 0) + pageMatch[0].length)}`.trim()
      : rest.trim()
    return { name: suffix.command, args: [filter, page, target], options: {} }
  }
  const target = rest.trim()
  if (suffix.argument === 'target') {
    return { name: suffix.command, args: [filter, target], options: {} }
  }
  return { name: suffix.command, args: [filter], options: { target } }
}

export function resolveComboCommand(input: string): ComboCommandResolution {
  const source = input.trim()
  const textMatch = source.match(TEXT_SUFFIX_PATTERN)
  if (textMatch) {
    const suffix = TEXT_SUFFIXES.find(entry => entry.suffix === textMatch[2])
    if (!suffix) return { type: 'none' }
    const execution = textExecution(suffix, textMatch[1].trim(), textMatch[3] ?? '')
    return execution ? { type: 'command', execution } : { type: 'invalid' }
  }

  const ratingMatch = source.match(RATING_SUFFIX_PATTERN)
  if (ratingMatch) {
    const filter = ratingMatch[1].trim()
    if (!validFilter(filter)) return { type: 'invalid' }
    const total = ratingMatch[2] ?? ratingMatch[3]
    const target = ratingMatch[4]?.trim() ?? ''
    return {
      type: 'command',
      execution: {
        name: 'mai.rating',
        args: [`${filter}b${total}${target ? ` ${target}` : ''}`],
        options: {},
      },
    }
  }

  return { type: 'none' }
}

export function serializeComboCommand(execution: ComboCommandExecution) {
  const args = (execution.args ?? []).map(value => JSON.stringify(String(value)))
  const options = Object.entries(execution.options ?? {}).flatMap(([key, value]) => {
    if (value === undefined || value === false) return []
    if (value === true) return [`--${key}`]
    return [`--${key}`, JSON.stringify(String(value))]
  })
  return [execution.name, ...args, ...options].join(' ')
}

function isTargetLike(value: string) {
  return /^qq\d+$/i.test(value) || /^<at\s/i.test(value)
}

function shouldUseExactAliasFallback(commandName: string | undefined, input: string) {
  if (commandName === 'mai.rating') return /^b(?:40|50)\s+\S/i.test(input)

  if (commandName === 'mai.score-list') {
    const match = input.match(/^(?:分数列表|分数表|成绩列表|成绩表)(?:\s+([\s\S]*))?$/)
    const trailing = match?.[1]?.trim()
    if (!trailing) return false
    const tokens = trailing.split(/\s+/)
    if (/^\d{1,2}$/.test(tokens[0])) {
      const rest = tokens.slice(1).join(' ')
      return tokens.length === 1 || !/^\d+$/.test(tokens[1]) || isTargetLike(rest)
    }
    return isTargetLike(trailing) || parseComboQuery(trailing) === null
  }

  if (commandName === 'mai.complete-table' || commandName === 'mai.incomplete-table') {
    const match = input.match(/^(?:完成表|进度表|未完成表|未完成列表)(?:\s+([\s\S]*))?$/)
    const trailing = match?.[1]?.trim()
    return Boolean(trailing && (isTargetLike(trailing) || parseComboQuery(trailing) === null))
  }

  if (commandName === 'mai.progress') {
    const match = input.match(/^进度(?:\s+([\s\S]*))?$/)
    const trailing = match?.[1]?.trim()
    return Boolean(trailing && (isTargetLike(trailing) || parseComboQuery(trailing) === null))
  }

  return false
}

export function registerComboFallback(ctx: Context) {
  const fallback = (content: string, session: Session): Argv | undefined => {
    const prefix = session.stripped.prefix
    if (typeof prefix !== 'string') return

    const match = content.match(/^mai(?:\s+|$)([\s\S]*)$/i)
    if (!match?.[1]) return
    const input = match[1]
    const probe = Argv.parse(content)
    probe.session = session
    const commandName = ctx.$commander.inferCommand(probe)?.name
    if (commandName !== 'mai' && !shouldUseExactAliasFallback(commandName, input)) return

    const resolution = resolveComboCommand(input)
    if (resolution.type === 'command') {
      return {
        name: resolution.execution.name,
        args: resolution.execution.args,
        options: resolution.execution.options,
      } as Argv
    }
    if (resolution.type === 'invalid') {
      return {
        name: 'mai',
        args: [],
        options: {},
        comboError: COMBO_ERROR,
      } as Argv
    }
  }
  return ctx.before('parse', fallback as (content: string, session: Session) => Argv)
}
