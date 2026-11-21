# Hermes iOS v5.0.0 验证记录

2026-11-21，Xcode 27.2（27B52）。重设计分支基于 `51c3e55`，应用版本为 5.0.0（build 3）。

## 本次收尾

- 保留四个底部入口和浅色、深色、跟随系统三种外观。工作台管理待处理事项，对话页按来源浏览会话，消息库和定时任务从工作台进入。
- 合并列表可以继续加载服务端会话。服务端列表显示新建和置顶请求的失败结果。
- 工作台与收件箱在定时任务读取失败时显示错误及重试入口，保留已读取的任务。点开定时任务时直接读取指定任务，失败后可以重试。
- 审批提交失败时在发起操作的页面显示错误。成功后同步清理本机审批状态，并忽略对已移除审批卡片的重复点击。
- 浅色和深色页面渲染使用临时数据与模拟服务端响应，截图作为 XCTest 附件保存。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| Mac Catalyst 完整 XCTest | 复跑 510 项通过，0 失败、0 跳过，结果包无 runtimeWarnings。首轮一项在测试进程提前退出后中断，复跑同一构建时通过。 |
| 界面布局 | 检查 18 张浅色与深色截图，覆盖工作台、对话列表、本机聊天、服务端会话、收件箱、定时任务、项目和设置。 |
| iOS 模拟器 Release | ARM64 构建成功。解压预览包后核对了 5.0.0（build 3）、iPhoneSimulator 平台、最低 iOS 17.0 和可执行文件。 |
| iOS 模拟器测试执行 | App 与测试目标编译成功。隔离设备启动超时，XCTest 在安装阶段中止。 |
| iPhone 13 Pro 真机（iOS 27.0.1） | Release 5.0.0（build 3）安装并启动，已核对进程和工作台。全量 XCTest 复跑 510 项通过，0 失败、0 跳过，结果包无 runtimeWarnings。 |

本地预览包和截图位于 `build/preview-v5.0.0/`。真机启动截图、18 张浅色与深色布局附件及最终结果包位于 `build/device-v5.0.0/`。

真机首轮有 42 个旧布局测试在写入固定的 `/private/tmp` 路径时失败。移除这一额外写入后，原有布局断言和 XCTest 截图附件全部保留。复跑结束后重新安装并启动了 Release 构建。

Release 首次启动显示了 iOS 无线数据授权弹窗。Mac 网关仍绑定旧局域网地址，API 端口无监听。本次未执行真实 Hermes API、iOS 原生点按或系统文件往返验收。

## 复现

```sh
xcodebuild -project Hermes.xcodeproj -scheme HermesTests \
  -destination 'platform=iOS Simulator,id=<simulator-uuid>' \
  -parallel-testing-enabled NO -resultBundlePath /tmp/hermes-v5-ios.xcresult \
  CODE_SIGNING_ALLOWED=NO test

xcodebuild -project Hermes.xcodeproj -scheme HermesTests \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -parallel-testing-enabled NO -resultBundlePath /tmp/hermes-v5-catalyst.xcresult \
  SUPPORTS_MACCATALYST=YES CODE_SIGNING_ALLOWED=NO test

xcodebuild -project Hermes.xcodeproj -scheme Hermes -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO build
```

从结果包导出布局附件时，可使用 `xcrun xcresulttool export attachments --path <xcresult> --output-path <directory>`。
