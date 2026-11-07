import type { Node } from '@takumi-rs/helpers'
import type { MaimaiDataStore } from '../data/sync-service'
import type { CourseInfo } from '../data/normalizers'
import type { ChartInfo, RecordEntry } from '../domain/music'
import { resolvePackageAssetPath } from './assets'
import { RenderImageCollector, type RenderImageSource } from './image-collector'
import { createContainerNode, createImageNode, createTextNode } from './nodes'
import type { TakumiRenderService } from './renderer'

export const COURSE_TEMPLATE_SIZE = Object.freeze({ width: 974, height: 974 })

const FONT_H = '阿里巴巴普惠体-H'
const FONT_B_FALLBACK = "'阿里巴巴普惠体-B', '方正兰亭粗黑_GBK'"

export interface CourseSongRenderInput {
  chart: ChartInfo
  record?: RecordEntry | null
}

export interface CourseRenderInput {
  course: CourseInfo
  songs: readonly CourseSongRenderInput[]
}

export interface CourseRenderPlan {
  node: Node
  width: number
  height: number
  images: RenderImageSource[]
}

interface CourseSongResult extends CourseSongRenderInput {
  damage: number
  life: number
}

export function courseBackgroundVariant(courseId: number) {
  const realId = courseId % 10_000
  if (realId <= 1_010) return 1
  if (realId <= 1_112) return 2
  return 3
}

function minimumDamage(chart: ChartInfo, achievement: number, course: CourseInfo) {
  const totalBase = chart.notes.tap
    + chart.notes.touch
    + 2 * chart.notes.hold
    + 3 * chart.notes.slide
    + 5 * chart.notes.break
  if (totalBase <= 0) return 0
  const amount = Math.max(0, 1_010_000 - achievement) / (100_000 / totalBase)
  const candidates = [
    course.damage.great ? course.damage.great * Math.floor(amount / 2) : undefined,
    course.damage.good ? course.damage.good * Math.floor(amount / 5) : undefined,
    course.damage.miss ? course.damage.miss * Math.floor(amount / 10) : undefined,
  ].filter((value): value is number => value !== undefined)
  return candidates.length ? Math.min(...candidates) : 0
}

function courseResults(input: CourseRenderInput): CourseSongResult[] {
  let life = input.course.life
  return input.songs.slice(0, 4).map((song, index): CourseSongResult => {
    if (index > 0 && life > 0) life += input.course.recover
    const damage = song.record?.comboStatus.isAP()
      ? 0
      : minimumDamage(song.chart, song.record?.achievement ?? 0, input.course)
    life = Math.max(0, life - damage)
    return { ...song, damage, life }
  })
}

function courseAsset(name: string) {
  return resolvePackageAssetPath(`course/${name}.png`)
}

async function asset(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  name: string,
) {
  return collector.collect(service, courseAsset(name))
}

function scoreType(achievement: number) {
  return achievement < 800_000 ? 1 : achievement < 970_000 ? 2 : 3
}

/** Image-based achievement digits. `total` picks the per-KarenBot image family. */
async function achievementDigits(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  achievement: number,
  total: boolean,
): Promise<Node[]> {
  const type = scoreType(achievement)
  const part0 = String(Math.trunc(achievement / 10_000)).padStart(3, ' ')
  const part1 = String(achievement % 10_000).padStart(4, '0')

  const intPrefix = total ? 'score_2' : 'score_1'
  const decPrefix = total ? 'score_1' : 'score_3'
  const dotPrefix = total ? 'score_1' : 'score_3'
  const percentName = total ? `percent_1_${type}` : `percent_2_${type}`
  const noneName = total ? 'score_2_none' : 'score_1_none'

  const intMargins = total
    ? ['0 -10px 0 0', '0 -10px 0 0', '0 -20px 0 0']
    : ['0 -16px 0 0', '0 -10px 0 0', '0 -16px 0 0']
  const dotMargin = total ? '0 -20px -6px 0' : '0 -16px -6px 0'
  const decMargins = total
    ? ['0 -10px 0 0', '0 -10px 0 0', '0 -10px 0 0', '0 -12px 0 0']
    : ['0 -10px 0 0', '0 -10px 0 0', '0 -10px 0 0', '0 -10px 0 0']
  const percentMargin = total ? '0 0 0 0' : '0 0 0 2px'

  const specs: Array<{ name: string; margin: string }> = []
  ;[...part0].forEach((ch, i) => specs.push({
    name: ch === ' ' ? noneName : `${intPrefix}_${type}_${ch}`,
    margin: intMargins[i],
  }))
  specs.push({ name: `${dotPrefix}_${type}_dot`, margin: dotMargin })
  ;[...part1].forEach((ch, i) => specs.push({ name: `${decPrefix}_${type}_${ch}`, margin: decMargins[i] }))
  specs.push({ name: percentName, margin: percentMargin })

  const keys = await Promise.all(specs.map(spec => asset(collector, service, spec.name)))
  return keys.map((key, i) => createImageNode({
    src: key,
    style: { objectFit: 'none', margin: specs[i].margin, flexShrink: 0 },
  }))
}

/** Level images (level_N_level + digit images + plus). */
async function levelImages(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  chart: ChartInfo,
): Promise<Node[]> {
  const value = chart.difficulty.value
  const digits = [...chart.level].filter(ch => /\d/.test(ch))
  const [levelKey, plusKey, ...digitKeys] = await Promise.all([
    asset(collector, service, `level_${value}_level`),
    asset(collector, service, `level_${chart.level.endsWith('+') ? value : 5}_plus`),
    ...digits.map(ch => asset(collector, service, `level_${value}_${ch}`)),
  ])
  return [
    createImageNode({ src: levelKey, style: { objectFit: 'none', flexShrink: 0 } }),
    createContainerNode({
      style: { width: 70, justifyContent: 'center', margin: '0 0 0 -10px' },
      children: [
        createContainerNode({
          style: { justifyContent: 'center' },
          children: digitKeys.map((key, i) => createImageNode({
            src: key,
            style: { objectFit: 'none', margin: i === 0 ? '0 0 0 0' : '0 0 0 -12px', flexShrink: 0 },
          })),
        }),
        createImageNode({ src: plusKey, style: { objectFit: 'none', margin: '0 0 0 -14px', flexShrink: 0 } }),
      ],
    }),
  ]
}

async function songRow(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  data: MaimaiDataStore,
  result: CourseSongResult,
): Promise<Node> {
  const chart = result.chart
  const [cover, type, base, resultKey] = await Promise.all([
    collector.collect(service, data.coverPath(chart.music.resourceId), resolvePackageAssetPath('fallback/cover.png')),
    asset(collector, service, `type_${chart.music.type.value}`),
    asset(collector, service, `base_${chart.difficulty.name}`),
    asset(collector, service, `result_${result.life <= 0 ? 2 : 1}`),
  ])
  const accImages = await achievementDigits(collector, service, result.record?.achievement ?? 0, false)
  const levelImgs = await levelImages(collector, service, chart)

  return createContainerNode({
    className: 'course-song-row',
    style: { width: 690, height: 120, justifyContent: 'space-between', alignItems: 'center' },
    children: [
      createImageNode({ src: resultKey, style: { objectFit: 'none', flexShrink: 0 } }),
      createContainerNode({
        style: {
          width: 570,
          height: 120,
          backgroundImage: `url("${base}")`,
          backgroundSize: 'cover',
          padding: 5,
          justifyContent: 'space-between',
        },
        children: [
          createImageNode({
            src: cover,
            width: 107,
            height: 107,
            style: { width: 107, height: 107, margin: '2px 0 0 2px', objectFit: 'fill', flexShrink: 0 },
          }),
          createContainerNode({
            style: { width: 450, flexDirection: 'column' },
            children: [
              createContainerNode({
                style: { width: 450, padding: '1px 5px 0 0', justifyContent: 'flex-end' },
                children: [
                  createImageNode({ src: type, style: { margin: '0 13px 0 0', objectFit: 'none', flexShrink: 0 } }),
                  createContainerNode({
                    style: { width: 270, marginTop: 2 },
                    children: [createTextNode({
                      text: chart.music.name,
                      style: {
                        fontFamily: FONT_B_FALLBACK,
                        fontSize: 12,
                        display: 'inline-block',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        color: '#ffffff',
                      },
                    })],
                  }),
                ],
              }),
              createContainerNode({
                style: { width: 100, margin: '3px 0 -48px 368px', alignItems: 'flex-end' },
                children: levelImgs,
              }),
              createContainerNode({
                style: { width: 320, margin: '27px 0 0 6px', justifyContent: 'flex-end', alignItems: 'flex-end' },
                children: accImages,
              }),
              createContainerNode({
                style: { margin: '-18px 0 0 356px', alignItems: 'center' },
                children: [
                  createTextNode({ text: '扣血', style: { fontFamily: FONT_H, fontSize: 12, color: '#02359e' } }),
                  createTextNode({ text: `-${result.damage}`, style: { fontFamily: FONT_H, fontSize: 12, color: '#02359e', marginLeft: 20 } }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  })
}

async function courseStatus(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  course: CourseInfo,
  finalLife: number,
): Promise<Node> {
  const realId = course.id % 10_000
  const [finalBg, title] = await Promise.all([
    asset(collector, service, `final_${finalLife <= 0 ? 2 : 1}`),
    asset(collector, service, `title_${realId}`),
  ])
  return createContainerNode({
    id: 'status',
    style: {
      width: 300,
      height: 255,
      flexDirection: 'column',
      alignItems: 'center',
      backgroundImage: `url("${finalBg}")`,
      backgroundSize: 'cover',
      justifyContent: 'center',
      flexShrink: 0,
    },
    children: [createImageNode({ src: title, style: { margin: '42px 0 0 0', objectFit: 'none' } })],
  })
}

async function courseLifeCircle(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  finalLife: number,
): Promise<Node> {
  const lifeType = finalLife >= 100 ? 1 : finalLife >= 10 ? 2 : finalLife >= 1 ? 3 : 4
  const digits = String(finalLife).split('')
  const [lifeBg, ...digitKeys] = await Promise.all([
    asset(collector, service, `life_${lifeType}`),
    ...digits.map(ch => asset(collector, service, `life_${lifeType}_${ch}`)),
  ])
  return createContainerNode({
    id: 'life',
    style: {
      width: 210,
      height: 210,
      backgroundImage: `url("${lifeBg}")`,
      backgroundSize: 'cover',
      margin: '45px 0 0 -10px',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    children: digitKeys.map(key => createImageNode({ src: key, style: { objectFit: 'none', flexShrink: 0 } })),
  })
}

async function courseDetail(
  collector: RenderImageCollector,
  service: TakumiRenderService,
  course: CourseInfo,
  results: readonly CourseSongResult[],
): Promise<Node> {
  const total = results.reduce((sum, song) => sum + (song.record?.achievement ?? 0), 0)
  const [lifeLabelBg, dmg1, dmg2, dmg3, healBg] = await Promise.all([
    asset(collector, service, 'life'),
    asset(collector, service, 'damage_1'),
    asset(collector, service, 'damage_2'),
    asset(collector, service, 'damage_3'),
    asset(collector, service, 'heal'),
  ])
  const totalDigits = await achievementDigits(collector, service, total, true)
  const damages: Array<{ bg: string; value: number }> = [
    { bg: dmg1, value: course.damage.great },
    { bg: dmg2, value: course.damage.good },
    { bg: dmg3, value: course.damage.miss },
  ]

  return createContainerNode({
    id: 'detail',
    style: { width: 425, flexDirection: 'column', padding: '31px 0 0 0' },
    children: [
      createContainerNode({
        style: { width: 425 },
        children: [
          createTextNode({ text: '合计成绩', style: { fontFamily: FONT_H, fontSize: 18, margin: '0 0 0 20px', color: '#02359e' } }),
          createContainerNode({
            style: {
              width: 104,
              height: 24,
              backgroundImage: `url("${lifeLabelBg}")`,
              backgroundSize: 'cover',
              padding: 3,
              margin: '4px 0 0 115px',
              justifyContent: 'center',
            },
            children: [createTextNode({ text: String(course.life), style: { fontFamily: FONT_H, fontSize: 12, color: '#ade537', margin: '0 0 0 60px' } })],
          }),
        ],
      }),
      createContainerNode({
        style: { width: 408, margin: '20px 0 0 23px', justifyContent: 'flex-end', alignItems: 'flex-end' },
        children: totalDigits,
      }),
      createContainerNode({
        style: { width: 336, margin: '14px 0 0 78px', justifyContent: 'space-between' },
        children: damages.map(dmg => createContainerNode({
          style: {
            width: 104,
            height: 24,
            backgroundImage: `url("${dmg.bg}")`,
            backgroundSize: 'cover',
            padding: '0 0 1px 0',
            alignItems: 'center',
            justifyContent: 'center',
          },
          children: [createTextNode({ text: `-${dmg.value}`, style: { fontFamily: FONT_H, fontSize: 12, color: '#b0c0fe', margin: '0 0 0 58px' } })],
        })),
      }),
      createContainerNode({
        style: { width: 150, margin: '18px 0 0 316px', justifyContent: 'space-between' },
        children: [
          createContainerNode({
            style: {
              width: 91,
              height: 19,
              backgroundImage: `url("${healBg}")`,
              backgroundSize: 'cover',
              alignItems: 'center',
              justifyContent: 'center',
            },
            children: [createTextNode({ text: `+${course.recover}`, style: { fontFamily: FONT_H, fontSize: 12, color: '#ade537', margin: '0 0 0 32px' } })],
          }),
        ],
      }),
    ],
  })
}

function courseFooter(caption: string) {
  return createContainerNode({
    id: 'footer',
    style: { justifyContent: 'center', backgroundColor: '#013162', padding: 12 },
    children: [createTextNode({ text: caption, style: { fontSize: 22, fontFamily: FONT_H, color: '#ffffff', textShadow: '#000000 1px 1px' } })],
  })
}

export async function createCourseRenderPlan(
  input: CourseRenderInput,
  renderService: TakumiRenderService,
  data: MaimaiDataStore,
  footerText?: string,
): Promise<CourseRenderPlan> {
  const collector = new RenderImageCollector()
  const caption = (footerText ?? '').trim().replace(/\s+/gu, ' ')
  const variant = courseBackgroundVariant(input.course.id)
  const results = courseResults(input)
  const finalLife = results.at(-1)?.life ?? input.course.life

  const [background, status, lifeCircle, detail, ...rows] = await Promise.all([
    asset(collector, renderService, `background_${variant}`),
    courseStatus(collector, renderService, input.course, finalLife),
    courseLifeCircle(collector, renderService, finalLife),
    courseDetail(collector, renderService, input.course, results),
    ...results.map(result => songRow(collector, renderService, data, result)),
  ])

  return {
    width: COURSE_TEMPLATE_SIZE.width,
    height: COURSE_TEMPLATE_SIZE.height,
    images: collector.images,
    node: createContainerNode({
      id: 'course-template',
      style: {
        width: COURSE_TEMPLATE_SIZE.width,
        height: COURSE_TEMPLATE_SIZE.height,
        backgroundImage: `url("${background}")`,
        backgroundSize: 'cover',
        flexDirection: 'column',
        justifyContent: 'space-between',
        overflow: 'hidden',
      },
      children: [
        createContainerNode({
          id: 'upper',
          style: { width: 974, padding: '151px 0 0 0', flexDirection: 'column' },
          children: [
            createContainerNode({
              id: 'musics',
              style: { width: 974, height: 486, margin: '0 0 0 146px', justifyContent: 'space-between', flexDirection: 'column' },
              children: rows,
            }),
            createContainerNode({
              id: 'info',
              style: { height: 255, padding: '0 0 0 41px' },
              children: [status, lifeCircle, detail],
            }),
          ],
        }),
        courseFooter(caption),
      ],
    }),
  }
}
