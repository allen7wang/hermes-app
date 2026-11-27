import MarkdownUI
import SwiftUI
import UIKit

struct MessageContentView: View {
    let text: String
    var rendersMarkdown = true

    var body: some View {
        if rendersMarkdown {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(MessageContent.blocks(text)) { block in
                    switch block.kind {
                    case .prose(let prose):
                        Markdown(prose)
                            .markdownTheme(.hermes)
                            .markdownSoftBreakMode(.lineBreak)
                            .textSelection(.enabled)
                    case .code(let language, let code):
                        CodeBlockView(language: language, code: code)
                    }
                }
            }
        } else {
            Text(text).font(.system(size: 15)).lineSpacing(4).textSelection(.enabled)
        }
    }
}

private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "代码").lineLimit(1)
                Spacer(minLength: 12)
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                } label: {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .padding(.vertical, 8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "代码已复制" : "复制代码块")
            }
            .font(.caption.weight(.medium)).foregroundStyle(Color(hex: 0xB4ADFF))
            .padding(.horizontal, 12)
            .background(HermesTheme.codeHeader)
            ScrollView(.horizontal) {
                Group {
                    if let highlighted = CodeHighlighter.highlighted(code: code, language: language) {
                        Text(highlighted)
                    } else {
                        Text(code)
                    }
                }
                .font(.system(size: 13, design: .monospaced))
                .foregroundStyle(HermesTheme.codeText)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .padding(12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HermesTheme.codeBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .environment(\.colorScheme, .dark)
        .onChange(of: code) { _, _ in copied = false }
    }
}
