import h from '@satorijs/element'
import type {
  GuessCoverImage,
  GuessKeyboardKind,
  GuessReply,
  OpeningBoardEntry,
  OpeningBoardView,
} from '../services/guess-service'
import {
  GUESS_STOP_KEYWORD,
  OPENING_LETTER_KEYWORD,
  OPENING_SONG_KEYWORD,
} from '../services/guess-service'
import {
  createQqButton,
  createQqButtonRow,
  createQqCommandAction,
  createQqInputHintAction,
  createQqKeyboard,
  createQqNativeMarkdown,
  sendReply,
  type QqKeyboard,
  type ReplySession,
} from './qq-message'
import { createQqMarkdownImage, type AssetTransformer } from './qq-markdown-image'

/** Bold heading of a guess card, as the reference implementation prints it. */
export const GUESS_CARD_TITLE = '舞萌猜歌'

/** Inline Markdown size of a guess card's image, as the reference hardcodes it. */
export const GUESS_CARD_IMAGE_SIZE = Object.freeze({ width: 300, height: 300 })

export const GUESS_CARD_IMAGE_ALT = 'img'

/** Heading of the opening board's Markdown form. */
export const GUESS_BOARD_MARKDOWN_HEADING = '## 舞萌开字母'

/** Heading of the opening board's plain-text form. */
export const GUESS_BOARD_TEXT_HEADING = '舞萌开字母'

/** Command that starts another classical game from a replay button. */
export const GUESS_REPLAY_COMMAND = '/mai 猜歌'

/** Command that starts another opening game from a replay button. */
export const OPENING_REPLAY_COMMAND = '/mai 舞萌开字母'

export type GuessSession = ReplySession

export interface GuessCardFallbackInput {
  cover: GuessCoverImage
  title: string
  caption: readonly string[]
}

export interface GuessPresenterOptions {
  /** QQ asset transformer; without it every reply uses the image-and-text form. */
  assets?: AssetTransformer
  /** Renders the fallback PNG that mirrors a guess card. */
  renderCard?(input: GuessCardFallbackInput): Promise<Buffer>
  logger?: { warn(message: string): void }
}

export interface GuessPresenterSendOptions {
  compatibilityMode?: boolean
}

export interface GuessPresenter {
  send(session: GuessSession, reply: GuessReply, options?: GuessPresenterSendOptions): Promise<void>
}

function primaryButton(id: string, label: string, data: string, enter: boolean) {
  return createQqButton(id, label, createQqCommandAction(data, { enter }), 1)
}

function secondaryButton(id: string, label: string, data: string, enter: boolean) {
  return createQqButton(id, label, createQqCommandAction(data, { enter }), 0)
}

/**
 * The reference keyboards: an answer row, a quit action, the opening actions,
 * and a replay button for each game.
 */
export function guessKeyboard(kind: GuessKeyboardKind): QqKeyboard | undefined {
  if (kind === 'answer') {
    return createQqKeyboard([
      createQqButtonRow([
        createQqButton('guess-answer', '⬇输入答案', createQqInputHintAction(), 1),
      ]),
      createQqButtonRow([
        secondaryButton('guess-stop', GUESS_STOP_KEYWORD, GUESS_STOP_KEYWORD, true),
      ]),
    ])
  }
  if (kind === 'guess-replay') {
    return createQqKeyboard([createQqButtonRow([
      primaryButton('guess-replay', '🕹️再玩一把', GUESS_REPLAY_COMMAND, true),
    ])])
  }
  if (kind === 'opening') {
    return createQqKeyboard([createQqButtonRow([
      primaryButton('opening-letter', `🔤${OPENING_LETTER_KEYWORD}`, OPENING_LETTER_KEYWORD, false),
      primaryButton('opening-song', `🎶${OPENING_SONG_KEYWORD}`, OPENING_SONG_KEYWORD, false),
      secondaryButton('opening-stop', `🔚${GUESS_STOP_KEYWORD}`, GUESS_STOP_KEYWORD, false),
    ])])
  }
  if (kind === 'opening-replay') {
    return createQqKeyboard([createQqButtonRow([
      primaryButton('opening-replay', '🕹️再玩一把', OPENING_REPLAY_COMMAND, true),
    ])])
  }
  return undefined
}

function boardEntryLine(entry: OpeningBoardEntry, revealAll: boolean) {
  if (entry.revealed) return `✅${entry.name}`
  if (revealAll) return `❌${entry.name}`
  return `🤔${entry.masked}`
}

export function guessBoardMarkdown(board: OpeningBoardView) {
  return [
    GUESS_BOARD_MARKDOWN_HEADING,
    '',
    ...board.entries.map(entry => `> ${boardEntryLine(entry, board.revealAll)}`),
    `> 💡已开出字母：${board.opened.join(', ')}`,
  ].join('\n')
}

export function guessBoardText(board: OpeningBoardView) {
  return [
    GUESS_BOARD_TEXT_HEADING,
    ...board.entries.map(entry => boardEntryLine(entry, board.revealAll)),
    `💡已开出字母：${board.opened.join(', ')}`,
  ].join('\n')
}

async function cardFallbackImage(
  reply: Extract<GuessReply, { type: 'song-card' }>,
  options: GuessPresenterOptions,
) {
  if (!options.renderCard) return { data: reply.cover.data, mimeType: reply.cover.mimeType }
  try {
    return {
      data: await options.renderCard({
        cover: reply.cover,
        title: GUESS_CARD_TITLE,
        caption: reply.caption,
      }),
      mimeType: 'image/png',
    }
  } catch (error) {
    options.logger?.warn(`[mai-plugin] guess card fallback render failed: ${String(error)}`)
    return { data: reply.cover.data, mimeType: reply.cover.mimeType }
  }
}

async function sendSongCard(
  session: GuessSession,
  reply: Extract<GuessReply, { type: 'song-card' }>,
  options: GuessPresenterOptions,
  compatibilityMode: boolean,
) {
  const keyboard = guessKeyboard(reply.keyboard)
  if (session.platform === 'qq' && !compatibilityMode && options.assets) {
    try {
      const card = await createQqMarkdownImage({
        image: reply.crop ?? reply.cover.data,
        alt: GUESS_CARD_IMAGE_ALT,
        title: GUESS_CARD_TITLE,
        caption: reply.caption,
        captionStyle: 'plain',
        displaySize: GUESS_CARD_IMAGE_SIZE,
        mimeType: reply.crop ? 'image/png' : reply.cover.mimeType,
        keyboard,
        assets: options.assets,
      })
      await session.send(card)
      return
    } catch (error) {
      options.logger?.warn(`[mai-plugin] guess card send failed: ${String(error)}`)
    }
  }
  const image = reply.crop
    ? { data: reply.crop, mimeType: 'image/png' }
    : await cardFallbackImage(reply, options)
  await session.send([h.image(image.data, image.mimeType), h.text(reply.caption.join('\n'))])
}

async function sendOpeningBoard(
  session: GuessSession,
  reply: Extract<GuessReply, { type: 'opening-board' }>,
  compatibilityMode: boolean,
) {
  const keyboard = guessKeyboard(reply.keyboard)
  const markdown = guessBoardMarkdown(reply.board)
  const rich = createQqNativeMarkdown(
    reply.note ? `${reply.note}\n\n${markdown}` : markdown,
    keyboard,
  )
  const text = reply.note ? `${reply.note}\n${guessBoardText(reply.board)}` : guessBoardText(reply.board)
  await sendReply(session, { type: 'text', text }, rich, { compatibilityMode })
}

export function createGuessPresenter(options: GuessPresenterOptions = {}): GuessPresenter {
  return {
    async send(session, reply, sendOptions = {}) {
      const compatibilityMode = sendOptions.compatibilityMode ?? false
      if (reply.type === 'opening-board') {
        await sendOpeningBoard(session, reply, compatibilityMode)
        return
      }
      if (reply.type === 'song-card') {
        await sendSongCard(session, reply, options, compatibilityMode)
        return
      }
      const keyboard = guessKeyboard(reply.keyboard)
      await sendReply(
        session,
        { type: 'text', text: reply.text },
        keyboard ? createQqNativeMarkdown(reply.text, keyboard) : undefined,
        { compatibilityMode },
      )
    },
  }
}
