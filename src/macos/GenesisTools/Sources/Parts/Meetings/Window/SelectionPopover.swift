import SwiftUI

// MARK: - Comment and clip on a transcript selection (R43, G60, G61, G62)
//
// Presentational only. b-swift-timeline opens `SelectionPopover` at the selection, sends `comment.stage` from
// `stage`, plays `clip` through the Moment player, and shows `StagedCommentsBar` under the transcript with
// `comment.list` / `comment.send` answers.

/// Words or lines selected in the transcript: where they start and end, and their text (the comment's quote).
struct TranscriptSelection: Equatable, Hashable {
    let from: LinePoint
    let to: LinePoint
    let quote: String

    /// What a comment or a clip of this selection is about.
    var target: MomentTarget { .selection(from: from, to: to) }
    var fromSec: Double { from.atSec }
    var toSec: Double { max(from.atSec, to.atSec) }

    /// "54:41" for one line, "54:41 to 54:48" for more.
    var rangeText: String {
        let start = MeetingsFormat.clock(fromSec)
        let end = MeetingsFormat.clock(toSec)
        return start == end ? start : "\(start) to \(end)"
    }

    static func words(_ line: TranscriptBlockLine, range: NSRange) -> TranscriptSelection? {
        let count = line.text.utf16.count
        guard let second = line.startSec, count > 0, range.length > 0,
              range.location <= count, range.length <= count - range.location,
              let indices = Range(range, in: line.text) else { return nil }
        let quote = String(line.text[indices])
        guard quote.utf16.count == range.length,
              line.text[..<indices.lowerBound].utf16.count == range.location else { return nil }
        return TranscriptSelection(
            from: LinePoint(atSec: second, line: line.index, fraction: Double(range.location) / Double(count)),
            to: LinePoint(atSec: second, line: line.index, fraction: Double(range.location + range.length) / Double(count)),
            quote: quote)
    }

    /// The selection of whole lines, from the first line's start to the last line's start (fraction 1).
    static func lines(_ lines: [TranscriptBlockLine]) -> TranscriptSelection? {
        let sorted = lines.sorted { $0.index < $1.index }
        guard let first = sorted.first, let last = sorted.last,
              let fromSec = first.startSec, let toSec = last.startSec else { return nil }
        return TranscriptSelection(from: LinePoint(atSec: fromSec, line: first.index, fraction: 0),
                                   to: LinePoint(atSec: toSec, line: last.index, fraction: 1),
                                   quote: sorted.map(\.text).joined(separator: " "))
    }
}

/// The popover at a selection: "Comment" and "Clip 5s" (Grain), then the comment field that stages.
struct SelectionPopover: View {
    let selection: TranscriptSelection
    /// The clip's length from the selection's start ("Clip 5s"). The plan's pick: 5 s.
    var clipLengthSec: Double = 5
    /// Opens straight into the comment field (a keyboard shortcut may open it so). The plan's pick: the two actions.
    var startsInComment = false
    /// Stages the comment (`comment.stage` with `selection.target`, `text`, `selection.quote`).
    let stage: (TranscriptSelection, String) -> Void
    /// Plays a Moment of the selection: the target and the length (G62).
    let clip: (MomentTarget, Double) -> Void
    /// Plays the whole selection, from its first line to the end of its last; nil hides "Play selection".
    var playAll: ((MomentTarget) -> Void)? = nil
    var close: () -> Void = {}

    /// Words that start a comment of a usual kind: a click writes them, the reader types the rest.
    static let starters = ["Fix the speaker", "Make this a question", "Add to glossary"]

    @State private var commenting = false
    @State private var text = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if commenting || startsInComment {
                composer
            } else {
                actions
            }
        }
        .padding(10)
        .frame(width: commenting || startsInComment ? 320 : nil)
        .onExitCommand { close() }
    }

    private var actions: some View {
        HStack(spacing: 4) {
            Button { commenting = true; fieldFocused = true } label: {
                Label("Comment", systemImage: "text.bubble")
            }
            .buttonStyle(.genHoverPlain())
            .padding(.horizontal, 6).frame(minHeight: 24)
            .instantTooltip("Write a comment on \(selection.rangeText) for the listening agent")
            .keyboardShortcut("c", modifiers: [.command, .shift])
            Divider().frame(height: 16)
            Button { clip(selection.target, clipLengthSec) } label: {
                HStack(spacing: 4) {
                    Image(systemName: "film")
                    Text("Clip")
                    Text(verbatim: MeetingsFormat.seconds(clipLengthSec).replacingOccurrences(of: " ", with: ""))
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.genHoverPlain())
            .padding(.horizontal, 6).frame(minHeight: 24)
            .instantTooltip("Play \(MeetingsFormat.seconds(clipLengthSec)) from \(MeetingsFormat.clock(selection.fromSec))")
            .accessibilityLabel("Clip \(MeetingsFormat.seconds(clipLengthSec)) from \(MeetingsFormat.clock(selection.fromSec))")
            if let playAll {
                Button { playAll(selection.target) } label: {
                    Label("Play selection", systemImage: "play.fill")
                }
                .buttonStyle(.genHoverPlain())
                .padding(.horizontal, 6).frame(minHeight: 24)
                .instantTooltip("Play \(selection.rangeText), every selected line to its end")
            }
            Divider().frame(height: 16)
            Button {
                Clipboard.copy(selection.quote, what: "the selected lines")
                close()
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            .buttonStyle(.genHoverPlain())
            .padding(.horizontal, 6).frame(minHeight: 24)
            .instantTooltip("Copy the words of \(selection.rangeText)")
        }
        .font(.system(size: 12.5))
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Badge(selection.rangeText, color: .purple, look: .tone, monospaced: true)
                Text(verbatim: "“\(selection.quote)”")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
            }
            WrapLayout(spacing: 6, lineSpacing: 6) {
                ForEach(Self.starters, id: \.self) { starter in
                    KitButton(starter, size: .small, tooltip: "Start the comment with “\(starter):”") {
                        text = Self.started(text, with: starter)
                        fieldFocused = true
                    }
                }
            }
            TextField("Comment for the listening agent", text: $text, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...5)
                .focused($fieldFocused)
                .onSubmit(submit)
                .accessibilityLabel("Comment on \(selection.rangeText)")
            HStack {
                Text("⌘↩ stages · Esc closes").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { close() }
                    .keyboardShortcut(.cancelAction)
                Button("Stage", action: submit)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(trimmed.isEmpty)
                    .buttonStyle(.genPrimary())
            }
        }
        .onAppear { fieldFocused = true }
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// The comment with `starter` before it. Another starter that stood there is replaced, so two clicks do not stack.
    static func started(_ text: String, with starter: String) -> String {
        var rest = text
        for other in starters where rest.hasPrefix("\(other): ") {
            rest = String(rest.dropFirst(other.count + 2))
        }
        return "\(starter): \(rest)"
    }

    private func submit() {
        guard !trimmed.isEmpty else { return }
        stage(selection, trimmed)
        text = ""
        close()
    }
}

/// What the last send did (G60, G61), as the bar shows it.
enum CommentDelivery: Equatable {
    case idle
    case sending(count: Int)
    /// `comment.send` answered: how many comments went out and how many listeners got them (0: nobody listened).
    case sent(comments: Int, listeners: Int)
    case failed(message: String)

    /// "Sent 3 comments to 1 listener", "Nobody listens: 3 comments stay staged", "Sending 2 comments…".
    var text: String? {
        switch self {
        case .idle:
            return nil
        case .sending(let count):
            return "Sending \(Plural.count(count, "comment"))…"
        case .sent(let comments, let listeners):
            if listeners == 0 { return "Nobody listens: \(Plural.count(comments, "comment")) stay staged" }
            return "Sent \(Plural.count(comments, "comment")) to \(Plural.count(listeners, "listener"))"
        case .failed(let message):
            return "Not sent: \(message). The comments stay staged."
        }
    }

    var isError: Bool {
        switch self {
        case .failed: return true
        case .sent(_, let listeners): return listeners == 0
        default: return false
        }
    }
}

/// One staged comment as the bar lists it.
struct StagedCommentLine: Equatable, Identifiable {
    let id: String
    let rangeText: String
    let text: String

    init(id: String, rangeText: String, text: String) {
        self.id = id
        self.rangeText = rangeText
        self.text = text
    }

    /// From the service's comment: its range on the transcript clock.
    init(_ comment: MeetingComment) {
        id = comment.id
        text = comment.text
        switch comment.target {
        case .selection(let from, let to):
            let start = MeetingsFormat.clock(from.atSec), end = MeetingsFormat.clock(to.atSec)
            rangeText = start == end ? start : "\(start) to \(end)"
        case .range(let from, let to):
            rangeText = "\(MeetingsFormat.clock(from)) to \(MeetingsFormat.clock(to))"
        case .time(let at), .stretch(let at, _):
            rangeText = MeetingsFormat.clock(at)
        case .item(let id):
            rangeText = id
        }
    }
}

/// The staged comments under the transcript: who receives them, each with its range and an unstage button, and the
/// one "Send N comments" control with its result text (G60, G61).
struct StagedCommentsBar: View {
    let comments: [StagedCommentLine]
    /// Who listens now (`comment.list`'s listeners).
    let listeners: [CommentListener]
    var delivery: CommentDelivery = .idle
    let send: () -> Void
    let unstage: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Staged for the listening agent").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    CountBadge(comments.count, tooltip: Plural.count(comments.count, "staged comment"))
                }
                Label(Self.receiverText(listeners), systemImage: listeners.isEmpty ? "person.slash" : "person.wave.2")
                    .font(.system(size: 11)).foregroundStyle(listeners.isEmpty ? Color.orange : Color.secondary)
                    .lineLimit(1).truncationMode(.middle)
            }
            ForEach(comments) { comment in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Badge(comment.rangeText, color: .purple, look: .tone, monospaced: true)
                    Text(verbatim: comment.text).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .layoutPriority(1)
                    IconButton(systemName: "xmark", tooltip: "Unstage this comment", size: 10) { unstage(comment.id) }
                }
                .accessibilityElement(children: .combine)
                .accessibilityAction(named: "Unstage") { unstage(comment.id) }
            }
            HStack(spacing: 8) {
                if let text = delivery.text {
                    Label(text, systemImage: delivery.isError ? "exclamationmark.triangle" : "checkmark.circle")
                        .font(.system(size: 11.5))
                        .foregroundStyle(delivery.isError ? Color.orange : Color.secondary)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                Spacer()
                Button(action: send) {
                    Label(Self.sendTitle(count: comments.count, listeners: listeners.count), systemImage: "paperplane")
                }
                .buttonStyle(.genPrimary())
                .disabled(comments.isEmpty || listeners.isEmpty || isSending)
                .keyboardShortcut(.return, modifiers: [.command, .shift])
                .instantTooltip(listeners.isEmpty
                    ? "Nobody runs tools meetings listen on this meeting. The comments stay staged."
                    : "Sends every staged comment as one message. A sent comment cannot be taken back.")
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    private var isSending: Bool {
        if case .sending = delivery { return true }
        return false
    }

    /// "Send 3 comments", or "Keep staged" while nobody listens (G60).
    static func sendTitle(count: Int, listeners: Int) -> String {
        listeners == 0 ? "Keep staged" : "Send \(Plural.count(count, "comment"))"
    }

    /// "listen agent, pid 4211", "2 listeners", or "Nobody listens".
    static func receiverText(_ listeners: [CommentListener]) -> String {
        switch listeners.count {
        case 0: return "Nobody listens on this meeting"
        case 1:
            let listener = listeners[0]
            return "\(listenerName(listener.actor)), pid \(listener.pid)"
        default: return "\(listeners.count) listeners"
        }
    }

    /// "listen agent", "Claude Code agent, session 7f3a": the harness by its name, not by its id.
    static func listenerName(_ actor: DecisionActor) -> String {
        if let harness = actor.harness {
            let session = actor.session.map { ", session \($0.prefix(4))" } ?? ""
            return "\(Harness(runtimeAgent: harness)?.label ?? harness) agent\(session)"
        }
        return "\(actor.kind) agent"
    }
}
