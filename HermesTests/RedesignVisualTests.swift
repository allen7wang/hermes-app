import XCTest
import SwiftUI
import UIKit
@testable import Hermes

/// v5 关键页面以浅色与深色渲染，截图附在 XCTest 结果包中。
/// 只渲染，不导航、不发送；服务端请求由本地 URLProtocol 返回固定数据。
final class RedesignVisualTests: XCTestCase {
    private var inboxDirectory: URL!
    private var previousInboxURL: URL!
    private static let phone = CGSize(width: 393, height: 852)

    override func setUp() {
        super.setUp()
        previousInboxURL = InboxStore.storageURL
        inboxDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("v5-visual-inbox-\(UUID())", isDirectory: true)
        InboxStore.storageURL = inboxDirectory.appendingPathComponent("inbox-items.json")
    }

    override func tearDown() {
        InboxStore.storageURL = previousInboxURL
        try? FileManager.default.removeItem(at: inboxDirectory)
        super.tearDown()
    }

    @MainActor func testHomeWithPendingApproval() async throws {
        let model = try makeModel()
        try seedApproval(for: model)
        model.draft = "补充这次发布的验证记录"
        try await render(AppShell().environmentObject(model), size: Self.phone, name: "v5-home")
        try await render(NavigationStack { WorkspaceHomeView(onOpenChat: { _ in }) }.environmentObject(model),
                         size: CGSize(width: 393, height: 1500), name: "v5-home-full")
    }

    @MainActor func testConversationsMergedList() async throws {
        let model = try makeModel()
        try await render(NavigationStack { ConversationsView(onOpenChat: {}) }.environmentObject(model), size: Self.phone, name: "v5-conversations")
    }

    @MainActor func testLocalChat() async throws {
        let model = try makeModel()
        let id = try XCTUnwrap(model.conversations.first { $0.title == "发布前检查" }?.id)
        XCTAssertTrue(model.select(id))
        model.draft = "再列一下回滚步骤"
        try await render(NavigationStack { ChatView().toolbar(.hidden, for: .navigationBar) }.environmentObject(model), size: Self.phone, name: "v5-chat")
    }

    @MainActor func testServerSession() async throws {
        let model = try makeModel()
        let session = try JSONDecoder().decode(RemoteSession.self, from: Data(Self.sessionJSON.utf8))
        let view = NavigationStack {
            RemoteSessionDetailView(session: session, client: model.makeRemoteClient(), draftStore: model.draftStore) {}
        }.environmentObject(model)
        try await render(view, size: Self.phone, name: "v5-server-session")
    }

    @MainActor func testInboxPage() async throws {
        let model = try makeModel()
        try seedApproval(for: model)
        try InboxStore.upsert(InboxItem(id: "done-1", profileID: model.settings.profileID, sessionID: "s1", sessionTitle: "项目发布复盘",
            runID: "run-0", requestID: nil, command: nil, choices: nil, kind: .finished, title: "运行完成",
            detail: "构建和自动化测试已通过。", createdAt: Date(timeIntervalSinceNow: -1800)))
        let view = NavigationStack { InboxView(inbox: InboxController(client: model.makeRemoteClient())) }.environmentObject(model)
        try await render(view, size: Self.phone, name: "v5-inbox")
    }

    @MainActor func testJobsPage() async throws {
        let model = try makeModel()
        let view = NavigationStack { RemoteWorkspaceView(embedded: true, initialSection: 1) }.environmentObject(model)
        try await render(view, size: Self.phone, name: "v5-jobs")
    }

    @MainActor func testProjectsAndSettings() async throws {
        let model = try makeModel()
        _ = try model.saveProject(id: nil, name: "版本发布", summary: "记录发版清单与验收结果。", instructions: "", profileID: model.activeProfileID)
        try await render(ProjectWorkspaceView(embedded: true).environmentObject(model), size: Self.phone, name: "v5-projects")
        try await render(SettingsView(embedded: true).environmentObject(model), size: Self.phone, name: "v5-settings")
    }

    // MARK: - Fixtures

    @MainActor private func seedApproval(for model: AppModel) throws {
        try InboxStore.upsert(InboxItem(id: "approval-1", profileID: model.settings.profileID, sessionID: "s1", sessionTitle: "项目发布复盘",
            runID: "run-1", requestID: "req-1", command: "git push origin release/5.0", choices: ["once", "session", "always", "deny"],
            kind: .approval, title: "需要审批", detail: "Hermes 请求推送发布分支。", createdAt: Date(timeIntervalSinceNow: -120)))
    }

    @MainActor private func makeModel() throws -> AppModel {
        let suite = "HermesRedesignVisualTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.set("https://preview.hermes.test", forKey: "serverURL")
        defaults.set("hermes-agent", forKey: "model")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let now = Date()
        let records = [
            Conversation(title: "发布前检查", messages: [
                ChatMessage(role: .user, content: "帮我检查 5.0 的发布准备情况。"),
                ChatMessage(role: .assistant, content: "**构建与测试已通过。** 还需要确认三件事：\n\n1. 更新记录与版本号\n2. 备份兼容性\n3. 模拟器安装包校验\n\n可以先运行：\n\n```sh\nxcodebuild -scheme Hermes build\n```", bookmark: .init(createdAt: now, note: "发布清单"))
            ], updatedAt: now, pinned: true, workspace: .init(tags: ["发布"])),
            Conversation(title: "周末的阅读计划", messages: [ChatMessage(role: .assistant, content: "留一点时间，读完一直想读的那本书。")],
                updatedAt: now.addingTimeInterval(-7200), workspace: .init(tags: ["生活"])),
            Conversation(title: "访谈问题整理", messages: [ChatMessage(role: .user, content: "把上周的访谈记录归成三类问题。")],
                updatedAt: now.addingTimeInterval(-90000))
        ]
        try JSONEncoder().encode(records).write(to: directory.appendingPathComponent("conversations.json"))
        let keys = MemoryCredentials(); keys.values["api-server-key"] = "preview-only"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RedesignServerProtocol.self]
        addTeardownBlock { defaults.removePersistentDomain(forName: suite); try? FileManager.default.removeItem(at: directory) }
        return AppModel(defaults: defaults, directory: directory, credentials: keys, sessionConfiguration: configuration)
    }

    static let sessionJSON = #"{"id":"s1","title":"项目发布复盘","source":"cli","preview":"已检查构建结果，正在核对发布内容。","last_active":1792600000,"message_count":4,"pinned":true}"#

    @MainActor private func render<V: View>(_ view: V, size: CGSize, name: String) async throws {
        let suite = "HermesRedesignAppearance.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        for style in [UIUserInterfaceStyle.light, .dark] {
            let controller = UIHostingController(rootView: view
                .defaultAppStorage(defaults)
                .environment(\.locale, Locale(identifier: "zh_CN"))
                .preferredColorScheme(style == .dark ? .dark : .light))
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.rootViewController = controller
            window.overrideUserInterfaceStyle = style
            window.makeKeyAndVisible()
            defer { window.isHidden = true }
            controller.view.frame = CGRect(origin: .zero, size: size)
            controller.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(1200))
            controller.view.layoutIfNeeded()
            let image = UIGraphicsImageRenderer(size: controller.view.bounds.size).image { _ in
                controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
            }
            let data = try XCTUnwrap(image.pngData())
            XCTAssertGreaterThan(data.count, 1_000)
            let file = name + (style == .dark ? "-dark" : "-light")
            let attachment = XCTAttachment(image: image)
            attachment.name = file
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
}

private final class RedesignServerProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url?.path ?? ""
        let json: String
        if path.hasSuffix("/messages") {
            json = #"{"session_id":"s1","data":[{"id":1,"role":"user","content":"帮我检查新版本的发布准备情况。"},{"id":2,"role":"assistant","content":"构建和自动化测试已通过，可以继续核对发布说明。"},{"id":3,"role":"tool","tool_name":"terminal","content":"$ git status\nOn branch release/5.0\nnothing to commit"},{"id":4,"role":"assistant","content":"工作区干净。下一步需要推送发布分支，这一步会请求你的审批。"}],"pagination":{"limit":100,"offset":0,"returned":4}}"#
        } else if path.contains("/api/sessions") {
            json = #"{"data":[\#(RedesignVisualTests.sessionJSON),{"id":"s2","title":"每周研究简报","source":"telegram","preview":"本周三篇论文的要点与下一步。","last_active":1792596400,"message_count":12}],"has_more":false}"#
        } else if path.contains("/api/jobs") {
            json = #"{"jobs":[{"id":"weekly","name":"每周研究简报","prompt":"整理本周的研究发现与下一步行动。","state":"running","schedule_display":"每周一 09:00","next_run_at":"2026-11-23T01:00:00Z"},{"id":"review","name":"发布验证提醒","prompt":"检查回归结果和待办。","state":"scheduled","last_status":"failed","last_error":"上次投递失败","schedule_display":"every 1h"},{"id":"reading","name":"晚间阅读","prompt":"推荐一篇值得读的文章。","state":"paused","enabled":false,"schedule_display":"every day at 9pm"}]}"#
        } else {
            json = #"{"object":"list","data":[{"id":"hermes-agent","object":"model"}]}"#
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
