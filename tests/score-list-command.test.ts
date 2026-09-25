import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from 'koishi'
import { registerImageCommands } from '../src/commands/image'
import type { CoreCommandDependencies } from '../src/commands/support'
import { ComboStatus, MusicDifficulty, MusicGenre, MusicType, SyncStatus } from '../src/domain/enums'
import { ChartInfo, MusicInfo, Notes, RecordEntry } from '../src/domain/music'
import { PlayerInfo, RatingResponse, RecordsResponse } from '../src/domain/player'

const music = new MusicInfo(1234, 'Song', MusicType.Deluxe, '', '', MusicGenre.Original,
  160, { id: 1, name: 'test', version: 1 }, false)
const chart = new ChartInfo(music, MusicDifficulty.Master, '14', 14, new Notes(), '')

function commandContext(actions: Map<string, (...args: any[]) => any>): Context {
  let currentCommand = ''
  const chain = {
    alias() { return this },
    option() { return this },
    action(callback: (...args: any[]) => any) {
      actions.set(currentCommand, callback)
      return this
    },
  }
  return {
    command(name: string) {
      currentCommand = name
      return chain
    },
  } as unknown as Context
}

test('the final score-list page keeps 50 positions and player rating', async () => {
  const actions = new Map<string, (...args: any[]) => any>()
  const context = commandContext(actions)
  const records = Array.from({ length: 53 }, (_, index) => new RecordEntry(
    music, chart, 1_000_000 - index, ComboStatus.None, SyncStatus.None, 0, 'sss', 300 - index,
  ))
  let rendered: any
  let sent: unknown
  const dependencies = {
    data: { musics: new Map([[music.id, music]]) },
    queryService: {
      getQueryParams: async () => ({ isSelf: true }),
      records: async () => ({ response: new RecordsResponse(new PlayerInfo('Player', 15384), null, records), provider: { name: 'test' } }),
    },
    renderer: {
      renderRating: async (input: unknown) => {
        rendered = input
        return Buffer.from('image')
      },
    },
    settingService: { isCompatibilityMode: async () => false },
  } as unknown as CoreCommandDependencies
  registerImageCommands(context, dependencies)
  const action = actions.get('mai.score-list [filter:string] [page:posint]')
  assert.ok(action)
  await action({
    options: {},
    session: {
      userId: '1', channelId: '2', platform: 'qq', content: 'mai.score-list 2',
      send: async (message: unknown) => { sent = message },
    },
  }, '', '2')
  assert.equal(rendered.oldCount, 50)
  assert.equal(rendered.newCount, 0)
  assert.equal(rendered.rating, 15384)
  assert.deepEqual(rendered.oldRecords, records.slice(50))
  assert.match(rendered.title, /2 \/ 2/)
  assert.match(JSON.stringify(sent), /page-1/)
})

test('Song 50 repeats the selected record and passes its total rating to the renderer', async () => {
  const actions = new Map<string, (...args: any[]) => any>()
  const context = commandContext(actions)
  const record = new RecordEntry(music, chart, 1_000_000, ComboStatus.None, SyncStatus.None, 0, 'sss', 329)
  let rendered: any
  const dependencies = {
    aliasService: { search: async () => [music] },
    queryService: {
      getQueryParams: async () => ({ isSelf: true }),
      rating: async () => ({ response: new RatingResponse(new PlayerInfo('Player', 15384)), provider: { name: 'test' } }),
      record: async () => ({ response: [record] }),
    },
    renderer: { renderRating: async (input: unknown) => {
      rendered = input
      return Buffer.from('image')
    } },
    settingService: { isCompatibilityMode: async () => false },
  } as unknown as CoreCommandDependencies
  registerImageCommands(context, dependencies)
  const action = actions.get('mai.song-rating <query:text>')
  assert.ok(action)
  await action({
    options: {},
    session: {
      userId: '1', channelId: '2', platform: 'qq', content: 'mai.song-rating 1234',
      send: async () => {},
    },
  }, '1234')
  assert.equal(rendered.oldCount, 35)
  assert.equal(rendered.newCount, 15)
  assert.equal(rendered.rating, 16450)
  assert.deepEqual(rendered.oldRecords, Array(35).fill(record))
  assert.deepEqual(rendered.newRecords, Array(15).fill(record))
})

test('a complete Best N filter disables the new group divider', async () => {
  const actions = new Map<string, (...args: any[]) => any>()
  const context = commandContext(actions)
  const filteredMusic = new MusicInfo(1234, 'Song', MusicType.Deluxe, '', '', MusicGenre.Original,
    160, { id: 1, name: 'test', version: 1 }, false)
  const filteredChart = new ChartInfo(filteredMusic, MusicDifficulty.Master, '14', 14, new Notes(), '')
  filteredMusic.charts.push(filteredChart)
  const record = new RecordEntry(filteredMusic, filteredChart, 1_000_000, ComboStatus.None, SyncStatus.None, 0, 'sss', 329)
  let rendered: any
  let sent: unknown
  const dependencies = {
    data: { musics: new Map([[filteredMusic.id, filteredMusic]]) },
    queryService: {
      getQueryParams: async () => ({ isSelf: true }),
      records: async () => ({ response: new RecordsResponse(new PlayerInfo('Player', 15384), null, [record]),
        provider: { name: 'test' } }),
    },
    renderer: { renderRating: async (input: unknown) => {
      rendered = input
      return Buffer.from('image')
    } },
    settingService: { isCompatibilityMode: async () => false },
  } as unknown as CoreCommandDependencies
  registerImageCommands(context, dependencies)
  const action = actions.get('mai.rating <input:text>')
  assert.ok(action)
  await action({
    options: {},
    session: {
      userId: '1', channelId: '2', platform: 'qq', content: 'mai.rating 全 b25',
      send: async (message: unknown) => { sent = message },
    },
  }, '全 b25')
  assert.ok(rendered, JSON.stringify(sent))
  assert.equal(rendered.newGroupDisabled, true)
})
