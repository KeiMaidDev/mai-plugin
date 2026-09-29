import type { Command, Context } from 'koishi'
import h from '@satorijs/element'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { Worker } from 'node:worker_threads'
import { isRichTextPlatform } from '../constants'
import { MusicDifficulty } from '../domain/enums'
import type { ChartInfo, MusicInfo } from '../domain/music'
import { isAdministrator } from '../platform/admin'
import { transformAssetImageUrl } from '../platform/qq-markdown-image'
import {
  createPagedCallbackButtons,
  createInlineCommandLink,
  createQqButton,
  createQqButtonRow,
  createQqCommandAction,
  createQqKeyboard,
  createQqNativeMarkdown,
  createQqUrlAction,
  sendReply,
  type QqButtonRow,
} from '../platform/qq-message'
import { filterCharts, filterMusics } from '../query/combo-executor'
import { parseComboQuery } from '../query/combo-parser'
import { Semaphore } from '../utils/semaphore'
import {
  MAX_USER_REGEX_LENGTH,
  commandAction,
  compatibilityModeFor,
  replyAudio,
  replyText,
  SEARCH_PAGE_SIZE,
  SEARCH_TOO_MANY,
  type ActiveCommandSession,
  type CoreCommandDependencies,
} from './support'

const NOT_FOUND = '未找到相关歌曲。'
const LEVEL_USAGE = '用法：定数查歌 <定数或范围> [页数]'
const FIT_LEVEL_USAGE = '用法：拟合定数查歌 <定数或范围> [页数]'
const USER_REGEX_TIMEOUT_MS = 100
const USER_REGEX_STARTUP_TIMEOUT_MS = 1_000
const userRegexWorkerSemaphore = new Semaphore(2, 4)

export const REGEX_WORKER_BUSY_MESSAGE = '正则搜索繁忙，请稍后重试。'

type MusicSearchResult = MusicInfo | ChartInfo

function resolveDifficulty(token: string | undefined) {
  if (!token) return undefined
  const normalized = token.toLocaleLowerCase()
  return MusicDifficulty.values.find(difficulty => (
    difficulty.name.toLocaleLowerCase() === normalized
    || difficulty.names.some(name => name === token)
  ))
}

function isChart(result: MusicSearchResult): result is ChartInfo {
  return 'music' in result && 'difficulty' in result
}

function formatMusic(music: MusicInfo, chart?: ChartInfo) {
  return chart ? formatChartText(chart) : formatMusicText(music)
}

function fitLevel(chart: ChartInfo) {
  return chart.fitLevelValue ? chart.fitLevelValue.toFixed(1) : '-'
}

function chartDesigner(chart: ChartInfo) {
  return chart.notesDesigner.trim() || '-'
}

function formatMusicText(music: MusicInfo) {
  return [
    `${music.id}. ${music.name}`,
    `艺术家：${music.artist}`,
    `分类：${music.genre.genreName}`,
    `版本：${music.version.name}${music.isNew ? ' (计入 B15)' : ''}`,
    `BPM：${music.bpm}`,
    `定数：${music.charts.map(chart => chart.levelValue.toFixed(1)).join('/')}`,
    `拟合定数：${music.charts.map(fitLevel).join('/')}`,
    `谱师：${music.charts.map(chartDesigner).join('/')}`,
  ].join('\n')
}

function formatChartText(chart: ChartInfo) {
  const { music, notes } = chart
  return [
    `${chart.difficulty.brief}${music.id}. ${music.name}`,
    `曲师：${music.artist}`,
    `分类：${music.genre.genreName}`,
    `版本：${music.version.name}`,
    `BPM：${music.bpm}`,
    `等级：${chart.level} (${chart.levelValue.toFixed(1)})`,
    `谱师：${chartDesigner(chart)}`,
    ...(chart.fitLevelValue ? [`拟合定数：${fitLevel(chart)}`] : []),
    `TAP：${notes.tap}`,
    `HOLD：${notes.hold}`,
    `SLIDE：${notes.slide}`,
    `BREAK：${notes.break}`,
    ...(notes.touch ? [`TOUCH：${notes.touch}`] : []),
    `总物量：${notes.total}`,
    `总 DX 分：${chart.maxDeluxeScore}`,
  ].join('\n')
}

function commandLink(label: string, command: string) {
  return createInlineCommandLink(label || '-', command)
}

function jacketMarkdown(url: string, size: number, alt = '封面') {
  return `![${alt} #${size}px #${size}px](${url})`
}

function difficultyLabel(difficulty: MusicDifficulty) {
  const icon = difficulty === MusicDifficulty.Basic ? '🟩'
    : difficulty === MusicDifficulty.Advanced ? '🟨'
      : difficulty === MusicDifficulty.Expert ? '🟥'
        : difficulty === MusicDifficulty.Master ? '🟪'
          : difficulty === MusicDifficulty.ReMaster ? '⬜'
            : '🟫'
  return `${icon}${difficulty.brief}`
}

function chunkRows<T>(values: readonly T[], size: number) {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function musicKeyboard(music: MusicInfo) {
  const rows: QqButtonRow[] = chunkRows(music.charts, 5).map((charts, rowIndex) => (
    createQqButtonRow(charts.map((chart, columnIndex) => createQqButton(
      `music-level-${rowIndex}-${columnIndex}`,
      difficultyLabel(chart.difficulty),
      createQqCommandAction(`/mai id ${music.id} --difficulty ${chart.difficulty.brief}`, { enter: true }),
    )))
  ))
  rows.push(createQqButtonRow([
    createQqButton(
      'music-score',
      '查成绩',
      createQqCommandAction(`/mai info ${music.id}`, { enter: true }),
    ),
    createQqButton(
      'music-song-rating',
      '歌50',
      createQqCommandAction(`/mai 歌50 ${music.id}`, { enter: true }),
    ),
  ]))
  rows.push(createQqButtonRow([
    createQqButton(
      'music-preview',
      '试听一下',
      createQqCommandAction(`/mai 预览 id${music.id}`, { enter: true }),
      0,
    ),
    createQqButton(
      'music-alias',
      '添加别名',
      createQqCommandAction(`/mai 添加别名 ${music.id} `, {
        enter: false,
        unsupportTips: '请在命令末尾补充别名后发送。',
      }),
      0,
    ),
  ]))
  return createQqKeyboard(rows)
}

function chartKeyboard(chart: ChartInfo) {
  const chartId = chart.difficulty === MusicDifficulty.Utage
    ? chart.music.resourceId + 100_000
    : chart.music.resourceId
  const difficulty = chart.difficulty === MusicDifficulty.Utage ? 0 : chart.difficulty.value
  return createQqKeyboard([createQqButtonRow([createQqButton(
    'chart-preview',
    '谱面确认',
    createQqUrlAction(`https://otmdb.cn/jump/maimai_chart?chart_id=${chartId}&difficulty=${difficulty}`),
  )])])
}

function formatMusicMarkdown(music: MusicInfo, coverUrl: string | null) {
  const constants = music.charts.map(chart => (
    commandLink(chart.levelValue.toFixed(1), `/mai 定数查歌 ${chart.levelValue.toFixed(1)}`)
  )).join('/')
  const fits = music.charts.map(chart => chart.fitLevelValue
    ? commandLink(fitLevel(chart), `/mai 拟合定数查歌 ${fitLevel(chart)}`)
    : '-').join('/')
  const designers = music.charts.map(chart => {
    const designer = chartDesigner(chart)
    return designer === '-' ? designer : commandLink(designer, `/mai 谱师查歌 ${designer}`)
  }).join('/')
  return [
    ...(coverUrl ? [jacketMarkdown(coverUrl, 190)] : []),
    `**${music.id}. ${music.name}**`,
    `**曲师：** ${commandLink(music.artist, `/mai 曲师查歌 ${music.artist}`)}`,
    `**分类：** ${commandLink(music.genre.genreName, `/mai 搜索 ${music.genre.genreName}`)}`,
    `**版本：** ${commandLink(music.version.name, `/mai 版本查歌 ${music.version.name}`)}${music.isNew ? ' (计入 B15)' : ''}`,
    `**BPM：** ${commandLink(String(music.bpm), `/mai BPM查歌 ${music.bpm}`)}`,
    `**定数：** ${constants}`,
    `**谱师：** ${designers}`,
    `**拟合定数：** ${fits}`,
  ].join('\n')
}

function formatChartMarkdown(chart: ChartInfo, coverUrl: string | null) {
  const { music, notes } = chart
  const designer = chartDesigner(chart)
  return [
    ...(coverUrl ? [jacketMarkdown(coverUrl, 190)] : []),
    `**${chart.difficulty.brief}${music.id}. ${music.name}**`,
    `**曲师：** ${commandLink(music.artist, `/mai 曲师查歌 ${music.artist}`)}`,
    `**分类：** ${commandLink(music.genre.genreName, `/mai 搜索 ${music.genre.genreName}`)}`,
    `**版本：** ${commandLink(music.version.name, `/mai 版本查歌 ${music.version.name}`)}`,
    `**BPM：** ${commandLink(String(music.bpm), `/mai BPM查歌 ${music.bpm}`)}`,
    `**等级：** ${chart.level} (${commandLink(chart.levelValue.toFixed(1), `/mai 定数查歌 ${chart.levelValue.toFixed(1)}`)})`,
    `**谱师：** ${designer === '-' ? designer : commandLink(designer, `/mai 谱师查歌 ${designer}`)}`,
    ...(chart.fitLevelValue ? [
      `**拟合定数：** ${commandLink(fitLevel(chart), `/mai 拟合定数查歌 ${fitLevel(chart)}`)}`,
    ] : []),
    '',
    `> **TAP：** ${notes.tap}`,
    `> **HOLD：** ${notes.hold}`,
    `> **SLIDE：** ${notes.slide}`,
    `> **BREAK：** ${notes.break}`,
    ...(notes.touch ? [`> **TOUCH：** ${notes.touch}`] : []),
    `> **总物量：** ${notes.total}`,
    `> **总 DX 分：** ${chart.maxDeluxeScore}`,
  ].join('\n')
}

async function loadCover(
  dependencies: CoreCommandDependencies,
  music: MusicInfo,
) {
  try {
    const path = await dependencies.data.coverPath(music.resourceId)
    const extension = extname(path).toLocaleLowerCase()
    return {
      data: await readFile(path),
      mimeType: extension === '.jpg' || extension === '.jpeg'
        ? 'image/jpeg'
        : extension === '.webp'
          ? 'image/webp'
          : 'image/png',
    }
  } catch {
    return null
  }
}

const publicCoverCaches = new WeakMap<object, Map<string, Promise<string | null>>>()

function mappedCoverUrl(
  dependencies: CoreCommandDependencies,
  music: MusicInfo,
) {
  if (!dependencies.assetTransformer) return Promise.resolve(null)
  let cache = publicCoverCaches.get(dependencies)
  if (!cache) {
    cache = new Map()
    publicCoverCaches.set(dependencies, cache)
  }
  const key = String(music.resourceId)
  const existing = cache.get(key)
  if (existing) return existing
  const pending = (async () => {
    const cover = await loadCover(dependencies, music)
    if (!cover) return null
    try {
      return await transformAssetImageUrl(
        cover.data,
        cover.mimeType,
        dependencies.assetTransformer!,
      )
    } catch {
      return null
    }
  })()
  cache.set(key, pending)
  return pending
}

async function replyMusicDetails(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  music: MusicInfo,
  chart?: ChartInfo,
) {
  const text = chart ? formatChartText(chart) : formatMusicText(music)
  const compatibilityMode = await compatibilityModeFor(session, dependencies)
  const useQqMarkdown = isRichTextPlatform(session.platform) && !compatibilityMode
  const coverUrl = useQqMarkdown ? await mappedCoverUrl(dependencies, music) : null
  const cover = !useQqMarkdown || !coverUrl ? await loadCover(dependencies, music) : null
  const fallback = [
    ...(cover ? [{ type: 'image' as const, ...cover }] : []),
    { type: 'text' as const, text },
  ]
  const rich = createQqNativeMarkdown(
    chart ? formatChartMarkdown(chart, coverUrl) : formatMusicMarkdown(music, coverUrl),
    chart ? chartKeyboard(chart) : musicKeyboard(music),
  )
  if (useQqMarkdown && !coverUrl && cover) {
    await session.send([h.image(cover.data, cover.mimeType), rich])
    return
  }
  await sendReply(session, fallback, rich, {
    compatibilityMode,
  })
}

function resultLine(result: MusicSearchResult) {
  if (isChart(result)) {
    return `${result.difficulty.brief}${result.music.id}. ${result.music.name}`
  }
  return `${result.id}. ${result.name}`
}

function pageText(results: readonly MusicSearchResult[], page: number) {
  const totalPages = Math.max(1, Math.ceil(results.length / SEARCH_PAGE_SIZE))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const start = (currentPage - 1) * SEARCH_PAGE_SIZE
  const lines = results.slice(start, start + SEARCH_PAGE_SIZE).map(resultLine)
  const hint = totalPages > 1
    ? `您要查找的歌曲可能是 (${currentPage} / ${totalPages})：`
    : '您要查找的歌曲可能是：'
  return {
    currentPage,
    totalPages,
    text: `${hint}\n${lines.join('\n')}`,
  }
}

function resultMarkdown(result: MusicSearchResult, coverUrl: string | null) {
  const music = isChart(result) ? result.music : result
  const label = isChart(result)
    ? `${result.difficulty.brief}${music.id}. ${music.name}`
    : `${music.id}. ${music.name}`
  const command = isChart(result)
    ? `/mai id ${music.id} --difficulty ${result.difficulty.brief}`
    : `/mai id ${music.id}`
  const preview = coverUrl ? `${jacketMarkdown(coverUrl, 20, 'preview')} ` : ''
  return `${preview}${createInlineCommandLink(label, command)}`
}

async function createSearchPage(
  dependencies: CoreCommandDependencies,
  results: readonly MusicSearchResult[],
  page: number,
  pageCommand: (page: number) => string,
) {
  const view = pageText(results, page)
  const start = (view.currentPage - 1) * SEARCH_PAGE_SIZE
  const pageResults = results.slice(start, start + SEARCH_PAGE_SIZE)
  const coverUrls = await Promise.all(pageResults.map(result => (
    mappedCoverUrl(dependencies, isChart(result) ? result.music : result)
  )))
  const markdown = [
    `**${view.text.slice(0, view.text.indexOf('\n'))}**`,
    '',
    ...pageResults.map((result, index) => resultMarkdown(result, coverUrls[index])),
  ].join('\n')
  const row = createPagedCallbackButtons({
    page: view.currentPage,
    totalPages: view.totalPages,
    pageCommand,
  })
  return {
    ...view,
    rich: createQqNativeMarkdown(
      markdown,
      row.buttons.length ? createQqKeyboard([row]) : undefined,
    ),
  }
}

async function showResults(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  results: readonly MusicSearchResult[],
  page: number,
  pageCommand: (page: number) => string,
) {
  if (!results.length) {
    await replyText(session, dependencies, NOT_FOUND)
    return
  }
  if (results.length > SEARCH_TOO_MANY) {
    await replyText(session, dependencies, '在当前条件下查询到的曲目过多，请缩小范围。')
    return
  }
  if (results.length === 1) {
    const result = results[0]
    await replyMusicDetails(session, dependencies, isChart(result) ? result.music : result, isChart(result) ? result : undefined)
    return
  }

  const view = await createSearchPage(dependencies, results, page, pageCommand)
  await replyText(session, dependencies, view.text, view.rich)
}

interface PagedInput {
  input: string
  page: number
  explicitPage: boolean
}

function parsePagedInput(raw: string): PagedInput | null {
  const match = raw.trim().match(/^(.*?)(?:\s+--page\s+(\d+))?$/u)
  if (!match) return null
  const page = Number(match[2] ?? 1)
  if (!Number.isSafeInteger(page) || page < 1) return null
  return { input: match[1].trim(), page, explicitPage: match[2] !== undefined }
}

function musicPageCommand(command: string, input: string, page: number) {
  return `/mai ${command}${input ? ` ${input}` : ''} --page ${page}`
}

function parseLevelRange(raw: string) {
  const match = raw.trim().match(
    /^(\d+(?:\.\d+)?)(?:\s*(?:-|~|至)\s*(\d+(?:\.\d+)?))?(?:\s+(\d+))?$/,
  )
  if (!match) return null
  const first = Number(match[1])
  const second = Number(match[2] ?? match[1])
  const page = Number(match[3] ?? 1)
  if (![first, second, page].every(Number.isFinite) || page < 1 || !Number.isInteger(page)) {
    return null
  }
  return { begin: Math.min(first, second), end: Math.max(first, second), page }
}

function regexRiskReason(source: string) {
  if (source.length > MAX_USER_REGEX_LENGTH) return '正则表达式过长。'
  if (/\\[1-9]|\(\?(?:[=!]|<[=!])/.test(source)) return '正则表达式不安全。'
  if (/\((?:[^()]|\\.)*(?:[+*{]|\|)(?:[^()]|\\.)*\)[+*{]/.test(source)) {
    return '正则表达式不安全。'
  }
  if (/\.\*(?:[^\n]{0,16})\.\*/.test(source)) return '正则表达式不安全。'
  return null
}

type UserRegexValidation = { source: string } | { error: string }

function validateUserRegex(source: string): UserRegexValidation {
  const risk = regexRiskReason(source)
  if (risk) return { error: risk }
  try {
    new RegExp(source, 'iu')
    return { source }
  } catch {
    return { error: '请输入正确的正则表达式。' }
  }
}

type WorkerRegexResult = { matches: number[] } | { error: 'busy' | 'malformed' | 'timeout' }

const regexWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads')
try {
  const regex = new RegExp(workerData.source, 'iu')
  const matches = []
  for (let index = 0; index < workerData.values.length; index++) {
    if (regex.test(workerData.values[index])) matches.push(index)
  }
  parentPort.postMessage({ matches })
} catch {
  parentPort.postMessage({ error: 'malformed' })
}
`

function executeUserRegex(
  source: string,
  values: readonly string[],
  semaphore: Semaphore,
): Promise<WorkerRegexResult> {
  return semaphore.acquire().then(async (release) => {
    try {
      return await new Promise<WorkerRegexResult>((resolve) => {
        const worker = new Worker(regexWorkerSource, {
          eval: true,
          workerData: { source, values },
        })
        let settled = false
        let timeout: ReturnType<typeof setTimeout>
        const finish = (result: WorkerRegexResult) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          resolve(result)
        }
        const terminateAsTimeout = () => {
          if (settled) return
          settled = true
          void worker.terminate().finally(() => resolve({ error: 'timeout' }))
        }
        timeout = setTimeout(terminateAsTimeout, USER_REGEX_STARTUP_TIMEOUT_MS)
        worker.once('online', () => {
          if (settled) return
          clearTimeout(timeout)
          timeout = setTimeout(terminateAsTimeout, USER_REGEX_TIMEOUT_MS)
        })
        worker.once('message', (result: WorkerRegexResult) => finish(result))
        worker.once('error', () => finish({ error: 'malformed' }))
        worker.once('exit', (code) => {
          if (code !== 0) finish({ error: 'malformed' })
        })
      })
    } finally {
      release()
    }
  }, () => ({ error: 'busy' }))
}

function seededValue(input: string) {
  let state = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    state ^= input.charCodeAt(index)
    state = Math.imul(state, 0x01000193)
  }
  state += 0x6d2b79f5
  let value = state
  value = Math.imul(value ^ value >>> 15, value | 1)
  value ^= value + Math.imul(value ^ value >>> 7, value | 61)
  return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
}

function localDateKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}

async function selectSingleMusic(
  dependencies: CoreCommandDependencies,
  query: string,
) {
  return (await dependencies.aliasService.search(query.trim()))[0]
}

function registerTextCommand(
  ctx: Context,
  definition: string,
  description: string,
  aliases: readonly string[],
  action: (session: ActiveCommandSession, raw: string) => Promise<void>,
  config?: Command.Config,
) {
  return ctx.command(definition, description, config)
    .alias(...aliases)
    .action(commandAction(async ({ session }, raw = '') => {
      await action(session, raw)
    }))
}

export function registerMusicCommands(
  ctx: Context,
  dependencies: CoreCommandDependencies,
) {
  const commands = []

  commands.push(ctx.command('mai.id <id:posint>', '按曲目 ID 查询舞萌歌曲')
    .option('difficulty', '-d <difficulty:string> 指定谱面难度')
    .action(commandAction(async ({ session, options }, id) => {
      const music = dependencies.data.musics.get(id)
      if (!music) {
        await replyText(session, dependencies, '未找到该歌曲。')
        return
      }
      const difficulty = resolveDifficulty(options.difficulty)
      if (options.difficulty && !difficulty) {
        await replyText(session, dependencies, '未找到该歌曲或难度。')
        return
      }
      const chart = difficulty
        ? music.charts.find(entry => entry.difficulty === difficulty)
        : undefined
      if (difficulty && !chart) {
        await replyText(session, dependencies, '未找到该歌曲或难度。')
        return
      }
      await replyMusicDetails(session, dependencies, music, chart)
    })))

  commands.push(registerTextCommand(
    ctx,
    'mai.random [query:text]',
    '按随心配条件随机歌曲',
    ['mai.随个'],
    async (session, raw) => {
      const filters = raw.trim() ? parseComboQuery(raw) : []
      const musics = raw.trim()
        ? filters ? filterMusics(filters, dependencies.data.musics.values()) : []
        : [...dependencies.data.musics.values()]
      if (!musics.length) {
        await replyText(session, dependencies, NOT_FOUND)
        return
      }
      const random = dependencies.random?.() ?? Math.random()
      const index = Math.min(musics.length - 1, Math.floor(Math.max(0, random) * musics.length))
      await replyMusicDetails(session, dependencies, musics[index])
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.search <query:text>',
    '按曲名或别名查歌',
    ['mai.查歌'],
    async (session, raw) => {
      const paged = parsePagedInput(raw)
      if (!paged) {
        await replyText(session, dependencies, '请输入正确的页数。')
        return
      }
      const results = paged.input ? await dependencies.aliasService.search(paged.input) : []
      await showResults(
        session,
        dependencies,
        results,
        paged.page,
        page => musicPageCommand('查歌', paged.input, page),
      )
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.level-search <range:text>',
    '按谱面定数查歌',
    ['mai.定数查歌'],
    async (session, raw) => {
      const paged = parsePagedInput(raw)
      const range = paged && parseLevelRange(paged.input)
      if (!range) {
        await replyText(session, dependencies, LEVEL_USAGE)
        return
      }
      const page = paged.explicitPage ? paged.page : range.page
      const input = range.begin === range.end
        ? String(range.begin)
        : String(range.begin) + '-' + String(range.end)
      const charts = [...dependencies.data.musics.values()].flatMap(music => music.charts)
        .filter(chart => chart.difficulty !== MusicDifficulty.Utage)
        .filter(chart => chart.levelValue >= range.begin && chart.levelValue <= range.end)
      await showResults(
        session,
        dependencies,
        charts,
        page,
        targetPage => musicPageCommand('定数查歌', input, targetPage),
      )
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.fit-level-search <range:text>',
    '按拟合定数查歌',
    ['mai.拟合定数查歌'],
    async (session, raw) => {
      const paged = parsePagedInput(raw)
      const range = paged && parseLevelRange(paged.input)
      if (!range) {
        await replyText(session, dependencies, FIT_LEVEL_USAGE)
        return
      }
      const page = paged.explicitPage ? paged.page : range.page
      const input = range.begin === range.end
        ? String(range.begin)
        : String(range.begin) + '-' + String(range.end)
      const charts = [...dependencies.data.musics.values()].flatMap(music => music.charts)
        .filter(chart => chart.difficulty !== MusicDifficulty.Utage)
        .filter(chart => chart.fitLevelValue >= range.begin && chart.fitLevelValue <= range.end)
      await showResults(
        session,
        dependencies,
        charts,
        page,
        targetPage => musicPageCommand('拟合定数查歌', input, targetPage),
      )
    },
  ))

  const propertySearches = [
    {
      definition: 'mai.designer-search <query:text>',
      description: '按谱师查歌',
      aliases: ['mai.谱师查歌'],
      command: '谱师查歌',
      search: (query: string) => [...dependencies.data.musics.values()].flatMap(music => music.charts)
        .filter(chart => chart.notesDesigner.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    },
    {
      definition: 'mai.version-search <query:text>',
      description: '按版本查歌',
      aliases: ['mai.版本查歌'],
      command: '版本查歌',
      search: (query: string) => [...dependencies.data.musics.values()]
        .filter(music => music.version.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    },
    {
      definition: 'mai.artist-search <query:text>',
      description: '按曲师查歌',
      aliases: ['mai.曲师查歌'],
      command: '曲师查歌',
      search: (query: string) => [...dependencies.data.musics.values()]
        .filter(music => music.artist.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    },
  ] as const
  for (const search of propertySearches) {
    commands.push(registerTextCommand(
      ctx,
      search.definition,
      search.description,
      search.aliases,
      async (session, raw) => {
        const paged = parsePagedInput(raw)
        if (!paged) {
          await replyText(session, dependencies, '请输入正确的页数。')
          return
        }
        await showResults(
          session,
          dependencies,
          paged.input ? search.search(paged.input) : [],
          paged.page,
          page => musicPageCommand(search.command, paged.input, page),
        )
      },
    ))
  }

  commands.push(registerTextCommand(
    ctx,
    'mai.regex-search <pattern:text>',
    '按安全正则表达式查歌',
    ['mai.正则查歌'],
    async (session, raw) => {
      const paged = parsePagedInput(raw)
      if (!paged) {
        await replyText(session, dependencies, '请输入正确的页数。')
        return
      }
      const validated = validateUserRegex(paged.input)
      if ('error' in validated) {
        await replyText(session, dependencies, validated.error)
        return
      }
      const musics = [...dependencies.data.musics.values()]
      const execution = await executeUserRegex(
        validated.source,
        musics.map(music => music.name.slice(0, 256)),
        dependencies.regexWorkerSemaphore ?? userRegexWorkerSemaphore,
      )
      if ('error' in execution) {
        await replyText(
          session,
          dependencies,
          execution.error === 'busy'
            ? REGEX_WORKER_BUSY_MESSAGE
            : execution.error === 'timeout'
              ? '正则表达式执行超时。'
              : '请输入正确的正则表达式。',
        )
        return
      }
      const results = execution.matches.map(index => musics[index])
      await showResults(
        session,
        dependencies,
        results,
        paged.page,
        page => musicPageCommand('正则查歌', paged.input, page),
      )
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.bpm-search <query:text>',
    '按 BPM 查歌',
    ['mai.bpm查歌'],
    async (session, raw) => {
      const paged = parsePagedInput(raw)
      const [bpmText, legacyPageText] = paged?.input.split(/\s+/, 2) ?? []
      const bpm = Number(bpmText)
      const legacyPage = legacyPageText === undefined ? 1 : Number(legacyPageText)
      const page = paged?.explicitPage ? paged.page : legacyPage
      if (!paged || !Number.isSafeInteger(bpm) || bpm <= 0
        || !Number.isSafeInteger(page) || page < 1) {
        await replyText(session, dependencies, '请输入正确的 BPM 值和页数。')
        return
      }
      const results = [...dependencies.data.musics.values()].filter(music => music.bpm === bpm)
      await showResults(
        session,
        dependencies,
        results,
        page,
        targetPage => musicPageCommand('BPM查歌', String(bpm), targetPage),
      )
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.combo-search <query:text>',
    '按随心配组合条件查歌',
    ['mai.搜索'],
    async (session, raw) => {
      const paged = parsePagedInput(raw)
      const filters = paged && parseComboQuery(paged.input)
      const results = filters ? (
        filters.some(filter => filter.singleChart)
          ? filterCharts(filters, dependencies.data.musics.values())
          : filterMusics(filters, dependencies.data.musics.values())
      ) : []
      await showResults(
        session,
        dependencies,
        results,
        paged?.page ?? 1,
        page => musicPageCommand('搜索', paged?.input ?? '', page),
      )
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.alias-add <input:text>',
    '添加或投票歌曲别名',
    ['mai.添加别名'],
    async (session, raw) => {
      const [query, ...aliasParts] = raw.trim().split(/\s+/)
      const alias = aliasParts.join(' ').trim()
      if (!query || !alias) {
        await replyText(session, dependencies, '用法：添加别名 <曲目> <别名>')
        return
      }
      if (alias.length >= 32) {
        await replyText(session, dependencies, '别名过长。')
        return
      }
      const music = await selectSingleMusic(dependencies, query)
      if (!music) {
        await replyText(session, dependencies, '未找到该歌曲。')
        return
      }
      const subject = {
        userId: session.userId,
        authority: (session.user as { authority?: number } | undefined)?.authority,
        roles: session.event.member?.roles?.map(role => role.id),
      }
      if (isAdministrator(subject, { administrators: dependencies.administrators })) {
        await dependencies.aliasService.add(music.id, alias)
        await replyText(session, dependencies, '别名添加成功。')
      } else {
        const voted = await dependencies.aliasService.vote(music.id, alias, session.userId)
        await replyText(session, dependencies, voted ? '别名投票成功。' : '您已经投过票了。')
      }
    },
  ))

  commands.push(registerTextCommand(
    ctx,
    'mai.alias-remove <input:text>',
    '删除歌曲别名（管理员）',
    ['mai.删除别名'],
    async (session, raw) => {
      const [query, ...aliasParts] = raw.trim().split(/\s+/)
      const alias = aliasParts.join(' ').trim()
      if (!query || !alias) {
        await replyText(session, dependencies, '用法：删除别名 <曲目> <别名>')
        return
      }
      const subject = {
        userId: session.userId,
        authority: (session.user as { authority?: number } | undefined)?.authority,
        roles: session.event.member?.roles?.map(role => role.id),
      }
      if (!isAdministrator(subject, { administrators: dependencies.administrators })) {
        await replyText(session, dependencies, '权限不足。')
        return
      }
      const music = await selectSingleMusic(dependencies, query)
      if (!music) {
        await replyText(session, dependencies, '未找到该歌曲。')
        return
      }
      await dependencies.aliasService.remove(music.id, alias)
      await replyText(session, dependencies, '别名删除成功。')
    },
    { authority: 4, permissions: ['authority:0'] },
  ))

  commands.push(ctx.command('mai.daily', '生成稳定的今日舞萌推荐')
    .alias('mai.今日舞萌')
    .action(commandAction(async ({ session }) => {
      const musics = [...dependencies.data.musics.values()]
      if (!musics.length) {
        await replyText(session, dependencies, '本地曲目数据为空，暂无可推荐歌曲。')
        return
      }
      const now = dependencies.now?.() ?? new Date()
      const date = localDateKey(now)
      const seed = seededValue(`${session.userId}:${date}`)
      const music = musics[Math.min(musics.length - 1, Math.floor(seed * musics.length))]
      const luck = Math.floor(seededValue(`${session.userId}:${date}:luck`) * 100) + 1
      await replyText(
        session,
        dependencies,
        `${date}\n今日幸运指数：${luck}\n今日推荐歌曲：\n${formatMusic(music)}`,
      )
    })))

  commands.push(registerTextCommand(
    ctx,
    'mai.preview <query:text>',
    '发送本地歌曲预览',
    ['mai.预览'],
    async (session, raw) => {
      const music = raw.trim() ? await selectSingleMusic(dependencies, raw) : undefined
      if (!music) {
        await replyText(session, dependencies, '未找到该歌曲。')
        return
      }
      const audio = await dependencies.previewAudio?.(music)
      if (!audio || audio.byteLength === 0) {
        await replyText(session, dependencies, '该歌曲的本地预览不可用。')
        return
      }
      await replyAudio(session, audio)
    },
  ))

  return commands
}
