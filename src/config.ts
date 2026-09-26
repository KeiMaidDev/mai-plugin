import Schema from 'schemastery'
import { DEFAULT_RATING_FOOTER_TEXT } from './constants'
import {
  DEFAULT_LXNS_CALLBACK_PATH,
  LXNS_CALLBACK_PATH_PATTERN,
} from './server/lxns-callback'

export interface Config {
  developerTokens: {
    lxns: string
  }
  divingFishOAuth: {
    clientId: string
    clientSecret: string
  }
  oauth: {
    enabled: boolean
    authorizationUrl: string
    callbackPath?: string
    clientId: string
    clientSecret: string
    tokenCipherKey: string
  }
  resourceSync: {
    enabled: boolean
    intervalMinutes: number
    timeoutMs: number
    cacheDir: string
    staticBaseUrl: string
    allowedHosts: string[]
  }
  render: {
    concurrency: number
    queueLimit: number
    timeoutMs: number
  }
  ratingFooterText: string
  publicBaseUrl: string
  administrators: string[]
  compatibilityMode: boolean
  debugMode: boolean
}

const secret = () => Schema.string().role('secret').default('')

export const ConfigSchema: Schema<Config> = Schema.object({
  developerTokens: Schema.object({
    lxns: secret().description('LXNS 开发者令牌，用于查询成绩并同步 LXNS 曲目与收藏品数据。'),
  }).description('开发者令牌'),
  divingFishOAuth: Schema.object({
    clientId: secret().description('水鱼客户端 ID。'),
    clientSecret: secret().description('水鱼客户端密钥。'),
  }).description('水鱼 OAuth 设置'),
  oauth: Schema.object({
    enabled: Schema.boolean().default(false)
      .description('是否启用 LXNS OAuth 用户授权和成绩同步。'),
    authorizationUrl: Schema.string().default('')
      .description('LXNS 开发者面板生成的完整 OAuth 授权链接'),
    callbackPath: Schema.string()
      .pattern(LXNS_CALLBACK_PATH_PATTERN)
      .default(DEFAULT_LXNS_CALLBACK_PATH)
      .description('LXNS OAuth 回调路径。'),
    clientId: secret().description('LXNS OAuth 客户端 ID。'),
    clientSecret: secret().description('LXNS OAuth 客户端密钥。'),
    tokenCipherKey: secret()
      .description('用于加密持久化 OAuth 令牌的密钥；启用 OAuth 时必须配置。'),
  }).description('LXNS OAuth 设置'),
  resourceSync: Schema.object({
    enabled: Schema.boolean().default(true)
      .description('是否在启动时同步数据'),
    intervalMinutes: Schema.natural().min(1).max(1_440).default(60)
      .description('资源同步检查间隔，单位为分钟'),
    timeoutMs: Schema.natural().min(1_000).max(120_000).default(10_000)
      .description('单个资源请求的超时时间，单位为毫秒'),
    cacheDir: Schema.string().min(1).max(512).default('data/maimai')
      .description('资源缓存目录'),
    staticBaseUrl: Schema.string().default('')
      .description('自定义静态资源服务的基础 URL；留空时使用默认数据源。'),
    allowedHosts: Schema.array(Schema.string()).default([])
      .description('资源同步允许访问的额外主机名白名单，不包含协议和路径。'),
  }).description('乐曲资源同步'),
  render: Schema.object({
    concurrency: Schema.natural().min(1).max(16).default(4)
      .description('同时执行的最大图片渲染任务数'),
    queueLimit: Schema.natural().min(1).max(1_024).default(64)
      .description('等待渲染的最大任务数，超过后拒绝新任务'),
    timeoutMs: Schema.natural().min(1_000).max(120_000).default(30_000)
      .description('单个图片渲染任务的超时时间，单位为毫秒'),
  }).description('图片渲染'),
  ratingFooterText: Schema.string().default(DEFAULT_RATING_FOOTER_TEXT)
    .description('图片渲染共用的底部文字；留空仅显示底栏。'),
  publicBaseUrl: Schema.string().default('')
    .description('插件回调路由可从公网访问的基础 URL；留空时使用 Koishi Server 的 selfUrl'),
  administrators: Schema.array(Schema.string()).default([])
    .description('管理员用户 ID'),
  compatibilityMode: Schema.boolean().default(false)
    .description('是否为 QQ 平台强制使用兼容消息，关闭富媒体交互'),
  debugMode: Schema.boolean().default(false)
    .description('调试模式'),
})

export const Config = ConfigSchema

export const usage = `
**本项目由各种AI工具开发，存在一定的问题，见谅，如有更好的实现欢迎 PR，有好的提议欢迎提ISSUE！**

插件需配合 [adapter-qq-crack](/market?keyword=adapter-qq-crack) 使用。

面向 Koishi 的舞萌 DX 功能插件，移植自[可怜BOT](https://github.com/xszqxszq/KarenBot) 的舞萌插件

插件需要配置水鱼 OAuth 与LXNS 开发者令牌及 OAuth 配置。

使用LXNS OAuth 时，请确保 Koishi 回调地址可从公网访问。

申请LXNS OAuth客户端时，务必勾选“读取用户信息”与“读取玩家数据”权限，否则落雪查分器可能无法正常使用。

水鱼 Oauth 申请指南：
- 使用水鱼账号登陆 [开发者控制台](https://auth.diving-fish.com/console)
- 点击“创建新应用”
- 填写应用名称（不超过 20 字）、应用描述（不超过 100 字）、主页地址（可留空，如填写须可公开访问）
- 接入方式选择“Bot/工具”
- 部署形态选择“由你自己部署运行”
- 权限选择“读取你在查分器的资料（Rating、姓名框等）”与“读取你的舞萌 DX 成绩”
- 点击提交，耐心等待审核完成
- 审核通过后，点击生成client_secret，clint_id在申请完成后仅会显示一次，请务必妥善保管
- 将申请到的client_secret与client_id填入对应的配置中，即可完成水鱼查分器配置

`.trim()
