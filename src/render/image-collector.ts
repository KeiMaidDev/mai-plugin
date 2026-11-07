import type { TakumiRenderService } from './renderer'

export interface RenderImageSource {
  src: string
  data: Buffer
}

/**
 * Collects the local PNG buffers a render plan references by string key, so
 * the node tree can address them through CSS backgroundImage/maskImage and
 * ImageNode.src. Deduplicates by the resolved asset path.
 */
export class RenderImageCollector {
  private readonly sources: RenderImageSource[] = []
  private readonly keyByPath = new Map<string, string>()

  async collect(
    service: TakumiRenderService,
    path: string | Promise<string>,
    fallbackPath?: string,
  ): Promise<string> {
    const resolved = await path
    const existing = this.keyByPath.get(resolved)
    if (existing) return existing
    const data = await service.loadAsset(resolved, fallbackPath)
    const key = `img${this.sources.length}`
    this.sources.push({ src: key, data })
    this.keyByPath.set(resolved, key)
    return key
  }

  get images(): RenderImageSource[] {
    return this.sources
  }
}
