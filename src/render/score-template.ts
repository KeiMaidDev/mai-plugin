import type { Node } from '@takumi-rs/helpers'
import type { MaimaiDataStore } from '../data/sync-service'
import { MusicDifficulty, Rate } from '../domain/enums'
import type { ChartInfo, MusicInfo, RecordEntry } from '../domain/music'
import { DeluxeScore } from '../domain/rating'
import { resolvePackageAssetPath } from './assets'
import { RenderImageCollector, type RenderImageSource } from './image-collector'
import { createContainerNode, createImageNode, createTextNode } from './nodes'
import { MAIMAI_DIFFICULTY_COLORS, type MaimaiDifficultyName } from './rating-template'
import type { TakumiRenderService } from './renderer'

export const SCORE_TEMPLATE_SIZE = Object.freeze({ width: 800, height: 800 })

const FONT_H = '阿里巴巴普惠体-H'
const FONT_H_FALLBACK = "'阿里巴巴普惠体-H', '方正兰亭特黑_GBK'"

export interface ScoreRenderInput {
  music: MusicInfo
  records?: readonly RecordEntry[]
}

export interface ScoreRenderPlan {
  node: Node
  width: number
  height: number
  images: RenderImageSource[]
}

const standardDifficulties = [
  MusicDifficulty.Basic,
  MusicDifficulty.Advanced,
  MusicDifficulty.Expert,
  MusicDifficulty.Master,
  MusicDifficulty.ReMaster,
] as const

function difficultyColor(name: string) {
  return MAIMAI_DIFFICULTY_COLORS[name as MaimaiDifficultyName]
}

function scoreAsset(name: string) {
  return resolvePackageAssetPath(`score/${name}.png`)
}

async function assetKey(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  name: string,
) {
  return collector.collect(service, scoreAsset(name))
}

function coverKey(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  data: MaimaiDataStore,
  resourceId: number,
) {
  return collector.collect(service, data.coverPath(resourceId), resolvePackageAssetPath('fallback/cover.png'))
}

/** Header (cover background + info) of a score image. */
async function musicHeader(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  data: MaimaiDataStore,
  music: MusicInfo,
): Promise<Node> {
  const [cover, infoBg, headerMask, coverMask, divider, type, genre, version] = await Promise.all([
    coverKey(collector, service, data, music.resourceId),
    assetKey(collector, service, 'info_bg'),
    assetKey(collector, service, 'header_mask'),
    assetKey(collector, service, 'cover_mask'),
    assetKey(collector, service, 'divider'),
    assetKey(collector, service, `type_${music.type.value}`),
    assetKey(collector, service, `genre_${music.genre.id}`),
    assetKey(collector, service, `version_${music.version.version}`),
  ])

  return createContainerNode({
    id: 'header',
    style: { width: 704, height: 227, backgroundImage: `url("${infoBg}")`, backgroundSize: 'cover', flexDirection: 'column' },
    children: [
      createContainerNode({
        id: 'header-cover',
        style: {
          width: 704,
          height: 227,
          padding: 26,
          backgroundImage: `url("${cover}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          opacity: 0.15,
          maskImage: `url("${headerMask}")`,
        },
        children: [
          createImageNode({
            id: 'cover',
            src: cover,
            width: 175,
            height: 175,
            style: { width: 175, height: 175, objectFit: 'fill', maskImage: `url("${coverMask}")`, flexShrink: 0 },
          }),
          createContainerNode({
            id: 'right',
            style: { height: 180, flexDirection: 'column', justifyContent: 'space-between', marginLeft: 20 },
            children: [
              createContainerNode({
                id: 'top',
                style: { flexDirection: 'row' },
                children: [
                  createImageNode({ id: 'type', src: type, style: { marginRight: 7 } }),
                  createTextNode({ id: 'id', text: `ID ${music.id}`, style: { fontSize: 18, fontFamily: FONT_H, color: '#ffffff', marginTop: -1 } }),
                ],
              }),
              createContainerNode({
                id: 'title-container',
                style: { justifyContent: 'center', flexDirection: 'column', height: 100, marginTop: -2 },
                children: [
                  createTextNode({
                    id: 'title',
                    text: music.name,
                    style: { width: 457, fontSize: 46, fontFamily: FONT_H_FALLBACK, color: '#ffffff', textFit: 'shrink' },
                  }),
                  createTextNode({
                    id: 'artist',
                    text: music.artist,
                    style: { fontSize: 18, fontFamily: FONT_H_FALLBACK, color: '#ffffff', marginTop: 8 },
                  }),
                ],
              }),
              createImageNode({ id: 'divider', src: divider, style: { alignSelf: 'flex-start' } }),
              createContainerNode({
                id: 'bottom',
                style: { flexDirection: 'row', marginTop: 4 },
                children: [
                  createImageNode({ id: 'genre', src: genre, style: { marginRight: 8 } }),
                  createImageNode({ id: 'version', src: version, style: { marginRight: 8 } }),
                  createTextNode({ id: 'bpm', text: `BPM ${music.bpm}`, style: { fontSize: 18, fontFamily: FONT_H, color: '#ffffff', marginTop: 7 } }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  })
}

/** One difficulty row. */
async function difficultyRow(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  chart: ChartInfo,
  record: RecordEntry | undefined,
): Promise<Node> {
  const difficulty = chart.difficulty.name
  const color = difficultyColor(difficulty)
  const stars = record ? DeluxeScore.stars(record.deluxeScore, chart.maxDeluxeScore) : 0

  const [base, levelBg, rank, combo, sync, dxstar, noteBg] = await Promise.all([
    assetKey(collector, service, `base_${difficulty}`),
    assetKey(collector, service, 'level_bg'),
    assetKey(collector, service, `rank_${record?.rate ?? 'none'}`),
    assetKey(collector, service, `icon_${record ? record.comboStatus.value : 'blank'}`),
    assetKey(collector, service, `icon_${record ? record.syncStatus.value : 'blank'}`),
    assetKey(collector, service, `icon_dxstar_${stars}`),
    assetKey(collector, service, 'note_designer_bg'),
  ])

  return createContainerNode({
    className: 'score-difficulty-row',
    attributes: { 'data-difficulty': difficulty, 'data-empty': String(!record) },
    style: {
      width: 704,
      height: 79,
      backgroundImage: `url("${base}")`,
      backgroundSize: 'cover',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: '1px 22px 0 18px',
      margin: '6px 0 0 2px',
      flexShrink: 0,
    },
    children: [
      createContainerNode({
        style: {
          width: 43,
          height: 43,
          backgroundImage: `url("${levelBg}")`,
          backgroundSize: 'cover',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '2px 1px 1px 1px',
          flexShrink: 0,
        },
        children: [
          createTextNode({ text: 'LV', style: { fontSize: 12, fontFamily: FONT_H, color, lineHeight: 1 } }),
          createTextNode({
            text: chart.levelValue !== 0 ? chart.levelValue.toFixed(1) : '-',
            style: { fontSize: 18, fontFamily: FONT_H, color, marginTop: -4, lineHeight: 1 },
          }),
        ],
      }),
      createContainerNode({
        style: { width: 140, justifyContent: 'flex-start', margin: '-1px 2px 0 -2px', flexShrink: 0 },
        children: [
          createTextNode({
            text: record ? Rate.toString(record.achievement) : (chart.levelValue === 0 ? '无此难度' : '暂无记录'),
            style: { fontSize: 24, fontFamily: FONT_H, color: '#ffffff', marginLeft: 12 },
          }),
        ],
      }),
      createContainerNode({
        style: { width: 77, justifyContent: 'center', flexShrink: 0 },
        children: [createImageNode({ src: rank, style: { flexShrink: 0 } })],
      }),
      createImageNode({ src: combo, style: { flexShrink: 0 } }),
      createImageNode({ src: sync, style: { flexShrink: 0 } }),
      createContainerNode({
        style: { flexDirection: 'column', justifyContent: 'center', alignItems: 'center', marginRight: 3, flexShrink: 0 },
        children: [
          createTextNode({
            text: record ? `${record.deluxeScore}/${chart.maxDeluxeScore}` : ' ',
            style: { fontSize: 16, fontFamily: FONT_H, color: '#ffffff' },
          }),
          createImageNode({ src: dxstar, style: { flexShrink: 0 } }),
        ],
      }),
      createContainerNode({
        style: {
          width: 194,
          height: 42,
          backgroundImage: `url("${noteBg}")`,
          backgroundSize: 'cover',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          flexShrink: 0,
        },
        children: [
          createTextNode({ text: chart.notesDesigner, style: { fontSize: 12, fontFamily: FONT_H, color: '#ffffff', textAlign: 'center' } }),
        ],
      }),
    ],
  })
}

function scoreFooter(caption: string) {
  return createContainerNode({
    id: 'footer',
    style: { justifyContent: 'center', backgroundColor: '#013162', padding: 12 },
    children: [
      createTextNode({
        text: caption,
        style: { fontSize: 22, fontFamily: FONT_H, color: '#ffffff', textShadow: '#000000 1px 1px' },
      }),
    ],
  })
}

export async function createScoreRenderPlan(
  input: ScoreRenderInput,
  renderService: TakumiRenderService,
  data: MaimaiDataStore,
  footerText?: string,
): Promise<ScoreRenderPlan> {
  const collector = new RenderImageCollector()
  const caption = (footerText ?? '').trim().replace(/\s+/gu, ' ')

  const background = await assetKey(collector, renderService, 'background')
  const header = await musicHeader(collector, renderService, data, input.music)

  const utageChart = input.music.charts.find(entry => entry.difficulty === MusicDifficulty.Utage)
  const rows: Node[] = []
  if (utageChart) {
    rows.push(await difficultyRow(
      collector, renderService, utageChart,
      input.records?.find(entry => entry.music.id === input.music.id && entry.chart.difficulty === MusicDifficulty.Utage),
    ))
  } else {
    for (const difficulty of standardDifficulties) {
      const chart = input.music.charts.find(entry => entry.difficulty === difficulty)
      if (!chart) continue
      const record = input.records?.find(entry => entry.music.id === input.music.id && entry.chart.difficulty === difficulty)
      rows.push(await difficultyRow(collector, renderService, chart, record))
    }
    if (!input.music.charts.some(entry => entry.difficulty === MusicDifficulty.ReMaster)) {
      rows.push(await difficultyRow(collector, renderService, input.music.fakeReMaster, undefined))
    }
  }

  return {
    width: SCORE_TEMPLATE_SIZE.width,
    height: SCORE_TEMPLATE_SIZE.height,
    images: collector.images,
    node: createContainerNode({
      id: 'score-template',
      style: {
        width: SCORE_TEMPLATE_SIZE.width,
        height: SCORE_TEMPLATE_SIZE.height,
        backgroundImage: `url("${background}")`,
        backgroundSize: 'cover',
        flexDirection: 'column',
        justifyContent: 'space-between',
        overflow: 'hidden',
      },
      children: [
        createContainerNode({
          id: 'upper',
          style: { width: 800, height: 745, flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
          children: [header, ...rows],
        }),
        scoreFooter(caption),
      ],
    }),
  }
}
