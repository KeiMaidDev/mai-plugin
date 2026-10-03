export const PLUGIN_NAME = 'mai-plugin'

export const DEFAULT_RATING_FOOTER_TEXT = '样式参考可怜Bot | https://bot-docs.otmdb.cn'

/** Status source used by the server-status bulletin when the deployment configures nothing else. */
export const DEFAULT_STATUS_SOURCE_BASE_URL = 'https://mai.chongxi.us'

export const INJECTED_SERVICES = ['database', 'server'] as const

/**
 * Platforms that receive this plugin's rich replies instead of the plain-text
 * fallback. Every rich-media decision reads this list, so a platform cannot be
 * enabled in one feature and overlooked in another.
 *
 * `qqguild` is listed ahead of adapter support: the channel encoder drops the
 * plugin's `qq:` elements, so every rich reply in a channel is lost until
 * `adapter-qq-crack` is fixed. `readme.md` records that temporary state and the
 * compatibility-mode workaround.
 */
export const RICH_TEXT_PLATFORMS = ['qq', 'qqguild'] as const

export function isRichTextPlatform(platform: string) {
  return (RICH_TEXT_PLATFORMS as readonly string[]).includes(platform)
}

export const LIFECYCLE_STAGES = [
  'database-models',
  'data-cache',
  'providers',
  'renderer',
  'services',
  'routes',
  'commands',
] as const
