import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

final class ToolsBridgeTests: XCTestCase {
    func testCapturedChildEndsBeforeAfterStartReturns() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        let ended = DispatchSemaphore(value: 0)
        let result = try process.runCapturing(mergeStderr: false, timeout: 5, afterStart: {
            XCTAssertEqual(ended.wait(timeout: .now() + 5), .success,
                           "the child exits while afterStart still holds the capture call open")
        }, meterStarted: { executable, arguments in
            XCTAssertEqual(executable, process.executableURL)
            XCTAssertEqual(arguments, [])
            XCTAssertFalse(process.isRunning, "register before launch so a quick exit cannot precede registration")
            return { ended.signal() }
        })
        XCTAssertEqual(result.status, 0)
        XCTAssertEqual(ended.wait(timeout: .now()), .timedOut, "completion is counted exactly once")
    }

    func testCapturedChildLaunchFailureBalancesMeterRegistration() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/nonexistent/spawn-meter-fixture")
        let ended = DispatchSemaphore(value: 0)
        XCTAssertThrowsError(try process.runCapturing(mergeStderr: false, timeout: 5, afterStart: nil,
                                                     meterStarted: { _, _ in { ended.signal() } }))
        XCTAssertEqual(ended.wait(timeout: .now()), .success)
        XCTAssertEqual(ended.wait(timeout: .now()), .timedOut)
    }

    func testBunShebangLaunchPlanExecsBunBinary() throws {
        // Regression: Genesis.app exec'd the `#!/usr/bin/env bun` tools script.
        // Taskgated SIGKILL'd bun (Code Signature Invalid) in ~5ms — see
        // bun-2026-08-22-210515.ips, parentProc Genesis, two pids at 21:05:15.393.
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "monitor-bun-shebang-\(UUID().uuidString)",
            isDirectory: true
        )
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let script = dir.appendingPathComponent("tools")
        try "#!/usr/bin/env bun\nconsole.log(1)\n".write(to: script, atomically: true, encoding: .utf8)
        let bun = "/Users/fixture/.bun/bin/bun"
        let plan = ToolsBridge.launchPlan(
            binaryPath: script.path,
            argv: ["claude", "usage"],
            bunExecutable: bun
        )
        XCTAssertEqual(plan.executable.path, bun)
        XCTAssertEqual(plan.arguments, [script.path, "claude", "usage"])
    }

    func testNodeShebangLaunchPlanExecsBunBinary() throws {
        // ccusage 20 is `#!/usr/bin/env node` that spawn()s an adhoc native
        // binary. Running the wrapper as-is from Genesis.app is what painted
        // "The operation couldn't be…". Same bun Mach-O plan as tools.
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "monitor-node-shebang-\(UUID().uuidString)",
            isDirectory: true
        )
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let script = dir.appendingPathComponent("ccusage")
        try "#!/usr/bin/env node\nconsole.log(1)\n".write(to: script, atomically: true, encoding: .utf8)
        let bun = "/Users/fixture/.bun/bin/bun"
        let plan = ToolsBridge.launchPlan(
            binaryPath: script.path,
            argv: ["--json", "--offline"],
            bunExecutable: bun
        )
        XCTAssertEqual(plan.executable.path, bun)
        XCTAssertEqual(plan.arguments, [script.path, "--json", "--offline"])
    }

    func testMachOLaunchPlanExecsBinaryDirectly() {
        let plan = ToolsBridge.launchPlan(
            binaryPath: "/bin/echo",
            argv: ["github", "pr"],
            bunExecutable: "/Users/fixture/.bun/bin/bun"
        )
        XCTAssertEqual(plan.executable.path, "/bin/echo")
        XCTAssertEqual(plan.arguments, ["github", "pr"])
    }

    func testDefaultBinaryPathUsesRepoToolsWhenBunLinkMissing() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.defaultBinaryPath(home: home) { candidate in
            candidate == "/Users/fixture/Tresors/Projects/GenesisTools/tools"
        }
        XCTAssertEqual(path, "/Users/fixture/Tresors/Projects/GenesisTools/tools")
    }

    func testDefaultBinaryPathUsesTheBuiltFromCheckoutWhenNoFixedPlaceHasTools() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.defaultBinaryPath(home: home, builtFrom: "/Users/fixture/Desktop/GenesisTools/tools") { candidate in
            candidate == "/Users/fixture/Desktop/GenesisTools/tools"
        }
        XCTAssertEqual(path, "/Users/fixture/Desktop/GenesisTools/tools")
    }

    func testDefaultBinaryPathPrefersAFixedPlaceOverTheBuiltFromCheckout() {
        // A worktree's build still calls the main checkout's tools.
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.defaultBinaryPath(home: home, builtFrom: "/tmp/worktree/tools") { candidate in
            candidate == "/tmp/worktree/tools" || candidate == "/Users/fixture/.bun/bin/tools"
        }
        XCTAssertEqual(path, "/Users/fixture/.bun/bin/tools")
    }

    func testDefaultBinaryPathIgnoresAMissingOrRelativeBuiltFrom() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        XCTAssertEqual(ToolsBridge.defaultBinaryPath(home: home, builtFrom: "/gone/tools") { _ in false }, "/Users/fixture/.bun/bin/tools")
        XCTAssertEqual(ToolsBridge.defaultBinaryPath(home: home, builtFrom: "tools") { $0 == "tools" }, "/Users/fixture/.bun/bin/tools")
    }

    func testDefaultBinaryPathKeepsLocalBinFallback() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.defaultBinaryPath(home: home) { candidate in
            candidate == "/Users/fixture/.local/bin/tools"
        }
        XCTAssertEqual(path, "/Users/fixture/.local/bin/tools")
    }

    func testResolveBinaryPathPrefersConfiguredWhenExecutable() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.resolveBinaryPath(
            configured: "/tmp/worktree/tools",
            home: home
        ) { $0 == "/tmp/worktree/tools" }
        XCTAssertEqual(path, "/tmp/worktree/tools")
    }

    func testResolveBinaryPathRejectsDirectory() {
        // /tmp passes access(X_OK); it must still fall through to the defaults.
        let home = URL(fileURLWithPath: "/Users/tester")
        let resolved = ToolsBridge.resolveBinaryPath(configured: "/tmp", home: home)
        XCTAssertNotEqual(resolved, "/tmp")
        XCTAssertFalse(ToolsBridge.isExecutableFile("/tmp"))
        XCTAssertTrue(ToolsBridge.isExecutableFile("/bin/echo"))
    }

    func testResolveBinaryPathFallsBackWhenConfiguredMissing() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.resolveBinaryPath(
            configured: "/tmp/gone-worktree/tools",
            home: home
        ) { $0 == "/Users/fixture/Tresors/Projects/GenesisTools/tools" }
        XCTAssertEqual(path, "/Users/fixture/Tresors/Projects/GenesisTools/tools")
    }

    func testResolveBinaryPathFallsBackWhenConfiguredEmpty() {
        let home = URL(fileURLWithPath: "/Users/fixture")
        let path = ToolsBridge.resolveBinaryPath(
            configured: "",
            home: home
        ) { $0 == "/Users/fixture/Tresors/Projects/GenesisTools/tools" }
        XCTAssertEqual(path, "/Users/fixture/Tresors/Projects/GenesisTools/tools")
    }

    func testFindBunSearchesPATHAfterFixedLocations() {
        let bun = ToolsBridge.findBun(
            home: URL(fileURLWithPath: "/Users/fixture"),
            isExecutable: { $0 == "/opt/custom/bin/bun" },
            pathEnvironment: "/opt/custom/bin:/usr/bin"
        )
        XCTAssertEqual(bun, "/opt/custom/bin/bun")
    }

    func testCustomCertificateEnvironmentReachesTheChild() async throws {
        let values = [
            "NODE_EXTRA_CA_CERTS": "/fixture/extra.pem",
            "SSL_CERT_FILE": "/fixture/cert.pem",
            "SSL_CERT_DIR": "/fixture/certs",
        ]
        let scrubbed = ToolsBridge.scrubbedEnvironment(from: values.merging(["UNRELATED_SECRET": "hidden"]) { old, _ in old })
        for (key, value) in values { XCTAssertEqual(scrubbed[key], value) }
        XCTAssertNil(scrubbed["UNRELATED_SECRET"])
        let result = try await ToolsBridge(binaryPath: "/bin/sh").run(
            subcommand: "-c",
            args: ["printf '%s\\n' \"$NODE_EXTRA_CA_CERTS\" \"$SSL_CERT_FILE\" \"$SSL_CERT_DIR\""],
            extraEnv: values
        )
        XCTAssertEqual(result.stdout, "/fixture/extra.pem\n/fixture/cert.pem\n/fixture/certs\n")
    }

    func testInheritedPipesRespectTheWholeCallDeadline() async throws {
        for redirect in ["", "1>/dev/null", "2>/dev/null"] {
            let started = Date()
            do {
                _ = try await ToolsBridge(binaryPath: "/bin/sh").run(
                    subcommand: "-c", args: ["/bin/sleep 2 \(redirect) & printf held"], timeoutSeconds: 1
                )
                XCTFail("an inherited pipe must not produce partial success")
            } catch let error as ToolsBridgeError {
                XCTAssertEqual(error, .timeout(seconds: 1, command: ToolsBridgeError.command(["-c", "/bin/sleep 2 \(redirect) & printf held"])))
            }
            XCTAssertLessThan(Date().timeIntervalSince(started), 1.8)
        }
    }

    func testCancellationAfterImmediateChildExitStopsPipeCollectors() async throws {
        let task = Task {
            try await ToolsBridge(binaryPath: "/bin/sh").run(
                subcommand: "-c", args: ["/bin/sleep 2 & printf held"], timeoutSeconds: 30
            )
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let started = Date()
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch is CancellationError {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 0.8)
    }

    /// A hub server that kept a call for its whole limit (the limit plus 1 s) leaves the process nothing: it is
    /// not started. It was started and killed at once before, 41 times in five days.
    func testNoProcessBudgetIsLeftAfterTheServerUsedTheWholeLimit() {
        // The server holds a call for a third of its limit, so the process keeps the rest.
        XCTAssertEqual(ToolsBridge.serverPatience(timeoutSeconds: 30), 10)
        XCTAssertEqual(ToolsBridge.serverPatience(timeoutSeconds: 300), 100)
        XCTAssertEqual(ToolsBridge.serverPatience(timeoutSeconds: 12), 5, "at least 5 s for the server")
        XCTAssertEqual(ToolsBridge.serverPatience(timeoutSeconds: 4), 4, "a short limit goes to the server whole")
        XCTAssertNotNil(ToolsBridge.processBudget(timeoutSeconds: 30, waited: 11.1), "the process runs after the server's part")
        XCTAssertTrue(ToolsBridge.isServerDeadline(
            ToolsRunResult(stdout: "", stderr: "hub server: ai sessions tail --json exceeded 10000 ms\n", exitCode: 124, wallMs: 10_001)))
        XCTAssertFalse(ToolsBridge.isServerDeadline(
            ToolsRunResult(stdout: "", stderr: "timeout: the command ran too long", exitCode: 124, wallMs: 5)),
                       "a command's own exit 124 is its answer")
        XCTAssertNil(ToolsBridge.processBudget(timeoutSeconds: 30, waited: 31.1))
        XCTAssertNil(ToolsBridge.processBudget(timeoutSeconds: 30, waited: 30))
        XCTAssertEqual(ToolsBridge.processBudget(timeoutSeconds: 30, waited: 0.2) ?? 0, 29.8, accuracy: 0.001)
    }

    func testEnvAllowlistScrubsSecrets() {
        let scrubbed = ToolsBridge.scrubbedEnvironment(from: [
            "HOME": "/Users/x",
            "PATH": "/usr/bin",
            "AWS_SECRET_ACCESS_KEY": "leak-me",
            "DATABASE_URL": "postgres://",
            "GITHUB_TOKEN": "gh_ok",
            "PROFILE": "cmux-focus",
            "RANDOM_VAR": "nope",
        ])
        XCTAssertEqual(scrubbed["HOME"], "/Users/x")
        XCTAssertEqual(scrubbed["PATH"]?.hasPrefix("/usr/bin"), true)
        XCTAssertEqual(scrubbed["PATH"]?.contains("/opt/homebrew/bin"), true)
        XCTAssertEqual(scrubbed["GITHUB_TOKEN"], "gh_ok")
        XCTAssertEqual(scrubbed["PROFILE"], "cmux-focus")
        XCTAssertNil(scrubbed["AWS_SECRET_ACCESS_KEY"])
        XCTAssertNil(scrubbed["DATABASE_URL"])
        XCTAssertNil(scrubbed["RANDOM_VAR"])
    }

    /// The launcher markers reach `tools`, so a child of a GenesisTools app face skips the launcher.
    func testEnvAllowlistKeepsTheLauncherMarkers() {
        let scrubbed = ToolsBridge.scrubbedEnvironment(from: [
            "GENESIS_TOOLS_APP_BUNDLE_ID": "com.example.tools",
            "GENESIS_TOOLS_APP_INODE": "4242",
            "GENESIS_TOOLS_APP_STAGE": "responsible",
        ])
        XCTAssertEqual(scrubbed["GENESIS_TOOLS_APP_BUNDLE_ID"], "com.example.tools")
        XCTAssertEqual(scrubbed["GENESIS_TOOLS_APP_INODE"], "4242")
        XCTAssertNil(scrubbed["GENESIS_TOOLS_APP_STAGE"])
    }

    /// A sandboxed caller's storage overrides reach `tools`, so a daemon page in a test home never edits the real one.
    func testEnvAllowlistKeepsTheStorageOverrides() {
        let scrubbed = ToolsBridge.scrubbedEnvironment(from: [
            "GENESIS_TOOLS_HOME": "/fixture/home",
            "GENESIS_TOOLS_DAEMON_DIR": "/fixture/home/daemon",
        ])
        XCTAssertEqual(scrubbed["GENESIS_TOOLS_HOME"], "/fixture/home")
        XCTAssertEqual(scrubbed["GENESIS_TOOLS_DAEMON_DIR"], "/fixture/home/daemon")
    }

    func testRunRereadsResolvedBinaryPath() async throws {
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "monitor-live-path-\(UUID().uuidString)",
            isDirectory: true
        )
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        func script(_ name: String, body: String) throws -> String {
            let url = dir.appendingPathComponent(name)
            try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
            try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            return url.path
        }
        let firstPath = try script("one", body: "echo first-bin")
        let secondPath = try script("two", body: "echo second-bin")
        let box = LivePathBox(firstPath)
        let bridge = ToolsBridge(resolveBinaryPath: { box.path })
        let first = try await bridge.run(subcommand: "x", args: [])
        XCTAssertEqual(
            first.stdout.trimmingCharacters(in: .whitespacesAndNewlines),
            "first-bin"
        )
        box.path = secondPath
        let second = try await bridge.run(subcommand: "x", args: [])
        XCTAssertEqual(
            second.stdout.trimmingCharacters(in: .whitespacesAndNewlines),
            "second-bin"
        )
    }

    func testRunPassesArgvAndCapturesStdout() async throws {
        let bridge = ToolsBridge(binaryPath: "/bin/echo")
        let result = try await bridge.run(subcommand: "github", args: ["pr", "view", "578"])
        XCTAssertEqual(result.exitCode, 0)
        XCTAssertEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "github pr view 578")
        XCTAssertGreaterThanOrEqual(result.wallMs, 0)
    }

    /// Closing Session Details cancels the fetch task; the child must die
    /// with it instead of running on until the watchdog.
    func testCancellationTerminatesProcess() async {
        let bridge = ToolsBridge(binaryPath: "/bin/sleep")
        let started = Date()
        let task = Task { try await bridge.run(subcommand: "30", args: [], timeoutSeconds: 60) }
        try? await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        _ = try? await task.value
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "cancelled run should return promptly")
    }

    func testCancellationEscalatesWhenTheDirectChildIgnoresSIGTERM() async throws {
        let task = Task {
            try await ToolsBridge(binaryPath: "/bin/sh").run(
                subcommand: "-c", args: ["trap '' TERM; exec /bin/sleep 30"], timeoutSeconds: 60
            )
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let started = Date()
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch is CancellationError {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
    }

    func testTimeoutKillsProcess() async {
        let bridge = ToolsBridge(binaryPath: "/bin/sleep")
        do {
            _ = try await bridge.run(subcommand: "30", args: [], timeoutSeconds: 1)
            XCTFail("expected timeout")
        } catch let error as ToolsBridgeError {
            guard case .timeout = error else {
                return XCTFail("expected .timeout, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testReadmeIsRefused() async {
        let bridge = ToolsBridge(binaryPath: "/bin/echo")
        do {
            _ = try await bridge.run(subcommand: "--readme", args: [])
            XCTFail("expected refusal")
        } catch let error as ToolsBridgeError {
            guard case .refused = error else {
                return XCTFail("expected .refused, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    func testRunUsesBinaryDirectoryAsCwdNotHome() async throws {
        // Regression: Genesis.app Monitor spawn cwd=$HOME made bun miss
        // GenesisTools/node_modules/.bun and recompile ~8-12s per tools call.
        let fm = FileManager.default
        let dir = fm.temporaryDirectory.appendingPathComponent(
            "monitor-tools-cwd-\(UUID().uuidString)",
            isDirectory: true
        )
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: dir) }
        let script = dir.appendingPathComponent("tools")
        try "#!/bin/sh\n/bin/pwd\n".write(to: script, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        let bridge = ToolsBridge(binaryPath: script.path)
        let result = try await bridge.run(subcommand: "claude", args: ["usage"])
        XCTAssertEqual(result.exitCode, 0)
        let cwd = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertTrue(
            cwd.hasSuffix("/\(dir.lastPathComponent)"),
            "cwd was \(cwd), expected .../\(dir.lastPathComponent)"
        )
        XCTAssertNotEqual(cwd, fm.homeDirectoryForCurrentUser.path)
    }

    func testRunFollowsSymlinkToRealBinaryDirectory() async throws {
        let fm = FileManager.default
        let realDir = fm.temporaryDirectory.appendingPathComponent(
            "monitor-tools-real-\(UUID().uuidString)",
            isDirectory: true
        )
        let linkDir = fm.temporaryDirectory.appendingPathComponent(
            "monitor-tools-link-\(UUID().uuidString)",
            isDirectory: true
        )
        try fm.createDirectory(at: realDir, withIntermediateDirectories: true)
        try fm.createDirectory(at: linkDir, withIntermediateDirectories: true)
        defer {
            try? fm.removeItem(at: realDir)
            try? fm.removeItem(at: linkDir)
        }
        let realScript = realDir.appendingPathComponent("tools")
        try "#!/bin/sh\n/bin/pwd\n".write(to: realScript, atomically: true, encoding: .utf8)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: realScript.path)
        let link = linkDir.appendingPathComponent("tools")
        try fm.createSymbolicLink(at: link, withDestinationURL: realScript)

        let bridge = ToolsBridge(binaryPath: link.path)
        let result = try await bridge.run(subcommand: "claude", args: [])
        let cwd = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        XCTAssertTrue(
            cwd.hasSuffix("/\(realDir.lastPathComponent)"),
            "cwd was \(cwd), expected the real binary dir not the symlink dir"
        )
        XCTAssertFalse(cwd.hasSuffix("/\(linkDir.lastPathComponent)"))
    }

    func testMissingBinaryThrows() async {
        let bridge = ToolsBridge(binaryPath: "/nonexistent/tools")
        do {
            _ = try await bridge.run(subcommand: "say", args: ["hi"])
            XCTFail("expected binaryNotFound")
        } catch let error as ToolsBridgeError {
            guard case .binaryNotFound = error else {
                return XCTFail("expected .binaryNotFound, got \(error)")
            }
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    /// With no sink the bridge still answers: persistence is optional, never in the run's path.
    func testNilOutputSinkStillReturnsTheOutput() async throws {
        let bridge = ToolsBridge(binaryPath: "/bin/echo", outputSink: nil)
        let result = try await bridge.run(subcommand: "x", args: [])
        XCTAssertEqual(result.stdout.trimmingCharacters(in: .whitespacesAndNewlines), "x")
    }
}

private final class LivePathBox: @unchecked Sendable {
    var path: String
    init(_ path: String) { self.path = path }
}

/// The one tools client (C04): every error shape reads as one `ToolsFailure`, the preamble goes, a failed `--json`
/// call keeps its stdout, a process child gets the allowlist only, a cancel stops the child, and the server choice
/// keeps a sandbox home off the real home's server. The server adapter is `FakeServer` (ToolsServerClientTests); the
/// process stub is `/bin/sh -c` or `/bin/sleep`.
final class ToolsClientTests: XCTestCase {
    private func failure(stdout: String = "", stderr: String = "", status: Int32 = 1,
                         argv: [String] = ["hub", "pr", "fetch", "x#1"]) -> ToolsFailure {
        ToolsFailure(argv: argv, capture: ProcessCapture(status: status, stdout: Data(stdout.utf8), stderr: Data(stderr.utf8)))
    }

    func testEachErrorShapeReadsAsOneFailure() {
        struct Row {
            let stdout: String
            let stderr: String
            let message: String
            let code: String?
            let missing: [String]?
        }
        let rows: [Row] = [
            Row(stdout: #"{"error":"not a draft","code":"not-a-draft"}"#, stderr: "", message: "not a draft", code: "not-a-draft", missing: nil),
            Row(stdout: #"{"error":"\"explain-file\" needs --var file=…","code":"missing-vars","missing":["file"]}"#, stderr: "",
                message: #""explain-file" needs --var file=…"#, code: "missing-vars", missing: ["file"]),
            Row(stdout: #"{"error":{"message":"the index is locked","code":"busy"}}"#, stderr: "", message: "the index is locked",
                code: "busy", missing: nil),
            Row(stdout: #"{"type":"error","message":"no sessions match"}"#, stderr: "", message: "no sessions match", code: nil, missing: nil),
            Row(stdout: "{\n  \"error\": \"pretty printed\",\n  \"code\": \"auth\"\n}\n", stderr: "", message: "pretty printed", code: "auth",
                missing: nil),
            Row(stdout: "{\"event\":\"start\"}\n{\"type\":\"error\",\"message\":\"the last line\"}\n", stderr: "", message: "the last line",
                code: nil, missing: nil),
            Row(stdout: "", stderr: "[profile:x] 3ms\n\u{1B}[31m✗ [config-stale] The config changed on disk.\u{1B}[0m\n",
                message: "The config changed on disk.", code: "config-stale", missing: nil),
            Row(stdout: "", stderr: "✗ no store\n", message: "no store", code: nil, missing: nil),
            Row(stdout: "", stderr: "error: unknown option '--nope'\n\nUsage: tools hub [options]\n  error: {\n",
                message: "unknown option '--nope'", code: nil, missing: nil),
        ]
        for row in rows {
            let read = failure(stdout: row.stdout, stderr: row.stderr)
            XCTAssertEqual(read.message, row.message, row.stdout + row.stderr)
            XCTAssertEqual(read.code, row.code, row.stdout + row.stderr)
            XCTAssertEqual(read.missing, row.missing, row.stdout + row.stderr)
            XCTAssertTrue(read.named)
            XCTAssertEqual("\(read)", row.message)
        }
    }

    func testAFailureThatNamesNothingReadsAsTheExitSummary() {
        let read = failure(stderr: "[profile:hub-pr] 4ms\nboom\n", status: 2)
        XCTAssertEqual(read.message, "tools hub pr fetch exited 2: boom")
        XCTAssertEqual(read.summary, "tools hub pr fetch exited 2: [profile:hub-pr] 4ms\nboom", "Details keep all of stderr")
        XCTAssertEqual(read.stderrTail, "boom", "the profile lines are not the reason")
        XCTAssertEqual(read.exitCode, 2)
        XCTAssertFalse(read.named)
        XCTAssertEqual(failure(status: 3).message, "tools hub pr fetch exited 3")
        XCTAssertEqual(failure(stdout: "No agents found for that session.\n", status: 1).message,
                       "tools hub pr fetch exited 1: No agents found for that session.", "an empty stderr leaves the reason to stdout")
        XCTAssertEqual(failure(stdout: "ignored\n", stderr: "boom\n", status: 1).message, "tools hub pr fetch exited 1: boom",
                       "stderr wins when it says something")
        let indented = failure(stderr: "    error: {\n      \"x\": 1\n    }\n", status: 1)
        XCTAssertFalse(indented.named, "an indented error: is a field of a log entry, not Commander's line")
    }

    func testAPreambleBeforeTheJSONIsDropped() throws {
        let bridge = ToolsBridge(binaryPath: "/bin/sh", server: nil)
        let data = try bridge.json(["-c", #"printf 'warning: a banner {x}\n[profile:y] 1ms\n{"rows":[1]}\n'"#])
        XCTAssertEqual(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines), #"{"rows":[1]}"#)
        XCTAssertThrowsError(try bridge.json(["-c", "printf 'nothing to read'"])) { error in
            XCTAssertTrue("\(error)".contains("no JSON object"), "\(error)")
        }
    }

    func testANonZeroExitWithJSONOnStdoutKeepsBothStreams() throws {
        let bridge = ToolsBridge(binaryPath: "/bin/sh", server: nil)
        let argv = ["-c", #"printf '{"error":"origin refused the fetch","code":"auth"}'; echo detail >&2; exit 1"#]
        let capture = try bridge.capture(argv)
        XCTAssertEqual(capture.status, 1)
        XCTAssertEqual(String(decoding: capture.stdout, as: UTF8.self), #"{"error":"origin refused the fetch","code":"auth"}"#)
        XCTAssertEqual(String(decoding: capture.stderr, as: UTF8.self), "detail\n")
        XCTAssertThrowsError(try bridge.output(argv)) { error in
            let failure = error as? ToolsFailure
            XCTAssertEqual(failure?.message, "origin refused the fetch")
            XCTAssertEqual(failure?.code, "auth")
            XCTAssertEqual(failure?.exitCode, 1)
            XCTAssertEqual(failure?.stderrTail, "detail")
        }
        XCTAssertEqual(try bridge.output(["-c", "printf ok"]), Data("ok".utf8))
    }

    func testAProcessChildGetsTheAllowlistOnly() throws {
        let allowed = ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "HTTPS_PROXY", "no_proxy",
                       "LANG", "LC_ALL", "TMPDIR", "GITLAB_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "GENESIS_TOOLS_HOME",
                       "GENESIS_HUB_SERVER", "PROFILE", "PROFILE_TO_STDERR"]
        for key in allowed { XCTAssertTrue(ToolsBridge.allowsEnvironmentKey(key), key) }
        // The names the hub's calls had before they moved onto the list (whole environment until 2026-11-10).
        let fromTheWholeEnvironment = [
            "GITHUB_PERSONAL_ACCESS_TOKEN", "TOOLS_SKIP_AUTOINSTALL", "TOOLS_AUTOINSTALL", "GENESIS_TOOLS_NO_EXEC",
            "GENESIS_TOOLS_MASTER_KEY", "XDG_CONFIG_HOME", "GITLAB_PROJECT", "T3CODE_HOME", "LC_TIME", "GENESIS_TOOLS_APP_HOME",
            "CODEBUFF_DATA_DIR", "KIMI_DATA_DIR", "OPENCLAW_DIR", "HERMES_HOME", "GOOSE_PATH_ROOT",
        ]
        for key in fromTheWholeEnvironment { XCTAssertTrue(ToolsBridge.allowsEnvironmentKey(key), key) }
        for key in ["AWS_SECRET_ACCESS_KEY", "DATABASE_URL", "OPENAI_API_KEY", "GITHUBX", "GIT", "XGIT_DIR"] {
            XCTAssertFalse(ToolsBridge.allowsEnvironmentKey(key), key)
        }
        // A repository location from a git hook's environment would point every child's git at that repository.
        for key in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY",
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE"] {
            XCTAssertFalse(ToolsBridge.allowsEnvironmentKey(key), key)
        }
        let scrubbed = ToolsBridge.scrubbedEnvironment(from: ["GIT_SSH_COMMAND": "ssh -i k", "GH_TOKEN": "t", "LEAK": "x"])
        XCTAssertEqual(scrubbed["GIT_SSH_COMMAND"], "ssh -i k")
        XCTAssertEqual(scrubbed["GH_TOKEN"], "t")
        XCTAssertNil(scrubbed["LEAK"])

        // A bridge's additions pass only when the allowlist has them; the trace id always does.
        let bridge = ToolsBridge(binaryPath: "/bin/sh", server: nil, childEnvironment: { argv in
            argv.last == "probe" ? ["PROFILE": "hub-pr", "PROFILE_TO_STDERR": "0", "NOT_ALLOWED": "leak"] : [:]
        })
        let script = #"printf '%s|%s|%s|%s' "$PROFILE" "$PROFILE_TO_STDERR" "${NOT_ALLOWED:-none}" "${GENESIS_TOOLS_TRACE_ID:+traced}""#
        let out = try bridge.output(["-c", script, "probe"])
        XCTAssertEqual(String(decoding: out, as: UTF8.self), "hub-pr|0|none|traced")

        let git = ToolsBridge(binaryPath: "/bin/sh", server: nil, childEnvironment: { _ in
            ["GIT_AUTHOR_NAME": "Alice", "GIT_DIR": "/fixture/hook-repo/.git"]
        })
        let gitOut = try git.output(["-c", #"printf '%s|%s' "$GIT_AUTHOR_NAME" "${GIT_DIR:-none}""#])
        XCTAssertEqual(String(decoding: gitOut, as: UTF8.self), "Alice|none", "a child gets git's settings, never a hook's repository")
    }

    func testAFakeServerAnswersFirstAndAnArgvWithoutADoorRunsTheProcess() throws {
        let server = try FakeServer { request in
            let id = request["id"] as? Int ?? 0
            let argv = request["argv"] as? [String] ?? []
            if argv.first == "-c", argv.last == "door" {
                return [["id": id, "ok": true, "stdout": "from-server\n", "stderr": "", "exit": 0, "ms": 2]]
            }
            if argv.last == "late" {
                return [["id": id, "ok": true, "stdout": "", "stderr": "hub server: late exceeded 5000 ms\n", "exit": 124, "ms": 5000]]
            }
            return [["id": id, "ok": false, "code": "unsupported"]]
        }
        defer { server.stop() }
        let bridge = ToolsBridge(binaryPath: "/bin/sh", server: ToolsServerClient(socketPath: server.path))
        XCTAssertEqual(try bridge.output(["-c", "printf from-process", "door"]), Data("from-server\n".utf8))
        XCTAssertEqual(try bridge.output(["-c", "printf from-process", "other"]), Data("from-process".utf8))
        XCTAssertEqual(try bridge.output(["-c", "printf from-process", "late"]), Data("from-process".utf8),
                       "the server's own deadline is no answer: the process runs")
    }

    func testACancelStopsTheChildAndAStopReturnsWhatItFinished() async throws {
        let sleeper = ToolsBridge(binaryPath: "/bin/sleep", server: nil)
        let started = Date()
        let task = Task { try await sleeper.captureCancellable(["30"], timeout: 60) }
        try await Task.sleep(nanoseconds: 300_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled capture returned instead of throwing")
        } catch is CancellationError {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the cancel waited for the child's own end")

        // On TERM the child finishes its work and answers, as a widget send past its cancel point does.
        let shell = ToolsBridge(binaryPath: "/bin/sh", server: nil)
        let stopped = Task { try await shell.captureStoppable(["-c", "trap 'kill $!; echo finished; exit 0' TERM; sleep 30 & wait"]) }
        try await Task.sleep(nanoseconds: 300_000_000)
        stopped.cancel()
        let run = try await stopped.value
        XCTAssertTrue(run.stopped)
        XCTAssertEqual(run.capture.status, 0)
        XCTAssertEqual(String(decoding: run.capture.stdout, as: UTF8.self), "finished\n")
    }

    func testAProcessThatOutlivesTheLimitIsKilled() {
        let started = Date()
        XCTAssertThrowsError(try ToolsBridge(binaryPath: "/bin/sleep", server: nil).capture(["30"], timeout: 1)) { error in
            XCTAssertEqual(error as? ToolsBridgeError, .timeout(seconds: 1, command: "tools 30"))
            XCTAssertEqual("\(error)", "tools 30 did not finish within 1 s", "the text names the call and its limit")
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 6)
    }

    /// `Int(0.5)` is 0: a half-second limit ran nothing and failed at once. It rounds up to 1 s.
    func testAFractionalLimitRoundsUpToAWholeSecond() throws {
        XCTAssertEqual(ToolsBridge.limitSeconds(0.5), 1)
        XCTAssertEqual(ToolsBridge.limitSeconds(0), 1)
        XCTAssertEqual(ToolsBridge.limitSeconds(1.2), 2)
        let capture = try ToolsBridge(binaryPath: "/bin/sh", server: nil).capture(["-c", "printf ran"], timeout: 0.5)
        XCTAssertEqual(String(decoding: capture.stdout, as: UTF8.self), "ran")
    }

    /// The sandbox-home case: a face on `GENESIS_TOOLS_HOME` or a worktree's `GENESIS_TOOLS_BIN` never asks the
    /// resident server, which reads the real home with the main checkout's code.
    func testTheServerChoiceKeepsASandboxHomeOffTheRealServer() {
        XCTAssertTrue(ToolsServerClient.allowsResidentServer(environment: [:], preview: false))
        XCTAssertTrue(ToolsServerClient.allowsResidentServer(environment: ["GENESIS_HUB_SERVER": "1"], preview: false))
        XCTAssertFalse(ToolsServerClient.allowsResidentServer(environment: ["GENESIS_TOOLS_HOME": "/tmp/sandbox"], preview: false))
        XCTAssertFalse(ToolsServerClient.allowsResidentServer(environment: ["GENESIS_TOOLS_BIN": "/tmp/wt/tools"], preview: false))
        XCTAssertFalse(ToolsServerClient.allowsResidentServer(environment: ["GENESIS_HUB_SERVER": "0"], preview: false))
        XCTAssertFalse(ToolsServerClient.allowsResidentServer(environment: [:], preview: true))
        XCTAssertNil(ToolsServerClient.resident(environment: ["GENESIS_TOOLS_HOME": "/tmp/sandbox"], preview: false, startServer: {}))
        XCTAssertNotNil(ToolsServerClient.resident(environment: [:], preview: false, startServer: {}))
    }
}
