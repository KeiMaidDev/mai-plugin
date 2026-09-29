export const PLUGIN_NAME = 'mai-plugin'

export const DEFAULT_RATING_FOOTER_TEXT = '样式参考可怜Bot | https://bot-docs.otmdb.cn'

/** Status page used by the server-status bulletin when the deployment configures nothing else. */
export const DEFAULT_STATUS_PAGE_BASE_URL = 'https://status.awmc.cc'

/** Line groups that decide the health verdict, as regex sources matched against the group name. */
export const DEFAULT_STATUS_VERDICT_GROUPS = ['CMCC', 'CT', 'CU'] as const

export const INJECTED_SERVICES = ['database', 'server'] as const

/**
 * Platforms that receive this plugin's rich replies instead of the plain-text
 * fallback. Every rich-media decision reads this list, so a platform cannot be
 * enabled in one feature and overlooked in another.
 */
export const RICH_TEXT_PLATFORMS = ['qq'] as const

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
