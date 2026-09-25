import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { Context } from 'koishi'
import type {
  MaiArcade,
  MaiArcadeGroup,
  MaiGuessGame,
  MaiOauthToken,
} from './models'

const TOKEN_CIPHER_ERROR = '[mai-plugin] OAuth token persistence requires config.oauth.tokenCipherKey.'
const TOKEN_FRAME_VERSION = 'v1'
const TOKEN_AAD = Buffer.from('mai-plugin:oauth-token:v1')

export const GUESS_GAME_TTL_MS = 30 * 60 * 1000

class KeyedSerialization {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => pending)
    this.tails.set(key, tail)

    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

export class RepositoryCoordinator {
  private readonly aliasSerialization = new KeyedSerialization()
  private readonly arcadeSerialization = new KeyedSerialization()

  runAlias<T>(key: string, operation: () => Promise<T>) {
    return this.aliasSerialization.run(key, operation)
  }

  runArcade<T>(key: string, operation: () => Promise<T>) {
    return this.arcadeSerialization.run(key, operation)
  }
}

const defaultCoordinators = new WeakMap<object, RepositoryCoordinator>()

function resolveRepositoryCoordinator(ctx: Context) {
  const owner = (ctx.root ?? ctx) as unknown as object
  let coordinator = defaultCoordinators.get(owner)
  if (!coordinator) {
    coordinator = new RepositoryCoordinator()
    defaultCoordinators.set(owner, coordinator)
  }
  return coordinator
}

function isDuplicateEntry(error: unknown) {
  return (error as { code?: string }).code === 'duplicate-entry'
}

export class TokenCipher {
  private readonly key: Buffer | null

  constructor(secret: string) {
    this.key = secret ? createHash('sha256').update(secret, 'utf8').digest() : null
  }

  encrypt(plaintext: string) {
    const key = this.requireKey()
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(TOKEN_AAD)
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ])
    const tag = cipher.getAuthTag()

    return [
      TOKEN_FRAME_VERSION,
      nonce.toString('base64url'),
      ciphertext.toString('base64url'),
      tag.toString('base64url'),
    ].join('.')
  }

  decrypt(frame: string) {
    const key = this.requireKey()
    const [version, nonceValue, ciphertextValue, tagValue, extra] = frame.split('.')
    if (version !== TOKEN_FRAME_VERSION || !nonceValue || !ciphertextValue || !tagValue || extra) {
      throw new Error('[mai-plugin] OAuth token ciphertext has an unsupported or invalid format.')
    }

    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(nonceValue, 'base64url'),
      )
      decipher.setAAD(TOKEN_AAD)
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new Error('[mai-plugin] OAuth token ciphertext authentication failed.')
    }
  }

  private requireKey() {
    if (!this.key) throw new Error(TOKEN_CIPHER_ERROR)
    return this.key
  }
}

export class BindRepository {
  constructor(private readonly ctx: Context) {}

  async setQq(id: string, qq: string) {
    await this.ctx.database.upsert('mai_qq_bind', [{ id, qq, updatedAt: new Date() }], ['id'])
  }

  async getQq(id: string) {
    const [row] = await this.ctx.database.get('mai_qq_bind', { id })
    return row?.qq ?? null
  }

  async retireImportTokens() {
    await this.ctx.database.remove('mai_diving_fish_bind', {})
  }

  async setDivingFishAccount(id: string, accountId: string) {
    await this.ctx.database.upsert('mai_diving_fish_oauth_bind', [{
      id, accountId, updatedAt: new Date(),
    }], ['id'])
  }

  async getDivingFishAccount(id: string) {
    const [row] = await this.ctx.database.get('mai_diving_fish_oauth_bind', { id })
    return row?.accountId ?? null
  }

  async removeDivingFishAccount(id: string) {
    await this.ctx.database.remove('mai_diving_fish_oauth_bind', { id })
  }

  async divingFishAccountsForQq(qq: string) {
    const owners = await this.ctx.database.get('mai_qq_bind', { qq })
    const accounts = await Promise.all(owners.map(owner => this.getDivingFishAccount(owner.id)))
    return [...new Set(accounts.filter((value): value is string => Boolean(value)))]
  }
}

export class SettingRepository {
  constructor(private readonly ctx: Context) {}

  async set(id: string, key: string, value: string) {
    await this.ctx.database.upsert('mai_setting', [{
      id,
      key,
      value,
      updatedAt: new Date(),
    }], ['id', 'key'])
  }

  async get(id: string, key: string) {
    const [row] = await this.ctx.database.get('mai_setting', { id, key })
    return row?.value ? row.value : null
  }

  async list(id: string) {
    const rows = await this.ctx.database.get('mai_setting', { id })
    return Object.fromEntries(rows.map(row => [row.key, row.value]))
  }
}

export class AliasRepository {
  private readonly coordinator: RepositoryCoordinator

  constructor(
    private readonly ctx: Context,
    coordinator = resolveRepositoryCoordinator(ctx),
  ) {
    this.coordinator = coordinator
  }

  async add(musicId: number, name: string) {
    return this.coordinator.runAlias(this.key(musicId, name), async () => {
      const [existing] = await this.ctx.database.get('mai_alias', { musicId, name })
      if (existing) {
        await this.ctx.database.set('mai_alias', { musicId, name }, { votes: 0 })
      } else {
        await this.ctx.database.create('mai_alias', {
          musicId,
          name,
          votes: 0,
          createdAt: new Date(),
        })
      }
    })
  }

  async remove(musicId: number, name: string) {
    return this.coordinator.runAlias(this.key(musicId, name), async () => {
      await this.ctx.database.remove('mai_alias_vote', { musicId, name })
      await this.ctx.database.remove('mai_alias', { musicId, name })
    })
  }

  async exact(name: string) {
    const normalized = name.trim().toLocaleLowerCase()
    const rows = await this.ctx.database.get('mai_alias', {})
    return rows
      .filter(row => row.votes >= 0 && row.name.toLocaleLowerCase() === normalized)
      .map(row => row.musicId)
  }

  async list(musicId: number) {
    const rows = await this.ctx.database.get('mai_alias', { musicId })
    return rows.filter(row => row.votes >= 0)
  }

  async allApproved() {
    return this.ctx.database.get('mai_alias', { votes: { $gte: 0 } })
  }

  async getVotes(musicId: number, name: string) {
    const [row] = await this.ctx.database.get('mai_alias', { musicId, name })
    return row?.votes ?? null
  }

  async hasVoted(musicId: number, name: string, userId: string) {
    const rows = await this.ctx.database.get('mai_alias_vote', { musicId, name, userId })
    return rows.length > 0
  }

  async vote(musicId: number, name: string, userId: string) {
    return this.coordinator.runAlias(this.key(musicId, name), async () => {
      let voted = false
      try {
        await this.ctx.database.withTransaction(async (database) => {
          const existingVotes = await database.get('mai_alias_vote', {
            musicId,
            name,
            userId,
          })
          if (existingVotes.length) return

          await database.create('mai_alias_vote', {
            musicId,
            name,
            userId,
            createdAt: new Date(),
          })

          const [alias] = await database.get('mai_alias', { musicId, name })
          if (alias) {
            await database.set('mai_alias', { musicId, name }, {
              votes: alias.votes + 1,
            })
          } else {
            await database.create('mai_alias', {
              musicId,
              name,
              votes: -2,
              createdAt: new Date(),
            })
          }
          voted = true
        })
      } catch (error) {
        if (isDuplicateEntry(error)) return false
        throw error
      }
      return voted
    })
  }

  private key(musicId: number, name: string) {
    return `${musicId}\u0000${name}`
  }
}

export interface ArcadeSnapshot {
  id: number
  groupId: number
  name: string
  aliases: string[]
  value: number
  modifiedAt: Date
}

export type ArcadeCountMutation =
  | { type: 'set', value: number }
  | { type: 'adjust', value: number }

export type ArcadeCountMutationResult =
  | { type: 'updated', arcade: ArcadeSnapshot }
  | { type: 'too-large' }

export const ARCADE_NO_UPDATES_AT_MS = new Date(2000, 0, 1, 0, 0, 0, 0).getTime()

function arcadeNoUpdatesAt() {
  return new Date(ARCADE_NO_UPDATES_AT_MS)
}

function sameLocalDay(left: Date, right: Date) {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function shouldResetArcade(arcade: MaiArcade, currentTime: Date) {
  return arcade.modifiedAt.getTime() !== ARCADE_NO_UPDATES_AT_MS
    && !sameLocalDay(arcade.modifiedAt, currentTime)
}

export type ArcadeRepositoryErrorCode =
  | 'group-not-found'
  | 'arcade-not-found'
  | 'arcade-exists'
  | 'alias-exists'

export class ArcadeRepositoryError extends Error {
  constructor(
    readonly code: ArcadeRepositoryErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ArcadeRepositoryError'
  }
}

export class ArcadeRepository {
  private readonly coordinator: RepositoryCoordinator

  constructor(
    private readonly ctx: Context,
    coordinator = resolveRepositoryCoordinator(ctx),
  ) {
    this.coordinator = coordinator
  }

  async getOrCreateGroup(channelId: string) {
    return this.coordinator.runArcade(`channel:${channelId}`, async () => {
      const bound = await this.findGroup(channelId)
      if (bound) return bound

      let [group] = await this.ctx.database.get('mai_arcade_group', { name: channelId })
      if (!group) {
        try {
          group = await this.ctx.database.create('mai_arcade_group', { name: channelId })
        } catch (error) {
          if (!isDuplicateEntry(error)) throw error
          ;[group] = await this.ctx.database.get('mai_arcade_group', { name: channelId })
          if (!group) throw error
        }
      }
      await this.ctx.database.upsert('mai_arcade_group_bind', [{
        channelId,
        groupId: group.id,
      }], ['channelId'])
      return group
    })
  }

  async findGroup(channelId: string) {
    const [binding] = await this.ctx.database.get('mai_arcade_group_bind', { channelId })
    if (!binding) return null
    const [group] = await this.ctx.database.get('mai_arcade_group', { id: binding.groupId })
    return group ?? null
  }

  async bind(channelId: string, groupName: string) {
    return this.coordinator.runArcade(`channel:${channelId}`, async () => {
      const [group] = await this.ctx.database.get('mai_arcade_group', { name: groupName })
      if (!group) {
        throw new ArcadeRepositoryError(
          'group-not-found',
          `[mai-plugin] arcade group "${groupName}" was not found.`,
        )
      }
      await this.ctx.database.upsert('mai_arcade_group_bind', [{
        channelId,
        groupId: group.id,
      }], ['channelId'])
      return group
    })
  }

  async addArcade(channelId: string, name: string, modifiedAt = new Date()) {
    const group = await this.getOrCreateGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      if (await this.findArcadeRow(group, name)) {
        throw new ArcadeRepositoryError(
          'arcade-exists',
          `[mai-plugin] arcade "${name}" already exists in this group.`,
        )
      }
      const arcade = await this.ctx.database.create('mai_arcade', {
        groupId: group.id,
        name,
        aliases: [name],
        value: 0,
        modifiedAt,
      })
      return this.snapshot(arcade)
    })
  }

  async deleteArcade(channelId: string, name: string) {
    const group = await this.requireGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const arcade = await this.requireArcade(group, name)
      await this.ctx.database.remove('mai_arcade', { id: arcade.id })
    })
  }

  async addAlias(channelId: string, name: string, alias: string) {
    const group = await this.requireGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const arcade = await this.requireArcade(group, name)
      if (await this.findArcadeRow(group, alias)) {
        throw new ArcadeRepositoryError(
          'alias-exists',
          `[mai-plugin] arcade alias "${alias}" already exists in this group.`,
        )
      }
      const aliases = [...arcade.aliases, alias]
      await this.ctx.database.set('mai_arcade', { id: arcade.id }, { aliases })
      return aliases
    })
  }

  async deleteAlias(channelId: string, name: string, alias: string) {
    const group = await this.requireGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const arcade = await this.requireArcade(group, name)
      const aliases = arcade.aliases.filter(value => value !== alias)
      await this.ctx.database.set('mai_arcade', { id: arcade.id }, { aliases })
      return aliases
    })
  }

  async aliases(channelId: string, name: string) {
    const group = await this.requireGroup(channelId)
    return [...(await this.requireArcade(group, name)).aliases]
  }

  async list(channelId: string, currentTime = new Date()) {
    const group = await this.findGroup(channelId)
    if (!group) return null
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const rows = await this.ctx.database.get('mai_arcade', { groupId: group.id })
      const snapshots: ArcadeSnapshot[] = []
      for (const row of rows.sort((left, right) => left.id - right.id)) {
        if (!shouldResetArcade(row, currentTime)) {
          snapshots.push(this.snapshot(row))
          continue
        }
        const modifiedAt = arcadeNoUpdatesAt()
        await this.ctx.database.set('mai_arcade', { id: row.id }, {
          value: 0,
          modifiedAt,
        })
        snapshots.push(this.snapshot({ ...row, value: 0, modifiedAt }))
      }
      return snapshots
    })
  }

  async find(channelId: string, name: string) {
    const group = await this.findGroup(channelId)
    if (!group) return null
    const arcade = await this.findArcadeRow(group, name)
    return arcade ? this.snapshot(arcade) : null
  }

  async setCount(channelId: string, name: string, value: number, modifiedAt = new Date()) {
    const group = await this.requireGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const arcade = await this.requireArcade(group, name)
      const normalized = Math.max(0, Math.trunc(value))
      await this.ctx.database.set('mai_arcade', { id: arcade.id }, {
        value: normalized,
        modifiedAt,
      })
      return this.snapshot({ ...arcade, value: normalized, modifiedAt })
    })
  }

  async adjustCount(channelId: string, name: string, delta: number, modifiedAt = new Date()) {
    const group = await this.requireGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const arcade = await this.requireArcade(group, name)
      const value = Math.max(0, Math.trunc(arcade.value + delta))
      await this.ctx.database.set('mai_arcade', { id: arcade.id }, {
        value,
        modifiedAt,
      })
      return this.snapshot({ ...arcade, value, modifiedAt })
    })
  }

  async mutateCount(
    channelId: string,
    name: string,
    mutation: ArcadeCountMutation,
    modifiedAt = new Date(),
    maximum = 50,
  ): Promise<ArcadeCountMutationResult> {
    const group = await this.requireGroup(channelId)
    return this.coordinator.runArcade(`group:${group.id}`, async () => {
      const arcade = await this.requireArcade(group, name)
      const currentValue = shouldResetArcade(arcade, modifiedAt) ? 0 : arcade.value
      const candidate = Math.trunc(
        mutation.type === 'set'
          ? mutation.value
          : currentValue + mutation.value,
      )
      if (candidate > maximum) {
        if (currentValue !== arcade.value) {
          await this.ctx.database.set('mai_arcade', { id: arcade.id }, {
            value: 0,
            modifiedAt: arcadeNoUpdatesAt(),
          })
        }
        return { type: 'too-large' }
      }
      const value = Math.max(0, candidate)
      await this.ctx.database.set('mai_arcade', { id: arcade.id }, {
        value,
        modifiedAt,
      })
      return {
        type: 'updated',
        arcade: this.snapshot({ ...arcade, value, modifiedAt }),
      }
    })
  }

  private async requireGroup(channelId: string) {
    const group = await this.findGroup(channelId)
    if (!group) {
      throw new ArcadeRepositoryError(
        'group-not-found',
        `[mai-plugin] arcade group for channel "${channelId}" was not found.`,
      )
    }
    return group
  }

  private async requireArcade(group: MaiArcadeGroup, name: string) {
    const arcade = await this.findArcadeRow(group, name)
    if (!arcade) {
      throw new ArcadeRepositoryError(
        'arcade-not-found',
        `[mai-plugin] arcade "${name}" was not found.`,
      )
    }
    return arcade
  }

  private async findArcadeRow(group: MaiArcadeGroup, name: string) {
    const normalized = name.toLocaleLowerCase()
    const rows = await this.ctx.database.get('mai_arcade', { groupId: group.id })
    return rows.find(row => (
      row.name.toLocaleLowerCase() === normalized
      || row.aliases.some(alias => alias.toLocaleLowerCase() === normalized)
    )) ?? null
  }

  private snapshot(arcade: MaiArcade): ArcadeSnapshot {
    return {
      id: arcade.id,
      groupId: arcade.groupId,
      name: arcade.name,
      aliases: [...arcade.aliases],
      value: arcade.value,
      modifiedAt: arcade.modifiedAt,
    }
  }
}

export class GuessRepository {
  constructor(private readonly ctx: Context) {}

  async save(game: Omit<MaiGuessGame, 'modifiedAt'>, modifiedAt = new Date()) {
    await this.ctx.database.upsert('mai_guess_game', [{ ...game, modifiedAt }], ['contextId'])
  }

  async restore(now = new Date()) {
    const cutoff = new Date(now.getTime() - GUESS_GAME_TTL_MS)
    await this.ctx.database.remove('mai_guess_game', { modifiedAt: { $lte: cutoff } })
    return this.ctx.database.get('mai_guess_game', { modifiedAt: { $gt: cutoff } })
  }

  async remove(contextId: string) {
    await this.ctx.database.remove('mai_guess_game', { contextId })
  }
}

export type OAuthTokenInput = Omit<MaiOauthToken, 'accessToken' | 'refreshToken' | 'updatedAt'> & {
  accessToken: string
  refreshToken: string
}

export class OAuthRepository {
  private readonly cipher: TokenCipher

  constructor(private readonly ctx: Context, tokenCipherKey: string) {
    this.cipher = new TokenCipher(tokenCipherKey)
  }

  async save(token: OAuthTokenInput, updatedAt = new Date()) {
    const accessToken = this.cipher.encrypt(token.accessToken)
    const refreshToken = this.cipher.encrypt(token.refreshToken)
    await this.ctx.database.upsert('mai_oauth_token', [{
      ...token,
      accessToken,
      refreshToken,
      updatedAt,
    }], ['userId', 'provider'])
  }

  async get(userId: string, provider: 'lxns' = 'lxns') {
    const [row] = await this.ctx.database.get('mai_oauth_token', { userId, provider })
    if (!row) return null
    return {
      ...row,
      accessToken: this.cipher.decrypt(row.accessToken),
      refreshToken: this.cipher.decrypt(row.refreshToken),
    }
  }

  async exists(userId: string, provider: 'lxns' = 'lxns') {
    const rows = await this.ctx.database.get('mai_oauth_token', { userId, provider })
    return rows.length > 0
  }

  async remove(userId: string, provider: 'lxns' = 'lxns') {
    await this.ctx.database.remove('mai_oauth_token', { userId, provider })
  }
}

export class MaiRepositories {
  readonly bind: BindRepository
  readonly setting: SettingRepository
  readonly alias: AliasRepository
  readonly arcade: ArcadeRepository
  readonly guess: GuessRepository
  readonly oauth: OAuthRepository

  constructor(
    ctx: Context,
    tokenCipherKey = '',
    coordinator = resolveRepositoryCoordinator(ctx),
  ) {
    this.bind = new BindRepository(ctx)
    this.setting = new SettingRepository(ctx)
    this.alias = new AliasRepository(ctx, coordinator)
    this.arcade = new ArcadeRepository(ctx, coordinator)
    this.guess = new GuessRepository(ctx)
    this.oauth = new OAuthRepository(ctx, tokenCipherKey)
  }
}
