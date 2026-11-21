import SwiftUI
import PhotosUI
import UIKit

struct RemoteSessionDetailView: View {
    @EnvironmentObject private var model: AppModel
    @StateObject private var conversation: RemoteConversationModel
    @Environment(\.dismiss) private var dismiss
    let onChange: () -> Void
    @State private var editingTitle = false
    @State private var title = ""
    @State private var deleting = false
    @State private var busy = false
    @State private var showingSearch = false
    @State private var searchSelection: String?
    @State private var jumpRequest: TimelineJumpRequest?
    @State private var showingPrompts = false
    @State private var promptNotice = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var loadingPhoto = false
    @State private var revision = ""

    init(session: RemoteSession, client: HermesClient, draftStore: DraftStore, onChange: @escaping () -> Void) {
        _conversation = StateObject(wrappedValue: RemoteConversationModel.open(session: session, client: client, draftStore: draftStore))
        self.onChange = onChange
    }

    var body: some View {
        VStack(spacing: 0) {
            ChatTimeline(contextID: conversation.session.id, updateToken: timelineToken, jumpRequest: $jumpRequest) { proxy, pauseFollow in
                LazyVStack(alignment: .leading, spacing: 22) {
                    if conversation.isLoading { ProgressView("正在读取消息…").frame(maxWidth: .infinity) }
                    if conversation.hasOlderMessages {
                        Button {
                            pauseFollow()
                            let anchor = conversation.visibleMessages.first?.id
                            Task {
                                await conversation.loadOlder()
                                await Task.yield()
                                if let anchor { proxy.scrollTo(TimelineAnchor.message(anchor), anchor: .top) }
                            }
                        } label: {
                            HStack {
                                Spacer()
                                if conversation.isLoadingOlder { ProgressView() }
                                else { Label("加载更早的消息", systemImage: "arrow.up") }
                                Spacer()
                            }
                        }
                        .buttonStyle(HermesPillButtonStyle(tone: .neutral))
                        .disabled(!conversation.canSend || busy)
                    }
                    if conversation.visibleMessages.isEmpty && !conversation.isLoading && !conversation.isSending {
                        ContentUnavailableView("开始这段会话", systemImage: "server.rack",
                                               description: Text("发送消息后，Hermes 会在服务端保存对话，其他客户端也能继续。"))
                    }
                    ForEach(conversation.visibleMessages) { message in
                        ChatMessageRow(role: ChatRowRole(remoteRole: message.role, toolName: message.toolName), text: message.content,
                                       highlighted: highlightedID == message.id, failed: message.displayKind == "failed_turn")
                            .id(TimelineAnchor.message(message.id))
                            .contextMenu {
                                Button("复制消息", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.content }
                                ShareLink(item: message.content) { Label("分享文字", systemImage: "square.and.arrow.up") }
                            }
                    }
                    if conversation.transientInput != nil || conversation.transientImage != nil {
                        ChatMessageRow(role: .user, text: conversation.transientInput ?? "",
                                       image: conversation.transientImage.flatMap(UIImage.init(data:)))
                    }
                    if !conversation.streamedReply.isEmpty {
                        ChatMessageRow(role: .assistant, text: conversation.streamedReply)
                    }
                    ForEach(conversation.approvals) { approval in
                        ApprovalCard(description: approval.description, command: approval.command, choices: approval.choices,
                                     showsPaths: true, busy: conversation.approvalBusy || conversation.isStopping) { choice in
                            Task {
                                do { try await conversation.resolve(approval, choice: choice) }
                                catch { conversation.errorMessage = error.localizedDescription }
                            }
                        }
                    }
                    if conversation.isSending || !conversation.progress.isEmpty {
                        RunStatusBar(text: conversation.progress.isEmpty ? "正在运行…" : conversation.progress,
                                     running: conversation.isSending,
                                     stopTitle: conversation.isStopping ? "正在停止" : "停止",
                                     stopDisabled: conversation.isStopping,
                                     onStop: conversation.isSending ? { Task { await conversation.stop() } } : nil)
                            .id("progress")
                    }
                }
                .padding(.horizontal, 18).padding(.vertical, 20)
            }
            .refreshable { await conversation.reload() }
            composer
        }
        .background(HermesTheme.background)
        .navigationTitle(conversation.session.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("提示词模板", systemImage: "text.badge.plus") { showingPrompts = true }
                    Button("查找已加载消息", systemImage: "magnifyingglass") { showingSearch = true }
                        .disabled(conversation.visibleMessages.isEmpty)
                    Button("刷新消息", systemImage: "arrow.clockwise") { Task { await conversation.reload() } }
                        .disabled(!conversation.canSend || busy)
                    Button("重命名", systemImage: "pencil") {
                        title = conversation.session.title ?? ""
                        editingTitle = true
                    }.disabled(!conversation.canSend || busy)
                    ShareLink(item: transcript) { Label("分享已加载的记录", systemImage: "square.and.arrow.up") }
                    Button("删除服务端会话", systemImage: "trash", role: .destructive) { deleting = true }
                        .disabled(!conversation.canSend || busy)
                } label: { Image(systemName: "ellipsis.circle") }
                .accessibilityLabel("服务端会话操作")
            }
        }
        .sheet(isPresented: $showingPrompts) {
            PromptLibraryView(profileID: conversation.client.settings.profileID ?? model.activeProfileID,
                              contextTitle: "服务端 · " + conversation.session.displayTitle,
                              currentDraft: { conversation.draft }) { text, mode in
                guard conversation.client.settings.profileID == model.activeProfileID else { throw PromptError.changedContext }
                try conversation.applyPrompt(text, mode: mode)
                promptNotice = true
            }
        }
        .sheet(isPresented: $showingSearch, onDismiss: {
            if let searchSelection { jumpRequest = TimelineJumpRequest(contextID: conversation.session.id, messageID: searchSelection) }
            searchSelection = nil
        }) {
            MessageSearchView(entries: conversation.visibleMessages.map {
                MessageSearchEntry(id: $0.id, label: label(for: $0), text: $0.content)
            }, scope: "此服务端会话已加载的消息；更早记录需先加载") { searchSelection = $0 }
        }
        .task { await conversation.reload() }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            loadingPhoto = true
            let sessionID = conversation.session.id
            Task {
                // 每条退出路径都清 loading，含会话 ID 已变化的早退，避免发送按钮一直禁用。
                defer {
                    loadingPhoto = false
                    if selectedPhoto == item { selectedPhoto = nil }
                }
                do {
                    guard let original = try await item.loadTransferable(type: Data.self) else {
                        throw ImageAttachmentStore.ImageError.invalidImage
                    }
                    guard conversation.session.id == sessionID else { return }
                    conversation.attachImage(original)
                } catch {
                    guard conversation.session.id == sessionID else { return }
                    conversation.errorMessage = error.localizedDescription
                }
            }
        }
        // Keep the stream alive so an approval can be handled from the inbox after leaving this screen.
        .onDisappear { onChange() }
        .alert("重命名服务端会话", isPresented: $editingTitle) {
            TextField("标题", text: $title)
            Button("取消", role: .cancel) {}
            Button("保存") {
                Task {
                    busy = true
                    _ = await conversation.rename(to: title)
                    busy = false
                }
            }
        }
        .confirmationDialog("删除“\(conversation.session.displayTitle)”及其服务端消息？", isPresented: $deleting) {
            Button("删除", role: .destructive) {
                Task {
                    busy = true
                    if await conversation.delete() { dismiss() }
                    busy = false
                }
            }
            Button("取消", role: .cancel) {}
        }
        .alert("服务端操作失败", isPresented: Binding(
            get: { conversation.errorMessage != nil },
            set: { if !$0 { conversation.errorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { conversation.errorMessage = nil }
        } message: { Text(conversation.errorMessage ?? "") }
    }

    private var highlightedID: String? {
        jumpRequest?.contextID == conversation.session.id ? jumpRequest?.messageID : nil
    }

    private var timelineToken: String {
        "\(conversation.messages.last?.id ?? "")|\(conversation.streamedReply.count)|\(conversation.approvals.count)|\(conversation.progress)|\(conversation.transientImage?.count ?? 0)"
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if promptNotice {
                HStack(spacing: 8) {
                    Image(systemName: "info.circle.fill").foregroundStyle(HermesTheme.accent)
                    Text("已套用提示词，尚未发送。").font(.caption).foregroundStyle(HermesTheme.ink)
                    Spacer()
                    Button { promptNotice = false } label: { Image(systemName: "xmark").font(.caption2.weight(.bold)) }
                        .foregroundStyle(HermesTheme.muted).accessibilityLabel("关闭提示")
                }
                .padding(.horizontal, 6)
            }
            if conversation.isSending || !conversation.approvals.isEmpty {
                revisionField
            }
            VStack(alignment: .leading, spacing: 4) {
                if let pendingImage = conversation.pendingImage, let preview = UIImage(data: pendingImage) {
                    PendingImageThumbnail(image: preview) { conversation.removePendingImage() }
                }
                TextField("继续这段服务端会话…", text: $conversation.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .tint(HermesTheme.accent)
                    .padding(.horizontal, 4).padding(.vertical, 6)
                    .accessibilityLabel("服务端会话消息")
                HStack(spacing: 2) {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        ComposerIconLabel(systemName: "photo", loading: loadingPhoto)
                    }
                    .disabled(!conversation.canSend || loadingPhoto)
                    .accessibilityLabel("添加图片")
                    Button { showingPrompts = true } label: { ComposerIconLabel(systemName: "text.badge.plus") }
                        .accessibilityLabel("提示词模板")
                    Spacer()
                    OriginBadge(origin: .server).padding(.trailing, 6)
                    if conversation.isSending {
                        StopButton(disabled: conversation.isStopping) { Task { await conversation.stop() } }
                    } else {
                        SendButton(enabled: canSendMessage, accessibility: "发送到服务端会话") {
                            if conversation.send(conversation.draft) { promptNotice = false }
                        }
                    }
                }
            }
            .composerContainer()
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(HermesTheme.background)
    }

    private var canSendMessage: Bool {
        let hasText = !conversation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return conversation.canSend && !busy && !loadingPhoto && (hasText || conversation.pendingImage != nil)
    }

    private var revisionField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("想改方向？先停止，改口内容会放进输入框，需你再发送。不会插入当前这一轮。", systemImage: "arrow.uturn.backward")
                .font(.caption2)
                .foregroundStyle(HermesTheme.muted)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("改口内容", text: $revision, axis: .vertical)
                    .lineLimit(1...3)
                    .font(.subheadline)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(HermesTheme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                Button("停止并放进输入框") {
                    let text = revision
                    Task {
                        if await conversation.stopAndPlaceInDraft(text) { revision = "" }
                    }
                }
                .buttonStyle(HermesPillButtonStyle(tone: .danger))
                .disabled(conversation.isStopping || revision.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
        .background(HermesTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(HermesTheme.hairline, lineWidth: 1))
    }

    private func label(for message: RemoteMessage) -> String {
        switch message.role {
        case "user": return "我"
        case "assistant": return "Hermes"
        case "tool": return message.toolName ?? "工具"
        case "system": return "系统"
        default: return message.role
        }
    }

    private var transcript: String {
        "# \(conversation.session.displayTitle)\n\n" + conversation.visibleMessages.map {
            "## \(label(for: $0))\n\n\($0.content)"
        }.joined(separator: "\n\n")
    }
}
