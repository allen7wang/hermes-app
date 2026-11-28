# 信使 Hermes · 产品分析

> 编写日期：2026-11-28。外部数据的访问日期均为 2026-11-28。「估算」表示推算，「待核实」表示未找到一手来源。
> 本文复用并更新了 [research/third-party-agent-clients](../research/third-party-agent-clients/README.md)（2026-11-13）中的竞品调研。返回 [摘要](README.md)。

## 1. 问题与使用场景

Hermes Agent 跑在用户自己的电脑或服务器上。它能连续执行工具、跑定时任务，但人一离开电脑，回路就断了：

- **任务等人。** Agent 要执行命令时需要审批，人不在电脑前，任务就停住。
- **会话接不上。** 出门后想在手机上继续同一个会话，或看看它跑到哪一步了。
- **上下文失控。** 长期项目的资料散落在聊天记录里，每次都要重新粘贴，也不知道这次请求实际带了哪些内容。

典型场景：

| 场景 | 信使的做法 |
| --- | --- |
| 通勤时 Agent 请求执行命令 | 工作台「待处理」集中显示审批，可以允许或拒绝（`Hermes/InboxStore.swift`、`Hermes/InboxView.swift`） |
| 在手机上续一个电脑上的会话 | 对话页合并浏览本机对话和服务端会话（`Hermes/RemoteWorkspaceModel.swift`、`Hermes/SessionStream.swift`） |
| 每天定时跑报告 | 在工作台查看、新建、暂停或立即运行服务端定时任务（`Hermes/RemoteJobEditorView.swift`） |
| 长期研究项目 | 项目里保存资料，逐个对话选择引用，发送前预览实际上下文（`Hermes/ProjectDocument.swift`、`Hermes/ChatContextPreview.swift`） |
| 回头找某条回答 | 在设备上统一检索项目、资料、对话、消息和草稿（`Hermes/WorkspaceSearchView.swift`、`Hermes/MessageLibrary.swift`） |

## 2. 用户画像

| 画像 | 描述 | 核心需求 | 付费意愿（推断） |
| --- | --- | --- | --- |
| **A. 自建 Agent 的开发者** | 在 Mac mini 或 VPS 上跑 Hermes，用 Tailscale 或反向代理暴露网关 | 审批不卡住、能续会话、通知及时 | 低到中。习惯开源免费，但会为省时间的工具买断 |
| **B. 用 Agent 做研究和写作的产品人** | 用 Hermes 长期跟进几个主题，需要积累资料 | 按项目整理、明确控制上下文、可导出 | 中。对标 TypingMind 这类买断工具（US$39–99） |
| **C. 小团队负责人** | 团队共用一个 Hermes 网关，多人用多个 Profile | 多连接、配对方便、密钥不外泄 | 待验证。当前产品没有多人协作 |

## 3. 核心功能与差异化

### 3.1 已实现的能力（以代码为准）

- **四个入口**：工作台、对话、项目、设置（`Hermes/AppShell.swift`、`Hermes/WorkspaceHomeView.swift`）。
- **本机工作区**：
  - 项目最多 20 篇资料，正文总计 200,000 字符。资料可以批量添加、移除或替换引用（`Hermes/ProjectReference*.swift`）。
  - 消息库支持收藏、加备注，也可以汇编成项目资料（`Hermes/MessageProjectCapture.swift`）。
- **服务端工作区**：
  - 服务端会话、流式回复（`Hermes/SSEParser.swift`）、单张图片输入、审批、停止、定时任务。
  - 断线后不自动重发，先核对服务端已保存的内容（`Hermes/RemoteConversationModel.swift`）。
- **连接与迁移**：
  - 多个连接，可以扫码配对（`Hermes/PairingPayload.swift`、`Hermes/PairingScanView.swift`）。
  - JSON 备份兼容 v1–v7 格式，备份中不含密钥（`Hermes/BackupArchive.swift`）。
- **网页版**：`web/` 对齐了 iOS 的服务端功能，但不包含本机工作区。默认连接经私有工作台中继，浏览器里没有密钥（[web/README.md](../web/README.md)）。

### 3.2 差异化

| 维度 | 信使 | 同类头部（Hermex） |
| --- | --- | --- |
| 本机项目资料和显式引用 | 有，是核心卖点 | 公开文案未提及 |
| 上下文预览（发送前看到实际携带的内容） | 有 | 未提及 |
| 统一检索和消息库 | 有，在设备上完成 | 未提及 |
| diff、浏览工作区文件 | 无 | 有 |
| 推送、灵动岛、小组件 | 无 | 有，推送走可自托管的中继 |
| 运行中排队或改方向 | 只能停止或改口 | 有 |

结论：信使的差异在**「人这一侧」的知识和上下文管理**，劣势在**「Agent 那一侧」的实时可见性**。后者恰好是同类客户端评分较高的原因（见 [02-deep-dives](../research/third-party-agent-clients/02-deep-dives.md)）。

## 4. 竞品对比

| 产品 | 类型 | 平台 | 价格 | 和信使的关系 |
| --- | --- | --- | --- | --- |
| **Hermes Mobile（Nous 官方）** | 官方 Hermes 客户端 Beta | iOS（TestFlight）、Android（Firebase）。来源为二手报道，待核实 | 未公布，Beta 免费。Nous Portal 套餐每月 Plus US$20、Super US$100、Ultra US$200，均含一个 Cloud agent | 最大威胁。连接自建网关或 Nous Cloud [1][2][3] |
| **Hermex** | 第三方 Hermes 客户端 | iOS / iPadOS 18+、visionOS 2+ | 免费，无内购 | 商店里 Hermes 类的头名，美国店 232 个评分 [4] |
| **Hermes Conduit** | 第三方 Hermes 客户端 | iPhone、iPad、Mac、Apple Watch | 免费下载，内购待核实 | 美国店 64 个评分 [5] |
| **Moshi** | 面向编码 Agent 的移动终端（SSH / Mosh） | iOS、Android | 免费；Pro 每月 US$9.99、每年 US$89.99，或终身 US$199 | 同类中少有的成熟收费样本 [6] |
| **TypingMind** | 自带密钥的通用 AI 聊天前端 | Web、桌面 | 一次性买断：US$39 / 79 / 99 | 「买断 + 自带密钥」的定价锚点 [7] |
| **Open WebUI / LibreChat** | 自托管 Web 聊天界面 | Web（可装为 PWA） | Open WebUI 免费（超过 50 名用户后不能去掉品牌，企业版需询价）；LibreChat 采用 MIT 许可 | 网页端的替代品，不是 Hermes 专用 [8][9] |

ChatGPT 和 Claude 官方 App 是大众市场的价格锚点：ChatGPT Plus 每月 US$20，Claude Pro 每月 US$20（二手汇总 [10]）。它们不连接自建 Agent，所以不是直接竞品。

## 5. 现状评估

| 维度 | 评估 |
| --- | --- |
| 成熟度 | 功能完整度高：v1→v5 共 36 次提交，14,313 行 Swift 和 4,262 行 JS。但仍是 Pre-release，没有签名包，未上架。 |
| 测试 | 510 项 XCTest，在 Mac Catalyst 和 iPhone 13 Pro 上通过，另有 18 张布局截图检查。v5 **未完成**真实 Hermes API、原生点按和系统文件往返的验收。 |
| 技术债 | 多个版本连续出现「真实 API 未验收」。网页版和 iOS 是两套实现（Swift 与 `web/core.js`），协议变动要改两处。依赖 MarkdownUI、Highlightr、NetworkImage、swift-cmark。 |
| 依赖风险 | 完全依赖 Hermes 的 API Server 协议，Nous 改接口时会跟着失效。官方客户端发布后，「第三方客户端」的必要性会下降。 |
| 安全 | 见下文。 |

**安全现状：**

- **密钥存储**：密钥存在钥匙串，属性为 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，不随 iCloud 迁移（`Hermes/KeychainStore.swift`）。
- **传输**：远程地址必须 HTTPS。HTTP 只放行 `localhost`、`.local` 主机名和私有 IPv4（`Hermes/HermesClient.swift`）。`Info.plist` 仅开启 `NSAllowsLocalNetworking`。
- **配对码**：配对码直接包含 API 密钥（`{"v":1,"name","url","key"}`，见 `Hermes/PairingPayload.swift`），被拍到就等于泄露。目前靠界面提示「只向自己的设备出示」。可以考虑一次性短时效配对，但需要服务端配合。
- **备份**：备份不含密钥，但包含聊天和资料的明文，需要用户自己妥善保管。
- **网页版**：
  - 自定义连接的密钥存在 `localStorage`，同一工作台来源下的其他应用也能读到（[web/README.md](../web/README.md) 已说明）。
  - 默认连接由中继保管密钥，并校验来源、Tailscale 身份和路由白名单（`project-private-web/scripts/hermes-relay.mjs`）。

## 6. 路线图建议

| 时间 | 做什么 | 怎么验证 |
| --- | --- | --- |
| **3 个月** | ① 对标官方 Beta 和 Hermex，确定「不做」清单。② 补齐真机连接真实网关的端到端验收。③ 选定许可证。④ 为上架做准备：首次发送前的第三方 AI 披露与同意页、隐私标签、审核用演示服务。⑤ TestFlight 外部 Beta。 | 30 名 Beta 用户：D7 留存 ≥ 30%，≥ 40% 的活跃用户用过项目资料或上下文预览 |
| **6 个月** | ① 网关提供设备通道后做推送，只推三类事件：待审批、完成、失败；没有通道就不做。② 列出本轮改动的文件，接口没有 diff 就只列路径。③ 把项目资料带入服务端会话，打通本机工作区和服务端会话。 | 审批中位响应时间比没有推送时缩短 50%；每周活跃用户里使用资料引用的比例 |
| **12 个月** | 二选一：**(a) 多 Agent 收件箱**，增加 DSH、OpenCode 等协议适配，参考 Happier 和 Paseo 的多 Agent 路线；**(b) 留在 Hermes，做深知识工作区**，加 iCloud 同步和 Mac 版。 | (a) 看连接两种以上 Agent 的用户比例；(b) 看买断 Pro 的转化率。按第 6 个月的数据决定走哪条 |

## 来源

[1] Nous Research，Hermes Mobile Beta 候补名单页：https://hermes-agent.nousresearch.com/mobile （页面只有候补名单，平台细节不可见）
[2] AICoder，《Nous Research opens the official Hermes Agent mobile beta》（2026-10-31，二手报道，待核实）：https://aicoder.com/news/news-20261031-nous-hermes-agent-mobile-beta-ios-testflight-android-firebase-own-gateway
[3] Nous Portal 套餐价格的二手汇总（Nous 自己的页面前后不一致，待核实）：https://www.dreamhost.com/guides/hermes-agent/hermes-agent-monthly-cost/ ；https://openclawlaunch.com/guides/nous-portal
[4] Hermex App Store 页面：https://apps.apple.com/us/app/hermex/id6767006319 ；评分数取自 iTunes Lookup API
[5] Hermes Conduit：iTunes Lookup API，id 6758554297
[6] Moshi 定价页：https://getmoshi.app/pricing
[7] TypingMind 定价（二手汇总，官方购买页为 typingmind.com/buy）：https://docs.typingmind.com/resources/typingmind-review
[8] Open WebUI 许可解读（WZ-IT，2026-10）：https://wz-it.com/en/blog/open-webui-license-branding-business/
[9] LibreChat 许可与 ClickHouse 收购（Thoughtworks Radar）：https://www.thoughtworks.com/en-us/radar/platforms/librechat
[10] ChatGPT / Claude 价格的二手汇总（2026-11）：https://theaicareerlab.com/blog/chatgpt-pricing-plans-explained ；https://superapp.dev/blog/claude-pricing
