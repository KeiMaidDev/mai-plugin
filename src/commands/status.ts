import type { Command, Context } from 'koishi'
import h from '@satorijs/element'
import { PLUGIN_NAME, isRichTextPlatform } from '../constants'
import type { FallbackElement } from '../platform/fallback-message'
import {
  createQqButton,
  createQqButtonRow,
  createQqCommandAction,
  createQqKeyboard,
  createQqNativeMarkdown,
  sendReply,
  type QqKeyboard,
} from '../platform/qq-message'
import {
  transformAssetImageUrl,
  type AssetTransformer,
} from '../platform/qq-markdown-image'
import {
  formatStatusMarkdown,
  formatStatusText,
  mapStatusError,
  type StatusBannerLoader,
} from '../platform/status-message'
import { findCancellationError } from '../providers/errors'
import { StatusSourceError } from '../providers/status-source'
import {
  StatusSourceEmptyError,
  type StatusService,
  type StatusSnapshot,
} from '../services/status-service'
import {
  commandAction,
  compatibilityModeFor,
  replyText,
  type ActiveCommandSession,
  type ReplyCommandDependencies,
} from './support'

export interface StatusCommandDependencies extends ReplyCommandDependencies {
  statusService?: Pick<StatusService, 'snapshot'>
  /** A deployment that disables the bulletin registers no command at all. */
  enabled?: boolean
  assetTransformer?: AssetTransformer
  /** Reads a verdict's banner artwork; absent means the bulletin omits the image. */
  loadStatusBanner?: StatusBannerLoader
}

/**
 * What the Refresh button sends. `mai.status` carries the `mai.有网吗` alias, and
 * Koishi reads `/mai` plus every following token as a dotted subcommand path, so
 * the button arrives at the same command a typed `/mai 有网吗` does — no callback
 * payload and no second parsing path.
 */
export const STATUS_REFRESH_COMMAND = '/mai 有网吗'

/** The one-row keyboard the Markdown bulletin carries. */
export function createStatusKeyboard(): QqKeyboard {
  return createQqKeyboard([createQqButtonRow([
    createQqButton(
      'status-refresh',
      '刷新',
      createQqCommandAction(STATUS_REFRESH_COMMAND, { enter: true }),
    ),
  ])])
}

/**
 * The status bulletin at the send boundary. QQ picks the Markdown form of the
 * same snapshot; every other platform, and compatibility mode, gets the banner
 * as an ordinary image element followed by the plain text. A banner that cannot
 * be read or uploaded costs the reply the banner — and, with it, the button that
 * rides the Markdown form — never the reply itself.
 */
export async function replyStatusBulletin(
  session: ActiveCommandSession,
  dependencies: StatusCommandDependencies,
  snapshot: StatusSnapshot,
) {
  const text = formatStatusText(snapshot)
  let banner: Buffer | null = null
  try {
    banner = dependencies.loadStatusBanner
      ? await dependencies.loadStatusBanner(snapshot.verdict)
      : null
  } catch {
    banner = null
  }
  const fallback: FallbackElement[] = [
    ...(banner ? [{ type: 'image' as const, data: banner, mimeType: 'image/png' }] : []),
    { type: 'text' as const, text },
  ]
  const compatibilityMode = await compatibilityModeFor(session, dependencies)
  let rich: h | undefined
  // `sendReply` applies the same platform rule; repeating it here is what keeps
  // an upload that would be discarded from being made at all.
  if (banner && dependencies.assetTransformer
    && isRichTextPlatform(session.platform) && !compatibilityMode) {
    try {
      const url = await transformAssetImageUrl(banner, 'image/png', dependencies.assetTransformer)
      rich = createQqNativeMarkdown(formatStatusMarkdown(snapshot, url), createStatusKeyboard())
    } catch {
      rich = undefined
    }
  }
  await sendReply(session, fallback, rich, { compatibilityMode })
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
          await replyStatusBulletin(session, dependencies, snapshot)
        } catch (error) {
          const cancellation = findCancellationError(error)
          if (cancellation) throw cancellation
          // A status-source failure is already logged by the data source with the
          // failing request and its kind; anything else is a surprise worth logging.
          if (!(error instanceof StatusSourceError) && !(error instanceof StatusSourceEmptyError)) {
            ctx.logger(PLUGIN_NAME).warn(`[mai-plugin] status source request failed: ${String(error)}`)
          }
          await replyText(session, dependencies, mapStatusError(error))
        }
      })),
  ]
}
