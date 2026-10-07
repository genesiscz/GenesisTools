import Foundation
import os

private let monitorLog = Logger(subsystem: "dev.foltyn.genesis", category: "monitor")

public struct ToolsRunResult: Equatable, Sendable {
    public let stdout: String
    public let stderr: String
    public let exitCode: Int32
    public let wallMs: Int

    public init(stdout: String, stderr: String, exitCode: Int32, wallMs: Int) {
        self.stdout = stdout
        self.stderr = stderr
        self.exitCode = exitCode
        self.wallMs = wallMs
    }
}

public enum ToolsBridgeError: Error, LocalizedError, Equatable {
    case binaryNotFound(String)
    case timeout(seconds: Int)
    case refused(String)

    public var errorDescription: String? {
        switch self {
        case .binaryNotFound(let path):
            return "tools binary not found at \(path) — run `tools --version` in a terminal first"
        case .timeout(let seconds):
            return "tools call exceeded \(seconds)s"
        case .refused(let reason):
            return reason
        }
    }
}

/// Scrubbed `tools <sub> …` runner. Argv only, never a shell.
///
/// Logging stays on `os.Logger` (subsystem `dev.foltyn.genesis`, category
/// `monitor`). Companion file persistence is an optional `outputSink` so this
/// library never writes under Application Support/Genesis/companion.
public struct ToolsBridge: Sendable {
    /// GENESIS_TOOLS_APP_BUNDLE_ID and GENESIS_TOOLS_APP_INODE pass through: they name the responsible
    /// process this one runs under (set by the GenesisTools launcher, or by a GenesisTools.app face that
    /// checked it with the kernel), so `tools` skips both launcher stages when that is already GenesisTools.
    public static let envAllowlist: Set<String> = [
        "HOME", "PATH", "SHELL", "LANG", "USER", "LOGNAME", "TERM",
        "SSH_AUTH_SOCK", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "TZ",
        "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
        "PROFILE", "GENESIS_TOOLS_APP_BUNDLE_ID", "GENESIS_TOOLS_APP_INODE",
        ToolsCallTrace.environmentKey,
    ]

    public typealias OutputSink = @Sendable (
        ToolsRunResult,
        _ turnId: String,
        _ callId: String,
        _ argv: [String]
    ) -> Void

    /// Resolved at each `run`, so a Settings / client.json path change applies
    /// without restarting Genesis.app.
    private let resolveBinaryPath: @Sendable () -> String
    public let outputSink: OutputSink?
    /// A resident `tools` server to ask first (`tools hub serve`). Nil, or a nil answer, runs the process.
    public let server: ToolsServerClient?

    public var binaryPath: String { resolveBinaryPath() }

    public init(binaryPath: String, outputSink: OutputSink? = nil, server: ToolsServerClient? = nil) {
        let captured = binaryPath
        self.resolveBinaryPath = { captured }
        self.outputSink = outputSink
        self.server = server
    }

    public init(
        resolveBinaryPath: @escaping @Sendable () -> String,
        outputSink: OutputSink? = nil,
        server: ToolsServerClient? = nil
    ) {
        self.resolveBinaryPath = resolveBinaryPath
        self.outputSink = outputSink
        self.server = server
    }

    public var binaryExists: Bool {
        Self.isExecutableFile(binaryPath)
    }

    /// `isExecutableFile(atPath:)` is `access(X_OK)`, which is true for any
    /// searchable directory, so a `toolsBinaryPath` pointing at a folder used
    /// to win the probe and then fail at `process.run()` every call.
    public static func isExecutableFile(_ path: String) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory),
              !isDirectory.boolValue
        else { return false }
        return FileManager.default.isExecutableFile(atPath: path)
    }

    /// Same candidate list as `CompanionSettings.defaultToolsBinaryPath`.
    public static func defaultBinaryPath(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        isExecutable: (String) -> Bool = ToolsBridge.isExecutableFile
    ) -> String {
        let candidates = [
            home.appendingPathComponent(".bun/bin/tools").path,
            home.appendingPathComponent(".local/bin/tools").path,
            home.appendingPathComponent("Tresors/Projects/GenesisTools/tools").path,
            "/usr/local/bin/tools",
        ]
        return candidates.first(where: isExecutable) ?? candidates[0]
    }

    /// Settings / client.json path first when it is executable. Otherwise the
    /// default probe list. A deleted worktree must not brick `tools` exec.
    public static func resolveBinaryPath(
        configured: String?,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        isExecutable: (String) -> Bool = ToolsBridge.isExecutableFile
    ) -> String {
        if let configured, !configured.isEmpty, isExecutable(configured) {
            return configured
        }
        return defaultBinaryPath(home: home, isExecutable: isExecutable)
    }

    /// Bun resolves `node_modules` and its transpile cache from cwd.
    /// `$HOME` misses GenesisTools/`node_modules/.bun` and recompiles the CLI
    /// (~8-12s). Follow symlinks so a `~/.bun/bin/tools` link still lands in
    /// the repo.
    public static func workingDirectory(forBinary path: String) -> URL {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().deletingLastPathComponent()
    }

    /// How to exec `tools`. A bun shebang script must be launched as
    /// `bun <script> …` so the Mach-O is bun (Developer ID). Exec'ing the
    /// script lets the kernel run `/usr/bin/env bun` as a child of a signed
    /// app; Taskgated then SIGKILLs bun (Code Signature Invalid, ~5ms).
    public struct ProcessLaunchPlan: Equatable, Sendable {
        public var executable: URL
        public var arguments: [String]
        public var workingDirectory: URL
    }

    public static func launchPlan(
        binaryPath: String,
        argv: [String],
        bunExecutable: String? = nil
    ) -> ProcessLaunchPlan {
        let workDir = workingDirectory(forBinary: binaryPath)
        if shebangMentions(binaryPath, needles: ["bun", "node"]),
           let bun = bunExecutable ?? findBun()
        {
            return ProcessLaunchPlan(
                executable: URL(fileURLWithPath: bun),
                arguments: [binaryPath] + argv,
                workingDirectory: workDir
            )
        }
        return ProcessLaunchPlan(
            executable: URL(fileURLWithPath: binaryPath),
            arguments: argv,
            workingDirectory: workDir
        )
    }

    static func shebangMentionsBun(_ path: String) -> Bool {
        shebangMentions(path, needles: ["bun"])
    }

    static func shebangMentions(_ path: String, needles: [String]) -> Bool {
        guard let handle = FileHandle(forReadingAtPath: path) else { return false }
        defer { try? handle.close() }
        let prefix = handle.readData(ofLength: 256)
        guard let text = String(data: prefix, encoding: .utf8), text.hasPrefix("#!") else {
            return false
        }
        let line = text.prefix(while: { $0 != "\n" }).lowercased()
        return needles.contains { line.contains($0) }
    }

    static func findBun(
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        pathEnvironment: String = ProcessInfo.processInfo.environment["PATH"] ?? ""
    ) -> String? {
        var candidates = [
            home.appendingPathComponent(".bun/bin/bun").path,
            "/opt/homebrew/bin/bun",
            "/usr/local/bin/bun",
        ]
        for dir in pathEnvironment.split(separator: ":") where !dir.isEmpty {
            let path = URL(fileURLWithPath: String(dir)).appendingPathComponent("bun").path
            if !candidates.contains(path) {
                candidates.append(path)
            }
        }
        return candidates.first(where: isExecutable)
    }

    public static func scrubbedEnvironment(
        from env: [String: String] = ProcessInfo.processInfo.environment
    ) -> [String: String] {
        var out = env.filter { envAllowlist.contains($0.key) }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let extras = ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
        var path = out["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"
        for extra in extras where !path.split(separator: ":").map(String.init).contains(extra) {
            path += ":\(extra)"
        }
        out["PATH"] = path
        return out
    }

    public func run(
        subcommand: String,
        args: [String],
        timeoutSeconds: Int = 30,
        turnId: String = "adhoc",
        callId: String = UUID().uuidString,
        extraEnv: [String: String] = [:]
    ) async throws -> ToolsRunResult {
        let resolvedBinaryPath = binaryPath
        if subcommand == "--readme" || args.contains("--readme") {
            throw ToolsBridgeError.refused(
                "`tools --readme` is too expensive from a turn — use `tools \(subcommand) --help` instead"
            )
        }
        let argv = [subcommand] + args
        let traceId = ToolsCallTrace.newId()
        let started = Date()
        if let server, let result = await server.call(argv: argv, timeoutSeconds: timeoutSeconds, traceId: traceId) {
            // Same span name as the process path with `.srv`, so app-perf.log shows which path answered.
            MonitorPerf.record(Self.spanLabel(subcommand: subcommand, args: args) + ".srv", ms: Double(result.wallMs))
            ToolsCallTrace.record(
                traceId: traceId, via: "server", argv: argv, started: started,
                exit: result.exitCode, outBytes: result.stdout.utf8.count, stderr: result.stderr
            )
            outputSink?(result, turnId, callId, argv)
            return result
        }

        // A task cancelled while the server had the call never starts the process fallback.
        try Task.checkCancellation()

        guard Self.isExecutableFile(resolvedBinaryPath) else {
            throw ToolsBridgeError.binaryNotFound(resolvedBinaryPath)
        }

        let plan = Self.launchPlan(binaryPath: resolvedBinaryPath, argv: argv)

        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        var environment = Self.scrubbedEnvironment()
        for (key, value) in extraEnv where Self.envAllowlist.contains(key) {
            environment[key] = value
        }
        environment[ToolsCallTrace.environmentKey] = traceId
        process.environment = environment
        process.currentDirectoryURL = plan.workingDirectory
        process.qualityOfService = .userInitiated
        process.standardInput = FileHandle.nullDevice

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        monitorLog.info(
            "tool_call exec turn=\(turnId, privacy: .public) sub=\(subcommand, privacy: .public) args=\(args.joined(separator: " "), privacy: .private)"
        )

        let stdout = try ToolsPipeCollector(outPipe)
        let stderr = try ToolsPipeCollector(errPipe)
        let exit = ToolsProcessExit()
        process.terminationHandler = { _ in exit.finish() }
        do {
            try process.run()
        } catch {
            stdout.stop(error)
            stderr.stop(error)
            throw error
        }

        // A caller that goes away (Session Details closed mid-fetch) cancels
        // its task; without this the child ran on until the watchdog.
        return try await withTaskCancellationHandler {
            try await finish(
                process: process, stdout: stdout, stderr: stderr, exit: exit, started: started,
                subcommand: subcommand, args: args, argv: argv, timeoutSeconds: timeoutSeconds,
                turnId: turnId, callId: callId, traceId: traceId
            )
        } onCancel: {
            stdout.stop(CancellationError())
            stderr.stop(CancellationError())
            ToolsProcessExit.terminate(process)
        }
    }

    private func finish(
        process: Process,
        stdout outReader: ToolsPipeCollector,
        stderr errReader: ToolsPipeCollector,
        exit: ToolsProcessExit,
        started: Date,
        subcommand: String,
        args: [String],
        argv: [String],
        timeoutSeconds: Int,
        turnId: String,
        callId: String,
        traceId: String
    ) async throws -> ToolsRunResult {
        let timedOutFlag = TimeoutFlag()
        let remaining = max(0, Double(timeoutSeconds) - Date().timeIntervalSince(started))
        let watchdog = Task.detached {
            do { try await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000)) }
            catch { return }
            timedOutFlag.fired = true
            let error = ToolsBridgeError.timeout(seconds: timeoutSeconds)
            outReader.stop(error)
            errReader.stop(error)
            ToolsProcessExit.terminate(process)
        }
        defer { watchdog.cancel() }

        await exit.waitForExit()
        async let outData = outReader.value()
        async let errData = errReader.value()
        let captured: (Data, Data)
        do {
            captured = try await (outData, errData)
            try Task.checkCancellation()
        } catch {
            MonitorPerf.mark("tools.\(subcommand) incomplete output: \(error.localizedDescription)")
            throw error
        }
        let stdout = String(decoding: captured.0, as: UTF8.self)
        let stderr = String(decoding: captured.1, as: UTF8.self)
        let wallMs = Int(Date().timeIntervalSince(started) * 1000)
        let exitCode = process.terminationStatus

        let timedOut = timedOutFlag.fired
        let result = ToolsRunResult(stdout: stdout, stderr: stderr, exitCode: exitCode, wallMs: wallMs)

        monitorLog.info(
            "tool_result turn=\(turnId, privacy: .public) exit=\(exitCode) wall_ms=\(wallMs)"
        )
        // perf.log sees every child: `tools.claude.usage 1234.0ms`. The
        // `[profile:` lines a PROFILE= child prints ride along as marks, so
        // "the CLI took 20 s" and "where inside the CLI" sit on adjacent lines.
        let spanLabel = Self.spanLabel(subcommand: subcommand, args: args)
        MonitorPerf.record(spanLabel, ms: Double(wallMs))
        if timedOutFlag.fired {
            MonitorPerf.mark("\(spanLabel) TIMEOUT after \(timeoutSeconds)s (killed)")
        } else if exitCode != 0 {
            MonitorPerf.mark("\(spanLabel) exit=\(exitCode)")
        }
        for line in stderr.split(whereSeparator: \.isNewline) where line.hasPrefix("[profile:") {
            monitorLog.info("\(String(line), privacy: .public)")
            MonitorPerf.mark("\(spanLabel) \(String(line.prefix(200)))")
        }
        ToolsCallTrace.record(
            traceId: traceId, via: timedOut ? "process-timeout" : "process", argv: argv, started: started,
            exit: exitCode, outBytes: stdout.utf8.count, stderr: stderr
        )
        outputSink?(result, turnId, callId, argv)

        if timedOut {
            throw ToolsBridgeError.timeout(seconds: timeoutSeconds)
        }
        return result
    }
}

extension ToolsBridge {
    static func spanLabel(subcommand: String, args: [String]) -> String {
        let verb = args.prefix(while: { !$0.hasPrefix("-") }).prefix(2).joined(separator: ".")
        return "tools.\(subcommand)" + (verb.isEmpty ? "" : ".\(verb)")
    }
}

private final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var _fired = false

    var fired: Bool {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _fired
        }
        set {
            lock.lock()
            defer { lock.unlock() }
            _fired = newValue
        }
    }
}

/// The handler is installed before launch, so even an immediate child exit is retained.
private final class ToolsProcessExit: @unchecked Sendable {
    private let lock = NSLock()
    private var exited = false
    private var waiter: CheckedContinuation<Void, Never>?

    func finish() {
        lock.lock()
        exited = true
        let pending = waiter
        waiter = nil
        lock.unlock()
        pending?.resume()
    }

    func waitForExit() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if exited {
                lock.unlock()
                continuation.resume()
            } else {
                waiter = continuation
                lock.unlock()
            }
        }
    }

    static func terminate(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) {
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

/// Nonblocking reads and closure share one queue. Cancellation cannot close an active read,
/// and a descendant holding a pipe never occupies a blocked thread.
private final class ToolsPipeCollector: @unchecked Sendable {
    private let queue = DispatchQueue(label: "genesis.tools.pipe", qos: .userInitiated)
    private let source: DispatchSourceRead
    private let descriptor: Int32
    private var data = Data()
    private var result: Result<Data, Error>?
    private var waiter: CheckedContinuation<Data, Error>?

    init(_ pipe: Pipe) throws {
        descriptor = dup(pipe.fileHandleForReading.fileDescriptor)
        guard descriptor >= 0 else { throw POSIXError(.EMFILE) }
        guard fcntl(descriptor, F_SETFL, fcntl(descriptor, F_GETFL) | O_NONBLOCK) >= 0 else {
            close(descriptor)
            throw POSIXError(.EIO)
        }
        source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: queue)
        let fd = descriptor
        source.setCancelHandler { close(fd) }
        source.setEventHandler { [weak self] in self?.receive() }
        source.resume()
    }

    func value() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                if let result = self.result {
                    continuation.resume(with: result)
                } else {
                    self.waiter = continuation
                }
            }
        }
    }

    func stop(_ error: Error) {
        queue.async { self.complete(.failure(error)) }
    }

    private func receive() {
        var buffer = [UInt8](repeating: 0, count: 65536)
        // Yield between bounded bursts so a continuously writing child cannot
        // keep the deadline/cancellation operation behind this callback forever.
        for _ in 0..<16 {
            guard result == nil else { return }
            let count = read(descriptor, &buffer, buffer.count)
            if count > 0 {
                data.append(contentsOf: buffer.prefix(count))
            } else if count == 0 {
                complete(.success(data))
            } else if errno == EINTR {
                continue
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                return
            } else {
                complete(.failure(POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)))
            }
        }
    }

    private func complete(_ value: Result<Data, Error>) {
        guard result == nil else { return }
        result = value
        source.cancel()
        let pending = waiter
        waiter = nil
        pending?.resume(with: value)
    }

    deinit { source.cancel() }
}
