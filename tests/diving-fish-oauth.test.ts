import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from 'koishi'
import { registerUpdateCommands } from '../src/commands/update'
import { DivingFishOAuth } from '../src/providers/diving-fish-oauth'
import { DivingFishProvider, DIVING_FISH_ENDPOINTS } from '../src/providers/diving-fish'
import { ChartInfo, MusicInfo, Notes } from '../src/domain/music'
import { MusicDifficulty, MusicGenre, MusicType } from '../src/domain/enums'
import { UpdateService } from '../src/services/update-service'
import type { Config } from '../src/config'

function commandContext(actions: Map<string, (...args: any[]) => any>): Context {
  let name = ''
  const chain = {
    alias() { return this },
    action(callback: (...args: any[]) => any) { actions.set(name, callback); return this },
  }
  return { command(command: string) { name = command; return chain } } as unknown as Context
}

function bindings() {
  const accounts = new Map<string, string>()
  const qq = new Map<string, string[]>()
  return {
    accounts,
    qq,
    async setDivingFishAccount(id: string, accountId: string) { accounts.set(id, accountId) },
    async getDivingFishAccount(id: string) { return accounts.get(id) ?? null },
    async removeDivingFishAccount(id: string) { accounts.delete(id) },
    async divingFishAccountsForQq(value: string) {
      return [...new Set((qq.get(value) ?? []).map(id => accounts.get(id)).filter(Boolean))] as string[]
    },
  }
}

const credentials = { clientId: 'client-1', clientSecret: 'secret-1' }

test('binding command presents the device URL and code through QQ rawMarkdown', async () => {
  const actions = new Map<string, (...args: any[]) => any>()
  const messages: unknown[] = []
  registerUpdateCommands(commandContext(actions), {
    updateService: {
      beginDivingFishOAuth: async () => ({ url: 'https://auth.diving-fish.com/device?user_code=ABCD', code: 'ABCD' }),
    },
  } as any)
  await actions.get('mai.bind-diving-fish')!({ options: {}, session: {
    userId: 'user-1', channelId: 'channel-1', platform: 'qq', content: '/mai 绑定水鱼',
    send: async (message: unknown) => { messages.push(message) },
  } })
  const rendered = JSON.stringify(messages)
  assert.match(rendered, /ABCD/)
  assert.match(rendered, /qq:rawmarkdown/)
  assert.match(rendered, /auth.diving-fish.com/)
  assert.ok(!actions.has('mai.bind-diving-fish <token:text>'))
})

test('device consent stores the account ID and unbinding stops later completion', async () => {
  const bind = bindings()
  const requests: Array<{ url: string; data: URLSearchParams }> = []
  const replies: string[] = []
  const ctx = { http: async (url: string, options: { data: URLSearchParams }) => {
    requests.push({ url, data: options.data })
    if (url.endsWith('/oauth/device_authorization')) return { status: 200, data: {
      device_code: 'device-secret', user_code: 'ABCD',
      verification_uri_complete: 'https://auth.diving-fish.com/device?user_code=ABCD',
      expires_in: 10, interval: 1,
    } }
    return { status: 200, data: { sub: 'account-7', access_token: 'temporary-token' } }
  } } as unknown as Context
  const oauth = new DivingFishOAuth(ctx, credentials, bind)
  try {
    const link = await oauth.begin({ userId: 'user-1', send: async text => { replies.push(text) } })
    assert.equal(link.code, 'ABCD')
    assert.equal(requests[0].data.get('scope'), 'prober.records.read prober.records.write')
    assert.match(requests[0].data.get('subject_ref') ?? '', /^[0-9a-f]{64}$/)
    assert.match(requests[0].data.get('binding_label') ?? '', /Koishi/)
    await new Promise(resolve => setTimeout(resolve, 1150))
    assert.equal(await oauth.hasBinding('user-1'), true)
    assert.deepEqual(replies, ['水鱼授权绑定成功。'])
    await oauth.unbind('user-1')
    assert.equal(await oauth.hasBinding('user-1'), false)
    assert.equal(requests[1].data.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  } finally {
    oauth.dispose()
  }
})

test('denied device consent ends with a retry path and no binding', async () => {
  const bind = bindings()
  const replies: string[] = []
  const ctx = { http: async (url: string) => url.endsWith('/oauth/device_authorization')
    ? { status: 200, data: {
      device_code: 'device-secret', user_code: 'ABCD',
      verification_uri_complete: 'https://auth.diving-fish.com/device?user_code=ABCD',
      expires_in: 10, interval: 1,
    } }
    : { status: 400, data: { error: 'access_denied' } },
  } as unknown as Context
  const oauth = new DivingFishOAuth(ctx, credentials, bind)
  try {
    await oauth.begin({ userId: 'user-1', send: async text => { replies.push(text) } })
    await new Promise(resolve => setTimeout(resolve, 1150))
    assert.equal(await oauth.hasBinding('user-1'), false)
    assert.deepEqual(replies, ['水鱼授权已拒绝，请发送“/mai 绑定水鱼”重试。'])
  } finally {
    oauth.dispose()
  }
})

test('concurrent queries reuse a short-lived token and renew near expiry', async () => {
  const bind = bindings()
  let now = 0
  let exchanges = 0
  const ctx = { http: async () => {
    exchanges += 1
    return { status: 200, data: { access_token: `token-${exchanges}`, expires_in: 300 } }
  } } as unknown as Context
  const oauth = new DivingFishOAuth(ctx, credentials, bind, undefined, () => now)
  try {
    const [first, concurrent] = await Promise.all([
      oauth.accessToken('sub:7', 'prober.records.read'),
      oauth.accessToken('sub:7', 'prober.records.read'),
    ])
    assert.equal(first, 'token-1')
    assert.equal(concurrent, first)
    assert.equal(exchanges, 1)
    now = 271_000
    assert.equal(await oauth.accessToken('sub:7', 'prober.records.read'), 'token-2')
    assert.equal(exchanges, 2)
  } finally {
    oauth.dispose()
  }
})

test('unbinding during an exchange cannot restore the cached token', async () => {
  const bind = bindings()
  bind.accounts.set('user-1', 'account-7')
  let finish!: (value: unknown) => void
  const ctx = { http: async () => new Promise(resolve => { finish = resolve }) } as unknown as Context
  const oauth = new DivingFishOAuth(ctx, credentials, bind)
  try {
    const exchange = oauth.accessToken('sub:account-7', 'prober.records.read')
    await oauth.unbind('user-1')
    finish({ status: 200, data: { access_token: 'stale-token', expires_in: 300 } })
    await assert.rejects(exchange, /consent_required/)
    assert.equal(await oauth.hasBinding('user-1'), false)
  } finally {
    oauth.dispose()
  }
})

test('authorized records use Bearer without target identity parameters and reuse exchange', async () => {
  const bind = bindings()
  bind.accounts.set('user-1', 'account-7')
  let exchanges = 0
  const requests: Array<{ url: string; method: string; headers: Record<string, string>; data: unknown }> = []
  const record = {
    achievements: 100.5, ds: 14, dxScore: 1000, fc: '', fs: '', level: '14',
    level_index: 0, level_label: 'Master', ra: 300, rate: 'sss', song_id: 1234,
    title: 'Song', type: 'DX',
  }
  const ctx = { http: async (url: string, options: any) => {
    requests.push({ url, method: options.method, headers: options.headers ?? {}, data: options.data })
    if (url.endsWith('/oauth/token')) {
      exchanges += 1
      return { status: 200, data: { access_token: 'bearer-1', expires_in: 300 } }
    }
    if (url.endsWith('/player/record')) return { status: 200, data: { '1234': [record] } }
    if (url.endsWith('/player/records')) return { status: 200, data: {
      username: 'owner', nickname: 'Player', rating: 15000, additional_rating: 20,
      plate: '', records: [record],
    } }
    if (url.endsWith('/player/update_records')) return { status: 200, data: {
      creates: 1, updates: 0, message: 'ok',
    } }
    if (url.endsWith('/query/player')) return { status: 200, data: {
      username: 'owner', nickname: 'Player', rating: 15000, additional_rating: 20,
      plate: '', charts: { sd: [], dx: [record] },
    } }
    throw new Error(`Unexpected request: ${url}`)
  } } as unknown as Context
  const oauth = new DivingFishOAuth(ctx, credentials, bind)
  const music = new MusicInfo(1234, 'Song', MusicType.Deluxe, '', '', MusicGenre.Original,
    160, { id: 1, name: 'test', version: 1 }, false)
  music.charts = [new ChartInfo(music, MusicDifficulty.Master, '14', 14, new Notes(), '')]
  const provider = new DivingFishProvider({ ctx, oauth,
    config: {} as Config, data: { musics: new Map([[1234, music]]) } as any,
    repositories: {} as any,
  })
  try {
    const user = { type: 'qq' as const, qq: '123456', userId: 'user-1', isSelf: true }
    const [song, all] = await Promise.all([
      provider.getPlayerRecord(user, music), provider.getPlayerRecords(user, [music]),
    ])
    assert.equal(song.length, 1)
    assert.equal(all.records.length, 1)
    assert.equal(exchanges, 1)
    const publicRating = await provider.getPlayerRating({ type: 'qq', qq: '123456' })
    assert.equal(publicRating.newRatingList.length, 1)
    const update = await provider.importRecords('user-1', [{
      title: 'Song', achievements: 100.5, dxScore: 1000, fc: '', fs: '',
      level_index: 0, type: 'DX',
    }])
    assert.equal(update.creates, 1)
    const resource = requests.filter(request => request.url.includes('/player/record'))
    assert.deepEqual(resource.map(request => [request.method, request.url]), [
      ['POST', DIVING_FISH_ENDPOINTS.playerRecord], ['GET', DIVING_FISH_ENDPOINTS.playerRecords],
    ])
    for (const request of resource) {
      assert.equal(request.headers.Authorization, 'Bearer bearer-1')
      assert.ok(!JSON.stringify(request.data ?? '').includes('qq'))
      assert.ok(!JSON.stringify(request.data ?? '').includes('username'))
    }
    const submission = requests.find(request => request.url === DIVING_FISH_ENDPOINTS.updateRecords)!
    assert.equal(submission.headers.Authorization, 'Bearer bearer-1')
    assert.equal(submission.headers['Import-Token'], undefined)
    assert.equal(exchanges, 2)
  } finally {
    oauth.dispose()
  }
})

test('WeChat callback submits with write scope and reports missing permission', async () => {
  const bind = bindings()
  bind.accounts.set('user-1', 'account-7')
  const requests: Array<{ url: string; data: unknown; headers: Record<string, string> }> = []
  let allowWrite = true
  const ctx = { http: async (url: string, options: any) => {
    requests.push({ url, data: options.data, headers: options.headers ?? {} })
    if (url.endsWith('/oauth/token')) return { status: 200, data: {
      access_token: 'write-token', expires_in: 300,
    } }
    return allowWrite
      ? { status: 200, data: { creates: 1, updates: 0, message: 'ok' } }
      : { status: 403, data: { message: 'access token 缺少权限：prober.records.write' } }
  } } as unknown as Context
  const oauth = new DivingFishOAuth(ctx, credentials, bind)
  const provider = new DivingFishProvider({ ctx, oauth, config: {} as Config,
    data: { musics: new Map() } as any, repositories: {} as any })
  const messages: string[] = []
  const record = { title: 'Song', achievements: 100.5, dxScore: 1000,
    fc: '' as const, fs: '' as const, level_index: 0, type: 'DX' as const }
  const service = new UpdateService({
    publicBaseUrl: 'https://bot.example.com',
    oauth: { enabled: false, authorizationUrl: '', clientId: '', clientSecret: '', tokenCipherKey: '' },
    lxns: { exchangeOAuthCode: async () => {}, removeOAuthToken: async () => {}, hasOAuthToken: async () => false },
    divingFishOAuth: oauth,
    fetchAuthorizationRedirect: async () => '',
    fetchDivingFishRecords: async () => [record],
    importDivingFishRecords: (userId, records) => provider.importRecords(userId, records),
  })
  const session = { userId: 'user-1', platform: 'qq', channelId: 'channel-1', direct: false,
    send: async (text: string) => { messages.push(text) }, replay: async () => {} }
  const callback = '/wc_auth/oauth/callback/maimai-dx'
  try {
    const first = new URL(await service.beginDivingFishUpdate(session)).searchParams.get('token')!
    await service.completeDivingFishUpdate(first, callback)
    assert.match(messages.at(-1) ?? '', /更新成功.*1条/)
    const submission = requests.find(request => request.url === DIVING_FISH_ENDPOINTS.updateRecords)!
    assert.equal(submission.headers.Authorization, 'Bearer write-token')
    assert.equal(submission.headers['Import-Token'], undefined)
    const exchange = requests.find(request => request.url.endsWith('/oauth/token'))!
    assert.equal((exchange.data as URLSearchParams).get('scope'), 'prober.records.write')

    allowWrite = false
    const second = new URL(await service.beginDivingFishUpdate(session)).searchParams.get('token')!
    await assert.rejects(service.completeDivingFishUpdate(second, callback))
    assert.match(messages.at(-1) ?? '', /缺少成绩写入权限/)
  } finally {
    service.dispose()
  }
})
