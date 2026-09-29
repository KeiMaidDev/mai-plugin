import type { Command, Context } from 'koishi'
import { PLUGIN_NAME } from '../constants'
import { formatStatusText, mapStatusError } from '../platform/status-message'
import { findCancellationError } from '../providers/errors'
import { StatusPageError } from '../providers/status-page'
import { StatusPageEmptyError, type StatusService } from '../services/status-service'
import {
  commandAction,
  replyText,
  type ReplyCommandDependencies,
} from './support'

export interface StatusCommandDependencies extends ReplyCommandDependencies {
  statusService?: Pick<StatusService, 'snapshot'>
  /** A deployment that disables the bulletin registers no command at all. */
  enabled?: boolean
}

export function registerStatusCommands(
  ctx: Context,
  dependencies: StatusCommandDependencies,
): Command[] {
  const statusService = dependencies.statusService
  if (dependencies.enabled === false || !statusService) return []
  return [
    ctx.command('mai.status', '查询舞萌 DX 服务器状态')
      .alias('mai.有网吗')
      .alias('mai.状态')
      .action(commandAction(async ({ session }) => {
        try {
          const snapshot = await statusService.snapshot()
          await replyText(session, dependencies, formatStatusText(snapshot))
        } catch (error) {
          const cancellation = findCancellationError(error)
          if (cancellation) throw cancellation
          // A status-page failure is already logged by the data source with the
          // failing request and its kind; anything else is a surprise worth logging.
          if (!(error instanceof StatusPageError) && !(error instanceof StatusPageEmptyError)) {
            ctx.logger(PLUGIN_NAME).warn(`[mai-plugin] status page request failed: ${String(error)}`)
          }
          await replyText(session, dependencies, mapStatusError(error))
        }
      })),
  ]
}
