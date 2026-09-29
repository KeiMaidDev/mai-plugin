import type { ProviderId, ProviderMode } from './types'

export const PROVIDER_LABELS: Readonly<Record<ProviderId, string>> = Object.freeze({
  'diving-fish': '水鱼',
  lxns: '落雪',
})

export function providerLabel(provider: ProviderMode): string {
  if (provider === 'auto') return '自动'
  return PROVIDER_LABELS[provider] ?? provider
}
