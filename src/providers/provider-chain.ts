import type { MaimaiDataStore } from '../data/sync-service'
import type { MaiRepositories } from '../database/repositories'
import { ComboStatus, MusicDifficulty, Rate, SyncStatus } from '../domain/enums'
import { RecordEntry, type MusicInfo } from '../domain/music'
import { PlayerInfo, PlayerSettings, RatingResponse, RecordsResponse } from '../domain/player'
import { Rating } from '../domain/rating'
import {
  ProviderAuthorizationError,
  ProviderAmbiguousTargetError,
  ProviderBindingRequiredError,
  ProviderConfigurationError,
  ProviderConsentScopeError,
  ProviderError,
  findCancellationError,
  ProviderMalformedPayloadError,
  ProviderNoDataError,
  ProviderNotFoundError,
  ProviderOAuthRequiredError,
  ProviderPrivacyError,
  ProviderRateLimitError,
  ProviderScopeError,
  ProviderTimeoutError,
  ProviderTransportError,
  ProviderUnsupportedError,
} from './errors'
import type {
  MaimaiProvider,
  ProviderResult,
  UserQuery,
} from './types'
import type { DebugTracer } from '../utils/debug'

export interface ProviderChainOptions {
  data: MaimaiDataStore
  repositories: MaiRepositories
  providers: {
    divingFish: MaimaiProvider
    lxns: MaimaiProvider
  }
  debug?: DebugTracer
}

const exceptionPriority = [
  ProviderConfigurationError,
  ProviderAmbiguousTargetError,
  ProviderScopeError,
  ProviderConsentScopeError,
  ProviderRateLimitError,
  ProviderPrivacyError,
  ProviderBindingRequiredError,
  ProviderAuthorizationError,
  ProviderOAuthRequiredError,
  ProviderNoDataError,
  ProviderNotFoundError,
  ProviderUnsupportedError,
  ProviderMalformedPayloadError,
  ProviderTimeoutError,
  ProviderTransportError,
] as const

function mergeSettings(
  existing: PlayerSettings | null | undefined,
  override: PlayerSettings | null | undefined,
) {
  if (!override) return existing
  if (!existing) {
    return override.avatar === null && override.plate === null ? null : override
  }
  return new PlayerSettings(
    override.avatar ?? existing.avatar,
    override.plate ?? existing.plate,
  )
}

export class ProviderChain {
  private readonly data: MaimaiDataStore
  private readonly repositories: MaiRepositories
  private readonly providers: ProviderChainOptions['providers']
  private readonly debug?: DebugTracer

  constructor(options: ProviderChainOptions) {
    this.data = options.data
    this.repositories = options.repositories
    this.providers = options.providers
    this.debug = options.debug
  }

  private isVirtual(user: UserQuery) {
    return user.type === 'username'
      && ['maxscore', '理论', '理论值'].includes(user.username.toLocaleLowerCase())
  }

  private theoreticalRecords(musics: Iterable<MusicInfo>) {
    return [...musics]
      .flatMap(music => music.charts)
      .filter(chart => chart.difficulty !== MusicDifficulty.Utage)
      .map(chart => new RecordEntry(
        chart.music,
        chart,
        1_010_000,
        ComboStatus.AllPerfectPlus,
        SyncStatus.FullSyncDeluxePlus,
        chart.maxDeluxeScore,
        Rate.get(1_010_000),
        Rating.calc(chart, 1_010_000),
      ))
      .sort((left, right) => right.rating - left.rating)
  }

  private async selectedProviders(user: UserQuery) {
    const providers = [this.providers.divingFish, this.providers.lxns]
    if (user.provider === 'diving-fish') return [this.providers.divingFish]
    if (user.provider === 'lxns') return [this.providers.lxns]
    if (!user.isSelf || !user.userId) return providers

    const setting = await this.repositories.setting.get(user.userId, 'prober')
    const preferred = setting === 'lxns'
      ? this.providers.lxns
      : setting === 'diving-fish' || setting === 'divingFish'
        ? this.providers.divingFish
        : null
    return preferred
      ? [preferred, ...providers.filter(provider => provider !== preferred)]
      : providers
  }

  private normalizeFailure(provider: MaimaiProvider, user: UserQuery, error: unknown) {
    if (user.type === 'qq' && error instanceof ProviderNotFoundError) {
      return new ProviderBindingRequiredError(provider.id, error.message, error.status)
    }
    if (error instanceof ProviderError) return error
    return new ProviderTransportError(provider.id)
  }

  private selectFailure(failures: ProviderError[]) {
    for (const ErrorType of exceptionPriority) {
      const failure = failures.find(error => error instanceof ErrorType)
      if (failure) return failure
    }
    return failures[0] ?? new ProviderTransportError('diving-fish')
  }

  private async query<T>(
    user: UserQuery,
    operation: (provider: MaimaiProvider) => Promise<T>,
  ): Promise<ProviderResult<T>> {
    const failures: ProviderError[] = []
    for (const provider of await this.selectedProviders(user)) {
      this.debug?.event('provider.chain.attempt', { provider: provider.id, user })
      try {
        const response = await operation(provider)
        this.debug?.event('provider.chain.success', { provider: provider.id, user, response })
        return { response, provider }
      } catch (error) {
        const cancellation = findCancellationError(error)
        if (cancellation) throw cancellation
        const failure = this.normalizeFailure(provider, user, error)
        this.debug?.failure('provider.chain.failure', failure, { provider: provider.id, user })
        failures.push(failure)
      }
    }
    const relevant = !user.isSelf
      ? failures.filter(error => !(error.provider === 'lxns' && error instanceof ProviderOAuthRequiredError))
      : failures
    throw this.selectFailure(relevant.length ? relevant : failures)
  }

  private async virtualProvider(user: UserQuery) {
    return (await this.selectedProviders(user))[0]
  }

  async rating(user: UserQuery) {
    if (this.isVirtual(user)) {
      const scores = this.theoreticalRecords(this.data.musics.values())
      const oldRatingList = scores.filter(record => !record.music.isNew).slice(0, 35)
      const newRatingList = scores.filter(record => record.music.isNew).slice(0, 15)
      const rating = [...oldRatingList, ...newRatingList].reduce((sum, record) => sum + record.rating, 0)
      return {
        response: new RatingResponse(
          new PlayerInfo('理论值', rating, 23),
          user.settings,
          oldRatingList,
          newRatingList,
        ),
        provider: await this.virtualProvider(user),
      }
    }

    const result = await this.query(user, async (provider) => {
      const response = await provider.getPlayerRating(user)
      if (!response.oldRatingList.length && !response.newRatingList.length) {
        throw new ProviderNoDataError(provider.id)
      }
      return response
    })
    result.response.settings = mergeSettings(result.response.settings, user.settings)
    return result
  }

  async record(user: UserQuery, music: MusicInfo) {
    if (this.isVirtual(user)) {
      return {
        response: this.theoreticalRecords([music]),
        provider: await this.virtualProvider(user),
      }
    }
    return this.query(user, provider => provider.getPlayerRecord(user, music))
  }

  async records(user: UserQuery, musics: MusicInfo[]) {
    if (this.isVirtual(user)) {
      const records = this.theoreticalRecords(this.data.musics.values())
      const rating = records
        .filter(record => !record.music.isNew).slice(0, 35)
        .concat(records.filter(record => record.music.isNew).slice(0, 15))
        .reduce((sum, record) => sum + record.rating, 0)
      return {
        response: new RecordsResponse(
          new PlayerInfo('理论值', rating, 23),
          user.settings,
          records,
        ),
        provider: await this.virtualProvider(user),
      }
    }
    const result = await this.query(user, provider => provider.getPlayerRecords(user, musics))
    result.response.settings = mergeSettings(result.response.settings, user.settings)
    return result
  }

  async recent(user: UserQuery) {
    if (this.isVirtual(user)) return this.records(user, [...this.data.musics.values()])
    const result = await this.query(user, (provider) => {
      if (!provider.getPlayerRecent) throw new ProviderUnsupportedError(provider.id)
      return provider.getPlayerRecent(user)
    })
    result.response.settings = mergeSettings(result.response.settings, user.settings)
    return result
  }

  getPlayerRating(user: UserQuery) {
    return this.rating(user)
  }

  getPlayerRecord(user: UserQuery, music: MusicInfo) {
    return this.record(user, music)
  }

  getPlayerRecords(user: UserQuery, musics: MusicInfo[]) {
    return this.records(user, musics)
  }
}
