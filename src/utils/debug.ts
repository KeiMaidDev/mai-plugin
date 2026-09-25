export type DebugValue = unknown

export interface DebugLogSink {
  info(message: string): void
}

export class DebugTracer {
  constructor(
    readonly enabled: boolean,
    private readonly logger: DebugLogSink,
  ) {}

  event(name: string, _details?: DebugValue) {
    if (!this.enabled) return
    this.logger.info(`[mai-plugin:debug] ${name}`)
  }

  failure(name: string, _error: unknown, _details: Record<string, DebugValue> = {}) {
    this.event(name)
  }
}
