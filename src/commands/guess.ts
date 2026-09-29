import type { Command, Context, Middleware, Session } from 'koishi'
import type { GuessPresenter } from '../platform/guess-message'
import type { SettingRepository } from '../database/repositories'
import { isAdministrator } from '../platform/admin'
import { GuessDeliveryError } from '../services/guess-service'
import type {
  GuessHandleResult,
  GuessInteraction,
  GuessMessage,
  GuessReply,
  GuessService,
  GuessStartResult,
} from '../services/guess-service'
import {
  commandAction,
  compatibilityModeFor,
  replyText,
  type ActiveCommandSession,
  type ReplyCommandDependencies,
} from './support'

export const GUESS_SETTING_KEY = 'guess'

type GuessServicePort = Pick<
  GuessService,
  'startClassical' | 'startOpening' | 'handleMessage' | 'hasActiveGame' | 'dispose'
>

export interface GuessCommandDependencies extends ReplyCommandDependencies {
  guessService: GuessServicePort
  settingRepository: Pick<SettingRepository, 'get' | 'set'>
  /** Presents every guess reply, in QQ Markdown where available. */
  presenter: GuessPresenter
  administrators?: readonly string[]
}

export interface GuessCommandRegistration {
  readonly commands: readonly Command[]
  dispose(): Promise<void>
}

function guessContextId(session: Pick<Session, 'platform' | 'channelId' | 'isDirect'>) {
  return `${session.platform}:${session.isDirect ? 'private' : 'channel'}:${session.channelId}`
}

export function guessSettingId(session: Pick<Session, 'platform' | 'channelId'>) {
  return `${session.platform}:${session.channelId}`
}

async function sendGuessReply(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
  reply: GuessReply,
) {
  await dependencies.presenter.send(session, reply, {
    compatibilityMode: await compatibilityModeFor(session, dependencies),
  })
}

function interactionFor(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
): GuessInteraction {
  const direct = session.isDirect
  return {
    contextId: guessContextId(session),
    platform: session.platform,
    channelId: session.channelId,
    guildId: direct ? null : (session.guildId ?? session.channelId),
    userId: session.userId,
    direct,
    reply: reply => sendGuessReply(session, dependencies, reply),
  }
}

async function groupGuessEnabled(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
) {
  if (session.isDirect) return true
  const stored = await dependencies.settingRepository.get(guessSettingId(session), GUESS_SETTING_KEY)
  return stored !== 'false' && stored !== '0'
}

async function reportStartResult(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
  result: GuessStartResult,
) {
  if (result.ok) return
  if (result.reason === 'active') {
    await replyText(session, dependencies, '当前还有猜歌游戏正在进行中，回复机器人“不玩了”结束游戏。')
    return
  }
  await replyText(session, dependencies, '本地曲目数据不足，暂时无法开始猜歌。')
}

async function startGame(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
  type: 'classical' | 'opening',
) {
  try {
    if (!await groupGuessEnabled(session, dependencies)) {
      await replyText(session, dependencies, '当前群猜歌已被禁用，请联系管理员发送“启用猜歌”。')
      return
    }
    const interaction = interactionFor(session, dependencies)
    const result = type === 'classical'
      ? await dependencies.guessService.startClassical(interaction)
      : await dependencies.guessService.startOpening(interaction)
    await reportStartResult(session, dependencies, result)
  } catch (error) {
    if (error instanceof GuessDeliveryError) return
    await replyText(session, dependencies, '猜歌启动失败，请稍后重试。')
  }
}

async function administratorSubject(session: ActiveCommandSession) {
  let authority = (session.user as { authority?: number } | undefined)?.authority
  if (authority === undefined) {
    try {
      authority = (await session.observeUser(['authority'])).authority
    } catch {
      authority = undefined
    }
  }
  return {
    userId: session.userId,
    authority,
    roles: session.event.member?.roles?.map(role => role.id),
  }
}

async function setGuessEnabled(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
  enabled: boolean,
) {
  if (session.isDirect) {
    await replyText(session, dependencies, '猜歌群设置仅支持群聊。')
    return
  }
  if (!isAdministrator(await administratorSubject(session), {
    administrators: dependencies.administrators,
  })) {
    await replyText(session, dependencies, '权限不足。')
    return
  }
  try {
    await dependencies.settingRepository.set(
      guessSettingId(session),
      GUESS_SETTING_KEY,
      enabled ? 'true' : 'false',
    )
    await replyText(session, dependencies, enabled ? '启用猜歌成功。' : '禁用猜歌成功。')
  } catch {
    await replyText(session, dependencies, '猜歌设置保存失败，请稍后重试。')
  }
}

async function handleActiveMessage(
  session: ActiveCommandSession,
  dependencies: GuessCommandDependencies,
): Promise<GuessHandleResult> {
  const interaction = interactionFor(session, dependencies)
  const message: GuessMessage = { ...interaction, content: session.content }
  return dependencies.guessService.handleMessage(message)
}

export function createGuessMiddleware(
  dependencies: GuessCommandDependencies,
): Middleware {
  return async (session, next) => {
    if (!session.userId || !session.channelId || session.userId === session.selfId) return next()
    if (session.event.user?.isBot) return next()
    const content = session.content?.trim() ?? ''
    if (!content || content.startsWith('/')) return next()
    const activeSession = session as ActiveCommandSession

    const contextId = guessContextId(session)
    if (!dependencies.guessService.hasActiveGame(contextId)) return next()
    const result = await handleActiveMessage(activeSession, dependencies)
    if (!result.consumed) return next()
  }
}

export function registerGuessCommands(
  ctx: Context,
  dependencies: GuessCommandDependencies,
): GuessCommandRegistration {
  const commands = [
    ctx.command('mai.guess', '开始经典舞萌猜歌')
      .alias('mai.猜歌')
      .action(commandAction(async ({ session }) => {
        await startGame(session, dependencies, 'classical')
      })),
    ctx.command('mai.opening', '开始舞萌开字母')
      .alias('mai.开字母', 'mai.出你字母')
      .action(commandAction(async ({ session }) => {
        await startGame(session, dependencies, 'opening')
      })),
    ctx.command('mai.guess-disable', '禁用当前群猜歌', {
      authority: 4,
      permissions: ['authority:0'],
    })
      .alias('mai.禁用猜歌', 'mai.禁止猜歌', 'mai.关闭猜歌')
      .action(commandAction(async ({ session }) => {
        await setGuessEnabled(session, dependencies, false)
      })),
    ctx.command('mai.guess-enable', '启用当前群猜歌', {
      authority: 4,
      permissions: ['authority:0'],
    })
      .alias('mai.启用猜歌', 'mai.允许猜歌', 'mai.打开猜歌')
      .action(commandAction(async ({ session }) => {
        await setGuessEnabled(session, dependencies, true)
      })),
  ]
  const disposeMiddleware = ctx.middleware(createGuessMiddleware(dependencies), true)
  let disposed = false

  return {
    commands,
    async dispose() {
      if (disposed) return
      disposed = true
      disposeMiddleware()
      for (const command of [...commands].reverse()) command.dispose()
      await dependencies.guessService.dispose()
    },
  }
}
