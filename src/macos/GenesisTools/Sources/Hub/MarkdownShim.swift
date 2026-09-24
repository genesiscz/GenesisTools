import SwiftUI

// A small stand-in for Genesis's MarkdownContentView (UI/MarkdownContentView.swift + the
// Knowledge/MarkdownPreview.swift block parser), which pulls in the companion theme, wikilinks and
// a web view. Same API as the stolen transcript list uses: `MarkdownContentView(markdown:style:)`
// with a `MarkdownStyle`. It renders inline markdown per paragraph and fenced code blocks; the
// full renderer can be stolen later if the transcript needs tables or task lists.

struct MarkdownStyle {
    var bodySize: CGFloat = 13
    var textColor: Color = .white.opacity(0.92)
    var secondaryColor: Color = .white.opacity(0.55)
    var mutedColor: Color = .white.opacity(0.35)
    var accentColor: Color = .orange
    var codeColor: Color = .white.opacity(0.88)
    var codeBackground: Color = Color.black.opacity(0.35)
    var taskDoneColor: Color = .green
    var lineSpacing: CGFloat = 3
    var blockSpacing: CGFloat = 10
    var headingScale: CGFloat = 1
    var monoBody: Bool = false
}

struct MarkdownContentView: View {
    let markdown: String
    var style = MarkdownStyle()

    private enum Block: Hashable {
        case text(String)
        case code(String)
        case heading(String, level: Int)
    }

    private var blocks: [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var code: [String]?
        func flush() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(.text(text))
            }
            paragraph = []
        }

        for line in markdown.components(separatedBy: "\n") {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }

            if code != nil {
                code?.append(line)
            } else if let match = line.range(of: "^#{1,6} ", options: .regularExpression) {
                flush()
                blocks.append(.heading(String(line[match.upperBound...]), level: line.distance(from: line.startIndex, to: match.upperBound) - 1))
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                flush()
            } else {
                paragraph.append(line)
            }
        }

        if let open = code {
            blocks.append(.code(open.joined(separator: "\n")))
        }
        flush()
        return blocks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: style.blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .text(let text):
                    Text(inline(text))
                        .font(style.monoBody ? .system(size: style.bodySize, design: .monospaced) : .system(size: style.bodySize))
                        .foregroundColor(style.textColor)
                        .lineSpacing(style.lineSpacing)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .heading(let text, let level):
                    Text(inline(text))
                        .font(.system(size: (20 - CGFloat(level) * 1.5) * style.headingScale, weight: .semibold))
                        .foregroundColor(style.textColor)
                case .code(let text):
                    Text(text)
                        .font(.system(size: style.bodySize - 1.5, design: .monospaced))
                        .foregroundColor(style.codeColor)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 6).fill(style.codeBackground))
                }
            }
        }
    }

    private func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
