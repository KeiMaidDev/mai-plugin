import type { Context } from 'koishi'
import { CallbackTokenError } from './callback-store'
import { resolveLxnsCallbackPath } from './lxns-callback'

export interface MaiRouteService {
  completeLxnsOAuth(state: string, code: string): Promise<void>
}

export interface MaiServerRouteOptions {
  service: MaiRouteService
  lxnsCallbackPath?: string
}

interface RouteContext {
  method: string
  host: string
  headers: Record<string, string | string[] | undefined>
  url: string
  query: Record<string, string | string[] | undefined>
  params: Record<string, string | undefined>
  status: number
  body: unknown
  type: string
  set(name: string, value: string): void
  redirect(url: string): void
}

type RouteNext = () => Promise<unknown>
type RouteLayer = object
interface ServerRouter {
  stack: RouteLayer[]
  all(
    path: string,
    handler: (context: unknown, next: RouteNext) => unknown,
  ): unknown
}

function queryValue(value: string | string[] | undefined, maxLength: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : null
}

function allowGet(ctx: RouteContext) {
  if (ctx.method === 'GET') return true
  ctx.set('Allow', 'GET')
  ctx.status = 405
  ctx.body = 'Method Not Allowed'
  return false
}

function callbackFailure(ctx: RouteContext, error: unknown) {
  if (error instanceof CallbackTokenError) {
    ctx.status = 400
    ctx.body = 'Invalid or expired callback token.'
    return
  }
  ctx.status = 502
  ctx.body = 'Callback processing failed.'
}

export function registerMaiServerRoutes(
  ctx: Context,
  options: MaiServerRouteOptions,
) {
  const router = (ctx as Context & { server: ServerRouter }).server
  const previousLayers = new Set(router.stack)
  const lxnsCallbackPath = resolveLxnsCallbackPath(options.lxnsCallbackPath)

  router.all(lxnsCallbackPath, async (routeContext: unknown) => {
    const route = routeContext as unknown as RouteContext
    if (!allowGet(route)) return
    const state = queryValue(route.query.state, 128)
    const code = queryValue(route.query.code, 2_048)
    if (!state || !code) {
      route.status = 400
      route.body = 'Missing state or code.'
      return
    }
    try {
      await options.service.completeLxnsOAuth(state, code)
      route.status = 200
      route.body = '绑定成功，您可以返回继续使用相关功能了。'
    } catch (error) {
      callbackFailure(route, error)
    }
  })

  const layers = router.stack.filter(layer => !previousLayers.has(layer))
  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      for (const layer of layers) {
        const index = router.stack.indexOf(layer)
        if (index >= 0) router.stack.splice(index, 1)
      }
    },
  }
}
