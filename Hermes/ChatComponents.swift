import SwiftUI
import UIKit

/// 本机对话与服务端会话共用的消息角色。
enum ChatRowRole: Equatable {
    case user
    case assistant
    case tool(String)
    case system

    init(remoteRole: String, toolName: String?) {
        switch remoteRole {
        case "user": self = .user
        case "assistant": self = .assistant
        case "tool": self = .tool(toolName ?? "工具")
        default: self = .system
        }
    }

    var label: String {
        switch self {
        case .user: "我"
        case .assistant: "Hermes"
        case .tool(let name): name
        case .system: "系统"
        }
    }
}

/// v5 消息样式：我的消息为右侧浅主色气泡；Hermes 回复不加底色、通栏阅读；工具与系统消息收成紧凑卡片。
struct ChatMessageRow<Accessory: View>: View {
    let role: ChatRowRole
    let text: String
    var image: UIImage?
    var rendersMarkdown: Bool
    var highlighted: Bool
    var bookmarked: Bool
    var failed: Bool
    let accessory: Accessory

    init(role: ChatRowRole, text: String, image: UIImage? = nil, rendersMarkdown: Bool? = nil,
         highlighted: Bool = false, bookmarked: Bool = false, failed: Bool = false,
         @ViewBuilder accessory: () -> Accessory) {
        self.role = role
        self.text = text
        self.image = image
        self.rendersMarkdown = rendersMarkdown ?? (role == .assistant)
        self.highlighted = highlighted
        self.bookmarked = bookmarked
        self.failed = failed
        self.accessory = accessory()
    }

    var body: some View {
        switch role {
        case .user: userBody
        case .assistant: assistantBody
        case .tool, .system: compactBody
        }
    }

    private var badges: some View {
        HStack(spacing: 6) {
            if highlighted { StatusBadge(text: "定位消息", tone: .accent, icon: "magnifyingglass") }
            if bookmarked { StatusBadge(text: "已收藏", tone: .accent, icon: "bookmark.fill") }
            if failed { StatusBadge(text: "本轮未执行", tone: .warning, icon: "exclamationmark.triangle.fill") }
        }
    }

    private var hasBadges: Bool { highlighted || bookmarked || failed }

    private var userBody: some View {
        HStack(alignment: .top) {
            Spacer(minLength: 52)
            VStack(alignment: .trailing, spacing: 8) {
                if hasBadges { badges }
                if let image {
                    Image(uiImage: image).resizable().scaledToFit()
                        .frame(maxWidth: 240, maxHeight: 280)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                if !text.isEmpty {
                    MessageContentView(text: text, rendersMarkdown: rendersMarkdown)
                        .foregroundStyle(HermesTheme.ink)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(HermesTheme.accentSoft, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(highlighted ? HermesTheme.accent : .clear, lineWidth: 1.5))
                }
                accessory
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var assistantBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                HermesMark(size: 22)
                Text("Hermes").font(.footnote.weight(.semibold)).foregroundStyle(HermesTheme.ink)
                if hasBadges { badges }
            }
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: 240, maxHeight: 280)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            if !text.isEmpty || image == nil {
                MessageContentView(text: text, rendersMarkdown: rendersMarkdown)
                    .foregroundStyle(HermesTheme.ink)
            }
            accessory
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(highlighted ? 12 : 0)
        .background(highlighted ? HermesTheme.accentSoft : .clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var compactBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: role == .system ? "gearshape" : "wrench.and.screwdriver")
                Text(role.label).lineLimit(1)
                if hasBadges { badges }
            }
            .font(.caption.weight(.semibold)).foregroundStyle(HermesTheme.muted)
            if !text.isEmpty {
                MessageContentView(text: text, rendersMarkdown: rendersMarkdown)
                    .foregroundStyle(HermesTheme.muted)
            }
            accessory
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HermesTheme.raised.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(highlighted ? HermesTheme.accent : HermesTheme.hairline, lineWidth: 1))
    }
}

extension ChatMessageRow where Accessory == EmptyView {
    init(role: ChatRowRole, text: String, image: UIImage? = nil, rendersMarkdown: Bool? = nil,
         highlighted: Bool = false, bookmarked: Bool = false, failed: Bool = false) {
        self.init(role: role, text: text, image: image, rendersMarkdown: rendersMarkdown,
                  highlighted: highlighted, bookmarked: bookmarked, failed: failed) { EmptyView() }
    }
}

/// 回复生成或服务端运行中的状态条，右侧为停止按钮。
struct RunStatusBar: View {
    let text: String
    var running = true
    var stopTitle = "停止"
    var stopDisabled = false
    var onStop: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            if running { ProgressView().controlSize(.small).tint(HermesTheme.accent) }
            else { StatusDot(tone: .accent) }
            Text(text).font(.footnote).foregroundStyle(HermesTheme.muted).lineLimit(2)
            Spacer(minLength: 8)
            if let onStop {
                Button(action: onStop) {
                    Label(stopTitle, systemImage: "stop.fill").labelStyle(.titleAndIcon)
                }
                .buttonStyle(HermesPillButtonStyle(tone: .danger))
                .disabled(stopDisabled)
                .accessibilityLabel("停止")
            }
        }
        .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 8)
        .background(HermesTheme.surface, in: Capsule())
        .overlay(Capsule().stroke(HermesTheme.hairline, lineWidth: 1))
    }
}

/// 输入区圆形发送按钮。
struct SendButton: View {
    let enabled: Bool
    var accessibility = "发送"
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(enabled ? HermesTheme.onAccent : HermesTheme.muted)
                .frame(width: 36, height: 36)
                .background(enabled ? HermesTheme.accent : HermesTheme.raised, in: Circle())
        }
        .disabled(!enabled)
        .accessibilityLabel(accessibility)
    }
}

/// 运行中替换发送按钮，滚动到任何位置都能停止。
struct StopButton: View {
    var disabled = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "stop.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(HermesTheme.onAccent)
                .frame(width: 36, height: 36)
                .background(HermesTheme.danger, in: Circle())
        }
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityLabel("停止")
    }
}

/// 输入区底部的小图标按钮（图片、模板、预览）。
struct ComposerIconLabel: View {
    let systemName: String
    var loading = false
    var body: some View {
        Group {
            if loading { ProgressView().controlSize(.small).tint(HermesTheme.accent) }
            else { Image(systemName: systemName).font(.system(size: 17, weight: .medium)) }
        }
        .foregroundStyle(HermesTheme.muted)
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
}

extension View {
    /// 输入框容器：圆角卡片，文字区在上、工具与发送按钮在下。
    func composerContainer() -> some View {
        self.padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 6)
            .background(HermesTheme.surface, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(HermesTheme.hairline, lineWidth: 1))
            .shadow(color: .black.opacity(0.06), radius: 12, y: 4)
    }
}

/// 待发送图片的缩略图，右上角可移除。
struct PendingImageThumbnail: View {
    let image: UIImage
    let onRemove: () -> Void
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(width: 72, height: 72)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill").font(.system(size: 20))
                    .foregroundStyle(.white, .black.opacity(0.7))
            }
            .offset(x: 6, y: -6)
            .accessibilityLabel("移除图片")
        }
        .padding(.top, 6)
    }
}

/// 审批卡片：命令预览、主次操作分明；扩大授权范围前再次确认。
struct ApprovalCard: View {
    var context: String? = nil
    let description: String?
    let command: String?
    let choices: [String]?
    var showsPaths = false
    var createdAt: Date? = nil
    var busy = false
    let onResolve: (String) -> Void
    @State private var elevatedChoice: String?

    private var allowed: [String] { choices ?? ["once", "deny"] }
    private var hasCommand: Bool { command?.isEmpty == false }
    private var allowsSession: Bool { allowed.contains("session") && hasCommand }
    private var allowsAlways: Bool { allowed.contains("always") && hasCommand }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 10) {
                IconTile(systemName: "hand.raised.fill", tone: .warning, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text("需要你的审批").font(.headline).foregroundStyle(HermesTheme.ink)
                    if let context, !context.isEmpty {
                        Text(context).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                if let createdAt { Text(createdAt, format: .relative(presentation: .named)).font(.caption2).foregroundStyle(HermesTheme.muted) }
            }
            if let description, !description.isEmpty {
                Text(description).font(.subheadline).foregroundStyle(HermesTheme.ink).fixedSize(horizontal: false, vertical: true)
            }
            if let command, !command.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("完整命令").font(.caption2.weight(.semibold)).foregroundStyle(Color(hex: 0x9B9BA6))
                    Text(command).font(.system(.footnote, design: .monospaced)).foregroundStyle(HermesTheme.codeText)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(HermesTheme.codeBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            if showsPaths { paths }
            HStack(spacing: 8) {
                if allowed.contains("once") {
                    Button("允许本次") { onResolve("once") }.buttonStyle(HermesPillButtonStyle(tone: .accent, filled: true))
                }
                // 拒绝始终可用：它是最安全的选择。
                Button("拒绝", role: .destructive) { onResolve("deny") }.buttonStyle(HermesPillButtonStyle(tone: .danger))
                if allowsSession || allowsAlways {
                    Menu {
                        if allowsSession { Button("本次会话允许", systemImage: "clock.badge.checkmark") { elevatedChoice = "session" } }
                        if allowsAlways { Button("始终允许", systemImage: "checkmark.seal") { elevatedChoice = "always" } }
                    } label: {
                        HStack(spacing: 4) { Text("更多授权"); Image(systemName: "chevron.down").font(.caption2.weight(.bold)) }
                    }
                    .buttonStyle(HermesPillButtonStyle(tone: .neutral))
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
            }
            .disabled(busy)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HermesTheme.surface, in: RoundedRectangle(cornerRadius: HermesMetrics.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: HermesMetrics.cardRadius, style: .continuous).stroke(HermesTheme.warning.opacity(0.45), lineWidth: 1))
        .confirmationDialog("确认扩大授权范围？", isPresented: Binding(
            get: { elevatedChoice != nil }, set: { if !$0 { elevatedChoice = nil } }
        ), titleVisibility: .visible) {
            if let choice = elevatedChoice {
                Button(choice == "always" ? "确认始终允许" : "确认本会话允许", role: .destructive) {
                    onResolve(choice)
                    elevatedChoice = nil
                }
            }
            Button("取消", role: .cancel) { elevatedChoice = nil }
        } message: { Text("请先核对卡片中展示的完整命令；此授权可能对后续操作生效。") }
    }

    @ViewBuilder private var paths: some View {
        let values = ApprovalPathParser.paths(in: command ?? "")
        if values.isEmpty {
            Text("服务端没有返回文件差异").font(.caption).foregroundStyle(HermesTheme.muted)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("命令里的路径").font(.caption.weight(.semibold)).foregroundStyle(HermesTheme.muted)
                ForEach(values, id: \.self) { path in
                    Label(path, systemImage: "doc").font(.system(.caption, design: .monospaced))
                        .foregroundStyle(HermesTheme.ink).textSelection(.enabled)
                }
            }
        }
    }
}
