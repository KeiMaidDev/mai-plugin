import type { Context } from 'koishi'
import type { ProviderMode } from '../providers/types'
import {
  InvalidSettingError,
  PlateNotAcquiredError,
} from '../services/setting-service'
import {
  createQqButton,
  createQqButtonRow,
  createQqCommandAction,
  createQqKeyboard,
  createQqNativeMarkdown,
  createQqUrlAction,
} from '../platform/qq-message'
import {
  commandAction,
  createQqCommandGuidance,
  replyText,
  type ActiveCommandSession,
  type CoreCommandDependencies,
} from './support'

const PROVIDER_PROMPT = '请选择成绩查询使用的查分器。自动模式会依次尝试可用的查分器。'

export interface QuerySettingsPanelState {
  provider: ProviderMode
  avatar: number | null
  plate: number | null
  lxns: boolean
  divingFish: boolean
}

function providerLabel(provider: ProviderMode) {
  if (provider === 'diving-fish') return '水鱼'
  if (provider === 'lxns') return '落雪'
  return '自动'
}

export function createQuerySettingsPanel(state: QuerySettingsPanelState) {
  const text = [
    `当前查分器：${providerLabel(state.provider)}`,
    `头像：${state.avatar ?? '默认'}`,
    `牌子：${state.plate ?? '默认'}`,
    `落雪：${state.lxns ? '已绑定' : '未绑定'}`,
    `水鱼账号授权：${state.divingFish ? '已授权' : '未授权'}`,
  ].join('\n')
  const rich = createQqCommandGuidance(text, [
    [
      {
        id: 'query-settings-avatar',
        label: '设置头像',
        command: '/mai 设置头像',
        enter: false,
        reply: false,
      },
      {
        id: 'query-settings-plate',
        label: '设置牌子',
        command: '/mai 设置牌子',
        enter: false,
        reply: false,
      },
    ],
    [
      {
        id: 'query-settings-provider-auto',
        label: '自动',
        command: '/mai 设置查分器 自动',
        enter: true,
        reply: false,
      },
      {
        id: 'query-settings-provider-diving-fish',
        label: '水鱼',
        command: '/mai 设置查分器 水鱼',
        enter: true,
        reply: false,
      },
      {
        id: 'query-settings-provider-lxns',
        label: '落雪',
        command: '/mai 设置查分器 落雪',
        enter: true,
        reply: false,
      },
    ],
    [
      {
        id: 'query-settings-lxns',
        label: state.lxns ? '解绑落雪' : '绑定落雪',
        command: state.lxns ? '/mai 解绑落雪' : '/mai 绑定落雪',
        enter: true,
        reply: false,
      },
      {
        id: 'query-settings-diving-fish',
        label: state.divingFish ? '解绑水鱼' : '绑定水鱼',
        command: state.divingFish ? '/mai 解绑水鱼' : '/mai 绑定水鱼',
        enter: true,
        reply: false,
      },
    ],
  ])
  return { text, rich }
}

function providerSelectionGuidance(text: string) {
  return createQqCommandGuidance(text, [[
    {
      id: 'provider-auto',
      label: '自动',
      command: '/mai 设置查分器 自动',
      enter: true,
      reply: false,
    },
    {
      id: 'provider-diving-fish',
      label: '水鱼',
      command: '/mai 设置查分器 水鱼',
      enter: true,
      reply: false,
    },
    {
      id: 'provider-lxns',
      label: '落雪',
      command: '/mai 设置查分器 落雪',
      enter: true,
      reply: false,
    },
  ]])
}

function collectionSettingKeyboard(label: '头像' | '牌子') {
  const command = `/mai 设置${label}`
  const listUrl = `https://otmdb.cn/bot/maimai/${label === '头像' ? 'icons' : 'plates'}`
  return createQqKeyboard([createQqButtonRow([
    createQqButton(`select-${label}`, `选择${label}`, createQqUrlAction(listUrl)),
    createQqButton(`set-${label}`, `⚙ 设置${label}`, createQqCommandAction(`${command} `, {
      unsupportTips: `请在正文命令后补充${label}编号或名称并手动发送。`,
    })),
  ])])
}

async function promptForSettingValue(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  label: '头像' | '牌子',
) {
  const text = label === '头像'
    ? '\n使用方法：设置头像 <id/名称>\n\t例：设置头像 106103\n\t例：设置头像 高瀬 梨緒\n\n\t收藏品列表：https://otmdb.cn/bot/maimai/icons'
    : '\n使用方法：设置牌子/设置姓名框 id/名称\n\t例：设置牌子 100501\n\t例：设置牌子 晓将\n\t例：设置姓名框 7sRefちほー2\n\n\t牌子列表：https://otmdb.cn/bot/maimai/plates'
  const richText = label === '头像'
    ? '## 设置头像\n\n使用方法：设置头像 id/名称\n👉设置头像 106103\n👉设置头像 高瀬 梨緒\n \n⏬您可以点击下方按钮查看头像列表。'
    : '## 设置牌子\n\n使用方法：设置牌子/设置姓名框 id/名称\n👉设置牌子 100501\n👉设置牌子 晓将\n👉设置姓名框 7sRefちほー2\n \n⏬您可以点击下方按钮查看牌子列表。'
  const rich = createQqNativeMarkdown(richText, collectionSettingKeyboard(label))
  await replyText(session, dependencies, text, rich)
}

async function replySettingSuccess(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  label: '头像' | '牌子',
) {
  const text = `设置${label}成功。`
  await replyText(session, dependencies, text,
    createQqNativeMarkdown(`**设置${label}**\n\n${text}`, collectionSettingKeyboard(label)))
}

function pendingScope(session: ActiveCommandSession) {
  return {
    userId: session.userId,
    sessionId: `${session.platform}:${session.channelId}`,
  }
}

function providerMode(raw: string): ProviderMode | null {
  const normalized = raw.trim().toLocaleLowerCase()
  if (['自动', 'auto'].includes(normalized)) return 'auto'
  if (['水鱼', 'diving-fish', 'divingfish'].includes(normalized)) return 'diving-fish'
  if (['落雪', 'lxns'].includes(normalized)) return 'lxns'
  return null
}

async function settingFailure(
  session: ActiveCommandSession,
  dependencies: CoreCommandDependencies,
  error: unknown,
) {
  if (error instanceof PlateNotAcquiredError) {
    await replyText(session, dependencies, '您未达成该牌子的获得条件。')
    return
  }
  if (error instanceof InvalidSettingError) {
    if (error.setting === 'avatar' || error.setting === 'plate') {
      await promptForSettingValue(session, dependencies, error.setting === 'avatar' ? '头像' : '牌子')
      return
    }
    await replyText(session, dependencies, '设置失败，请检查输入。')
    return
  }
  await replyText(session, dependencies, '设置失败，请稍后重试。')
}

export function registerSettingsCommands(
  ctx: Context,
  dependencies: CoreCommandDependencies,
) {
  const commands = []

  commands.push(ctx.command('mai.bind <qq:string>', '绑定查询使用的 QQ 号')
    .alias('mai.绑定')
    .action(commandAction(async ({ session }, qq = '') => {
      const normalized = qq.trim()
      if (!/^\d{5,20}$/.test(normalized)) {
        const text = '用法：/mai 绑定 <QQ 号>'
        await replyText(session, dependencies, text, createQqCommandGuidance(text, [[{
          id: 'bind-qq',
          label: '绑定 QQ',
          command: '/mai 绑定',
          enter: false,
          reply: false,
          unsupportTips: '请在正文命令后补充 QQ 号并手动发送。',
        }]]))
        return
      }
      try {
        await dependencies.bindRepository.setQq(session.userId, normalized)
        const pending = dependencies.queryService.consumePendingCommand(pendingScope(session))
        await replyText(session, dependencies, 'QQ 绑定成功。')
        if (pending) {
          if (dependencies.replayCommand) {
            await dependencies.replayCommand(session, pending)
          } else {
            await session.execute(pending)
          }
        }
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.provider <provider:string>', '设置成绩查询后端')
    .alias('mai.设置查分器')
    .alias('mai.设置水鱼', { args: ['diving-fish'] })
    .alias('mai.水鱼', { args: ['diving-fish'] })
    .alias('mai.设置落雪', { args: ['lxns'] })
    .alias('mai.落雪', { args: ['lxns'] })
    .action(commandAction(async ({ session }, raw = '') => {
      const provider = providerMode(raw)
      if (!provider) {
        const text = raw.trim()
          ? `不支持该查分器。${PROVIDER_PROMPT}`
          : PROVIDER_PROMPT
        await replyText(session, dependencies, text, providerSelectionGuidance(text))
        return
      }
      try {
        await dependencies.settingService.setProviderPreference(session.userId, provider)
        await replyText(session, dependencies, `已将查分器设置为“${providerLabel(provider)}”。`)
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.compatibility <input:text>', '切换兼容模式')
    .alias('mai.兼容模式', { args: ['兼容模式'] })
    .alias('mai.取消兼容模式', { args: ['取消兼容模式'] })
    .alias('mai.关闭兼容模式', { args: ['关闭兼容模式'] })
    .alias('mai.禁用兼容模式', { args: ['禁用兼容模式'] })
    .alias('mai.打开兼容模式', { args: ['打开兼容模式'] })
    .alias('mai.启用兼容模式', { args: ['启用兼容模式'] })
    .action(commandAction(async ({ session }, raw) => {
      const disabled = /^(?:取消|关闭|禁用)兼容模式$/.test(raw)
        || /^兼容模式\s+(?:取消|关闭|禁用)$/.test(raw)
      const enabled = !disabled
      try {
        await dependencies.settingService.setCompatibilityMode(session.userId, enabled)
        await replyText(
          session,
          dependencies,
          enabled ? '兼容模式启用成功。' : '兼容模式禁用成功。',
        )
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.avatar <value:text>', '设置舞萌头像')
    .alias('mai.设置头像')
    .action(commandAction(async ({ session }, value = '') => {
      const requested = value.trim()
      if (!requested) {
        await promptForSettingValue(session, dependencies, '头像')
        return
      }
      try {
        await dependencies.settingService.setAvatar(session.userId, requested)
        await replySettingSuccess(session, dependencies, '头像')
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.plate <value:text>', '设置舞萌牌子或姓名框')
    .alias('mai.设置牌子', 'mai.设置姓名框')
    .action(commandAction(async ({ session }, value = '') => {
      const requested = value.trim()
      if (!requested) {
        await promptForSettingValue(session, dependencies, '牌子')
        return
      }
      try {
        await dependencies.settingService.setPlate(session.userId, requested)
        await replySettingSuccess(session, dependencies, '牌子')
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.query-settings', '显示舞萌成绩图设置')
    .alias('mai.查分设置', 'mai.设置mai', 'mai.设置b50')
    .action(commandAction(async ({ session }) => {
      if (!dependencies.updateService) {
        await settingFailure(session, dependencies, new Error('Update service is unavailable.'))
        return
      }
      try {
        const [settings, bindingStatus] = await Promise.all([
          dependencies.settingService.getSettings(session.userId),
          dependencies.updateService.getBindingStatus(session.userId),
        ])
        const panel = createQuerySettingsPanel({ ...settings, ...bindingStatus })
        await replyText(session, dependencies, panel.text, panel.rich)
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  commands.push(ctx.command('mai.default', '将舞萌设为默认音游')
    .alias('mai.默认', 'mai.设为默认')
    .action(commandAction(async ({ session }) => {
      try {
        await dependencies.settingService.setDefaultGame(session.userId, 'maimai')
        await replyText(session, dependencies, '设置成功，默认游戏已切换为 maimai。')
      } catch (error) {
        await settingFailure(session, dependencies, error)
      }
    })))

  return commands
}
