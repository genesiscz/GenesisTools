import Foundation

/// One long-running child whose stdout arrives as whole lines on the main queue: a `tools … --live`
/// follow, which prints a line per change and runs until it is stopped. Nothing polls: the pipe's
/// readability handler wakes it, and a chunk's complete lines go to `onLines` in one call, so a
/// burst costs one main-queue hop.
///
/// The child's stdin is a pipe this object holds open. macOS has no parent-death signal, so a child
/// that watches its stdin ends when this process quits or crashes and the kernel closes the pipe.
/// `stop()` closes it and sends SIGTERM (`tools` forwards it to the process that does the work).
public final class ToolsLineStream: @unchecked Sendable {
    public struct Exit: Sendable {
        public let status: Int32
        /// True for a `stop()` of ours; false when the child ended on its own or was killed.
        public let stopped: Bool
        /// The last `stderrLimit` bytes of stderr.
        public let stderr: String
    }

    /// Stderr kept for the exit report.
    public static let stderrLimit = 8192

    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private let errors = Pipe()
    private let lock = NSLock()
    private var partial = Data()
    private var stderrTail = Data()
    private var stopRequested = false
    private var outputClosed = false
    private var exited = false
    private let onLines: @MainActor ([String]) -> Void
    private let onExit: @MainActor (Exit) -> Void

    public var processIdentifier: Int32 { process.processIdentifier }

    /// Starts `tools <subcommand> <args…>` the way `ToolsBridge.run` does (bun for a bun script, the
    /// scrubbed environment, the repo as working directory). Throws when it cannot start.
    public init(
        bridge: ToolsBridge,
        subcommand: String,
        args: [String],
        extraEnv: [String: String] = [:],
        onLines: @escaping @MainActor ([String]) -> Void,
        onExit: @escaping @MainActor (Exit) -> Void
    ) throws {
        self.onLines = onLines
        self.onExit = onExit
        let binary = bridge.binaryPath
        guard ToolsBridge.isExecutableFile(binary) else {
            throw ToolsBridgeError.binaryNotFound(binary)
        }

        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: [subcommand] + args)
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory
        var environment = ToolsBridge.scrubbedEnvironment()
        for (key, value) in extraEnv where ToolsBridge.envAllowlist.contains(key) {
            environment[key] = value
        }
        process.environment = environment
        process.qualityOfService = .utility
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors

        // EOF clears the handler before `self` is consulted: a stream released while its child still
        // exits would otherwise leave a handler that fires on the closed pipe in a tight loop.
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else {
                if data.isEmpty { handle.readabilityHandler = nil }
                return
            }
            self.receive(data)
        }
        errors.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty {
                handle.readabilityHandler = nil
                return
            }
            guard let self else { return }

            self.lock.lock()
            self.stderrTail.append(data)
            if self.stderrTail.count > Self.stderrLimit {
                self.stderrTail = self.stderrTail.suffix(Self.stderrLimit)
            }
            self.lock.unlock()
        }
        process.terminationHandler = { [weak self] _ in
            self?.finish(exited: true)
        }
        try process.run()
    }

    deinit {
        if process.isRunning {
            process.terminate()
        }
    }

    /// Ends the child: stdin closes and it gets SIGTERM. `onExit` still runs, with `stopped` true.
    public func stop() {
        lock.lock()
        let first = !stopRequested
        stopRequested = true
        lock.unlock()
        guard first else { return }
        try? input.fileHandleForWriting.close()
        if process.isRunning {
            process.terminate()
        }
    }

    private func receive(_ data: Data) {
        if data.isEmpty {
            output.fileHandleForReading.readabilityHandler = nil
            finish(exited: false)
            return
        }

        lock.lock()
        partial.append(data)
        var lines: [String] = []
        while let newline = partial.firstIndex(of: 0x0A) {
            let line = partial[partial.startIndex..<newline]
            partial.removeSubrange(partial.startIndex...newline)
            if !line.isEmpty {
                lines.append(String(decoding: line, as: UTF8.self))
            }
        }
        // Rebase so indices stay small after many removals.
        partial = Data(partial)
        let stopped = stopRequested
        lock.unlock()
        guard !lines.isEmpty, !stopped else { return }
        let onLines = onLines
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onLines(lines) }
        }
    }

    /// `onExit` runs once, after both the exit and the end of stdout: lines printed just before the
    /// exit are delivered first.
    private func finish(exited: Bool) {
        lock.lock()
        if exited { self.exited = true } else { outputClosed = true }
        let done = self.exited && outputClosed
        let report = Exit(
            status: done ? process.terminationStatus : 0,
            stopped: stopRequested,
            stderr: String(decoding: stderrTail, as: UTF8.self)
        )
        lock.unlock()
        guard done else { return }
        let onExit = onExit
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onExit(report) }
        }
    }
}
