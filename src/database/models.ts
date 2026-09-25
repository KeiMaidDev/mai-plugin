import type { Context } from 'koishi'

export interface MaiQqBind {
  id: string
  qq: string
  updatedAt: Date
}

export interface MaiDivingFishBind {
  id: string
  importToken: string
  updatedAt: Date
}

export interface MaiDivingFishOAuthBind {
  id: string
  accountId: string
  updatedAt: Date
}

export interface MaiSetting {
  id: string
  key: string
  value: string
  updatedAt: Date
}

export interface MaiAlias {
  musicId: number
  name: string
  votes: number
  createdAt: Date
}

export interface MaiAliasVote {
  musicId: number
  name: string
  userId: string
  createdAt: Date
}

export interface MaiArcadeGroup {
  id: number
  name: string
}

export interface MaiArcadeGroupBind {
  channelId: string
  groupId: number
}

export interface MaiArcade {
  id: number
  groupId: number
  name: string
  aliases: string[]
  value: number
  modifiedAt: Date
}

export interface MaiGuessGame {
  contextId: string
  platform: string
  channelId: string
  guildId: string | null
  userId: string
  type: 'classical' | 'opening'
  status: unknown
  modifiedAt: Date
}

export interface MaiOauthToken {
  userId: string
  provider: 'lxns'
  accessToken: string
  refreshToken: string
  expiresAt: Date
  updatedAt: Date
}

export interface MaiTables {
  mai_qq_bind: MaiQqBind
  mai_diving_fish_bind: MaiDivingFishBind
  mai_diving_fish_oauth_bind: MaiDivingFishOAuthBind
  mai_setting: MaiSetting
  mai_alias: MaiAlias
  mai_alias_vote: MaiAliasVote
  mai_arcade_group: MaiArcadeGroup
  mai_arcade_group_bind: MaiArcadeGroupBind
  mai_arcade: MaiArcade
  mai_guess_game: MaiGuessGame
  mai_oauth_token: MaiOauthToken
}

declare module 'koishi' {
  interface Tables extends MaiTables {}
}

export function registerMaiDatabaseModels(ctx: Context) {
  ctx.model.extend('mai_qq_bind', {
    id: 'string(64)',
    qq: 'string(32)',
    updatedAt: 'timestamp',
  }, {
    primary: 'id',
  })

  ctx.model.extend('mai_diving_fish_bind', {
    id: 'string(64)',
    importToken: 'text',
    updatedAt: 'timestamp',
  }, {
    primary: 'id',
  })

  ctx.model.extend('mai_diving_fish_oauth_bind', {
    id: 'string(64)',
    accountId: 'string(64)',
    updatedAt: 'timestamp',
  }, { primary: 'id' })

  ctx.model.extend('mai_setting', {
    id: 'string(64)',
    key: 'string(64)',
    value: 'string(512)',
    updatedAt: 'timestamp',
  }, {
    primary: ['id', 'key'],
  })

  ctx.model.extend('mai_alias', {
    musicId: 'integer',
    name: 'string(128)',
    votes: 'integer',
    createdAt: 'timestamp',
  }, {
    primary: ['musicId', 'name'],
  })

  ctx.model.extend('mai_alias_vote', {
    musicId: 'integer',
    name: 'string(128)',
    userId: 'string(64)',
    createdAt: 'timestamp',
  }, {
    primary: ['musicId', 'name', 'userId'],
  })

  ctx.model.extend('mai_arcade_group', {
    id: 'unsigned',
    name: 'string(64)',
  }, {
    autoInc: true,
    primary: 'id',
    unique: ['name'],
  })

  ctx.model.extend('mai_arcade_group_bind', {
    channelId: 'string(255)',
    groupId: 'unsigned',
  }, {
    primary: 'channelId',
  })

  ctx.model.extend('mai_arcade', {
    id: 'unsigned',
    groupId: 'unsigned',
    name: 'string(64)',
    aliases: 'array',
    value: 'integer',
    modifiedAt: 'timestamp',
  }, {
    autoInc: true,
    primary: 'id',
  })

  ctx.model.extend('mai_guess_game', {
    contextId: 'string(255)',
    platform: 'string(64)',
    channelId: 'string(255)',
    guildId: { type: 'string', length: 255, nullable: true, initial: null },
    userId: 'string(64)',
    type: 'string(16)',
    status: 'json' as never,
    modifiedAt: 'timestamp',
  }, {
    primary: 'contextId',
  })

  ctx.model.extend('mai_oauth_token', {
    userId: 'string(64)',
    provider: 'string(32)',
    accessToken: 'text',
    refreshToken: 'text',
    expiresAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: ['userId', 'provider'],
  })
}
