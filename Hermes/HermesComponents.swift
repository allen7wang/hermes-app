import SwiftUI

/// 语义色调：状态徽标、图标底色和提示条共用。
enum HermesTone {
    case accent, success, warning, danger, info, neutral

    var color: Color {
        switch self {
        case .accent: HermesTheme.accent
        case .success: HermesTheme.success
        case .warning: HermesTheme.warning
        case .danger: HermesTheme.danger
        case .info: HermesTheme.info
        case .neutral: HermesTheme.muted
        }
    }
}

/// 品牌标志：鸢尾渐变圆角方块上的 H 字母。
struct HermesMark: View {
    var size: CGFloat = 28

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(LinearGradient(colors: [Color(hex: 0x7B6CFF), Color(hex: 0x4B3BDB)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .frame(width: size, height: size)
            .overlay {
                Text("H").font(.system(size: size * 0.56, weight: .heavy, design: .rounded)).foregroundStyle(.white)
            }
            .accessibilityHidden(true)
    }
}

struct StatusBadge: View {
    let text: String
    var tone: HermesTone = .accent
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let icon { Image(systemName: icon).font(.caption2.weight(.bold)) }
            Text(text).lineLimit(1)
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(tone.color)
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(tone.color.opacity(0.13), in: Capsule())
    }
}

struct StatusDot: View {
    var tone: HermesTone
    var size: CGFloat = 7
    var body: some View {
        Circle().fill(tone.color).frame(width: size, height: size)
            .overlay(Circle().stroke(tone.color.opacity(0.3), lineWidth: 3).scaleEffect(1.6))
            .accessibilityHidden(true)
    }
}

enum ConversationOrigin {
    case local, server

    var title: String { self == .local ? "本机" : "服务端" }
    var icon: String { self == .local ? "iphone" : "server.rack" }
}

/// 标出一段对话保存在哪里：本机工作区，或 Hermes 服务端。
struct OriginBadge: View {
    let origin: ConversationOrigin
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: origin.icon).imageScale(.small)
            Text(origin.title)
        }
            .font(.caption2.weight(.medium))
            .foregroundStyle(origin == .local ? HermesTheme.muted : HermesTheme.info)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background((origin == .local ? HermesTheme.raised : HermesTheme.info.opacity(0.12)), in: Capsule())
    }
}

/// 列表行左侧的图标方块。
struct IconTile: View {
    let systemName: String
    var tone: HermesTone = .accent
    var size: CGFloat = 34

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(tone.color)
            .frame(width: size, height: size)
            .background(tone.color.opacity(0.13), in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// 带图标、标题、说明的导航行，用于工作台入口和设置。
struct NavigationRowLabel: View {
    let title: String
    var subtitle: String? = nil
    let icon: String
    var tone: HermesTone = .accent
    var value: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            IconTile(systemName: icon, tone: tone)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(HermesTheme.ink).lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(HermesTheme.muted).lineLimit(2)
                }
            }
            Spacer(minLength: 4)
            if let value { Text(value).font(.subheadline.monospacedDigit()).foregroundStyle(HermesTheme.muted) }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// 可选中的筛选胶囊。
struct FilterChip: View {
    let title: String
    var count: Int? = nil
    var icon: String? = nil
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                if let icon { Image(systemName: icon).font(.caption2.weight(.semibold)) }
                Text(title)
                if let count { Text("\(count)").monospacedDigit().foregroundStyle(selected ? HermesTheme.accent.opacity(0.75) : HermesTheme.muted.opacity(0.8)) }
            }
            .font(.subheadline.weight(selected ? .semibold : .regular))
            .foregroundStyle(selected ? HermesTheme.accent : HermesTheme.ink)
            .padding(.horizontal, 13).padding(.vertical, 8)
            .background(selected ? HermesTheme.accentSoft : HermesTheme.surface, in: Capsule())
            .overlay(Capsule().stroke(selected ? HermesTheme.accent.opacity(0.35) : HermesTheme.hairline, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// 分区标题：左侧标题与数量，右侧可选的「全部」入口。
struct SectionTitle: View {
    let title: String
    var count: Int? = nil
    var trailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.title3.weight(.bold)).foregroundStyle(HermesTheme.ink)
            if let count, count > 0 {
                Text("\(count)").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(HermesTheme.muted)
            }
            Spacer(minLength: 8)
            if let trailing {
                HStack(spacing: 2) { Text(trailing); Image(systemName: "chevron.right").font(.caption2.weight(.bold)) }
                    .font(.subheadline.weight(.medium)).foregroundStyle(HermesTheme.accent)
            }
        }
        .textCase(nil)
    }
}

struct HermesPrimaryButtonStyle: ButtonStyle {
    var fullWidth = true
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(HermesTheme.onAccent)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: 50)
            .padding(.horizontal, fullWidth ? 0 : 20)
            .background(HermesTheme.accent, in: RoundedRectangle(cornerRadius: HermesMetrics.controlRadius, style: .continuous))
            .opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// 紧凑胶囊按钮，用于卡片内的次要操作。
struct HermesPillButtonStyle: ButtonStyle {
    var tone: HermesTone = .accent
    var filled = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(filled ? HermesTheme.onAccent : tone.color)
            .padding(.horizontal, 14).frame(minHeight: 36)
            .background(filled ? AnyShapeStyle(tone.color) : AnyShapeStyle(tone.color.opacity(0.13)), in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
    }
}

extension View {
    /// 新版卡片：表面色、连续圆角与细描边。
    func hermesCard(padding: CGFloat = 16, radius: CGFloat = HermesMetrics.cardRadius) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(HermesTheme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(HermesTheme.hairline, lineWidth: 1))
    }

    /// 列表中整行即卡片：清掉系统行背景与分隔线。
    func cardRow(top: CGFloat = 5, bottom: CGFloat = 5) -> some View {
        self.listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: top, leading: HermesMetrics.page, bottom: bottom, trailing: HermesMetrics.page))
    }

    /// 页面统一底色与列表背景。
    func hermesPage() -> some View {
        self.scrollContentBackground(.hidden).background(HermesTheme.background)
    }
}

/// 紧凑的「图标 + 文字」，间距比系统 Label 更小，适合卡片内的元信息。
struct InlineLabel: View {
    let text: String
    let systemImage: String
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: systemImage).imageScale(.small)
            Text(text)
        }
    }
}

extension String {
    /// 列表摘要：去掉常见 Markdown 标记并压成一行，只取开头部分，避免长消息拖慢列表。
    var markdownPreview: String {
        var text = String(prefix(400))
        text = text.replacingOccurrences(of: "```[A-Za-z0-9_+#-]*", with: " ", options: .regularExpression)
        for token in ["**", "__", "`"] { text = text.replacingOccurrences(of: token, with: "") }
        text = text.replacingOccurrences(of: "(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+\\.)\\s+", with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: "\\s*\\n+\\s*", with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
