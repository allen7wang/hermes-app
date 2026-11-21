import SwiftUI

/// v5 工作台：连接状态、统一检索、待处理（审批 / 失败 / 运行中）、继续草稿、最近对话与常用入口。
struct WorkspaceHomeView: View {
    @EnvironmentObject private var model: AppModel
    let onOpenChat: (LocalMessageTarget?) -> Void
    var onShowConversations: () -> Void = {}
    var onShowProjects: () -> Void = {}

    var body: some View {
        WorkspaceHomeContent(client: model.makeRemoteClient(), onOpenChat: onOpenChat,
                             onShowConversations: onShowConversations, onShowProjects: onShowProjects)
            .id(model.settings)
    }
}

private struct WorkspaceHomeContent: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var inbox: InboxController
    let onOpenChat: (LocalMessageTarget?) -> Void
    let onShowConversations: () -> Void
    let onShowProjects: () -> Void
    @State private var error: String?
    @State private var showingSettings = false
    @State private var showingLibrary = false
    @State private var librarySelection: LocalMessageTarget?
    @State private var libraryShowsDraft = false
    @State private var inboxRoute: InboxRoute?

    init(client: HermesClient, onOpenChat: @escaping (LocalMessageTarget?) -> Void,
         onShowConversations: @escaping () -> Void, onShowProjects: @escaping () -> Void) {
        _inbox = StateObject(wrappedValue: InboxController(client: client))
        self.onOpenChat = onOpenChat
        self.onShowConversations = onShowConversations
        self.onShowProjects = onShowProjects
    }

    private var unavailable: Bool { model.isSending || model.needsRecovery }

    var body: some View {
        let snapshot = try? model.workspaceSnapshot()
        let drafts = snapshot?.draftItems() ?? []
        let recent = model.conversations.filter { !$0.isArchived }.sorted {
            $0.updatedAt == $1.updatedAt ? $0.id.uuidString < $1.id.uuidString : $0.updatedAt > $1.updatedAt
        }
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                VStack(spacing: 12) {
                    connectionCard
                    NavigationLink { WorkspaceSearchView(onOpenChat: onOpenChat) } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "magnifyingglass").foregroundStyle(HermesTheme.muted)
                            Text("搜索对话、消息、项目、资料与草稿").foregroundStyle(HermesTheme.muted)
                            Spacer()
                        }
                        .font(.subheadline)
                        .padding(.horizontal, 14).frame(height: 44)
                        .background(HermesTheme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain).disabled(model.needsRecovery).accessibilityIdentifier("home-search")
                    Button {
                        do { try model.startWorkspaceConversation(profileID: model.activeProfileID); onOpenChat(nil) }
                        catch { self.error = error.localizedDescription }
                    } label: {
                        Label("开始新对话", systemImage: "square.and.pencil")
                    }
                    .buttonStyle(HermesPrimaryButtonStyle())
                    .disabled(unavailable).accessibilityIdentifier("home-new-chat")
                    if model.isSending {
                        Text("回复正在生成，完成或停止后可切换对话。").font(.caption).foregroundStyle(HermesTheme.muted)
                    }
                }

                pendingSection
                if !drafts.isEmpty { draftSection(drafts) }
                recentSection(recent)
                shortcutGrid(drafts: drafts.count)
            }
            .padding(.horizontal, HermesMetrics.page)
            .padding(.top, 4).padding(.bottom, 32)
        }
        .background(HermesTheme.background)
        .refreshable { await inbox.reloadJobs() }
        .task {
            if model.connectionState != .connected { await model.checkConnection() }
            await inbox.reloadJobs()
        }
        .navigationTitle("工作台").navigationBarTitleDisplayMode(.large)
        .navigationDestination(item: $inboxRoute) { InboxRouteDestination(route: $0, client: inbox.client) }
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .sheet(isPresented: $showingLibrary, onDismiss: {
            if let target = librarySelection {
                do { try model.openMessage(target); onOpenChat(target) }
                catch { self.error = error.localizedDescription }
            } else if libraryShowsDraft { onOpenChat(nil) }
            librarySelection = nil
            libraryShowsDraft = false
        }) {
            MessageLibraryView(onShowDraft: { libraryShowsDraft = true; showingLibrary = false }) { target in
                librarySelection = target
                showingLibrary = false
            }
        }
        .alert("暂时无法打开", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("知道了", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
        .inboxErrorAlert(inbox)
    }

    // MARK: 连接

    private var connectionCard: some View {
        let state = connectionState
        return Button { showingSettings = true } label: {
            HStack(spacing: 12) {
                HermesMark(size: 40)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.activeProfileName).font(.headline).foregroundStyle(HermesTheme.ink).lineLimit(1)
                    Text(connectionDetail).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(1)
                }
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    StatusDot(tone: state.tone)
                    Text(state.title).font(.caption.weight(.semibold)).foregroundStyle(state.tone == .neutral ? HermesTheme.muted : state.tone.color)
                }
                Image(systemName: "chevron.right").font(.caption.weight(.bold)).foregroundStyle(HermesTheme.muted)
            }
            .hermesCard(padding: 14)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(model.activeProfileName)，\(state.title)，打开连接设置")
        .accessibilityIdentifier("home-connection-status")
    }

    private var connectionState: (title: String, tone: HermesTone) {
        if model.needsRecovery { return ("需要恢复", .danger) }
        if !model.settings.isConfigured { return ("未配置", .warning) }
        switch model.connectionState {
        case .connected: return ("已连接", .success)
        case .checking: return ("检测中", .info)
        case .offline: return ("连接失败", .danger)
        case .unconfigured: return ("未配置", .warning)
        }
    }

    private var connectionDetail: String {
        if model.needsRecovery { return "本机数据需要恢复，点按打开设置" }
        guard model.settings.isConfigured else { return "填写服务地址与密钥，连接你自己的 Hermes" }
        let host = URL(string: model.settings.serverURL)?.host ?? model.settings.serverURL
        return host + " · " + model.settings.model
    }

    // MARK: 待处理

    @ViewBuilder private var pendingSection: some View {
        let approvals = Array(inbox.approvals.prefix(2))
        let jobs = Array(inbox.attentionJobs.prefix(max(0, 3 - approvals.count)))
        let outcomes = Array(inbox.outcomes.prefix(max(0, 3 - approvals.count - jobs.count)))
        VStack(alignment: .leading, spacing: 12) {
            NavigationLink { InboxView(inbox: inbox) } label: {
                SectionTitle(title: "待处理", count: inbox.pendingCount, trailing: "收件箱")
            }
            .buttonStyle(.plain).accessibilityIdentifier("home-inbox")
            if inbox.jobsError != nil { InboxJobsLoadError(inbox: inbox) }
            if approvals.isEmpty && jobs.isEmpty && outcomes.isEmpty && inbox.jobsError == nil {
                HStack(spacing: 12) {
                    IconTile(systemName: inbox.loadingJobs ? "arrow.triangle.2.circlepath" : "checkmark", tone: .success, size: 32)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(inbox.loadingJobs ? "正在读取…" : "一切就绪").font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.ink)
                        Text(model.settings.isConfigured ? "需要你审批、失败或正在运行的事项会出现在这里。" : "连接服务器后，审批与任务状态会出现在这里。")
                            .font(.caption).foregroundStyle(HermesTheme.muted)
                    }
                }
                .hermesCard(padding: 14)
            }
            ForEach(approvals) { item in
                InboxApprovalRow(item: item, inbox: inbox) { inboxRoute = .session(item.sessionID) }
            }
            ForEach(jobs) { job in
                Button { inboxRoute = .job(job.id) } label: { InboxJobRow(job: job) }.buttonStyle(.plain)
            }
            ForEach(outcomes) { item in
                Button { inboxRoute = .session(item.sessionID) } label: { InboxOutcomeRow(item: item) }.buttonStyle(.plain)
            }
        }
    }

    // MARK: 草稿与最近

    private func draftSection(_ drafts: [WorkspaceSearchResult]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NavigationLink { WorkspaceDraftListView(onOpenChat: onOpenChat) } label: {
                SectionTitle(title: "继续草稿", count: drafts.count, trailing: drafts.count > 3 ? "全部" : nil)
            }
            .buttonStyle(.plain).disabled(model.needsRecovery).accessibilityIdentifier("home-all-drafts")
            groupedCard(Array(drafts.prefix(3))) { item in
                Button { open(item.destination) } label: { WorkspaceSearchResultRow(item: item) }
                    .buttonStyle(.plain).disabled(unavailable)
            }
        }
    }

    @ViewBuilder private func recentSection(_ recent: [Conversation]) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Button(action: onShowConversations) {
                SectionTitle(title: "最近对话", trailing: "全部")
            }
            .buttonStyle(.plain).accessibilityIdentifier("home-all-conversations")
            if recent.isEmpty {
                Text("从一段新对话开始。发送后会自动保存在本机。")
                    .font(.subheadline).foregroundStyle(HermesTheme.muted).hermesCard(padding: 14)
            } else {
                groupedCard(Array(recent.prefix(4))) { conversation in
                    Button { open(.conversation(conversation.id)) } label: {
                        WorkspaceConversationRow(conversation: conversation, projectName: model.project(for: conversation)?.name)
                    }
                    .buttonStyle(.plain).disabled(unavailable)
                    .accessibilityIdentifier("home-recent-\(conversation.id)")
                }
            }
        }
    }

    private func groupedCard<Item: Identifiable, Row: View>(_ items: [Item], @ViewBuilder row: @escaping (Item) -> Row) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                row(item).padding(.horizontal, 14).padding(.vertical, 12)
                if index < items.count - 1 { Rectangle().fill(HermesTheme.hairline).frame(height: 1).padding(.leading, 14) }
            }
        }
        .background(HermesTheme.surface, in: RoundedRectangle(cornerRadius: HermesMetrics.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: HermesMetrics.cardRadius, style: .continuous).stroke(HermesTheme.hairline, lineWidth: 1))
    }

    // MARK: 常用入口

    private func shortcutGrid(drafts: Int) -> some View {
        let bookmarks = model.conversations.reduce(0) { $0 + $1.messages.filter { $0.bookmark != nil }.count }
        let runningJobs = inbox.jobs.filter(InboxController.isRunning).count
        return VStack(alignment: .leading, spacing: 12) {
            SectionTitle(title: "常用")
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 12) {
                Button { showingLibrary = true } label: {
                    shortcutTile("消息库", detail: "收藏 \(bookmarks)", icon: "books.vertical.fill", tone: .accent)
                }
                .buttonStyle(.plain).disabled(model.needsRecovery).accessibilityIdentifier("home-library")
                NavigationLink { RemoteWorkspaceView(embedded: true, initialSection: 1) } label: {
                    shortcutTile("定时任务", detail: model.settings.isConfigured ? (inbox.didLoadJobs ? "\(inbox.jobs.count) 个 · 运行中 \(runningJobs)" : "服务端任务") : "需要连接",
                                 icon: "calendar.badge.clock", tone: .info)
                }
                .buttonStyle(.plain).accessibilityIdentifier("home-jobs")
                NavigationLink { WorkspaceDraftListView(onOpenChat: onOpenChat) } label: {
                    shortcutTile("全部草稿", detail: "\(drafts) 份", icon: "tray.full.fill", tone: .warning)
                }
                .buttonStyle(.plain).disabled(model.needsRecovery)
                Button(action: onShowProjects) {
                    shortcutTile("项目", detail: "\(model.projects.count) 个", icon: "folder.fill", tone: .success)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func shortcutTile(_ title: String, detail: String, icon: String, tone: HermesTone) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            IconTile(systemName: icon, tone: tone, size: 34)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.ink)
                Text(detail).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(1)
            }
        }
        .hermesCard(padding: 14)
        .contentShape(Rectangle())
    }

    private func open(_ destination: WorkspaceDestination) {
        do {
            try model.openWorkspaceDestination(destination, profileID: model.activeProfileID)
            onOpenChat(nil)
        } catch { self.error = error.localizedDescription }
    }
}

struct WorkspaceDetailDestination: View {
    let destination: WorkspaceDestination
    let profileID: UUID
    let onOpenChat: (LocalMessageTarget?) -> Void
    var body: some View {
        switch destination {
        case .project(let id): ProjectDetailView(projectID: id, profileID: profileID) { onOpenChat(nil) }
        case .document(let project, let document): ProjectDocumentDetailView(projectID: project, profileID: profileID, documentID: document)
        default: ContentUnavailableView("目标已改变", systemImage: "arrow.clockwise", description: Text("请返回工作台重新打开。"))
        }
    }
}

struct WorkspaceSearchResultRow: View {
    let item: WorkspaceSearchResult
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(systemName: item.kind.icon, tone: .accent, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.ink).lineLimit(2)
                    if item.archived { StatusBadge(text: "已归档", tone: .neutral) }
                }
                Text(item.subtitle).font(.caption).foregroundStyle(HermesTheme.accent).lineLimit(2)
                Text(item.excerpt).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(3)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption2.weight(.bold)).foregroundStyle(HermesTheme.muted).padding(.top, 6)
        }
        .contentShape(Rectangle())
    }
}
