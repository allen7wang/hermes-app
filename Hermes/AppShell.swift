import SwiftUI

/// v5 信息架构：工作台 · 对话 · 项目 · 设置。
/// 收件箱并入工作台的「待处理」，Tab 角标显示待审批数量；本机对话与服务端会话合并到「对话」。
struct AppShell: View {
    @EnvironmentObject private var model: AppModel
    private enum Section: Hashable { case home, conversations, projects, settings }
    @State private var section: Section = .home
    @State private var homeChat = false
    @State private var conversationsChat = false
    @State private var homeChatTarget: LocalMessageTarget?
    @State private var pendingApprovals = 0

    var body: some View {
        TabView(selection: $section) {
            NavigationStack {
                WorkspaceHomeView(onOpenChat: { target in homeChatTarget = target; homeChat = true },
                                  onShowConversations: { section = .conversations },
                                  onShowProjects: { section = .projects })
                    .navigationDestination(isPresented: $homeChat) { chatDestination(target: homeChatTarget) }
            }
            .id(model.activeProfileID)
            .tabItem { Label("工作台", systemImage: "square.grid.2x2") }
            .badge(pendingApprovals)
            .tag(Section.home)

            NavigationStack {
                ConversationsView { conversationsChat = true }
                    .navigationDestination(isPresented: $conversationsChat) { chatDestination() }
            }
            .id(model.activeProfileID)
            .tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }
            .tag(Section.conversations)

            ProjectWorkspaceView(embedded: true) {
                section = .conversations
                conversationsChat = true
            }
            .tabItem { Label("项目", systemImage: "folder") }
            .tag(Section.projects)

            SettingsView(embedded: true)
                .tabItem { Label("设置", systemImage: "gearshape") }
                .tag(Section.settings)
        }
        .tint(HermesTheme.accent)
        .onAppear(perform: refreshBadge)
        .onReceive(NotificationCenter.default.publisher(for: InboxStore.didChange)) { _ in refreshBadge() }
        .onChange(of: model.activeProfileID) { _, _ in
            homeChat = false
            conversationsChat = false
            homeChatTarget = nil
            refreshBadge()
        }
    }

    private func chatDestination(target: LocalMessageTarget? = nil) -> some View {
        ChatView(initialTarget: target)
            .toolbar(.hidden, for: .navigationBar)
            .toolbar(.hidden, for: .tabBar)
    }

    private func refreshBadge() {
        pendingApprovals = ((try? InboxStore.items(profileID: model.settings.profileID)) ?? []).filter { $0.kind == .approval }.count
    }
}
