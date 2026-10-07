import XCTest
@testable import GenesisKit

final class ToolsBridgeTests: XCTestCase {
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
                XCTAssertEqual(error, .timeout(seconds: 1))
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
