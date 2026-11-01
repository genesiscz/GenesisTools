import Foundation

/// One `file:line` a decision cites, as the decision log's reader filled it (`InboxRef`,
/// src/question/lib/inbox/build.ts and excerpts.ts): the real lines read from disk, or why there are none. The hub's
/// Inbox (`tools question inbox`) and the widget's decision cards (`WidgetDecisionDetails.refs`) both decode it.
public struct DecisionRef: Codable, Hashable, Sendable {
    /// As written in the reply.
    public let path: String
    public let line: Int?
    public let endLine: Int?
    /// The file the path names (the loader tries the session's folder, its checkout and the main checkout,
    /// then a unique suffix match); null when it could not be located.
    public let absolute: String?
    /// The real lines read from disk by the loader; null when the file could not be read.
    public let excerpt: String?
    /// The 1-based line the excerpt starts at.
    public let startLine: Int?
    /// For syntax highlighting.
    public let language: String?
    public let missing: Bool?
    /// The folders a relative path was looked up in.
    public let searched: [String]?
    /// Files the path matched by suffix: more than one means it is ambiguous.
    public let matches: Int?

    /// Lines to show, or a missing file to name: a found file the reply named without a line has neither.
    public var hasContent: Bool { (excerpt?.isEmpty == false) || missing == true }

    /// "src/rules.ts:9", as the reply wrote it.
    public var displayPath: String { line.map { "\(path):\($0)" } ?? path }

    /// The cited lines, for a link that opens the file at them.
    public var lines: MarkdownLineRange? {
        line.flatMap { MarkdownLineRange(first: $0, last: endLine ?? $0) }
    }

    /// The file to open: the loader's absolute path, an absolute path as written, else the path under `root`.
    public func file(under root: String?) -> String {
        if let absolute { return absolute }
        if path.hasPrefix("/") { return path }
        return root.map { $0 + "/" + path } ?? path
    }

    /// Why a missing ref has no lines, in the words the card shows: what was searched and where. Never
    /// "file not found" for a file that exists elsewhere (H5).
    public var unresolvedNote: (label: String, detail: String) {
        let folders = (searched ?? []).map { ($0 as NSString).lastPathComponent }
        let unique = folders.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        if let matches, matches > 1 {
            return ("\(matches) matches", "\(matches) files end with \(path) under \(unique.first ?? "the session's folder"); the reply does not say which one.")
        }
        if path.hasPrefix("/") {
            return ("not on disk", "\(path) is not on this Mac any more.")
        }
        if unique.isEmpty {
            return ("can't locate", "The session's folder is not known, so \(path) cannot be looked up.")
        }
        return ("can't locate", "Not under \(unique.joined(separator: ", ")): the reply may name a file of another repository.")
    }
}

/// Where the last send took a decision's answer (`delivery` on the stored row, `InboxDeliveryView` in
/// src/question/lib/inbox/build.ts). The hub's Inbox footer and the widget's answered card say it in one line.
public struct DecisionDelivery: Codable, Hashable, Sendable {
    public let route: String
    public let target: String?
    /// A one-sentence reason a queued send delivered nothing. New rows store it here; older rows put
    /// the raw dump in `target`, which the TS side reads through the same rules (`inboxDelivery`).
    public let error: String?
    /// The raw dump behind an old row's sentence, shown behind Details only.
    public let raw: String?
    public let at: String

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoPlain = ISO8601DateFormatter()

    /// When the send ran, with or without fractional seconds.
    public var date: Date? { Self.iso.date(from: at) ?? Self.isoPlain.date(from: at) }

    /// A short human place, never a multi-line dump: the first line of whatever the row stored.
    private var place: String? {
        target?.split(separator: "\n").first.map(String.init)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "Sent 22:31 to cmux pane work · agent", "Sent 22:31 to Codex worker w1", "Waiting to send since 22:31: why".
    /// New rows store `cmux · …` and `codex worker …`; older rows stored the bare pane or worker name. Every delivered
    /// route reads "Sent": a Claude session's own channel (`claude-peer`) read "queued … when the decisions hook is on"
    /// under a header that said "Sent" (UX audit 2026-10-27, F7).
    public var line: String {
        let time = date.map { Self.clock.string(from: $0) } ?? ""
        // The decision log's delivery channels (`DeliveryChannel`, src/question/lib/decisions/deliver.ts), not the
        // harness set: `codex` is the Codex worker route.
        switch route {
        case "cmux":
            let where_ = place.map { $0.hasPrefix("cmux") ? $0 : "cmux pane \($0)" } ?? "the cmux pane"
            return "Sent \(time) to \(where_)"
        case "codex":
            let who = place.map { $0.hasPrefix("codex") ? "C" + $0.dropFirst() : "Codex worker \($0)" } ?? "the Codex worker"
            return "Sent \(time) to \(who)"
        case "resume": return "Resumed \(time) in " + (place ?? "a new pane") + "; the answer goes with its first prompt"
        case "prompt": return "Sent \(time) with the session's next prompt"
        case "queued":
            let why = error ?? place
            return "Waiting to send since \(time)" + (why.map { ": \($0)" } ?? "") + "."
        default:
            return "Sent \(time) to " + (place ?? "the session")
        }
    }

    public var isQueued: Bool { route == "queued" }
}
