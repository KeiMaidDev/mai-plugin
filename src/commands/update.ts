import type { Context } from 'koishi'
import { DivingFishOAuthError } from '../providers/diving-fish-oauth'
import { ProviderOAuthRequiredError, ProviderRateLimitError, ProviderScopeError } from '../providers/errors'
import {
  PublicCallbackUnavailableError,
  type UpdateService,
  type UpdateSessionLocator,
} from '../services/update-service'
import {
  commandAction,
  createQqCommandGuidance,
  createQqUrlGuidance,
  replyText,
  type ActiveCommandSession,
  type ReplyCommandDependencies,
} from './support'

export type UpdateServicePort = Pick<
  UpdateService,
  | 'beginLxnsOAuth'
  | 'beginDivingFishOAuth'
  | 'unbindLxns'
  | 'unbindDivingFish'
>

export interface UpdateCommandDependencies extends ReplyCommandDependencies {
  updateService: UpdateServicePort
  replayCommand?: (session: ActiveCommandSession, command: string) => Promise<void> | void
}

export function createUpdateSessionLocator(
  session: ActiveCommandSession,
  dependencies: UpdateCommandDependencies,
  pendingCommand = session.content,
): UpdateSessionLocator {
  return {
    userId: session.userId,
    platform: session.platform,
    channelId: session.channelId,
    direct: session.isDirect,
    pendingCommand,
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
  }
}

async function updateFailure(
  session: ActiveCommandSession,
  dependencies: UpdateCommandDependencies,
  error: unknown,
  retryCommand?: string,
) {
  if (error instanceof PublicCallbackUnavailableError) {
    const text = `${error.message}\n落雪当前无法完成绑定，请选择其他查分器或绑定水鱼。`
    await replyText(session, dependencies, text, createQqCommandGuidance(text, [[
      {
        id: 'update-provider',
        label: '选择查分器',
        command: '/mai 设置查分器',
        enter: true,
        reply: false,
      },
      {
        id: 'update-bind-diving-fish',
        label: '绑定水鱼',
        command: '/mai 绑定水鱼',
        enter: true,
        reply: false,
      },
    ]]))
    return
  }
  if (error instanceof ProviderOAuthRequiredError
    || error instanceof DivingFishOAuthError && error.code === 'consent_required') {
    await replyText(session, dependencies, error.message, createQqCommandGuidance(error.message, [[{
      id: 'bind-diving-fish-oauth',
      label: '授权水鱼',
      command: '/mai 绑定水鱼',
      enter: true,
      reply: false,
    }]]))
    return
  }
  if (error instanceof DivingFishOAuthError || error instanceof ProviderScopeError || error instanceof ProviderRateLimitError) {
    const text = error instanceof ProviderRateLimitError || error instanceof DivingFishOAuthError && error.code === 'slow_down'
      ? '水鱼授权请求过于频繁，请稍后重试。'
      : error instanceof ProviderScopeError || error instanceof DivingFishOAuthError && error.code === 'invalid_scope'
        ? '水鱼应用缺少成绩读取权限，请联系部署者确认权限已获批。'
        : '水鱼 OAuth 配置无效或应用不可用，请联系部署者检查客户端 ID 和密钥。'
    await replyText(session, dependencies, text)
    return
  }
  const text = '操作失败，请稍后重试。'
  await replyText(session, dependencies, text, createQqCommandGuidance(text, [[{
    id: retryCommand ? 'retry-update' : 'update-help',
    label: retryCommand ? '重试' : '返回帮助',
    command: retryCommand ?? '/mai',
    enter: true,
    reply: false,
  }]]))
}

export function registerUpdateCommands(
  ctx: Context,
  dependencies: UpdateCommandDependencies,
) {
  return [
    ctx.command('mai.bind-lxns', '绑定落雪 OAuth')
      .alias('mai.绑定落雪')
      .action(commandAction(async ({ session }) => {
        try {
          const url = await dependencies.updateService.beginLxnsOAuth(
            createUpdateSessionLocator(session, dependencies, ''),
          )
          const text = `请点击下方按钮授权 BOT 访问您在落雪查分器的成绩。`
          await replyText(session, dependencies, text, createQqUrlGuidance(text, {
            id: 'lxns-oauth',
            label: '前往落雪授权',
            visitedLabel: '重新前往落雪授权',
            url,
          }))
        } catch (error) {
          await updateFailure(session, dependencies, error, '/mai 绑定落雪')
        }
      })),
    ctx.command('mai.unbind-lxns', '解绑落雪 OAuth')
      .alias('mai.解绑落雪')
      .action(commandAction(async ({ session }) => {
        try {
          await dependencies.updateService.unbindLxns(session.userId)
          const text = '落雪授权解绑成功。需要时可重新发送“/mai 绑定落雪”。'
          await replyText(session, dependencies, text, createQqCommandGuidance(text, [[{
            id: 'rebind-lxns',
            label: '重新绑定落雪',
            command: '/mai 绑定落雪',
            enter: true,
            reply: false,
          }]]))
        } catch (error) {
          await updateFailure(session, dependencies, error, '/mai 解绑落雪')
        }
      })),
    ctx.command('mai.unbind-diving-fish', '解绑水鱼账号授权')
      .alias('mai.解绑水鱼')
      .action(commandAction(async ({ session }) => {
        try {
          await dependencies.updateService.unbindDivingFish(session.userId)
          const text = '已清除本地水鱼账号关联。若要撤销远端授权，请前往水鱼账号设置页。'
          await replyText(session, dependencies, text, createQqUrlGuidance(text, {
            id: 'diving-fish-settings', label: '水鱼账号设置',
            visitedLabel: '重新打开水鱼账号设置', url: 'https://auth.diving-fish.com/apps',
          }))
        } catch (error) {
          await updateFailure(session, dependencies, error, '/mai 解绑水鱼')
        }
      })),
    ctx.command('mai.bind-diving-fish', '绑定水鱼账号授权')
      .alias('mai.绑定水鱼')
      .action(commandAction(async ({ session }) => {
        try {
          const { url, code } = await dependencies.updateService.beginDivingFishOAuth(
            createUpdateSessionLocator(session, dependencies, ''),
          )
          const text = `请点击下方按钮授权BOT访问您在水鱼查分器的成绩。`
          await replyText(session, dependencies, text, createQqUrlGuidance(text, {
            id: 'diving-fish-oauth', label: '前往水鱼授权',
            visitedLabel: '重新前往水鱼授权', url,
          }))
        } catch (error) {
          await updateFailure(session, dependencies, error)
        }
      })),
  ]
}
