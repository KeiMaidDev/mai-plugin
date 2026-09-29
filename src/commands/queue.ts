import type { Command, Context } from 'koishi'
import { isAdministrator } from '../platform/admin'
import {
  QueueServiceError,
  type QueueService,
} from '../services/queue-service'
import {
  commandAction,
  createQqCommandGuidance,
  replyText,
  type ActiveCommandSession,
  type QqCommandGuidanceButton,
  type ReplyCommandDependencies,
} from './support'

type QueueServicePort = Pick<
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

export interface QueueCommandDependencies extends ReplyCommandDependencies {
  queueService: QueueServicePort
  administrators?: readonly string[]
}

export interface QueueCommandRegistration {
  readonly commands: readonly Command[]
  dispose(): Promise<void>
}

export const QUEUE_HELP_TEXT = [
  '## 舞萌DX',
  '本功能可以提供机厅人数查询及更新功能。',
  '支持的管理命令如下：',
].join('\n')

const queueActionRows: readonly (readonly QqCommandGuidanceButton[])[] = [
  [
    queueAction('queue-add-arcade', '添加机厅', '添加机厅'),
    queueAction('queue-delete-arcade', '删除机厅', '删除机厅'),
  ],
  [
    queueAction('queue-view-aliases', '查看别名', '查看别名'),
    queueAction('queue-add-alias', '添加别名', '添加别名'),
  ],
  [
    queueAction('queue-delete-alias', '删除别名', '删除别名'),
    queueAction('queue-bind-group', '添加分组', '添加分组'),
  ],
  [
    queueAction('queue-query-count', '查询人数', '查询人数', true),
    queueAction('queue-update-count', '更新人数', '更新人数'),
  ],
]

function queueAction(
  id: string,
  label: string,
  operation: string,
  enter = false,
): QqCommandGuidanceButton {
  return {
    id,
    label,
    command: `/mai 排卡管理 ${operation}`,
    enter,
    reply: false,
  }
}

function queueMenu(content: string) {
  return createQqCommandGuidance(content, queueActionRows)
}

function queueOperation(content: string, id: string, label: string, operation: string) {
  return createQqCommandGuidance(content, [[queueAction(id, label, operation)]])
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

async function queryQueue(
  session: ActiveCommandSession,
  dependencies: QueueCommandDependencies,
  name = '',
) {
  if (session.isDirect) {
    await replyText(session, dependencies, '机厅人数查询仅支持群聊。')
    return
  }
  try {
    const result = await dependencies.queueService.query(session.channelId, name)
    if (!result || result.type === 'updated' || result.type === 'too-large') {
      await replyText(session, dependencies, '未找到对应机厅。', queueMenu('未找到对应机厅。'))
      return
    }
    await replyText(session, dependencies, result.text, queueMenu(result.text))
  } catch (error) {
    if (error instanceof QueueServiceError) {
      await replyText(session, dependencies, error.message, queueMenu(error.message))
      return
    }
    throw error
  }
}

async function manageQueue(
  session: ActiveCommandSession,
  dependencies: QueueCommandDependencies,
  raw: string,
) {
  if (session.isDirect) {
    await replyText(session, dependencies, '排卡管理仅支持群聊。')
    return
  }
  const [operation, name, alias] = raw.trim().split(/\s+/u)
  if (!operation) {
    await replyText(session, dependencies, QUEUE_HELP_TEXT, queueMenu(QUEUE_HELP_TEXT))
    return
  }
  if (operation === '查询人数') {
    await queryQueue(session, dependencies, name)
    return
  }
  if (!isAdministrator(await administratorSubject(session), {
    administrators: dependencies.administrators,
  })) {
    await replyText(session, dependencies, '权限不足。')
    return
  }
  try {
    switch (operation) {
      case '更新人数': {
        if (!name || !alias) {
          const text = '请填写机厅名称和人数，例如：/mai 排卡管理 更新人数 jt +1'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-update-count-input',
            '填写机厅和人数',
            '更新人数',
          ))
          return
        }
        const result = await dependencies.queueService.updateCount(
          session.channelId,
          name,
          alias,
        )
        if (!result || result.type === 'query' || result.type === 'empty') {
          await replyText(session, dependencies, '未找到对应机厅或人数格式不正确。', queueMenu(
            '未找到对应机厅或人数格式不正确。',
          ))
          return
        }
        await replyText(session, dependencies, result.text, queueMenu(result.text))
        return
      }
      case '添加机厅':
        if (!name) {
          const text = '请填写机厅名称'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-add-arcade-input',
            '填写机厅名称',
            '添加机厅',
          ))
          return
        }
        await dependencies.queueService.addArcade(session.channelId, name)
        await replyText(session, dependencies, '添加机厅成功。', queueMenu('添加机厅成功。'))
        return
      case '删除机厅':
        if (!name) {
          const text = '请填写机厅名称'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-delete-arcade-input',
            '填写机厅名称',
            '删除机厅',
          ))
          return
        }
        await dependencies.queueService.deleteArcade(session.channelId, name)
        await replyText(session, dependencies, '删除机厅成功。', queueMenu('删除机厅成功。'))
        return
      case '添加别名':
        if (!name || !alias) {
          const text = '请填写机厅名称和别名'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-add-alias-input',
            '填写机厅和别名',
            '添加别名',
          ))
          return
        }
        await dependencies.queueService.addAlias(session.channelId, name, alias)
        await replyText(session, dependencies, '添加机厅别名成功。', queueMenu('添加机厅别名成功。'))
        return
      case '删除别名':
        if (!name || !alias) {
          const text = '请填写机厅名称和别名'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-delete-alias-input',
            '填写机厅和别名',
            '删除别名',
          ))
          return
        }
        await dependencies.queueService.deleteAlias(session.channelId, name, alias)
        await replyText(session, dependencies, '删除机厅别名成功。', queueMenu('删除机厅别名成功。'))
        return
      case '查看别名': {
        if (!name) {
          const text = '请填写机厅名称'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-view-aliases-input',
            '填写机厅名称',
            '查看别名',
          ))
          return
        }
        const aliases = await dependencies.queueService.aliases(session.channelId, name)
        const text = `机厅别名如下：${aliases.join('，')}`
        await replyText(session, dependencies, text, queueMenu(text))
        return
      }
      case '添加分组':
        if (!name) {
          const text = '请填写分组名称'
          await replyText(session, dependencies, text, queueOperation(
            text,
            'queue-bind-group-input',
            '填写分组名称',
            '添加分组',
          ))
          return
        }
        await dependencies.queueService.bindGroup(session.channelId, name)
        await replyText(session, dependencies, '设置分组成功。', queueMenu('设置分组成功。'))
        return
      default:
        await replyText(session, dependencies, QUEUE_HELP_TEXT, queueMenu(QUEUE_HELP_TEXT))
    }
  } catch (error) {
    if (error instanceof QueueServiceError) {
      await replyText(session, dependencies, error.message, queueMenu(error.message))
      return
    }
    throw error
  }
}

export function registerQueueCommands(
  ctx: Context,
  dependencies: QueueCommandDependencies,
): QueueCommandRegistration {
  const queryCommand = ctx.command('mai.queue.query [name:string]', '查询机厅人数')
    .alias('.查询人数')
    .action(commandAction(async ({ session }, name = '') => {
      await queryQueue(session, dependencies, name)
    }))
  const command = ctx.command('mai.queue [input:text]', '管理机厅排卡')
    .alias('mai.排卡管理')
    .action(commandAction(async ({ session }, input = '') => {
      await manageQueue(session, dependencies, input)
    }))
  let disposed = false

  return {
    commands: [queryCommand, command],
    async dispose() {
      if (disposed) return
      disposed = true
      queryCommand.dispose()
      command.dispose()
    },
  }
}
