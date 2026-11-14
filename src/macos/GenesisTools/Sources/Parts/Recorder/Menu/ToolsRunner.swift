import Foundation

/// Starts a `tools` command that outlives the click: a recording owns its process and socket, so the menu only
/// launches it and watches the live folder. Its output goes to `~/.genesis-tools/logs/recorder-start.log`, which a
/// failed start names.
enum ToolsRunner {
    /// A command that exited non-zero soon after it started: its exit status, this run's output, and where that
    /// output sits in the shared log (the file and the 1-based line it starts at).
    struct EarlyFailure {
        let argv: [String]
        let status: Int32
        let output: String
        let logFile: String
        let logLine: Int?

        /// The command as a person would type it.
        var command: String { (["tools"] + argv).joined(separator: " ") }
    }

    /// `onEarlyFailure` runs on the main thread when the command exits non-zero within `earlyWindow` seconds (a
    /// refused flag, a missing grant), with the end of the log, so a start that never began does not stay silent.
    static func detached(
        _ argv: [String],
        earlyWindow: TimeInterval = 15,
        onEarlyFailure: ((Int32, String) -> Void)? = nil
    ) throws {
        try detachedRun(argv, earlyWindow: earlyWindow, onFailure: onEarlyFailure.map { report in { report($0.status, $0.output) } })
    }

    /// `detached` with everything the failure notice names: the command, its exit, this run's output and its place in
    /// the log file.
    static func detachedRun(
        _ argv: [String],
        earlyWindow: TimeInterval = 15,
        onFailure: ((EarlyFailure) -> Void)? = nil
    ) throws {
        let binary = ToolsBridge.defaultBinaryPath()
        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: argv)
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory
        process.environment = ToolsBridge.scrubbedEnvironment()
        let log = URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/logs/recorder-start.log")
        try? FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: log)
        handle.seekToEndOfFile()
        handle.write(Data("\(Date()) tools \(argv.joined(separator: " "))\n".utf8))
        // This run's output starts here: the log holds every earlier run too, whose lines named nothing about this one.
        let start = handle.offsetInFile
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice
        let started = Date()
        process.terminationHandler = { finished in
            let status = finished.terminationStatus
            guard status != 0 else { return }
            HubPerf.log("recorder: tools \(argv.joined(separator: " ")) exited \(status); see \(log.path)")
            guard let onFailure, Date().timeIntervalSince(started) < earlyWindow else { return }
            let failure = EarlyFailure(argv: argv, status: status, output: Self.output(of: log, from: start), logFile: log.path,
                                       logLine: Self.line(of: log, at: start))
            DispatchQueue.main.async { onFailure(failure) }
        }
        try process.run()
    }

    /// The 1-based line of `log` that starts at byte `offset`. The log keeps every earlier run and is never rotated, so
    /// it is counted `chunk` bytes at a time: memory stays bounded however long the history grows.
    static func line(of log: URL, at offset: UInt64, chunk: Int = 64 * 1024) -> Int? {
        guard let reader = try? FileHandle(forReadingFrom: log) else { return nil }
        defer { try? reader.close() }
        var line = 1
        var remaining = offset
        while remaining > 0 {
            let data: Data?
            do {
                data = try reader.read(upToCount: Int(min(UInt64(chunk), remaining)))
            } catch {
                return nil
            }
            guard let data, !data.isEmpty else { break }
            line += data.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 }
            remaining -= UInt64(data.count)
        }
        return line
    }

    /// One run's output in the shared log, from its offset, at most the last 120 lines.
    private static func output(of log: URL, from offset: UInt64) -> String {
        guard let reader = try? FileHandle(forReadingFrom: log) else { return "" }
        defer { try? reader.close() }
        try? reader.seek(toOffset: offset)
        let text = String(decoding: (try? reader.readToEnd()) ?? Data(), as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(120).joined(separator: "\n")
    }

    /// The line of a failed command's output that names the problem. Commander prints `error: …` and then its whole
    /// help, whose last lines name nothing (a note once showed six lines of `tools recorder` help, review 2026-11-06):
    /// that `error:` line, else a note that it printed its usage, else the last line. Nil for no output.
    /// Only lines at column 0 count: an indented `    error: {` is a field of a log entry, and it once made the
    /// note's title end in "{" (2026-11-09).
    nonisolated static func problem(in output: String) -> String? {
        let lines = output.split(separator: "\n").filter { $0.first.map { !$0.isWhitespace } ?? false }
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if let error = lines.first(where: { $0.lowercased().hasPrefix("error:") }) {
            return error.dropFirst("error:".count).trimmingCharacters(in: .whitespaces)
        }
        if lines.contains(where: { $0.hasPrefix("Usage:") }) { return "it printed its usage instead of running" }
        return lines.last
    }
}

extension ToolsRunner {
    /// Runs a short `tools` command with its output captured, and calls `done` on the main thread with the exit
    /// status, stdout and stderr. For a step the window waits on (an edit op that needs ffmpeg), not a recording.
    static let defaultTimeout: TimeInterval = 600

    static func run(_ argv: [String], timeout: TimeInterval = defaultTimeout, done: @escaping @MainActor (Int32, String, String) -> Void) {
        Task {
            do {
                let result = try await ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath()).run(subcommand: argv.first ?? "", args: Array(argv.dropFirst()),
                                                       timeoutSeconds: max(1, Int(timeout)))
                await done(result.exitCode, result.stdout, result.stderr)
            } catch {
                await done(-1, "", error.localizedDescription)
            }
        }
    }
}
