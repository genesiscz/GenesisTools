//
//  SessionNativeLog.swift
//  Genesis
//
//  Reads the provider's own session file (Claude `~/.claude/projects/**/<id>.jsonl`, Codex
//  rollouts) for what `tools ai sessions tail --json` leaves out:
//
//  - token usage per model call, with cache writes, and the model that made each call. Claude
//    files only: a Codex envelope already carries each turn's usage, and its turn ids are
//    positions the GenesisTools reader assigns, so a Codex line cannot be matched to a turn here;
//  - the full input of every tool call (Write content, Edit old/new strings, patches);
//  - the full, unclipped tool result.
//
//  One pass builds a small index: byte ranges of the lines that hold each tool call and result,
//  plus the usage. Nothing large stays in memory; `detail(for:)` re-reads one line when a row
//  asks for it. Both calls do file I/O and JSON work: run them off the main thread.
//
//  Portable: Foundation only.
//

import Foundation

// MARK: - Usage

public struct SessionUsage: Equatable, Sendable {
    public var inputTokens = 0
    public var outputTokens = 0
    public var cacheReadTokens = 0
    public var cacheWriteTokens = 0
    public var reasoningTokens = 0
    public var modelCalls = 0
    /// Only what the session file or the provider reported. Nothing here derives a price.
    public var costUsd: Double?
    // When the hub fills `costUsd` from `tools ai-spend` (a list-price
    // estimate, the file has none), this says so, and the Cost tile's tooltip shows it.
    public var costNote: String?

    public var isEmpty: Bool {
        modelCalls == 0 && inputTokens == 0 && outputTokens == 0 && cacheReadTokens == 0 && cacheWriteTokens == 0
            && costUsd == nil
    }

    public mutating func add(_ other: SessionUsage) {
        inputTokens += other.inputTokens
        outputTokens += other.outputTokens
        cacheReadTokens += other.cacheReadTokens
        cacheWriteTokens += other.cacheWriteTokens
        reasoningTokens += other.reasoningTokens
        modelCalls += other.modelCalls
        if let cost = other.costUsd {
            costUsd = (costUsd ?? 0) + cost
        }
    }

    /// `in 1.2K · cache 88.4K · out 3.1K · $0.42`, for a prompt header. `in` is fresh input;
    /// `cache` is cache reads plus writes.
    public var compact: String {
        var parts: [String] = []
        if inputTokens > 0 { parts.append("in \(SessionFormat.tokens(inputTokens))") }
        if cacheReadTokens + cacheWriteTokens > 0 {
            parts.append("cache \(SessionFormat.tokens(cacheReadTokens + cacheWriteTokens))")
        }
        if outputTokens > 0 { parts.append("out \(SessionFormat.tokens(outputTokens))") }
        if let costUsd, costUsd > 0 { parts.append(SessionFormat.usd(costUsd)) }
        return parts.joined(separator: " · ")
    }

    /// Every figure, for a tooltip.
    public var detailed: String {
        var parts = [
            "\(modelCalls) model call\(modelCalls == 1 ? "" : "s")",
            "input \(SessionFormat.tokens(inputTokens))",
            "cache read \(SessionFormat.tokens(cacheReadTokens))",
            "cache write \(SessionFormat.tokens(cacheWriteTokens))",
            "output \(SessionFormat.tokens(outputTokens))",
        ]
        if reasoningTokens > 0 { parts.append("reasoning \(SessionFormat.tokens(reasoningTokens))") }
        if let costUsd { parts.append("cost \(SessionFormat.usd(costUsd))") }
        return parts.joined(separator: " · ")
    }

    public init(
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheWriteTokens: Int = 0,
        reasoningTokens: Int = 0,
        modelCalls: Int = 0,
        costUsd: Double? = nil,
        costNote: String? = nil
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.reasoningTokens = reasoningTokens
        self.modelCalls = modelCalls
        self.costUsd = costUsd
        self.costNote = costNote
    }
}

// MARK: - Tool call detail

public struct ToolEditPair: Equatable, Sendable {
    public var old: String
    public var new: String

    public init(old: String, new: String) {
        self.old = old
        self.new = new
    }
}

/// The parts of a tool call's input and result that the transcript envelope does not carry.
public struct ToolCallDetail: Equatable, Sendable {
    public var filePath: String?
    /// Write: the whole file content.
    public var content: String?
    /// Edit / MultiEdit: every replacement, in order.
    public var edits: [ToolEditPair] = []
    /// Codex apply_patch: the patch text.
    public var patch: String?
    public var command: String?
    /// The result as the provider stored it, before any clipping.
    public var fullResult: String?
    // The whole input as indented JSON (keys sorted), for a call whose
    // transcript preview is one field of it: an Agent's prompt, a SendMessage body, a Grep's path and
    // flags. The envelope carries only the preview (Martin, 2026-09-28: "show me the entire input").
    public var arguments: String?

    public init(
        filePath: String? = nil,
        content: String? = nil,
        edits: [ToolEditPair] = [],
        patch: String? = nil,
        command: String? = nil,
        fullResult: String? = nil,
        arguments: String? = nil
    ) {
        self.filePath = filePath
        self.content = content
        self.edits = edits
        self.patch = patch
        self.command = command
        self.fullResult = fullResult
        self.arguments = arguments
    }
}

// MARK: - Summary (per-turn model, per-range usage)

public struct SessionNativeSummary: Equatable, Sendable {
    fileprivate struct Call: Equatable, Sendable {
        let ordinal: Int
        let messageId: String
    }

    /// Short model name per transcript turn id (`opus`, `sonnet`). Claude files only (see the header).
    public var models: [String: String] = [:]
    fileprivate var ordinals: [String: Int] = [:]
    fileprivate var calls: [Call] = []
    fileprivate var usageByMessage: [String: SessionUsage] = [:]
    public var total = SessionUsage()

    public func model(forTurn id: String) -> String? { models[id] }

    /// Usage of every model call from the line `fromTurn` up to, not including, `untilTurn`
    /// (nil: to the end of the file). nil when `fromTurn`, or a given `untilTurn`, is not in the
    /// file: summing to the end would count every later section's calls in this one.
    // An unknown `untilTurn` used to read as the end of the file.
    public func usage(fromTurn: String, untilTurn: String?) -> SessionUsage? {
        guard let start = ordinals[fromTurn] else { return nil }
        let end: Int
        if let untilTurn {
            guard let found = ordinals[untilTurn] else { return nil }
            end = found
        } else {
            end = Int.max
        }
        guard end >= start else { return SessionUsage() }
        func lowerBound(_ ordinal: Int) -> Int {
            var low = 0, high = calls.count
            while low < high {
                let middle = low + (high - low) / 2
                if calls[middle].ordinal < ordinal { low = middle + 1 }
                else { high = middle }
            }
            return low
        }
        var sum = SessionUsage()
        for call in calls[lowerBound(start)..<lowerBound(end)] {
            if let usage = usageByMessage[call.messageId] { sum.add(usage) }
        }
        return sum
    }
}

// MARK: - Log

public final class SessionNativeLog: @unchecked Sendable {
    public let path: String
    private var currentSummary: SessionNativeSummary
    public var summary: SessionNativeSummary {
        appendLock.lock()
        defer { appendLock.unlock() }
        return currentSummary
    }

    /// Call off-main after coalesced tail updates. Only the appended region is indexed.
    public func refreshSummarySnapshot() -> SessionNativeSummary {
        indexAppended()
        return summary
    }
    private let toolUse: [String: Range<Int>]
    private let toolResult: [String: Range<Int>]
    private let lock = NSLock()
    private var cache: [String: ToolCallDetail] = [:]
    private var detailBytes = 0

    public var retainedBytes: Int {
        appendLock.lock()
        let indexBytes = (currentSummary.models.count + currentSummary.ordinals.count + currentSummary.calls.count
            + currentSummary.usageByMessage.count + toolUse.count + toolResult.count
            + appendedUse.count + appendedResult.count) * 256
        let keyBytes = currentSummary.models.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
            + currentSummary.ordinals.keys.reduce(0) { $0 + $1.utf8.count }
            + currentSummary.calls.reduce(0) { $0 + $1.messageId.utf8.count }
            + currentSummary.usageByMessage.keys.reduce(0) { $0 + $1.utf8.count }
            + [toolUse, toolResult, appendedUse, appendedResult].reduce(0) { sum, ranges in
                sum + ranges.keys.reduce(0) { $0 + $1.utf8.count }
            }
        appendLock.unlock()
        lock.lock()
        defer { lock.unlock() }
        return indexBytes + keyBytes + detailBytes
    }
    // A call written after the scan (the hub's live tail appends turns to an
    // open transcript, the scan runs once) is found in the lines written since (`indexAppended`); it
    // used to have no detail at all, so its output stayed clipped. `appendedEnd` is where that index
    // stops: the start of a line not written whole yet, else the file's end. Each whole line past the
    // scan is read once (PR #429 t21: every look used to scan the whole appended part again).
    private let appendLock = NSLock()
    private var appendedEnd: Int
    private var appendedOrdinal: Int
    private var appendedRead = 0
    private var appendedUse: [String: Range<Int>] = [:]
    private var appendedResult: [String: Range<Int>] = [:]

    private init(path: String, summary: SessionNativeSummary, toolUse: [String: Range<Int>], toolResult: [String: Range<Int>], appendedStart: Int, ordinal: Int) {
        self.path = path
        self.currentSummary = summary
        self.appendedOrdinal = ordinal
        self.toolUse = toolUse
        self.toolResult = toolResult
        appendedEnd = appendedStart
    }

    // Bytes read past the scan over this log's life (see `appendedEnd`).
    public var appendedBytesRead: Int {
        appendLock.lock()
        defer { appendLock.unlock() }
        return appendedRead
    }

    public var toolCount: Int { toolUse.count }

    /// One pass over the file. Lines that cannot hold a turn (attachments, snapshots) are skipped by
    /// a byte search before any JSON is parsed. Returns nil when the file cannot be read.
    public static func scan(path: String) -> SessionNativeLog? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped) else { return nil }
        var summary = SessionNativeSummary()
        var toolUse: [String: Range<Int>] = [:]
        var toolResult: [String: Range<Int>] = [:]
        var ordinal = 0
        var completeOrdinal = 0

        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            let count = raw.count
            var start = 0
            while start < count {
                let remaining = count - start
                let newline = memchr(base + start, 0x0A, remaining)
                let end = newline.map { base.distance(to: UnsafeRawPointer($0)) } ?? count
                defer { start = end + 1 }
                guard end > start else { continue }
                let line = UnsafeRawBufferPointer(start: base + start, count: end - start)
                let kind = LineKind.of(line)
                guard kind != .other else { continue }
                guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                ordinal += 1
                if newline != nil { completeOrdinal = ordinal }
                let range = start..<end
                switch kind {
                case .claude:
                    indexClaude(object, range: range, ordinal: ordinal, summary: &summary, toolUse: &toolUse, toolResult: &toolResult)
                case .codex:
                    indexCodex(object, range: range, toolUse: &toolUse, toolResult: &toolResult)
                case .other:
                    break
                }
            }
        }


        // A last line with no newline may still be being written; the index of
        // appended lines reads it again once it is whole.
        let appendedStart = data.last == 0x0A ? data.count : (data.lastIndex(of: 0x0A).map { $0 + 1 } ?? 0)
        return SessionNativeLog(path: path, summary: summary, toolUse: toolUse, toolResult: toolResult, appendedStart: appendedStart, ordinal: completeOrdinal)
    }

    /// The input and full result of one tool call, read from disk on first use and cached.
    public func detail(for toolId: String) -> ToolCallDetail? {
        lock.lock()
        if let cached = cache[toolId] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        // A call the scan did not see, or saw still running, is looked up in
        // the lines written since (`indexAppended`).
        var use = toolUse[toolId]
        var result = toolResult[toolId]
        if use == nil || result == nil {
            indexAppended()
            lock.lock()
            use = use ?? appendedUse[toolId]
            result = result ?? appendedResult[toolId]
            lock.unlock()
        }
        guard use != nil || result != nil else { return nil }
        var detail = ToolCallDetail()
        if let range = use, let object = readLine(range) {
            Self.fillInput(&detail, from: object, toolId: toolId)
        }
        if let range = result, let object = readLine(range) {
            detail.fullResult = Self.resultText(in: object, toolId: toolId)
        }
        // A call still running is read again once its result is written.
        guard result != nil else { return detail }

        lock.lock()
        let bytes = [detail.filePath, detail.content, detail.patch, detail.command, detail.fullResult, detail.arguments]
            .compactMap { $0 }.reduce(0) { $0 + $1.utf8.count }
            + detail.edits.reduce(0) { $0 + $1.old.utf8.count + $1.new.utf8.count }
        if cache.count >= 400 || detailBytes + bytes > 4 * 1024 * 1024 {
            cache.removeAll()
            detailBytes = 0
        }
        if bytes <= 4 * 1024 * 1024 {
            cache[toolId] = detail
            detailBytes += bytes
        }
        lock.unlock()
        return detail
    }

    /// Indexes the whole lines written since the last look, with the scan's own
    /// indexers, and moves `appendedEnd` past them. A last line with no newline is parsed on each look
    /// but never passed: it may still be being written, or its writer ended the file without one.
    private func indexAppended() {
        appendLock.lock()
        defer { appendLock.unlock() }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped), data.count > appendedEnd else { return }
        var summary = currentSummary
        var ordinal = appendedOrdinal
        var uses: [String: Range<Int>] = [:]
        var results: [String: Range<Int>] = [:]
        func index(_ line: UnsafeRawBufferPointer, _ range: Range<Int>) {
            let kind = LineKind.of(line)
            guard kind != .other, let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { return }
            if kind == .claude {
                Self.indexClaude(object, range: range, ordinal: ordinal + 1, summary: &summary, toolUse: &uses, toolResult: &results)
            } else {
                Self.indexCodex(object, range: range, toolUse: &uses, toolResult: &results)
            }
            ordinal += 1
        }
        var end = appendedEnd
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            let count = raw.count
            var start = end
            while start < count, let newline = memchr(base + start, 0x0A, count - start) {
                let lineEnd = base.distance(to: UnsafeRawPointer(newline))
                if lineEnd > start {
                    index(UnsafeRawBufferPointer(start: base + start, count: lineEnd - start), start..<lineEnd)
                }
                start = lineEnd + 1
                end = start
            }
            appendedOrdinal = ordinal
            if start < count {
                index(UnsafeRawBufferPointer(start: base + start, count: count - start), start..<count)
            }
        }
        currentSummary = summary
        appendedRead += end - appendedEnd
        appendedEnd = end
        lock.lock()
        appendedUse.merge(uses) { _, new in new }
        appendedResult.merge(results) { _, new in new }
        lock.unlock()
    }

    // MARK: Scan helpers

    private enum LineKind {
        case claude, codex, other

        static func of(_ line: UnsafeRawBufferPointer) -> LineKind {
            if hasClaudeType(line) { return .claude }
            if contains(line, #""response_item""#) || contains(line, #""item_completed""#) { return .codex }
            return .other
        }

        /// `"type":"assistant"` or `"type":"user"`, with any spaces or tabs around the colon: Claude
        /// Code writes its lines minified, but a JSONL writer may not. Byte work only, no JSON: most
        /// lines of a session file are not turns and must be skipped cheaply.
        // The exact minified spelling used to be required.
        private static func hasClaudeType(_ line: UnsafeRawBufferPointer) -> Bool {
            guard let base = line.baseAddress else { return false }
            let count = line.count
            func skipBlanks(_ index: inout Int) {
                while index < count, line[index] == 0x20 || line[index] == 0x09 { index += 1 }
            }
            func startsWith(_ needle: String, at index: Int) -> Bool {
                var needle = needle
                return needle.withUTF8 { bytes in
                    index + bytes.count <= count && memcmp(base + index, bytes.baseAddress, bytes.count) == 0
                }
            }

            var key = #""type""#
            return key.withUTF8 { keyBytes in
                var from = 0
                while from < count, let hit = memmem(base + from, count - from, keyBytes.baseAddress, keyBytes.count) {
                    let start = base.distance(to: UnsafeRawPointer(hit))
                    var index = start + keyBytes.count
                    skipBlanks(&index)
                    if index < count, line[index] == UInt8(ascii: ":") {
                        index += 1
                        skipBlanks(&index)
                        if startsWith(#""assistant""#, at: index) || startsWith(#""user""#, at: index) { return true }
                    }
                    from = start + 1
                }
                return false
            }
        }

        private static func contains(_ line: UnsafeRawBufferPointer, _ needle: String) -> Bool {
            var needle = needle
            return needle.withUTF8 { bytes in
                memmem(line.baseAddress, line.count, bytes.baseAddress, bytes.count) != nil
            }
        }
    }

    private static func indexClaude(
        _ object: [String: Any],
        range: Range<Int>,
        ordinal: Int,
        summary: inout SessionNativeSummary,
        toolUse: inout [String: Range<Int>],
        toolResult: inout [String: Range<Int>]
    ) {
        let type = object["type"] as? String
        guard let message = object["message"] as? [String: Any] else { return }
        let content = message["content"] as? [[String: Any]] ?? []
        // Tool calls are indexed on every line. A sub-agent file (`subagents/agent-*.jsonl`) is all
        // sidechain lines, so skipping them first left every call of an agent without its input: its
        // Edit and Write rows showed "The file … has been updated successfully" instead of the diff
        // (Martin, 2026-10-01). Usage and models stay the parent's own, as before.
        if type == "assistant" {
            for item in content where item["type"] as? String == "tool_use" {
                if let id = item["id"] as? String { toolUse[id] = range }
            }
        } else if type == "user" {
            for item in content where item["type"] as? String == "tool_result" {
                if let id = item["tool_use_id"] as? String { toolResult[id] = range }
            }
        }
        if object["isSidechain"] as? Bool == true { return }
        let uuid = object["uuid"] as? String
        if let uuid, summary.ordinals[uuid] == nil { summary.ordinals[uuid] = ordinal }

        if type == "assistant" {
            if let uuid, let model = message["model"] as? String { summary.models[uuid] = shortModel(model) }
            if let id = message["id"] as? String {
                let previous = summary.usageByMessage[id]
                var usage = previous ?? SessionUsage(modelCalls: 1)
                if let raw = message["usage"] as? [String: Any] {
                    if raw["input_tokens"] != nil { usage.inputTokens = int(raw["input_tokens"]) }
                    if raw["output_tokens"] != nil { usage.outputTokens = int(raw["output_tokens"]) }
                    if raw["cache_read_input_tokens"] != nil { usage.cacheReadTokens = int(raw["cache_read_input_tokens"]) }
                    if raw["cache_creation_input_tokens"] != nil { usage.cacheWriteTokens = int(raw["cache_creation_input_tokens"]) }
                }
                if let cost = object["costUSD"] as? Double { usage.costUsd = cost }
                if let previous {
                    summary.total.add(SessionUsage(
                        inputTokens: -previous.inputTokens, outputTokens: -previous.outputTokens,
                        cacheReadTokens: -previous.cacheReadTokens, cacheWriteTokens: -previous.cacheWriteTokens,
                        reasoningTokens: -previous.reasoningTokens, modelCalls: -previous.modelCalls,
                        costUsd: previous.costUsd.map { -$0 }
                    ))
                } else {
                    summary.calls.append(.init(ordinal: ordinal, messageId: id))
                }
                summary.usageByMessage[id] = usage
                summary.total.add(usage)
            }
        }
    }

    /// The `item_completed` items the transcript shows as tool rows (src/utils/ai/transcripts/codex.ts `itemTool`).
    private static let codexActionItems: Set<String> = ["CommandExecution", "McpToolCall", "FileChange"]

    private static func indexCodex(_ object: [String: Any], range: Range<Int>, toolUse: inout [String: Range<Int>], toolResult: inout [String: Range<Int>]) {
        guard let payload = object["payload"] as? [String: Any] else { return }
        // A command, patch or MCP call an `exec` script made: one line holds its input and its output,
        // keyed by the item id the transcript row carries.
        if payload["type"] as? String == "item_completed" {
            guard let item = payload["item"] as? [String: Any], let id = item["id"] as? String,
                  codexActionItems.contains(item["type"] as? String ?? "") else { return }
            toolUse[id] = range
            toolResult[id] = range
            return
        }
        guard let id = payload["call_id"] as? String else { return }
        switch payload["type"] as? String {
        case "function_call", "custom_tool_call": toolUse[id] = range
        case "function_call_output", "custom_tool_call_output": toolResult[id] = range
        default: break
        }
    }

    /// `claude-opus-5-5` → `opus`, the same family word the session list uses.
    public static func shortModel(_ model: String) -> String {
        for family in ["fable", "opus", "sonnet", "haiku"] where model.contains(family) { return family }
        return model.hasPrefix("claude-") ? String(model.dropFirst(7)) : model
    }

    private static func int(_ value: Any?) -> Int {
        (value as? NSNumber)?.intValue ?? 0
    }

    // MARK: Detail helpers

    private func readLine(_ range: Range<Int>) -> [String: Any]? {
        guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { try? handle.close() }
        do {
            try handle.seek(toOffset: UInt64(range.lowerBound))
            guard let data = try handle.read(upToCount: range.count) else { return nil }
            return try JSONSerialization.jsonObject(with: data) as? [String: Any]
        } catch {
            return nil
        }
    }

    /// Codex encrypts what its collaboration tools pass between agents (`spawn_agent`, `send_message`): the
    /// `message` argument is a Fernet token, `gAAAAA` and kilobytes of base64. The transcript envelope
    /// shows a marker for it (src/utils/ai/transcripts/codex.ts); the opened call says the same.
    static func withoutEncryptedToken(_ value: Any) -> Any {
        guard let text = value as? String, text.hasPrefix("gAAAAA"), text.count >= 46,
              text.unicodeScalars.allSatisfy({ $0.isASCII && (CharacterSet.alphanumerics.contains($0) || "_-=".unicodeScalars.contains($0)) })
        else { return value }
        return "[encrypted by Codex, \(text.count) chars]"
    }

    private static func fillInput(_ detail: inout ToolCallDetail, from object: [String: Any], toolId: String) {
        var input: [String: Any] = [:]
        if let message = object["message"] as? [String: Any], let content = message["content"] as? [[String: Any]],
           let use = content.first(where: { $0["id"] as? String == toolId }) {
            input = use["input"] as? [String: Any] ?? [:]
        } else if let payload = object["payload"] as? [String: Any], let item = payload["item"] as? [String: Any] {
            switch item["type"] as? String {
            case "CommandExecution": detail.command = codexShellCommand(item["command"])
            case "McpToolCall": input = item["arguments"] as? [String: Any] ?? [:]
            case "FileChange": detail.patch = codexPatchText(item["changes"])
            default: break
            }
        } else if let payload = object["payload"] as? [String: Any] {
            if let arguments = payload["arguments"] as? String,
               let parsed = try? JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String: Any] {
                input = parsed.mapValues(withoutEncryptedToken)
            } else if let raw = payload["input"] as? String {
                detail.patch = raw
            }
        }

        // See `ToolCallDetail.arguments`. One string field is what the
        // preview already shows.
        if input.count > 1 || (input.count == 1 && !(input.values.first is String)), JSONSerialization.isValidJSONObject(input),
           let data = try? JSONSerialization.data(withJSONObject: input, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            detail.arguments = String(decoding: data, as: UTF8.self)
        }
        detail.filePath = (input["file_path"] ?? input["path"] ?? input["notebook_path"]) as? String
        // NotebookEdit writes one cell: its new source shows like a Write.
        detail.content = (input["content"] ?? input["new_source"]) as? String
        detail.command = (input["command"] as? String) ?? (input["cmd"] as? String)
            ?? (input["command"] as? [String])?.joined(separator: " ") ?? detail.command
        if let old = input["old_string"] as? String, let new = input["new_string"] as? String {
            detail.edits = [ToolEditPair(old: old, new: new)]
        } else if let edits = input["edits"] as? [[String: Any]] {
            detail.edits = edits.compactMap { edit in
                guard let old = edit["old_string"] as? String, let new = edit["new_string"] as? String else { return nil }
                return ToolEditPair(old: old, new: new)
            }
        }
        if detail.patch == nil, let patch = input["patch"] as? String ?? input["input"] as? String, patch.contains("*** ") {
            detail.patch = patch
        }
    }

    private static func resultText(in object: [String: Any], toolId: String) -> String? {
        if let message = object["message"] as? [String: Any], let content = message["content"] as? [[String: Any]],
           let block = content.first(where: { $0["tool_use_id"] as? String == toolId }) {
            if let text = block["content"] as? String { return text }
            if let parts = block["content"] as? [[String: Any]] {
                return parts.compactMap { $0["text"] as? String }.joined(separator: "\n")
            }
            return nil
        }
        if let payload = object["payload"] as? [String: Any], let item = payload["item"] as? [String: Any] {
            return codexItemOutput(item)
        }
        if let payload = object["payload"] as? [String: Any] {
            let output = payload["output"] as? String ?? payload["result"] as? String
            // Codex wraps shell output as `{"output": "...", "metadata": {...}}`.
            if let output, let data = output.data(using: .utf8),
               let wrapped = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let inner = wrapped["output"] as? String {
                return inner
            }
            return output
        }
        return nil
    }

    // MARK: Codex items (the same reading as src/utils/ai/transcripts/codex.ts)

    /// `["/bin/zsh", "-lc", "<the command>"]` is the command the agent wrote.
    private static func codexShellCommand(_ value: Any?) -> String? {
        guard let parts = value as? [String] else { return value as? String }
        if parts.count == 3, parts[1] == "-c" || parts[1] == "-lc" { return parts[2] }
        return parts.joined(separator: " ")
    }

    /// A FileChange as apply_patch text, one section per file (sorted: the JSON object has no order here).
    private static func codexPatchText(_ value: Any?) -> String? {
        guard let changes = value as? [String: Any] else { return nil }
        var sections = ["*** Begin Patch"]
        for file in changes.keys.sorted() {
            let change = changes[file] as? [String: Any] ?? [:]
            switch change["type"] as? String {
            case "add":
                sections.append("*** Add File: \(file)")
                sections += (change["content"] as? String ?? "").components(separatedBy: "\n").map { "+\($0)" }
            case "delete":
                sections.append("*** Delete File: \(file)")
            default:
                sections.append("*** Update File: \(file)")
                if let moved = change["move_path"] as? String, !moved.isEmpty { sections.append("*** Move to: \(moved)") }
                sections.append(change["unified_diff"] as? String ?? "")
            }
        }
        sections.append("*** End Patch")
        return sections.joined(separator: "\n")
    }

    private static func codexItemOutput(_ item: [String: Any]) -> String {
        let streams = (item["stdout"] as? String ?? "") + (item["stderr"] as? String ?? "")
        switch item["type"] as? String {
        case "CommandExecution":
            // A command's colours arrive as escape codes; the transcript strips them too.
            let output = (item["aggregated_output"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? streams
            return output.replacingOccurrences(of: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]", with: "", options: .regularExpression)
        case "McpToolCall":
            let parts = ((item["result"] as? [String: Any])?["content"] as? [[String: Any]]) ?? []
            let text = parts.compactMap { $0["text"] as? String }.filter { !$0.isEmpty }.joined(separator: "\n")
            return text.isEmpty ? item["error"] as? String ?? "" : text
        default:
            return streams
        }
    }
}

/// Bounded, process-local reuse. Its synchronous reads belong off the main thread.
public final class SessionNativeLogStore: @unchecked Sendable {
    public static let shared = SessionNativeLogStore()
    private struct Stamp: Equatable {
        let device: UInt64
        let inode: UInt64
        let size: Int
        let modified: Date
    }
    private struct Entry {
        var stamp: Stamp
        var head: Data
        var tail: Data
        let log: SessionNativeLog
        var used: UInt64
    }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    private var clock: UInt64 = 0
    private let byteLimit: Int
    private let countLimit: Int

    public init(byteLimit: Int = 32 * 1024 * 1024, countLimit: Int = 6) {
        self.byteLimit = byteLimit
        self.countLimit = countLimit
    }

    public func load(path: String) -> SessionNativeLog? {
        let path = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        lock.lock()
        defer { lock.unlock() }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let inode = attrs[.systemFileNumber] as? NSNumber,
              let device = attrs[.systemNumber] as? NSNumber,
              let size = attrs[.size] as? NSNumber,
              let modified = attrs[.modificationDate] as? Date,
              let handle = FileHandle(forReadingAtPath: path) else {
            entries.removeValue(forKey: path)
            return nil
        }
        defer { try? handle.close() }
        let stamp = Stamp(device: device.uint64Value, inode: inode.uint64Value, size: size.intValue, modified: modified)
        func checkpoint(_ size: Int) -> (Data, Data)? {
            do {
                try handle.seek(toOffset: 0)
                let head = try handle.read(upToCount: min(size, 256)) ?? Data()
                try handle.seek(toOffset: UInt64(max(0, size - 256)))
                let tail = try handle.read(upToCount: min(size, 256)) ?? Data()
                return (head, tail)
            } catch { return nil }
        }
        clock &+= 1
        if var entry = entries[path] {
            let unchanged = entry.stamp == stamp
            let grew = entry.stamp.device == stamp.device && entry.stamp.inode == stamp.inode && stamp.size > entry.stamp.size
            let previous = grew ? checkpoint(entry.stamp.size) : nil
            if unchanged || (grew && previous?.0 == entry.head && previous?.1 == entry.tail) {
                if grew {
                    _ = entry.log.refreshSummarySnapshot()
                    guard let next = checkpoint(stamp.size) else {
                        entries.removeValue(forKey: path)
                        return nil
                    }
                    entry.head = next.0
                    entry.tail = next.1
                    entry.stamp = stamp
                }
                entry.used = clock
                entries[path] = entry
                trim()
                return entry.log
            }
        }
        guard let log = SessionNativeLog.scan(path: path), let checkpoint = checkpoint(stamp.size) else {
            entries.removeValue(forKey: path)
            return nil
        }
        entries[path] = Entry(stamp: stamp, head: checkpoint.0, tail: checkpoint.1, log: log, used: clock)
        trim()
        return log
    }

    private func trim() {
        while entries.count > countLimit || entries.values.reduce(0, { $0 + $1.log.retainedBytes }) > byteLimit {
            guard let oldest = entries.min(by: { $0.value.used < $1.value.used })?.key else { return }
            entries.removeValue(forKey: oldest)
        }
    }
}
