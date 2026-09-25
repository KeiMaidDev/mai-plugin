import { readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Config } from '../config'
import type { GameVersion, MusicInfo } from '../domain/music'
import { resolvePackageAssetPath } from '../render/assets'
import type { DebugTracer } from '../utils/debug'
import { RemoteAliasCache, type RemoteAliases } from './alias-cache'
import { CacheStore, type CachedSnapshot } from './cache-store'
import { LxnsAssetCache } from './lxns-assets'
import { inspectFile, parseResourceManifest, sha256, type ResourceManifest, type ResourceManifestFile } from './manifest'
import {
  normalizeMaimaiSource,
  extractDivingFishChartMetadata,
  parseDivingFishChartMetadata,
  type DivingFishChartMetadata,
  type CourseInfo,
  type IconInfo,
  type NormalizedMaimaiSource,
  type PlateInfo,
} from './normalizers'

const DEFAULT_PROBER_DATA_URL = 'https://www.diving-fish.com/api/maimaidxprober/music_data'
const DEFAULT_PROBER_CHART_STATS_URL = 'https://www.diving-fish.com/api/maimaidxprober/chart_stats'
const LXNS_SONG_LIST_URL = 'https://maimai.lxns.net/api/v0/maimai/song/list'
const LXNS_ICON_LIST_URL = 'https://maimai.lxns.net/api/v0/maimai/icon/list'
const LXNS_PLATE_LIST_URL = 'https://maimai.lxns.net/api/v0/maimai/plate/list'
const FALLBACK_COVER = resolvePackageAssetPath('fallback/cover.png')
const FALLBACK_AVATAR = resolvePackageAssetPath('fallback/avatar.png')
const FALLBACK_PLATE = resolvePackageAssetPath('fallback/plate.png')

const BUILTIN_SOURCE = {
  revision: 'builtin-minimal-v1',
  versions: [{ id: 0, name: 'maimai', version: 0 }],
  musics: [{
    id: 1,
    name: 'maimai',
    type: 'SD',
    rights: '',
    artist: '',
    genre: 'maimai',
    bpm: 0,
    version: 'maimai',
    isNew: false,
    charts: [{
      difficulty: 0,
      level: '1',
      levelValue: 1,
      notes: [0, 0, 0, 0],
      notesDesigner: '',
    }],
  }],
  plates: [],
  icons: [],
  courses: [],
} as const

export interface DataSyncLogger {
  warn(message: string): void
}

export interface MaimaiDataSyncOptions {
  config: Config['resourceSync']
  lxnsDeveloperToken?: string
  fetch?: typeof fetch
  logger?: DataSyncLogger
  proberDataUrl?: string
  proberChartStatsUrl?: string
  builtinSource?: unknown | null
  debug?: DebugTracer
  now?: () => Date
}

export interface MaimaiAssetInvalidationEvent {
  revision: string
  paths: readonly string[]
}

export type MaimaiAssetInvalidationListener = (event: MaimaiAssetInvalidationEvent) => void

export interface MaimaiAssetInvalidationSource {
  onAssetInvalidation(listener: MaimaiAssetInvalidationListener): () => void
}

export class MissingMaimaiDataError extends Error {
  constructor(readonly missing: string[], causes: unknown[] = []) {
    const details = causes.length
      ? ` (${causes.map(error => error instanceof Error ? error.message : String(error)).join('; ')})`
      : ''
    super(`[mai-plugin] missing minimum data: ${missing.join(', ')}${details}`)
    this.name = 'MissingMaimaiDataError'
  }
}

function resourceIdFromPath(path: string) {
  const match = basename(path).match(/^(\d+)\.[^.]+$/i)
  return match ? Number(match[1]) : undefined
}

export class MaimaiDataStore {
  readonly versions: Map<string, GameVersion>
  readonly musics: Map<number, MusicInfo>
  readonly plates: Map<number, PlateInfo>
  readonly icons: Map<number, IconInfo>
  readonly courses: Map<number, CourseInfo>
  private readonly covers = new Map<number, string>()
  private readonly avatars = new Map<number, string>()
  private readonly plateImages = new Map<number, string>()
  private _remoteAliases: RemoteAliases = new Map()
  readonly assetPaths: readonly string[]

  constructor(
    data: NormalizedMaimaiSource,
    readonly manifest: ResourceManifest,
    files: Map<string, string>,
    private readonly remoteAssets?: LxnsAssetCache,
  ) {
    this.assetPaths = Object.freeze([...files.values()])
    this.versions = data.versions
    this.musics = data.musics
    this.plates = data.plates
    this.icons = data.icons
    this.courses = data.courses
    for (const [relativePath, absolutePath] of files) {
      const normalized = relativePath.replaceAll('\\', '/')
      const id = resourceIdFromPath(normalized)
      if (id === undefined) continue
      if (/\/covers\/\d+\.(?:png|jpe?g|webp)$/i.test(normalized)) this.covers.set(id, absolutePath)
      else if (/\/(?:avatars|icons)\/\d+\.(?:png|jpe?g|webp)$/i.test(normalized)) this.avatars.set(id, absolutePath)
      else if (/\/plates\/\d+\.(?:png|jpe?g|webp)$/i.test(normalized)) this.plateImages.set(id, absolutePath)
    }
  }

  coverPath(resourceId: number) {
    const local = this.covers.get(resourceId)
    if (local) return local
    const remote = this.remoteAssets?.resolve('jacket', resourceId, FALLBACK_COVER)
    return remote ? remote.then(path => path ?? FALLBACK_COVER) : FALLBACK_COVER
  }

  iconPath(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) return FALLBACK_AVATAR
    const local = this.avatars.get(id)
    if (local) return local
    const remote = this.remoteAssets?.resolve('icon', id, FALLBACK_AVATAR)
    return remote ? remote.then(path => path ?? FALLBACK_AVATAR) : FALLBACK_AVATAR
  }

  avatarPath(id: number) {
    return this.iconPath(id)
  }

  platePath(id: number) {
    if (!Number.isSafeInteger(id) || id < 1) return FALLBACK_PLATE
    const local = this.plateImages.get(id)
    if (local) return local
    const remote = this.remoteAssets?.resolve('plate', id, FALLBACK_PLATE)
    return remote ? remote.then(path => path ?? FALLBACK_PLATE) : FALLBACK_PLATE
  }

  previewPath(resourceId: number) {
    return this.remoteAssets?.resolve('music', resourceId)
  }

  get remoteAliases(): RemoteAliases {
    return this._remoteAliases
  }

  setRemoteAliases(aliases: RemoteAliases) {
    this._remoteAliases = aliases
  }
}

function createRemoteUrlValidator(allowedHosts: string[]) {
  const allowed = new Set([
    'maimai.lxns.net',
    'www.diving-fish.com',
    ...allowedHosts.map(host => host.toLowerCase()),
  ])
  return (url: URL) => {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`Unsupported resource source protocol: ${url.protocol}`)
    }
    if (url.username || url.password) throw new Error('Remote resource URLs cannot contain credentials')
    if (!allowed.has(url.hostname.toLowerCase())) {
      throw new Error(`Remote resource host ${url.hostname} is not allowed`)
    }
  }
}

function ensureBaseUrl(value: string, validateUrl: (url: URL) => void) {
  const url = new URL(value)
  validateUrl(url)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return url
}

function mergeChartMetadata(
  current: DivingFishChartMetadata[],
  cached: DivingFishChartMetadata[],
) {
  const cachedByMusic = new Map(cached.map(entry => [entry.musicId, entry]))
  const merged = current.map(entry => {
    const cachedEntry = cachedByMusic.get(entry.musicId)
    const charts = entry.charts.map(chart => {
      if (chart.fitLevelValue) return chart
      const fallback = cachedEntry?.charts.find(candidate => (
        candidate.difficulty === chart.difficulty
      ))
      return fallback?.fitLevelValue
        ? { ...chart, fitLevelValue: fallback.fitLevelValue }
        : chart
    })
    const currentDifficulties = new Set(charts.map(chart => chart.difficulty))
    return {
      ...entry,
      charts: [
        ...charts,
        ...(cachedEntry?.charts.filter(chart => !currentDifficulties.has(chart.difficulty)) ?? []),
      ],
    }
  })
  const currentIds = new Set(merged.map(entry => entry.musicId))
  return [...merged, ...cached.filter(entry => !currentIds.has(entry.musicId))]
}

export class MaimaiDataSyncService implements MaimaiAssetInvalidationSource {
  private readonly logger: DataSyncLogger
  private readonly cache: CacheStore
  private readonly proberDataUrl: string
  private readonly proberChartStatsUrl: string
  private readonly builtinSource: unknown | null
  private readonly validateRemoteUrl: (url: URL) => void
  private readonly assets: LxnsAssetCache
  private readonly aliases: RemoteAliasCache
  private readonly assetInvalidationListeners = new Set<MaimaiAssetInvalidationListener>()
  private publishedAssetPaths = new Set<string>()

  constructor(private readonly options: MaimaiDataSyncOptions) {
    this.logger = options.logger ?? console
    this.cache = new CacheStore(options.config.cacheDir, options.fetch ?? fetch)
    this.assets = new LxnsAssetCache({
      cacheDir: options.config.cacheDir,
      timeoutMs: options.config.timeoutMs,
      fetch: options.fetch,
      logger: this.logger,
      debug: options.debug,
    })
    this.aliases = new RemoteAliasCache({
      cacheDir: options.config.cacheDir,
      timeoutMs: options.config.timeoutMs,
      fetch: options.fetch,
      logger: this.logger,
      debug: options.debug,
      now: options.now,
    })
    this.proberDataUrl = options.proberDataUrl === undefined ? DEFAULT_PROBER_DATA_URL : options.proberDataUrl
    this.proberChartStatsUrl = options.proberChartStatsUrl === undefined
      ? DEFAULT_PROBER_CHART_STATS_URL
      : options.proberChartStatsUrl
    this.builtinSource = options.builtinSource === undefined ? BUILTIN_SOURCE : options.builtinSource
    this.validateRemoteUrl = createRemoteUrlValidator(options.config.allowedHosts)
  }

  onAssetInvalidation(listener: MaimaiAssetInvalidationListener): () => void {
    this.assetInvalidationListeners.add(listener)
    return () => {
      this.assetInvalidationListeners.delete(listener)
    }
  }

  private async complete(store: MaimaiDataStore) {
    store.setRemoteAliases(await this.aliases.startup(store.musics))
    const currentPaths = new Set(store.assetPaths)
    const affectedPaths = Object.freeze([...new Set([
      ...this.publishedAssetPaths,
      ...currentPaths,
    ])])
    this.publishedAssetPaths = currentPaths
    if (affectedPaths.length) {
      const event = Object.freeze({
        revision: store.manifest.revision,
        paths: affectedPaths,
      })
      for (const listener of this.assetInvalidationListeners) listener(event)
    }
    return store
  }

  private async storeFromCache(snapshot?: CachedSnapshot) {
    const loaded = snapshot ?? await this.cache.loadSnapshot()
    const source = JSON.parse(await readFile(loaded.sourcePath, 'utf8'))
    const data = normalizeMaimaiSource(source, { revision: loaded.manifest.revision })
    return new MaimaiDataStore(data, loaded.manifest, loaded.files, this.assets)
  }

  private async syncLxnsSource() {
    const token = this.options.lxnsDeveloperToken?.trim()
    if (!token) throw new Error('LXNS developer token is unavailable')
    const staging = await this.cache.createStagingDirectory()
    try {
      const requests = [
        ['songs.json', LXNS_SONG_LIST_URL],
        ['icons.json', LXNS_ICON_LIST_URL],
        ['plates.json', LXNS_PLATE_LIST_URL],
      ] as const
      await Promise.all(requests.map(([filename, url]) => this.cache.downloadComputed(
        url,
        join(staging, filename),
        {
          timeoutMs: this.options.config.timeoutMs,
          maxBytes: 32 * 1024 * 1024,
          validateUrl: this.validateRemoteUrl,
          headers: { Authorization: token },
        },
      )))
      const [songs, icons, plates] = await Promise.all(requests.map(([filename]) => (
        readFile(join(staging, filename), 'utf8').then(JSON.parse)
      )))
      const chartMetadata = await this.syncChartMetadata(staging)
      const source = {
        sourceType: 'lxns',
        ...songs,
        icons: icons.icons,
        plates: plates.plates,
        chartMetadata,
      }
      const serialized = `${JSON.stringify(source)}\n`
      const revision = `lxns-${sha256(serialized).slice(0, 16)}`
      const persisted = { ...source, revision }
      normalizeMaimaiSource(persisted, { revision })
      const sourcePath = join(staging, 'source.json')
      const metadata = await this.cache.writeAtomic(sourcePath, `${JSON.stringify(persisted)}\n`)
      await Promise.all(requests.map(([filename]) => rm(join(staging, filename), { force: true })))
      await this.cache.commitSnapshot(staging, revision, {
        'source.json': { ...metadata, source: LXNS_SONG_LIST_URL },
      })
      return this.storeFromCache()
    } catch (error) {
      await this.cache.discardStagingDirectory(staging)
      throw error
    }
  }

  private async cachedChartMetadata() {
    try {
      const cached = await this.cache.loadSnapshot()
      const source = JSON.parse(await readFile(cached.sourcePath, 'utf8'))
      if (Array.isArray(source)) return extractDivingFishChartMetadata(source)
      if (source && typeof source === 'object' && Array.isArray(source.chartMetadata)) {
        return parseDivingFishChartMetadata(source.chartMetadata)
      }
    } catch {
      // A missing or incompatible snapshot simply means there is no metadata fallback yet.
    }
    return []
  }

  private async syncChartMetadata(staging: string) {
    if (!this.proberDataUrl) return this.cachedChartMetadata()
    const target = join(staging, 'chart-metadata-source.json')
    const statsTarget = join(staging, 'chart-metadata-stats.json')
    try {
      const startedAt = Date.now()
      this.options.debug?.event('data.chart-metadata.start', { source: 'diving-fish' })
      await this.cache.downloadComputed(this.proberDataUrl, target, {
        timeoutMs: this.options.config.timeoutMs,
        maxBytes: 32 * 1024 * 1024,
        validateUrl: this.validateRemoteUrl,
      })
      let chartStats: unknown
      if (this.proberChartStatsUrl) {
        try {
          await this.cache.downloadComputed(this.proberChartStatsUrl, statsTarget, {
            timeoutMs: this.options.config.timeoutMs,
            maxBytes: 32 * 1024 * 1024,
            validateUrl: this.validateRemoteUrl,
          })
          chartStats = JSON.parse(await readFile(statsTarget, 'utf8'))
        } catch (error) {
          this.options.debug?.failure('data.chart-stats.failure', error, {
            source: 'diving-fish',
          })
        }
      }
      const cached = await this.cachedChartMetadata()
      const metadata = mergeChartMetadata(
        extractDivingFishChartMetadata(
          JSON.parse(await readFile(target, 'utf8')),
          chartStats,
        ),
        cached,
      )
      if (!metadata.length) throw new Error('Diving Fish chart metadata is empty')
      this.options.debug?.event('data.chart-metadata.success', {
        source: 'diving-fish',
        musics: metadata.length,
        charts: metadata.reduce((sum, music) => sum + music.charts.length, 0),
        fitLevels: metadata.reduce((sum, music) => (
          sum + music.charts.filter(chart => chart.fitLevelValue > 0).length
        ), 0),
        durationMs: Date.now() - startedAt,
      })
      return metadata
    } catch (error) {
      this.options.debug?.failure('data.chart-metadata.failure', error, {
        source: 'diving-fish',
      })
      const cached = await this.cachedChartMetadata()
      if (cached.length) {
        this.options.debug?.event('data.chart-metadata.cache', {
          musics: cached.length,
        })
      }
      return cached
    } finally {
      await Promise.all([
        rm(target, { force: true }),
        rm(statsTarget, { force: true }),
      ])
    }
  }

  private async syncStaticSource() {
    const baseUrl = ensureBaseUrl(this.options.config.staticBaseUrl, this.validateRemoteUrl)
    const staging = await this.cache.createStagingDirectory()
    try {
      const remoteManifestPath = join(staging, '.remote-manifest.json')
      await this.cache.downloadComputed(
        new URL('manifest.json', baseUrl).href,
        remoteManifestPath,
        {
          timeoutMs: this.options.config.timeoutMs,
          maxBytes: 32 * 1024 * 1024,
          validateUrl: this.validateRemoteUrl,
        },
      )
      const remoteManifest = parseResourceManifest(JSON.parse(await readFile(remoteManifestPath, 'utf8')))
      await rm(remoteManifestPath, { force: true })
      if (!Object.keys(remoteManifest.files).includes('source.json')) {
        throw new Error('Static resource manifest is missing source.json')
      }
      const files: Record<string, ResourceManifestFile> = {}
      for (const [relativePath, metadata] of Object.entries(remoteManifest.files)) {
        await this.cache.downloadVerified(
          new URL(relativePath, baseUrl).href,
          join(staging, relativePath),
          metadata,
          {
            timeoutMs: this.options.config.timeoutMs,
            validateUrl: this.validateRemoteUrl,
          },
        )
        files[relativePath] = { ...metadata, source: metadata.source || baseUrl.href }
      }
      normalizeMaimaiSource(JSON.parse(await readFile(join(staging, 'source.json'), 'utf8')), {
        revision: remoteManifest.revision,
      })
      await this.cache.commitSnapshot(staging, remoteManifest.revision, files)
      return this.storeFromCache()
    } catch (error) {
      await this.cache.discardStagingDirectory(staging)
      throw error
    }
  }

  private async syncProberSource() {
    const staging = await this.cache.createStagingDirectory()
    try {
      const rawSourcePath = join(staging, 'diving-fish-music-data.json')
      const sourcePath = join(staging, 'source.json')
      await this.cache.downloadComputed(
        this.proberDataUrl,
        rawSourcePath,
        {
          timeoutMs: this.options.config.timeoutMs,
          maxBytes: 32 * 1024 * 1024,
          validateUrl: this.validateRemoteUrl,
        },
      )
      const musicData = JSON.parse(await readFile(rawSourcePath, 'utf8'))
      const statsPath = join(staging, 'diving-fish-chart-stats.json')
      let chartStats: unknown
      if (this.proberChartStatsUrl) {
        try {
          await this.cache.downloadComputed(this.proberChartStatsUrl, statsPath, {
            timeoutMs: this.options.config.timeoutMs,
            maxBytes: 32 * 1024 * 1024,
            validateUrl: this.validateRemoteUrl,
          })
          chartStats = JSON.parse(await readFile(statsPath, 'utf8'))
        } catch (error) {
          this.options.debug?.failure('data.chart-stats.failure', error, {
            source: 'diving-fish',
          })
        }
      }
      const chartMetadata = mergeChartMetadata(
        extractDivingFishChartMetadata(musicData, chartStats),
        await this.cachedChartMetadata(),
      )
      const payload = {
        sourceType: 'diving-fish',
        musicData,
        chartMetadata,
      }
      const serialized = `${JSON.stringify(payload)}\n`
      const revision = `diving-fish-${sha256(serialized).slice(0, 16)}`
      const source = { ...payload, revision }
      const data = normalizeMaimaiSource(source)
      const metadata = await this.cache.writeAtomic(sourcePath, `${JSON.stringify(source)}\n`)
      await Promise.all([
        rm(rawSourcePath, { force: true }),
        rm(statsPath, { force: true }),
      ])
      await this.cache.commitSnapshot(staging, data.revision, {
        'source.json': { ...metadata, source: this.proberDataUrl },
      })
      return this.storeFromCache()
    } catch (error) {
      await this.cache.discardStagingDirectory(staging)
      throw error
    }
  }

  private async storeBuiltinSource() {
    if (this.builtinSource === null) throw new MissingMaimaiDataError(['versions', 'musics'])
    const data = normalizeMaimaiSource(this.builtinSource)
    const staging = await this.cache.createStagingDirectory()
    try {
      const sourcePath = join(staging, 'source.json')
      const metadata = await this.cache.writeAtomic(sourcePath, `${JSON.stringify(this.builtinSource, null, 2)}\n`)
      await this.cache.commitSnapshot(staging, data.revision, {
        'source.json': { ...metadata, source: 'builtin' },
      })
      return this.storeFromCache()
    } catch (error) {
      await this.cache.discardStagingDirectory(staging)
      throw error
    }
  }

  private async attemptSource(name: string, operation: () => Promise<MaimaiDataStore>) {
    const startedAt = Date.now()
    this.options.debug?.event('data.source.start', { source: name })
    try {
      const store = await operation()
      this.options.debug?.event('data.source.success', {
        source: name,
        durationMs: Date.now() - startedAt,
        revision: store.manifest.revision,
        musics: store.musics.size,
        icons: store.icons.size,
        plates: store.plates.size,
      })
      return store
    } catch (error) {
      this.options.debug?.failure('data.source.failure', error, {
        source: name,
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }

  async startup() {
    const remoteErrors: unknown[] = []
    if (this.options.config.enabled) {
      try {
        return await this.complete(await this.attemptSource('lxns', () => this.syncLxnsSource()))
      } catch (error) {
        remoteErrors.push(error)
      }
      if (this.proberDataUrl) {
        try {
          const store = await this.attemptSource('diving-fish', () => this.syncProberSource())
          if (remoteErrors.length) {
            this.logger.warn('落雪查分器未配置，将使用水鱼查分器')
          }
          return await this.complete(store)
        } catch (error) {
          remoteErrors.push(error)
        }
      }
      if (this.options.config.staticBaseUrl) {
        try {
          return await this.complete(await this.attemptSource('static', () => this.syncStaticSource()))
        } catch (error) {
          remoteErrors.push(error)
        }
      }
    }

    try {
      const cached = await this.cache.loadSnapshot()
      this.options.debug?.event('data.source.cache', { revision: cached.manifest.revision })
      if (remoteErrors.length) {
        this.logger.warn(`资源同步失败，使用缓存版本 ${cached.manifest.revision}`)
      }
      return await this.complete(await this.storeFromCache(cached))
    } catch (cacheError) {
      try {
        const store = await this.storeBuiltinSource()
        this.options.debug?.event('data.source.builtin', { revision: store.manifest.revision })
        if (remoteErrors.length) {
          this.logger.warn('资源不可用，使用内置最小数据')
        }
        return await this.complete(store)
      } catch (builtinError) {
        throw new MissingMaimaiDataError(
          ['versions', 'musics'],
          [...remoteErrors, cacheError, builtinError],
        )
      }
    }
  }
}
