import h from '@satorijs/element'
import type { Command, Context, Fragment, Session } from 'koishi'
import type { CourseInfo, IconInfo, PlateInfo } from '../data/normalizers'
import { isRichTextPlatform } from '../constants'
import type { BindRepository, SettingRepository } from '../database/repositories'
import type { MusicInfo } from '../domain/music'
import {
  createQqButton,
  createQqButtonRow,
  createQqCommandAction,
  createQqKeyboard,
  createQqNativeMarkdown,
  createQqUrlAction,
} from '../platform/qq-message'
import { sendReply } from '../platform/qq-message'
import {
  createQqMarkdownImage,
  type AssetTransformer,
} from '../platform/qq-markdown-image'
import type { GuessCardFallbackInput } from '../platform/guess-message'
import type { QqKeyboard } from '../platform/qq-message'
import type { MaiRenderer } from '../render/mai-renderer'
import type { AliasService } from '../services/alias-service'
import type { QueryService } from '../services/query-service'
import type { QueueService } from '../services/queue-service'
import type { SettingService } from '../services/setting-service'
import type { GuessService } from '../services/guess-service'
import type { UpdateService } from '../services/update-service'
import { PublicCallbackUnavailableError } from '../services/update-service'
import { ProviderOAuthRequiredError } from '../providers/errors'
import { mapQueryError, type FallbackElement } from '../platform/fallback-message'
import type { Awaitable } from '../types'
import type { Semaphore } from '../utils/semaphore'

export const SEARCH_PAGE_SIZE = 10
export const SEARCH_TOO_MANY = 40
export const MAX_USER_REGEX_LENGTH = 128
export const SCORE_LIST_PAGE_SIZE = 50

export interface CoreCommandData {
  musics: ReadonlyMap<number, MusicInfo>
  courses: ReadonlyMap<number, CourseInfo>
  icons: ReadonlyMap<number, IconInfo>
  plates: ReadonlyMap<number, PlateInfo>
  coverPath(resourceId: number): string | Promise<string>
}

export interface CoreCommandDependencies {
  data: CoreCommandData
  aliasService: Pick<AliasService, 'search' | 'add' | 'remove' | 'vote'>
  queryService: Pick<
    QueryService,
    'getQueryParams' | 'consumePendingCommand' | 'rating' | 'record' | 'records' | 'recent'
  >
  settingService: Pick<
    SettingService,
    | 'isCompatibilityMode'
    | 'getDefaultGame'
    | 'getSettings'
    | 'setProviderPreference'
    | 'setCompatibilityMode'
    | 'setAvatar'
    | 'setPlate'
    | 'setDefaultGame'
  >
  bindRepository: Pick<BindRepository, 'setQq'>
  guessService?: Pick<
    GuessService,
    'startClassical' | 'startOpening' | 'handleMessage' | 'hasActiveGame' | 'dispose'
  >
  settingRepository?: Pick<SettingRepository, 'get' | 'set'>
  queueService?: Pick<
    QueueService,
    | 'addArcade'
    | 'deleteArcade'
    | 'addAlias'
    | 'deleteAlias'
    | 'aliases'
    | 'bindGroup'
    | 'query'
    | 'updateCount'
  >
  updateService?: Pick<
    UpdateService,
    | 'beginLxnsOAuth'
    | 'getBindingStatus'
    | 'unbindLxns'
    | 'unbindDivingFish'
    | 'beginDivingFishOAuth'
    | 'completeLxnsOAuth'
    | 'dispose'
  >
  renderer: MaiRenderer
  /** Renders the fallback PNG of a guess card where QQ Markdown is unavailable. */
  guessCardRender?: (input: GuessCardFallbackInput) => Promise<Buffer>
  assetTransformer?: AssetTransformer
  administrators?: readonly string[]
  compatibilityMode?: boolean
  now?: () => Date
  random?: () => number
  previewAudio?: (music: MusicInfo) => Awaitable<Buffer | Uint8Array | null>
  replayCommand?: (session: Session, command: string) => Awaitable<void>
  regexWorkerSemaphore?: Semaphore
}

export interface ReplyCommandDependencies {
  settingService?: Pick<SettingService, 'isCompatibilityMode'>
  compatibilityMode?: boolean
}

export interface ReplyMarkdownImageOptions {
  alt: string
  title?: string
  caption?: readonly string[]
  keyboard?: QqKeyboard
}

export interface QqCommandGuidanceButton {
  id: string
  label: string
  command: string
  visitedLabel?: string
  style?: 0 | 1
  enter: boolean
  reply: false
  unsupportTips?: string
}

export interface QqUrlGuidanceButton {
  id: string
  label: string
  url: string
  visitedLabel?: string
  style?: 0 | 1
  unsupportTips?: string
}

export function createQqCommandGuidance(
  content: string,
  rows: readonly (readonly QqCommandGuidanceButton[])[],
) {
  return createQqNativeMarkdown(content, createQqKeyboard(rows.map(row => (
    createQqButtonRow(row.map(button => createQqButton(
      button.id,
      button.label,
      createQqCommandAction(button.command, {
        enter: button.enter,
        unsupportTips: button.unsupportTips,
      }),
      button.style,
      button.visitedLabel,
    )))
  ))))
}

export function createQqUrlGuidance(content: string, button: QqUrlGuidanceButton) {
  return createQqNativeMarkdown(content, createQqKeyboard([createQqButtonRow([
    createQqButton(
      button.id,
      button.label,
      createQqUrlAction(button.url, {
        unsupportTips: button.unsupportTips,
      }),
      button.style,
      button.visitedLabel,
    ),
  ])]))
}

export type CoreCommandContext = Pick<Context, 'command'>

export type ActiveCommandSession = Session & {
  userId: string
  channelId: string
  content: string
}

interface ActiveCommandArgv {
  session: ActiveCommandSession
  options: Record<string, any>
}

export function commandAction(
  callback: (argv: ActiveCommandArgv, ...args: any[]) => Awaitable<void | Fragment>,
): Command.Action {
  return (argv, ...args) => {
    const session = argv.session
    if (!session?.userId || !session.channelId || session.content === undefined) {
      throw new Error('[mai-plugin] command action requires a message session.')
    }
    return callback({
      ...argv,
      session: session as ActiveCommandSession,
      options: argv.options ?? {},
    }, ...args)
  }
}

export async function compatibilityModeFor(
  session: ActiveCommandSession,
  dependencies: ReplyCommandDependencies,
) {
  if (dependencies.compatibilityMode) return true
  return dependencies.settingService?.isCompatibilityMode(session.userId) ?? false
}

export async function replyText(
  session: ActiveCommandSession,
  dependencies: ReplyCommandDependencies,
  text: string,
  rich = createQqNativeMarkdown(text),
) {
  await sendReply(
    session,
    { type: 'text', text },
    rich,
    { compatibilityMode: await compatibilityModeFor(session, dependencies) },
  )
}

export async function replyQueryError(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  error: unknown,
  isSelf = true,
) {
  if (isSelf && error instanceof ProviderOAuthRequiredError && error.provider === 'lxns' && dependencies.updateService) {
    try {
      const url = await dependencies.updateService.beginLxnsOAuth({
        userId: session.userId,
        platform: session.platform,
        channelId: session.channelId,
        direct: session.isDirect,
        pendingCommand: session.content,
        send: (text, options) => replyText(
          session,
          dependencies,
          text,
          options?.retryCommand
            ? createQqCommandGuidance(text, [[{
                id: 'retry-lxns-oauth',
                label: '重试授权',
                command: options.retryCommand,
                enter: true,
                reply: false,
              }]])
            : undefined,
        ),
        replay: async (command) => {
          if (dependencies.replayCommand) {
            await dependencies.replayCommand(session, command)
          } else {
            await session.execute(command)
          }
        },
      })
      const text = `使用该功能需要授权 BOT 访问您在落雪查分器的全部成绩。无法使用按钮时，请复制以下 HTTPS 链接打开：\n${url}`
      await replyText(
        session,
        dependencies,
        text,
        createQqUrlGuidance(text, {
          id: 'lxns-oauth',
          label: '前往落雪授权',
          visitedLabel: '重新前往落雪授权',
          url,
        }),
      )
      return
    } catch (oauthError) {
      if (oauthError instanceof PublicCallbackUnavailableError) {
        const text = `${oauthError.message}\n落雪当前无法完成绑定，请选择其他查分器或绑定水鱼。`
        await replyText(
          session,
          dependencies,
          text,
          createQqCommandGuidance(text, [[
            {
              id: 'oauth-provider',
              label: '选择查分器',
              command: '/mai 设置查分器',
              enter: true,
              reply: false,
            },
            {
              id: 'oauth-bind-diving-fish',
              label: '绑定水鱼',
              command: '/mai 绑定水鱼',
              enter: true,
              reply: false,
            },
          ]]),
        )
        return
      }
      const text = '落雪授权请求失败，请稍后重试。'
      await replyText(session, dependencies, text, createQqCommandGuidance(text, [[{
        id: 'retry-lxns-oauth',
        label: '重试授权',
        command: '/mai 绑定落雪',
        enter: true,
        reply: false,
      }]]))
      return
    }
  }
  const message = mapQueryError(error, { isSelf })
  if (message.code === 'qq-unbound') {
    await replyText(session, dependencies, message.text, createQqCommandGuidance(message.text, [[{
      id: 'bind-qq',
      label: '绑定 QQ',
      command: '/mai 绑定',
      enter: false,
      reply: false,
      unsupportTips: '请在正文命令后补充 QQ 号并手动发送。',
    }]]))
    return
  }
  const shouldGuideProviderBinding = message.code === 'provider-unbound'
    || (isSelf && (message.code === 'oauth-required' || message.code === 'no-data'))
  if (shouldGuideProviderBinding) {
    const text = message.code === 'no-data'
      ? '未查询到舞萌DX成绩，请先确认已绑定查分器并导入成绩。'
      : message.text
    await replyText(session, dependencies, text, createQqCommandGuidance(text, [[
      {
        id: 'bind-lxns',
        label: '绑定落雪',
        command: '/mai 绑定落雪',
        enter: true,
        reply: false,
      },
      {
        id: 'bind-diving-fish',
        label: '绑定水鱼',
        command: '/mai 绑定水鱼',
        enter: true,
        reply: false,
      },
    ]]))
    return
  }
  await replyText(session, dependencies, message.text, createQqCommandGuidance(message.text, [[{
    id: 'error-help',
    label: '返回帮助',
    command: '/mai',
    enter: true,
    reply: false,
  }]]))
}

export async function replyImage(
  session: ActiveCommandSession,
  dependencies: ReplyCommandDependencies,
  image: Buffer | Uint8Array,
  text = '',
  rich?: h,
) {
  const compatibilityMode = await compatibilityModeFor(session, dependencies)
  if (isRichTextPlatform(session.platform) && !compatibilityMode && rich) {
    await session.send([h.image(Buffer.from(image), 'image/png'), rich])
    return
  }
  await sendReply(session, [
    { type: 'image', data: image, mimeType: 'image/png' },
    ...(text ? [{ type: 'text' as const, text }] : []),
  ], undefined, { compatibilityMode })
}

export async function replyMarkdownImage(
  session: ActiveCommandSession,
  dependencies: ReplyCommandDependencies & Pick<CoreCommandDependencies, 'assetTransformer'>,
  image: Buffer | Uint8Array,
  options: ReplyMarkdownImageOptions,
) {
  const compatibilityMode = await compatibilityModeFor(session, dependencies)
  const caption = (options.caption ?? []).filter(line => line.trim())
  const fallback: FallbackElement[] = [
    { type: 'image', data: image, mimeType: 'image/png' },
    ...(caption.length ? [{ type: 'text' as const, text: caption.join('\n') }] : []),
  ]
  if (!isRichTextPlatform(session.platform) || compatibilityMode || !dependencies.assetTransformer) {
    await sendReply(session, fallback, undefined, { compatibilityMode })
    return
  }
  let rich: h
  try {
    rich = await createQqMarkdownImage({
      image,
      alt: options.alt,
      title: options.title,
      caption,
      keyboard: options.keyboard,
      assets: dependencies.assetTransformer,
    })
  } catch {
    await sendReply(session, fallback, undefined, { compatibilityMode })
    return
  }
  await sendReply(session, fallback, rich, { compatibilityMode })
}

export const QUERY_RESULT_TITLE = '查询结果'

export function generationTimeLine(elapsedMs: number) {
  return `生成时间：${elapsedMs}ms`
}

export interface QueryResultImageOptions {
  image: Buffer | Uint8Array
  alt: string
  elapsedMs?: number
  keyboard?: QqKeyboard
}

/**
 * Reply with a query result image: the shared result title above it on QQ, plus
 * the generation time line below it when the caller measured a render.
 */
export async function replyQueryResultImage(
  session: ActiveCommandSession,
  dependencies: ReplyCommandDependencies & Pick<CoreCommandDependencies, 'assetTransformer'>,
  options: QueryResultImageOptions,
) {
  await replyMarkdownImage(session, dependencies, options.image, {
    alt: options.alt,
    title: QUERY_RESULT_TITLE,
    caption: options.elapsedMs === undefined ? undefined : [generationTimeLine(options.elapsedMs)],
    keyboard: options.keyboard,
  })
}

export interface TimedRender<T> {
  image: T
  elapsedMs: number
}

export async function renderTimed<T>(render: () => Promise<T>): Promise<TimedRender<T>> {
  const start = performance.now()
  const image = await render()
  return { image, elapsedMs: Math.max(0, Math.round(performance.now() - start)) }
}

export async function replyAudio(session: ActiveCommandSession, audio: Buffer | Uint8Array) {
  await session.send(h.audio(Buffer.from(audio), 'audio/mpeg'))
}
