import type { ProviderId } from './types'

export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderId,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class ProviderAuthorizationError extends ProviderError {
  constructor(provider: ProviderId, message = 'Provider authorization failed.', status = 401) {
    super(provider, message, status)
  }
}

export class ProviderPrivacyError extends ProviderError {
  constructor(provider: ProviderId, message = 'The player denied score access.', status = 403) {
    super(provider, message, status)
  }
}

export class ProviderNotFoundError extends ProviderError {
  constructor(provider: ProviderId, message = 'The player was not found.', status = 404) {
    super(provider, message, status)
  }
}

export class ProviderNoDataError extends ProviderError {
  constructor(provider: ProviderId, message = 'The provider returned no score data.', status?: number) {
    super(provider, message, status)
  }
}

export class ProviderBindingRequiredError extends ProviderError {
  constructor(provider: ProviderId, message = 'The player is not bound to the provider.', status?: number) {
    super(provider, message, status)
  }
}

export class ProviderOAuthRequiredError extends ProviderError {
  constructor(provider: ProviderId, message = 'OAuth authorization is required.', status?: number) {
    super(provider, message, status)
  }
}

export class ProviderScopeError extends ProviderError {
  constructor(provider: ProviderId) {
    super(provider, 'The application lacks the required scope.', 403)
  }
}

export class ProviderRateLimitError extends ProviderError {
  constructor(provider: ProviderId) {
    super(provider, 'The provider rate limit was reached.', 429)
  }
}

export class ProviderAmbiguousTargetError extends ProviderError {
  constructor(provider: ProviderId) {
    super(provider, 'Multiple authorized accounts match this QQ number.')
  }
}

export class ProviderConfigurationError extends ProviderError {
  constructor(provider: ProviderId) {
    super(provider, 'Provider OAuth client configuration is invalid.')
  }
}

export class ProviderMalformedPayloadError extends ProviderError {
  constructor(provider: ProviderId, message = 'The provider returned a malformed payload.') {
    super(provider, message)
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(provider: ProviderId, message = 'The provider request timed out.') {
    super(provider, message)
  }
}

export class ProviderUnsupportedError extends ProviderError {
  constructor(provider: ProviderId, message = 'The provider does not support this operation.') {
    super(provider, message)
  }
}

export class ProviderTransportError extends ProviderError {
  constructor(provider: ProviderId, message = 'The provider request failed.', status?: number) {
    super(provider, message, status)
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError
}

export function findCancellationError(error: unknown): Error | null {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    if (current instanceof Error
      && ['AbortError', 'CanceledError', 'CancellationError'].includes(current.name)) {
      return current
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

export function isCancellationError(error: unknown): error is Error {
  return findCancellationError(error) !== null
}

function responseMessage(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const message = (value as Record<string, unknown>).message
  return typeof message === 'string' ? message : ''
}

export function providerResponseError(
  provider: ProviderId,
  status: number,
  body: unknown,
  fallbackMessage = '',
) {
  const message = responseMessage(body) || fallbackMessage
  const normalized = message.toLocaleLowerCase()
  if (/oauth|authorization required|授权/.test(normalized)) {
    return new ProviderOAuthRequiredError(provider, message || undefined, status)
  }
  if (/unbound|not bound|bind(?:ing)?\s+(?:qq|account)|未绑定|绑定.*(?:qq|账号)/.test(normalized)) {
    return new ProviderBindingRequiredError(provider, message || undefined, status)
  }
  if (/privacy|private|denied|forbidden|隐私|协议/.test(normalized)) {
    return new ProviderPrivacyError(provider, message || undefined, status)
  }
  if (/no data|no score|暂无|无数据|没有.*成绩/.test(normalized) || status === 204) {
    return new ProviderNoDataError(provider, message || undefined, status)
  }
  if (status === 401) return new ProviderAuthorizationError(provider, message || undefined, status)
  if (status === 403) return new ProviderPrivacyError(provider, message || undefined, status)
  if (status === 404 || status === 400) return new ProviderNotFoundError(provider, message || undefined, status)
  return new ProviderTransportError(provider, message || undefined, status)
}
