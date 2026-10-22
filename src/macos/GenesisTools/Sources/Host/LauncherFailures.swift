// The launcher's half of the CLI failures log (src/utils/cli/failures/). A tool that the default SIGINT or SIGTERM
// action kills never reaches its own failure watcher. When `tools` exec'd into this launcher (the default path), the
// launcher is the only parent left that sees the death, so it writes the record, in the same day file and the same
// JSONL shape as `appendFailure` in src/utils/cli/failures/record.ts. LauncherFailuresTests reads the TypeScript
// sources and fails when the file name, the field names or the signal table drift apart.

import Darwin
import Foundation

enum LauncherFailures {
    /// src/utils/cli/failures/run-id.ts `RUN_ID_ENV`: the run's id; a record that carries it is never written twice.
    static let runIdVariable = "GENESIS_TOOLS_RUN_ID"
    /// run-id.ts `RUN_TOOL_ENV`: set by `tools` only on a tool run it hands to this launcher; nothing else is recorded.
    static let toolVariable = "GENESIS_TOOLS_RUN_TOOL"
    /// run-id.ts `RUN_ROOT_ENV`: the GenesisTools checkout that runs the tool (the record's `toolsRoot`).
    static let rootVariable = "GENESIS_TOOLS_RUN_ROOT"
    static let traceVariable = "GENESIS_TOOLS_TRACE_ID"
    static let homeVariable = "GENESIS_TOOLS_HOME"

    /// src/utils/cli/failures/launcher.ts `CRASH_SIGNALS` and `INTERRUPT_SIGNALS`: a fault the process raised on
    /// itself is a crash; a signal sent from outside (SIGKILL included, most often a timeout's escalation) is an
    /// interrupt; anything else (SIGPIPE from `tools x | head`) is a normal end.
    static let crashSignals: [Int32: String] = [
        SIGSEGV: "SIGSEGV", SIGBUS: "SIGBUS", SIGILL: "SIGILL", SIGFPE: "SIGFPE", SIGABRT: "SIGABRT", SIGTRAP: "SIGTRAP",
    ]
    static let interruptSignals: [Int32: String] = [
        SIGINT: "SIGINT", SIGTERM: "SIGTERM", SIGHUP: "SIGHUP", SIGQUIT: "SIGQUIT", SIGKILL: "SIGKILL",
    ]

    /// One tool run this launcher waits for.
    struct Run {
        let tool: String
        let toolsRoot: String
        let runId: String
        var startedAt = Date()
        var childPid: pid_t = 0
    }

    /// The tool run `environment` describes, or nil for any other program. The tool and root markers are removed, so
    /// a program the tool starts under another launcher is not taken for a tool run. The run id stays for the tool's
    /// own watcher, and is made here when the caller set none (the exec path: `tools` is gone by now).
    static func prepare(_ environment: inout [String: String], pid: pid_t = getpid(), now: Date = Date()) -> Run? {
        let tool = environment.removeValue(forKey: toolVariable)?.trimmingCharacters(in: .whitespaces) ?? ""
        let root = environment.removeValue(forKey: rootVariable) ?? ""
        guard !tool.isEmpty else { return nil }
        let given = environment[runIdVariable]?.trimmingCharacters(in: .whitespaces) ?? ""
        let runId = given.isEmpty ? "\(pid)-\(base36(now))" : given
        environment[runIdVariable] = runId
        return Run(tool: tool, toolsRoot: root, runId: runId, startedAt: now)
    }

    /// launcher.ts `signalEnd` for a signal death: the record's kind and the signal's name, or nil for no failure.
    static func kind(of signal: Int32) -> (kind: String, name: String)? {
        if let name = crashSignals[signal] { return ("crash", name) }
        if let name = interruptSignals[signal] { return ("interrupt", name) }
        return nil
    }

    /// record.ts `failuresDir()`: storage/root.ts `genesisToolsDir("logs")`, under GENESIS_TOOLS_HOME when it is set.
    static func failuresDirectory(environment: [String: String]) -> URL {
        let override = environment[homeVariable]?.trimmingCharacters(in: .whitespaces) ?? ""
        let home = override.isEmpty ? NSHomeDirectory() : override
        return URL(fileURLWithPath: home).appendingPathComponent(".genesis-tools").appendingPathComponent("logs")
    }

    /// record.ts `failureLogPath(day)`: `<dir>/<YYYY-MM-DD>-failures.jsonl`, the day in local time (date.ts
    /// `formatLocalDate`).
    static func failureLogURL(day: String, directory: URL) -> URL {
        directory.appendingPathComponent("\(day)-failures.jsonl")
    }

    static func localDay(_ date: Date) -> String {
        let parts = Calendar(identifier: .gregorian).dateComponents(in: TimeZone.current, from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    static func base36(_ date: Date) -> String {
        String(Int64((date.timeIntervalSince1970 * 1000).rounded(.down)), radix: 36)
    }

    /// launcher.ts `childRecorded`: whether a record of this run is already in a day file it could be in.
    static func recorded(runId: String, since: Date, now: Date, directory: URL) -> Bool {
        var day = since
        let last = localDay(now)
        while localDay(day) <= last {
            let url = failureLogURL(day: localDay(day), directory: directory)
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                for line in text.split(separator: "\n") {
                    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
                    else { continue }
                    if object["runId"] as? String == runId { return true }
                }
            }
            guard let next = Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: day) else { break }
            day = next
        }
        return false
    }

    /// The record `appendFailure` would write for this signal death (record.ts `ToolFailure`, v 1).
    static func record(run: Run, name: String, kind: String, signal: Int32, now: Date, launcherPid: pid_t,
                       cwd: String, environment: [String: String]) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let trace = environment[traceVariable]?.trimmingCharacters(in: .whitespaces) ?? ""
        return [
            "v": 1,
            "id": "\(base36(now))-\(launcherPid)",
            "at": formatter.string(from: now),
            "kind": kind,
            "tool": run.tool,
            "command": NSNull(),
            "argv": ["[withheld]"],
            "exitCode": 128 + Int(signal),
            "message": "ended by \(name)",
            "errorName": NSNull(),
            "stack": NSNull(),
            "stderrTail": NSNull(),
            "fatal": true,
            "durationMs": Int((now.timeIntervalSince(run.startedAt) * 1000).rounded()),
            "pid": Int(run.childPid),
            "ppid": Int(launcherPid),
            "cwd": cwd,
            "traceId": trace.isEmpty ? NSNull() : trace,
            "toolsRoot": run.toolsRoot,
            // The agent, session and model come from the agent runtime in TypeScript; the launcher cannot know them.
            "caller": NSNull(),
            "runId": run.runId,
        ]
    }

    /// Writes the record of a signal death once: nothing for a normal end, or when the tool (it handled the signal,
    /// wrote its own record and re-raised it) or the spawning `tools` wrapper already recorded this run id.
    /// Returns the record it wrote.
    @discardableResult
    static func recordSignalDeath(run: Run, signal: Int32, now: Date = Date(), launcherPid: pid_t = getpid(),
                                  cwd: String = FileManager.default.currentDirectoryPath,
                                  environment: [String: String] = ProcessInfo.processInfo.environment,
                                  directory: URL? = nil) -> [String: Any]? {
        guard let (kind, name) = kind(of: signal) else { return nil }
        let directory = directory ?? failuresDirectory(environment: environment)
        guard !recorded(runId: run.runId, since: run.startedAt, now: now, directory: directory) else { return nil }
        let record = record(run: run, name: name, kind: kind, signal: signal, now: now, launcherPid: launcherPid,
                            cwd: cwd, environment: environment)
        guard var data = try? JSONSerialization.data(withJSONObject: record, options: [.withoutEscapingSlashes])
        else { return nil }
        data.append(0x0A)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            warn("failures: cannot create \(directory.path): \(error.localizedDescription)")
            return nil
        }
        // One write with O_APPEND, like appendFileSync: concurrent writers never interleave a record.
        let path = failureLogURL(day: localDay(now), directory: directory).path
        let fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard fd >= 0 else {
            warn("failures: cannot open \(path): \(String(cString: strerror(errno)))")
            return nil
        }
        defer { close(fd) }
        let written = data.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        return written == data.count ? record : nil
    }
}
