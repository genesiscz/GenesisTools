import SwiftUI

// A user turn that holds more than the user's own words: a peer agent's message, a background task's
// result, the Esc marker, a reminder the harness attached. `tools ai sessions tail` splits it into parts
// (src/utils/ai/transcripts/prompt-parts.ts) and the transcript shows each part in its own shape, where the
// raw text used to show `<teammate-message …>{"type":"idle_notification",…}` with literal `\n`s.

/// One part of a user turn. Flat and all-optional, so a kind this build does not know still decodes and
/// shows as plain text instead of failing the whole envelope.
public struct TranscriptPromptPart: Equatable, Hashable, Sendable, Codable {
    /// `user`, `teammate`, `task`, `interrupt` or `system`.
    public var kind: String
    /// `user`, `interrupt`, `system`.
    public var text: String?
    /// `user`: typed while the agent was working, delivered inside the running turn.
    public var midTurn: Bool?
    /// `teammate`: the sender's name, its colour, the summary it gave, the payload type, the markdown body.
    public var from: String?
    public var color: String?
    public var summary: String?
    public var type: String?
    public var body: String?
    /// `task`: the task id, its status, what finished, the output file and a sub-agent's report.
    public var id: String?
    public var status: String?
    public var outputFile: String?
    public var result: String?

    public init(kind: String, text: String? = nil, from: String? = nil, color: String? = nil, summary: String? = nil,
                type: String? = nil, body: String? = nil, id: String? = nil, status: String? = nil, result: String? = nil) {
        self.kind = kind
        self.text = text
        self.from = from
        self.color = color
        self.summary = summary
        self.type = type
        self.body = body
        self.id = id
        self.status = status
        self.result = result
    }
}

enum HubPromptParts {
    /// The expansion key of one part: parts open one by one, like the calls of a folded tool group.
    static func partId(_ rowId: String, _ index: Int) -> String { "\(rowId)#part\(index)" }

    /// The words the transcript search matches: names, titles, bodies and results, not the raw JSON.
    static func searchText(_ parts: [TranscriptPromptPart]) -> String {
        parts.flatMap { part in
            [part.text, part.from, part.summary, part.type, part.body, part.id, part.status, part.result].compactMap { $0 }
        }
        .joined(separator: " ")
    }

    /// The user's own words across the parts: where the prompt's image references live.
    static func userText(_ parts: [TranscriptPromptPart]) -> String {
        parts.filter { $0.kind == "user" }.compactMap(\.text).joined(separator: "\n")
    }

    /// Claude Code's teammate colour names.
    static func color(_ name: String?) -> Color {
        switch name {
        case "red": return SessionPalette.red
        case "green": return SessionPalette.green
        case "orange": return SessionPalette.orange
        case "blue": return SessionPalette.blue
        case "purple": return SessionPalette.purple
        case "yellow": return Color(red: 0.95, green: 0.83, blue: 0.35)
        case "cyan": return Color(red: 0.35, green: 0.82, blue: 0.88)
        case "pink": return Color(red: 0.96, green: 0.52, blue: 0.75)
        default: return SessionPalette.secondary
        }
    }

    /// `idle_notification` → `idle`, `task_assignment` → `task assignment`.
    static func typeLabel(_ type: String?) -> String? {
        guard let type, !type.isEmpty else { return nil }
        if type == "idle_notification" { return "idle" }
        return type.replacingOccurrences(of: "_", with: " ")
    }

    static func statusColor(_ status: String?) -> Color {
        switch status {
        case "completed": return SessionPalette.green
        case "failed", "killed", "error": return SessionPalette.red
        case "running": return SessionPalette.blue
        default: return SessionPalette.secondary
        }
    }

    /// The first `lines` lines (and at most 600 bytes, since a report's lines are whole paragraphs) of a
    /// long body, with whether anything was cut.
    static func collapsed(_ text: String, lines: Int) -> (text: String, cut: Bool, lineCount: Int) {
        let all = text.split(separator: "\n", omittingEmptySubsequences: false)
        let tooLong = all.count > lines || text.utf8.count > 600
        guard tooLong else { return (text, false, all.count) }
        var head = all.prefix(lines).joined(separator: "\n")
        if head.utf8.count > 600 {
            head = String(decoding: head.utf8.prefix(600), as: UTF8.self) + "…"
        }
        return (head, true, all.count)
    }
}

/// A prompt that carries parts: each part in order, the user's words in the usual prompt card.
struct PromptPartsView: View {
    let rowId: String
    let parts: [TranscriptPromptPart]
    let images: [TranscriptImageRef]
    let clock: String?
    let open: Set<String>
    let onToggle: (String) -> Void

    var body: some View {
        let firstUser = parts.firstIndex { $0.kind == "user" }
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                let id = HubPromptParts.partId(rowId, index)
                switch part.kind {
                case "teammate":
                    TeammatePartCard(id: id, part: part, clock: clock, expanded: open.contains(id), onToggle: onToggle)
                case "task":
                    TaskPartLine(id: id, part: part, clock: clock, expanded: open.contains(id), onToggle: onToggle)
                case "interrupt":
                    InterruptPartLine(text: part.text ?? "Request interrupted by user", clock: clock)
                case "system":
                    SystemPartLine(id: id, text: part.text ?? "", expanded: open.contains(id), onToggle: onToggle)
                default:
                    // The user's words, and any kind this build does not know, in the transcript's own prompt card.
                    PromptCard(
                        id: id,
                        text: part.text ?? part.body ?? "",
                        images: index == firstUser ? images : [],
                        clock: clock,
                        expanded: open.contains(id),
                        onToggle: onToggle
                    )
                }
            }
        }
        .accessibilityIdentifier("transcript-prompt-parts")
    }
}

/// A peer agent's message: colour dot, name, what it is about, then its body as markdown, cut to a few
/// lines until "Show more".
struct TeammatePartCard: View {
    let id: String
    let part: TranscriptPromptPart
    let clock: String?
    let expanded: Bool
    let onToggle: (String) -> Void

    private static let collapsedLines = 5

    var body: some View {
        let accent = HubPromptParts.color(part.color)
        let message = (part.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let cut = HubPromptParts.collapsed(message, lines: Self.collapsedLines)

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Circle().fill(accent).frame(width: 8, height: 8)
                Text(verbatim: part.from ?? "teammate")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundStyle(SessionPalette.text)
                    .lineLimit(1)
                    .layoutPriority(1)
                if let type = HubPromptParts.typeLabel(part.type) {
                    SessionPill(text: type, color: accent)
                }
                if let summary = part.summary, !summary.isEmpty {
                    Text(verbatim: summary)
                        .font(.system(size: 12))
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 8)
                if let clock {
                    Text(verbatim: clock)
                        .font(.system(size: 11.5))
                        .foregroundStyle(SessionPalette.dim)
                }
            }
            if !message.isEmpty {
                MarkdownContentView(markdown: expanded ? message : cut.text, style: .sessionTranscript)
                    .textSelection(.enabled)
                    .padding(.leading, 15)
                if cut.cut {
                    Button(expanded ? "Show less" : (cut.lineCount > Self.collapsedLines ? "Show all \(cut.lineCount) lines" : "Show the full message")) { onToggle(id) }
                        .buttonStyle(.genHoverPlain())
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(SessionPalette.blue)
                        .padding(.leading, 15)
                        .accessibilityIdentifier("transcript-teammate-expand")
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(SessionPalette.card))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(accent.opacity(0.35)))
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 2)
        .accessibilityIdentifier("transcript-teammate-card")
    }
}

/// A background command or sub-agent that finished: one line with its status, what it was and its id.
/// A sub-agent's report opens under it.
struct TaskPartLine: View {
    let id: String
    let part: TranscriptPromptPart
    let clock: String?
    let expanded: Bool
    let onToggle: (String) -> Void

    var body: some View {
        let result = (part.result ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: 4) {
            if result.isEmpty {
                line(hasResult: false)
            } else {
                line(hasResult: true).rowButton(cornerRadius: 7) { onToggle(id) }
                    .accessibilityIdentifier("transcript-task-row")
                if expanded {
                    MarkdownContentView(markdown: result, style: .sessionTranscript)
                        .textSelection(.enabled)
                        .padding(.leading, 12)
                        .overlay(alignment: .leading) {
                            Rectangle().fill(HubPromptParts.statusColor(part.status).opacity(0.35)).frame(width: 2)
                        }
                        .padding(.leading, 12)
                        .padding(.bottom, 6)
                }
            }
        }
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.top, 4)
    }

    private func line(hasResult: Bool) -> some View {
        let color = HubPromptParts.statusColor(part.status)
        return HStack(spacing: 8) {
            Image(systemName: "bell")
                .font(.system(size: 11))
                .foregroundStyle(color.opacity(0.85))
                .frame(width: 14)
            Text(verbatim: part.status ?? "task")
                .font(SessionPalette.mono(10.5, weight: .medium))
                .foregroundStyle(color)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(Capsule().fill(color.opacity(0.14)))
            Text(verbatim: part.summary ?? "Background task")
                .font(.system(size: 12))
                .foregroundStyle(SessionPalette.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 8)
            if let taskId = part.id {
                Text(verbatim: taskId)
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
                    .lineLimit(1)
            }
            if let clock {
                Text(verbatim: clock)
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
            }
            if hasResult {
                Chevron(expanded: expanded)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 24)
        .contentShape(Rectangle())
    }
}

/// The Esc marker: a small muted line, not a prompt card.
struct InterruptPartLine: View {
    let text: String
    let clock: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "escape")
                .font(.system(size: 11))
                .foregroundStyle(SessionPalette.dim)
                .frame(width: 14)
            Text(verbatim: text)
                .font(.system(size: 12).italic())
                .foregroundStyle(SessionPalette.dim)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let clock {
                Text(verbatim: clock)
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.faint)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 24)
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.top, 4)
        .accessibilityIdentifier("transcript-interrupt-row")
    }
}

/// A reminder the harness attached: closed to one dim line until opened.
struct SystemPartLine: View {
    let id: String
    let text: String
    let expanded: Bool
    let onToggle: (String) -> Void

    var body: some View {
        let firstLine = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "gearshape")
                    .font(.system(size: 10.5))
                    .foregroundStyle(SessionPalette.faint)
                    .frame(width: 14)
                Text("Harness note")
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
                if !expanded {
                    Text(verbatim: firstLine)
                        .font(.system(size: 11.5))
                        .foregroundStyle(SessionPalette.faint)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 0)
                Chevron(expanded: expanded)
            }
            .padding(.horizontal, 8)
            .frame(height: 22)
            .contentShape(Rectangle())
            .rowButton(cornerRadius: 7) { onToggle(id) }
            .accessibilityIdentifier("transcript-system-row")

            if expanded {
                Text(verbatim: text)
                    .font(.system(size: 12))
                    .foregroundStyle(SessionPalette.dim)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) {
                        Rectangle().fill(SessionPalette.faint.opacity(0.5)).frame(width: 2)
                    }
                    .padding(.leading, 12)
                    .padding(.bottom, 6)
            }
        }
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.top, 2)
    }
}


