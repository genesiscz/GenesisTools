import Foundation

/// The blocking and the stoppable forms of a `tools` call, for button actions and background loads that already run
/// off the main thread. Same rules as `run`: the resident server first (a third of the limit, `serverPatience`), then
/// a process with the scrubbed environment, the trace id and the perf span; the limit covers both.
extension ToolsBridge {
    /// The exit status and both streams. Blocks the calling thread: never call it on the main thread. A child still
    /// running at the end of `timeout` is killed and `ToolsBridgeError.timeout` is thrown.
    public func capture(_ argv: [String], timeout: TimeInterval = 60) throws -> ProcessCapture {
        let traceId = ToolsCallTrace.newId()
        let started = Date()
        if let server {
            let start = CFAbsoluteTimeGetCurrent()
            let patience = Self.serverPatience(timeoutSeconds: Self.limitSeconds(timeout))
            if let result = server.callSync(argv: argv, timeout: TimeInterval(patience), traceId: traceId),
               !Self.isServerDeadline(result) {
                return Self.serverCapture(result, argv, traceId: traceId, started: started, since: start)
            }
        }

        return try processCapture(argv, timeout: timeout, traceId: traceId, started: started)
    }

    /// stdout of a call that exited 0, else its `ToolsFailure`.
    public func output(_ argv: [String], timeout: TimeInterval = 60) throws -> Data {
        try ToolsFailure.check(capture(argv, timeout: timeout), argv: argv)
    }

    /// The JSON a `--json` call printed, with any banner, warning or `[profile:` line before it dropped
    /// (`MonitorJSON.dataByDroppingPreamble`), else its `ToolsFailure`.
    public func json(_ argv: [String], timeout: TimeInterval = 60) throws -> Data {
        try MonitorJSON.dataByDroppingPreamble(output(argv, timeout: timeout))
    }

    /// `capture` that its task can stop: a server call is cancelled there, and a running process is terminated (the
    /// `tools` wrapper passes the signal to the tool). A cancelled task throws `CancellationError`, never a capture.
    public func captureCancellable(_ argv: [String], timeout: TimeInterval = 60) async throws -> ProcessCapture {
        let run = try await captureStoppable(argv, timeout: timeout)
        try Task.checkCancellation()
        return run.capture
    }

    /// `capture` for work a stop may come too late for (a widget send). A cancel of the calling task before the child
    /// starts throws `CancellationError`; a cancel while it runs terminates it, waits for its end and returns what it
    /// printed, with `stopped` set. The tool decides what the stop undoes: a widget send honors it only before it
    /// writes (`cancelPoint`, src/hub/lib/widget/staged.ts), so a send that already typed finishes and says so.
    /// A server door is one idempotent write, so a cancel there only stops the wait for its answer.
    public func captureStoppable(_ argv: [String], timeout: TimeInterval = 60) async throws -> (capture: ProcessCapture, stopped: Bool) {
        let traceId = ToolsCallTrace.newId()
        let started = Date()
        if let server {
            let start = CFAbsoluteTimeGetCurrent()
            let patience = Self.serverPatience(timeoutSeconds: Self.limitSeconds(timeout))
            let result = await server.call(argv: argv, timeoutSeconds: patience, traceId: traceId)
            try Task.checkCancellation()
            if let result, !Self.isServerDeadline(result) {
                return (Self.serverCapture(result, argv, traceId: traceId, started: started, since: start), false)
            }
        }

        try Task.checkCancellation()
        let run = try await Self.runStoppable { handle in
            try processCapture(argv, timeout: timeout, traceId: traceId, started: started, handle: handle)
        }
        return (run.value, run.stopped)
    }

    /// Runs `work` off the main thread; a cancel of the calling task stops the process `work` hands its handle,
    /// and the call throws `CancellationError` once `work` returned.
    public static func runCancellable<T: Sendable>(_ work: @escaping @Sendable (ProcessCancelHandle) throws -> T) async throws -> T {
        let run = try await runStoppable(work)
        try Task.checkCancellation()
        return run.value
    }

    /// `runCancellable` that returns what `work` returned also after a cancel: `stopped` says a cancel came.
    public static func runStoppable<T: Sendable>(
        _ work: @escaping @Sendable (ProcessCancelHandle) throws -> T
    ) async throws -> (value: T, stopped: Bool) {
        let handle = ProcessCancelHandle()
        let value = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
                DispatchQueue.global(qos: .userInitiated).async {
                    continuation.resume(with: Result { try work(handle) })
                }
            }
        } onCancel: {
            handle.cancel()
        }
        return (value, handle.cancelled)
    }

    /// A limit in whole seconds, rounded up and at least 1: `Int(0.5)` is 0, and a call with 0 s failed at once without a
    /// run.
    static func limitSeconds(_ timeout: TimeInterval) -> Int {
        max(1, Int(timeout.rounded(.up)))
    }

    /// A server door's answer as a capture, with its perf span and its trace line.
    private static func serverCapture(_ result: ToolsRunResult, _ argv: [String], traceId: String, started: Date,
                                      since start: CFAbsoluteTime) -> ProcessCapture {
        PerfLog.since("\(PerfSpans.prefix).srv.\(argv.prefix(3).joined(separator: "."))", start)
        ToolsCallTrace.record(
            traceId: traceId, via: "server", argv: argv, started: started,
            exit: result.exitCode, outBytes: result.stdout.utf8.count, stderr: result.stderr
        )
        return ProcessCapture(status: result.exitCode, stdout: Data(result.stdout.utf8), stderr: Data(result.stderr.utf8))
    }

    private func processCapture(_ argv: [String], timeout: TimeInterval, traceId: String, started: Date,
                                handle: ProcessCancelHandle? = nil) throws -> ProcessCapture {
        // The server's try shares the limit; with nothing left the process would be started and killed at once.
        guard let budget = Self.processBudget(timeoutSeconds: Self.limitSeconds(timeout), waited: Date().timeIntervalSince(started)) else {
            ToolsCallTrace.record(
                traceId: traceId, via: "server-timeout", argv: argv, started: started, exit: -1, outBytes: 0, stderr: ""
            )
            throw ToolsBridgeError.timeout(seconds: Self.limitSeconds(timeout), command: ToolsBridgeError.command(argv))
        }
        let span = PerfSpans.begin("tools.\(argv.prefix(3).joined(separator: "."))")
        defer { span.end() }
        let binary = binaryPath
        guard Self.isExecutableFile(binary) else { throw ToolsBridgeError.binaryNotFound(binary) }
        let process = Process()
        let plan = Self.launchPlan(binaryPath: binary, argv: argv)
        process.executableURL = plan.executable
        process.currentDirectoryURL = plan.workingDirectory
        process.arguments = plan.arguments
        process.standardInput = FileHandle.nullDevice
        process.environment = childEnvironment(argv: argv, traceId: traceId)
        do {
            let capture = try process.runCapturing(timeout: budget, afterStart: handle.map { handle in { handle.adopt(process) } })
            ToolsCallTrace.record(
                traceId: traceId, via: handle?.cancelled == true ? "process-cancelled" : "process", argv: argv, started: started,
                exit: capture.status, outBytes: capture.stdout.count, stderr: String(decoding: capture.stderr.suffix(400), as: UTF8.self)
            )
            return capture
        } catch is ProcessTimeout {
            ToolsCallTrace.record(
                traceId: traceId, via: "process-timeout", argv: argv, started: started, exit: -1, outBytes: 0, stderr: ""
            )
            throw ToolsBridgeError.timeout(seconds: Self.limitSeconds(timeout), command: ToolsBridgeError.command(argv))
        }
    }
}

/// The running child of a cancellable capture. A cancel before the child started terminates it as soon as it does.
public final class ProcessCancelHandle: @unchecked Sendable {
    private let lock = NSLock()
    private var process: Process?
    private var _cancelled = false

    public init() {}

    public var cancelled: Bool { lock.withLock { _cancelled } }

    public func adopt(_ process: Process) {
        let stop = lock.withLock { () -> Bool in
            self.process = process
            return _cancelled
        }
        if stop { process.terminate() }
    }

    public func cancel() {
        let running = lock.withLock { () -> Process? in
            _cancelled = true
            return process
        }
        if let running, running.isRunning { running.terminate() }
    }
}
