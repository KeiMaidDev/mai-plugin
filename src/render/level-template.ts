import type { Node } from '@takumi-rs/helpers'
import type { MaimaiDataStore } from '../data/sync-service'
import { MusicDifficulty } from '../domain/enums'
import type { ChartInfo, RecordEntry } from '../domain/music'
import { resolvePackageAssetPath } from './assets'
import { RenderImageCollector, type RenderImageSource } from './image-collector'
import { createContainerNode, createImageNode, createTextNode } from './nodes'
import { MAIMAI_DIFFICULTY_COLORS, type MaimaiDifficultyName } from './rating-template'
import type { TakumiRenderService } from './renderer'

export const LEVEL_TEMPLATE_WIDTH = 1280
export const LEVEL_TEMPLATE_MIN_HEIGHT = 1280

const FONT_H = '阿里巴巴普惠体-H'

export type LevelRequirement = 'achievement' | 'combo' | 'sync'

export interface LevelChartGroup {
  label: string
  charts: readonly ChartInfo[]
}

export interface LevelProgressValue {
  completed: number
  total: number
}

export interface LevelRenderInput {
  title: string
  groups: readonly LevelChartGroup[]
  records?: readonly RecordEntry[]
  requirement?: LevelRequirement
  showProgress?: boolean
  progress?: Partial<Record<MaimaiDifficultyName, LevelProgressValue>>
}

export interface LevelRenderPlan {
  node: Node
  width: number
  height?: number
  images: RenderImageSource[]
}

/** Difficulty order for progress bars, descending (ReMaster -> Basic). */
const PROGRESS_DIFFICULTIES = [
  MusicDifficulty.ReMaster,
  MusicDifficulty.Master,
  MusicDifficulty.Expert,
  MusicDifficulty.Advanced,
  MusicDifficulty.Basic,
] as const

/** Hardcoded text-stroke colors KarenBot uses for the progress count labels. */
const PROGRESS_STROKE: Record<string, string> = {
  ReMaster: '#9f51dc',
  Master: '#c576ff',
  Expert: '#ff5a66',
  Advanced: '#f8b709',
  Basic: '#45c124',
}

function difficultyColor(name: string) {
  return MAIMAI_DIFFICULTY_COLORS[name as MaimaiDifficultyName]
}

function levelAsset(name: string) {
  return resolvePackageAssetPath(`level/${name}.png`)
}

function recordFor(chart: ChartInfo, records: readonly RecordEntry[] | undefined) {
  return records?.find(record =>
    record.music.id === chart.music.id && record.chart.difficulty === chart.difficulty,
  )
}

/** Which completion icon a tile shows for its requirement. */
function tileScoreIcon(record: RecordEntry | undefined, requirement: LevelRequirement): string | undefined {
  if (!record) return undefined
  if (requirement === 'combo') return record.comboStatus.isFC() ? record.comboStatus.value : undefined
  if (requirement === 'sync') return record.syncStatus.isFS() ? record.syncStatus.value : undefined
  return record.achievement >= 800_000 ? record.rate : undefined
}

function tileScoreAsset(icon: string | undefined, requirement: LevelRequirement) {
  if (!icon) return undefined
  return requirement === 'achievement' ? `rank_${icon}` : `icon_${icon}`
}

/** Header "all" completion icon, only when every chart is completed. */
function allIconName(groups: readonly LevelChartGroup[], records: readonly RecordEntry[] | undefined, requirement: LevelRequirement): string | undefined {
  if (!records) return undefined
  const all = groups.flatMap(group => group.charts)
  const matched = all.map(chart => recordFor(chart, records))
  if (matched.some(record => !record)) return undefined

  const present = matched as RecordEntry[]
  if (requirement === 'combo') {
    const min = present.reduce((a, b) => (a.comboStatus.id < b.comboStatus.id ? a : b))
    return min.comboStatus.id === 0 ? undefined : min.comboStatus.value
  }
  if (requirement === 'sync') {
    const min = present.reduce((a, b) => (a.syncStatus.id < b.syncStatus.id ? a : b))
    return min.syncStatus.id === 0 ? undefined : min.syncStatus.value
  }
  const min = present.reduce((a, b) => (a.achievement < b.achievement ? a : b))
  if (min.achievement >= 970_000) return min.rate
  if (min.achievement >= 800_000) return 'clear'
  return undefined
}

async function levelTile(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  data: MaimaiDataStore,
  chart: ChartInfo,
  record: RecordEntry | undefined,
  requirement: LevelRequirement,
): Promise<Node> {
  const color = difficultyColor(chart.difficulty.name)
  const cover = await collector.collect(service, data.coverPath(chart.music.resourceId), resolvePackageAssetPath('fallback/cover.png'))
  const type = await collector.collect(service, levelAsset(`type_${chart.music.type.value}`))
  const icon = tileScoreIcon(record, requirement)
  const scoreSrc = icon ? await collector.collect(service, levelAsset(tileScoreAsset(icon, requirement)!)) : undefined
  const idText = String(chart.music.id)

  return createContainerNode({
    className: 'level-chart-tile',
    attributes: { 'data-difficulty': chart.difficulty.name, 'data-music-id': idText },
    style: {
      width: 80,
      height: 80,
      backgroundColor: color,
      padding: 4,
      margin: '0 4 8 4',
      flexShrink: 0,
    },
    children: [
      createContainerNode({
        style: {
          width: 72,
          height: 72,
          backgroundImage: `url("${cover}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        },
        children: [
          createContainerNode({
            style: { width: 72, height: 72, flexDirection: 'column', justifyContent: 'space-between' },
            children: [
              createContainerNode({
                style: { justifyContent: 'space-between', width: 72 },
                children: [
                  createImageNode({ src: type, style: { objectFit: 'none', width: 14, height: 7, margin: '1px 0 0 1px' } }),
                  createContainerNode({
                    style: {
                      width: 25 + (idText.length - 3) * 5,
                      justifyContent: 'center',
                      backgroundColor: color,
                      margin: '-2px -4px 0 0',
                      padding: '0 0 2px 0',
                    },
                    children: [createTextNode({ text: idText, style: { fontSize: 10, fontFamily: FONT_H, color: '#ffffff' } })],
                  }),
                ],
              }),
              createContainerNode({
                style: {
                  justifyContent: 'center',
                  alignItems: 'center',
                  width: 72,
                  height: 72,
                  marginTop: -16,
                  ...(scoreSrc ? { backgroundColor: 'rgba(0, 0, 0, 0.5)' } : {}),
                },
                children: scoreSrc ? [createImageNode({ src: scoreSrc, style: { objectFit: 'none' } })] : [],
              }),
            ],
          }),
        ],
      }),
    ],
  })
}

async function levelGroup(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  data: MaimaiDataStore,
  group: LevelChartGroup,
  records: readonly RecordEntry[] | undefined,
  requirement: LevelRequirement,
): Promise<Node> {
  const labelBg = await collector.collect(service, levelAsset('level'))
  const tiles = await Promise.all(group.charts.map(chart =>
    levelTile(collector, service, data, chart, recordFor(chart, records), requirement),
  ))
  return createContainerNode({
    className: 'level-group',
    attributes: { 'data-level': group.label },
    style: { margin: '0 0 12 0' },
    children: [
      createContainerNode({
        style: {
          width: 80,
          height: 80,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundImage: `url("${labelBg}")`,
          backgroundSize: 'cover',
          padding: '4px 0 0 0',
          margin: '0 14 0 14',
          flexShrink: 0,
        },
        children: [createTextNode({ text: group.label, style: { fontSize: 22, fontFamily: FONT_H, color: '#ffffff' } })],
      }),
      createContainerNode({
        style: { width: 1120, flexWrap: 'wrap', marginLeft: 6 },
        children: tiles,
      }),
    ],
  })
}

async function progressBar(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  difficulty: MusicDifficulty,
  progress: LevelProgressValue | undefined,
  show: boolean,
): Promise<{ bar: Node; num: Node }> {
  const name = difficulty.name
  const [bgKey, overlayKey] = await Promise.all([
    collector.collect(service, levelAsset(`progress_background_${name}`)),
    collector.collect(service, levelAsset(`progress_overlay_${name}`)),
  ])
  const width = progress && progress.total > 0 ? Math.round(progress.completed / progress.total * 80) : 0
  const text = progress ? `${progress.completed}/${progress.total}` : '0/0'
  return {
    bar: createContainerNode({
      style: { width: 80, height: 18, backgroundImage: `url("${bgKey}")`, backgroundSize: 'cover', flexShrink: 0 },
      children: [createContainerNode({
        style: { width, backgroundImage: `url("${overlayKey}")`, backgroundSize: 'cover' },
      })],
    }),
    num: createContainerNode({
      style: { width: 80, flexShrink: 0 },
      children: [createTextNode({
        text,
        style: {
          fontSize: show ? 16 : 18,
          fontFamily: FONT_H,
          color: '#ffffff',
          WebkitTextStroke: `3px ${PROGRESS_STROKE[name] ?? '#ffffff'}`,
          textShadow: 'rgba(0, 0, 0, 0.2) 1px 1px',
        },
      })],
    }),
  }
}

async function progressBlock(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  difficulties: readonly MusicDifficulty[],
  progress: LevelRenderInput['progress'],
  smallText: boolean,
): Promise<Node> {
  const bgKey = await collector.collect(service, levelAsset(`progress_background_${difficulties.length}`))
  const items = await Promise.all(difficulties.map(diff =>
    progressBar(collector, service, diff, progress?.[diff.name as MaimaiDifficultyName], smallText),
  ))
  return createContainerNode({
    style: { width: 422, height: 116, flexDirection: 'column', justifyContent: 'center', margin: '4px 0 0 10px' },
    children: [
      createContainerNode({
        style: {
          width: 422,
          height: 28,
          backgroundImage: `url("${bgKey}")`,
          backgroundSize: 'cover',
          justifyContent: 'space-between',
          padding: 5,
        },
        children: items.map(item => item.bar),
      }),
      createContainerNode({
        style: { width: 422, justifyContent: 'space-between', padding: '0 5px 0 5px' },
        children: items.map(item => item.num),
      }),
    ],
  })
}

function scoreFooter(caption: string) {
  return createContainerNode({
    id: 'footer',
    style: { justifyContent: 'center', backgroundColor: '#013162', padding: 12 },
    children: [
      createTextNode({ text: caption, style: { fontSize: 22, fontFamily: FONT_H, color: '#ffffff', textShadow: '#000000 1px 1px' } }),
    ],
  })
}

export async function createLevelRenderPlan(
  input: LevelRenderInput,
  renderService: TakumiRenderService,
  data: MaimaiDataStore,
  footerText?: string,
): Promise<LevelRenderPlan> {
  const collector = new RenderImageCollector()
  const caption = (footerText ?? '').trim().replace(/\s+/gu, ' ')
  const requirement = input.requirement ?? 'achievement'
  const showProgress = !!input.showProgress

  const bgKey = await collector.collect(renderService, levelAsset('background'))

  const allIcon = allIconName(input.groups, input.records, requirement)
  const allSrc = allIcon ? await collector.collect(renderService, levelAsset(`all_${allIcon}`)) : undefined

  const hasReMaster = input.groups.some(group => group.charts.some(chart => chart.difficulty === MusicDifficulty.ReMaster))
  const smallText = !!input.progress && Object.values(input.progress).some(v => (v?.total ?? 0) >= 100)
  const progressDiffs = (hasReMaster ? PROGRESS_DIFFICULTIES : PROGRESS_DIFFICULTIES.slice(1)) as readonly MusicDifficulty[]

  const progressNode = showProgress
    ? await progressBlock(collector, renderService, progressDiffs, input.progress, smallText)
    : undefined

  const groups = await Promise.all(input.groups.map(group =>
    levelGroup(collector, renderService, data, group, input.records, requirement),
  ))

  const headerChildren: Node[] = [
    createTextNode({
      text: input.title,
      style: {
        fontSize: 36,
        fontFamily: FONT_H,
        color: '#fbf8e9',
        WebkitTextStroke: '12px #e84472',
        textShadow: 'rgba(0, 0, 0, 0.2) 1px 1px',
        margin: '36px 10px 0 0',
      },
    }),
  ]
  if (allSrc) headerChildren.push(createImageNode({ src: allSrc, style: { objectFit: 'none', margin: '0 0 0 5px' } }))
  if (progressNode) headerChildren.push(progressNode)

  return {
    width: LEVEL_TEMPLATE_WIDTH,
    height: undefined,
    images: collector.images,
    node: createContainerNode({
      id: 'level-template',
      style: {
        width: LEVEL_TEMPLATE_WIDTH,
        minHeight: LEVEL_TEMPLATE_MIN_HEIGHT,
        backgroundImage: `url("${bgKey}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'top center',
        flexDirection: 'column',
        justifyContent: 'space-between',
        overflow: 'hidden',
      },
      children: [
        createContainerNode({
          id: 'upper',
          style: { width: 1280, padding: 48, flexDirection: 'column' },
          children: [
            createContainerNode({
              id: 'header',
              style: { minHeight: 116, margin: '-20px 0 0 12px' },
              children: headerChildren,
            }),
            createContainerNode({
              id: 'list',
              style: { flexDirection: 'column', margin: '16px 0 0 -2px' },
              children: groups,
            }),
          ],
        }),
        scoreFooter(caption),
      ],
    }),
  }
}
