# koishi-plugin-mai-plugin

[![npm](https://img.shields.io/npm/v/koishi-plugin-mai-plugin?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-mai-plugin)

> [!NOTE]
> 本项目由各种AI工具开发，存在一定的问题，见谅，如有更好的实现欢迎 PR<br>
> 有好的提议欢迎提ISSUE！

面向 Koishi 的舞萌 DX 查询插件，移植自[可怜BOT](https://github.com/xszqxszq/KarenBot) 的舞萌查分插件

## 功能

- 通过水鱼或落雪查分器查询 B15、B25、B35、B40、B50 和单曲成绩。
- 生成成绩列表、定数表、完成表、进度表、未完成表和段位表。
- 查询曲目、谱面、别名、BPM、谱师、曲师、版本和拟合定数。
- 支持每日推荐、歌曲试听、经典猜歌和舞萌开字母。
- 支持群聊机厅排卡、机厅别名和排卡人数管理。
- 支持落雪 OAuth 与水鱼账号设备码授权。
- QQ 平台支持原生 Markdown 和按钮，其他平台可回退到普通文本与图片。
- 查分结果按可怜BOT的样式显示：图片上方为“查询结果”，下方为生成时间，图片内标题使用中文查分器名称。


## 安装

在 Koishi 控制台的插件市场中搜索并安装：

```text
mai-plugin
```

安装后启用插件，如需在 QQ 官机使用，请确认 Koishi 已启用 assets 服务。

在插件配置页修改 `ratingFooterText`，可统一替换 B15/B25/B35/B40/B50、成绩列表和歌50图片的底部文字；清空后只保留底栏。

## 运行要求

- Node.js 18 或更高版本。
- Koishi 4.18.7 或兼容版本。
- 可用的 Koishi HTTP 服务，用于访问水鱼、落雪和静态资源源。
- QQ 原生 Markdown 和按钮使用 [adapter-qq-crack](https://github.com/koishi-shangxue-plugins/koishi-plugin-adapter-qq-crack) 独有语法；不支持时可启用兼容模式。

需要使用落雪 OAuth 时，请先配置 Koishi Server 的 `selfUrl`，或设置插件的 `publicBaseUrl`。

水鱼 Oauth 申请指南：
- 使用水鱼账号登陆 [开发者控制台](https://auth.diving-fish.com/console)
- 点击“创建新应用”
- 填写应用名称（不超过 20 字）、应用描述（不超过 100 字）、主页地址（可留空，如填写须可公开访问）
- 接入方式选择“Bot/工具”
- 部署形态选择“由你自己部署运行”
- 权限选择“读取你在查分器的资料（Rating、姓名框等）”与“读取你的舞萌 DX 成绩”（`prober.records.read`）
- 点击提交，耐心等待审核完成
- 审核通过后，点击生成client_secret，clint_id在申请完成后仅会显示一次，请务必妥善保管
- 将申请到的client_secret与client_id填入对应的配置中，即可完成水鱼查分器配置

## 查分器绑定

首次查询前，按以下顺序完成设置：

1. 绑定查询使用的 QQ 号：

   ```text
   /mai 绑定 <QQ 号>
   ```

2. 绑定至少一个查分器：

   ```text
   /mai 绑定落雪
   /mai 绑定水鱼
   ```

3. 打开 查分设置面板：

   ```text
   /mai 查分设置
   ```

面板会提供头像、牌子、查分器和绑定/解绑按钮；查分器选择支持“自动”“水鱼”“落雪”，自动模式会依次尝试当前可用的查分器。

4. 查询成绩：

   ```text
   /mai B50
   ```

落雪绑定会跳转到 OAuth 授权页面。水鱼绑定会返回授权链接和用户码；玩家在网页确认后，BOT 会回复绑定结果。旧 Import-Token 绑定需重新授权，启动时会清理旧 Token 数据，但保留 QQ 与落雪绑定。`/mai 解绑水鱼` 只清除 BOT 的本地关联，远端授权可在[水鱼账号应用页](https://auth.diving-fish.com/apps)撤销。

## 常用命令

| 场景 | 命令示例 |
| --- | --- |
| 帮助 | `/mai` |
| QQ 绑定 | `/mai 绑定 <QQ 号>` |
| 查分设置面板 | `/mai 查分设置`；别名 `/mai 设置mai`、`/mai 设置b50` |
| 查分器选择 | `/mai 设置查分器`、`/mai 设置查分器 自动`、`/mai 设置查分器 水鱼`、`/mai 设置查分器 落雪` |
| 查分器绑定 | `/mai 绑定落雪`、`/mai 解绑落雪`、`/mai 绑定水鱼`、`/mai 解绑水鱼` |
| Rating 图片 | `/mai B15`、`/mai B25`、`/mai B35`、`/mai B40`、`/mai B50` |
| 单曲成绩 | `/mai info <曲目>`、`/mai minfo <曲目>`、`/mai 紫谱成绩 <曲目>` |
| 曲目查询 | `/mai id 123`、`/mai 查歌 <关键词>`、`/mai 随个`、`/mai 今日舞萌` |
| 列表与表格 | `/mai 分数列表`、`/mai 定数表`、`/mai 完成表`、`/mai 未完成表`、`/mai 段位表` |
| 进度查询 | `/mai 进度 <条件> [目标]` |
| 分数计算 | `/mai 分数线 <参数>` |
| 图片设置 | `/mai 设置头像 <头像>`、`/mai 设置牌子 <牌子>` |
| 猜歌 | `/mai 猜歌`、`/mai 舞萌开字母`、`/mai 启用猜歌`、`/mai 禁用猜歌` |
| 排卡 | `/mai 排卡管理`、`/mai 几`、机厅别名加人数 |
| 服务器状态 | `/mai 状态`、`/mai 有网吗`；也可直接发送「有网吗」 |
| 平台回退 | `/mai 兼容模式`、`/mai 关闭兼容模式` |

查询自己但尚未绑定 QQ 时，插件会暂存原命令，并在绑定成功后自动继续查询。公开 B50 可按 QQ 或用户名查询；详细成绩要求目标玩家已授权本应用。QQ 查询若对应多个已授权账号，会要求澄清绑定。QQ 平台会提供相应的绑定按钮。

## 回调与兼容模式

插件注册以下公网路由：

| 路由 | 用途 |
| --- | --- |
| `GET <oauth.callbackPath>` | 接收落雪 OAuth 回调。 |

落雪 OAuth 的 redirect URI 为 `publicBaseUrl`（或 Koishi Server `selfUrl`）与 `oauth.callbackPath` 的组合。例如：

```text
https://bot.example.com/mai-plugin/lxns/callback
```

控制台登记的 redirect URI 必须与插件最终生成的地址完全一致。

OAuth 凭据和令牌属于敏感信息。请勿在聊天记录、工单或截图中公开；`oauth.tokenCipherKey` 更换前应先迁移或清理已有落雪 OAuth Token。

## 项目结构

```text
mai-plugin/
├─ assets/
│  ├─ fallback/          # 缺失远程资源时使用的默认图片
│  ├─ fonts/             # Takumi 渲染使用的字体及授权说明
│  └─ generated/         # 段位、状态和 Rating 等渲染素材
├─ src/
│  ├─ commands/          # Koishi 命令、快捷触发词和交互引导
│  ├─ data/              # 资源清单、曲目与别名缓存、标准化和同步服务
│  ├─ database/          # 数据表声明与仓储实现
│  ├─ domain/            # 曲目、玩家、Rating 和枚举等领域模型
│  ├─ platform/          # QQ 富媒体、回退消息、权限与命令路由
│  ├─ providers/         # 水鱼、落雪查分器及查询链
│  ├─ query/             # 组合查询解析、过滤规则和执行器
│  ├─ render/            # Takumi 渲染服务、节点和图片模板
│  ├─ server/            # OAuth 回调与 HTTP 路由
│  ├─ services/          # 查询、设置、别名、猜歌、排卡和账号绑定业务
│  ├─ utils/             # 字符串与并发控制工具
│  ├─ config.ts          # 插件配置类型与 Schema
│  ├─ constants.ts       # 插件名称、注入服务和生命周期常量
│  ├─ index.ts           # Koishi 插件入口及生命周期装配
│  └─ types.ts           # 生命周期与插件上下文类型
├─ package.json          # npm 与 Koishi 插件元数据
├─ tsconfig.json         # Koishi 工作区 TypeScript 配置
└─ README.md             # 使用与开发文档
```

运行期间的资源快照和试听文件默认写入 Koishi 数据目录下的 `data/maimai`，该路径可通过 `resourceSync.cacheDir` 修改。

## 开发

在 Koishi 根目录执行：

```powershell
yarn clone https://github.com/KeiMaidDev/koishi-plugin-mai-plugin
```

## 许可证

MIT
