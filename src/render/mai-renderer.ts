import type { MaimaiDataStore } from '../data/sync-service'
import { DEFAULT_RATING_FOOTER_TEXT } from '../constants'
import {
  createCourseRenderPlan,
  type CourseRenderInput,
} from './course-template'
import {
  createLevelRenderPlan,
  type LevelRenderInput,
} from './level-template'
import {
  createRatingRenderPlan,
  type RatingRenderInput,
} from './rating-template'
import {
  renderRadarPlan,
  type RadarRenderInput,
} from './radar-template'
import {
  createScoreRenderPlan,
  type ScoreRenderInput,
} from './score-template'
import type { TakumiRenderService } from './renderer'

export interface MaiRenderer {
  renderRating(input: RatingRenderInput, signal?: AbortSignal): Promise<Buffer>
  renderScore(input: ScoreRenderInput, signal?: AbortSignal): Promise<Buffer>
  renderLevel(input: LevelRenderInput, signal?: AbortSignal): Promise<Buffer>
  renderCourse(input: CourseRenderInput, signal?: AbortSignal): Promise<Buffer>
  renderRadar(input: RadarRenderInput, signal?: AbortSignal): Promise<Buffer>
}

export class TakumiMaiRenderer implements MaiRenderer {
  constructor(
    readonly renderService: TakumiRenderService,
    readonly data: MaimaiDataStore,
    readonly ratingFooterText = DEFAULT_RATING_FOOTER_TEXT,
  ) {}

  async renderRating(input: RatingRenderInput, signal?: AbortSignal): Promise<Buffer> {
    const plan = await createRatingRenderPlan(input, this.renderService, this.data, this.ratingFooterText)
    return this.renderService.render(plan.node, {
      width: plan.width,
      height: plan.height,
      format: 'png',
    }, signal)
  }

  async renderScore(input: ScoreRenderInput, signal?: AbortSignal): Promise<Buffer> {
    const plan = await createScoreRenderPlan(input, this.renderService, this.data)
    return this.renderService.render(plan.node, {
      width: plan.width,
      height: plan.height,
      format: 'png',
    }, signal)
  }

  async renderLevel(input: LevelRenderInput, signal?: AbortSignal): Promise<Buffer> {
    const plan = await createLevelRenderPlan(input, this.renderService, this.data)
    return this.renderService.render(plan.node, {
      width: plan.width,
      height: plan.height,
      format: 'png',
    }, signal)
  }

  async renderCourse(input: CourseRenderInput, signal?: AbortSignal): Promise<Buffer> {
    const plan = await createCourseRenderPlan(input, this.renderService, this.data)
    return this.renderService.render(plan.node, {
      width: plan.width,
      height: plan.height,
      format: 'png',
    }, signal)
  }

  renderRadar(input: RadarRenderInput, signal?: AbortSignal): Promise<Buffer> {
    return renderRadarPlan(input, this.renderService, signal)
  }
}
