//
//  SessionToolCallView.swift
//  Genesis
//
//  One tool call in the transcript, drawn like Claude Code's terminal:
//
//      ● Write(Sources/Hub/HubSessionDetail.swift)                    ~4s  ›
//        ⎿ Wrote 198 lines to Sources/Hub/HubSessionDetail.swift
//           1  import SwiftUI
//           …
//          … +188 lines
//
//  Write shows the written file, Edit a red/green diff of old → new, Read the numbered file, a
//  command its output. A Bash call that edited files (sed, python, fable-replace) shows what it
//  changed from the change log (`SessionToolChanges.swift`). The verbosity level decides how much
//  is open by default and how many body lines show.
//
//  Portable except for the app's `.genHover*` / `.instantTooltip` conventions.
//

import AppKit
import Foundation
import SwiftUI

// MARK: - Verbosity

public enum TranscriptVerbosity: String, CaseIterable, Identifiable, Sendable {
    /// Chat only; each run of tool calls is one summary line.
    case minimal
    /// One line per tool call with its main argument; click to open.
    case inputs
    /// Every call open, its output trimmed.
    case outputs
    /// Every call open, nothing trimmed, thinking open.
    case verbose

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .minimal: return "Minimal"
        case .inputs: return "Tool inputs"
        case .outputs: return "Inputs + output"
        case .verbose: return "Verbose"
        }
    }

    public var detail: String {
        switch self {
        case .minimal: return "Chat only; tool work folded into one line per run"
        case .inputs: return "One line per tool call; click one to open it"
        case .outputs: return "Every tool call open, output trimmed"
        case .verbose: return "Everything open, output not trimmed"
        }
    }

    public var symbol: String {
        switch self {
        case .minimal: return "text.alignleft"
        case .inputs: return "list.bullet"
        case .outputs: return "list.bullet.indent"
        case .verbose: return "text.justify.left"
        }
    }

    /// Tool calls are open unless the reader closed them.
    public var opensTools: Bool { self == .outputs || self == .verbose }
    public var opensThinking: Bool { self == .verbose }
    /// Body lines shown before `… +N lines`; nil shows all.
    public var bodyLimit: Int? { self == .verbose ? nil : 10 }
}

/// Which code blocks of a tool call wrap their long lines instead of scrolling sideways (Martin,
/// 2026-09-30: long commands were clipped). Persisted by the transcript's toolbar.
public struct TranscriptWrap: Equatable, Sendable {
    public var inputs = false
    public var outputs = false

    public init(inputs: Bool = false, outputs: Bool = false) {
        self.inputs = inputs
        self.outputs = outputs
    }

    public var any: Bool { inputs || outputs }

    public var detail: String {
        switch (inputs, outputs) {
        case (true, true): return "tool inputs and outputs wrap"
        case (true, false): return "tool inputs wrap, outputs scroll sideways"
        case (false, true): return "tool outputs wrap, inputs scroll sideways"
        case (false, false): return "long lines scroll sideways"
        }
    }
}

// MARK: - Services

/// What rows need beyond their own value: the session file for full inputs and results, the change
/// log for Bash edits, and the host's "open the diff" action. Compared by identity.
public final class TranscriptServices: @unchecked Sendable {
    public let sessionId: String
    public let cwd: String?
    public let nativeLog: SessionNativeLog?
    public let changes: ToolChangeSource?
    /// "Open the Changes view at this file (and line)". nil hides every "Open diff" button.
    /// Genesis leaves it nil; the GenesisTools hub wires it to its diff window.
    public let showChange: ((String, Int?) -> Void)?
    /// A host without a native session file (a chat that keeps its own tool records) supplies the
    /// detail of a call here. Asked off the main thread; nativeLog wins when both are set.
    public let detailLoader: (@Sendable (String) -> ToolCallDetail?)?
    /// Buttons a prompt or reply offers on hover and in its context menu (Copy, Edit, Fork).
    public let rowActions: ((TranscriptRow) -> [TranscriptRowAction])?
    /// A press on a notice button: the row id and the button title.
    public let onNoticeAction: ((String, String) -> Void)?
    /// The host hears the applied search query, so ⌘F can search the whole session and not only
    /// the loaded window (GenesisTools hub: `tools ai sessions grep`). Never set on `.none`.
    public var onQuery: ((String) -> Void)?

    /// Details of finished calls already loaded, by tool id. The List recycles rows and a recycled
    /// row loses its `@State`, so a row scrolled back into view used to draw the short result, load
    /// again and grow: two bodies, a plain render on the main thread and a height change per row, on
    /// every scroll (measured 2026-09-25). A running call is not kept: its detail still changes (the
    /// chat holds one services object for its whole life and fills a call in as it ends).
    private let loadedLock = NSLock()
    private var loadedById: [String: ToolLoaded] = [:]

    public init(
        sessionId: String,
        cwd: String?,
        nativeLog: SessionNativeLog?,
        changes: ToolChangeSource?,
        showChange: ((String, Int?) -> Void)?,
        detailLoader: (@Sendable (String) -> ToolCallDetail?)? = nil,
        rowActions: ((TranscriptRow) -> [TranscriptRowAction])? = nil,
        onNoticeAction: ((String, String) -> Void)? = nil
    ) {
        self.sessionId = sessionId
        self.cwd = cwd
        self.nativeLog = nativeLog
        self.changes = changes
        self.showChange = showChange
        self.detailLoader = detailLoader
        self.rowActions = rowActions
        self.onNoticeAction = onNoticeAction
    }

    public static let none = TranscriptServices(sessionId: "", cwd: nil, nativeLog: nil, changes: nil, showChange: nil)

    /// What `load` returned for this finished call before, if anything.
    public func loaded(toolId: String) -> ToolLoaded? {
        loadedLock.lock()
        defer { loadedLock.unlock() }
        return loadedById[toolId]
    }

    /// Detail of one call, plus the file's current lines and the edit's line when it is an Edit.
    /// A `finished` call's detail is kept for `loaded(toolId:)`.
    public func load(toolId: String, finished: Bool) async -> ToolLoaded? {
        if finished, let known = loaded(toolId: toolId) {
            return known
        }
        let log = nativeLog
        let loader = detailLoader
        guard log != nil || loader != nil else { return nil }
        let loaded = await Task.detached(priority: .utility) { () -> ToolLoaded? in
            guard let detail = log?.detail(for: toolId) ?? loader?(toolId) else { return nil }
            var loaded = ToolLoaded(detail: detail)
            if let path = detail.filePath, let first = detail.edits.first, !first.new.isEmpty,
               let attributes = try? FileManager.default.attributesOfItem(atPath: path),
               (attributes[.size] as? NSNumber)?.intValue ?? .max < 2_000_000,
               let text = try? String(contentsOfFile: path, encoding: .utf8),
               let range = text.range(of: first.new) {
                loaded.editStart = text[..<range.lowerBound].reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
                loaded.fileLines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            }
            return loaded
        }.value
        if finished, let loaded {
            loadedLock.lock()
            // The same bound as the session file's own detail cache.
            if loadedById.count > 400 { loadedById.removeAll() }
            loadedById[toolId] = loaded
            loadedLock.unlock()
        }
        return loaded
    }
}

public struct ToolLoaded: Equatable, Sendable {
    public var detail: ToolCallDetail
    /// Line of the (first) edit's new text in the file as it is now; nil when not found.
    public var editStart: Int?
    /// The file as it is now, for "show context" around an edit.
    public var fileLines: [String]?

    public init(
        detail: ToolCallDetail,
        editStart: Int? = nil,
        fileLines: [String]? = nil
    ) {
        self.detail = detail
        self.editStart = editStart
        self.fileLines = fileLines
    }
}

// MARK: - Presentation (pure)

public struct ToolPresentation: Equatable {
    public var name: String
    public var argument: String
    public var summary: String
    public var block: CodeBlock?
    /// The call's full input when it does not fit the header (a multi-line command, long JSON).
    public var input: CodeBlock?
    /// `input` is the header's argument in full (a command), not other fields (an Agent's JSON). An
    /// open header then leaves the argument out, so the command shows once.
    public var inputRepeatsArgument = false
    /// Input lines after the one `argument` shows (a multi-line command).
    public var moreInputLines = 0
    public var failed: Bool
    public var filePath: String?
    /// Line to open the file's diff at.
    public var line: Int?

    public static func make(line: TranscriptToolLine, loaded: ToolLoaded?, context: Int, cwd: String?) -> ToolPresentation {
        let kind = TranscriptToolKind.of(line.name)
        let detail = loaded?.detail
        let failed = line.status == .failed
        let path = detail?.filePath ?? ((kind == .read || kind == .edit) && line.input.hasPrefix("/") ? line.input : nil)
        let shownPath = path.map { relative($0, to: cwd) }
        let resultText = detail?.fullResult ?? line.result ?? ""
        let resultBlock = resultText.isEmpty ? nil : CodeBlockBuilder.numbered(
            resultText,
            language: looksLikeJSON(resultText) ? .json : .plain,
            failed: failed
        )

        var presentation = ToolPresentation(
            name: line.displayName,
            argument: shownPath ?? argument(line, detail: detail),
            summary: "",
            block: resultBlock,
            failed: failed,
            filePath: path,
            line: loaded?.editStart
        )
        let count = resultBlock?.lines.count ?? 0
        let rawInput = detail?.command ?? line.input
        // A call whose header shows one field of its input (an Agent's description, a Grep's
        // pattern) opens to all of it (`ToolCallDetail.arguments`).
        if [.search, .web, .agent, .skill, .mcp, .other].contains(kind), let arguments = detail?.arguments {
            presentation.input = CodeBlockBuilder.numbered(arguments, language: .json)
        } else if [.command, .search, .web, .agent, .skill, .mcp, .other].contains(kind), rawInput.contains("\n") || rawInput.count > 120 {
            presentation.input = CodeBlockBuilder.numbered(rawInput, language: kind == .command ? .shell : (looksLikeJSON(rawInput) ? .json : .plain))
            presentation.inputRepeatsArgument = shownPath == nil
        }
        if shownPath == nil {
            presentation.moreInputLines = max(0, inputLines(detail?.command ?? line.input) - 1)
        }

        if line.status == .pending {
            presentation.summary = "Running…"
            presentation.block = nil
            return presentation
        }
        if failed {
            let code = line.exitCode.map { "exit \($0)" } ?? "Error"
            presentation.summary = count > 0 ? "\(code) · \(lines(count))" : code
            return presentation
        }

        switch (kind, line.name) {
        case (.edit, "Write"), (.edit, "write_file"), (.edit, "create_file"):
            if let content = detail?.content {
                let block = CodeBlockBuilder.numbered(content, language: .forPath(path ?? ""))
                presentation.block = block
                presentation.summary = "Wrote \(lines(block.lines.count)) to \(shownPath ?? "the file")"
                presentation.line = 1
            } else {
                presentation.summary = firstLine(resultText) ?? "Wrote the file"
                presentation.block = nil
            }
        case (.edit, _):
            if let patch = detail?.patch {
                let block = CodeBlockBuilder.patch(patch, language: .forPath(path ?? ""))
                presentation.block = block
                presentation.summary = "Patched with \(changeWords(block))"
            } else if let edits = detail?.edits, !edits.isEmpty {
                let block = editBlock(edits, loaded: loaded, context: context, language: .forPath(path ?? ""))
                presentation.block = block
                presentation.summary = "Updated \(shownPath ?? "the file") with \(changeWords(block))"
            } else {
                presentation.summary = firstLine(resultText) ?? "Updated the file"
                presentation.block = nil
            }
        case (.read, _):
            if let resultBlock {
                presentation.block = CodeBlock(lines: resultBlock.lines, language: .forPath(path ?? ""))
            }
            presentation.summary = "Read \(lines(count))"
        case (.command, _):
            presentation.summary = count == 0 ? "(No output)" : lines(count)
        default:
            presentation.summary = count == 0 ? "(No output)" : (count == 1 ? (firstLine(resultText) ?? lines(1)) : lines(count))
            if count == 1 { presentation.block = nil }
        }
        return presentation
    }

    /// Every replacement of an Edit / MultiEdit as one block, hunks separated by gap lines. With
    /// `context` > 0 and the file at hand, a single edit also shows the lines around it.
    private static func editBlock(_ edits: [ToolEditPair], loaded: ToolLoaded?, context: Int, language: SyntaxLanguage) -> CodeBlock {
        var lines: [CodeLine] = []
        for (index, edit) in edits.enumerated() {
            if index > 0 { lines.append(CodeLine(number: nil, mark: .gap, text: "edit \(index + 1) of \(edits.count)")) }
            let start = index == 0 ? loaded?.editStart : nil
            lines += CodeBlockBuilder.edit(old: edit.old, new: edit.new, start: start, language: language).lines
        }
        if context > 0, edits.count == 1, let start = loaded?.editStart, let file = loaded?.fileLines {
            let newCount = edits[0].new.split(separator: "\n", omittingEmptySubsequences: false).count
            let before = max(0, start - 1 - context)..<max(0, start - 1)
            let afterStart = min(file.count, start - 1 + newCount)
            let after = afterStart..<min(file.count, afterStart + context)
            let head = before.map { CodeLine(number: $0 + 1, mark: .context, text: file[$0]) }
            let tail = after.map { CodeLine(number: $0 + 1, mark: .context, text: file[$0]) }
            // Unfold the gaps: the context shown is the file itself.
            let full = CodeBlockBuilder.lineDiff(
                edits[0].old.split(separator: "\n", omittingEmptySubsequences: false).map(String.init),
                edits[0].new.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            )
            var oldNumber = start
            var newNumber = start
            var middle: [CodeLine] = []
            for step in full {
                switch step {
                case .same(let text):
                    middle.append(CodeLine(number: newNumber, mark: .context, text: text))
                    oldNumber += 1
                    newNumber += 1
                case .removed(let text):
                    middle.append(CodeLine(number: oldNumber, mark: .removed, text: text))
                    oldNumber += 1
                case .added(let text):
                    middle.append(CodeLine(number: newNumber, mark: .added, text: text))
                    newNumber += 1
                }
            }
            lines = head + middle + tail
        }
        return CodeBlock(lines: lines, language: language)
    }

    /// The first input line only. The first three, joined, put the command's first line in the header
    /// right after the paren and its next lines under it with no closing paren, and an open row then
    /// printed them all again in the numbered input (Martin, 2026-09-30). The header counts the rest
    /// (`moreInputLines`); the numbered input shows the whole command once.
    private static func argument(_ line: TranscriptToolLine, detail: ToolCallDetail?) -> String {
        let source = detail?.command ?? line.input
        let first = source.split(separator: "\n", omittingEmptySubsequences: true).first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        return first.utf8.count > 400 ? String(decoding: first.utf8.prefix(400), as: UTF8.self) + "…" : first
    }

    /// Non-empty lines of an input, as `argument` counts them.
    private static func inputLines(_ source: String) -> Int {
        source.split(separator: "\n", omittingEmptySubsequences: true).count
    }

    public static func relative(_ path: String, to cwd: String?) -> String {
        guard let cwd, !cwd.isEmpty else { return (path as NSString).abbreviatingWithTildeInPath }
        let base = cwd.hasSuffix("/") ? cwd : cwd + "/"
        return path.hasPrefix(base) ? String(path.dropFirst(base.count)) : (path as NSString).abbreviatingWithTildeInPath
    }

    /// `{…}` or `[…]` end to end; `[main 4e7a3bc] subject` is not JSON.
    private static func looksLikeJSON(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed.hasPrefix("{") && trimmed.hasSuffix("}")) || (trimmed.hasPrefix("[{") && trimmed.hasSuffix("]"))
    }

    private static func lines(_ count: Int) -> String { "\(count) line\(count == 1 ? "" : "s")" }

    private static func changeWords(_ block: CodeBlock) -> String {
        let added = block.additions
        let removed = block.removals
        return "\(added) addition\(added == 1 ? "" : "s") and \(removed) removal\(removed == 1 ? "" : "s")"
    }

    private static func firstLine(_ text: String) -> String? {
        text.split(separator: "\n", omittingEmptySubsequences: true).first.map { String($0).trimmingCharacters(in: .whitespaces) }
    }
}

// MARK: - Row

public struct ToolCallRowView: View, Equatable {
    public let rowId: String
    public let toolId: String
    public let line: TranscriptToolLine
    public let verbosity: TranscriptVerbosity
    public let open: Bool
    public let showAll: Bool
    /// See `TranscriptWrap`.
    public var wrap = TranscriptWrap()
    public let services: TranscriptServices
    public let onToggle: (String) -> Void

    @State private var loaded: ToolLoaded?
    /// The services `loaded` came from. The rows appear before the session file is scanned (with
    /// `.none`), so a row opened by then loads again when the real services arrive.
    @State private var loadedFrom: ObjectIdentifier?
    /// Whether `loaded` was read after the call finished. A detail read while it ran is partial: the
    /// call's end loads it again, also from the same services (a chat keeps one for its whole life).
    @State private var loadedFinished = false
    @State private var context = 0

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.rowId == rhs.rowId && lhs.line == rhs.line && lhs.verbosity == rhs.verbosity && lhs.open == rhs.open
            && lhs.showAll == rhs.showAll && lhs.wrap == rhs.wrap && lhs.services === rhs.services
    }

    private var finished: Bool { line.status != .pending }

    private var editsFiles: Bool {
        TranscriptToolKind.of(line.name) == .command && ToolChangeHeuristics.mayEditFiles(line.input)
    }

    public var body: some View {
        let _ = RenderProbe.hit("toolRow.body")
        // A recycled row starts from what was loaded before (see `TranscriptServices.loaded`). What the
        // current services loaded wins over detail this row took from an earlier one.
        let cached = open && finished ? services.loaded(toolId: toolId) : nil
        let current = loadedFrom == ObjectIdentifier(services) ? (loaded ?? cached) : (cached ?? loaded)
        let presentation = ToolPresentation.make(line: line, loaded: current, context: context, cwd: services.cwd)
        VStack(alignment: .leading, spacing: 2) {
            Button { onToggle(rowId) } label: { header(presentation) }
                .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
                .accessibilityIdentifier("transcript-tool-row")
                .accessibilityLabel(Text("\(presentation.name) \(presentation.argument), \(presentation.summary)"))

            if open {
                ToolResultBody(
                    rowId: rowId,
                    presentation: presentation,
                    limit: showAll ? nil : verbosity.bodyLimit,
                    expandedByReader: showAll && verbosity.bodyLimit != nil,
                    wrap: wrap,
                    canAddContext: current?.fileLines != nil && (current?.detail.edits.count ?? 0) == 1,
                    onShowAll: { onToggle(rowId + "#all") },
                    onMoreContext: { context += 10 },
                    onCollapse: { onToggle(rowId) },
                    onOpenDiff: services.showChange.flatMap { show in
                        presentation.filePath.map { path in { show(path, presentation.line) } }
                    }
                )
            }

            if editsFiles, let source = services.changes, verbosity != .minimal {
                ToolChangesView(sessionId: services.sessionId, toolId: toolId, source: source, cwd: services.cwd, showChange: services.showChange, startOpen: verbosity.opensTools)
            }
        }
        .padding(.leading, 24)
        .padding(.trailing, 12)
        .padding(.vertical, 0)
        .task(id: open ? "\(toolId)|\(ObjectIdentifier(services))|\(finished)" : "") {
            let source = ObjectIdentifier(services)
            guard open, loaded == nil || loadedFrom != source || (finished && !loadedFinished) else { return }
            // A finished call the current services loaded before is drawn from `services.loaded`
            // already (see body). A row still holding an earlier source's detail takes that answer
            // over; a recycled row with nothing loaded writes nothing, so it draws once.
            if finished, let known = services.loaded(toolId: toolId) {
                if loaded != nil {
                    loaded = known
                    loadedFrom = source
                    loadedFinished = true
                }
                return
            }
            RenderProbe.hit("toolRow.load")
            let result = await services.load(toolId: toolId, finished: finished)
            // The detached load ignores cancellation: an older source's answer must not land late.
            guard !Task.isCancelled else { return }
            // The new source's answer replaces the old one, nil included (its scan had no detail),
            // so a refresh never keeps the previous source's detail. Until it lands, the old one stays.
            loaded = result
            loadedFrom = source
            loadedFinished = finished
        }
    }

    private func header(_ presentation: ToolPresentation) -> some View {
        HStack(spacing: 7) {
            statusGlyph
            Image(systemName: line.symbol)
                .font(.system(size: 10.5))
                .foregroundStyle(SessionPalette.faint)
                .frame(width: 13)
            // An open call whose numbered input holds the command shows only the tool name and a line
            // count here, so the command is printed once. A closed one shows the first line and counts
            // the rest. See `ToolPresentation.argument`.
            let argumentInBlock = open && presentation.inputRepeatsArgument && presentation.input != nil
            let shownArgument = argumentInBlock || presentation.argument.isEmpty ? "" : "(\(presentation.argument))"
            let lineCount = presentation.moreInputLines > 0
                ? (argumentInBlock ? " \(presentation.moreInputLines + 1) lines" : " +\(presentation.moreInputLines) lines")
                : ""
            (Text(verbatim: presentation.name)
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(line.status == .failed ? SessionPalette.red : SessionPalette.text)
                + Text(verbatim: shownArgument)
                .font(SessionPalette.mono(11.5))
                .foregroundColor(SessionPalette.dim)
                + Text(verbatim: lineCount)
                .font(SessionPalette.mono(10.5))
                .foregroundColor(SessionPalette.faint))
                // An open call with no input block below shows its whole input here; one line only
                // when the block has it (a short command stayed cut in a narrow pane). A multi-line
                // command's header is one line.
                .lineLimit(presentation.moreInputLines > 0 ? 1 : (open ? (presentation.input == nil ? nil : 1) : 3))
                .truncationMode(.middle)
            Spacer(minLength: 8)
            if let code = line.exitCode, code != 0 {
                Text(verbatim: "exit \(code)")
                    .font(SessionPalette.mono(10.5, weight: .semibold))
                    .foregroundStyle(SessionPalette.red)
                    .fixedSize()
            }
            if let duration = line.duration {
                Text(verbatim: "~" + SessionFormat.duration(duration))
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
                    .fixedSize()
                    .instantTooltip("Time to the next transcript entry; the transcript records no tool timing")
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(SessionPalette.faint)
                .rotationEffect(.degrees(open ? 90 : 0))
                .frame(width: 12)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .frame(minHeight: 24)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var statusGlyph: some View {
        switch line.status {
        case .ok:
            SessionStatusDot(color: SessionPalette.green).frame(width: 10)
        case .failed:
            Image(systemName: "xmark")
                .font(.system(size: 8.5, weight: .heavy))
                .foregroundStyle(SessionPalette.red)
                .frame(width: 10)
        case .pending:
            SessionStatusDot(color: SessionPalette.orange)
                .overlay(Circle().strokeBorder(SessionPalette.orange.opacity(0.4), lineWidth: 3).frame(width: 10, height: 10))
                .frame(width: 10)
        }
    }
}

/// `⎿ summary`, then the numbered body with its `… +N lines` tail and the edit actions.
private struct ToolResultBody: View {
    let rowId: String
    let presentation: ToolPresentation
    let limit: Int?
    /// The reader pressed "… +N lines" at a verbosity that trims the body. The "show fewer" link only
    /// makes sense then.
    let expandedByReader: Bool
    /// See `TranscriptWrap`.
    let wrap: TranscriptWrap
    let canAddContext: Bool
    let onShowAll: () -> Void
    let onMoreContext: () -> Void
    /// A click on the output (on mouse-up, not a drag that selects text) closes the call.
    let onCollapse: () -> Void
    let onOpenDiff: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let input = presentation.input {
                CodeBlockText(block: input, limit: limit, cacheKey: rowId + "#in", wrap: wrap.inputs)
                    .padding(.leading, 16)
                    .padding(.bottom, 2)
                if let limit, input.lines.count > limit {
                    Button(action: onShowAll) {
                        Text(verbatim: "… +\(input.lines.count - limit) input lines")
                            .font(SessionPalette.mono(11.5))
                            .foregroundStyle(SessionPalette.blue)
                    }
                    .buttonStyle(.genHoverPlain())
                    .padding(.leading, 16)
                    .instantTooltip("Show the whole input and output")
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: "⎿")
                    .font(SessionPalette.mono(12))
                    .foregroundStyle(SessionPalette.faint)
                Text(verbatim: presentation.summary)
                    .font(.system(size: 12))
                    .foregroundStyle(presentation.failed ? SessionPalette.red : SessionPalette.secondary)
                    .lineLimit(2)
                Spacer(minLength: 6)
                if canAddContext {
                    smallButton("Show context", symbol: "arrow.up.and.down", tip: "Show 10 more lines of the file around the edit", action: onMoreContext)
                        .accessibilityIdentifier("transcript-tool-more-context")
                }
                if let onOpenDiff {
                    smallButton("Open diff", symbol: "arrow.up.right.square", tip: "Open this file in the Changes view", action: onOpenDiff)
                        .accessibilityIdentifier("transcript-tool-open-diff")
                }
            }
            if let block = presentation.block, !block.lines.isEmpty {
                CodeBlockText(block: block, limit: limit, cacheKey: rowId, wrap: wrap.outputs)
                    .padding(.leading, 16)
                    .background(ClickUpCatcher(action: onCollapse))
                if let limit, block.lines.count > limit {
                    Button(action: onShowAll) {
                        Text(verbatim: "… +\(block.lines.count - limit) lines")
                            .font(SessionPalette.mono(11.5))
                            .foregroundStyle(SessionPalette.blue)
                    }
                    .buttonStyle(.genHoverPlain())
                    .padding(.leading, 16)
                    .instantTooltip("Show every line")
                    .accessibilityIdentifier("transcript-tool-show-all")
                } else if limit == nil, block.lines.count > (TranscriptVerbosity.outputs.bodyLimit ?? 0), expandedByReader {
                    Button(action: onShowAll) {
                        Text("Show fewer lines")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(SessionPalette.blue)
                    }
                    .buttonStyle(.genHoverPlain())
                    .padding(.leading, 16)
                }
            }
        }
        .padding(.leading, 20)
        .padding(.bottom, 6)
    }

    private func smallButton(_ title: String, symbol: String, tip: String, action: @escaping () -> Void) -> some View {
        GhostButton(title, symbol: symbol, tooltip: tip, height: 20, action: action)
    }
}

// MARK: - Changes a command made

/// Under a Bash call that edited files: `N files changed +a −d`, opening to each file's
/// coloured hunks, with more context and "open the diff" per file.
public struct ToolChangesView: View {
    public let sessionId: String
    public let toolId: String
    public let source: ToolChangeSource
    public let cwd: String?
    public let showChange: ((String, Int?) -> Void)?

    @State private var files: [ToolFileChange]?
    @State private var open: Bool

    public init(sessionId: String, toolId: String, source: ToolChangeSource, cwd: String?, showChange: ((String, Int?) -> Void)?, startOpen: Bool) {
        self.sessionId = sessionId
        self.toolId = toolId
        self.source = source
        self.cwd = cwd
        self.showChange = showChange
        _open = State(initialValue: startOpen)
    }
    @State private var context: [String: Int] = [:]
    @State private var expanded: [String: String] = [:]

    public var body: some View {
        // A VStack, not a Group: `.task` on a Group with no child never runs, and before the load
        // there is no child.
        VStack(alignment: .leading, spacing: 0) {
            if let files, !files.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Button { open.toggle() } label: { summary(files) }
                        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
                        .accessibilityIdentifier("transcript-tool-changes")
                    if open {
                        ForEach(files) { file in
                            fileView(file)
                        }
                    }
                }
                .padding(.leading, 20)
                .padding(.bottom, 4)
            }
        }
        .task(id: toolId) {
            guard files == nil else { return }
            let loaded = await source.changes(sessionId: sessionId, toolUseId: toolId)
            // A row that left the screen got an empty answer; keep asking when it returns.
            // Only an answer with files is kept: a source answers [] for "no change" and for a failed
            // lookup alike, so an empty answer leaves `files` nil and the row asks again the next time it
            // appears. The source's cache answers a successful empty lookup without a process.
            guard !Task.isCancelled, !loaded.isEmpty else { return }
            files = loaded
        }
    }

    private func summary(_ files: [ToolFileChange]) -> some View {
        let additions = files.reduce(0) { $0 + $1.counts.additions }
        let deletions = files.reduce(0) { $0 + $1.counts.deletions }
        return HStack(spacing: 7) {
            Text(verbatim: "⎿")
                .font(SessionPalette.mono(12))
                .foregroundStyle(SessionPalette.faint)
            Image(systemName: "doc.badge.gearshape")
                .font(.system(size: 10.5))
                .foregroundStyle(SessionPalette.orange)
            Text(verbatim: "\(files.count) file\(files.count == 1 ? "" : "s") changed")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(SessionPalette.secondary)
            // When the log has no diff for any file, say so instead of "+0 −0".
            if files.allSatisfy({ $0.skipReason != nil }) {
                Text(verbatim: "no diff recorded")
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
            } else {
                Text(verbatim: "+\(additions)")
                    .font(SessionPalette.mono(11.5, weight: .semibold))
                    .foregroundStyle(SessionPalette.green)
                Text(verbatim: "−\(deletions)")
                    .font(SessionPalette.mono(11.5, weight: .semibold))
                    .foregroundStyle(SessionPalette.red)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(SessionPalette.faint)
                .rotationEffect(.degrees(open ? 90 : 0))
                .frame(width: 12)
        }
        .padding(.horizontal, 8)
        .frame(height: 24)
        .contentShape(Rectangle())
    }

    private func fileView(_ file: ToolFileChange) -> some View {
        let counts = file.counts
        let diff = expanded[file.path] ?? file.unifiedDiff ?? ""
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                SessionStatusDot(color: file.status == "added" ? SessionPalette.green : file.status == "deleted" ? SessionPalette.red : SessionPalette.orange)
                Text(verbatim: ToolPresentation.relative(file.path, to: cwd))
                    .font(SessionPalette.mono(11.5, weight: .medium))
                    .foregroundStyle(SessionPalette.text)
                    .lineLimit(1)
                    .truncationMode(.head)
                // A skipped file names why it has no diff instead of "+0 −N".
                Text(verbatim: file.skipLabel ?? "+\(counts.additions) −\(counts.deletions)")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.dim)
                Spacer(minLength: 6)
                // No "More context" for a skipped file.
                if file.skipReason == nil, file.beforeBlob != nil || file.afterBlob != nil {
                    Button {
                        Task { await moreContext(file) }
                    } label: {
                        Label("More context", systemImage: "arrow.up.and.down")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .buttonStyle(.genHoverPlain())
                    .foregroundStyle(SessionPalette.secondary)
                    .instantTooltip("Show more unchanged lines around each change")
                }
                if let showChange {
                    Button {
                        showChange(file.path, file.firstLine)
                    } label: {
                        Label("Open diff", systemImage: "arrow.up.right.square")
                            .font(.system(size: 11, weight: .medium))
                    }
                    .buttonStyle(.genHoverPlain())
                    .foregroundStyle(SessionPalette.secondary)
                    .instantTooltip("Open this file in the Changes view")
                }
            }
            if !diff.isEmpty {
                CodeBlockText(
                    block: CodeBlockBuilder.unifiedDiff(diff, language: .forPath(file.path)),
                    limit: nil,
                    cacheKey: "\(toolId)|\(file.path)|\(context[file.path] ?? 3)"
                )
                .padding(.leading, 14)
            }
        }
        .padding(.leading, 26)
    }

    private func moreContext(_ file: ToolFileChange) async {
        let next = (context[file.path] ?? 3) + 20
        if let diff = await source.expandedDiff(for: file, context: next) {
            context[file.path] = next
            expanded[file.path] = diff
        }
    }
}

/// Calls `action` on a plain click inside its bounds: one mouse-up, no drag, no modifiers, and no
/// second click within the double-click interval. It sits BEHIND selectable text and only watches
/// the app's own mouse events (a local monitor that returns every event unchanged), because the
/// text view underneath takes the mouse first and a SwiftUI tap gesture on it never fired: the
/// "click the output to collapse" feature did nothing (2026-09-24). A drag that selects text and a
/// double-click that selects a word stay with the text.
public struct ClickUpCatcher: NSViewRepresentable {
    public let action: () -> Void

    public func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.action = action
        return view
    }

    public func updateNSView(_ view: CatcherView, context: Context) {
        view.action = action
    }

    public final class CatcherView: NSView {
        public var action: (() -> Void)?
        private var monitor: Any?
        private var downPoint: NSPoint?
        private var pending: DispatchWorkItem?

        public override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp]) { [weak self] event in
                self?.handle(event)
                return event
            }
        }

        private func handle(_ event: NSEvent) {
            guard event.window === window else { return }
            let inside = bounds.contains(convert(event.locationInWindow, from: nil))
            if event.type == .leftMouseDown {
                // Only a second click on THIS output (a double-click selecting a word) cancels its
                // pending collapse; a click anywhere else lets it complete.
                if inside {
                    pending?.cancel()
                    pending = nil
                }
                downPoint = inside && event.clickCount == 1 ? event.locationInWindow : nil
                guard downPoint != nil else { return }
                // Selectable text runs its own tracking loop inside this mouse-down and takes the
                // mouse-up before any monitor sees it. That loop has returned by the next turn of the
                // main queue, and the event it ended on is the mouse-up.
                DispatchQueue.main.async { [weak self] in
                    guard let self, let up = NSApp.currentEvent, up.type == .leftMouseUp else { return }
                    self.release(up)
                }
                return
            }
            release(event)
        }

        private func release(_ event: NSEvent) {
            guard let down = downPoint, event.window === window, event.clickCount <= 1,
                  bounds.contains(convert(event.locationInWindow, from: nil)),
                  event.modifierFlags.isDisjoint(with: [.command, .option, .shift, .control]),
                  hypot(event.locationInWindow.x - down.x, event.locationInWindow.y - down.y) < 4
            else { return }
            downPoint = nil
            let work = DispatchWorkItem { [weak self] in self?.action?() }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + NSEvent.doubleClickInterval, execute: work)
        }

        deinit {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
        }
    }
}
