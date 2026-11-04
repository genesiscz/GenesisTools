import Foundation

/// Starts a `tools` command that outlives the click: a recording owns its process and socket, so the menu only
/// launches it and watches the live folder. Its output goes to `~/.genesis-tools/logs/recorder-start.log`, which a
/// failed start names.
enum ToolsRunner {
    /// `onEarlyFailure` runs on the main thread when the command exits non-zero within `earlyWindow` seconds (a
    /// refused flag, a missing grant), with the end of the log, so a start that never began does not stay silent.
    static func detached(
        _ argv: [String],
        earlyWindow: TimeInterval = 15,
        onEarlyFailure: ((Int32, String) -> Void)? = nil
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
        process.standardOutput = handle
        process.standardError = handle
        process.standardInput = FileHandle.nullDevice
        let started = Date()
        process.terminationHandler = { finished in
            let status = finished.terminationStatus
            guard status != 0 else { return }
            HubPerf.log("recorder: tools \(argv.joined(separator: " ")) exited \(status); see \(log.path)")
            guard let onEarlyFailure, Date().timeIntervalSince(started) < earlyWindow else { return }
            let tail = (try? String(contentsOf: log, encoding: .utf8))
                .map { $0.split(separator: "\n", omittingEmptySubsequences: true).suffix(6).joined(separator: "\n") } ?? ""
            DispatchQueue.main.async { onEarlyFailure(status, tail) }
        }
        try process.run()
    }
}

extension ToolsRunner {
    /// Runs a short `tools` command with its output captured, and calls `done` on the main thread with the exit
    /// status, stdout and stderr. For a step the window waits on (an edit op that needs ffmpeg), not a recording.
    static func run(_ argv: [String], done: @escaping @MainActor (Int32, String, String) -> Void) {
        let plan = ToolsBridge.launchPlan(binaryPath: ToolsBridge.defaultBinaryPath(), argv: argv)
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory
        process.environment = ToolsBridge.scrubbedEnvironment()
        process.standardInput = FileHandle.nullDevice
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        HubPerf.log("recorder: run tools \(argv.joined(separator: " "))")
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try process.run()
            } catch {
                DispatchQueue.main.async { MainActor.assumeIsolated { done(-1, "", error.localizedDescription) } }
                return
            }
            // Both pipes are read at once and before the wait, so neither fills and blocks the child.
            var stderrData = Data()
            let reading = DispatchGroup()
            reading.enter()
            DispatchQueue.global(qos: .userInitiated).async {
                stderrData = err.fileHandleForReading.readDataToEndOfFile()
                reading.leave()
            }
            let stdout = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            reading.wait()
            let stderr = String(decoding: stderrData, as: UTF8.self)
            process.waitUntilExit()
            let status = process.terminationStatus
            if status != 0 { HubPerf.log("recorder: tools \(argv.first ?? "") exited \(status): \(stderr.suffix(300))") }
            DispatchQueue.main.async { MainActor.assumeIsolated { done(status, stdout, stderr) } }
        }
    }
}
