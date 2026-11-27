# Hermes iOS

用 iPhone 或 iPad 连接自己的 Hermes Agent，把持续的讨论、项目资料和待写内容放在一个原生 SwiftUI 工作区中。

**v5.0.0（build 3）· iOS 模拟器安装预览** · 提供 ARM64 模拟器包，不含真机签名 IPA。

[下载安装包](https://github.com/allen7wang/hermes-app/releases/tag/v5.0.0) · [用户指南](docs/USER-GUIDE.md) · [更新记录](CHANGELOG.md) · [v5.0.0 验证记录](docs/VALIDATION-v5.0.0.md) · [历史发布记录](docs/RELEASE-v4.0.1.md)

## 安装模拟器预览版

从 [v5.0.0 Release](https://github.com/allen7wang/hermes-app/releases/tag/v5.0.0) 下载 `Hermes-5.0.0-iOS-Simulator-arm64.zip` 并解压。在移动端验收台选择「iOS 模拟器」，启动 / 连接后，通过「安装测试包」选择 `Hermes.app`。该包用于 Apple Silicon Mac 的 iOS 模拟器，不能安装到真实 iPhone。

Release 同时提供 `SHA256SUMS`、`BUILDINFO.json` 和 `INSTALL.txt`，可核对包摘要、源码提交、版本和构建环境。聊天功能需要在 App 中配置自己的 Hermes Agent 服务地址与密钥。

## 四个入口

| 入口 | 可以做什么 |
| --- | --- |
| **工作台** | 查看当前连接、待审批和需关注的任务，继续本机草稿，打开统一检索、消息库和定时任务。 |
| **对话** | 合并浏览本机对话与服务端会话，按来源筛选；在本机范围使用标签、批量整理、归档和回收站。 |
| **项目** | 组织相关对话、简介与共同指令；编写或导入知识资料，明确选择对话引用，批量添加、移除或替换引用。 |
| **设置** | 管理连接和模型，手动录入或扫码添加连接，选择浅色、深色或跟随系统，导出或合并导入 JSON 备份。 |

## v5 界面与操作

- 工作台的「待处理」显示审批、服务端任务状态和本机观察到的运行结果。待审批数量显示在工作台标签上，可以从卡片打开对应会话。
- 对话页的「全部」按置顶和最近活动合并当前连接的本机进行中对话与已加载的服务端会话，来源标签显示保存位置。可以继续加载更早的服务端会话。
- 两种会话共用消息样式和输入区。本机聊天提供上下文预览；服务端会话可显示工具输出、审批和运行状态。
- 工作台的统一检索在设备上运行，查找当前连接的本机项目、资料、对话、消息、收藏备注和文字草稿。归档可显式纳入，每类最多展示 50 条并显示匹配总数。
- 从「工作台 → 消息库」可跨本机对话查找和收藏消息，添加备注，批量导出、引用到草稿或存为项目资料。

草稿没有独立的修改时间。“继续草稿”优先显示新对话草稿，其余按关联对话的更新时间排列，不表示最近编辑顺序。

## 快速启动

1. 用 Xcode 打开 `Hermes.xcodeproj`，选择 `Hermes` scheme 和 iOS 模拟器。真机运行时，在 Signing & Capabilities 中选择 Team，并按需修改 Bundle Identifier。
2. 准备可从手机访问的 Hermes Agent API Server。在服务主机的 `~/.hermes/.env` 设置 `API_SERVER_ENABLED=true`、`API_SERVER_KEY=<your-secret>`，运行 `hermes gateway`。服务默认地址 `127.0.0.1:8642` 只指向服务主机自身，手机需使用可访问的 HTTPS 地址或可信局域网地址。
3. 在“设置 → 添加连接”填写连接名称、服务地址、密钥和模型。地址可为服务根路径、以 `/v1` 结尾，或包含 Profile 路径，例如 `https://example.com/p/work/v1`。读取模型列表或测试连接，检查后保存。
4. 从工作台开始新对话，或先创建项目并保存资料。发送前可打开“上下文预览”，检查实际携带的历史、系统指令、模型、图片与选定资料。

具体操作、容量限制和整理流程见[用户指南](docs/USER-GUIDE.md)。

## 本机内容与服务端内容

本机对话、项目、知识资料、收藏和草稿按连接保存在当前设备；API 密钥分别存入系统钥匙串。发送时，服务端会收到请求正文、选定历史、指令和明确选择的资料；未选择的项目资料不会自动发送。

从「对话 → 服务端」打开服务器保存的会话，从「工作台 → 定时任务」管理服务器上的任务。服务端续聊由服务器管理上下文，支持文字和单张图片输入；历史图片展示以服务端返回内容为准。停止、审批、运行任务等操作会提交给服务器，断线后请先刷新状态，App 不自动重发消息。

远程服务要求 HTTPS。局域网 HTTP 仅接受 `localhost`、`.local` 主机名和私有 IPv4 地址；请使用自己信任的服务地址，并保管 API 密钥。

## 备份与迁移

- 在“设置 → 备份与恢复”导出 JSON，或选择文件、检查预览后合并导入。备份覆盖本机对话、项目资料、引用、已发送图片、草稿、收藏和自建模板等内容，**不含 API 密钥，也不下载服务端记录**。
- 继续读取 v1–v7，按内容导出最低所需格式；含知识资料或引用时使用 v7。已有对话与非空草稿优先保留，新导入连接需重新填写密钥。
- JSON 用于恢复完整结构，Markdown 用于阅读与分享。备份文件含聊天和资料正文，需保存到信任的位置；备份不会持续同步设备。

## 构建

在仓库根目录运行：

```sh
xcodebuild -project Hermes.xcodeproj -scheme Hermes \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

工程可通过 `ruby tools/generate_project.rb` 重新生成；首次构建需解析 MarkdownUI 与 Highlightr 依赖。

从干净的版本标签检出打包：

```sh
git checkout v5.0.0
python3 tools/package_simulator.py
# 输出：build/release-v5.0.0/
```

打包工具仅生成 ARM64 的 iPhoneSimulator Release 构建，并核对平台、版本、构建号和可执行文件架构。依赖版本以已提交的 `Package.resolved` 为准。

## 验证与已知边界

见 [v5.0.0 验证记录](docs/VALIDATION-v5.0.0.md) 和 [v4.0.1 发布记录](docs/RELEASE-v4.0.1.md)。

API 格式参考 [Hermes Agent 官方 API Server 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)。
