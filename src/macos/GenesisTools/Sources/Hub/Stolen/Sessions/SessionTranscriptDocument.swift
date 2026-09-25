// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionTranscriptDocument.swift at 2026-09-24T05:05:15+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
//
//  SessionTranscriptDocument.swift
//  Genesis
//
//  Pure model behind the Session Details window. `TranscriptDocument.build` turns the
//  `tools ai sessions tail --json` turns into sections (one per user prompt) of flat rows:
//  prompt, reply, thinking, one row per tool call. Everything a row shows (clock label,
//  duration, key argument, search text) is computed here, once, off the main thread, so a
//  row body only reads stored values.
//
//  `SessionActivityDigest` derives files touched, commits and sub-agents from the same tool
//  calls. `SessionLiveness` answers running / idle / ended.
//
//  Portable: depends on Foundation and the GenesisAIMonitorKit transcript types only.
//

import Foundation
// GenesisTools adaptation: the kit types are compiled into this module.
// import GenesisAIMonitorKit

// MARK: - Rows

struct TranscriptImageRef: Equatable, Hashable {
    /// Absolute path of an image the prompt names that exists on disk; nil for a placeholder.
    let path: String?
    /// `Image #2` for a pasted image the transcript keeps no bytes for; the file name otherwise.
    let label: String
}

enum TranscriptToolStatus: Equatable {
    case ok
    case failed
    case pending
}

struct TranscriptToolLine: Equatable {
    let toolId: String
    let name: String
    let displayName: String
    let symbol: String
    /// The one argument that says what the call did: a file name, a command, a pattern.
    let keyArgument: String
    let input: String
    let result: String?
    let status: TranscriptToolStatus
    let exitCode: Int?
    let resultChars: Int?
    /// Time from this call to the next transcript entry. The transcript records no tool
    /// timing, so this is an upper bound and the view prints it with a `~`.
    let duration: TimeInterval?
}

struct TranscriptRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case prompt(text: String, images: [TranscriptImageRef])
        /// `model` is the model that wrote this reply, when the native log names it.
        case reply(text: String, usage: String?, model: String?)
        case thinking(text: String)
        case tool(TranscriptToolLine)
        /// Minimal verbosity: a run of tool calls folded into one line.
        case toolGroup(TranscriptToolGroup)
    }

    let id: String
    let kind: Kind
    let at: Date?
    /// `14:32:10`, precomputed.
    let clock: String?
    /// Lowercased text the search box matches against, capped so a huge result stays cheap.
    let searchText: String
    /// A reply draws its author row ("Claude · opus · 14:32") only at the start of a run of
    /// replies, and again when the model changes. Set by `TranscriptDocument.filtered`.
    var showsAuthor = true

    var isPrompt: Bool {
        if case .prompt = kind { return true }
        return false
    }

    var isError: Bool {
        if case .tool(let line) = kind { return line.status == .failed }
        if case .toolGroup(let group) = kind { return group.failed > 0 }
        return false
    }

    /// A row passes when it matches ANY selected chip; no chip selected means everything.
    /// A prompt always passes: it is the context the other rows hang from.
    func matches(_ chips: Set<TranscriptFilter>) -> Bool {
        if chips.isEmpty { return true }
        switch kind {
        case .prompt:
            return true
        case .reply, .thinking:
            return chips.contains(.chat)
        case .tool(let line):
            return chips.contains(.tools) || (chips.contains(.errors) && line.status == .failed)
        case .toolGroup(let group):
            return chips.contains(.tools) || (chips.contains(.errors) && group.failed > 0)
        }
    }
}

/// Consecutive tool calls shown as one line: `Ran 3 commands · Read 2 files`.
struct TranscriptToolGroup: Equatable {
    let members: [TranscriptRow]
    let summary: String
    let failed: Int
    let duration: TimeInterval?

    init(members: [TranscriptRow]) {
        self.members = members
        let lines = members.compactMap { row -> TranscriptToolLine? in
            if case .tool(let line) = row.kind { return line }
            return nil
        }
        failed = lines.filter { $0.status == .failed }.count
        let total = lines.compactMap(\.duration).reduce(0, +)
        duration = total > 0 ? total : nil
        var counts: [TranscriptToolKind: Int] = [:]
        for line in lines { counts[TranscriptToolKind.of(line.name), default: 0] += 1 }
        summary = TranscriptToolKind.allCases.compactMap { kind in counts[kind].map { kind.summarize($0) } }.joined(separator: " · ")
    }
}

/// Toggle chips of the transcript toolbar. Several can be on at once (Chat + Errors); none on
/// means "All".
enum TranscriptFilter: String, CaseIterable, Identifiable {
    case chat, tools, errors

    var id: String { rawValue }

    var title: String {
        switch self {
        case .chat: return "Chat"
        case .tools: return "Tools"
        case .errors: return "Errors"
        }
    }
}

/// Everything between one user prompt and the next. Rendered as a `List` section, so its
/// header floats (the sticky turn separator).
struct TranscriptSection: Identifiable, Equatable {
    let id: String
    /// 1-based turn index of the section's prompt inside the whole session file (exact even when
    /// only a later window is loaded); 0 for rows before the first prompt of the window.
    let number: Int
    let startedAt: Date?
    let duration: TimeInterval?
    let toolCount: Int
    let errorCount: Int
    /// Tokens and cost of the model calls in this section: from the native session file when it was
    /// read, else from the envelope's per-turn usage. nil when neither reports any.
    var usage: SessionUsage?
    var rows: [TranscriptRow]
}

struct TranscriptDocument: Equatable {
    var sections: [TranscriptSection]
    var turnCount: Int
    var toolCount: Int
    var errorCount: Int
    var firstAt: Date?
    var lastAt: Date?

    static let empty = TranscriptDocument(sections: [], turnCount: 0, toolCount: 0, errorCount: 0)

    init(sections: [TranscriptSection], turnCount: Int, toolCount: Int, errorCount: Int, firstAt: Date? = nil, lastAt: Date? = nil) {
        self.sections = sections
        self.turnCount = turnCount
        self.toolCount = toolCount
        self.errorCount = errorCount
        self.firstAt = firstAt
        self.lastAt = lastAt
    }

    /// Sections with only the rows that pass the chips and contain the query, with the reply
    /// author rows decided. A prompt alone is context, not a hit: unless Chat is on, a section
    /// whose only surviving row is its prompt is dropped.
    func filtered(_ chips: Set<TranscriptFilter>, query: String) -> [TranscriptSection] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()

        return sections.compactMap { section in
            var copy = section
            if !chips.isEmpty || !needle.isEmpty {
                copy.rows = section.rows.filter { row in
                    row.matches(chips) && (needle.isEmpty || row.searchText.contains(needle))
                }
                if !chips.isEmpty, !chips.contains(.chat) {
                    guard copy.rows.contains(where: { !$0.isPrompt }) else { return nil }
                }
            }
            Self.markAuthors(&copy.rows)
            return copy.rows.isEmpty ? nil : copy
        }
    }

    /// Minimal verbosity: thinking goes, and every run of consecutive tool rows becomes one group
    /// row (id `g-` + the first call's row id).
    static func folded(_ sections: [TranscriptSection]) -> [TranscriptSection] {
        sections.map { section in
            var copy = section
            var rows: [TranscriptRow] = []
            var run: [TranscriptRow] = []
            func flush() {
                guard let first = run.first else { return }
                let group = TranscriptToolGroup(members: run)
                rows.append(TranscriptRow(
                    id: "g-\(first.id)",
                    kind: .toolGroup(group),
                    at: first.at,
                    clock: first.clock,
                    searchText: run.map(\.searchText).joined(separator: " ")
                ))
                run = []
            }
            for row in section.rows {
                switch row.kind {
                case .tool: run.append(row)
                case .thinking: continue
                default:
                    flush()
                    rows.append(row)
                }
            }
            flush()
            copy.rows = rows
            return copy
        }
    }

    /// The first reply of a section shows its author row; a later one only when its model differs
    /// from the previous reply's. Tool calls and thinking between replies do not break the run.
    static func markAuthors(_ rows: inout [TranscriptRow]) {
        var seenReply = false
        var lastModel: String?
        for index in rows.indices {
            guard case .reply(_, _, let model) = rows[index].kind else { continue }
            let changed = model != nil && lastModel != nil && model != lastModel
            rows[index].showsAuthor = !seenReply || changed
            seenReply = true
            if let model { lastModel = model }
        }
    }

    /// `turnOffset` is the session-wide index of `turns[0]` (`TranscriptEnvelope.windowStart`), so a
    /// page loaded from the middle of a session still numbers its prompts like the whole file does.
    static func build(
        _ turns: [TranscriptTurn],
        turnOffset: Int = 0,
        native: SessionNativeSummary? = nil,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> TranscriptDocument {
        let dates = turns.map { SessionFormat.parseISO($0.at) }
        var sections: [TranscriptSection] = []
        var rows: [TranscriptRow] = []
        var sectionId = "s-lead"
        var sectionNumber = 0
        var sectionStart: Date?
        var seen = Set<String>()
        var toolTotal = 0
        var errorTotal = 0
        var sectionFirstTurn: [String] = []
        var pendingFirstTurn: String?
        var sectionEnvelopeUsage = SessionUsage()
        var previousIndex: Int?

        func closeSection(endingAt end: Date?) {
            guard !rows.isEmpty else { return }
            let tools = rows.filter { if case .tool = $0.kind { return true } else { return false } }
            let lastAt = rows.compactMap(\.at).last
            let finish = end ?? lastAt
            let duration: TimeInterval? = {
                guard let start = sectionStart, let finish else { return nil }
                let span = finish.timeIntervalSince(start)
                return span > 0 ? span : nil
            }()
            sections.append(TranscriptSection(
                id: sectionId,
                number: sectionNumber,
                startedAt: sectionStart,
                duration: duration,
                toolCount: tools.count,
                errorCount: tools.filter(\.isError).count,
                usage: sectionEnvelopeUsage.isEmpty ? nil : sectionEnvelopeUsage,
                rows: rows
            ))
            rows = []
            sectionEnvelopeUsage = SessionUsage()
            sectionFirstTurn.append(pendingFirstTurn ?? "")
            pendingFirstTurn = nil
        }

        func append(_ row: TranscriptRow) {
            // Ids come from the CLI and go straight into a ForEach; a repeated id is undefined
            // behaviour in SwiftUI (the 2026-09-03 popup freeze), so a duplicate is dropped.
            guard seen.insert(row.id).inserted else { return }
            rows.append(row)
        }

        for (index, turn) in turns.enumerated() {
            let at = dates[index]
            let nextAt = dates[(index + 1)...].lazy.compactMap { $0 }.first
            let clock = at.map(SessionFormat.clock)

            // GenesisTools adaptation: search hits merged with the window are sparse. A reply or tool
            // turn whose index does not follow the previous turn's belongs to a prompt that is not in
            // the list, so it opens its own unnumbered section instead of joining the last prompt's.
            if turn.role != "user", let own = turn.index, let previous = previousIndex, own != previous + 1 {
                closeSection(endingAt: nil)
                sectionNumber = 0
                sectionId = "s-gap-\(turn.id)"
                sectionStart = nil
            }
            previousIndex = turn.index

            if turn.role == "user" {
                // The section's work ends at its last entry; the gap before the next prompt is the
                // user reading, not the agent working.
                closeSection(endingAt: nil)
                pendingFirstTurn = turn.id
                // GenesisTools adaptation: a turn that knows its session-wide index (search hits merged
                // with the window) numbers itself; a contiguous page counts from `turnOffset`.
                sectionNumber = turn.index.map { $0 + 1 } ?? turnOffset + index + 1
                sectionId = "s-\(turn.id)"
                sectionStart = at
                let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
                append(TranscriptRow(
                    id: "p-\(turn.id)",
                    kind: .prompt(text: text, images: imageRefs(in: text, fileExists: fileExists)),
                    at: at,
                    clock: clock,
                    searchText: searchable(text)
                ))
                continue
            }

            if sectionStart == nil { sectionStart = at }
            if pendingFirstTurn == nil { pendingFirstTurn = turn.id }
            if let usage = turn.usage { sectionEnvelopeUsage.add(SessionUsage(usage)) }

            if let reasoning = turn.reasoning?.trimmingCharacters(in: .whitespacesAndNewlines), !reasoning.isEmpty {
                append(TranscriptRow(id: "r-\(turn.id)", kind: .thinking(text: reasoning), at: at, clock: clock, searchText: searchable(reasoning)))
            }

            let text = turn.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                append(TranscriptRow(
                    id: "a-\(turn.id)",
                    kind: .reply(text: text, usage: turn.usage?.summary, model: native?.model(forTurn: turn.id)),
                    at: at,
                    clock: clock,
                    searchText: searchable(text)
                ))
            }

            let isLastTurn = index == turns.count - 1
            for tool in turn.tools {
                let line = toolLine(tool, at: at, nextAt: nextAt, isLastTurn: isLastTurn)
                toolTotal += 1
                if line.status == .failed { errorTotal += 1 }
                append(TranscriptRow(
                    id: "t-\(tool.id)",
                    kind: .tool(line),
                    at: at,
                    clock: clock,
                    searchText: searchable("\(tool.name) \(tool.inputPreview) \(tool.result ?? "")")
                ))
            }
        }
        closeSection(endingAt: nil)

        // The native file is the better source: it has cache writes and every model call, including
        // the ones whose turn the envelope drops (thinking-only calls).
        if let native, sectionFirstTurn.count == sections.count {
            for index in sections.indices {
                let until = index + 1 < sectionFirstTurn.count ? sectionFirstTurn[index + 1] : nil
                if let usage = native.usage(fromTurn: sectionFirstTurn[index], untilTurn: until), !usage.isEmpty {
                    sections[index].usage = usage
                }
            }
        }

        return TranscriptDocument(
            sections: sections,
            turnCount: turns.count,
            toolCount: toolTotal,
            errorCount: errorTotal,
            firstAt: dates.lazy.compactMap { $0 }.first,
            lastAt: dates.reversed().lazy.compactMap { $0 }.first
        )
    }

    // MARK: Helpers

    private static func searchable(_ text: String) -> String {
        // utf8 prefix: `String.prefix` walks graphemes, which is the O(n) cost the design rules warn about.
        let capped = text.utf8.count > 6000 ? String(decoding: text.utf8.prefix(6000), as: UTF8.self) : text
        return capped.lowercased()
    }

    static func toolLine(_ tool: TranscriptTool, at: Date?, nextAt: Date?, isLastTurn: Bool) -> TranscriptToolLine {
        let kind = TranscriptToolKind.of(tool.name)
        let status: TranscriptToolStatus
        if tool.isError || (tool.exitCode ?? 0) != 0 {
            status = .failed
        } else if tool.result == nil && isLastTurn {
            status = .pending
        } else {
            status = .ok
        }

        var duration: TimeInterval?
        if let at, let nextAt {
            let span = nextAt.timeIntervalSince(at)
            // A gap of an hour is the user walking away, not the tool running.
            if span >= 0, span < 3600 { duration = span }
        }

        return TranscriptToolLine(
            toolId: tool.id,
            name: tool.name,
            displayName: displayName(tool.name),
            symbol: kind.symbol,
            keyArgument: keyArgument(tool.inputPreview, kind: kind),
            input: tool.inputPreview,
            result: tool.result,
            status: status,
            exitCode: tool.exitCode,
            resultChars: tool.resultChars,
            duration: duration
        )
    }

    /// `mcp__genesis-tools__handoff_post` → `genesis-tools · handoff_post`.
    static func displayName(_ name: String) -> String {
        guard name.hasPrefix("mcp__") else { return name }
        return name.dropFirst(5).replacingOccurrences(of: "__", with: " · ")
    }

    /// A path becomes its file name plus parent folder; a command or pattern stays, on one line.
    static func keyArgument(_ preview: String, kind: TranscriptToolKind) -> String {
        let firstLine = preview.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? ""
        let line = firstLine.trimmingCharacters(in: .whitespaces)
        switch kind {
        case .read, .edit:
            guard line.hasPrefix("/") || line.hasPrefix("~") else { return line }
            let url = URL(fileURLWithPath: line)
            let parent = url.deletingLastPathComponent().lastPathComponent
            return parent.isEmpty || parent == "/" ? url.lastPathComponent : "\(parent)/\(url.lastPathComponent)"
        default:
            return line.utf8.count > 240 ? String(decoding: line.utf8.prefix(240), as: UTF8.self) + "…" : line
        }
    }

    /// Existing image files the prompt names by absolute path, then `[Image #N]` placeholders.
    static func imageRefs(in text: String, fileExists: (String) -> Bool) -> [TranscriptImageRef] {
        var refs: [TranscriptImageRef] = []
        var seen = Set<String>()
        let ns = text as NSString
        let range = NSRange(location: 0, length: ns.length)

        for match in imagePathPattern.matches(in: text, range: range) {
            let raw = ns.substring(with: match.range)
            let path = (raw as NSString).expandingTildeInPath
            guard seen.insert(path).inserted, fileExists(path) else { continue }
            refs.append(TranscriptImageRef(path: path, label: URL(fileURLWithPath: path).lastPathComponent))
        }
        for match in imagePlaceholderPattern.matches(in: text, range: range) {
            let label = ns.substring(with: match.range(at: 1))
            guard seen.insert(label).inserted else { continue }
            refs.append(TranscriptImageRef(path: nil, label: label))
        }
        return refs
    }

    // swiftlint:disable force_try
    private static let imagePathPattern = try! NSRegularExpression(
        pattern: #"(?:~|/)[^\s'"`()<>\]\[]+\.(?:png|jpe?g|gif|webp|heic|tiff?)"#,
        options: [.caseInsensitive]
    )
    private static let imagePlaceholderPattern = try! NSRegularExpression(pattern: #"\[(Image #\d+)\]"#)
    // swiftlint:enable force_try
}

// MARK: - Tool taxonomy

enum TranscriptToolKind: CaseIterable {
    case command, read, edit, search, web, agent, skill, mcp, other

    static func of(_ name: String) -> TranscriptToolKind {
        if name.hasPrefix("mcp__") { return .mcp }
        switch name {
        case "Bash", "BashOutput", "KillShell", "Monitor", "commandExecution", "shell", "exec_command", "run_terminal_cmd":
            return .command
        case "Read", "NotebookRead", "read_file", "view":
            return .read
        case "Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit_file", "write_file", "create_file":
            return .edit
        case "Grep", "Glob", "LS", "ToolSearch", "grep", "list_dir", "file_search":
            return .search
        case "WebSearch", "WebFetch", "web_search":
            return .web
        case "Task", "Agent", "Workflow", "SendMessage":
            return .agent
        case "Skill":
            return .skill
        default:
            return .other
        }
    }

    /// `summarize(3)` → "Ran 3 commands".
    func summarize(_ count: Int) -> String {
        let s = count == 1 ? "" : "s"
        switch self {
        case .command: return "Ran \(count) command\(s)"
        case .read: return "Read \(count) file\(s)"
        case .edit: return "Changed \(count) file\(s)"
        case .search: return "\(count) search\(count == 1 ? "" : "es")"
        case .web: return "\(count) web call\(s)"
        case .agent: return "\(count) sub-agent\(s)"
        case .skill: return "\(count) skill\(s)"
        case .mcp: return "\(count) MCP call\(s)"
        case .other: return "\(count) other tool\(s)"
        }
    }

    var symbol: String {
        switch self {
        case .command: return "terminal"
        case .read: return "doc.text"
        case .edit: return "pencil"
        case .search: return "magnifyingglass"
        case .web: return "globe"
        case .agent: return "person.2"
        case .skill: return "sparkles"
        case .mcp: return "puzzlepiece.extension"
        case .other: return "wrench.adjustable"
        }
    }
}

// MARK: - Activity digest (files touched, commits, sub-agents)

struct SessionFileTouch: Identifiable, Equatable {
    var id: String { path }
    let path: String
    var edits: Int
    var writes: Int
    var reads: Int

    var name: String { URL(fileURLWithPath: path).lastPathComponent }

    var folder: String {
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        return (parent as NSString).abbreviatingWithTildeInPath
    }

    var changed: Bool { edits + writes > 0 }
}

struct SessionCommit: Identifiable, Equatable {
    var id: String { sha }
    let sha: String
    let branch: String?
    let subject: String
}

struct SessionSubagent: Identifiable, Equatable {
    enum State: Equatable { case done, running, background, failed }

    let id: String
    let kind: String
    let summary: String
    let state: State
}

struct SessionActivityDigest: Equatable {
    var files: [SessionFileTouch] = []
    var commits: [SessionCommit] = []
    var subagents: [SessionSubagent] = []
    var commandCount = 0

    static let empty = SessionActivityDigest()

    var changedFiles: [SessionFileTouch] { files.filter(\.changed) }
    var readOnlyFiles: [SessionFileTouch] { files.filter { !$0.changed } }

    static func build(_ turns: [TranscriptTurn]) -> SessionActivityDigest {
        var digest = SessionActivityDigest()
        var files: [String: SessionFileTouch] = [:]
        var order: [String] = []
        var commitShas = Set<String>()

        func touch(_ path: String, edit: Int = 0, write: Int = 0, read: Int = 0) {
            let clean = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard clean.hasPrefix("/") || clean.hasPrefix("~"), !clean.contains("\n") else { return }
            if files[clean] == nil {
                files[clean] = SessionFileTouch(path: clean, edits: 0, writes: 0, reads: 0)
                order.append(clean)
            }
            files[clean]?.edits += edit
            files[clean]?.writes += write
            files[clean]?.reads += read
        }

        for turn in turns {
            for tool in turn.tools {
                let kind = TranscriptToolKind.of(tool.name)
                switch kind {
                case .edit:
                    if tool.name == "apply_patch" || tool.inputPreview.contains("*** ") {
                        for path in patchPaths(tool.inputPreview) { touch(path, edit: 1) }
                    } else if tool.name == "Write" || tool.name == "write_file" || tool.name == "create_file" {
                        touch(tool.inputPreview, write: 1)
                    } else {
                        touch(tool.inputPreview, edit: 1)
                    }
                case .read:
                    touch(tool.inputPreview, read: 1)
                case .command:
                    digest.commandCount += 1
                    if tool.inputPreview.contains("git commit") || tool.inputPreview.contains("git -C"),
                       let result = tool.result {
                        for commit in commits(in: result) where commitShas.insert(commit.sha).inserted {
                            digest.commits.append(commit)
                        }
                    }
                case .agent where tool.name != "SendMessage":
                    let state: SessionSubagent.State
                    if tool.isError {
                        state = .failed
                    } else if let result = tool.result {
                        state = result.contains("Async agent launched") || result.contains("running in the background") ? .background : .done
                    } else {
                        state = .running
                    }
                    let summary = tool.inputPreview.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? tool.name
                    digest.subagents.append(SessionSubagent(id: tool.id, kind: tool.name, summary: summary, state: state))
                default:
                    break
                }
            }
        }

        digest.files = order.compactMap { files[$0] }
        return digest
    }

    /// `*** Update File: path` lines of a Codex patch.
    static func patchPaths(_ patch: String) -> [String] {
        patch.split(separator: "\n").compactMap { line in
            for prefix in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] where line.hasPrefix(prefix) {
                return String(line.dropFirst(prefix.count))
            }
            return nil
        }
    }

    /// `[feat/x 4e7a3bc] subject` lines of `git commit` output.
    static func commits(in output: String) -> [SessionCommit] {
        let ns = output as NSString
        return commitPattern.matches(in: output, range: NSRange(location: 0, length: ns.length)).map { match in
            SessionCommit(
                sha: ns.substring(with: match.range(at: 2)),
                branch: ns.substring(with: match.range(at: 1)),
                subject: ns.substring(with: match.range(at: 3)).trimmingCharacters(in: .whitespaces)
            )
        }
    }

    // swiftlint:disable:next force_try
    private static let commitPattern = try! NSRegularExpression(
        pattern: #"^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$"#,
        options: [.anchorsMatchLines]
    )
}

// MARK: - Liveness

enum SessionLiveness: Equatable {
    case running, idle, ended

    var label: String {
        switch self {
        case .running: return "Running"
        case .idle: return "Idle"
        case .ended: return "Ended"
        }
    }

    /// Running: activity inside the last two minutes, or a tool call still waiting for its result.
    /// Ended: the transcript recorded an end, or the cache is cold and no pane holds the session.
    /// Idle: everything in between.
    static func resolve(
        lastActivity: Date?,
        terminated: String?,
        pendingTool: Bool,
        cacheCold: Bool?,
        inPane: Bool?,
        now: Date = Date()
    ) -> SessionLiveness {
        if let terminated, !terminated.isEmpty { return .ended }
        if pendingTool { return .running }
        if let lastActivity, now.timeIntervalSince(lastActivity) < 120 { return .running }
        if inPane == true { return .idle }
        if cacheCold == false { return .idle }
        return .ended
    }
}

// MARK: - Git branch (file read, no process)

enum SessionGitBranch {
    /// Walks up from `cwd` to the repository, follows a worktree's `.git` file, and reads
    /// `HEAD`. Returns the branch name, or a short sha on a detached head.
    static func read(cwd: String, maxDepth: Int = 12) -> String? {
        var dir = URL(fileURLWithPath: (cwd as NSString).expandingTildeInPath)
        let fm = FileManager.default
        for _ in 0..<maxDepth {
            let dotGit = dir.appendingPathComponent(".git")
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: dotGit.path, isDirectory: &isDir) {
                let gitDir: URL
                if isDir.boolValue {
                    gitDir = dotGit
                } else {
                    guard let pointer = try? String(contentsOf: dotGit, encoding: .utf8),
                          let line = pointer.split(separator: "\n").first(where: { $0.hasPrefix("gitdir:") })
                    else { return nil }
                    let raw = line.dropFirst("gitdir:".count).trimmingCharacters(in: .whitespaces)
                    gitDir = raw.hasPrefix("/") ? URL(fileURLWithPath: raw) : dir.appendingPathComponent(raw)
                }
                guard let head = try? String(contentsOf: gitDir.appendingPathComponent("HEAD"), encoding: .utf8) else { return nil }
                return parseHead(head)
            }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { break }
            dir = parent
        }
        return nil
    }

    static func parseHead(_ head: String) -> String? {
        let line = head.trimmingCharacters(in: .whitespacesAndNewlines)
        if line.hasPrefix("ref: refs/heads/") { return String(line.dropFirst("ref: refs/heads/".count)) }
        if line.hasPrefix("ref: ") { return String(line.dropFirst(5)) }
        return line.isEmpty ? nil : String(line.prefix(8))
    }
}


extension SessionUsage {
    /// One envelope turn's usage. Envelope `inputTokens` is already net of cache reads.
    init(_ usage: TranscriptUsage) {
        self.init(
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            cacheReadTokens: usage.cacheReadTokens ?? 0,
            reasoningTokens: usage.reasoningTokens ?? 0,
            modelCalls: 1
        )
    }

    /// The envelope's session totals. nil when it reports no model call and no cost.
    init?(_ totals: TranscriptTotals?) {
        guard let totals, (totals.modelCalls ?? 0) > 0 || totals.costUsd != nil else { return nil }
        self.init(
            inputTokens: totals.inputTokens ?? 0,
            outputTokens: totals.outputTokens ?? 0,
            cacheReadTokens: totals.cacheReadTokens ?? 0,
            reasoningTokens: totals.reasoningTokens ?? 0,
            modelCalls: totals.modelCalls ?? 0,
            costUsd: totals.costUsd
        )
    }
}
