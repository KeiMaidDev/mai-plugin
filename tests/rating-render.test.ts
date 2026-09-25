import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MaimaiDataStore } from '../src/data/sync-service'
import { ComboStatus, MusicDifficulty, MusicGenre, MusicType, SyncStatus } from '../src/domain/enums'
import { ChartInfo, MusicInfo, Notes, RecordEntry } from '../src/domain/music'
import { PlayerInfo } from '../src/domain/player'
import { TakumiMaiRenderer } from '../src/render/mai-renderer'
import { resolvePackageAssetPath } from '../src/render/assets'
import { TakumiRenderService } from '../src/render/renderer'
import { pngPixel, pngRow } from './png-pixels'

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
    assert.deepEqual(pngPixel(image, 200, 1250), [1, 49, 98, 255])
    const footer = pngRow(image, 1254)
    assert.ok(Array.from({ length: 680 }, (_, index) => (index + 300) * 4)
      .some(offset => footer[offset] > 220 && footer[offset + 1] > 220 && footer[offset + 2] > 220),
    'the footer should contain the KarenBot attribution')
    const score = await new TakumiMaiRenderer(service, data).renderScore({ music, records: [record] })
    assert.equal(score.readUInt32BE(16), 1200)
    assert.equal(score.readUInt32BE(20), 1080)
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
        const background = await readFile(resolvePackageAssetPath('rating/background.png'))
        assert.deepEqual(pngPixel(image, 1000, 175), pngPixel(background, 1000, 175),
          `${name} should show the reference background without a title band`)
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

test('disabled new group uses the compact reference divider', async () => {
  const service = new TakumiRenderService()
  const renderer = new TakumiMaiRenderer(service, data)
  const input = {
    backend: 'test', player: new PlayerInfo('Player', 15384),
    oldRecords: [record], newRecords: [], oldCount: 10, newCount: 15,
  }
  try {
    const enabled = await renderer.renderRating(input)
    const disabled = await renderer.renderRating({ ...input, newGroupDisabled: true })
    assert.notDeepEqual(pngRow(disabled, 390).subarray(587 * 4, 692 * 4),
      pngRow(enabled, 390).subarray(587 * 4, 692 * 4))
    assert.notDeepEqual(pngPixel(disabled, 50, 415), pngPixel(enabled, 50, 415),
      'compact divider should move the new cards up')
  } finally {
    await service.dispose()
  }
})

test('record details stay inside the card artwork border', async () => {
  const service = new TakumiRenderService()
  const renderer = new TakumiMaiRenderer(service, data)
  const input = {
    backend: 'test', player: new PlayerInfo('Player', 15384),
    newRecords: [], oldCount: 1, newCount: 0,
  }
  try {
    const populated = await renderer.renderRating({ ...input, oldRecords: [record] })
    const empty = await renderer.renderRating({ ...input, oldRecords: [] })
    for (let y = 277; y < 283; y++) {
      const start = 43 * 4
      const end = 284 * 4
      assert.ok(pngRow(populated, y).subarray(start, end).equals(pngRow(empty, y).subarray(start, end)),
        `record details should not paint below the card border at y=${y}`)
    }
  } finally {
    await service.dispose()
  }
})
