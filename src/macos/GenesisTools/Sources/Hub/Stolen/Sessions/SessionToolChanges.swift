// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionToolChanges.swift at 2026-09-24T05:05:23+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
//
//  SessionToolChanges.swift
//  Genesis
//
//  Files a tool call changed that its own input does not show: a Bash call that edited through
//  sed, python or fable-replace. The data comes from GenesisTools' change log:
//
//      tools agents changes <session> --tool <toolUseId> --json
//      → { "files": [ { "path", "status", "unifiedDiff", "beforeBlob", "afterBlob" } ],
//          "objects": "<bare git dir holding the blobs>" }
//
//  (handoff h_p38uwgeo). Older builds of the command reject `--tool`; that, a missing binary, a
//  timeout or unreadable output all read as "no recorded change" and the row shows nothing.
//  More context comes from `git --git-dir <objects> diff -U<n> <before> <after>`.
//
//  Portable: Foundation only. Hosts pass their own `ToolChangeSource` or use the CLI one.
//

import Foundation

struct ToolFileChange: Equatable, Sendable, Identifiable {
    var id: String { path }
    var path: String
    /// `modified`, `added`, `deleted`, or whatever the log says.
    var status: String
    var unifiedDiff: String?
    var beforeBlob: String?
    var afterBlob: String?

    /// `+` and `-` lines of the diff, file headers excluded.
    var counts: (additions: Int, deletions: Int) {
        guard let unifiedDiff else { return (0, 0) }
        var additions = 0
        var deletions = 0
        for line in unifiedDiff.split(separator: "\n") {
            if line.hasPrefix("+++") || line.hasPrefix("---") { continue }
            if line.hasPrefix("+") { additions += 1 } else if line.hasPrefix("-") { deletions += 1 }
        }
        return (additions, deletions)
    }

    /// New-side line of the first hunk, for "open the diff at this line".
    var firstLine: Int? {
        guard let header = unifiedDiff?.split(separator: "\n").first(where: { $0.hasPrefix("@@") }) else { return nil }
        guard let part = header.split(separator: " ").first(where: { $0.hasPrefix("+") }) else { return nil }
        return Int(part.dropFirst().split(separator: ",").first ?? "")
    }
}

protocol ToolChangeSource: Sendable {
    /// Files the tool call changed, with a diff each. [] when nothing was recorded or the source is
    /// not available.
    func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange]
    /// The same file's diff with `context` lines around each hunk. nil when it cannot be made.
    func expandedDiff(for change: ToolFileChange, context: Int) async -> String?
}

/// Does a shell command look like it writes files? Only those rows ask the change source, so a
/// session of 300 `rg` calls starts no processes. A miss here hides a change; a false hit costs
/// one short lookup.
enum ToolChangeHeuristics {
    private static let markers = [
        "sed -i", "perl -i", "perl -pi", "awk -i", "ruby -i", "python", "fable-replace", "fable replace", "fable_replace",
        "apply_patch", "git apply", "git checkout --", "git restore", " patch ", " > ", ">>", " tee ", " mv ", " cp ",
        " truncate ", " rm ", "git mv", "git rm", "ln -s", "prettier --write", "biome check --write", "biome format --write",
        "swift-format", "gofmt -w", "--fix",
    ]

    static func mayEditFiles(_ command: String) -> Bool {
        // A leading space so a command that starts with `mv ` matches the ` mv ` marker.
        let lower = " " + command.lowercased().replacingOccurrences(of: "\n", with: " ")
        return markers.contains { lower.contains($0) }
    }
}

final class CLIToolChangeSource: ToolChangeSource, @unchecked Sendable {
    private let binary: String?
    private let objectsDir: String
    private let timeout: TimeInterval
    private let lock = NSLock()
    private var cache: [String: [ToolFileChange]] = [:]

    /// `toolsBinary`: the `tools` executable; nil looks on PATH and in the usual install places.
    init(
        toolsBinary: String? = nil,
        objectsDir: String = (NSHomeDirectory() as NSString).appendingPathComponent(".genesis-tools/agents/_objects"),
        timeout: TimeInterval = 10
    ) {
        self.binary = toolsBinary ?? Self.findTools()
        self.objectsDir = objectsDir
        self.timeout = timeout
    }

    func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange] {
        let key = "\(sessionId)|\(toolUseId)"
        lock.lock()
        if let cached = cache[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()

        guard let binary else { return [] }
        let output = await Self.run(binary, ["agents", "changes", sessionId, "--tool", toolUseId, "--json"], timeout: timeout)
        var files = output.map(Self.decode) ?? []
        for index in files.indices where files[index].unifiedDiff == nil {
            files[index].unifiedDiff = await expandedDiff(for: files[index], context: 3)
        }

        lock.lock()
        cache[key] = files
        lock.unlock()
        return files
    }

    func expandedDiff(for change: ToolFileChange, context: Int) async -> String? {
        let git = "/usr/bin/git"
        switch (change.beforeBlob, change.afterBlob) {
        case let (before?, after?):
            return await Self.run(git, ["--git-dir", objectsDir, "diff", "-U\(context)", before, after], timeout: timeout)
        case let (nil, after?):
            guard let text = await Self.run(git, ["--git-dir", objectsDir, "cat-file", "-p", after], timeout: timeout) else { return nil }
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            return "@@ -0,0 +1,\(lines.count) @@\n" + lines.map { "+\($0)" }.joined(separator: "\n")
        case let (before?, nil):
            guard let text = await Self.run(git, ["--git-dir", objectsDir, "cat-file", "-p", before], timeout: timeout) else { return nil }
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            return "@@ -1,\(lines.count) +0,0 @@\n" + lines.map { "-\($0)" }.joined(separator: "\n")
        default:
            return nil
        }
    }

    // MARK: Decoding

    /// Tolerant of both spellings the change log has used (`beforeOid` / `beforeBlob`,
    /// `diff` / `unifiedDiff`).
    static func decode(_ text: String) -> [ToolFileChange] {
        guard let start = text.firstIndex(of: "{"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[start...].utf8)) as? [String: Any],
              let files = object["files"] as? [[String: Any]]
        else { return [] }
        return files.compactMap { file in
            guard let path = file["path"] as? String else { return nil }
            let before = (file["beforeBlob"] ?? file["beforeOid"]) as? String
            let after = (file["afterBlob"] ?? file["afterOid"]) as? String
            let status = file["status"] as? String ?? (before == nil ? "added" : after == nil ? "deleted" : "modified")
            return ToolFileChange(
                path: path,
                status: status,
                unifiedDiff: (file["unifiedDiff"] ?? file["diff"]) as? String,
                beforeBlob: before,
                afterBlob: after
            )
        }
    }

    // MARK: Process

    private static func findTools() -> String? {
        let fm = FileManager.default
        let home = NSHomeDirectory()
        var candidates = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map { "\($0)/tools" }
        candidates += ["\(home)/.bun/bin/tools", "\(home)/.local/bin/tools", "\(home)/Tresors/Projects/GenesisTools/tools", "/usr/local/bin/tools"]
        return candidates.first { fm.isExecutableFile(atPath: $0) }
    }

    /// stdout of a finished, successful run; nil on launch failure, non-zero exit or timeout.
    static func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) async -> String? {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = arguments
            let stdout = Pipe()
            process.standardOutput = stdout
            process.standardError = FileHandle.nullDevice
            let lock = NSLock()
            var resumed = false
            func finish(_ value: String?) {
                lock.lock()
                defer { lock.unlock() }
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: value)
            }
            do {
                try process.run()
            } catch {
                finish(nil)
                return
            }
            DispatchQueue.global(qos: .utility).async {
                let collected = stdout.fileHandleForReading.readDataToEndOfFile()
                process.waitUntilExit()
                finish(process.terminationStatus == 0 ? String(decoding: collected, as: UTF8.self) : nil)
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                if process.isRunning { process.terminate() }
                finish(nil)
            }
        }
    }
}
