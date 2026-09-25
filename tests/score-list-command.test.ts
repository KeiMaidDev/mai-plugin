import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from 'koishi'
import { registerImageCommands } from '../src/commands/image'
import type { CoreCommandDependencies } from '../src/commands/support'
import { ComboStatus, MusicDifficulty, MusicGenre, MusicType, SyncStatus } from '../src/domain/enums'
import { ChartInfo, MusicInfo, Notes, RecordEntry } from '../src/domain/music'
import { PlayerInfo, RecordsResponse } from '../src/domain/player'

test('the final score-list page keeps 50 positions and player rating', async () => {
  const actions = new Map<string, (...args: any[]) => any>()
  const chain = {
    alias() { return this },
    option() { return this },
    action(callback: (...args: any[]) => any) {
      actions.set(currentCommand, callback)
      return this
    },
  }
  let currentCommand = ''
  const context = {
    command(name: string) {
      currentCommand = name
      return chain
    },
  } as unknown as Context
  const music = new MusicInfo(1234, 'Song', MusicType.Deluxe, '', '', MusicGenre.Original,
    160, { id: 1, name: 'test', version: 1 }, false)
  const chart = new ChartInfo(music, MusicDifficulty.Master, '14', 14, new Notes(), '')
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
