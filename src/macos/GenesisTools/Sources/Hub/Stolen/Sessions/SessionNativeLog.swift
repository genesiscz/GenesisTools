// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionNativeLog.swift at 2026-09-24T05:05:23+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
//
//  SessionNativeLog.swift
//  Genesis
//
//  Reads the provider's own session file (Claude `~/.claude/projects/**/<id>.jsonl`, Codex
//  rollouts) for what `tools ai sessions tail --json` leaves out:
//
//  - token usage per model call, with cache writes, and the model that made each call;
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

struct SessionUsage: Equatable, Sendable {
    var inputTokens = 0
    var outputTokens = 0
    var cacheReadTokens = 0
    var cacheWriteTokens = 0
    var reasoningTokens = 0
    var modelCalls = 0
    /// Only what the session file or the provider reported. Nothing here derives a price.
    var costUsd: Double?
    // GenesisTools adaptation: when the hub fills `costUsd` from `tools ai-spend` (a list-price
    // estimate, the file has none), this says so, and the Cost tile's tooltip shows it.
    var costNote: String?

    var isEmpty: Bool {
        modelCalls == 0 && inputTokens == 0 && outputTokens == 0 && cacheReadTokens == 0 && cacheWriteTokens == 0
            && costUsd == nil
    }

    mutating func add(_ other: SessionUsage) {
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
    var compact: String {
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
    var detailed: String {
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
}

// MARK: - Tool call detail

struct ToolEditPair: Equatable, Sendable {
    var old: String
    var new: String
}

/// The parts of a tool call's input and result that the transcript envelope does not carry.
struct ToolCallDetail: Equatable, Sendable {
    var filePath: String?
    /// Write: the whole file content.
    var content: String?
    /// Edit / MultiEdit: every replacement, in order.
    var edits: [ToolEditPair] = []
    /// Codex apply_patch: the patch text.
    var patch: String?
    var command: String?
    /// The result as the provider stored it, before any clipping.
    var fullResult: String?
}

// MARK: - Summary (per-turn model, per-range usage)

struct SessionNativeSummary: Equatable, Sendable {
    fileprivate struct Call: Equatable, Sendable {
        let ordinal: Int
        let messageId: String
    }

    /// Short model name per transcript turn id (`opus`, `sonnet`, `gpt-5.5`).
    var models: [String: String] = [:]
    fileprivate var ordinals: [String: Int] = [:]
    fileprivate var calls: [Call] = []
    fileprivate var usageByMessage: [String: SessionUsage] = [:]
    var total = SessionUsage()

    func model(forTurn id: String) -> String? { models[id] }

    /// Usage of every model call from the line `fromTurn` up to, not including, `untilTurn`
    /// (nil: to the end of the file). nil when `fromTurn` is not in the file.
    func usage(fromTurn: String, untilTurn: String?) -> SessionUsage? {
        guard let start = ordinals[fromTurn] else { return nil }
        let end = untilTurn.flatMap { ordinals[$0] } ?? Int.max
        var seen = Set<String>()
        var sum = SessionUsage()
        for call in calls where call.ordinal >= start && call.ordinal < end && seen.insert(call.messageId).inserted {
            if let usage = usageByMessage[call.messageId] { sum.add(usage) }
        }
        return sum
    }
}

// MARK: - Log

final class SessionNativeLog: @unchecked Sendable {
    let path: String
    let summary: SessionNativeSummary
    private let toolUse: [String: Range<Int>]
    private let toolResult: [String: Range<Int>]
    private let lock = NSLock()
    private var cache: [String: ToolCallDetail] = [:]

    private init(path: String, summary: SessionNativeSummary, toolUse: [String: Range<Int>], toolResult: [String: Range<Int>]) {
        self.path = path
        self.summary = summary
        self.toolUse = toolUse
        self.toolResult = toolResult
    }

    var toolCount: Int { toolUse.count }

    /// One pass over the file. Lines that cannot hold a turn (attachments, snapshots) are skipped by
    /// a byte search before any JSON is parsed. Returns nil when the file cannot be read.
    static func scan(path: String) -> SessionNativeLog? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped) else { return nil }
        var summary = SessionNativeSummary()
        var toolUse: [String: Range<Int>] = [:]
        var toolResult: [String: Range<Int>] = [:]
        var ordinal = 0

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

        for call in summary.calls {
            if let usage = summary.usageByMessage[call.messageId] { summary.total.add(usage) }
        }
        return SessionNativeLog(path: path, summary: summary, toolUse: toolUse, toolResult: toolResult)
    }

    /// The input and full result of one tool call, read from disk on first use and cached.
    func detail(for toolId: String) -> ToolCallDetail? {
        lock.lock()
        if let cached = cache[toolId] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        guard toolUse[toolId] != nil || toolResult[toolId] != nil else { return nil }
        var detail = ToolCallDetail()
        if let range = toolUse[toolId], let object = readLine(range) {
            Self.fillInput(&detail, from: object, toolId: toolId)
        }
        if let range = toolResult[toolId], let object = readLine(range) {
            detail.fullResult = Self.resultText(in: object, toolId: toolId)
        }

        lock.lock()
        if cache.count > 400 { cache.removeAll() }
        cache[toolId] = detail
        lock.unlock()
        return detail
    }

    // MARK: Scan helpers

    private enum LineKind {
        case claude, codex, other

        static func of(_ line: UnsafeRawBufferPointer) -> LineKind {
            if contains(line, #""type":"assistant""#) || contains(line, #""type":"user""#) { return .claude }
            if contains(line, #""response_item""#) { return .codex }
            return .other
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
        if object["isSidechain"] as? Bool == true { return }
        let type = object["type"] as? String
        let uuid = object["uuid"] as? String
        if let uuid { summary.ordinals[uuid] = ordinal }
        guard let message = object["message"] as? [String: Any] else { return }
        let content = message["content"] as? [[String: Any]] ?? []

        if type == "assistant" {
            if let uuid, let model = message["model"] as? String { summary.models[uuid] = shortModel(model) }
            if let id = message["id"] as? String, summary.usageByMessage[id] == nil {
                var usage = SessionUsage(modelCalls: 1)
                if let raw = message["usage"] as? [String: Any] {
                    usage.inputTokens = int(raw["input_tokens"])
                    usage.outputTokens = int(raw["output_tokens"])
                    usage.cacheReadTokens = int(raw["cache_read_input_tokens"])
                    usage.cacheWriteTokens = int(raw["cache_creation_input_tokens"])
                }
                if let cost = object["costUSD"] as? Double { usage.costUsd = cost }
                summary.usageByMessage[id] = usage
                summary.calls.append(.init(ordinal: ordinal, messageId: id))
            }
            for item in content where item["type"] as? String == "tool_use" {
                if let id = item["id"] as? String { toolUse[id] = range }
            }
        } else if type == "user" {
            for item in content where item["type"] as? String == "tool_result" {
                if let id = item["tool_use_id"] as? String { toolResult[id] = range }
            }
        }
    }

    private static func indexCodex(_ object: [String: Any], range: Range<Int>, toolUse: inout [String: Range<Int>], toolResult: inout [String: Range<Int>]) {
        guard let payload = object["payload"] as? [String: Any], let id = payload["call_id"] as? String else { return }
        switch payload["type"] as? String {
        case "function_call", "custom_tool_call": toolUse[id] = range
        case "function_call_output", "custom_tool_call_output": toolResult[id] = range
        default: break
        }
    }

    /// `claude-opus-5-5` → `opus`, the same family word the session list uses.
    static func shortModel(_ model: String) -> String {
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

    private static func fillInput(_ detail: inout ToolCallDetail, from object: [String: Any], toolId: String) {
        var input: [String: Any] = [:]
        if let message = object["message"] as? [String: Any], let content = message["content"] as? [[String: Any]],
           let use = content.first(where: { $0["id"] as? String == toolId }) {
            input = use["input"] as? [String: Any] ?? [:]
        } else if let payload = object["payload"] as? [String: Any] {
            if let arguments = payload["arguments"] as? String,
               let parsed = try? JSONSerialization.jsonObject(with: Data(arguments.utf8)) as? [String: Any] {
                input = parsed
            } else if let raw = payload["input"] as? String {
                detail.patch = raw
            }
        }

        detail.filePath = (input["file_path"] ?? input["path"] ?? input["notebook_path"]) as? String
        detail.content = input["content"] as? String
        detail.command = (input["command"] as? String) ?? (input["cmd"] as? String)
            ?? (input["command"] as? [String])?.joined(separator: " ")
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
}
