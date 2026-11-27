import SwiftUI

/// 「对话」页的来源筛选：全部合并展示，本机与服务端各自保留完整功能。
enum ConversationSource: String, CaseIterable, Identifiable {
    case all, local, server, archived, trash
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "全部"
        case .local: "本机"
        case .server: "服务端"
        case .archived: "已归档"
        case .trash: "回收站"
        }
    }
    var icon: String? {
        switch self {
        case .local: "iphone"
        case .server: "server.rack"
        default: nil
        }
    }
}

/// v5「对话」页：本机对话与服务端会话在一处查找，来源用标记区分。
struct ConversationsView: View {
    @EnvironmentObject private var model: AppModel
    let onOpenChat: () -> Void

    var body: some View {
        ConversationsContent(client: model.makeRemoteClient(), onOpenChat: onOpenChat)
            .id(model.settings)
    }
}

private struct ConversationsContent: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var remote: RemoteWorkspaceModel
    @AppStorage("conversationSource") private var sourceValue = ConversationSource.all.rawValue
    let onOpenChat: () -> Void

    init(client: HermesClient, onOpenChat: @escaping () -> Void) {
        _remote = StateObject(wrappedValue: RemoteWorkspaceModel(client: client))
        self.onOpenChat = onOpenChat
    }

    private var source: ConversationSource { ConversationSource(rawValue: sourceValue) ?? .all }

    var body: some View {
        Group {
            switch source {
            case .all: MergedConversationList(remote: remote, onOpenChat: onOpenChat)
            case .local: HistoryView(embedded: true, initialScope: .active, showsScopeControls: false, onOpen: onOpenChat)
            case .archived: HistoryView(embedded: true, initialScope: .archived, showsScopeControls: false, onOpen: onOpenChat)
            case .trash: HistoryView(embedded: true, initialScope: .trash, showsScopeControls: false, onOpen: onOpenChat)
            case .server:
                if remote.client.settings.isConfigured { RemoteSessionPane(workspace: remote) }
                else {
                    ContentUnavailableView("先连接 Hermes", systemImage: "server.rack",
                        description: Text("在设置中填写服务器地址和 API 密钥后，服务端会话会出现在这里。"))
                        .frame(maxHeight: .infinity).background(HermesTheme.background)
                }
            }
        }
        .id(source)
        .safeAreaInset(edge: .top, spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(ConversationSource.allCases) { value in
                        FilterChip(title: value.title, icon: value.icon, selected: source == value) { sourceValue = value.rawValue }
                            .accessibilityIdentifier("conversations-source-\(value.rawValue)")
                    }
                }
                .padding(.horizontal, HermesMetrics.page).padding(.vertical, 8)
            }
            .background(HermesTheme.background)
        }
        .navigationTitle("对话")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private enum MergedEntry: Identifiable {
    case local(Conversation)
    case remote(RemoteSession)

    var id: String {
        switch self {
        case .local(let conversation): "local-" + conversation.id.uuidString
        case .remote(let session): "remote-" + session.id
        }
    }
    var date: Date {
        switch self {
        case .local(let conversation): conversation.updatedAt
        case .remote(let session): Date(timeIntervalSince1970: session.lastActive ?? 0)
        }
    }
    var pinned: Bool {
        switch self {
        case .local(let conversation): conversation.isPinned
        case .remote(let session): session.pinned == true
        }
    }
}

/// 「全部」：进行中的本机对话与已加载的服务端会话按时间合并，置顶优先。
private struct MergedConversationList: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var remote: RemoteWorkspaceModel
    let onOpenChat: () -> Void
    @State private var query = ""
    @State private var creatingSession = false
    @State private var newSessionTitle = ""
    @State private var openedSession: RemoteSession?
    @State private var showingSession = false

    private var configured: Bool { remote.client.settings.isConfigured }

    private var entries: [MergedEntry] {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let local = ConversationWorkbench.filtered(model.conversations, scope: .active, query: text, tag: nil, sort: .recent)
            .map(MergedEntry.local)
        let server = remote.filteredSessions(query: text, pinnedOnly: false).map(MergedEntry.remote)
        return (local + server).sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            if a.date != b.date { return a.date > b.date }
            return a.id < b.id
        }
    }

    var body: some View {
        let entries = entries
        List {
            if !configured {
                Label("连接服务器后，服务端会话也会出现在这里。", systemImage: "server.rack")
                    .font(.caption).foregroundStyle(HermesTheme.muted).cardRow()
            } else if let error = remote.sessionsError {
                RemoteLoadBanner(message: error, hasRecords: !remote.sessions.isEmpty, disabled: remote.sessionActionsDisabled) {
                    Task { await remote.reloadSessions() }
                }
                .cardRow()
            }
            if entries.isEmpty {
                if remote.isLoadingSessions {
                    ProgressView("正在读取…").frame(maxWidth: .infinity).cardRow(top: 24)
                } else {
                    ContentUnavailableView(query.isEmpty ? "还没有对话" : "没有匹配的对话",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text(query.isEmpty ? "点右上角开始一段新对话。" : "试试其他关键词，或切换到本机、服务端查看更多范围。"))
                        .cardRow(top: 24)
                }
            }
            Section {
                ForEach(entries) { entry in
                    switch entry {
                    case .local(let conversation):
                        Button {
                            if model.select(conversation.id) { onOpenChat() }
                        } label: {
                            WorkspaceConversationRow(conversation: conversation, projectName: model.project(for: conversation)?.name, showsOrigin: true)
                        }
                        .buttonStyle(.plain).disabled(model.isSending)
                        .hermesCard(padding: 14).cardRow()
                        .contextMenu {
                            Button(conversation.isPinned ? "取消置顶" : "置顶", systemImage: "pin") { model.togglePin(conversation.id) }
                            Button("归档", systemImage: "archivebox") {
                                do { try model.setArchived([conversation.id], archived: true) }
                                catch { model.errorMessage = error.localizedDescription }
                            }
                        }
                    case .remote(let session):
                        Button { openedSession = session; showingSession = true } label: {
                            RemoteSessionRow(session: session, busy: remote.busySessionID == session.id, showsOrigin: true)
                        }
                        .buttonStyle(.plain)
                        .hermesCard(padding: 14).cardRow()
                    }
                }
            } header: {
                if !entries.isEmpty {
                    HStack {
                        Text("本机 \(model.conversations.filter { !$0.isArchived }.count)" + (configured ? " · 服务端已加载 \(remote.sessions.count)" : ""))
                        Spacer()
                        Text("置顶优先 · 最近活动")
                    }
                    .font(.caption).foregroundStyle(HermesTheme.muted).textCase(nil)
                }
            }
            if remote.hasMoreSessions {
                Button {
                    Task { await remote.loadMoreSessions() }
                } label: {
                    if remote.isLoadingMoreSessions { ProgressView().frame(maxWidth: .infinity) }
                    else { Text("加载更多服务端会话").frame(maxWidth: .infinity) }
                }
                .disabled(remote.sessionActionsDisabled)
                .cardRow()
            }
        }
        .listStyle(.plain).hermesPage()
        .searchable(text: $query, prompt: "搜索本机对话与已加载的服务端会话")
        .refreshable { if configured { await remote.reloadSessions() } }
        .task { if configured && remote.sessions.isEmpty { await remote.reloadSessions() } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("新建本机对话", systemImage: "iphone") {
                        if model.newConversation() { onOpenChat() }
                    }
                    .disabled(model.isSending || model.needsRecovery)
                    Button("新建服务端会话", systemImage: "server.rack") { newSessionTitle = ""; creatingSession = true }
                        .disabled(!configured || remote.sessionActionsDisabled)
                } label: { Image(systemName: "square.and.pencil") }
                .accessibilityLabel("新建对话").accessibilityIdentifier("conversations-new")
            }
        }
        .navigationDestination(isPresented: $showingSession) {
            if let session = openedSession { sessionDetail(session) }
        }
        .alert("新建服务端会话", isPresented: $creatingSession) {
            TextField("标题（可选）", text: $newSessionTitle)
            Button("取消", role: .cancel) {}
            Button("创建") {
                Task {
                    if let session = await remote.createSession(title: newSessionTitle) {
                        openedSession = session
                        showingSession = true
                    }
                }
            }
        } message: { Text("消息会保存在 Hermes 服务器上，可从其他客户端继续。") }
        .alert("操作失败", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("知道了", role: .cancel) { model.errorMessage = nil }
        } message: { Text(model.errorMessage ?? "") }
        .remoteActionErrorAlert(remote)
    }

    private func sessionDetail(_ session: RemoteSession) -> some View {
        RemoteSessionDetailView(session: session, client: remote.client, draftStore: model.draftStore) {
            Task { await remote.reloadSessions() }
        }
    }
}
