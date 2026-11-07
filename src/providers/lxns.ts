import type { MaimaiDataStore } from '../data/sync-service'
import type { MaiRepositories } from '../database/repositories'
import { ComboStatus, MusicGenre, Rate, SyncStatus } from '../domain/enums'
import { RecordEntry, type MusicInfo } from '../domain/music'
import type { LXNSCollection, LXNSPlayer, LXNSScore } from '../domain/payloads'
import { normalizeLxnsMusicId, toInternalAchievement } from '../domain/payloads'
import { PlayerInfo, PlayerSettings, RatingResponse, RecordsResponse } from '../domain/player'
import { Rating } from '../domain/rating'
import type { Config } from '../config'
import type { DebugTracer } from '../utils/debug'
import {
  ProviderMalformedPayloadError,
  ProviderNoDataError,
  ProviderOAuthRequiredError,
  ProviderRateLimitError,
  providerResponseError,
} from './errors'
import {
  ProviderHttpClient,
  type MaimaiProvider,
  type ProviderOptions,
  type UserQuery,
} from './types'

export const LXNS_ENDPOINTS = {
  maimai: 'https://maimai.lxns.net/api/v0/maimai',
  oauth: 'https://maimai.lxns.net/api/v0/oauth',
  user: 'https://maimai.lxns.net/api/v0/user',
  oauthToken: 'https://maimai.lxns.net/api/v0/oauth/token',
} as const

export const LXNS_OAUTH_EXPIRY_SKEW_MS = 30_000

interface LxnsEnvelope {
  success: boolean
  code: number
  message: string | null
  data: unknown
}

interface LxnsOAuthToken {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

export interface LxnsProviderOptions extends ProviderOptions {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

function optionalString(value: unknown) {
  return value === undefined || value === null || typeof value === 'string'
}

function optionalBoolean(value: unknown) {
  return value === undefined || value === null || typeof value === 'boolean'
}

function optionalSafeIntegerArray(value: unknown) {
  return value === undefined || value === null
    || (Array.isArray(value) && value.every(isSafeInteger))
}

function parseEnvelope(value: unknown): LxnsEnvelope {
  if (!isObject(value)
    || typeof value.success !== 'boolean'
    || !isSafeInteger(value.code)
    || (value.message !== undefined && value.message !== null && typeof value.message !== 'string')) {
    throw new ProviderMalformedPayloadError('lxns', 'LXNS response envelope is malformed.')
  }
  return {
    success: value.success,
    code: value.code,
    message: value.message as string | null | undefined ?? null,
    data: value.data,
  }
}

function validCollectionSong(value: unknown) {
  return isObject(value)
    && isSafeInteger(value.id)
    && typeof value.title === 'string'
    && typeof value.type === 'string'
    && optionalBoolean(value.completed)
    && optionalSafeIntegerArray(value.completed_difficulties)
}

function validCollectionRequired(value: unknown) {
  return isObject(value)
    && optionalSafeIntegerArray(value.difficulties)
    && optionalString(value.rate)
    && optionalString(value.fc)
    && optionalString(value.fs)
    && (value.songs === undefined || value.songs === null
      || (Array.isArray(value.songs) && value.songs.every(validCollectionSong)))
    && optionalBoolean(value.completed)
}

function parseCollection(value: unknown): LXNSCollection | null | undefined {
  if (value === undefined || value === null) return value
  if (!isObject(value)
    || !isSafeInteger(value.id)
    || typeof value.name !== 'string'
    || !optionalString(value.color)
    || !optionalString(value.description)
    || !optionalString(value.genre)
    || (value.required !== undefined && value.required !== null
      && (!Array.isArray(value.required) || !value.required.every(validCollectionRequired)))) {
    throw new ProviderMalformedPayloadError('lxns', 'LXNS collection payload is malformed.')
  }
  return value as unknown as LXNSCollection
}

function parsePlayer(value: unknown): LXNSPlayer {
  if (!isObject(value)
    || typeof value.name !== 'string'
    || !isSafeInteger(value.rating)
    || !isSafeInteger(value.friend_code)
    || !isSafeInteger(value.course_rank)
    || !isSafeInteger(value.class_rank)
    || !isSafeInteger(value.star)) {
    throw new ProviderMalformedPayloadError('lxns', 'LXNS player payload is malformed.')
  }
  parseCollection(value.icon)
  parseCollection(value.name_plate)
  parseCollection(value.frame)
  return value as unknown as LXNSPlayer
}

function parseScore(value: unknown): LXNSScore {
  if (!isObject(value)
    || !isSafeInteger(value.id)
    || !isSafeInteger(value.level_index)
    || !isFiniteNumber(value.achievements)
    || (value.fc !== undefined && value.fc !== null && typeof value.fc !== 'string')
    || (value.fs !== undefined && value.fs !== null && typeof value.fs !== 'string')
    || !isSafeInteger(value.dx_score)
    || typeof value.type !== 'string'
    || !optionalString(value.play_time)
    || !optionalString(value.upload_time)
    || !optionalString(value.last_played_time)) {
    throw new ProviderMalformedPayloadError('lxns', 'LXNS score payload is malformed.')
  }
  return value as unknown as LXNSScore
}

function parseScores(value: unknown) {
  if (!Array.isArray(value)) throw new ProviderMalformedPayloadError('lxns', 'LXNS score list is malformed.')
  return value.map(parseScore)
}

function parseOAuthToken(value: unknown): LxnsOAuthToken {
  if (!isObject(value)
    || typeof value.access_token !== 'string'
    || typeof value.token_type !== 'string'
    || !isSafeInteger(value.expires_in)
    || value.expires_in < 0
    || typeof value.refresh_token !== 'string'
    || typeof value.scope !== 'string') {
    throw new ProviderMalformedPayloadError('lxns', 'LXNS OAuth token payload is malformed.')
  }
  return value as unknown as LxnsOAuthToken
}

export class LxnsProvider implements MaimaiProvider {
  readonly id = 'lxns' as const
  readonly name = 'LXNS'
  private readonly http: ProviderHttpClient
  private readonly config: Config
  private readonly data: MaimaiDataStore
  private readonly repositories: MaiRepositories
  private readonly now: () => Date
  private readonly debug?: DebugTracer

  constructor(options: LxnsProviderOptions) {
    this.config = options.config
    this.data = options.data
    this.repositories = options.repositories
    this.now = options.now ?? (() => new Date())
    this.debug = options.debug
    this.http = new ProviderHttpClient(this.id, options.ctx, options.logger, options)
  }

  private async unwrap(response: { status: number; data: unknown }, noDataMessage?: string) {
    if (response.status < 200 || response.status >= 300) {
      throw providerResponseError(this.id, response.status, response.data)
    }
    const envelope = parseEnvelope(response.data)
    if (!envelope.success || envelope.code !== 200) {
      throw providerResponseError(this.id, envelope.code, { message: envelope.message })
    }
    if (envelope.data === null || envelope.data === undefined) {
      throw new ProviderNoDataError(this.id, envelope.message || noDataMessage)
    }
    return envelope.data
  }

  private oauthFailure(status: number, body: unknown) {
    if (isObject(body) && typeof body.error === 'string') {
      const description = typeof body.error_description === 'string'
        ? body.error_description
        : body.error
      return new ProviderOAuthRequiredError(this.id, description, status)
    }
    return providerResponseError(this.id, status, body)
  }

  private requireOAuthUserId(user: UserQuery) {
    if (!user.isSelf || !user.userId) {
      throw new ProviderOAuthRequiredError(
        this.id,
        'LXNS player data is only available through OAuth for the current user.',
      )
    }
    return user.userId
  }

  private async oauthUserRequest(user: UserQuery, label: string, url: string) {
    const userId = this.requireOAuthUserId(user)
    const accessToken = await this.getOAuthAccessToken(userId)
    const response = await this.http.json({
      label,
      method: 'GET',
      url,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (response.status === 401) {
      await this.repositories.oauth.remove(userId, 'lxns')
      throw new ProviderOAuthRequiredError(this.id, 'LXNS OAuth authorization is no longer valid.', 401)
    }
    if (response.status === 429) throw new ProviderRateLimitError(this.id)
    return this.unwrap(response)
  }

  private async getOAuthPlayer(user: UserQuery) {
    return parsePlayer(await this.oauthUserRequest(
      user,
      'player-info',
      `${LXNS_ENDPOINTS.user}/maimai/player`,
    ))
  }

  private async getOAuthScores(user: UserQuery) {
    const scores = await this.oauthUserRequest(
      user,
      'all-scores',
      `${LXNS_ENDPOINTS.user}/maimai/player/scores`,
    )
    return parseScores(scores)
  }

  private playerInfo(player: LXNSPlayer) {
    return new PlayerInfo(player.name, player.rating, player.course_rank)
  }

  private playerSettings(player: LXNSPlayer) {
    return new PlayerSettings(player.icon?.id ?? null, player.name_plate?.id ?? null)
  }

  private toRecord(score: LXNSScore) {
    const music = this.data.musics.get(normalizeLxnsMusicId(score.id, score.type))
    if (!music) return null
    const chart = music.genre === MusicGenre.Utage
      ? music.charts[0]
      : music.charts[score.level_index]
    if (!chart) throw new ProviderMalformedPayloadError(this.id, 'LXNS score references an unknown chart.')
    const achievement = toInternalAchievement(score.achievements)
    const ratingAchievement = music.genre === MusicGenre.Utage && music.charts.length > 1
      ? Math.trunc(achievement / music.charts.length)
      : achievement
    return new RecordEntry(
      music,
      chart,
      achievement,
      ComboStatus.of(score.fc),
      SyncStatus.of(score.fs),
      score.dx_score,
      Rate.get(ratingAchievement),
      Rating.calc(chart, ratingAchievement),
    )
  }

  private normalizeScores(scores: LXNSScore[]) {
    const records = scores.map(score => this.toRecord(score)).filter((record): record is RecordEntry => record !== null)
    this.debug?.event('provider.records.mapped', {
      provider: this.id,
      received: scores.length,
      mapped: records.length,
      dropped: scores.length - records.length,
    })
    return records
  }

  async getPlayerInfo(user: UserQuery) {
    return this.getOAuthPlayer(user)
  }

  async getPlayerRating(user: UserQuery) {
    const player = await this.getOAuthPlayer(user)
    const records = this.normalizeScores(await this.getOAuthScores(user))
      .sort((left, right) => right.rating - left.rating)
    return new RatingResponse(
      this.playerInfo(player),
      this.playerSettings(player),
      records.filter(record => !record.music.isNew).slice(0, 35),
      records.filter(record => record.music.isNew).slice(0, 15),
    )
  }

  async getPlayerRecord(user: UserQuery, music: MusicInfo) {
    const records = this.normalizeScores(await this.getOAuthScores(user))
    return records.filter(record => record.music.id === music.id)
  }

  async getPlayerRecords(user: UserQuery, musics: MusicInfo[]) {
    const player = await this.getOAuthPlayer(user)
    const ids = new Set(musics.map(music => music.id))
    const records = this.normalizeScores(await this.getOAuthScores(user))
      .filter(record => ids.has(record.music.id))
    return new RecordsResponse(
      this.playerInfo(player),
      this.playerSettings(player),
      records,
    )
  }

  async getPlayerRecent(user: UserQuery) {
    const player = await this.getOAuthPlayer(user)
    const scores = (await this.getOAuthScores(user))
      .map(score => ({
        score,
        time: Date.parse(score.last_played_time ?? score.play_time ?? score.upload_time ?? ''),
      }))
      .filter(entry => Number.isFinite(entry.time))
      .sort((left, right) => right.time - left.time)
      .slice(0, 50)
      .map(entry => entry.score)
    return new RecordsResponse(
      this.playerInfo(player),
      this.playerSettings(player),
      this.normalizeScores(scores),
    )
  }

  private async requestOAuthToken(data: Record<string, string>) {
    if (!this.config.lxnsOAuth.enabled) throw new ProviderOAuthRequiredError(this.id, 'LXNS OAuth is disabled.')
    const response = await this.http.json({
      label: 'oauth-token',
      method: 'POST',
      url: LXNS_ENDPOINTS.oauthToken,
      headers: { 'Content-Type': 'application/json' },
      data,
    })
    if (response.status < 200 || response.status >= 300) {
      throw this.oauthFailure(response.status, response.data)
    }
    const envelope = parseEnvelope(response.data)
    if (!envelope.success || envelope.code !== 200) {
      if (envelope.code === 400 || envelope.code === 401) {
        throw new ProviderOAuthRequiredError(this.id, envelope.message || undefined, envelope.code)
      }
      throw providerResponseError(this.id, envelope.code, { message: envelope.message })
    }
    if (envelope.data === null || envelope.data === undefined) {
      throw new ProviderOAuthRequiredError(this.id, envelope.message || 'LXNS OAuth token response contained no data.')
    }
    return parseOAuthToken(envelope.data)
  }

  private async saveToken(userId: string, token: LxnsOAuthToken) {
    await this.repositories.oauth.save({
      userId,
      provider: 'lxns',
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(this.now().getTime() + token.expires_in * 1_000),
    })
  }

  async exchangeOAuthCode(userId: string, code: string, redirectUri: string) {
    const token = await this.requestOAuthToken({
      client_id: this.config.lxnsOAuth.clientId,
      client_secret: this.config.lxnsOAuth.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    })
    await this.saveToken(userId, token)
    return token.access_token
  }

  async removeOAuthToken(userId: string) {
    await this.repositories.oauth.remove(userId, 'lxns')
  }

  async hasOAuthToken(userId: string) {
    return this.repositories.oauth.exists(userId, 'lxns')
  }

  private async refreshStoredToken(
    userId: string,
    stored: { refreshToken: string },
  ) {
    const token = await this.requestOAuthToken({
      client_id: this.config.lxnsOAuth.clientId,
      client_secret: this.config.lxnsOAuth.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken,
    })
    await this.saveToken(userId, token)
    return token.access_token
  }

  private async getOAuthAccessToken(userId: string) {
    const stored = await this.repositories.oauth.get(userId, 'lxns')
    if (!stored) throw new ProviderOAuthRequiredError(this.id)
    if (stored.expiresAt.getTime() > this.now().getTime() + LXNS_OAUTH_EXPIRY_SKEW_MS) {
      return stored.accessToken
    }
    return this.refreshStoredToken(userId, stored)
  }

  async refreshOAuthToken(userId: string) {
    const stored = await this.repositories.oauth.get(userId, 'lxns')
    if (!stored) throw new ProviderOAuthRequiredError(this.id)
    return this.refreshStoredToken(userId, stored)
  }
}

export { LxnsProvider as LXNSProvider }
