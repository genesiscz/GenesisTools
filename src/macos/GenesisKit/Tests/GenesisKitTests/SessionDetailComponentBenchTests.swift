import AppKit
import Darwin
import XCTest
@testable import GenesisKit

/// The parts of a session screen's load, timed one at a time on a real transcript: the page fetch and the
/// document build at 150 and at 12 turns, the native scan cold and reused, the tool-change lookups one
/// process per row against one batch, a manual refresh, and the live tail's write-to-batch latency on a
/// scratch copy of the transcript (the real file is only read). Skipped unless `SESSION_DETAILS_BENCH`
/// (an output .jsonl), `SESSION_DETAILS_BENCH_ID` and `SESSION_DETAILS_BENCH_FILE` are set. Prints no
/// transcript content: the JSON line holds counts and times only.
@MainActor
final class SessionDetailComponentBenchTests: XCTestCase {
    private var env: [String: String] { ProcessInfo.processInfo.environment }

    private func setting() throws -> (out: String, id: String, file: String, bridge: ToolsBridge) {
        guard let out = env["SESSION_DETAILS_BENCH"], let id = env["SESSION_DETAILS_BENCH_ID"], let file = env["SESSION_DETAILS_BENCH_FILE"] else {
            throw XCTSkip("set SESSION_DETAILS_BENCH, SESSION_DETAILS_BENCH_ID and SESSION_DETAILS_BENCH_FILE")
        }
        let tools = env["SESSION_DETAILS_BENCH_TOOLS"] ?? "\(NSHomeDirectory())/Tresors/Projects/GenesisTools/tools"
        return (out, id, file, ToolsBridge(binaryPath: tools))
    }

    private static func ms(since start: CFAbsoluteTime) -> Double {
        (CFAbsoluteTimeGetCurrent() - start) * 1000
    }

    private static func childCpuMs() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_CHILDREN, &usage)
        func ms(_ t: timeval) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_usec) / 1000 }
        return ms(usage.ru_utime) + ms(usage.ru_stime)
    }

    func testLoadParts() async throws {
        let (out, id, file, bridge) = try setting()
        var values: [String: Double] = [:]
        for limit in [150, 12] {
            var start = CFAbsoluteTimeGetCurrent()
            let envelope = try await SessionTranscriptClient.fetch(using: bridge, sessionId: id, limit: limit)
            values["fetch\(limit)Ms"] = Self.ms(since: start)
            start = CFAbsoluteTimeGetCurrent()
            let document = await Task.detached { TranscriptDocument.build(envelope.turns, turnOffset: envelope.windowStart) }.value
            values["build\(limit)Ms"] = Self.ms(since: start)
            values["rows\(limit)"] = Double(document.sections.reduce(0) { $0 + $1.rows.count })
        }
        var start = CFAbsoluteTimeGetCurrent()
        _ = await Task.detached { SessionNativeLog.scan(path: file) }.value
        values["nativeScanMs"] = Self.ms(since: start)
        let store = SessionNativeLogStore()
        _ = await Task.detached { store.load(path: file) }.value
        start = CFAbsoluteTimeGetCurrent()
        _ = await Task.detached { store.load(path: file) }.value
        values["nativeStoreReuseMs"] = Self.ms(since: start)

        // A manual refresh of a 150-turn window (Genesis before the live tail): refetch to the end, rebuild.
        let window = try await SessionTranscriptClient.fetch(using: bridge, sessionId: id, limit: 150)
        start = CFAbsoluteTimeGetCurrent()
        let refreshed = try await TranscriptPaging.fetchWindow(
            using: bridge, sessionId: id, offset: window.windowStart,
            limit: TranscriptPaging.refreshLimit(loaded: window.turns.count), throughEnd: true
        )
        values["refreshFetchMs"] = Self.ms(since: start)
        start = CFAbsoluteTimeGetCurrent()
        _ = await Task.detached { TranscriptDocument.build(refreshed.turns, turnOffset: refreshed.windowStart) }.value
        values["refreshBuildMs"] = Self.ms(since: start)
        try Self.append(values, counts: [:], kind: "load", id: id, to: out)
    }

    /// The tool calls of the latest 40 turns that a row would ask about, looked up all at once (rows
    /// appear together) through both sources, in the order `SESSION_DETAILS_BENCH_ORDER` names.
    func testToolChangeSources() async throws {
        let (out, id, _, bridge) = try setting()
        let envelope = try await SessionTranscriptClient.fetch(using: bridge, sessionId: id, limit: 40)
        let edits: Set<String> = ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "ApplyPatch"]
        let ids = envelope.turns.flatMap(\.tools).filter { tool in
            edits.contains(tool.name) || (tool.name == "Bash" && ToolChangeHeuristics.mayEditFiles(tool.inputPreview))
        }.map(\.id)
        var values: [String: Double] = [:]
        var counts: [String: Int] = ["calls": ids.count]
        guard !ids.isEmpty else {
            try Self.append(values, counts: counts, kind: "toolChanges", id: id, to: out)
            return
        }
        RenderProbe.enabled = true
        let order = (env["SESSION_DETAILS_BENCH_ORDER"] ?? "perRow,batched").split(separator: ",").map(String.init)
        for arm in order {
            let source: ToolChangeSource = arm == "batched"
                ? BatchedToolChangeSource(toolsBinary: bridge.binaryPath)
                : CLIToolChangeSource(toolsBinary: bridge.binaryPath)
            _ = RenderProbe.take()
            let cpu0 = Self.childCpuMs()
            let start = CFAbsoluteTimeGetCurrent()
            let files = await withTaskGroup(of: Int.self) { group in
                for tool in ids {
                    group.addTask { await source.changes(sessionId: envelope.sessionId, toolUseId: tool).count }
                }
                return await group.reduce(0, +)
            }
            values["\(arm)WallMs"] = Self.ms(since: start)
            values["\(arm)ChildCpuMs"] = Self.childCpuMs() - cpu0
            let probes = RenderProbe.take()
            counts["\(arm)ToolsProcesses"] = probes["toolChanges.process.tools"] ?? 0
            counts["\(arm)GitProcesses"] = probes["toolChanges.process.git"] ?? 0
            counts["\(arm)Files"] = files
        }
        try Self.append(values, counts: counts, kind: "toolChanges", id: id, to: out)
    }

    /// The live tail on a synthetic Claude transcript of `SESSION_DETAILS_BENCH_SYNTH_MB` (default 8) in
    /// `SESSION_DETAILS_BENCH_SCRATCH`: invented text only, no real transcript is copied. Then 40 lines, one
    /// every 400 ms, a prompt and a reply in turn. Latency: a write to the next batch the follow delivers.
    func testLiveTailLatency() async throws {
        guard let out = env["SESSION_DETAILS_BENCH"], let scratch = env["SESSION_DETAILS_BENCH_SCRATCH"] else {
            throw XCTSkip("set SESSION_DETAILS_BENCH and SESSION_DETAILS_BENCH_SCRATCH")
        }
        let tools = env["SESSION_DETAILS_BENCH_TOOLS"] ?? "\(NSHomeDirectory())/Tresors/Projects/GenesisTools/tools"
        let bridge = ToolsBridge(binaryPath: tools)
        let megabytes = Double(env["SESSION_DETAILS_BENCH_SYNTH_MB"] ?? "") ?? 8
        let sessionId = UUID().uuidString.lowercased()
        try FileManager.default.createDirectory(atPath: scratch, withIntermediateDirectories: true)
        let path = (scratch as NSString).appendingPathComponent("\(sessionId).jsonl")
        var parent = UUID().uuidString.lowercased()
        var turn = 0
        func line(user: Bool) -> String {
            turn += 1
            let uuid = UUID().uuidString.lowercased()
            defer { parent = uuid }
            let stamp = ISO8601DateFormatter().string(from: Date())
            let filler = String(repeating: "lorem ipsum dolor sit amet ", count: user ? 4 : 60)
            let message: [String: Any] = user
                ? ["role": "user", "content": "synthetic prompt \(turn) \(filler)"]
                : ["role": "assistant", "id": "msg_\(uuid.prefix(12))", "model": "bench-model", "type": "message",
                   "content": [["type": "text", "text": "synthetic reply \(turn) \(filler)"]],
                   "usage": ["input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0]]
            let object: [String: Any] = [
                "type": user ? "user" : "assistant", "uuid": uuid, "parentUuid": parent, "sessionId": sessionId,
                "timestamp": stamp, "cwd": scratch, "isSidechain": false, "userType": "external", "version": "bench",
                "message": message,
            ]
            let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
        var body = ""
        while Double(body.utf8.count) < megabytes * 1_048_576 {
            body += line(user: true) + "\n" + line(user: false) + "\n"
        }
        try body.write(toFile: path, atomically: true, encoding: .utf8)

        // The follow starts two turns before the end, as a screen's follow starts at its last turn.
        let probe = try await bridge.run(
            subcommand: "ai", args: ["sessions", "tail", path, "--provider", "claude", "--json", "--limit", "1"], timeoutSeconds: 60
        )
        let turnCount = (try? SessionTranscriptClient.decode(Data(probe.stdout.utf8)))?.turnCount ?? 0
        var batches: [CFAbsoluteTime] = []
        var turnsSeen = 0
        let start = CFAbsoluteTimeGetCurrent()
        let tail = TranscriptLiveTail(query: path, offset: max(0, turnCount - 2), provider: "claude", bridge: bridge, log: { _ in }) { batch in
            batches.append(CFAbsoluteTimeGetCurrent())
            turnsSeen += batch.turns.count
        }
        defer { tail.stop() }
        while batches.isEmpty, CFAbsoluteTimeGetCurrent() - start < 20 {
            try await Task.sleep(for: .milliseconds(20))
        }
        var values: [String: Double] = ["firstBatchMs": batches.first.map { ($0 - start) * 1000 } ?? -1, "fileMB": megabytes, "turnCount": Double(turnCount)]
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        defer { try? handle.close() }
        try handle.seekToEnd()
        var latencies: [Double] = []
        var silent = 0
        let writes = 40
        for index in 0..<writes {
            let before = batches.count
            let written = CFAbsoluteTimeGetCurrent()
            try handle.write(contentsOf: Data((line(user: index % 2 == 0) + "\n").utf8))
            while batches.count == before, CFAbsoluteTimeGetCurrent() - written < 0.4 {
                try await Task.sleep(for: .milliseconds(2))
            }
            if batches.count > before {
                latencies.append((batches[before] - written) * 1000)
                let left = 400 - (CFAbsoluteTimeGetCurrent() - written) * 1000
                if left > 0 { try await Task.sleep(for: .milliseconds(Int(left))) }
            } else {
                silent += 1
            }
        }
        let sorted = latencies.sorted()
        if !sorted.isEmpty {
            values["appendP50Ms"] = sorted[sorted.count / 2]
            values["appendP95Ms"] = sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]
            values["appendMinMs"] = sorted.first ?? 0
            values["appendMaxMs"] = sorted.last ?? 0
        }
        try Self.append(values, counts: ["writes": writes, "batched": latencies.count, "silent": silent, "turnsSeen": turnsSeen], kind: "tail", id: sessionId, to: out)
    }

    private static func append(_ values: [String: Double], counts: [String: Int], kind: String, id: String, to path: String) throws {
        var load = [Double](repeating: 0, count: 1)
        getloadavg(&load, 1)
        var object: [String: Any] = [
            "kind": kind,
            "session": String(id.prefix(8)),
            "at": ISO8601DateFormatter().string(from: Date()),
            "load1": (load[0] * 10).rounded() / 10,
        ]
        for (key, value) in values { object[key] = (value * 10).rounded() / 10 }
        for (key, value) in counts { object[key] = value }
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data + Data("\n".utf8))
    }
}
