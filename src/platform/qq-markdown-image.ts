import h from '@satorijs/element'
import { imageSize } from 'image-size'
import { createQqNativeMarkdown, type QqKeyboard } from './qq-message'

export interface AssetTransformer {
  transform(content: string): Promise<string>
}

export interface QqMarkdownImageOptions {
  image: Buffer | Uint8Array
  alt: string
  /** Bold heading rendered above the image, matching the reference result message. */
  title?: string
  /** Lines rendered below the image as a Markdown quote block. */
  caption?: readonly string[]
  /** How caption lines are rendered. Query results quote them; guess cards do not. */
  captionStyle?: 'quote' | 'plain'
  /** Inline Markdown size, in pixels. Defaults to the image's own pixel size. */
  displaySize?: { width: number, height: number }
  /** MIME type declared to the assets service. Defaults to PNG. */
  mimeType?: string
  keyboard?: QqKeyboard
  assets: AssetTransformer
}

export const DEFAULT_QQ_MARKDOWN_MIME_TYPE = 'image/png'

function assertDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError('QQ Markdown image dimensions must be positive integers.')
  }
}

function assertImageAlt(alt: string) {
  const normalized = alt.trim()
  if (!normalized) throw new TypeError('QQ Markdown image alt text must be non-empty.')
  if (normalized !== alt || /[\r\n\]]/u.test(normalized)) {
    throw new TypeError('QQ Markdown image alt text must be a single line without brackets.')
  }
  return normalized
}

function parsePublicImageUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('QQ Markdown images require an absolute HTTP(S) URL.')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new TypeError('QQ Markdown images require an absolute HTTP(S) URL without credentials.')
  }
  return url
}

export function createQqMarkdownImageContent(url: string, width: number, height: number, alt: string) {
  assertDimensions(width, height)
  const label = assertImageAlt(alt)
  const serializedUrl = parsePublicImageUrl(url)
    .toString()
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
  return `![${label} #${width}px #${height}px](${serializedUrl})`
}

/**
 * Assemble the result message the way the reference implementation does: a bold
 * heading line, the image, then the caption. Query results quote the caption;
 * guess cards append it as plain lines.
 */
export function createQqMarkdownResultContent(
  imageLine: string,
  title?: string,
  caption: readonly string[] = [],
  captionStyle: 'quote' | 'plain' = 'quote',
) {
  const blocks: string[] = []
  const heading = title?.trim()
  if (heading) blocks.push(`**${heading}**`)
  blocks.push(imageLine)
  const lines = caption.filter(line => line.trim())
  if (lines.length) {
    blocks.push(captionStyle === 'quote' ? lines.map(line => `> ${line}`).join('\n') : lines.join('\n'))
  }
  return blocks.join('\n\n')
}

function transformedImageUrl(content: string) {
  const elements = h.parse(content)
  const nonEmptyElements = elements.filter(element => (
    element.type !== 'text' || String(element.attrs.content ?? '').trim()
  ))
  if (nonEmptyElements.length !== 1 || nonEmptyElements[0].type !== 'img') {
    throw new TypeError('Assets transformation must return exactly one image.')
  }
  const image = nonEmptyElements[0]
  if (image.children.length || typeof image.attrs.src !== 'string') {
    throw new TypeError('Assets transformation returned an invalid image.')
  }
  return parsePublicImageUrl(image.attrs.src).toString()
}

export async function transformAssetImageUrl(
  image: Buffer | Uint8Array,
  mimeType: string,
  assets: AssetTransformer,
) {
  if (!/^image\/(?:png|jpe?g|webp)$/i.test(mimeType)) {
    throw new TypeError('Assets image transformation requires a supported image MIME type.')
  }
  const transformed = await assets.transform(h.image(Buffer.from(image), mimeType).toString())
  return transformedImageUrl(transformed)
}

export async function createQqMarkdownImage(options: QqMarkdownImageOptions) {
  const image = Buffer.from(options.image)
  const mimeType = options.mimeType ?? DEFAULT_QQ_MARKDOWN_MIME_TYPE
  const size = options.displaySize ?? imageSize(image)
  assertDimensions(size.width, size.height)
  const transformed = await options.assets.transform(h.image(image, mimeType).toString())
  const content = createQqMarkdownResultContent(
    createQqMarkdownImageContent(transformedImageUrl(transformed), size.width, size.height, options.alt),
    options.title,
    options.caption,
    options.captionStyle,
  )
  return createQqNativeMarkdown(content, options.keyboard)
}
