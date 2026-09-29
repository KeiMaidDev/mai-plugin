import type { Context } from 'koishi'
import type { CoreCommandDependencies } from './support'
import { commandAction, createQqCommandGuidance, replyText } from './support'

const HELP_TEXT = [
  '## 舞萌 DX',
  '这是一个查询舞萌DX成绩及相关信息的功能。',
  '支持以下功能指令：',
].join('\n')

export function registerHelpCommand(
  ctx: Context,
  dependencies: CoreCommandDependencies,
) {
  return ctx.command('mai', '舞萌 DX 命令帮助')
    .alias('/mai')
    .action(commandAction(async ({ session }) => {
      await replyText(session, dependencies, HELP_TEXT, createQqCommandGuidance(HELP_TEXT, [
        [
          {
            id: 'help-search',
            label: '🔎查歌',
            command: '/mai 查歌',
            enter: false,
            reply: false,
          },
          {
            id: 'help-rating',
            label: '💯Best50',
            command: '/mai b50',
            enter: true,
            reply: false,
          },
        ],
        [
          {
            id: 'help-provider',
            label: '⚙️查分设置',
            command: '/mai 查分设置',
            enter: true,
            reply: false,
          },
          {
            id: 'help-guess',
            label: '🕹️开字母',
            command: '/mai 开字母',
            enter: true,
            reply: false,
          },
        ],
        [
          {
            id: 'help-queue',
            label: '📝排卡管理',
            command: '/mai 排卡管理',
            enter: true,
            reply: false,
          },
          {
            id: 'help-game',
            label: '🎮猜歌',
            command: '/mai 猜歌',
            enter:true,
            reply: false,
          },
        ],
      ]))
    }))
}
