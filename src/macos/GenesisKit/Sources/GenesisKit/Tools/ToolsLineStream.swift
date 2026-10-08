import Foundation
import Darwin

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
    private var lineBuffer = ToolsLineBuffer()
    private var stderrTail = Data()
    private var stopRequested = false
    private var outputClosed = false
    private var inputClosed = false
    private var exited = false
    private let onLines: @MainActor ([String]) -> Void
    private let onExit: @MainActor (Exit) -> Void
    /// One app-perf.log line when the follow ends (ToolsCallTrace); the CLI gets the id in its environment.
    public let traceId = ToolsCallTrace.newId()
    private let argv: [String]
    private let started = Date()
    private var outBytes = 0

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
        self.argv = [subcommand] + args
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
        environment[ToolsCallTrace.environmentKey] = traceId
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

    /// A small control message, written atomically without blocking the UI or raising SIGPIPE.
    public func sendInput(_ text: String) throws {
        let data = Data(text.utf8)
        guard !data.isEmpty, data.count <= 512 else { throw POSIXError(.EMSGSIZE) }
        lock.lock()
        defer { lock.unlock() }
        guard !inputClosed, !exited, !stopRequested else { throw POSIXError(.EPIPE) }
        let descriptor = input.fileHandleForWriting.fileDescriptor
        guard fcntl(descriptor, F_SETNOSIGPIPE, 1) != -1 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let flags = fcntl(descriptor, F_GETFL)
        guard flags != -1, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) != -1 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let written = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
        guard written == data.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    /// Requests an EOF-driven finish while retaining final stdout events.
    public func finishInput() {
        lock.lock()
        defer { lock.unlock() }
        guard !inputClosed else { return }
        inputClosed = true
        do { try input.fileHandleForWriting.close() }
        catch { PerfLog.mark("tools.follow input close \(error.localizedDescription)") }
    }

    /// Ends the child: stdin closes and it gets SIGTERM. `onExit` still runs, with `stopped` true.
    public func stop() {
        lock.lock()
        let first = !stopRequested
        stopRequested = true
        lock.unlock()
        guard first else { return }
        finishInput()
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
        outBytes += data.count
        let lines = lineBuffer.append(data)
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
        let bytes = outBytes
        lock.unlock()
        guard done else { return }
        ToolsCallTrace.record(
            traceId: traceId, via: "process-follow", argv: argv, started: started,
            exit: report.status, outBytes: bytes, stderr: report.stderr
        )
        let onExit = onExit
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onExit(report) }
        }
    }
}

struct ToolsLineBuffer: Sendable {
    private var partial = Data()
    private var searchedTo = 0
    private(set) var scannedBytes = 0

    mutating func append(_ data: Data) -> [String] {
        partial.append(data)
        var lines: [String] = []
        var consumed = 0
        var scanned = 0
        partial.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
            guard let base = bytes.baseAddress else { return }
            var cursor = searchedTo
            while cursor < bytes.count {
                guard let match = memchr(base.advanced(by: cursor), 0x0A, bytes.count - cursor) else {
                    scanned += bytes.count - cursor
                    break
                }
                let newline = base.distance(to: UnsafeRawPointer(match))
                scanned += newline - cursor + 1
                if newline > consumed {
                    let line = UnsafeRawBufferPointer(start: base.advanced(by: consumed), count: newline - consumed)
                    lines.append(String(decoding: line, as: UTF8.self))
                }
                consumed = newline + 1
                cursor = consumed
            }
        }
        scannedBytes += scanned
        if consumed > 0 {
            partial.removeSubrange(partial.startIndex..<partial.index(partial.startIndex, offsetBy: consumed))
        }
        searchedTo = partial.count
        return lines
    }
}
