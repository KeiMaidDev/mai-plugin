import { MusicDifficulty, MusicGenre, MusicType } from '../domain/enums'
import { ChartInfo, MusicInfo, Notes, type GameVersion } from '../domain/music'

export interface PlateInfo {
  id: number
  filename: string
  name: string
  genre: string
  hint: string
  requires: number[]
  remasters: number[]
}

export interface IconInfo {
  id: number
  filename: string
  name: string
  genre: string
  hint: string
}

export interface CourseMusicInfo {
  id: number
  name: string
  difficulty: number
}

export interface CourseDamage {
  perfect: number
  great: number
  good: number
  miss: number
}

export interface CourseInfo {
  id: number
  name: string
  mode: number
  random: boolean
  lower: number
  upper: number
  musics: CourseMusicInfo[]
  life: number
  recover: number
  damage: CourseDamage
}

export interface NormalizedMaimaiSource {
  revision: string
  versions: Map<string, GameVersion>
  musics: Map<number, MusicInfo>
  plates: Map<number, PlateInfo>
  icons: Map<number, IconInfo>
  courses: Map<number, CourseInfo>
}

type UnknownRecord = Record<string, unknown>

export interface DivingFishChartMetadata {
  musicId: number
  charts: Array<{
    difficulty: number
    notes: [number, number, number, number, number]
    notesDesigner: string
    fitLevelValue: number
  }>
}

function record(value: unknown, path: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`)
  }
  return value as UnknownRecord
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

function string(value: unknown, path: string, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new TypeError(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function number(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be a finite number from ${minimum} to ${maximum}`)
  }
  return value
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const result = number(value, path, minimum, maximum)
  if (!Number.isSafeInteger(result)) throw new TypeError(`${path} must be an integer`)
  return result
}

function boolean(value: unknown, path: string) {
  if (typeof value !== 'boolean') throw new TypeError(`${path} must be a boolean`)
  return value
}

function uniqueMap<T>(items: T[], key: (item: T) => number, path: string) {
  const result = new Map<number, T>()
  for (const item of items) {
    const id = key(item)
    if (result.has(id)) throw new TypeError(`${path} contains duplicate ID ${id}`)
    result.set(id, item)
  }
  return result
}

function musicGenre(value: unknown, path: string) {
  const name = string(value, path)
  const genre = MusicGenre.values.find(entry =>
    entry.value === name || entry.genreName === name || entry.names.includes(name),
  )
  if (!genre) throw new TypeError(`${path} contains unknown music genre ${JSON.stringify(name)}`)
  return genre
}

function musicType(value: unknown, path: string) {
  const name = string(value, path)
  if (name === 'standard') return MusicType.Standard
  if (name === 'dx') return MusicType.Deluxe
  try {
    return MusicType.of(name)
  } catch {
    throw new TypeError(`${path} contains unknown music type ${JSON.stringify(name)}`)
  }
}

function notes(value: unknown, path: string) {
  if (Array.isArray(value)) {
    if (value.length !== 4 && value.length !== 5) {
      throw new TypeError(`${path} notes must contain exactly 4 or 5 counts`)
    }
    const counts = value.map((entry, index) => integer(entry, `${path}[${index}]`))
    return counts.length === 4
      ? new Notes(counts[0], counts[1], counts[2], 0, counts[3])
      : new Notes(counts[0], counts[1], counts[2], counts[3], counts[4])
  }

  const input = record(value, path)
  return new Notes(
    integer(input.tap, `${path}.tap`),
    integer(input.hold, `${path}.hold`),
    integer(input.slide, `${path}.slide`),
    input.touch === undefined ? 0 : integer(input.touch, `${path}.touch`),
    integer(input.break ?? input.breakNotes, `${path}.break`),
  )
}

function integerList(value: unknown, path: string) {
  return array(value, path).map((entry, index) => integer(entry, `${path}[${index}]`, 1))
}

function divingFishFitLevels(value: unknown) {
  if (value === undefined || value === null) return new Map<number, number[]>()
  const input = record(value, 'divingFishChartStats')
  const charts = record(input.charts, 'divingFishChartStats.charts')
  const result = new Map<number, number[]>()
  for (const [idText, entries] of Object.entries(charts)) {
    if (!/^\d+$/.test(idText)) {
      throw new TypeError('divingFishChartStats.charts contains an invalid music ID')
    }
    const values = array(entries, `divingFishChartStats.charts.${idText}`).map((entry, index) => {
      const path = `divingFishChartStats.charts.${idText}[${index}]`
      const chart = record(entry, path)
      return chart.fit_diff === undefined
        ? 0
        : number(chart.fit_diff, `${path}.fit_diff`, 0, 20)
    })
    result.set(Number(idText), values)
  }
  return result
}

export function extractDivingFishChartMetadata(
  value: unknown,
  chartStats?: unknown,
): DivingFishChartMetadata[] {
  const fitLevels = divingFishFitLevels(chartStats)
  return array(value, 'divingFishMusicData').flatMap((entry, musicIndex) => {
    const path = `divingFishMusicData[${musicIndex}]`
    const input = record(entry, path)
    const idText = string(input.id, `${path}.id`)
    if (!/^\d+$/.test(idText)) throw new TypeError(`${path}.id must contain digits only`)
    const musicId = Number(idText)
    const chartInputs = array(input.charts, `${path}.charts`)
    const charts = chartInputs.map((chartEntry, chartIndex) => {
      const chartPath = `${path}.charts[${chartIndex}]`
      const chart = record(chartEntry, chartPath)
      const parsedNotes = notes(chart.notes, `${chartPath}.notes`)
      return {
        difficulty: chartIndex,
        notes: [
          parsedNotes.tap,
          parsedNotes.hold,
          parsedNotes.slide,
          parsedNotes.touch,
          parsedNotes.break,
        ] as [number, number, number, number, number],
        notesDesigner: string(chart.charter ?? '', `${chartPath}.charter`, true),
        fitLevelValue: fitLevels.get(musicId)?.[chartIndex] ?? 0,
      }
    })
    return charts.length ? [{ musicId, charts }] : []
  })
}

function normalizeChartMetadata(value: unknown) {
  const entries = array(value ?? [], 'chartMetadata').map((entry, musicIndex) => {
    const path = `chartMetadata[${musicIndex}]`
    const input = record(entry, path)
    const musicId = integer(input.musicId, `${path}.musicId`, 1)
    const charts = array(input.charts, `${path}.charts`).map((chartEntry, chartIndex) => {
      const chartPath = `${path}.charts[${chartIndex}]`
      const chart = record(chartEntry, chartPath)
      const parsedNotes = notes(chart.notes, `${chartPath}.notes`)
      return {
        difficulty: integer(chart.difficulty, `${chartPath}.difficulty`, 0, 10),
        notes: [
          parsedNotes.tap,
          parsedNotes.hold,
          parsedNotes.slide,
          parsedNotes.touch,
          parsedNotes.break,
        ] as [number, number, number, number, number],
        notesDesigner: string(chart.notesDesigner ?? '', `${chartPath}.notesDesigner`, true),
        fitLevelValue: chart.fitLevelValue === undefined
          ? 0
          : number(chart.fitLevelValue, `${chartPath}.fitLevelValue`, 0, 20),
      }
    })
    return { musicId, charts }
  })
  return uniqueMap(entries, entry => entry.musicId, 'chartMetadata')
}

export function parseDivingFishChartMetadata(value: unknown) {
  return [...normalizeChartMetadata(value).values()]
}

function normalizeVersions(value: unknown) {
  const versions = array(value, 'versions').map((entry, index): GameVersion => {
    const input = record(entry, `versions[${index}]`)
    return {
      id: integer(input.id, `versions[${index}].id`, 0),
      name: string(input.name, `versions[${index}].name`),
      version: integer(input.version, `versions[${index}].version`, 0),
    }
  })
  if (!versions.length) throw new TypeError('versions must contain at least one item')
  versions.sort((left, right) => left.version - right.version || left.id - right.id)
  const result = new Map<string, GameVersion>()
  for (const version of versions) {
    if (result.has(version.name)) throw new TypeError(`versions contains duplicate name ${JSON.stringify(version.name)}`)
    result.set(version.name, version)
  }
  return result
}

function normalizeMusics(value: unknown, versions: Map<string, GameVersion>) {
  const newestVersion = [...versions.values()].at(-1)!
  const musics = array(value, 'musics').map((entry, musicIndex) => {
    const path = `musics[${musicIndex}]`
    const input = record(entry, path)
    const id = integer(input.id, `${path}.id`, 1)
    const versionName = string(input.version, `${path}.version`)
    const version = versions.get(versionName)
    if (!version) throw new TypeError(`${path}.version references unknown version ${JSON.stringify(versionName)}`)
    const genre = musicGenre(input.genre, `${path}.genre`)
    const music = new MusicInfo(
      id,
      string(input.name ?? input.title, `${path}.name`),
      musicType(input.type, `${path}.type`),
      string(input.rights ?? '', `${path}.rights`, true),
      string(input.artist, `${path}.artist`, true),
      genre,
      integer(input.bpm, `${path}.bpm`, 0, 1_000),
      version,
      input.isNew === undefined ? version === newestVersion : boolean(input.isNew, `${path}.isNew`),
    )
    const chartInputs = array(input.charts, `${path}.charts`)
    if (!chartInputs.length) throw new TypeError(`${path}.charts must contain at least one chart`)
    if (genre !== MusicGenre.Utage && chartInputs.length > 5) {
      throw new TypeError(`${path}.charts contains more than five ordered difficulties`)
    }
    music.charts = chartInputs.map((chartEntry, chartIndex) => {
      const chartPath = `${path}.charts[${chartIndex}]`
      const chart = record(chartEntry, chartPath)
      const expectedDifficulty = genre === MusicGenre.Utage ? MusicDifficulty.Utage.value : chartIndex
      const actualDifficulty = integer(chart.difficulty, `${chartPath}.difficulty`, 0, 10)
      if (actualDifficulty !== expectedDifficulty) {
        throw new TypeError(`${chartPath} violates difficulty order: expected ${expectedDifficulty}, received ${actualDifficulty}`)
      }
      const result = new ChartInfo(
        music,
        MusicDifficulty.of(expectedDifficulty),
        string(chart.level, `${chartPath}.level`),
        number(chart.levelValue ?? chart.ds, `${chartPath}.levelValue`, 0, 20),
        notes(chart.notes, `${chartPath}.notes`),
        string(chart.notesDesigner ?? chart.charter ?? '', `${chartPath}.notesDesigner`, true),
      )
      result.fitLevelValue = chart.fitLevelValue === undefined
        ? 0
        : number(chart.fitLevelValue, `${chartPath}.fitLevelValue`, 0, 20)
      return result
    })
    return music
  })
  if (!musics.length) throw new TypeError('musics must contain at least one item')
  return uniqueMap(musics, music => music.id, 'musics')
}

function normalizeCollections(value: unknown, path: string) {
  return array(value ?? [], path).map((entry, index) => {
    const entryPath = `${path}[${index}]`
    const input = record(entry, entryPath)
    const id = integer(input.id, `${entryPath}.id`, 1)
    return {
      id,
      filename: `${id}.png`,
      name: string(input.name, `${entryPath}.name`),
      genre: string(input.genre ?? '', `${entryPath}.genre`, true),
      hint: string(input.description ?? input.hint ?? '', `${entryPath}.hint`, true),
      requires: [],
      remasters: [],
    }
  })
}

function normalizePlates(value: unknown) {
  const plates = array(value, 'plates').map((entry, index): PlateInfo => {
    const path = `plates[${index}]`
    const input = record(entry, path)
    return {
      id: integer(input.id, `${path}.id`, 1),
      filename: string(input.filename, `${path}.filename`),
      name: string(input.name, `${path}.name`),
      genre: string(input.genre, `${path}.genre`, true),
      hint: string(input.hint, `${path}.hint`, true),
      requires: integerList(input.requires, `${path}.requires`),
      remasters: integerList(input.remasters, `${path}.remasters`),
    }
  })
  return uniqueMap(plates, plate => plate.id, 'plates')
}

function normalizeIcons(value: unknown) {
  const icons = array(value, 'icons').map((entry, index): IconInfo => {
    const path = `icons[${index}]`
    const input = record(entry, path)
    return {
      id: integer(input.id, `${path}.id`, 1),
      filename: string(input.filename, `${path}.filename`),
      name: string(input.name, `${path}.name`),
      genre: string(input.genre, `${path}.genre`, true),
      hint: string(input.hint, `${path}.hint`, true),
    }
  })
  return uniqueMap(icons, icon => icon.id, 'icons')
}

function normalizeCourses(value: unknown, musics: Map<number, MusicInfo>) {
  const courses = array(value, 'courses').map((entry, index): CourseInfo => {
    const path = `courses[${index}]`
    const input = record(entry, path)
    const courseMusics = array(input.musics, `${path}.musics`).map((musicEntry, musicIndex): CourseMusicInfo => {
      const musicPath = `${path}.musics[${musicIndex}]`
      const musicInput = record(musicEntry, musicPath)
      const id = integer(musicInput.id, `${musicPath}.id`, 1)
      const difficulty = integer(musicInput.difficulty, `${musicPath}.difficulty`, 0, 10)
      const music = musics.get(id)
      if (!music) throw new TypeError(`${musicPath}.id references unknown music ${id}`)
      if (!music.charts.some(chart => chart.difficulty.value === difficulty)) {
        throw new TypeError(`${musicPath}.difficulty references a missing chart`)
      }
      return { id, name: string(musicInput.name ?? '', `${musicPath}.name`, true), difficulty }
    })
    const damageInput = record(input.damage, `${path}.damage`)
    return {
      id: integer(input.id, `${path}.id`, 1),
      name: string(input.name, `${path}.name`),
      mode: integer(input.mode, `${path}.mode`),
      random: boolean(input.random, `${path}.random`),
      lower: number(input.lower, `${path}.lower`, 0, 20),
      upper: number(input.upper, `${path}.upper`, 0, 20),
      musics: courseMusics,
      life: integer(input.life, `${path}.life`),
      recover: integer(input.recover, `${path}.recover`),
      damage: {
        perfect: integer(damageInput.perfect, `${path}.damage.perfect`),
        great: integer(damageInput.great, `${path}.damage.great`),
        good: integer(damageInput.good, `${path}.damage.good`),
        miss: integer(damageInput.miss, `${path}.damage.miss`),
      },
    }
  })
  return uniqueMap(courses, course => course.id, 'courses')
}

function fromDivingFish(
  value: unknown[],
  revision: string,
  chartMetadata = new Map<number, DivingFishChartMetadata>(),
  collections: { icons?: unknown; plates?: unknown } = {},
): UnknownRecord {
  const versionNames: string[] = []
  for (const [index, entry] of value.entries()) {
    const input = record(entry, `musics[${index}]`)
    const basicInfo = record(input.basic_info, `musics[${index}].basic_info`)
    const version = string(basicInfo.from, `musics[${index}].basic_info.from`)
    if (!versionNames.includes(version)) versionNames.push(version)
  }
  return {
    revision,
    versions: versionNames.map((name, index) => ({ id: index + 1, name, version: index + 1 })),
    musics: value.flatMap((entry, musicIndex) => {
      const path = `musics[${musicIndex}]`
      const input = record(entry, path)
      const title = string(input.title, `${path}.title`, true).trim()
      if (!title) return []
      const basicInfo = record(input.basic_info, `${path}.basic_info`)
      const chartInputs = array(input.charts, `${path}.charts`)
      const levels = array(input.level, `${path}.level`)
      const constants = array(input.ds, `${path}.ds`)
      if (chartInputs.length !== levels.length || chartInputs.length !== constants.length) {
        throw new TypeError(`${path} chart, level, and constant counts must match`)
      }
      const idText = string(input.id, `${path}.id`)
      if (!/^\d+$/.test(idText)) throw new TypeError(`${path}.id must contain digits only`)
      const genre = musicGenre(basicInfo.genre, `${path}.basic_info.genre`)
      return [{
        id: Number(idText),
        name: title,
        type: input.type,
        rights: '',
        artist: basicInfo.artist,
        genre: genre.value,
        bpm: basicInfo.bpm,
        version: basicInfo.from,
        isNew: basicInfo.is_new,
        charts: chartInputs.map((chartEntry, chartIndex) => {
          const chart = record(chartEntry, `${path}.charts[${chartIndex}]`)
          return {
            difficulty: genre === MusicGenre.Utage ? MusicDifficulty.Utage.value : chartIndex,
            level: levels[chartIndex],
            levelValue: constants[chartIndex],
            notes: chart.notes,
            notesDesigner: chart.charter,
            fitLevelValue: chartMetadata.get(Number(idText))?.charts.find(entry => (
              entry.difficulty === chartIndex
            ))?.fitLevelValue ?? 0,
          }
        }),
      }]
    }),
    plates: normalizeCollections(collections.plates, 'plates'),
    icons: normalizeCollections(collections.icons, 'icons'),
    courses: [],
  }
}

function fromLxns(value: UnknownRecord, revision: string): UnknownRecord {
  const chartMetadata = normalizeChartMetadata(value.chartMetadata ?? [])
  const versionInputs = array(value.versions, 'versions')
  const versions = versionInputs.map((entry, index) => {
    const input = record(entry, `versions[${index}]`)
    return {
      id: integer(input.id, `versions[${index}].id`, 0),
      name: string(input.title, `versions[${index}].title`),
      version: integer(input.version, `versions[${index}].version`, 0),
    }
  })
  const sortedVersions = [...versions].sort((left, right) => left.version - right.version)
  const versionName = (version: number) => (
    sortedVersions.filter(candidate => candidate.version <= version).at(-1)?.name
  )

  const musics = array(value.songs, 'songs').flatMap((entry, songIndex) => {
    const path = `songs[${songIndex}]`
    const input = record(entry, path)
    const title = string(input.title, `${path}.title`, true).trim()
    if (!title) return []
    const id = integer(input.id, `${path}.id`, 1)
    const version = integer(input.version, `${path}.version`, 0)
    const resolvedVersionName = versionName(version)
    if (!resolvedVersionName) throw new TypeError(`${path}.version references unknown version ${version}`)
    const difficulties = record(input.difficulties, `${path}.difficulties`)

    return (['standard', 'dx', 'utage'] as const).flatMap(type => {
      const charts = array(difficulties[type] ?? [], `${path}.difficulties.${type}`)
      if (!charts.length) return []
      const genre = type === 'utage' ? MusicGenre.Utage.value : string(input.genre, `${path}.genre`)
      const musicId = type === 'dx' && id < 10_000 ? id + 10_000 : id
      return [{
        id: musicId,
        name: title,
        type: type === 'dx' ? 'dx' : 'standard',
        rights: '',
        artist: string(input.artist, `${path}.artist`, true),
        genre,
        bpm: number(input.bpm, `${path}.bpm`, 0, 1_000),
        version: resolvedVersionName,
        charts: charts.map((chartEntry, chartIndex) => {
          const chartPath = `${path}.difficulties.${type}[${chartIndex}]`
          const chart = record(chartEntry, chartPath)
          const notesInput = chart.notes === undefined || chart.notes === null
            ? null
            : record(chart.notes, `${chartPath}.notes`)
          const difficulty = type === 'utage'
            ? MusicDifficulty.Utage.value
            : integer(chart.difficulty, `${chartPath}.difficulty`, 0, 4)
          const metadata = chartMetadata.get(musicId)?.charts.find(entry => (
            entry.difficulty === difficulty
          ))
          const designer = string(chart.note_designer ?? '', `${chartPath}.note_designer`, true)
          return {
            difficulty,
            level: string(chart.level, `${chartPath}.level`),
            levelValue: number(chart.level_value, `${chartPath}.level_value`, 0, 20),
            notes: notesInput
              ? [
                  integer(notesInput.tap ?? 0, `${chartPath}.notes.tap`),
                  integer(notesInput.hold ?? 0, `${chartPath}.notes.hold`),
                  integer(notesInput.slide ?? 0, `${chartPath}.notes.slide`),
                  integer(notesInput.touch ?? 0, `${chartPath}.notes.touch`),
                  integer(notesInput.break ?? 0, `${chartPath}.notes.break`),
                ]
              : metadata?.notes ?? [0, 0, 0, 0, 0],
            notesDesigner: designer.trim() ? designer : metadata?.notesDesigner ?? '',
            fitLevelValue: metadata?.fitLevelValue ?? 0,
          }
        }),
      }]
    })
  })

  return {
    revision,
    versions,
    musics,
    icons: normalizeCollections(value.icons, 'icons'),
    plates: normalizeCollections(value.plates, 'plates'),
    courses: [],
  }
}

export function normalizeMaimaiSource(value: unknown, options: { revision?: string } = {}): NormalizedMaimaiSource {
  const raw = Array.isArray(value) ? value : record(value, 'source')
  const input = Array.isArray(raw)
    ? fromDivingFish(raw, options.revision ?? 'diving-fish')
    : raw.sourceType === 'lxns'
      ? fromLxns(raw, string(raw.revision ?? options.revision, 'revision'))
      : raw.sourceType === 'diving-fish'
        ? fromDivingFish(
            array(raw.musicData, 'musicData'),
            string(raw.revision ?? options.revision, 'revision'),
            normalizeChartMetadata(raw.chartMetadata ?? []),
            { icons: raw.icons, plates: raw.plates },
          )
      : raw
  const revision = string(input.revision ?? options.revision, 'revision')
  const versions = normalizeVersions(input.versions)
  const musics = normalizeMusics(input.musics, versions)
  return {
    revision,
    versions,
    musics,
    plates: normalizePlates(input.plates),
    icons: normalizeIcons(input.icons),
    courses: normalizeCourses(input.courses, musics),
  }
}
