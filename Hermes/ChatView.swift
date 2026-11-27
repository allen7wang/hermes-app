import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

private struct PromptComposerContext: Identifiable {
    let id = UUID()
    let profileID: UUID
    let draftKey: String
    let title: String
}

private struct ProjectReferenceSelectionTarget: Identifiable {
    let id = UUID()
    let conversationID: UUID
    let profileID: UUID
}

struct ChatView: View {
    var initialTarget: LocalMessageTarget? = nil
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var showingSettings = false
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var pendingImage: Data?
    @State private var loadingPhoto = false
    @State private var showingSearch = false
    @State private var searchSelection: String?
    @State private var jumpRequest: TimelineJumpRequest?
    @State private var showingLibrary = false
    @State private var librarySelection: LocalMessageTarget?
    @State private var bookmarkNoteTarget: LocalMessageTarget?
    @State private var composerNotice: String?
    @State private var editingMessage: ChatMessage?
    @State private var promptContext: PromptComposerContext?
    @State private var settingsTarget: ConversationSettingsTarget?
    @State private var exportDocument: ConversationDocument?
    @State private var exporting = false
    @State private var contextPreview: ChatContextPreview?
    @State private var referenceSelection: ProjectReferenceSelectionTarget?
    @State private var documentCapture: ProjectDocumentCapture?

    var body: some View {
        VStack(spacing: 0) {
            header
            configurationBar
            Rectangle().fill(HermesTheme.hairline).frame(height: 1)
            if model.selectedConversation?.isArchived == true {
                HStack {
                    Label("已归档 · 恢复后可继续发送", systemImage: "archivebox").foregroundStyle(HermesTheme.ink)
                    Spacer()
                    Button("恢复") {
                        if let id = model.selectedID { performLocalAction { try model.setArchived([id], archived: false) } }
                    }
                    .buttonStyle(HermesPillButtonStyle(tone: .accent))
                    .disabled(model.isSending)
                }.font(.caption).padding(.horizontal, 16).padding(.vertical, 8).background(HermesTheme.warning.opacity(0.12))
            }

            ChatTimeline(contextID: model.selectedID?.uuidString ?? "new", updateToken: timelineToken, jumpRequest: $jumpRequest) { _, _ in
                if let conversation = model.selectedConversation {
                    LazyVStack(spacing: 22) {
                        ForEach(conversation.messages) { message in
                            MessageBubble(message: message, attachmentDirectory: model.attachmentDirectory,
                                          highlighted: highlightedID == message.id.uuidString,
                                          captureAction: conversation.projectID == nil ? nil : {
                                              performLocalAction {
                                                  documentCapture = try model.captureProjectDocument(
                                                      LocalMessageTarget(conversationID: conversation.id, messageID: message.id),
                                                      profileID: model.activeProfileID)
                                              }
                                          }, captureDisabled: model.isSending || model.needsRecovery)
                                .id(TimelineAnchor.message(message.id.uuidString))
                                .contextMenu {
                                    Button(message.bookmark == nil ? "收藏消息" : "取消收藏", systemImage: message.bookmark == nil ? "bookmark" : "bookmark.fill") {
                                        performLocalAction { try model.toggleBookmark(LocalMessageTarget(conversationID: conversation.id, messageID: message.id)) }
                                    }.disabled(model.needsRecovery)
                                    if message.bookmark != nil {
                                        Button("编辑收藏备注", systemImage: "note.text") {
                                            bookmarkNoteTarget = LocalMessageTarget(conversationID: conversation.id, messageID: message.id)
                                        }.disabled(model.needsRecovery)
                                    }
                                    Button("引用到草稿", systemImage: "text.quote") {
                                        performLocalAction {
                                            try model.quoteMessage(LocalMessageTarget(conversationID: conversation.id, messageID: message.id))
                                            composerNotice = "已引用到当前草稿，尚未发送。"
                                        }
                                    }.disabled(model.needsRecovery)
                                    Button("复制消息", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.content }
                                        .disabled(message.content.isEmpty)
                                    if conversation.projectID != nil {
                                        Button("存为项目资料", systemImage: "doc.badge.plus") {
                                            performLocalAction {
                                                documentCapture = try model.captureProjectDocument(
                                                    LocalMessageTarget(conversationID: conversation.id, messageID: message.id),
                                                    profileID: model.activeProfileID)
                                            }
                                        }.disabled(model.needsRecovery || model.isSending || message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                    }
                                    ShareLink(item: message.content) { Label("分享文字", systemImage: "square.and.arrow.up") }
                                        .disabled(message.content.isEmpty)
                                    Button("从这里创建分支", systemImage: "arrow.triangle.branch") {
                                        _ = model.branchConversation(at: message.id)
                                    }.disabled(model.isSending || model.needsRecovery)
                                    if message.role == .user {
                                        Button("修改后重新发送", systemImage: "pencil") { editingMessage = message }
                                            .disabled(model.isSending || model.needsRecovery)
                                    }
                                }
                        }
                        if !model.streamedReply.isEmpty {
                            MessageBubble(message: ChatMessage(role: .assistant, content: model.streamedReply),
                                          attachmentDirectory: model.attachmentDirectory)
                        }
                        if model.isSending { thinkingIndicator }
                        else if conversation.messages.last?.role == .user {
                            HStack {
                                Button { model.retryLastResponse() } label: { Label("生成回复", systemImage: "arrow.clockwise") }
                                    .buttonStyle(HermesPillButtonStyle(tone: .accent))
                                Spacer()
                            }
                        }
                    }
                    .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 24)
                } else {
                    welcome.frame(maxWidth: .infinity, minHeight: 480)
                }
            }

            composer
                .disabled(model.selectedConversation?.isArchived == true)
        }
        .background(HermesTheme.background.ignoresSafeArea())
        .sheet(isPresented: $showingSettings) { SettingsView() }
        .sheet(item: $contextPreview) { preview in
            ChatContextPreviewView(preview: preview, pendingImage: pendingImage)
        }
        .sheet(item: $referenceSelection) { target in
            ProjectDocumentSelectionView(conversationID: target.conversationID, profileID: target.profileID)
        }
        .sheet(item: $documentCapture) { capture in ProjectDocumentCaptureView(capture: capture) }
        .sheet(item: $settingsTarget) { target in
            ConversationSettingsView(conversationID: target.conversationID, profileID: target.profileID, draftKey: target.draftKey)
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: ConversationDocument.markdownType,
                      defaultFilename: ConversationWorkbench.filename(model.selectedConversation?.title ?? "Hermes-对话")) { result in
            if case .failure(let error) = result { model.errorMessage = error.localizedDescription }
        }
        .onAppear { openInitialTarget() }
        .onChange(of: initialTarget) { _, _ in openInitialTarget() }
        .sheet(item: $promptContext) { context in
            PromptLibraryView(profileID: context.profileID, contextTitle: context.title,
                              currentDraft: { model.draft }) { text, mode in
                try model.applyPrompt(text, mode: mode, expectedDraftKey: context.draftKey)
                composerNotice = "已套用提示词，尚未发送。"
            }
        }
        .sheet(item: $editingMessage) { EditMessageView(message: $0) }
        .sheet(item: $bookmarkNoteTarget) { target in
            BookmarkNoteView(target: target, note: model.libraryItem(target)?.message.bookmark?.note ?? "")
        }
        .sheet(isPresented: $showingLibrary, onDismiss: {
            if let target = librarySelection {
                performLocalAction {
                    try model.openMessage(target)
                    jumpRequest = TimelineJumpRequest(contextID: target.conversationID.uuidString, messageID: target.messageID.uuidString)
                }
            }
            librarySelection = nil
        }) {
            MessageLibraryView { target in librarySelection = target; showingLibrary = false }
        }
        .sheet(isPresented: $showingSearch, onDismiss: {
            if let searchSelection { jumpRequest = TimelineJumpRequest(contextID: model.selectedID?.uuidString ?? "new", messageID: searchSelection) }
            searchSelection = nil
        }) {
            MessageSearchView(entries: searchEntries, scope: "当前本机对话") { searchSelection = $0 }
        }
        .onChange(of: model.selectedID) { _, id in
            if jumpRequest?.contextID != id?.uuidString { jumpRequest = nil }
        }
        .task(id: model.settings) { await model.checkConnection() }
        .onChange(of: model.draftKey) { _, _ in
            composerNotice = nil
            pendingImage = nil
            selectedPhoto = nil
            loadingPhoto = false
        }
        .onChange(of: selectedPhoto) { _, item in
            guard let item else { return }
            loadingPhoto = true
            let context = model.draftKey
            Task {
                do {
                    guard let original = try await item.loadTransferable(type: Data.self) else {
                        throw ImageAttachmentStore.ImageError.invalidImage
                    }
                    guard context == model.draftKey, selectedPhoto == item else { return }
                    pendingImage = try ImageAttachmentStore.prepare(original)
                } catch {
                    guard context == model.draftKey, selectedPhoto == item else { return }
                    model.errorMessage = error.localizedDescription
                }
                guard context == model.draftKey, selectedPhoto == item else { return }
                loadingPhoto = false
                selectedPhoto = nil
            }
        }
        .alert("操作失败", isPresented: Binding(
            get: { model.errorMessage != nil },
            set: { if !$0 { model.errorMessage = nil } }
        )) {
            Button("知道了", role: .cancel) { model.errorMessage = nil }
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 4) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 40, height: 44)
            }
            .accessibilityLabel("返回对话工作台")

            VStack(alignment: .leading, spacing: 2) {
                Text(model.selectedConversation?.title ?? "新对话")
                    .font(.headline).foregroundStyle(HermesTheme.ink)
                    .lineLimit(1)
                Button {
                    if model.settings.isConfigured {
                        Task { await model.checkConnection() }
                    } else {
                        showingSettings = true
                    }
                } label: {
                    HStack(spacing: 6) {
                        StatusDot(tone: connectionTone, size: 6)
                        Text("\(model.activeProfileName) · \(connectionLabel)")
                            .lineLimit(1)
                            .font(.caption)
                            .foregroundStyle(HermesTheme.muted)
                    }
                }
                .accessibilityLabel("连接状态：\(connectionLabel)，点按重新检测")
            }
            Spacer()
            if let project = model.currentProject {
                Menu {
                    Button("在当前项目新建对话", systemImage: "folder.badge.plus") {
                        performLocalAction { _ = try model.startProjectConversation(project.id, profileID: model.activeProfileID) }
                    }.accessibilityIdentifier("chat-new-project-conversation")
                    Button("开始未分配的新对话", systemImage: "square.and.pencil") { model.newConversation() }
                } label: {
                    Image(systemName: "square.and.pencil").font(.system(size: 18)).frame(width: 42, height: 44)
                }.disabled(model.isSending || model.needsRecovery).accessibilityLabel("新对话选项")
            } else {
                Button { model.newConversation() } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 18))
                        .frame(width: 42, height: 44)
                }
                .disabled(model.isSending)
                .accessibilityLabel("新对话")
            }
            Menu {
                Section {
                    Button("对话设置与标签", systemImage: "slider.horizontal.3") { openConfiguration() }
                        .disabled(model.isSending)
                    Button("查找消息", systemImage: "magnifyingglass") { showingSearch = true }
                        .disabled(model.selectedConversation?.messages.isEmpty != false)
                    if let conversation = model.selectedConversation {
                        Button("导出 Markdown", systemImage: "square.and.arrow.up") {
                            exportDocument = ConversationDocument(text: ConversationWorkbench.markdown([conversation]))
                            exporting = true
                        }
                    }
                }
                Section {
                    Button("提示词模板", systemImage: "text.badge.plus") { openPrompts() }
                    Button("本机消息库", systemImage: "books.vertical") { showingLibrary = true }
                    Button("连接管理", systemImage: "server.rack") { showingSettings = true }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 18))
                    .frame(width: 42, height: 44)
            }
            .accessibilityLabel("消息查找与连接管理")
        }
        .foregroundStyle(HermesTheme.ink)
        .padding(.horizontal, 6)
        .padding(.top, 4)
    }

    private var configurationBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button(action: openConfiguration) {
                    configurationChip(icon: "cpu",
                                      text: model.conversationConfiguration.model.isEmpty ? model.settings.model : model.conversationConfiguration.model,
                                      trailing: model.conversationConfiguration.systemPrompt.isEmpty ? nil : "text.alignleft")
                }
                .buttonStyle(.plain).disabled(model.isSending || model.needsRecovery)
                .accessibilityLabel("对话设置，\(model.conversationConfiguration.contextLabel)")
                Button(action: openConfiguration) {
                    configurationChip(icon: "text.line.last.and.arrowtriangle.forward", text: model.conversationConfiguration.contextLabel)
                }
                .buttonStyle(.plain).disabled(model.isSending || model.needsRecovery)
                referenceBar
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
        }
    }

    private func configurationChip(icon: String, text: String, trailing: String? = nil, tone: HermesTone = .neutral) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.caption2.weight(.semibold))
            Text(text).lineLimit(1)
            if let trailing { Image(systemName: trailing).font(.caption2) }
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tone == .neutral ? HermesTheme.muted : tone.color)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(tone == .neutral ? HermesTheme.raised : tone.color.opacity(0.13), in: Capsule())
    }

    @ViewBuilder private var referenceBar: some View {
        if let conversation = model.selectedConversation, let project = model.currentProject {
            HStack(spacing: 8) {
                configurationChip(icon: "folder.fill", text: project.name + (project.instructions.isEmpty ? "" : " · 指令生效"), tone: .accent)
                    .accessibilityIdentifier("chat-project-indicator")
                Button {
                    referenceSelection = ProjectReferenceSelectionTarget(conversationID: conversation.id, profileID: model.activeProfileID)
                } label: {
                    configurationChip(icon: "doc.on.doc", text: model.currentReferenceDocuments.isEmpty ? "选择参考资料" : "参考资料 \(model.currentReferenceDocuments.count)",
                                      tone: model.currentReferenceDocuments.isEmpty ? .neutral : .accent)
                }
                .buttonStyle(.plain)
                .disabled(model.isSending || model.needsRecovery).accessibilityIdentifier("chat-reference-documents")
            }
        } else if model.selectedConversation != nil {
            Button(action: openConfiguration) {
                configurationChip(icon: "folder.badge.plus", text: "分配项目后添加参考资料")
            }
            .buttonStyle(.plain).disabled(model.isSending || model.needsRecovery)
            .accessibilityIdentifier("chat-reference-assign-project")
        }
    }

    private func openConfiguration() {
        settingsTarget = ConversationSettingsTarget(conversationID: model.selectedID, profileID: model.activeProfileID, draftKey: model.draftKey)
    }

    private func openInitialTarget() {
        if let target = initialTarget, model.selectedID == target.conversationID {
            jumpRequest = TimelineJumpRequest(contextID: target.conversationID.uuidString, messageID: target.messageID.uuidString)
        }
    }

    private var highlightedID: String? {
        jumpRequest?.contextID == model.selectedID?.uuidString ? jumpRequest?.messageID : nil
    }

    private func openPrompts() {
        promptContext = PromptComposerContext(profileID: model.activeProfileID, draftKey: model.draftKey,
                                              title: model.selectedConversation?.title ?? "新对话")
    }

    private func performLocalAction(_ action: () throws -> Void) {
        do { try action() }
        catch { model.errorMessage = error.localizedDescription }
    }

    private var timelineToken: String {
        "\(model.selectedConversation?.messages.last?.id.uuidString ?? "")|\(model.streamedReply.count)|\(model.isSending)"
    }

    private var searchEntries: [MessageSearchEntry] {
        (model.selectedConversation?.messages ?? []).map {
            MessageSearchEntry(id: $0.id.uuidString, label: $0.role == .user ? "我" : "Hermes", text: $0.content)
        }
    }

    private var connectionLabel: String {
        switch model.connectionState {
        case .unconfigured: "等待连接"
        case .checking: "正在检测"
        case .connected: "已连接"
        case .offline: "连接失败"
        }
    }

    private var connectionTone: HermesTone {
        switch model.connectionState {
        case .unconfigured: .warning
        case .checking: .info
        case .connected: .success
        case .offline: .danger
        }
    }

    private var welcome: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 60)
            HermesMark(size: 64)
                .shadow(color: HermesTheme.accent.opacity(0.35), radius: 24, y: 8)
            Text("今天想让 Hermes 做什么？")
                .font(.title2.weight(.bold))
                .foregroundStyle(HermesTheme.ink)
                .padding(.top, 24)
            Text(model.settings.isConfigured
                 ? "本机对话保存在这台设备上，发送前可预览上下文。"
                 : "先连接你的 Hermes Agent，然后开始对话。")
                .font(.subheadline)
                .foregroundStyle(HermesTheme.muted)
                .multilineTextAlignment(.center)
                .padding(.top, 8)

            if !model.settings.isConfigured {
                Button { showingSettings = true } label: {
                    Label("连接 Hermes", systemImage: "link")
                }
                .buttonStyle(HermesPrimaryButtonStyle(fullWidth: false))
                .padding(.top, 28)
            } else {
                VStack(spacing: 10) {
                    suggestion("帮我总结今天的工作", icon: "text.badge.checkmark")
                    suggestion("看看现在有什么需要处理", icon: "tray.full")
                    suggestion("把这周的计划拆成待办", icon: "checklist")
                }
                .padding(.top, 28)
            }
            Spacer(minLength: 60)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }

    private func suggestion(_ text: String, icon: String) -> some View {
        Button {
            model.draft = text
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).foregroundStyle(HermesTheme.accent).frame(width: 20)
                Text(text).foregroundStyle(HermesTheme.ink)
                Spacer()
                Image(systemName: "arrow.up.left").font(.caption2.weight(.bold)).foregroundStyle(HermesTheme.muted)
            }
            .font(.subheadline)
            .hermesCard(padding: 14, radius: 14)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 380)
    }

    private var thinkingIndicator: some View {
        RunStatusBar(text: model.toolStatus ?? (model.streamedReply.isEmpty ? "Hermes 正在思考…" : "正在生成回复…")) {
            model.cancelSend()
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let composerNotice {
                HStack(spacing: 8) {
                    Image(systemName: "info.circle.fill").foregroundStyle(HermesTheme.accent)
                    Text(composerNotice).font(.caption).foregroundStyle(HermesTheme.ink)
                    Spacer()
                    Button { self.composerNotice = nil } label: { Image(systemName: "xmark").font(.caption2.weight(.bold)) }
                        .foregroundStyle(HermesTheme.muted)
                        .accessibilityLabel("关闭草稿提示")
                }
                .padding(.horizontal, 6)
            }
            VStack(alignment: .leading, spacing: 4) {
                if let pendingImage, let preview = UIImage(data: pendingImage) {
                    PendingImageThumbnail(image: preview) { self.pendingImage = nil }
                }
                TextField("给 Hermes 发送消息…", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .font(.body)
                    .tint(HermesTheme.accent)
                    .padding(.horizontal, 4).padding(.vertical, 6)
                    .accessibilityLabel("消息内容")
                HStack(spacing: 2) {
                    PhotosPicker(selection: $selectedPhoto, matching: .images) {
                        ComposerIconLabel(systemName: "photo", loading: loadingPhoto)
                    }
                    .disabled(model.isSending || loadingPhoto)
                    .accessibilityLabel("添加图片")
                    Button { openPrompts() } label: { ComposerIconLabel(systemName: "text.badge.plus") }
                        .accessibilityLabel("提示词模板")
                    Button {
                        performLocalAction {
                            contextPreview = try model.previewNextRequest(model.draft, hasImage: pendingImage != nil, expectedDraftKey: model.draftKey)
                        }
                    } label: { ComposerIconLabel(systemName: "eye") }
                    .disabled(model.isSending || loadingPhoto || model.needsRecovery ||
                        (model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pendingImage == nil))
                    .accessibilityLabel("上下文预览")
                    .accessibilityIdentifier("preview-chat-context")
                    Spacer()
                    if model.isSending {
                        StopButton { model.cancelSend() }
                    } else {
                        SendButton(enabled: canSend) {
                            if model.settings.isConfigured {
                                if model.send(model.draft, imageData: pendingImage) {
                                    composerNotice = nil
                                    pendingImage = nil
                                }
                            } else {
                                showingSettings = true
                            }
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

    private var canSend: Bool {
        (!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingImage != nil)
            && !model.isSending && !loadingPhoto
    }
}

private struct MessageBubble: View {
    let message: ChatMessage
    let attachmentDirectory: URL
    var highlighted = false
    var captureAction: (() -> Void)? = nil
    var captureDisabled = false

    var body: some View {
        ChatMessageRow(role: message.role == .user ? .user : .assistant, text: message.content,
                       image: message.imageID.flatMap { ImageAttachmentStore.image($0, directory: attachmentDirectory) },
                       highlighted: highlighted, bookmarked: message.bookmark != nil) {
            if let captureAction, !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Button(action: captureAction) {
                    Label("存为项目资料", systemImage: "doc.badge.plus")
                }
                .buttonStyle(HermesPillButtonStyle(tone: .accent))
                .disabled(captureDisabled)
                .accessibilityIdentifier("capture-message-\(message.id)")
            }
        }
    }
}
