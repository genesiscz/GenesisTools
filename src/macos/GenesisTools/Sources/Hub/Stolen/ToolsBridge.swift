// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/ToolsBridge.swift at 2026-09-24T03:58:53+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
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
            return "tools call exceeded \(seconds)s and was killed"
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
    public static let envAllowlist: Set<String> = [
        "HOME", "PATH", "SHELL", "LANG", "USER", "LOGNAME", "TERM",
        "SSH_AUTH_SOCK", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "TZ",
        "PROFILE",
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

    public var binaryPath: String { resolveBinaryPath() }

    public init(binaryPath: String, outputSink: OutputSink? = nil) {
        let captured = binaryPath
        self.resolveBinaryPath = { captured }
        self.outputSink = outputSink
    }

    public init(
        resolveBinaryPath: @escaping @Sendable () -> String,
        outputSink: OutputSink? = nil
    ) {
        self.resolveBinaryPath = resolveBinaryPath
        self.outputSink = outputSink
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
        guard Self.isExecutableFile(resolvedBinaryPath) else {
            throw ToolsBridgeError.binaryNotFound(resolvedBinaryPath)
        }

        let started = Date()
        let argv = [subcommand] + args
        let plan = Self.launchPlan(binaryPath: resolvedBinaryPath, argv: argv)

        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        var environment = Self.scrubbedEnvironment()
        for (key, value) in extraEnv where Self.envAllowlist.contains(key) {
            environment[key] = value
        }
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

        try process.run()

        // A caller that goes away (Session Details closed mid-fetch) cancels
        // its task; without this the child ran on until the watchdog.
        return try await withTaskCancellationHandler {
            try await finish(
                process: process, outPipe: outPipe, errPipe: errPipe, started: started,
                subcommand: subcommand, args: args, argv: argv, timeoutSeconds: timeoutSeconds,
                turnId: turnId, callId: callId
            )
        } onCancel: {
            if process.isRunning { process.terminate() }
        }
    }

    private func finish(
        process: Process,
        outPipe: Pipe,
        errPipe: Pipe,
        started: Date,
        subcommand: String,
        args: [String],
        argv: [String],
        timeoutSeconds: Int,
        turnId: String,
        callId: String
    ) async throws -> ToolsRunResult {
        let timedOutFlag = TimeoutFlag()
        let watchdog = Task.detached {
            try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
            if process.isRunning {
                timedOutFlag.fired = true
                process.terminate()
                try? await Task.sleep(nanoseconds: 500_000_000)
                if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            }
        }

        async let outData = Task.detached { outPipe.fileHandleForReading.readDataToEndOfFile() }.value
        async let errData = Task.detached { errPipe.fileHandleForReading.readDataToEndOfFile() }.value

        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            process.terminationHandler = { _ in cont.resume() }
        }
        watchdog.cancel()

        let stdout = String(decoding: await outData, as: UTF8.self)
        let stderr = String(decoding: await errData, as: UTF8.self)
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
        let verb = args.prefix(while: { !$0.hasPrefix("-") }).prefix(2).joined(separator: ".")
        let spanLabel = "tools.\(subcommand)" + (verb.isEmpty ? "" : ".\(verb)")
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
        outputSink?(result, turnId, callId, argv)

        if timedOut {
            throw ToolsBridgeError.timeout(seconds: timeoutSeconds)
        }
        return result
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
