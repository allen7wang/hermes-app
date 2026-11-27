import SwiftUI

/// 服务端工作区：v5 中会话并入「对话」，这里专注定时任务；section 0 仍可单独展示服务端会话。
struct RemoteWorkspaceView: View {
    var embedded = false
    var initialSection = 1
    @EnvironmentObject private var model: AppModel

    var body: some View {
        RemoteWorkspaceContent(client: model.makeRemoteClient(), embedded: embedded, initialSection: initialSection)
            .id(model.settings)
    }
}

struct RemoteWorkspaceContent: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    /// embedded 为 true 时推入外层导航栈；否则作为表单自带导航栈与「关闭」。
    let embedded: Bool
    @StateObject private var workspace: RemoteWorkspaceModel
    private let section: Int
    @State private var jobQuery = ""
    @State private var jobFilter = RemoteJobFilter.all
    @State private var showingNewJob = false
    @AppStorage("workspaceRefreshInterval") private var refreshSeconds = 0
    @State private var visible = false
    @State private var showingDetail = false
    @State private var jobRoute: String?

    private var refreshInterval: RemoteRefreshInterval { RemoteRefreshInterval(rawValue: refreshSeconds) ?? .off }
    private var pollingKey: String {
        "\(refreshSeconds)-\(section)-\(visible)-\(scenePhase == .active)-\(showingDetail)-\(showingNewJob)"
    }

    init(client: HermesClient, embedded: Bool, initialSection: Int = 1) {
        self.embedded = embedded
        _workspace = StateObject(wrappedValue: RemoteWorkspaceModel(client: client))
        section = initialSection == 0 ? 0 : 1
    }

    private var isConfigured: Bool { workspace.client.settings.isConfigured }

    var body: some View {
        if embedded { content }
        else {
            NavigationStack {
                content.toolbar { ToolbarItem(placement: .topBarLeading) { Button("关闭") { dismiss() } } }
            }
        }
    }

    private var content: some View {
        Group {
            if !isConfigured {
                ContentUnavailableView("先连接 Hermes", systemImage: "server.rack",
                    description: Text("在设置中填写服务器地址和 API 密钥。"))
            } else if section == 0 {
                RemoteSessionPane(workspace: workspace)
            } else { jobList }
        }
        .hermesPage()
        .navigationTitle(section == 0 ? "服务端会话" : "定时任务")
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            if section == 1 && isConfigured {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Picker("任务自动刷新", selection: $refreshSeconds) {
                            ForEach(RemoteRefreshInterval.allCases) { Text($0.title).tag($0.rawValue) }
                        }
                        Text("仅在任务列表可见且 App 在前台时读取；失败后自动放慢。")
                    } label: { Image(systemName: refreshInterval == .off ? "clock" : "clock.badge.checkmark") }
                        .accessibilityLabel("任务自动刷新")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingNewJob = true } label: { Image(systemName: "plus") }
                        .disabled(workspace.jobActionsDisabled)
                        .accessibilityLabel("新建定时任务")
                }
            }
        }
        .tint(HermesTheme.accent)
        .sheet(isPresented: $showingNewJob) {
            RemoteJobEditorView(job: nil) { Task { await workspace.reloadJobs() } }
        }
        .task { if section == 1 { await workspace.reloadJobs() } }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .task(id: pollingKey) {
            guard section == 1, visible, scenePhase == .active, !showingDetail,
                  !showingNewJob, isConfigured, refreshInterval != .off else { return }
            var failures = 0
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(refreshInterval.delay(afterFailures: failures))) }
                catch { return }
                guard !Task.isCancelled else { return }
                if !workspace.jobActionsDisabled {
                    await workspace.reloadJobs()
                    failures = workspace.jobsError == nil ? 0 : min(3, failures + 1)
                }
            }
        }
    }

    private var jobList: some View {
        let visible = workspace.filteredJobs(query: jobQuery, filter: jobFilter)
        let overview = RemoteJobOverview(workspace.jobs)
        return List {
            Section {
                HStack(spacing: 10) {
                    overviewTile("运行中", count: overview.running, filter: .running, tone: .info, icon: "play.fill")
                    overviewTile("需关注", count: overview.attention, filter: .attention, tone: .warning, icon: "exclamationmark.triangle.fill")
                    overviewTile("已暂停", count: overview.paused, filter: .paused, tone: .neutral, icon: "pause.fill")
                }
                .cardRow(top: 4, bottom: 4)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(RemoteJobFilter.allCases) { filter in
                            FilterChip(title: filter.title, selected: jobFilter == filter) { jobFilter = filter }
                        }
                    }.padding(.horizontal, HermesMetrics.page)
                }
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
                if let notice = workspace.notice {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "info.circle.fill").foregroundStyle(HermesTheme.info)
                        Text(notice).font(.caption).foregroundStyle(HermesTheme.ink)
                        Spacer()
                        Button { workspace.notice = nil } label: { Image(systemName: "xmark").font(.caption) }
                            .accessibilityLabel("关闭运行提示")
                    }
                    .hermesCard(padding: 12).cardRow()
                }
            }
            if let error = workspace.jobsError {
                RemoteLoadBanner(message: error, hasRecords: !workspace.jobs.isEmpty,
                    disabled: workspace.jobActionsDisabled) { Task { await workspace.reloadJobs() } }
                    .cardRow()
            }
            if workspace.isLoadingJobs && workspace.jobs.isEmpty {
                ProgressView("正在读取定时任务…").frame(maxWidth: .infinity).cardRow(top: 24)
            } else if visible.isEmpty && workspace.jobsError == nil {
                ContentUnavailableView(workspace.jobs.isEmpty ? "没有定时任务" : "没有匹配的任务",
                    systemImage: "calendar.badge.clock",
                    description: Text(workspace.jobs.isEmpty ? "点击右上角 + 创建一个任务。" : "试试其他关键词或状态筛选。"))
                    .cardRow(top: 24)
            }
            Section {
                ForEach(visible) { job in
                    Button { jobRoute = job.id } label: { RemoteJobRow(job: job).contentShape(Rectangle()) }
                        .buttonStyle(.plain)
                        .hermesCard(padding: 14).cardRow()
                }
            } header: {
                if !visible.isEmpty {
                    HStack {
                        Text("\(visible.count) / \(workspace.jobs.count) 个任务")
                        Spacer()
                        Text(refreshInterval == .off ? "下拉刷新" : "前台\(refreshInterval.title)刷新")
                    }.font(.caption).foregroundStyle(HermesTheme.muted).textCase(nil)
                }
            }
            if let date = workspace.jobsUpdatedAt { RemoteUpdatedRow(date: date) }
        }
        .listStyle(.plain)
        .navigationDestination(item: $jobRoute) { id in
            RemoteJobDetailView(workspace: workspace, jobID: id)
                .onAppear { showingDetail = true }.onDisappear { showingDetail = false }
        }
        .searchable(text: $jobQuery, prompt: "搜索任务名称、说明、日程或 ID")
        .refreshable { await workspace.reloadJobs() }
        .scrollDismissesKeyboard(.interactively)
    }

    private func overviewTile(_ title: String, count: Int, filter: RemoteJobFilter, tone: HermesTone, icon: String) -> some View {
        Button { jobFilter = jobFilter == filter ? .all : filter } label: {
            VStack(alignment: .leading, spacing: 10) {
                Image(systemName: icon).font(.caption.weight(.bold)).foregroundStyle(tone.color)
                Text("\(count)").font(.title2.weight(.bold).monospacedDigit()).foregroundStyle(HermesTheme.ink)
                Text(title).font(.caption).foregroundStyle(HermesTheme.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(jobFilter == filter ? tone.color.opacity(0.14) : HermesTheme.surface,
                        in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(jobFilter == filter ? tone.color.opacity(0.4) : HermesTheme.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title)，\(count) 个任务")
    }
}

struct RemoteJobRow: View {
    let job: RemoteJob
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Text(job.name).font(.headline).foregroundStyle(HermesTheme.ink).lineLimit(2)
                Spacer(minLength: 8)
                RemoteJobStatusBadge(job: job)
            }
            InlineLabel(text: job.scheduleDisplay ?? "未设置日程", systemImage: "calendar")
                .font(.caption).foregroundStyle(HermesTheme.muted)
            if let prompt = job.prompt, !prompt.isEmpty {
                Text(prompt).font(.caption).foregroundStyle(HermesTheme.ink.opacity(0.85)).lineLimit(2)
            }
            HStack(spacing: 12) {
                if job.nextRunAt != nil {
                    InlineLabel(text: "下次 \(RemoteTimestamp.display(job.nextRunAt))", systemImage: "clock")
                }
                if job.needsAttention {
                    InlineLabel(text: "最近运行需要关注", systemImage: "exclamationmark.triangle").foregroundStyle(HermesTheme.warning)
                } else if job.lastStatus != nil {
                    Text("上次：\(job.lastStatusLabel)")
                }
            }
            .font(.caption2).foregroundStyle(HermesTheme.muted)
        }
    }
}

/// 服务端会话列表：搜索、置顶筛选、分页加载与新建。用于「对话 › 服务端」。
struct RemoteSessionPane: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var workspace: RemoteWorkspaceModel
    @State private var query = ""
    @State private var pinnedOnly = false
    @State private var creatingSession = false
    @State private var newSessionTitle = ""
    @State private var createdSession: RemoteSession? // 新建或点按打开的会话
    @State private var showingCreatedSession = false

    var body: some View {
        let visible = workspace.filteredSessions(query: query, pinnedOnly: pinnedOnly)
        List {
            if let error = workspace.sessionsError {
                RemoteLoadBanner(message: error, hasRecords: !workspace.sessions.isEmpty,
                    disabled: workspace.sessionActionsDisabled) { Task { await workspace.reloadSessions() } }
                    .cardRow()
            }
            if workspace.isLoadingSessions && workspace.sessions.isEmpty {
                ProgressView("正在读取服务端会话…").frame(maxWidth: .infinity).cardRow(top: 24)
            } else if visible.isEmpty && workspace.sessionsError == nil {
                ContentUnavailableView(workspace.sessions.isEmpty ? "没有服务端会话" : "没有匹配的会话",
                    systemImage: "server.rack",
                    description: Text(workspace.sessions.isEmpty ? "新建一段会话，消息会保存在 Hermes 服务器上。" :
                        "试试其他关键词、切换置顶筛选，或继续加载更多记录。"))
                    .cardRow(top: 24)
            }
            Section {
                ForEach(visible) { session in
                    Button { createdSession = session; showingCreatedSession = true } label: {
                        RemoteSessionRow(session: session, busy: workspace.busySessionID == session.id)
                    }
                    .buttonStyle(.plain)
                    .hermesCard(padding: 14).cardRow()
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        if session.pinned != nil { pinButton(session) }
                    }
                    .contextMenu { if session.pinned != nil { pinButton(session) } }
                }
            } header: {
                if !workspace.sessions.isEmpty {
                    HStack {
                        Text("已加载 \(workspace.sessions.count) 段 · 置顶优先")
                        Spacer()
                        if workspace.sessions.contains(where: { $0.pinned != nil }) {
                            Button { pinnedOnly.toggle() } label: {
                                Label(pinnedOnly ? "仅置顶" : "全部", systemImage: pinnedOnly ? "pin.fill" : "pin")
                            }
                            .accessibilityLabel(pinnedOnly ? "显示全部会话" : "仅显示置顶会话")
                        }
                    }.font(.caption).foregroundStyle(HermesTheme.muted).textCase(nil)
                }
            }
            if workspace.hasMoreSessions {
                Button { Task { await workspace.loadMoreSessions() } } label: {
                    HStack {
                        Spacer()
                        if workspace.isLoadingMoreSessions { ProgressView() } else { Text("加载更多会话").font(.subheadline.weight(.medium)) }
                        Spacer()
                    }
                }
                .disabled(workspace.sessionActionsDisabled)
                .cardRow()
            }
            if let date = workspace.sessionsUpdatedAt { RemoteUpdatedRow(date: date) }
        }
        .listStyle(.plain).hermesPage()
        .searchable(text: $query, prompt: "搜索标题、摘要、来源或 ID")
        .refreshable { await workspace.reloadSessions() }
        .scrollDismissesKeyboard(.interactively)
        .task { if workspace.sessions.isEmpty { await workspace.reloadSessions() } }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { newSessionTitle = ""; creatingSession = true } label: { Image(systemName: "plus") }
                    .disabled(workspace.sessionActionsDisabled)
                    .accessibilityLabel("新建服务端会话")
            }
        }
        .navigationDestination(isPresented: $showingCreatedSession) {
            if let session = createdSession { sessionDetail(session) }
        }
        .alert("新建服务端会话", isPresented: $creatingSession) {
            TextField("标题（可选）", text: $newSessionTitle)
            Button("取消", role: .cancel) {}
            Button("创建") {
                Task {
                    if let session = await workspace.createSession(title: newSessionTitle) {
                        createdSession = session
                        showingCreatedSession = true
                    }
                }
            }
        } message: { Text("消息会保存在 Hermes 服务器上，可从其他客户端继续。") }
        .remoteActionErrorAlert(workspace)
    }

    private func pinButton(_ session: RemoteSession) -> some View {
        Button {
            Task { await workspace.togglePin(session) }
        } label: {
            Label(session.pinned == true ? "取消置顶" : "置顶", systemImage: session.pinned == true ? "pin.slash" : "pin")
        }
        .tint(HermesTheme.accent).disabled(workspace.sessionActionsDisabled)
    }

    private func sessionDetail(_ session: RemoteSession) -> some View {
        RemoteSessionDetailView(session: session, client: workspace.client, draftStore: model.draftStore) {
            Task { await workspace.reloadSessions() }
        }
    }
}

struct RemoteSessionRow: View {
    let session: RemoteSession
    var busy = false
    var showsOrigin = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if session.pinned == true {
                    Image(systemName: "pin.fill").font(.caption2).foregroundStyle(HermesTheme.accent).accessibilityLabel("已置顶")
                }
                Text(session.displayTitle).font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.ink).lineLimit(1)
                if busy { ProgressView().controlSize(.mini) }
                Spacer(minLength: 6)
                if let date = session.lastActive.map(Date.init(timeIntervalSince1970:)) {
                    Text(date, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(HermesTheme.muted).lineLimit(1)
                }
            }
            if let preview = session.preview, !preview.isEmpty {
                Text(preview).font(.footnote).foregroundStyle(HermesTheme.muted).lineLimit(2)
            }
            HStack(spacing: 8) {
                if showsOrigin { OriginBadge(origin: .server) }
                Text(session.source ?? "Hermes")
                if let count = session.messageCount { Text("· \(count) 条消息") }
            }.font(.caption2).foregroundStyle(HermesTheme.muted)
        }
    }
}

struct RemoteUpdatedRow: View {
    let date: Date
    var body: some View {
        HStack(spacing: 4) {
            Spacer()
            Text("最近刷新")
            Text(date, style: .relative)
            Spacer()
        }
        .font(.caption2).foregroundStyle(HermesTheme.muted)
        .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}
