import SwiftUI

struct WidgetEntryBody: Decodable, Sendable {
    let body: String
    let question: String?
}

struct WidgetGroupEntry: Decodable, Identifiable, Sendable {
    let id: String
    let at: Double
    let question: String
    let text: String
    let more: Bool?
}

struct WidgetAnswerBlock: View, Equatable {
    let question: String?
    let answer: String
    let more: Bool
    let clampLines: Int
    var label = "Answer"
    var earlier = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let question {
                if earlier {
                    Text(KitMarkdown.inline(question)).font(.system(size: 11.5, weight: .semibold))
                } else {
                    Text("Question").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                    WidgetClampedMarkdown(text: question, lines: 6)
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Text(label).font(.system(size: 10, weight: .semibold)).foregroundStyle(SessionPalette.blue)
                    if more {
                        ProgressView().controlSize(.mini)
                            .accessibilityLabel(label == "Message" ? "Loading the full message" : "Loading the full answer")
                    }
                }
                WidgetClampedMarkdown(text: answer, lines: clampLines)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.035))
            .overlay(alignment: .leading) {
                Rectangle().fill(SessionPalette.blue.opacity(0.55)).frame(width: 2).allowsHitTesting(false)
            }
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .textSelection(.enabled)
    }
}

/// Measure the laid-out markdown, including wrapping, lists and code, before clipping it to a line budget.
private struct WidgetClampedMarkdown: View {
    let text: String
    let lines: Int
    @State private var overflows = false
    @State private var expanded = false
    @GenReduceMotion private var reduceMotion

    var body: some View {
        let height = CGFloat(lines) * 16
        VStack(alignment: .leading, spacing: 3) {
            WidgetMarkdown(text: text)
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: Bool.self, of: { $0.size.height > height + 1 }) { overflows = $0 }
                .frame(maxHeight: expanded ? nil : height, alignment: .top)
                .clipped()
                .mask {
                    VStack(spacing: 0) {
                        Rectangle()
                        if overflows && !expanded {
                            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                                .frame(height: 14)
                        }
                    }
                }
            if overflows {
                Button(expanded ? "Show less" : "Show all") {
                    GenMotion.perform(expanding: !expanded, reduceMotion: reduceMotion) { expanded.toggle() }
                }.buttonStyle(.genHoverPlain()).font(.caption)
            }
        }
    }
}
