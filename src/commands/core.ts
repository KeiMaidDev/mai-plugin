import type { Command, Context, Session } from 'koishi'
import { registerCalcCommands } from './calc'
import { registerGuessCommands } from './guess'
import { registerHelpCommand } from './help'
import { registerImageCommands } from './image'
import { registerMusicCommands } from './music'
import { registerQueueCommands } from './queue'
import { registerRecordCommands } from './record'
import { registerSettingsCommands } from './settings'
import { registerStatusCommands } from './status'
import { registerUpdateCommands } from './update'
import type { CoreCommandDependencies } from './support'
import { PLUGIN_NAME } from '../constants'
import { createGuessPresenter } from '../platform/guess-message'
import { parseComboQuery } from '../query/combo-parser'
import { resolveQqCommandCallbackData } from '../platform/qq-message'

export type { CoreCommandDependencies } from './support'

const compatibilityPatterns = [
  /^mai$/i,
  /^id\d+$/i,
  /^(?:绿谱?|黄谱?|红谱?|紫谱?|白谱?|Basic|Advanced|Expert|Master|ReMaster)id\d+$/i,
  /^随个(?:\s+.*)?$/,
  /^查歌(?:\s+.*)?$/,
  /^定数查歌(?:\s+.*)?$/,
  /^拟合定数查歌(?:\s+.*)?$/,
  /^谱师查歌(?:\s+.*)?$/,
  /^版本查歌(?:\s+.*)?$/,
  /^曲师查歌(?:\s+.*)?$/,
  /^正则查歌(?:\s+.*)?$/,
  /^(?:BPM|bpm)查歌(?:\s+.*)?$/,
  /^搜索(?:\s+.*)?$/,
  /^添加别名(?:\s+.*)?$/,
  /^删除别名(?:\s+.*)?$/,
  /^今日舞萌$/,
  /^预览(?:\s+.*)?$/,
  /^(?:.*?)b(?:15|25|35|40|50)(?:\s+.*)?$/i,
  /^(?:.*?)(?:分数列表|分数表|成绩列表|成绩表)(?:\s+\d+)?$/,
  /^(?:.*?)定数表$/,
  /^(?:.*?)(?:完成表|进度表|未完成表|未完成列表)$/,
  /^(?:info|minfo)\s+.+$/i,
  /^歌50\s+.+$/i,
  /^(?:绿谱?|黄谱?|红谱?|紫谱?|白谱?)成绩\s+.+$/,
  /^段位表(?:\s+.*)?$/,
  /^.+?进度(?:\s+.*)?$/,
  /^分数线(?:\s+.*)?$/,
  /^(?:bind|绑定)(?:\s+.*)?$/i,
  /^设置查分器(?:\s+.*)?$/,
  /^(?:设置水鱼|水鱼|设置落雪|落雪)$/,
  /^(?:兼容模式(?:\s+.*)?|取消兼容模式|关闭兼容模式|禁用兼容模式|打开兼容模式|启用兼容模式)$/,
  /^设置头像(?:\s+.*)?$/,
  /^(?:设置牌子|设置姓名框)(?:\s+.*)?$/,
  /^查分设置$/,
  /^设置(?:mai|b50)$/i,
  /^(?:默认|设为默认)$/,
  /^绑定水鱼$/,
  /^绑定落雪$/,
  /^解绑落雪$/,
  /^解绑水鱼$/,
  /^有网吗$/,
] as const

export function isExactCompatibilityCommand(content: string) {
  const normalized = content.trim()
  return compatibilityPatterns.some(pattern => pattern.test(normalized))
    && resolveCompatibilityExecution(normalized) !== null
}

function commandArgument(value: string) {
  return value.trim()
}

export function resolveCompatibilityExecution(content: string) {
  const normalized = content.trim()
  let match: RegExpMatchArray | null
  if (/^mai$/i.test(normalized)) return 'mai'
  if ((match = normalized.match(/^id(\d+)$/i))) return `mai.id ${match[1]}`
  if ((match = normalized.match(/^(绿谱?|黄谱?|红谱?|紫谱?|白谱?|Basic|Advanced|Expert|Master|ReMaster)id(\d+)$/i))) {
    return `mai.id ${match[2]} --difficulty ${commandArgument(match[1])}`
  }
  const textCommands: Array<[RegExp, string]> = [
    [/^随个(?:\s+(.*))?$/, 'mai.random'],
    [/^查歌(?:\s+(.*))?$/, 'mai.search'],
    [/^定数查歌(?:\s+(.*))?$/, 'mai.level-search'],
    [/^拟合定数查歌(?:\s+(.*))?$/, 'mai.fit-level-search'],
    [/^谱师查歌(?:\s+(.*))?$/, 'mai.designer-search'],
    [/^版本查歌(?:\s+(.*))?$/, 'mai.version-search'],
    [/^曲师查歌(?:\s+(.*))?$/, 'mai.artist-search'],
    [/^正则查歌(?:\s+(.*))?$/, 'mai.regex-search'],
    [/^(?:BPM|bpm)查歌(?:\s+(.*))?$/, 'mai.bpm-search'],
    [/^搜索(?:\s+(.*))?$/, 'mai.combo-search'],
    [/^添加别名(?:\s+(.*))?$/, 'mai.alias-add'],
    [/^删除别名(?:\s+(.*))?$/, 'mai.alias-remove'],
    [/^预览(?:\s+(.*))?$/, 'mai.preview'],
    [/^分数线(?:\s+(.*))?$/, 'mai.score-line'],
    [/^(?:bind|绑定)(?:\s+(.*))?$/i, 'mai.bind'],
    [/^设置查分器(?:\s+(.*))?$/, 'mai.provider'],
    [/^设置头像(?:\s+(.*))?$/, 'mai.avatar'],
    [/^(?:设置牌子|设置姓名框)(?:\s+(.*))?$/, 'mai.plate'],
  ]
  for (const [pattern, command] of textCommands) {
    match = normalized.match(pattern)
    if (match) return `${command} ${commandArgument(match[1] ?? '')}`
  }
  if (/^今日舞萌$/.test(normalized)) return 'mai.daily'
  if (/^有网吗$/.test(normalized)) return 'mai.status'
  if (/^绑定水鱼$/.test(normalized)) return 'mai.bind-diving-fish'
  if (/^绑定落雪$/.test(normalized)) return 'mai.bind-lxns'
  if (/^解绑落雪$/.test(normalized)) return 'mai.unbind-lxns'
  if (/^解绑水鱼$/.test(normalized)) return 'mai.unbind-diving-fish'
  if (/^(?:设置水鱼|水鱼)$/.test(normalized)) return 'mai.provider diving-fish'
  if (/^(?:设置落雪|落雪)$/.test(normalized)) return 'mai.provider lxns'
  if (/^(?:查分设置|设置mai|设置b50)$/i.test(normalized)) return 'mai.query-settings'
  if (/^(?:默认|设为默认)$/.test(normalized)) return 'mai.default'
  if (/^(?:兼容模式(?:\s+.*)?|取消兼容模式|关闭兼容模式|禁用兼容模式|打开兼容模式|启用兼容模式)$/.test(normalized)) {
    return `mai.compatibility ${commandArgument(normalized)}`
  }
  if ((match = normalized.match(/^(.*?)b(?:15|25|35|40|50)(?:\s+.*)?$/i))) {
    const filter = commandArgument(match[1])
    if (filter && !parseComboQuery(filter)) return null
    return `mai.rating ${commandArgument(normalized)}`
  }
  if ((match = normalized.match(/^(.*?)(?:分数列表|分数表|成绩列表|成绩表)(?:\s+(\d+))?$/))) {
    const filter = commandArgument(match[1])
    if (filter && !parseComboQuery(filter)) return null
    return `mai.score-list ${JSON.stringify(filter)} ${match[2] ?? 1}`
  }
  if ((match = normalized.match(/^(.*?)定数表$/))) {
    const filter = commandArgument(match[1])
    if (filter && !parseComboQuery(filter)) return null
    return `mai.level-table ${filter}`
  }
  if ((match = normalized.match(/^(?!.*未完成)(.*?)(?:完成表|进度表)$/))) {
    const filter = commandArgument(match[1])
    if (filter && !parseComboQuery(filter)) return null
    return `mai.complete-table ${filter}`
  }
  if ((match = normalized.match(/^(.*?)(?:未完成表|未完成列表)$/))) {
    const filter = commandArgument(match[1])
    if (filter && !parseComboQuery(filter)) return null
    return `mai.incomplete-table ${filter}`
  }
  if ((match = normalized.match(/^(?:info|minfo)\s+(.+)$/i))) {
    return `mai.song-score ${commandArgument(match[1])}`
  }
  if ((match = normalized.match(/^歌50\s+(.+)$/i))) {
    return `mai.song-rating ${commandArgument(match[1])}`
  }
  if ((match = normalized.match(/^(绿谱?|黄谱?|红谱?|紫谱?|白谱?)成绩\s+(.+)$/))) {
    return `mai.song-score ${commandArgument(match[2])} --difficulty ${commandArgument(match[1])}`
  }
  if ((match = normalized.match(/^段位表(?:\s+(.*))?$/))) {
    return `mai.course ${commandArgument(match[1] ?? '')}`
  }
  if ((match = normalized.match(/^(.+?)进度(?:\s+(.*))?$/))) {
    const filter = commandArgument(match[1])
    if (!parseComboQuery(filter)) return null
    return `mai.progress ${filter} ${commandArgument(match[2] ?? '')}`
  }
  return null
}

export function resolvePendingCommandExecution(content: string) {
  const normalized = content.trim()
  const legacy = normalized.match(/^\/mai(?:\s+(.*))?$/i)
  if (legacy) {
    return resolveCompatibilityExecution(legacy[1] ?? 'mai')
      ?? normalized.slice(1)
  }
  return resolveCompatibilityExecution(normalized)
}

export interface CoreCommandRegistration {
  readonly commands: readonly Command[]
  dispose(): Promise<void>
}

async function dispatchQqCommandCallback(session: Session) {
  const button = session.event.button as { data?: unknown } | undefined
  const command = resolveQqCommandCallbackData(button?.data)
  if (!command || !session.userId || !session.channelId) return
  const execution = resolvePendingCommandExecution(command)
  if (!execution) return

  session.content = command
  await session.execute(execution)
}

export function registerCoreCommands(
  ctx: Context,
  dependencies: CoreCommandDependencies,
) {
  const commandDependencies = dependencies.replayCommand
    ? dependencies
    : {
        ...dependencies,
        replayCommand: async (session: Session, command: string) => {
          const execution = resolvePendingCommandExecution(command)
          if (execution) await session.execute(execution)
        },
      }
  const guessRegistration = dependencies.guessService && dependencies.settingRepository
    ? registerGuessCommands(ctx, {
        guessService: dependencies.guessService,
        settingRepository: dependencies.settingRepository,
        settingService: dependencies.settingService,
        presenter: createGuessPresenter({
          assets: dependencies.assetTransformer,
          renderCard: dependencies.guessCardRender,
          logger: ctx.logger(PLUGIN_NAME),
        }),
        administrators: dependencies.administrators,
        compatibilityMode: dependencies.compatibilityMode,
      })
    : undefined
  const queueRegistration = dependencies.queueService
    ? registerQueueCommands(ctx, {
        queueService: dependencies.queueService,
        settingService: dependencies.settingService,
        administrators: dependencies.administrators,
        compatibilityMode: dependencies.compatibilityMode,
      })
    : undefined
  const regularCommands = [
    registerHelpCommand(ctx, commandDependencies),
    ...registerSettingsCommands(ctx, commandDependencies),
    ...registerMusicCommands(ctx, commandDependencies),
    ...registerImageCommands(ctx, commandDependencies),
    ...registerRecordCommands(ctx, commandDependencies),
    ...registerCalcCommands(ctx, commandDependencies),
    ...registerStatusCommands(ctx, {
      statusService: commandDependencies.statusService,
      enabled: commandDependencies.statusEnabled,
      assetTransformer: commandDependencies.assetTransformer,
      loadStatusBanner: commandDependencies.loadStatusBanner,
      settingService: commandDependencies.settingService,
      compatibilityMode: commandDependencies.compatibilityMode,
    }),
    ...(dependencies.updateService ? registerUpdateCommands(ctx, {
      updateService: dependencies.updateService,
      settingService: dependencies.settingService,
      compatibilityMode: dependencies.compatibilityMode,
      replayCommand: dependencies.replayCommand,
    }) : []),
  ]
  const commands = [
    ...(guessRegistration?.commands ?? []),
    ...(queueRegistration?.commands ?? []),
    ...regularCommands,
  ]
  const disposeCallbacks = ctx.on('interaction/button', dispatchQqCommandCallback)
  let disposed = false

  return {
    commands,
    async dispose() {
      if (disposed) return
      disposed = true
      disposeCallbacks()
      for (const command of [...regularCommands].reverse()) command.dispose()
      await queueRegistration?.dispose()
      await guessRegistration?.dispose()
    },
  } satisfies CoreCommandRegistration
}
