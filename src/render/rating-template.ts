import type { Node } from '@takumi-rs/helpers'
import type { MaimaiDataStore } from '../data/sync-service'
import { Rate } from '../domain/enums'
import type { RecordEntry } from '../domain/music'
import type { PlayerInfo, PlayerSettings } from '../domain/player'
import { DeluxeScore, Rating } from '../domain/rating'
import { resolvePackageAssetPath } from './assets'
import { createContainerNode, createImageNode, createTextNode } from './nodes'
import type { TakumiRenderService } from './renderer'
import { MAIMAI_RENDER_THEME } from './theme'

export const MAIMAI_DIFFICULTY_COLORS = Object.freeze({
  Basic: '#45c124',
  Advanced: '#f8b709',
  Expert: '#ff5a66',
  Master: '#9f51dc',
  ReMaster: '#dbaaff',
  Utage: '#ff6ffd',
} as const)

export type MaimaiDifficultyName = keyof typeof MAIMAI_DIFFICULTY_COLORS
export const RATING_TEMPLATE_SIZE = Object.freeze({ width: 1280, height: 1280 })

export interface RatingRenderInput {
  backend: string
  player: PlayerInfo
  settings?: PlayerSettings | null
  oldRecords: readonly RecordEntry[]
  newRecords: readonly RecordEntry[]
  oldCount?: number
  newCount?: number
  rating?: number
  title?: string
}

export interface RatingRenderPlan {
  node: Node
  width: number
  height: number
}

const CARD_X = 43
const CARD_Y = 187
const CARD_STEP_X = 239
const CARD_STEP_Y = 94
const CARD_COLUMNS = 5
const DIVIDER_HEIGHT = 73
const FOOTER_Y = 1235

function countOf(value: number | undefined, fallback: number, name: string) {
  const count = value ?? fallback
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`${name} must be a non-negative integer`)
  return count
}

function textAt(text: string, x: number, y: number, width: number, height: number, fontSize: number, color: string) {
  return createTextNode({
    text,
    style: {
      position: 'absolute', left: x, top: y, width, height,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize, fontWeight: 700, lineHeight: 1.1, color,
    },
  })
}

async function artwork(service: TakumiRenderService, name: string, x: number, y: number, width: number, height: number) {
  const src = await service.loadAsset(resolvePackageAssetPath(`rating/${name}.png`))
  return createImageNode({
    src, width, height,
    style: { position: 'absolute', left: x, top: y, width, height },
  })
}

function imageAt(src: Buffer, x: number, y: number, width: number, height: number) {
  return createImageNode({
    src, width, height,
    style: { position: 'absolute', left: x, top: y, width, height, objectFit: 'cover' },
  })
}

function ratingColor(input: RatingRenderInput, rating: number, oldCount: number, newCount: number) {
  if (newCount === 0) return Rating.color(input.player.rating)
  return oldCount + newCount < 50 ? Rating.colorOld(rating) : Rating.color(rating)
}

async function header(input: RatingRenderInput, title: string, rating: number, oldCount: number, newCount: number,
  service: TakumiRenderService, data: MaimaiDataStore): Promise<Node[]> {
  const [avatar, plate] = await Promise.all([
    service.loadAsset(data.avatarPath(input.settings?.avatar ?? 0), resolvePackageAssetPath('fallback/avatar.png')),
    service.loadAsset(data.platePath(input.settings?.plate ?? 0), resolvePackageAssetPath('fallback/plate.png')),
  ])
  const color = ratingColor(input, rating, oldCount, newCount)
  const course = Math.max(0, Math.min(23, Math.trunc(input.player.course) || 0))
  const digits = String(Math.max(0, Math.trunc(rating))).slice(-5)
  const digitX = 163 + 176 - digits.length * 16
  const staticNodes = await Promise.all([
    artwork(service, `rating_base_${color}`, 163, 42, 192, 40),
    artwork(service, 'header_name', 161, 77, 300, 56),
    artwork(service, 'header_shougou', 161, 125, 300, 39),
    artwork(service, `dani_${course}`, 365, 84, 91, 38),
    ...[...digits].map((digit, index) => artwork(service, `rating_${digit}`, digitX + index * 16, 53, 16, 20)),
  ])
  return [
    imageAt(plate, 47, 36, 773, 125),
    imageAt(avatar, 55, 44, 108, 108),
    ...staticNodes,
    textAt(input.player.nickname || 'maimai player', 178, 88, 181, 34, 25, '#24232d'),
    textAt(title, 170, 134, 281, 20, 14, '#34343d'),
  ]
}

async function card(record: RecordEntry | undefined, section: 'old' | 'new', index: number, x: number, y: number,
  service: TakumiRenderService, data: MaimaiDataStore): Promise<Node> {
  const difficulty = record?.chart.difficulty.name as MaimaiDifficultyName | undefined
  const base = difficulty && difficulty in MAIMAI_DIFFICULTY_COLORS ? difficulty : 'None'
  const children: Node[] = [await artwork(service, `base_${base}`, 0, 0, 241, 96)]
  if (record) {
    const cover = await service.loadAsset(data.coverPath(record.music.resourceId), resolvePackageAssetPath('fallback/cover.png'))
    const stars = DeluxeScore.stars(record.deluxeScore, record.chart.maxDeluxeScore)
    const score = Rate.toString(record.achievement)
    const status = await Promise.all([
      artwork(service, `type_${record.music.type.value}`, 15, 12, 19, record.music.type.value === 'DX' ? 13 : 10),
      artwork(service, `icon_dxstar_${stars}`, 175, 8, 50, 11),
      artwork(service, `rank_${record.rate}`, 148, 78, 40, 16),
      artwork(service, `icon_${record.comboStatus.value}`, 186, 77, 19, 19),
      artwork(service, `icon_${record.syncStatus.value}`, 207, 77, 19, 19),
    ])
    children.push(
      imageAt(cover, 13, 10, 72, 72),
      ...status,
      textAt(`#${index + 1} ${record.music.id}`, 91, 8, 82, 14, 10, '#ffffff'),
      textAt(record.music.name, 91, 22, 137, 16, 12, '#ffffff'),
      textAt(score, 90, 40, 139, 22, score.length > 9 ? 18 : 20, '#ffffff'),
      textAt(`${record.chart.levelValue.toFixed(1)}→${record.rating}`, 90, 78, 59, 16, 11,
        MAIMAI_DIFFICULTY_COLORS[base as MaimaiDifficultyName] ?? MAIMAI_RENDER_THEME.colors.text),
    )
  }
  return createContainerNode({
    id: `rating-slot-${section}-${index + 1}`,
    attributes: { 'data-empty': String(!record) },
    style: { position: 'absolute', left: x, top: y, width: 241, height: 96, overflow: 'hidden' },
    children,
  })
}

async function cards(records: readonly RecordEntry[], section: 'old' | 'new', count: number, startY: number,
  service: TakumiRenderService, data: MaimaiDataStore) {
  return Promise.all(Array.from({ length: count }, (_, index) => card(
    records[index], section, index,
    CARD_X + index % CARD_COLUMNS * CARD_STEP_X,
    startY + Math.floor(index / CARD_COLUMNS) * CARD_STEP_Y,
    service, data,
  )))
}

export async function createRatingRenderPlan(input: RatingRenderInput, service: TakumiRenderService,
  data: MaimaiDataStore): Promise<RatingRenderPlan> {
  const oldCount = countOf(input.oldCount, 35, 'Old rating slot count')
  const newCount = countOf(input.newCount, 15, 'New rating slot count')
  if (oldCount + newCount > 50) throw new RangeError('Rating image supports at most 50 slots')
  const oldRating = input.oldRecords.slice(0, oldCount).reduce((sum, record) => sum + record.rating, 0)
  const newRating = input.newRecords.slice(0, newCount).reduce((sum, record) => sum + record.rating, 0)
  const rating = input.rating ?? oldRating + newRating
  const title = input.title ?? `[${input.backend}] B${oldCount} ${oldRating} + B${newCount} ${newRating} = ${rating}`
  const oldRows = Math.ceil(oldCount / CARD_COLUMNS)
  const dividerY = CARD_Y + oldRows * CARD_STEP_Y
  const newY = dividerY + (newCount ? DIVIDER_HEIGHT : 0)
  const [background, headerNodes, oldCards, newCards, divider] = await Promise.all([
    artwork(service, 'background', 0, 0, 1280, 1280),
    header(input, title, rating, oldCount, newCount, service, data),
    cards(input.oldRecords, 'old', oldCount, CARD_Y, service, data),
    cards(input.newRecords, 'new', newCount, newY, service, data),
    newCount ? artwork(service, 'icon_b15', 587, dividerY, 105, 73) : Promise.resolve(undefined),
  ])
  const titleBand = createContainerNode({
    id: 'rating-title',
    style: {
      position: 'absolute', left: CARD_X, top: 163, width: 1194, height: 22,
      overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.86)',
    },
    children: [textAt(title, 8, 2, 1178, 19, 14, '#243c55')],
  })
  const children: Node[] = [background, ...headerNodes, titleBand, ...oldCards]
  if (divider) children.push(divider)
  children.push(...newCards, createContainerNode({
    id: 'rating-footer',
    style: { position: 'absolute', left: 0, top: FOOTER_Y, width: 1280, height: 45, backgroundColor: '#013162' },
  }))
  return {
    width: RATING_TEMPLATE_SIZE.width,
    height: RATING_TEMPLATE_SIZE.height,
    node: createContainerNode({
      id: 'rating-template',
      style: { position: 'relative', width: 1280, height: 1280, overflow: 'hidden', fontFamily: MAIMAI_RENDER_THEME.fontFamily },
      children,
    }),
  }
}
