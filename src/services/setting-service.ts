import type { MaimaiDataStore } from '../data/sync-service'
import type { IconInfo, PlateInfo } from '../data/normalizers'
import type { SettingRepository } from '../database/repositories'
import { MusicDifficulty } from '../domain/enums'
import type { MusicInfo, RecordEntry } from '../domain/music'
import { PlayerSettings, type RecordsResponse } from '../domain/player'
import { filterCharts, filterMusics, filterRecords } from '../query/combo-executor'
import { parseComboQuery } from '../query/combo-parser'
import { toSimplified } from '../utils/strings'
import { normalizeProviderPreference } from './query-service'
import type { ProviderMode } from '../providers/types'

export type DefaultGame = 'maimai' | 'chunithm'

export interface UserSettings {
  provider: ProviderMode
  compatibilityMode: boolean
  avatar: number | null
  plate: number | null
  defaultGame: DefaultGame
}

type SettingRepositoryPort = Pick<SettingRepository, 'get' | 'list' | 'set'>

export interface SettingRepositoriesPort {
  setting: SettingRepositoryPort
}

export type AchievementRecordSource = (
  userId: string,
  musics: MusicInfo[],
) => Promise<readonly RecordEntry[] | RecordsResponse>

export interface SettingServiceOptions {
  achievementRecords?: AchievementRecordSource
}

export class InvalidSettingError extends Error {
  constructor(readonly setting: string, readonly value: unknown) {
    super(`Invalid ${setting} setting.`)
    this.name = 'InvalidSettingError'
  }
}

export class PlateNotAcquiredError extends Error {
  constructor(readonly plate: PlateInfo) {
    super('The user has not met this achievement plate acquisition condition.')
    this.name = 'PlateNotAcquiredError'
  }
}

function normalizedCollectionValue(value: string) {
  return toSimplified(value.trim()).toLocaleLowerCase()
}

function matchesCollection(
  collection: Pick<IconInfo, 'id' | 'filename' | 'name'>,
  requested: string,
) {
  const normalized = normalizedCollectionValue(requested)
  const filename = collection.filename.trim()
  return String(collection.id) === requested.trim()
    || normalizedCollectionValue(collection.name) === normalized
    || normalizedCollectionValue(filename) === normalized
    || normalizedCollectionValue(filename.replace(/\.[^.]+$/, '')) === normalized
}

function validDefaultGame(value: string | null | undefined): DefaultGame {
  return value === 'chunithm' ? 'chunithm' : 'maimai'
}

function collectionId<T>(value: string | undefined, collections: ReadonlyMap<number, T>) {
  if (!value || !/^\d+$/.test(value.trim())) return null
  const id = Number(value)
  return Number.isSafeInteger(id) && collections.has(id) ? id : null
}

function recordsFromResult(
  result: readonly RecordEntry[] | RecordsResponse,
): readonly RecordEntry[] {
  return Array.isArray(result) ? result : (result as RecordsResponse).records
}

function chartKey(record: RecordEntry) {
  return `${record.music.id}:${record.chart.difficulty.value}`
}

export class SettingService {
  private readonly achievementRecords?: AchievementRecordSource

  constructor(
    private readonly data: Pick<MaimaiDataStore, 'icons' | 'plates' | 'musics'>,
    private readonly repositories: SettingRepositoriesPort,
    options: SettingServiceOptions = {},
  ) {
    this.achievementRecords = options.achievementRecords
  }

  async getSettings(userId: string): Promise<UserSettings> {
    const stored = await this.repositories.setting.list(userId)
    return {
      provider: normalizeProviderPreference(stored.prober),
      compatibilityMode: stored['text-mode'] === '1',
      avatar: collectionId(stored.icon, this.data.icons),
      plate: collectionId(stored.plate, this.data.plates),
      defaultGame: validDefaultGame(stored['game-prior']),
    }
  }

  async getPlayerSettings(userId: string) {
    const settings = await this.getSettings(userId)
    return new PlayerSettings(settings.avatar, settings.plate)
  }

  async getProviderPreference(userId: string) {
    return (await this.getSettings(userId)).provider
  }

  async isCompatibilityMode(userId: string) {
    return (await this.getSettings(userId)).compatibilityMode
  }

  async getDefaultGame(userId: string) {
    return (await this.getSettings(userId)).defaultGame
  }

  async setProviderPreference(userId: string, provider: ProviderMode) {
    if (!['auto', 'diving-fish', 'lxns'].includes(provider)) {
      throw new InvalidSettingError('provider', provider)
    }
    await this.repositories.setting.set(userId, 'prober', provider)
    return provider
  }

  async setCompatibilityMode(userId: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new InvalidSettingError('compatibility mode', enabled)
    await this.repositories.setting.set(userId, 'text-mode', enabled ? '1' : '0')
    return enabled
  }

  async setAvatar(userId: string, requested: string | number | null) {
    if (requested === null || String(requested).trim() === '') {
      await this.repositories.setting.set(userId, 'icon', '')
      return null
    }
    const icon = [...this.data.icons.values()].find(value => (
      matchesCollection(value, String(requested))
    ))
    if (!icon) throw new InvalidSettingError('avatar', requested)
    await this.repositories.setting.set(userId, 'icon', String(icon.id))
    return icon
  }

  async setPlate(userId: string, requested: string | number | null) {
    if (requested === null || String(requested).trim() === '') {
      await this.repositories.setting.set(userId, 'plate', '')
      return null
    }
    const plate = [...this.data.plates.values()].find(value => (
      matchesCollection(value, String(requested))
    ))
    if (!plate) throw new InvalidSettingError('plate', requested)
    if (plate.genre === '実績' && plate.requires.length) {
      await this.assertPlateAcquired(userId, plate)
    }
    await this.repositories.setting.set(userId, 'plate', String(plate.id))
    return plate
  }

  async setDefaultGame(userId: string, game: DefaultGame) {
    if (game !== 'maimai' && game !== 'chunithm') {
      throw new InvalidSettingError('default game', game)
    }
    await this.repositories.setting.set(userId, 'game-prior', game)
    return game
  }

  private async assertPlateAcquired(userId: string, plate: PlateInfo) {
    if (!this.achievementRecords) throw new PlateNotAcquiredError(plate)
    const filters = parseComboQuery(plate.name, { data: this.data as MaimaiDataStore })
    if (!filters) throw new PlateNotAcquiredError(plate)
    const musics = [...this.data.musics.values()]
    const requiredCharts = filterCharts(filters, musics)
      .filter(chart => chart.difficulty.value >= MusicDifficulty.Master.value)
    const requiredMusics = filterMusics(filters, musics)
    if (!requiredCharts.length || !requiredMusics.length) throw new PlateNotAcquiredError(plate)
    const response = await this.achievementRecords(userId, requiredMusics)
    const eligibleRecords = recordsFromResult(response)
      .filter(record => record.chart.difficulty.value >= MusicDifficulty.Master.value)
    const acquiredRecords = filterRecords(filters, eligibleRecords, true)
    if (!acquiredRecords) throw new PlateNotAcquiredError(plate)

    const acquired = new Set(acquiredRecords.map(chartKey))
    const complete = requiredCharts.every(chart => (
      acquired.has(`${chart.music.id}:${chart.difficulty.value}`)
    ))
    if (!complete) throw new PlateNotAcquiredError(plate)
  }
}
