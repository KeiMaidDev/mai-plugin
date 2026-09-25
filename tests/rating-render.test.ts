import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MaimaiDataStore } from '../src/data/sync-service'
import { ComboStatus, MusicDifficulty, MusicGenre, MusicType, SyncStatus } from '../src/domain/enums'
import { ChartInfo, MusicInfo, Notes, RecordEntry } from '../src/domain/music'
import { PlayerInfo } from '../src/domain/player'
import { TakumiMaiRenderer } from '../src/render/mai-renderer'
import { resolvePackageAssetPath } from '../src/render/assets'
import { TakumiRenderService } from '../src/render/renderer'
import { pngPixel } from './png-pixels'

const data = {
  avatarPath: () => resolvePackageAssetPath('fallback/avatar.png'),
  platePath: () => resolvePackageAssetPath('fallback/plate.png'),
  coverPath: () => resolvePackageAssetPath('fallback/cover.png'),
} as unknown as MaimaiDataStore

const music = new MusicInfo(1234, 'A very long song title for a narrow card', MusicType.Deluxe,
  '', '', MusicGenre.Original, 160, { id: 1, name: 'test', version: 1 }, false)
const chart = new ChartInfo(music, MusicDifficulty.Master, '14+', 14.7, new Notes(100, 50, 30, 20, 10), '')
const record = new RecordEntry(music, chart, 1_005_000, ComboStatus.FullCombo,
  SyncStatus.FullSyncDeluxe, 610, 'sssp', 329)

async function preview(name: string, image: Buffer) {
  const directory = process.env.RATING_PREVIEW_DIR
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${name}.png`), image)
}

function assertPng(image: Buffer) {
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(image.readUInt32BE(16), 1280)
  assert.equal(image.readUInt32BE(20), 1280)
}

test('B15 renders a 1280 by 1280 PNG with fallback player assets', async () => {
  const service = new TakumiRenderService()
  try {
    const image = await new TakumiMaiRenderer(service, data).renderRating({
      backend: 'test',
      player: new PlayerInfo('Player', 12345, 5),
      oldRecords: [],
      newRecords: [],
      oldCount: 0,
      newCount: 15,
    })
    assertPng(image)
    assert.deepEqual(pngPixel(image, 640, 1250), [1, 49, 98, 255])
    await preview('b15-empty', image)
  } finally {
    await service.dispose()
  }
})

test('all Rating variants render populated cards and fixed empty positions', async () => {
  const service = new TakumiRenderService()
  const renderer = new TakumiMaiRenderer(service, data)
  try {
    for (const [name, oldCount, newCount] of [
      ['b15', 0, 15], ['b25', 10, 15], ['b35', 20, 15],
      ['b40', 25, 15], ['b50', 35, 15], ['score-list', 50, 0], ['song-50', 35, 15],
    ] as const) {
      const oldRecords = name === 'song-50' ? Array(oldCount).fill(record) : [record]
      const newRecords = name === 'song-50' ? Array(newCount).fill(record) : newCount ? [record] : []
      const image = await renderer.renderRating({
        backend: 'test',
        player: new PlayerInfo('A very long player nickname for the header', 15384, 23),
        oldRecords, newRecords, oldCount, newCount,
        rating: name === 'score-list' ? 15384 : undefined,
        title: name === 'b50' ? undefined
          : name === 'song-50' ? '[test] 歌50 Master1234. A very long song title for a narrow card x 50 = 16450'
            : `${name} - text-heavy image`,
      })
      assertPng(image)
      assert.ok(image.byteLength > 100_000, `${name} should contain the template artwork`)
      if (name === 'b50' || name === 'score-list') {
        const filled = pngPixel(image, 50, 200)
        const empty = pngPixel(image, 290, 200)
        assert.ok(filled[1] < empty[1] && filled[2] > empty[2], `${name} should distinguish populated and empty cards`)
        assert.ok(pngPixel(image, 1000, 175)[0] > 200, `${name} should show the title band`)
      }
      if (name === 'b50') {
        assert.ok(pngPixel(image, 50, 930)[2] > pngPixel(image, 290, 930)[2],
          'the new group should show a populated card followed by an empty card')
      }
      await preview(name, image)
    }
  } finally {
    await service.dispose()
  }
})
