import type { Context } from 'koishi'
import h from '@satorijs/element'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Config, ConfigSchema } from './config'
import {
  registerCoreCommands,
  type CoreCommandDependencies,
  type CoreCommandRegistration,
} from './commands/core'
import { INJECTED_SERVICES, PLUGIN_NAME } from './constants'
import { MaimaiDataSyncService, type MaimaiDataSyncOptions } from './data/sync-service'
import { registerMaiDatabaseModels } from './database/models'
import { MaiRepositories } from './database/repositories'
import { PlayerSettings } from './domain/player'
import { DivingFishProvider } from './providers/diving-fish'
import { DivingFishOAuth } from './providers/diving-fish-oauth'
import { LxnsProvider } from './providers/lxns'
import { ProviderChain } from './providers/provider-chain'
import { TakumiMaiRenderer } from './render/mai-renderer'
import { TakumiGuessRenderer } from './render/guess-template'
import {
  connectDataSyncAssetInvalidation,
  TakumiRenderService,
  type TakumiRenderServiceOptions,
} from './render/renderer'
import { AliasService } from './services/alias-service'
import { GuessService, type GuessReply, type GuessTarget } from './services/guess-service'
import { QqBindingRequiredError, QueryService } from './services/query-service'
import { QueueService } from './services/queue-service'
import { SettingService } from './services/setting-service'
import {
  lxnsCallbackUrl,
  PublicCallbackUnavailableError,
  UpdateService,
} from './services/update-service'
import type { Awaitable, LifecycleContext, LifecycleSteps, PluginContext } from './types'
import { registerMaiServerRoutes } from './server/routes'
import { DebugTracer } from './utils/debug'

export const name = PLUGIN_NAME

export { Config, ConfigSchema, usage } from './config'
export { type LifecycleContext, type LifecycleSteps }
export * from './database/models'
export * from './database/repositories'
export * from './domain/enums'
export * from './domain/music'
export * from './domain/player'
export * from './domain/rating'
export * from './data/alias-cache'
export * from './data/cache-store'
export * from './data/manifest'
export * from './data/lxns-assets'
export * from './data/normalizers'
export * from './data/sync-service'
export * from './providers/types'
export * from './providers/errors'
export * from './providers/diving-fish'
export * from './providers/lxns'
export * from './providers/provider-chain'
export * from './query/filter-types'
export * from './query/combo-parser'
export * from './query/combo-rules'
export * from './query/combo-executor'
export * from './services/alias-service'
export * from './services/guess-service'
export * from './services/query-service'
export * from './services/queue-service'
export * from './services/setting-service'
export * from './services/update-service'
export * from './server/callback-store'
export * from './server/lxns-callback'
export * from './server/routes'
export * from './commands/calc'
export * from './commands/core'
export * from './commands/guess'
export * from './commands/help'
export * from './commands/image'
export * from './commands/music'
export * from './commands/queue'
export * from './commands/record'
export * from './commands/settings'
export * from './commands/update'
export * from './commands/support'
export * from './platform/admin'
export * from './platform/fallback-message'
export * from './platform/qq-markdown-image'
export * from './platform/qq-message'
export * from './render/assets'
export * from './render/course-template'
export * from './render/guess-template'
export * from './render/level-template'
export * from './render/mai-renderer'
export * from './render/nodes'
export * from './render/radar-template'
export * from './render/rating-template'
export * from './render/renderer'
export * from './render/score-template'
export * from './render/theme'
export * from './utils/semaphore'
export * from './utils/strings'
export * from './utils/debug'

export const inject = {
  required: [...INJECTED_SERVICES],
  optional: ['assets'],
}

const noOp = () => undefined

function createDebugTracer(ctx: object, enabled: boolean) {
  const logger = (ctx as { logger?: (name: string) => { info(message: string): void } }).logger
  return new DebugTracer(
    enabled,
    typeof logger === 'function' ? logger.call(ctx, PLUGIN_NAME) : { info: noOp },
  )
}

export interface DefaultLifecycleDependencies {
  initializeDatabaseModels(ctx: Context): Awaitable<void>
  createRenderer(options: TakumiRenderServiceOptions): TakumiRenderService
  createDataSync(options: MaimaiDataSyncOptions): MaimaiDataSyncService
  createCommandDependencies(
    ctx: Context,
    runtime: LifecycleContext,
    services: DefaultCommandServices,
  ): Awaitable<CoreCommandDependencies | null>
}

export interface DefaultCommandServices {
  dataSync: MaimaiDataSyncService
  renderer?: TakumiRenderService
}

interface DefaultRuntimeState {
  renderer?: TakumiRenderService
  dataSync?: MaimaiDataSyncService
  disconnectInvalidation?: () => void
  commandRegistration?: CoreCommandRegistration
  commandDependencies?: CoreCommandDependencies | null
  servicesInitialized?: boolean
  routeRegistration?: { dispose(): void }
  debug?: DebugTracer
}

const defaultRuntimeStates = new WeakMap<object, DefaultRuntimeState>()

const defaultLifecycleDependencies: DefaultLifecycleDependencies = {
  initializeDatabaseModels: ctx => registerMaiDatabaseModels(ctx),
  createRenderer: options => new TakumiRenderService(options),
  createDataSync: options => new MaimaiDataSyncService(options),
  createCommandDependencies: createDefaultCommandDependencies,
}

export async function createDefaultCommandDependencies(
  ctx: Context,
  runtime: LifecycleContext,
  services: DefaultCommandServices,
): Promise<CoreCommandDependencies> {
  if (!services.renderer) {
    throw new Error('[mai-plugin] renderer must be initialized before commands.')
  }
  const logger = ctx.logger(PLUGIN_NAME)
  const debug = new DebugTracer(runtime.config.debugMode, logger)
  debug.event('plugin.services.initialize', {
    config: runtime.config,
    publicBaseUrl: runtime.publicBaseUrl,
  })
  const data = await services.dataSync.startup()
  const repositories = new MaiRepositories(ctx, runtime.config.oauth.tokenCipherKey)
  await repositories.bind.retireImportTokens()
  const divingFishOAuth = new DivingFishOAuth(ctx, runtime.config.divingFishOAuth, repositories.bind, logger)
  const providers = {
    divingFish: new DivingFishProvider({
      ctx,
      config: runtime.config,
      data,
      repositories,
      oauth: divingFishOAuth,
      logger,
      debug,
    }),
    lxns: new LxnsProvider({
      ctx,
      config: runtime.config,
      data,
      repositories,
      logger,
      debug,
    }),
  }
  const providerChain = new ProviderChain({ data, repositories, providers, debug })
  let settingService: SettingService
  settingService = new SettingService(data, repositories, {
    achievementRecords: async (userId, musics) => {
      const qq = await repositories.bind.getQq(userId)
      if (!qq) throw new QqBindingRequiredError({ userId, sessionId: 'settings' })
      const settings = await settingService.getSettings(userId)
      const result = await providerChain.records({
        type: 'qq',
        qq,
        userId,
        isSelf: true,
        provider: settings.provider,
        settings: new PlayerSettings(settings.avatar, settings.plate),
      }, musics)
      return result.response
    },
  })
  const queryService = new QueryService(repositories, {
    providerChain,
    settings: settingService,
  })
  const aliasService = new AliasService(data, repositories)
  const now = () => new Date()
  const queueService = new QueueService(repositories.arcade, { now })
  const ctxServices = ctx as Context & {
    assets?: { transform?: (content: string) => Promise<string> }
  }
  const assets = ctxServices.assets
  const transform = assets?.transform
  const guessService = new GuessService({
    musics: data.musics,
    repository: repositories.guess,
    aliasService,
    renderer: new TakumiGuessRenderer(services.renderer, data),
    send: async (target: GuessTarget, reply: GuessReply) => {
      const bot = ctx.bots.find(candidate => candidate.platform === target.platform)
      if (!bot) {
        throw new Error(`[mai-plugin] no ${target.platform} bot is available to restore guessing game output.`)
      }
      const content = reply.type === 'text'
        ? h.text(reply.text)
        : [h.image(reply.image, 'image/png'), h.text(reply.text)]
      if (target.direct) {
        await bot.sendPrivateMessage(target.userId, content)
      } else {
        await bot.sendMessage(target.channelId, content)
      }
    },
    now,
    random: Math.random,
    logger,
  })
  try {
    await guessService.restore()
  } catch (error) {
    try {
      await guessService.dispose()
    } catch (cleanupError) {
      ctx.logger(PLUGIN_NAME).warn(
        `[mai-plugin] failed to dispose guessing service after restore failure: ${String(cleanupError)}`,
      )
    }
    throw error
  }
  const updateService = new UpdateService({
    publicBaseUrl: runtime.publicBaseUrl,
    oauth: runtime.config.oauth,
    lxns: providers.lxns,
    divingFishOAuth,
    debug,
  })

  return {
    data,
    aliasService,
    queryService,
    settingService,
    bindRepository: repositories.bind,
    queueService,
    updateService,
    guessService,
    settingRepository: repositories.setting,
    renderer: new TakumiMaiRenderer(services.renderer, data, runtime.config.ratingFooterText),
    assetTransformer: typeof transform === 'function'
      ? { transform: content => transform.call(assets, content) }
      : undefined,
    administrators: runtime.config.administrators,
    compatibilityMode: runtime.config.compatibilityMode,
    now,
    random: Math.random,
    async previewAudio(music) {
      try {
        const path = await data.previewPath(music.resourceId)
        if (!path) return null
        const audio = await readFile(path)
        return audio.byteLength ? audio : null
      } catch {
        return null
      }
    },
  }
}

export function getTakumiRenderService(ctx: object) {
  const renderer = defaultRuntimeStates.get(ctx)?.renderer
  if (!renderer) throw new Error('[mai-plugin] renderer service is not initialized')
  return renderer
}

export function getMaimaiDataSyncService(ctx: object) {
  const dataSync = defaultRuntimeStates.get(ctx)?.dataSync
  if (!dataSync) throw new Error('[mai-plugin] data sync service is not initialized')
  return dataSync
}

export function createDefaultLifecycle(
  ctx: Context,
  overrides: Partial<DefaultLifecycleDependencies> = {},
): LifecycleSteps {
  const dependencies = { ...defaultLifecycleDependencies, ...overrides }
  const state = defaultRuntimeStates.get(ctx) ?? {}
  defaultRuntimeStates.set(ctx, state)

  const ensureDebug = (runtime: LifecycleContext) => {
    state.debug ??= createDebugTracer(ctx, runtime.config.debugMode)
    return state.debug
  }

  const ensureDataSync = (runtime: LifecycleContext) => {
    state.dataSync ??= dependencies.createDataSync({
      config: runtime.config.resourceSync,
      lxnsDeveloperToken: runtime.config.developerTokens.lxns,
      logger: ctx.logger(PLUGIN_NAME),
      debug: ensureDebug(runtime),
    })
    return state.dataSync
  }

  const ensureCommandDependencies = async (runtime: LifecycleContext) => {
    if (state.servicesInitialized) return state.commandDependencies ?? null
    try {
      state.commandDependencies = await dependencies.createCommandDependencies(
        ctx,
        runtime,
        {
          dataSync: ensureDataSync(runtime),
          renderer: state.renderer,
        },
      )
      state.servicesInitialized = true
      return state.commandDependencies
    } catch (error) {
      state.commandDependencies = undefined
      state.servicesInitialized = false
      throw error
    }
  }

  return {
    async verifyNativePackages() {
      await Promise.all([
        import('@takumi-rs/wasm/node'),
        import('@takumi-rs/helpers'),
      ])
    },
    initializeDatabaseModels: () => dependencies.initializeDatabaseModels(ctx),
    initializeDataCache(runtime) {
      ensureDataSync(runtime)
    },
    initializeProviders: noOp,
    async initializeRenderer(runtime) {
      const dataSync = ensureDataSync(runtime)
      state.renderer ??= dependencies.createRenderer({
        ...runtime.config.render,
        debug: ensureDebug(runtime),
      })
      await state.renderer.initialize()
      state.disconnectInvalidation ??= connectDataSyncAssetInvalidation(dataSync, state.renderer)
    },
    async initializeServices(runtime) {
      const server = (ctx as Context & { server?: { all?: unknown } }).server
      if (typeof (ctx as Context).command !== 'function' && typeof server?.all !== 'function') return
      await ensureCommandDependencies(runtime)
    },
    async initializeRoutes(runtime) {
      if (state.routeRegistration) return
      const server = (ctx as Context & { server?: { all?: unknown } }).server
      if (typeof server?.all !== 'function') return
      const commandDependencies = await ensureCommandDependencies(runtime)
      if (!commandDependencies?.updateService) return
      state.routeRegistration = registerMaiServerRoutes(ctx, {
        service: commandDependencies.updateService,
        lxnsCallbackPath: runtime.config.oauth.callbackPath,
      })
      if (runtime.config.oauth.enabled) {
        const logger = ctx.logger(PLUGIN_NAME)
        try {
          logger.info(`LXNS OAuth 回调地址：${lxnsCallbackUrl(
            runtime.publicBaseUrl,
            runtime.config.oauth.callbackPath,
          )}`)
        } catch (error) {
          if (!(error instanceof PublicCallbackUnavailableError)) throw error
          logger.warn('LXNS OAuth 已启用，但未配置 publicBaseUrl 或 Koishi Server selfUrl。')
        }
      }
    },
    async initializeCommands(runtime) {
      if (state.commandRegistration) return
      if (typeof (ctx as Context).command !== 'function') return
      const commandDependencies = await ensureCommandDependencies(runtime)
      if (!commandDependencies) return
      state.commandRegistration = registerCoreCommands(ctx, commandDependencies)
    },
    cancelSyncTasks: noOp,
    clearWaitingQueue() {
      state.renderer?.clearWaitingQueue(new Error('[mai-plugin] renderer queue cleared'))
    },
    async releaseCallbackState() {
      const updateService = state.commandDependencies?.updateService
      try {
        await state.commandRegistration?.dispose()
      } finally {
        state.commandRegistration = undefined
        try {
          state.routeRegistration?.dispose()
        } finally {
          state.routeRegistration = undefined
          try {
            updateService?.dispose()
            state.commandDependencies = undefined
            state.servicesInitialized = false
            state.disconnectInvalidation?.()
            state.disconnectInvalidation = undefined
          } finally {
            try {
              await state.renderer?.dispose()
            } finally {
              state.renderer = undefined
              defaultRuntimeStates.delete(ctx)
            }
          }
        }
      }
    },
  }
}

function assertRequiredServices(ctx: PluginContext) {
  for (const service of INJECTED_SERVICES) {
    if (!ctx[service]) {
      throw new Error(`[mai-plugin] required Koishi service "${service}" is unavailable.`)
    }
  }
}

function createCleanup(lifecycle: LifecycleSteps) {
  let cleaned = false

  return async () => {
    if (cleaned) return
    cleaned = true

    const cleanupSteps = [
      () => lifecycle.cancelSyncTasks(),
      () => lifecycle.clearWaitingQueue(),
      () => lifecycle.releaseCallbackState(),
    ]
    const results = await Promise.allSettled(
      cleanupSteps.map(cleanup => Promise.resolve().then(cleanup)),
    )
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length) throw new AggregateError(failures, 'mai-plugin cleanup failed')
  }
}

export async function initializePlugin(
  ctx: PluginContext,
  config: Config,
  lifecycle?: LifecycleSteps,
) {
  assertRequiredServices(ctx)
  const debug = createDebugTracer(ctx, config.debugMode)
  debug.event('plugin.initialize', { config })
  const activeLifecycle = lifecycle ?? createDefaultLifecycle(ctx as Context)

  const runtime: LifecycleContext = {
    config,
    publicBaseUrl: config.publicBaseUrl || ctx.server?.selfUrl || '',
  }
  const cleanup = createCleanup(activeLifecycle)
  ctx.on('dispose', cleanup)

  try {
    await activeLifecycle.verifyNativePackages(runtime)
  } catch {
    await cleanup()
    throw new Error('[mai-plugin] Takumi WASM packages are unavailable. Reinstall @takumi-rs/wasm and @takumi-rs/helpers.')
  }

  try {
    await activeLifecycle.initializeDatabaseModels(runtime)
    await activeLifecycle.initializeDataCache(runtime)
    await activeLifecycle.initializeProviders(runtime)
    await activeLifecycle.initializeRenderer(runtime)
    await activeLifecycle.initializeServices(runtime)
    await activeLifecycle.initializeRoutes(runtime)
    await activeLifecycle.initializeCommands(runtime)
    debug.event('plugin.ready')
  } catch (error) {
    debug.failure('plugin.initialize.failure', error)
    await cleanup()
    throw error
  }
}

export function apply(ctx: Context, config: Config) {
  return initializePlugin(ctx, {
    ...config,
    resourceSync: {
      ...config.resourceSync,
      cacheDir: resolve(ctx.baseDir, config.resourceSync.cacheDir),
    },
  })
}
