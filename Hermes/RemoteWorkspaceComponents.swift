import SwiftUI

struct RemoteLoadBanner: View {
    let message: String
    let hasRecords: Bool
    let disabled: Bool
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(hasRecords ? "刷新失败，保留上次记录" : "读取失败", systemImage: "wifi.exclamationmark")
                .font(.subheadline.weight(.semibold)).foregroundStyle(HermesTheme.warning)
            Text(message).font(.caption).textSelection(.enabled)
            Button("重试", action: retry).disabled(disabled).buttonStyle(.borderless)
        }
        .hermesCard(padding: 14)
    }
}

struct RemoteJobStatusBadge: View {
    let job: RemoteJob
    var body: some View {
        StatusBadge(text: job.statusLabel,
                    tone: job.needsAttention ? .warning : job.isPaused ? .neutral : RemoteJobFilter.running.includes(job) ? .info : .accent)
    }
}

extension View {
    func remoteActionErrorAlert(_ workspace: RemoteWorkspaceModel) -> some View {
        alert("服务端操作失败", isPresented: Binding(
            get: { workspace.actionError != nil }, set: { if !$0 { workspace.actionError = nil } }
        )) {
            Button("知道了", role: .cancel) { workspace.actionError = nil }
        } message: { Text(workspace.actionError ?? "") }
    }
}
