import SwiftUI

struct SettingsView: View {
    var embedded = false
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @AppStorage(HermesAppearance.storageKey) private var appearance = HermesAppearance.system.rawValue
    @State private var showingEditor = false
    @State private var editingID: UUID?
    @State private var deletingProfile: ConnectionProfile?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 14) {
                        HermesMark(size: 48)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(model.activeProfileName).font(.title3.weight(.bold)).foregroundStyle(HermesTheme.ink).lineLimit(1)
                            Text(model.settings.isConfigured ? model.settings.serverURL : "尚未配置服务地址")
                                .font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(1)
                            Text("每个连接都有独立的本机对话、草稿和钥匙串密钥。")
                                .font(.caption2).foregroundStyle(HermesTheme.muted)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .listRowBackground(HermesTheme.surface)

                Section {
                    ForEach(model.profiles) { profile in
                        HStack(spacing: 12) {
                            Button {
                                if !model.selectProfile(profile.id) { errorMessage = model.errorMessage ?? WorkspaceError.draftSaveFailed.localizedDescription }
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: profile.id == model.activeProfileID ? "checkmark.circle.fill" : "circle")
                                        .font(.title3)
                                        .foregroundStyle(profile.id == model.activeProfileID ? HermesTheme.accent : HermesTheme.muted)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(profile.name).font(.body.weight(.semibold)).foregroundStyle(HermesTheme.ink)
                                        Text(profile.serverURL.isEmpty ? "尚未配置" : profile.serverURL)
                                            .font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(1)
                                        if profile.id == model.activeProfileID {
                                            Text("当前连接 · \(profile.model)")
                                                .font(.caption2.weight(.medium)).foregroundStyle(HermesTheme.accent).lineLimit(1)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 3)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("切换到 \(profile.name)")
                            Button {
                                editingID = profile.id
                                showingEditor = true
                            } label: {
                                Image(systemName: "pencil").font(.subheadline.weight(.semibold))
                                    .frame(width: 32, height: 32)
                                    .background(HermesTheme.raised, in: Circle())
                            }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("编辑 \(profile.name)")
                        }
                        .swipeActions {
                            Button("删除", role: .destructive) { deletingProfile = profile }
                        }
                    }
                    Button {
                        editingID = nil
                        showingEditor = true
                    } label: { NavigationRowLabel(title: "添加连接", icon: "plus") }
                    NavigationLink {
                        PairingCodeView()
                    } label: { NavigationRowLabel(title: "显示配对码", subtitle: "让另一台手机扫码添加当前连接", icon: "qrcode", tone: .info) }
                    NavigationLink {
                        PairingScanView()
                    } label: { NavigationRowLabel(title: "扫码添加连接", icon: "qrcode.viewfinder", tone: .info) }
                } header: { Text("连接") }
                footer: { if model.isSending { Text("回复进行中，停止或完成后即可修改连接。") } }
                .disabled(model.isSending)
                .listRowBackground(HermesTheme.surface)

                Section {
                    Picker(selection: $appearance) {
                        ForEach(HermesAppearance.allCases) { Text($0.title).tag($0.rawValue) }
                    } label: { NavigationRowLabel(title: "外观", icon: "circle.lefthalf.filled", tone: .neutral) }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("settings-appearance")
                } header: { Text("显示") } footer: { Text("外观设置只保存在这台设备上，不进入备份。") }
                .listRowBackground(HermesTheme.surface)

                Section("数据") {
                    NavigationLink { BackupView() } label: {
                        NavigationRowLabel(title: "备份与恢复", subtitle: "导出或合并导入 JSON 备份", icon: "externaldrive.fill", tone: .success)
                    }
                }
                .listRowBackground(HermesTheme.surface)

                Section("帮助") {
                    DisclosureGroup {
                        Text("在 ~/.hermes/.env 中设置 API_SERVER_ENABLED=true 和 API_SERVER_KEY，然后运行 hermes gateway。默认服务端口是 8642。填写手机可访问的地址，远程连接使用 HTTPS。")
                            .font(.footnote).foregroundStyle(HermesTheme.muted).textSelection(.enabled)
                    } label: { NavigationRowLabel(title: "在 Mac 上启用", icon: "laptopcomputer", tone: .warning) }
                }
                .listRowBackground(HermesTheme.surface)

                Section {
                    LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                } header: { Text("关于 Hermes") } footer: {
                    Text("本机记录、标签、草稿与对话设置保存在设备上。服务端会话和定时任务由你连接的服务器管理。")
                }
                .listRowBackground(HermesTheme.surface)
            }
            .hermesPage()
            .navigationDestination(isPresented: $showingEditor) {
                ConnectionEditorView(profileID: editingID)
            }
            .navigationTitle(embedded ? "设置" : "连接管理")
            .navigationBarTitleDisplayMode(embedded ? .large : .inline)
            .toolbar { if !embedded { ToolbarItem(placement: .topBarTrailing) { Button("完成") { dismiss() } } } }
            .tint(HermesTheme.accent)
            .confirmationDialog("删除“\(deletingProfile?.name ?? "")”？", isPresented: Binding(
                get: { deletingProfile != nil }, set: { if !$0 { deletingProfile = nil } }
            ), titleVisibility: .visible) {
                Button("删除连接和本机记录", role: .destructive) {
                    guard let profile = deletingProfile else { return }
                    do { try model.removeProfile(profile.id) }
                    catch { errorMessage = error.localizedDescription }
                    deletingProfile = nil
                }
                Button("取消", role: .cancel) { deletingProfile = nil }
            } message: {
                Text("此连接的密钥、本机对话、图片和文字草稿会从设备删除。服务端会话和任务会保留。")
            }
            .alert("连接操作未完成", isPresented: Binding(
                get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }
            )) { Button("知道了", role: .cancel) { errorMessage = nil } }
            message: { Text(errorMessage ?? "") }
        }
    }
}

struct ConnectionEditorView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let profileID: UUID?
    @State private var savedID: UUID?
    @State private var name = ""
    @State private var serverURL = ""
    @State private var apiKey = ""
    @State private var modelName = "hermes-agent"
    @State private var models: [String] = []
    @State private var isBusy = false
    @State private var feedback: String?
    @State private var succeeded = false
    @State private var loaded = false

    private var connection: ConnectionSettings {
        ConnectionSettings(serverURL: serverURL.trimmingCharacters(in: .whitespacesAndNewlines),
                           model: modelName.trimmingCharacters(in: .whitespacesAndNewlines),
                           apiKey: apiKey.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    private var canSave: Bool { !isBusy && !model.isSending && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && connection.isConfigured }

    var body: some View {
        Form {
            Section {
                TextField("连接名称，例如：家中的 Mac", text: $name)
                    .accessibilityLabel("连接名称")
                TextField("https://example.com/v1", text: $serverURL)
                    .textContentType(.URL).textInputAutocapitalization(.never)
                    .autocorrectionDisabled().keyboardType(.URL).accessibilityLabel("服务地址")
                SecureField("API_SERVER_KEY", text: $apiKey)
                    .textContentType(.password).textInputAutocapitalization(.never)
                    .autocorrectionDisabled().accessibilityLabel("API 密钥")
            } header: { Text("连接") } footer: {
                Text("更换已保存的服务地址会另存为连接，原连接及记录会保留。")
            }
            .disabled(isBusy || model.isSending)
            .listRowBackground(HermesTheme.surface)

            Section {
                TextField("hermes-agent", text: $modelName)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .accessibilityLabel("本机聊天模型名称")
                if !models.isEmpty {
                    Menu {
                        ForEach(models, id: \.self) { item in
                            Button { modelName = item } label: {
                                if modelName == item { Label(item, systemImage: "checkmark") }
                                else { Text(item) }
                            }
                        }
                    } label: { Label("选择可用名称（\(models.count)）", systemImage: "list.bullet") }
                }
                Button {
                    Task { await loadModels() }
                } label: { Label("读取模型列表", systemImage: "arrow.clockwise") }
                    .disabled(!connection.isConfigured)
            } header: { Text("本机聊天模型") } footer: {
                Text("读取服务器公布的模型名称或别名，也可手动填写。实际模型由服务端配置决定；服务端会话沿用自己的模型设置。")
            }
            .disabled(isBusy || model.isSending)
            .listRowBackground(HermesTheme.surface)

            Section {
                Button { Task { await saveAndTest() } } label: {
                    HStack(spacing: 8) {
                        if isBusy { ProgressView().tint(HermesTheme.onAccent) }
                        Text(isBusy ? "正在连接…" : "保存并测试连接")
                    }
                }
                .buttonStyle(HermesPrimaryButtonStyle())
                .disabled(!canSave)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())

            if let feedback {
                Section {
                    Label(feedback, systemImage: succeeded ? "checkmark.circle.fill" : "exclamationmark.circle")
                        .font(.subheadline).foregroundStyle(succeeded ? HermesTheme.success : HermesTheme.warning)
                }
                .listRowBackground(HermesTheme.surface)
            }
        }
        .scrollContentBackground(.hidden)
        .background(HermesTheme.background)
        .navigationTitle(profileID == nil ? "添加连接" : "编辑连接")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("保存") {
                    do { try save(); dismiss() }
                    catch { succeeded = false; feedback = error.localizedDescription }
                }
                .disabled(!canSave)
            }
        }
        .interactiveDismissDisabled(isBusy)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            savedID = profileID
            if let profile = model.profiles.first(where: { $0.id == profileID }) {
                name = profile.name
                serverURL = profile.serverURL
                modelName = profile.model
                apiKey = model.key(for: profile.id)
            }
        }
        .onChange(of: serverURL) { _, _ in models = []; feedback = nil }
        .onChange(of: apiKey) { _, _ in models = []; feedback = nil }
        .tint(HermesTheme.accent)
    }

    private func save() throws {
        savedID = try model.saveProfile(id: savedID, name: name, connection: connection)
    }

    private func loadModels() async {
        isBusy = true
        feedback = nil
        defer { isBusy = false }
        do {
            models = try await HermesClient(settings: connection).availableModels()
            succeeded = true
            feedback = models.isEmpty ? "服务器没有公布模型名称，可以手动填写。" : "已读取 \(models.count) 个名称，请从列表中选择。"
        } catch { succeeded = false; feedback = error.localizedDescription }
    }

    private func saveAndTest() async {
        feedback = nil
        succeeded = false
        do { try save() }
        catch { feedback = error.localizedDescription; return }
        let tested = model.settings
        isBusy = true
        defer { isBusy = false }
        do {
            models = try await HermesClient(settings: tested).availableModels()
            model.recordConnectionTest(success: true, settings: tested)
            succeeded = true
            feedback = "已保存，连接成功。\(models.contains(modelName) ? "" : "当前名称未在列表中，请确认或重新选择。")"
        } catch {
            model.recordConnectionTest(success: false, settings: tested)
            feedback = "已保存，但测试失败：\(error.localizedDescription)"
        }
    }
}
