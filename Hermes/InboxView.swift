import SwiftUI

/// 收件箱数据：本机观察到的审批、完成与失败，加上服务端可读取的任务状态。
/// 工作台「待处理」与完整收件箱页共用同一套读取与提交逻辑。
@MainActor
final class InboxController: ObservableObject {
    let client: HermesClient
    @Published private(set) var items: [InboxItem] = []
    @Published private(set) var jobs: [RemoteJob] = []
    @Published private(set) var didLoadJobs = false
    @Published private(set) var loadingJobs = false
    @Published private(set) var jobsError: String?
    @Published private(set) var resolvingID: String?
    @Published var errorText: String?
    private var observer: NSObjectProtocol?

    init(client: HermesClient) {
        self.client = client
        observer = NotificationCenter.default.addObserver(forName: InboxStore.didChange, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.loadItems() }
        }
        loadItems()
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    var approvals: [InboxItem] { items.filter { $0.kind == .approval } }
    var outcomes: [InboxItem] { items.filter { $0.kind != .approval } }
    var attentionJobs: [RemoteJob] { jobs.filter(Self.isAttention) }
    var pendingCount: Int { approvals.count + attentionJobs.filter { !Self.isRunning($0) }.count }
    var isEmpty: Bool { items.isEmpty && attentionJobs.isEmpty }

    func loadItems() {
        do { items = try InboxStore.items(profileID: client.settings.profileID) }
        catch {
            items = []
            errorText = "无法读取收件箱；原文件已保留：\(error.localizedDescription)"
        }
    }

    func reloadJobs() async {
        loadItems()
        guard client.settings.isConfigured, !loadingJobs else { return }
        loadingJobs = true
        defer { loadingJobs = false }
        do {
            let received = try await client.jobs()
            guard !Task.isCancelled else { return }
            var seen = Set<String>()
            jobs = received.filter { seen.insert($0.id).inserted }
            didLoadJobs = true
            jobsError = nil
        } catch {
            guard !Task.isCancelled, (error as? URLError)?.code != .cancelled else { return }
            jobsError = error.localizedDescription
        }
    }

    func resolve(_ item: InboxItem, choice: String) async {
        guard resolvingID == nil, item.profileID == client.settings.profileID, approvals.contains(item) else { return }
        guard choice == "deny" || (item.choices ?? ["once", "deny"]).contains(choice) else { return }
        if choice == "session" || choice == "always" { guard item.command?.isEmpty == false else { return } }
        resolvingID = item.id
        defer { resolvingID = nil }
        if let (conversation, approval) = RemoteConversationModel.activeApproval(id: item.id, client: client, sessionID: item.sessionID) {
            do { try await conversation.resolve(approval, choice: choice) }
            catch { errorText = error.localizedDescription }
            loadItems()
            return
        }
        guard let runID = item.runID, !runID.isEmpty else {
            errorText = "这条审批没有运行编号，无法提交。"
            return
        }
        let approval = RemoteApproval(runID: runID, requestID: item.requestID, command: nil, description: item.detail, choices: item.choices)
        do {
            try await client.resolveApproval(approval, choice: choice)
        } catch {
            errorText = "无法提交审批，请稍后再试。"
            return
        }
        do { try InboxStore.remove(id: item.id, profileID: item.profileID) }
        catch { errorText = "审批已提交，但无法清理本机收件箱：\(error.localizedDescription)" }
        loadItems()
    }

    /// 完成与失败记录只是通知，可以清除；待审批事项必须允许或拒绝。
    func dismiss(_ item: InboxItem) {
        guard item.kind != .approval else { return }
        do { try InboxStore.remove(id: item.id, profileID: item.profileID) }
        catch { errorText = "无法清除这条记录：\(error.localizedDescription)" }
        loadItems()
    }

    static func isRunning(_ job: RemoteJob) -> Bool { job.lastStatus == "running" || job.state == "running" }

    static func isAttention(_ job: RemoteJob) -> Bool {
        if isRunning(job) { return true }
        return ["error", "failed", "delivery_failed", "unreachable", "auth_failed"].contains(job.lastStatus ?? "")
            || job.needsAttention
    }
}

/// 收件箱中可打开的目标：所属会话或任务详情。
enum InboxRoute: Hashable {
    case session(String)
    case job(String)
}

struct InboxRouteDestination: View {
    let route: InboxRoute
    let client: HermesClient
    var body: some View {
        switch route {
        case .session(let id): InboxSessionDestination(client: client, sessionID: id)
        case .job(let id): InboxJobDestination(client: client, jobID: id)
        }
    }
}

/// 完整收件箱页。
struct InboxView: View {
    @ObservedObject var inbox: InboxController
    @State private var route: InboxRoute?

    var body: some View {
        List {
            if inbox.jobsError != nil { InboxJobsLoadError(inbox: inbox).cardRow() }
            if inbox.isEmpty && inbox.jobsError == nil {
                Group {
                    if inbox.loadingJobs { ProgressView("正在读取收件箱…").frame(maxWidth: .infinity) }
                    else {
                        ContentUnavailableView("一切就绪", systemImage: "checkmark.circle",
                            description: Text("审批、完成和失败会出现在这里。"))
                    }
                }.cardRow()
            }
            if !inbox.approvals.isEmpty {
                Section {
                    ForEach(inbox.approvals) { item in
                        InboxApprovalRow(item: item, inbox: inbox) { route = .session(item.sessionID) }.cardRow()
                    }
                } header: { SectionTitle(title: "待审批", count: inbox.approvals.count) }
            }
            if !inbox.attentionJobs.isEmpty {
                Section {
                    ForEach(inbox.attentionJobs) { job in
                        Button { route = .job(job.id) } label: { InboxJobRow(job: job) }.buttonStyle(.plain).cardRow()
                    }
                } header: { SectionTitle(title: "定时任务", count: inbox.attentionJobs.count) }
            }
            if !inbox.outcomes.isEmpty {
                Section {
                    ForEach(inbox.outcomes) { item in
                        Button { route = .session(item.sessionID) } label: { InboxOutcomeRow(item: item) }.buttonStyle(.plain).cardRow()
                            .swipeActions { Button("清除", systemImage: "xmark") { inbox.dismiss(item) }.tint(HermesTheme.muted) }
                    }
                } header: { SectionTitle(title: "最近结果", count: inbox.outcomes.count) }
                footer: { Text("左滑可清除已读结果。收件箱只记录这台设备发起并观察到的运行。").font(.caption).foregroundStyle(HermesTheme.muted) }
            }
        }
        .listStyle(.plain).hermesPage()
        .navigationTitle("收件箱").navigationBarTitleDisplayMode(.large)
        .navigationDestination(item: $route) { InboxRouteDestination(route: $0, client: inbox.client) }
        .task { await inbox.reloadJobs() }
        .refreshable { await inbox.reloadJobs() }
        .inboxErrorAlert(inbox)
    }
}

struct InboxJobsLoadError: View {
    @ObservedObject var inbox: InboxController

    var body: some View {
        if let error = inbox.jobsError {
            RemoteLoadBanner(message: "无法读取定时任务。\(error)", hasRecords: inbox.didLoadJobs, disabled: inbox.loadingJobs) {
                Task { await inbox.reloadJobs() }
            }
        }
    }
}

extension View {
    func inboxErrorAlert(_ inbox: InboxController) -> some View {
        alert("收件箱操作失败", isPresented: Binding(get: { inbox.errorText != nil }, set: { if !$0 { inbox.errorText = nil } })) {
            Button("知道了", role: .cancel) { inbox.errorText = nil }
        } message: { Text(inbox.errorText ?? "") }
    }
}

/// 待审批事项：卡片内直接允许或拒绝，下方按钮打开所属会话。
struct InboxApprovalRow: View {
    let item: InboxItem
    @ObservedObject var inbox: InboxController
    let onOpenSession: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ApprovalCard(context: item.sessionTitle.isEmpty ? nil : item.sessionTitle,
                         description: item.detail.isEmpty ? item.title : item.detail,
                         command: item.command, choices: item.choices, createdAt: item.createdAt,
                         busy: inbox.resolvingID == item.id) { choice in
                Task { await inbox.resolve(item, choice: choice) }
            }
            Button(action: onOpenSession) {
                HStack(spacing: 4) { Text("打开会话"); Image(systemName: "arrow.up.right") }
                    .font(.caption.weight(.medium)).foregroundStyle(HermesTheme.accent)
            }
            .buttonStyle(.plain)
            .padding(.leading, 4)
        }
    }
}

struct InboxOutcomeRow: View {
    let item: InboxItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(systemName: item.kind == .failed ? "xmark.octagon.fill" : "checkmark.circle.fill",
                     tone: item.kind == .failed ? .danger : .success, size: 32)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.ink).lineLimit(2)
                    Spacer(minLength: 6)
                    Text(item.createdAt, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(HermesTheme.muted)
                }
                if !item.sessionTitle.isEmpty { Text(item.sessionTitle).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(1) }
                if !item.detail.isEmpty { Text(item.detail).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(3) }
            }
        }
        .hermesCard(padding: 14)
        .contentShape(Rectangle())
    }
}

struct InboxJobRow: View {
    let job: RemoteJob

    var body: some View {
        let running = InboxController.isRunning(job)
        HStack(alignment: .top, spacing: 12) {
            IconTile(systemName: running ? "play.circle.fill" : "exclamationmark.triangle.fill", tone: running ? .info : .warning, size: 32)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text(job.name).font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.ink).lineLimit(2)
                    Spacer(minLength: 6)
                    StatusBadge(text: running ? "运行中" : "需关注", tone: running ? .info : .warning)
                }
                if !running || (job.lastStatus != nil && job.lastStatus != "running") {
                    Text("上次：\(job.lastStatusLabel)").font(.caption).foregroundStyle(HermesTheme.muted)
                }
                if let error = job.lastError, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(2)
                }
            }
        }
        .hermesCard(padding: 14)
        .contentShape(Rectangle())
    }
}

/// 从收件箱打开任务详情：独立读取任务，不依赖任务列表是否已加载。
private struct InboxJobDestination: View {
    @StateObject private var workspace: RemoteWorkspaceModel
    let jobID: String

    init(client: HermesClient, jobID: String) {
        _workspace = StateObject(wrappedValue: RemoteWorkspaceModel(client: client))
        self.jobID = jobID
    }

    var body: some View {
        RemoteJobDetailView(workspace: workspace, jobID: jobID)
    }
}

struct InboxSessionDestination: View {
    @EnvironmentObject private var model: AppModel
    let client: HermesClient
    let sessionID: String
    @State private var session: RemoteSession?
    @State private var errorText: String?

    var body: some View {
        Group {
            if let session {
                RemoteSessionDetailView(session: session, client: client, draftStore: model.draftStore) {}
            } else if let errorText {
                ContentUnavailableView("无法打开会话", systemImage: "exclamationmark.triangle",
                    description: Text(errorText))
            } else {
                ProgressView("正在读取会话…")
            }
        }
        .hermesPage()
        .task {
            guard session == nil else { return }
            do { session = try await client.session(sessionID) }
            catch { errorText = error.localizedDescription }
        }
    }
}
