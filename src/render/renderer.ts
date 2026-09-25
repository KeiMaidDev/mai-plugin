import { readFile } from 'node:fs/promises'
import { Renderer, type RenderOptions } from '@takumi-rs/wasm/node'
import type { Node } from '@takumi-rs/helpers'
import type { MaimaiAssetInvalidationSource } from '../data/sync-service'
import { Semaphore, RENDER_QUEUE_FULL_MESSAGE } from '../utils/semaphore'
import { RenderAssetCache, resolvePackageAssetPath } from './assets'
import { MAIMAI_RENDER_THEME } from './theme'
import type { DebugTracer } from '../utils/debug'

const FZ_FONT_PATH = resolvePackageAssetPath('fonts/FZLanTingHei-B-GBK.ttf')
const BOLD_FONT_PATH = resolvePackageAssetPath('fonts/AlibabaPuHuiTi-3-85-Bold.otf')
const HEAVY_FONT_PATH = resolvePackageAssetPath('fonts/AlibabaPuHuiTi-3-105-Heavy.otf')

export { RENDER_QUEUE_FULL_MESSAGE }

export interface TakumiRenderServiceOptions {
  concurrency?: number
  queueLimit?: number
  timeoutMs?: number
  debug?: DebugTracer
}

export interface TakumiRenderInstrumentation {
  beforeRender?(signal: AbortSignal): void | Promise<void>
  onRenderStart?(): void
  onRenderEnd?(): void
}

export function connectDataSyncAssetInvalidation(
  source: MaimaiAssetInvalidationSource,
  renderer: TakumiRenderService,
) {
  return source.onAssetInvalidation(event => renderer.invalidateAssets(event.paths))
}

interface AbortScope {
  signal: AbortSignal
  dispose(): void
}

function createTimeoutError(timeoutMs: number) {
  const error = new Error(`Render timed out after ${timeoutMs}ms`)
  error.name = 'TimeoutError'
  return error
}

function createAbortScope(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController()
  const onCallerAbort = () => controller.abort(callerSignal?.reason)
  let timer: ReturnType<typeof setTimeout> | undefined

  if (callerSignal?.aborted) {
    onCallerAbort()
  } else {
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
    timer = setTimeout(() => controller.abort(createTimeoutError(timeoutMs)), timeoutMs)
    timer.unref?.()
  }

  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}

function throwIfAborted(signal: AbortSignal) {
  if (!signal.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error(signal.reason === undefined ? 'The operation was aborted' : String(signal.reason))
  error.name = 'AbortError'
  throw error
}

function waitForStage<T>(stage: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    try {
      throwIfAborted(signal)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      try {
        throwIfAborted(signal)
      } catch (error) {
        finish(() => reject(error))
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(stage).then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`)
  return value
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

export class TakumiRenderService {
  private readonly renderer = new Renderer()
  private readonly semaphore: Semaphore
  private readonly assetCache = new RenderAssetCache()
  private readonly timeoutMs: number
  private readonly debug?: DebugTracer
  private initializationPromise?: Promise<void>
  private renderCalls = 0
  private disposed = false
  private disposalPromise?: Promise<void>
  private readonly idleWaiters = new Set<() => void>()

  constructor(
    options: TakumiRenderServiceOptions = {},
    private readonly instrumentation: TakumiRenderInstrumentation = {},
  ) {
    const concurrency = positiveInteger(options.concurrency ?? 4, 'Render concurrency')
    if (concurrency > 16) throw new RangeError('Render concurrency cannot exceed 16')
    const queueLimit = options.queueLimit ?? 64
    if (!Number.isInteger(queueLimit) || queueLimit < 0) {
      throw new RangeError('Render queue limit must be a non-negative integer')
    }
    this.timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, 'Render timeout')
    this.debug = options.debug
    this.semaphore = new Semaphore(concurrency, queueLimit)
  }

  get activeRenders() {
    return this.semaphore.active
  }

  get pendingRenders() {
    return this.semaphore.pending
  }

  initialize(): Promise<void> {
    this.initializationPromise ??= this.registerFonts()
    return this.initializationPromise
  }

  async loadAsset(path: string | Promise<string>, fallbackPath?: string) {
    try {
      return await this.assetCache.load(await path)
    } catch (error) {
      if (!fallbackPath || !isMissingFile(error)) throw error
      return this.assetCache.load(fallbackPath)
    }
  }

  invalidateAssets(paths: Iterable<string>) {
    this.assetCache.invalidate(paths)
  }

  clearWaitingQueue(reason?: unknown) {
    this.debug?.event('render.queue.clear', { pending: this.semaphore.pending })
    this.semaphore.clear(reason)
  }

  dispose() {
    if (this.disposalPromise) return this.disposalPromise
    this.disposed = true
    this.clearWaitingQueue(new Error('[mai-plugin] renderer disposed'))
    this.disposalPromise = this.waitForIdle().then(() => {
      this.assetCache.clear()
      this.renderer.free()
    })
    return this.disposalPromise
  }

  private waitForIdle() {
    if (!this.renderCalls) return Promise.resolve()
    return new Promise<void>(resolve => this.idleWaiters.add(resolve))
  }

  private finishRenderCall() {
    this.renderCalls--
    if (this.renderCalls) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  async render(node: Node, options: RenderOptions, signal?: AbortSignal): Promise<Buffer> {
    if (this.disposed) throw new Error('[mai-plugin] renderer is disposed')
    this.renderCalls++
    const requestedAt = Date.now()
    this.debug?.event('render.queue.enter', {
      active: this.semaphore.active,
      pending: this.semaphore.pending,
    })
    const abortScope = createAbortScope(signal, this.timeoutMs)
    let release: (() => void) | undefined
    try {
      await waitForStage(this.initialize(), abortScope.signal)
      throwIfAborted(abortScope.signal)
      release = await this.semaphore.acquire(abortScope.signal)
      this.debug?.event('render.start', {
        waitMs: Date.now() - requestedAt,
        active: this.semaphore.active,
        pending: this.semaphore.pending,
      })
      await waitForStage(this.instrumentation.beforeRender?.(abortScope.signal), abortScope.signal)
      throwIfAborted(abortScope.signal)
      this.instrumentation.onRenderStart?.()
      try {
        const output = await this.renderer.render(node, { ...options, signal: abortScope.signal })
        this.debug?.event('render.success', {
          durationMs: Date.now() - requestedAt,
          bytes: output.byteLength,
        })
        return Buffer.from(output)
      } catch (error) {
        this.debug?.failure('render.failure', error, { durationMs: Date.now() - requestedAt })
        throw error
      } finally {
        this.instrumentation.onRenderEnd?.()
      }
    } finally {
      release?.()
      abortScope.dispose()
      this.finishRenderCall()
    }
  }

  private async registerFonts() {
    const [fz, bold, heavy] = await Promise.all([
      readFile(FZ_FONT_PATH),
      readFile(BOLD_FONT_PATH),
      readFile(HEAVY_FONT_PATH),
    ])
    await this.renderer.registerFont({
      name: MAIMAI_RENDER_THEME.fontFamily,
      data: bold,
      weight: 400,
      style: 'normal',
    })
    await this.renderer.registerFont({
      name: MAIMAI_RENDER_THEME.fontFamily,
      data: bold,
      weight: 700,
      style: 'normal',
    })
    await this.renderer.registerFont({
      name: MAIMAI_RENDER_THEME.fontFamily,
      data: heavy,
      weight: 900,
      style: 'normal',
    })
    await this.renderer.registerFont({
      name: 'FZLanTingHei-B-GBK',
      data: fz,
      weight: 700,
      style: 'normal',
    })
  }
}
