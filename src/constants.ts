export const PLUGIN_NAME = 'mai-plugin'

export const DEFAULT_RATING_FOOTER_TEXT = '样式参考可怜Bot | https://bot-docs.otmdb.cn'

export const INJECTED_SERVICES = ['database', 'server'] as const

export const LIFECYCLE_STAGES = [
  'database-models',
  'data-cache',
  'providers',
  'renderer',
  'services',
  'routes',
  'commands',
] as const
