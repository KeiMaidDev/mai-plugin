import { imageSize } from 'image-size'
import type { Node } from '@takumi-rs/helpers'
import type { MusicInfo } from '../domain/music'
import type { GuessCoverImage } from '../services/guess-service'
import { resolvePackageAssetPath } from './assets'
import { createContainerNode, createImageNode, createTextNode } from './nodes'
import type { TakumiRenderService } from './renderer'
import { MAIMAI_RENDER_THEME } from './theme'

/** Cover slice the reference implementation crops for its hint, in source pixels. */
export const GUESS_CROP_SOURCE_SIZE = 66
/** Size of the rendered crop PNG, matching the reference's inline 300px image. */
export const GUESS_CROP_SIZE = Object.freeze({ width: 300, height: 300 })

export const GUESS_CARD_WIDTH = 620
export const GUESS_CARD_COVER_SIZE = 300
export const GUESS_CARD_LINE_HEIGHT = 30
export const GUESS_CARD_MAX_CAPTION_LINES = 12

const GUESS_CARD_PADDING = 30
const GUESS_CARD_TITLE_HEIGHT = 44
const GUESS_CARD_GAP = 18

const FALLBACK_COVER = resolvePackageAssetPath('fallback/cover.png')

export interface GuessCoverSource {
  coverPath(resourceId: number): string | Promise<string>
}

export interface GuessCropRenderInput {
  cover: GuessCoverImage
  seed: string
}

export interface GuessCardRenderInput {
  cover: GuessCoverImage
  title: string
  caption: readonly string[]
}

export interface GuessRenderPlan {
  node: Node
  width: number
  height: number
}

function hashSeed(value: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Offset of the cover slice for one game. The plugin persists a crop seed while
 * the reference re-randomizes on restore, so the slice stays deterministic here.
 */
export function deterministicGuessCrop(seed: string, cover: { width: number, height: number }) {
  const maximumX = Math.max(0, Math.floor(cover.width) - GUESS_CROP_SOURCE_SIZE)
  const maximumY = Math.max(0, Math.floor(cover.height) - GUESS_CROP_SOURCE_SIZE)
  return {
    x: hashSeed(`${seed}:x`) % (maximumX + 1),
    y: hashSeed(`${seed}:y`) % (maximumY + 1),
  }
}

export function guessCardHeight(captionLineCount: number) {
  const lines = Math.min(Math.max(captionLineCount, 1), GUESS_CARD_MAX_CAPTION_LINES)
  return GUESS_CARD_PADDING * 2
    + GUESS_CARD_TITLE_HEIGHT
    + GUESS_CARD_GAP
    + GUESS_CARD_COVER_SIZE
    + GUESS_CARD_GAP
    + lines * GUESS_CARD_LINE_HEIGHT
}

function detectCoverMimeType(buffer: Buffer) {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }
  throw new TypeError('Guess covers must be PNG, JPEG, or WebP images.')
}

function describeCover(buffer: Buffer): GuessCoverImage {
  const mimeType = detectCoverMimeType(buffer)
  const size = imageSize(buffer)
  if (!size.width || !size.height) {
    throw new TypeError('Guess covers must expose readable pixel dimensions.')
  }
  return { data: buffer, mimeType, width: size.width, height: size.height }
}

export async function loadGuessCover(
  renderService: TakumiRenderService,
  coverPath: string | Promise<string>,
): Promise<GuessCoverImage> {
  const buffer = await renderService.loadAsset(coverPath, FALLBACK_COVER)
  try {
    return describeCover(buffer)
  } catch {
    return describeCover(await renderService.loadAsset(FALLBACK_COVER))
  }
}

function cropNode(cover: GuessCoverImage, seed: string) {
  const crop = deterministicGuessCrop(seed, cover)
  const scale = GUESS_CROP_SIZE.width / GUESS_CROP_SOURCE_SIZE
  const width = Math.round(cover.width * scale)
  const height = Math.round(cover.height * scale)
  return createContainerNode({
    id: 'guess-crop-template',
    attributes: {
      'data-crop-x': String(crop.x),
      'data-crop-y': String(crop.y),
      'data-crop-source-size': String(GUESS_CROP_SOURCE_SIZE),
    },
    style: {
      width: GUESS_CROP_SIZE.width,
      height: GUESS_CROP_SIZE.height,
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: '#20252c',
      color: '#ffffff',
      fontFamily: MAIMAI_RENDER_THEME.fontFamily,
    },
    children: [
      createImageNode({
        className: 'guess-crop-cover',
        src: cover.data,
        width,
        height,
        style: {
          position: 'absolute',
          left: -Math.round(crop.x * scale),
          top: -Math.round(crop.y * scale),
          width,
          height,
          objectFit: 'cover',
        },
      }),
    ],
  })
}

function cardNode(input: GuessCardRenderInput) {
  const lines = Math.min(
    Math.max(input.caption.length, 1),
    GUESS_CARD_MAX_CAPTION_LINES,
  )
  return createContainerNode({
    id: 'guess-card-template',
    style: {
      width: GUESS_CARD_WIDTH,
      height: guessCardHeight(input.caption.length),
      padding: GUESS_CARD_PADDING,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: GUESS_CARD_GAP,
      overflow: 'hidden',
      backgroundColor: MAIMAI_RENDER_THEME.colors.background,
      color: MAIMAI_RENDER_THEME.colors.text,
      fontFamily: MAIMAI_RENDER_THEME.fontFamily,
    },
    children: [
      createTextNode({
        text: input.title,
        style: {
          width: '100%',
          height: GUESS_CARD_TITLE_HEIGHT,
          overflow: 'hidden',
          fontSize: 30,
          fontWeight: 700,
          lineHeight: 1.2,
          color: '#137e91',
        },
      }),
      createImageNode({
        className: 'guess-card-cover',
        src: input.cover.data,
        width: GUESS_CARD_COVER_SIZE,
        height: GUESS_CARD_COVER_SIZE,
        style: {
          width: GUESS_CARD_COVER_SIZE,
          height: GUESS_CARD_COVER_SIZE,
          objectFit: 'cover',
          borderRadius: 6,
          border: '2px solid #cbd4dc',
          flexShrink: 0,
        },
      }),
      createContainerNode({
        id: 'guess-card-caption',
        style: {
          width: '100%',
          height: lines * GUESS_CARD_LINE_HEIGHT,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        },
        children: input.caption.slice(0, GUESS_CARD_MAX_CAPTION_LINES).map(line => createTextNode({
          text: line,
          style: {
            width: '100%',
            height: GUESS_CARD_LINE_HEIGHT,
            overflow: 'hidden',
            fontSize: 20,
            lineHeight: 1.5,
            color: '#596675',
          },
        })),
      }),
    ],
  })
}

export function createGuessCropRenderPlan(input: GuessCropRenderInput): GuessRenderPlan {
  return {
    width: GUESS_CROP_SIZE.width,
    height: GUESS_CROP_SIZE.height,
    node: cropNode(input.cover, input.seed),
  }
}

export function createGuessCardRenderPlan(input: GuessCardRenderInput): GuessRenderPlan {
  return {
    width: GUESS_CARD_WIDTH,
    height: guessCardHeight(input.caption.length),
    node: cardNode(input),
  }
}

export class TakumiGuessRenderer {
  constructor(
    private readonly renderService: TakumiRenderService,
    private readonly data: GuessCoverSource,
  ) {}

  loadCover(music: MusicInfo) {
    return loadGuessCover(this.renderService, this.data.coverPath(music.resourceId))
  }

  async renderCrop(input: GuessCropRenderInput, signal?: AbortSignal) {
    const plan = createGuessCropRenderPlan(input)
    return this.renderService.render(plan.node, {
      width: plan.width,
      height: plan.height,
      format: 'png',
    }, signal)
  }

  async renderCard(input: GuessCardRenderInput, signal?: AbortSignal) {
    const plan = createGuessCardRenderPlan(input)
    return this.renderService.render(plan.node, {
      width: plan.width,
      height: plan.height,
      format: 'png',
    }, signal)
  }
}
