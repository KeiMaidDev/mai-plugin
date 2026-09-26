import type { Node } from '@takumi-rs/helpers'
import type { MaimaiDataStore } from '../data/sync-service'
import { DEFAULT_RATING_FOOTER_TEXT } from '../constants'
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
  newGroupDisabled?: boolean
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
const FOOTER_TEXT_WIDTH = 1200

function footerFontSize(text: string) {
  // Estimate glyph advances; overflow clipping handles font-specific differences.
  let widthUnits = 0
  for (const char of text) {
    widthUnits += char === ' ' ? 0.35 : char.codePointAt(0)! > 0x024f ? 1 : 0.6
  }
  return Math.max(14, Math.min(22, Math.floor(FOOTER_TEXT_WIDTH / Math.max(1, widthUnits))))
}

function countOf(value: number | undefined, fallback: number, name: string) {
  const count = value ?? fallback
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`${name} must be a non-negative integer`)
  return count
}

function textAt(text: string, x: number, y: number, width: number, height: number, fontSize: number,
  color: string, font: { family?: string; weight?: number; outline?: boolean } = {}) {
  return createTextNode({
    text,
    style: {
      position: 'absolute', left: x, top: y, width, height,
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      fontSize, fontWeight: font.weight ?? 700, fontFamily: font.family ?? MAIMAI_RENDER_THEME.fontFamily,
      lineHeight: 1.1, color,
      ...(font.outline ? { textShadow: '1px 0 0 #ffffff, -1px 0 0 #ffffff, 0 1px 0 #ffffff, 0 -1px 0 #ffffff' } : {}),
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
    textAt(input.player.nickname || 'maimai player', 178, 88, 181, 34, 27, '#24232d',
      { family: 'FZLanTingHei-B-GBK' }),
    textAt(title, 170, 134, 281, 20, 14, '#444444', { outline: true }),
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
    const achievement = Math.floor(record.achievement / 10_000)
    const decimal = `.${String(record.achievement % 10_000).padStart(4, '0')}`
    const status = await Promise.all([
      artwork(service, `type_${record.music.type.value}`, 15, 12, 19, record.music.type.value === 'DX' ? 13 : 10),
      artwork(service, `icon_dxstar_${stars}`, 175, 8, 50, 11),
      artwork(service, `rank_${record.rate}`, 148, 66, 40, 16),
      artwork(service, `icon_${record.comboStatus.value}`, 186, 65, 19, 19),
      artwork(service, `icon_${record.syncStatus.value}`, 207, 65, 19, 19),
    ])
    children.push(
      imageAt(cover, 13, 10, 72, 72),
      ...status,
      textAt(`#${index + 1} ${record.music.id}`, 91, 8, 82, 14, 10, '#ffffff'),
      textAt(record.music.name, 91, 22, 137, 16, 12, '#ffffff',
        { family: 'AlibabaPuHuiTi3,FZLanTingHei-B-GBK' }),
      createContainerNode({
        style: {
          position: 'absolute', left: 90, top: 27, width: 139, height: 35,
          display: 'flex', alignItems: 'flex-end', overflow: 'hidden', whiteSpace: 'nowrap',
        },
        children: [
          createTextNode({ text: String(achievement), style: { fontFamily: MAIMAI_RENDER_THEME.fontFamily,
            fontWeight: 900, fontSize: 30, lineHeight: 1, color: '#ffffff' } }),
          createTextNode({ text: decimal, style: { fontFamily: MAIMAI_RENDER_THEME.fontFamily,
            fontWeight: 900, fontSize: 24, lineHeight: 1, color: '#ffffff' } }),
          createTextNode({ text: '%', style: { fontFamily: MAIMAI_RENDER_THEME.fontFamily,
            fontWeight: 900, fontSize: 18, lineHeight: 1, color: '#ffffff' } }),
        ],
      }),
      textAt(`${record.chart.levelValue.toFixed(1)}→${record.rating}`, 90, 66, 59, 17, 10,
        MAIMAI_DIFFICULTY_COLORS[base as MaimaiDifficultyName] ?? MAIMAI_RENDER_THEME.colors.text,
        { weight: 900, outline: true }),
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
  data: MaimaiDataStore, footerText = DEFAULT_RATING_FOOTER_TEXT): Promise<RatingRenderPlan> {
  const oldCount = countOf(input.oldCount, 35, 'Old rating slot count')
  const newCount = countOf(input.newCount, 15, 'New rating slot count')
  if (oldCount + newCount > 50) throw new RangeError('Rating image supports at most 50 slots')
  const oldRating = input.oldRecords.slice(0, oldCount).reduce((sum, record) => sum + record.rating, 0)
  const newRating = input.newRecords.slice(0, newCount).reduce((sum, record) => sum + record.rating, 0)
  const rating = input.rating ?? oldRating + newRating
  const title = input.title ?? `[${input.backend}] B${oldCount} ${oldRating} + B${newCount} ${newRating} = ${rating}`
  const caption = footerText.trim().replace(/\s+/gu, ' ')
  const oldRows = Math.ceil(oldCount / CARD_COLUMNS)
  const dividerY = CARD_Y + oldRows * CARD_STEP_Y
  const dividerHeight = newCount ? input.newGroupDisabled ? 30 : DIVIDER_HEIGHT : 0
  const newY = dividerY + dividerHeight
  const [background, headerNodes, oldCards, newCards, divider] = await Promise.all([
    artwork(service, 'background', 0, 0, 1280, 1280),
    header(input, title, rating, oldCount, newCount, service, data),
    cards(input.oldRecords, 'old', oldCount, CARD_Y, service, data),
    cards(input.newRecords, 'new', newCount, newY, service, data),
    newCount ? artwork(service, input.newGroupDisabled ? 'icon_no_b15' : 'icon_b15',
      587, dividerY, 105, dividerHeight) : Promise.resolve(undefined),
  ])
  const children: Node[] = [background, ...headerNodes, ...oldCards]
  if (divider) children.push(divider)
  children.push(...newCards, createContainerNode({
    id: 'rating-footer',
    style: { position: 'absolute', left: 0, top: FOOTER_Y, width: 1280, height: 45, backgroundColor: '#013162' },
    children: caption ? [createTextNode({
      text: caption,
      style: {
        position: 'absolute', left: 40, top: 10, width: FOOTER_TEXT_WIDTH, height: 30,
        textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        fontFamily: MAIMAI_RENDER_THEME.fontFamily,
        fontWeight: 900, fontSize: footerFontSize(caption), lineHeight: 1.1, color: '#ffffff',
        textShadow: '1px 1px 0 #000000',
      },
    })] : [],
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
