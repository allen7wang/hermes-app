import SwiftUI
import UIKit

/// v5 「石墨 · 鸢尾」设计令牌。每个颜色同时定义浅色与深色，跟随系统或设置中的外观选择。
/// 原有五个令牌名称保持不变，旧页面无需逐一修改即可换上新配色。
enum HermesTheme {
    /// 页面底色：浅色为冷调纸白，深色为石墨黑。
    static let background = dynamic(light: 0xF4F4F7, dark: 0x0B0B0D)
    /// 卡片与列表行。
    static let surface = dynamic(light: 0xFFFFFF, dark: 0x161619)
    /// 输入框、次级卡片、选中态。
    static let raised = dynamic(light: 0xECECF1, dark: 0x222227)
    /// 品牌主色：鸢尾紫。
    static let accent = dynamic(light: 0x5B4CF0, dark: 0x9188FF)
    /// 次要文字与图标。
    static let muted = dynamic(light: 0x6A6A75, dark: 0x9B9BA6)

    /// 主要文字。
    static let ink = dynamic(light: 0x16161B, dark: 0xF3F3F6)
    /// 主色按钮上的文字与图标。
    static let onAccent = dynamic(light: 0xFFFFFF, dark: 0x0B0B0D)
    /// 主色浅底，用于选中筛选、用户气泡和次级按钮。
    static let accentSoft = dynamic(light: 0x5B4CF0, dark: 0x9188FF, lightAlpha: 0.11, darkAlpha: 0.18)
    /// 细分隔线与卡片描边。
    static let hairline = dynamic(light: 0x000000, dark: 0xFFFFFF, lightAlpha: 0.07, darkAlpha: 0.08)

    static let success = dynamic(light: 0x1B9A57, dark: 0x3DD68C)
    static let warning = dynamic(light: 0xB86E00, dark: 0xFFB547)
    static let danger = dynamic(light: 0xD53A3A, dark: 0xFF6B6B)
    static let info = dynamic(light: 0x2C6BE0, dark: 0x64A8FF)

    /// 代码块在两种外观下都保持深色，语法高亮颜色才稳定可读。
    static let codeBackground = Color(hex: 0x111116)
    static let codeHeader = Color(hex: 0x1B1B22)
    static let codeText = Color(hex: 0xE6E6EE)

    private static func dynamic(light: UInt32, dark: UInt32, lightAlpha: CGFloat = 1, darkAlpha: CGFloat = 1) -> Color {
        Color(UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(hex: dark, alpha: darkAlpha) : UIColor(hex: light, alpha: lightAlpha)
        })
    }
}

enum HermesMetrics {
    static let cardRadius: CGFloat = 18
    static let controlRadius: CGFloat = 14
    static let page: CGFloat = 16
}

/// 外观偏好保存在本机，不进入 JSON 备份。
enum HermesAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    static let storageKey = "appearance"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }
    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }

    /// 直接设置窗口的界面风格：表单、弹窗和菜单都会继承，切回「跟随系统」也能立即生效。
    @MainActor static func apply(_ appearance: HermesAppearance) {
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            for window in windowScene.windows { window.overrideUserInterfaceStyle = appearance.interfaceStyle }
        }
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(uiColor: UIColor(hex: hex, alpha: alpha))
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: alpha)
    }
}
