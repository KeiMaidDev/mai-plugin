import type { Context } from 'koishi'
import h from '@satorijs/element'
import { MusicDifficulty } from '../domain/enums'
import type { ChartInfo, MusicInfo, RecordEntry } from '../domain/music'
import type { RecordsResponse } from '../domain/player'
import { Rating } from '../domain/rating'
import {
  createQqButton,
  createQqButtonRow,
  createQqCommandAction,
  createPagedCommandButtons,
  createQqKeyboard,
  createQqNativeMarkdown,
} from '../platform/qq-message'
import { filterCharts, filterMusics, filterRecords } from '../query/combo-executor'
import { parseComboQuery } from '../query/combo-parser'
import type { ComboFilter } from '../query/filter-types'
import {
  commandAction,
  replyImage,
  replyMarkdownImage,
  replyQueryError,
  replyText,
  SCORE_LIST_PAGE_SIZE,
  type ActiveCommandSession,
  type CoreCommandDependencies,
} from './support'

function querySession(session: ActiveCommandSession) {
  return {
    userId: session.userId,
    sessionId: `${session.platform}:${session.channelId}`,
    command: session.content,
    mentions: session.elements
      ?.filter(element => element.type === 'at')
      .map(element => ({
        userId: String(element.attrs.id ?? ''),
        qq: element.attrs.id ? String(element.attrs.id) : undefined,
        isBot: String(element.attrs.id ?? '') === session.selfId,
        isSelf: String(element.attrs.id ?? '') === session.userId,
      })),
  }
}

async function commandFailure(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  error: unknown,
  isSelf = true,
) {
  await replyQueryError(session, dependencies, error, isSelf)
}

function resultRecords(response: RecordsResponse, filters?: readonly ComboFilter[] | null) {
  return filters ? filterRecords(filters, response.records) ?? [] : [...response.records]
}

function ratingCounts(total: number) {
  const newCount = Math.min(15, total)
  return { newCount, oldCount: Math.max(0, total - newCount) }
}

export function ratingSelfQueryCommand(filterText: string, total: number) {
  if (![15, 25, 35, 40, 50].includes(total)) {
    throw new RangeError('Unsupported Rating count.')
  }
  const filter = filterText.trim()
  return `/mai rating ${filter ? `${filter} ` : ''}b${total}`
}

export function createRatingKeyboard(filterText: string, total: number) {
  return createQqKeyboard([createQqButtonRow([
    createQqButton(
      `rating-self-b${total}`,
      '我也要查',
      createQqCommandAction(ratingSelfQueryCommand(filterText, total), { enter: true }),
    ),
    createQqButton(
      'rating-score-list',
      '成绩列表',
      createQqCommandAction('/mai 分数列表', { enter: true }),
    ),
    createQqButton(
      'rating-settings',
      '查分设置',
      createQqCommandAction('/mai 查分设置', { enter: true }),
    ),
  ])])
}

function createSongRatingKeyboard(music: MusicInfo, chart: ChartInfo) {
  const query = `${chart.difficulty.brief}id${music.id}`
  return createQqKeyboard([createQqButtonRow([
    createQqButton(
      'song-rating-self',
      '我也要查',
      createQqCommandAction(`/mai 歌50 ${query}`, { enter: true }),
    ),
    createQqButton(
      'song-rating-score',
      '单曲成绩',
      createQqCommandAction(`/mai info ${music.id}`, { enter: true }),
    ),
    createQqButton(
      'song-rating-settings',
      '查分设置',
      createQqCommandAction('/mai 查分设置', { enter: true }),
    ),
  ])])
}

function splitRatingRecords(records: readonly RecordEntry[], total: number) {
  const counts = ratingCounts(total)
  return {
    oldRecords: records.filter(record => !record.music.isNew).slice(0, counts.oldCount),
    newRecords: records.filter(record => record.music.isNew).slice(0, counts.newCount),
    ...counts,
  }
}

function ratingRenderInput(
  backend: string,
  player: RecordsResponse['player'],
  settings: RecordsResponse['settings'],
  oldRecords: readonly RecordEntry[],
  newRecords: readonly RecordEntry[],
  total: number,
  newGroupDisabled = false,
) {
  const { oldCount, newCount } = ratingCounts(total)
  const legacy = total < 50
  const normalize = (record: RecordEntry) => legacy
    ? { ...record, rating: Rating.calcOld(record.chart, record.achievement) }
    : record
  const selectedOld = oldRecords.slice(0, oldCount).map(normalize)
  const selectedNew = newRecords.slice(0, newCount).map(normalize)
  const oldRating = selectedOld.reduce((sum, record) => sum + record.rating, 0)
  const newRating = selectedNew.reduce((sum, record) => sum + record.rating, 0)
  const courseRating = legacy ? Rating.courseOld(player.course) : 0
  const rating = oldRating + newRating + courseRating
  const coursePart = courseRating ? ` + COURSE ${courseRating}` : ''
  return {
    backend,
    player,
    settings,
    oldRecords: selectedOld,
    newRecords: selectedNew,
    oldCount,
    newCount,
    newGroupDisabled,
    rating,
    title: `[${backend}] B${oldCount} ${oldRating} + B${newCount} ${newRating}${coursePart} = ${rating}`,
  }
}

function scoreListPageCommand(filter: string, page: number) {
  const normalized = filter.trim()
  return `/mai 成绩列表${normalized ? ` ${normalized}` : ''} ${page}`
}

async function createScoreListPage(
  dependencies: CoreCommandDependencies,
  response: RecordsResponse,
  backend: string,
  records: readonly RecordEntry[],
  filter: string,
  requestedPage: number,
) {
  const totalPages = Math.max(1, Math.ceil(records.length / SCORE_LIST_PAGE_SIZE))
  const currentPage = Math.min(Math.max(1, requestedPage), totalPages)
  const offset = (currentPage - 1) * SCORE_LIST_PAGE_SIZE
  const pageRecords = records.slice(offset, offset + SCORE_LIST_PAGE_SIZE)
  const image = await dependencies.renderer.renderRating({
    backend,
    player: response.player,
    settings: response.settings,
    oldRecords: pageRecords,
    newRecords: [],
    oldCount: SCORE_LIST_PAGE_SIZE,
    newCount: 0,
    rating: response.player.rating,
    title: `[${backend}] ${filter.trim() || '全部'}成绩列表 ${currentPage} / ${totalPages}`,
  })
  const text = `${currentPage} / ${totalPages}`
  const row = createPagedCommandButtons({
    page: currentPage,
    totalPages,
    pageCommand: page => scoreListPageCommand(filter, page),
  })
  const keyboard = row.buttons.length ? createQqKeyboard([row]) : undefined
  const rich = createQqNativeMarkdown(text, keyboard)
  return { image, text, rich }
}

function chartKey(chart: ChartInfo) {
  return `${chart.music.id}:${chart.difficulty.value}`
}

function groupsFor(charts: readonly ChartInfo[]) {
  return MusicDifficulty.values
    .map(difficulty => ({
      label: difficulty.name,
      charts: charts.filter(chart => chart.difficulty === difficulty),
    }))
    .filter(group => group.charts.length)
}

function sampleCharts(
  charts: readonly ChartInfo[],
  count: number,
  random: () => number,
) {
  const pool = [...charts]
  return Array.from({ length: count }, () => {
    const value = random()
    const index = Math.min(
      pool.length - 1,
      Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * pool.length)),
    )
    return pool.splice(index, 1)[0]
  })
}

function levelProgress(charts: readonly ChartInfo[], completed: ReadonlySet<string>) {
  return Object.fromEntries(MusicDifficulty.values.map(difficulty => {
    const selected = charts.filter(chart => chart.difficulty === difficulty)
    return [difficulty.name, {
      total: selected.length,
      completed: selected.filter(chart => completed.has(chartKey(chart))).length,
    }]
  }))
}

function filtersAndCharts(
  dependencies: CoreCommandDependencies,
  raw: string,
) {
  const filters = raw.trim() ? parseComboQuery(raw) : []
  if (!filters) return null
  return {
    filters,
    charts: filterCharts(filters, dependencies.data.musics.values()),
    musics: filterMusics(filters, dependencies.data.musics.values()),
  }
}

async function renderLevelTable(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  title: string,
  charts: readonly ChartInfo[],
  records?: readonly RecordEntry[],
  completed = new Set<string>(),
) {
  if (!charts.length) {
    await replyText(session, dependencies, '未找到符合条件的谱面。')
    return
  }
  const image = await dependencies.renderer.renderLevel({
    title,
    groups: groupsFor(charts),
    records,
    showProgress: records !== undefined,
    progress: records === undefined ? undefined : levelProgress(charts, completed),
  })
  await replyImage(session, dependencies, image)
}

async function songByAlias(
  dependencies: CoreCommandDependencies,
  raw: string,
) {
  return (await dependencies.aliasService.search(raw.trim()))[0]
}

function parseSongRatingQuery(raw: string) {
  const match = raw.trim().match(/^(?:(绿谱?|黄谱?|红谱?|紫谱?|白谱?|Basic|Advanced|Expert|Master|ReMaster)\s*)?(.+)$/i)
  if (!match) return null
  const difficultyName = match[1]?.replace('谱', '').toLocaleLowerCase()
  return {
    difficulty: difficultyName
      ? MusicDifficulty.values.find(entry => (
        entry.name.toLocaleLowerCase() === difficultyName
        || entry.names.some(name => name.toLocaleLowerCase() === difficultyName)
      ))
      : undefined,
    query: match[2].trim(),
  }
}

export function registerImageCommands(
  ctx: Context,
  dependencies: CoreCommandDependencies,
) {
  const commands = []

  commands.push(ctx.command('mai.rating <input:text>', '生成 B15/B25/B35/B40/B50 成绩图')
    .alias('mai.b15', { args: ['b15'] })
    .alias('mai.b25', { args: ['b25'] })
    .alias('mai.b35', { args: ['b35'] })
    .alias('mai.b40', { args: ['b40'] })
    .alias('mai.b50', { args: ['b50'] })
    .action(commandAction(async ({ session }, input) => {
      const match = input.match(/^(.*?)(?:b)(15|25|35|40|50)(?:\s+(.*))?$/i)
      if (!match) return
      const filterText = match[1].trim()
      const total = Number(match[2])
      const target = match[3]?.trim() ?? ''
      let isSelf = true
      let image: Buffer | undefined
      try {
        const user = await dependencies.queryService.getQueryParams(querySession(session), target)
        isSelf = user.isSelf !== false
        if (!filterText) {
          const { response, provider } = await dependencies.queryService.rating(user)
          image = await dependencies.renderer.renderRating(ratingRenderInput(
            provider.name,
            response.player,
            response.settings,
            response.oldRatingList,
            response.newRatingList,
            total,
          ))
        } else {
          const selected = filtersAndCharts(dependencies, filterText)
          if (!selected?.musics.length) {
            await replyText(session, dependencies, '未找到符合条件的歌曲。')
            return
          }
          const { response, provider } = await dependencies.queryService.records(user, selected.musics)
          const records = resultRecords(response, selected.filters)
          if (!records.length) {
            await replyText(session, dependencies, '当前条件下没有成绩。')
            return
          }
          const split = splitRatingRecords(records, total)
          image = await dependencies.renderer.renderRating(ratingRenderInput(
            provider.name,
            response.player,
            response.settings,
            split.oldRecords,
            split.newRecords,
            total,
            selected.filters.some(filter => filter.disable15),
          ))
        }
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
        return
      }
      if (!image) return
      await replyMarkdownImage(session, dependencies, image, {
        alt: `B${total}`,
        keyboard: createRatingKeyboard(filterText, total),
      })
    })))

  commands.push(ctx.command('mai.song-rating <query:text>', '将同一首歌填充为歌50成绩图')
    .alias('mai.歌50')
    .action(commandAction(async ({ session }, raw) => {
      const parsed = parseSongRatingQuery(raw)
      const music = parsed?.query ? await songByAlias(dependencies, parsed.query) : undefined
      if (!parsed || !music) {
        await replyText(session, dependencies, '使用方法：歌50 (难度)id/名称/别名')
        return
      }
      let isSelf = true
      try {
        const user = await dependencies.queryService.getQueryParams(querySession(session))
        isSelf = user.isSelf !== false
        const [{ response: rating, provider }, { response: records }] = await Promise.all([
          dependencies.queryService.rating(user),
          dependencies.queryService.record(user, music),
        ])
        const record = parsed.difficulty
          ? records.find(entry => entry.chart.difficulty === parsed.difficulty)
          : [...records]
            .filter(entry => entry.achievement > 0)
            .sort((left, right) => right.chart.difficulty.value - left.chart.difficulty.value)[0]
        if (!record) {
          await replyText(
            session,
            dependencies,
            parsed.difficulty ? '未查询到该歌曲该难度的游玩记录。' : '未查询到该歌曲的游玩记录。',
          )
          return
        }
        const oldRecords = Array.from({ length: 35 }, () => record)
        const newRecords = Array.from({ length: 15 }, () => record)
        const totalRating = record.rating * 50
        const image = await dependencies.renderer.renderRating({
          backend: provider.name,
          player: rating.player,
          settings: rating.settings,
          oldRecords,
          newRecords,
          oldCount: oldRecords.length,
          newCount: newRecords.length,
          rating: totalRating,
          title: `[${provider.name}] 歌50 ${record.chart.difficulty.brief}${music.id}. ${music.name} × 50 = ${totalRating}`,
        })
        await replyMarkdownImage(session, dependencies, image, {
          alt: 'B50',
          keyboard: createSongRatingKeyboard(music, record.chart),
        })
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
      }
    })))

  commands.push(ctx.command('mai.score-list [filter:string] [page:posint]', '生成成绩列表')
    .alias('mai.分数列表', 'mai.分数表', 'mai.成绩列表', 'mai.成绩表')
    .action(commandAction(async ({ session }, filterText = '', pageText = '') => {
      const page = pageText ? Number(pageText) : 1
      if (!Number.isSafeInteger(page) || page < 1) {
        await replyText(session, dependencies, '请输入正确的页数。')
        return
      }
      let isSelf = true
      try {
        const selected = filtersAndCharts(dependencies, filterText)
        if (!selected) {
          await replyText(session, dependencies, '未找到符合条件的歌曲。')
          return
        }
        const user = await dependencies.queryService.getQueryParams(querySession(session))
        isSelf = user.isSelf !== false
        const musics = selected.musics.length
          ? selected.musics
          : [...dependencies.data.musics.values()]
        const { response, provider } = await dependencies.queryService.records(user, musics)
        const records = resultRecords(response, selected.filters)
        if (!records.length) {
          await replyText(session, dependencies, '当前条件下没有成绩。')
          return
        }
        const rendered = await createScoreListPage(
          dependencies,
          response,
          provider.name,
          records,
          filterText,
          page,
        )
        await replyImage(
          session,
          dependencies,
          rendered.image,
          rendered.text,
          rendered.rich,
        )
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
      }
    })))

  commands.push(ctx.command('mai.level-table [filter:text]', '生成定数表')
    .alias('mai.定数表')
    .action(commandAction(async ({ session }, filterText = '') => {
      const selected = filtersAndCharts(dependencies, filterText)
      if (!selected) {
        await replyText(session, dependencies, '未找到符合条件的谱面。')
        return
      }
      try {
        await renderLevelTable(session, dependencies, `${filterText}定数表`, selected.charts)
      } catch (error) {
        await commandFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.complete-table [filter:text]', '生成完成表或进度表')
    .alias('mai.完成表', 'mai.进度表')
    .action(commandAction(async ({ session }, filterText = '') => {
      const selected = filtersAndCharts(dependencies, filterText)
      if (!selected?.charts.length) {
        await replyText(session, dependencies, '未找到符合条件的谱面。')
        return
      }
      let isSelf = true
      try {
        const user = await dependencies.queryService.getQueryParams(querySession(session))
        isSelf = user.isSelf !== false
        const { response } = await dependencies.queryService.records(user, selected.musics)
        const matched = filterRecords(selected.filters, response.records, true)
          ?? response.records.filter(record => record.achievement >= 800_000)
        const completed = new Set(matched.map(record => chartKey(record.chart)))
        await renderLevelTable(
          session,
          dependencies,
          `${filterText}完成表`,
          selected.charts,
          response.records,
          completed,
        )
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
      }
    })))

  commands.push(ctx.command('mai.incomplete-table [filter:text]', '生成未完成表')
    .alias('mai.未完成表', 'mai.未完成列表')
    .action(commandAction(async ({ session }, filterText = '') => {
      const selected = filtersAndCharts(dependencies, filterText)
      if (!selected?.charts.length) {
        await replyText(session, dependencies, '未找到符合条件的谱面。')
        return
      }
      let isSelf = true
      try {
        const user = await dependencies.queryService.getQueryParams(querySession(session))
        isSelf = user.isSelf !== false
        const { response } = await dependencies.queryService.records(user, selected.musics)
        const matched = filterRecords(selected.filters, response.records, true)
          ?? response.records.filter(record => record.achievement >= 800_000)
        const completed = new Set(matched.map(record => chartKey(record.chart)))
        const remains = selected.charts.filter(chart => !completed.has(chartKey(chart)))
        if (!remains.length) {
          await replyText(session, dependencies, '恭喜您已完成所有谱面！')
          return
        }
        await renderLevelTable(
          session,
          dependencies,
          `${filterText}未完成表`,
          remains,
          response.records,
          completed,
        )
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
      }
    })))

  commands.push(ctx.command('mai.song-score <query:text>', '生成单曲成绩图')
    .option('difficulty', '-d <difficulty:string> 只显示指定难度')
    .alias('mai.info', 'mai.minfo')
    .alias('mai.绿谱成绩', { options: { difficulty: '绿谱' } })
    .alias('mai.黄谱成绩', { options: { difficulty: '黄谱' } })
    .alias('mai.红谱成绩', { options: { difficulty: '红谱' } })
    .alias('mai.紫谱成绩', { options: { difficulty: '紫谱' } })
    .alias('mai.白谱成绩', { options: { difficulty: '白谱' } })
    .action(commandAction(async ({ session, options }, query) => {
      const music = await songByAlias(dependencies, query)
      if (!music) {
        await replyText(session, dependencies, '未找到该歌曲。')
        return
      }
      let isSelf = true
      try {
        const user = await dependencies.queryService.getQueryParams(querySession(session))
        isSelf = user.isSelf !== false
        const { response } = await dependencies.queryService.record(user, music)
        const difficulty = options.difficulty
          ? MusicDifficulty.from(options.difficulty.replace('谱', ''))
          : undefined
        const records = difficulty
          ? response.filter(record => record.chart.difficulty === difficulty)
          : response
        const image = await dependencies.renderer.renderScore({ music, records })
        await replyImage(session, dependencies, image)
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
      }
    })))

  commands.push(ctx.command('mai.course <name:text>', '生成段位表')
    .alias('mai.段位表')
    .action(commandAction(async ({ session }, name = '') => {
      const normalized = name.trim().toLocaleLowerCase()
      const course = [...dependencies.data.courses.values()].find(entry => (
        entry.name.trim().toLocaleLowerCase() === normalized
        || String(entry.id) === normalized
      ))
      if (!course) {
        await replyText(session, dependencies, '未找到该段位。')
        return
      }
      let isSelf = true
      try {
        const eligibleCharts = course.random
          ? [...dependencies.data.musics.values()].flatMap(music => music.charts)
            .filter(chart => chart.levelValue >= course.lower && chart.levelValue <= course.upper)
          : []
        if (course.random && eligibleCharts.length < 4) {
          await replyText(session, dependencies, '随机段位可用谱面不足 4 张。')
          return
        }
        const charts = course.random
          ? sampleCharts(eligibleCharts, 4, dependencies.random ?? Math.random)
          : course.musics.map(entry => dependencies.data.musics.get(entry.id)?.charts.find(
            chart => chart.difficulty.value === entry.difficulty,
          )).filter((chart): chart is ChartInfo => Boolean(chart))
        const musics = [...new Set(charts.map(chart => chart.music))]
        const user = await dependencies.queryService.getQueryParams(querySession(session))
        isSelf = user.isSelf !== false
        const { response } = await dependencies.queryService.records(user, musics)
        const image = await dependencies.renderer.renderCourse({
          course,
          songs: charts.map(chart => ({
            chart,
            record: response.records.find(record => chartKey(record.chart) === chartKey(chart)),
          })),
        })
        await replyImage(session, dependencies, image)
      } catch (error) {
        await commandFailure(session, dependencies, error, isSelf)
      }
    })))

  return commands
}
