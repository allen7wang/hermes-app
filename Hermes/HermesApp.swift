import SwiftUI

@main
struct HermesApp: App {
    @StateObject private var model = AppModel()
    @AppStorage(HermesAppearance.storageKey) private var appearance = HermesAppearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            AppShell()
                .environmentObject(model)
                .onAppear { HermesAppearance.apply(HermesAppearance(rawValue: appearance) ?? .system) }
                .onChange(of: appearance) { _, value in HermesAppearance.apply(HermesAppearance(rawValue: value) ?? .system) }
        }
    }
}
