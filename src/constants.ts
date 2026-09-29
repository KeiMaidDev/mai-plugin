export const PLUGIN_NAME = 'mai-plugin'

export const DEFAULT_RATING_FOOTER_TEXT = '样式参考可怜Bot | https://bot-docs.otmdb.cn'

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
