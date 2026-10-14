import XCTest
@testable import GenesisTools

/// The vault approval window's pure parts (Sources/VaultUnlock.swift): reading a process from the kernel's bytes,
/// what counts as the same tool for a remembered approval, and what the window tells the user.
final class VaultUnlockTests: XCTestCase {
    private func procArgsBytes(argc: Int32, executable: String, arguments: [String], environment: [String]) -> [UInt8] {
        var bytes = withUnsafeBytes(of: argc.littleEndian) { Array($0) }
        bytes += Array(executable.utf8) + [0, 0, 0, 0]
        for argument in arguments {
            bytes += Array(argument.utf8) + [0]
        }

        for entry in environment {
            bytes += Array(entry.utf8) + [0]
        }

        // The environment ends at an empty entry; the "apple" strings after it are not environment.
        bytes += [0] + Array("executable_path=/x".utf8) + [0]
        return bytes
    }

    private func caller(arguments: [String], environment: [String] = [], ancestors: [(pid_t, String)] = []) -> VaultCaller {
        VaultCaller(pid: 4242, executable: "/Users/alice/.genesis-tools/bin/gt-claude",
                    args: ProcArgs(executable: "/Users/alice/.genesis-tools/bin/gt-claude", arguments: arguments, environment: environment),
                    cwd: "/Users/alice/project", ancestors: ancestors.map { (pid: $0.0, command: $0.1) })
    }

    func testTheKernelBytesSplitIntoExecutableArgumentsAndEnvironment() throws {
        let bytes = procArgsBytes(argc: 3, executable: "/Users/alice/.genesis-tools/bin/gt-claude",
                                  arguments: ["gt-claude", "/repo/src/claude/index.ts", "info"],
                                  environment: ["CLAUDE_CODE_SESSION_ID=0f3a", "HOME=/Users/alice"])
        let parsed = try XCTUnwrap(VaultProcess.parseProcArgs(bytes))

        XCTAssertEqual(parsed.executable, "/Users/alice/.genesis-tools/bin/gt-claude")
        XCTAssertEqual(parsed.arguments, ["gt-claude", "/repo/src/claude/index.ts", "info"])
        XCTAssertEqual(parsed.environment, ["CLAUDE_CODE_SESSION_ID=0f3a", "HOME=/Users/alice"])
        XCTAssertEqual(parsed.environmentValue("CLAUDE_CODE_SESSION_ID"), "0f3a")
    }

    func testTheScriptIsPartOfTheIdentityAndLoadersBlockRemembering() {
        XCTAssertEqual(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts", "info"]).script, "/repo/src/claude/index.ts")
        XCTAssertEqual(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"]).injected, [])
        XCTAssertFalse(caller(arguments: ["gt-claude", "--preload", "/tmp/x.ts", "/repo/src/claude/index.ts"]).injected.isEmpty)
        XCTAssertFalse(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"], environment: ["DYLD_INSERT_LIBRARIES=/tmp/x.dylib"]).injected.isEmpty)
        XCTAssertEqual(VaultWindow.choices(rememberable: false), [0], "with extra code loaded, only allow once")
    }

    func testARememberedApprovalCoversOnlyTheSameToolExecutableAndScriptUntilItEnds() {
        let key = VaultGrants.key(tool: "claude", executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts")
        let grant = VaultGrant(key: key, tool: "claude", executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts",
                               grantedAt: 1_000, until: 2_000, method: "touch-id")
        let file = VaultGrants.remember(grant, now: 1_000, in: VaultGrantsFile(version: 1, grants: []))

        XCTAssertNotNil(VaultGrants.live(key, now: 1_500, in: file))
        XCTAssertNil(VaultGrants.live(key, now: 2_000, in: file), "a timed approval ends")
        XCTAssertNil(VaultGrants.live(VaultGrants.key(tool: "claude", executable: "/bin/gt-claude", script: "/tmp/other.ts"), now: 1_500, in: file))
        XCTAssertNil(VaultGrants.live(VaultGrants.key(tool: "say", executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts"), now: 1_500, in: file))

        var always = grant
        always.until = nil
        XCTAssertNotNil(VaultGrants.live(key, now: Int64.max, in: VaultGrants.remember(always, now: 1_000, in: file)), "always lasts until revoked")
    }

    func testTheWindowSaysWhyWhatWhoAndWhichSession() {
        let params = VaultUnlockParams(tool: "claude", purpose: "match the session's token to an account for the statusline",
                                       secret: "ai/acc_work/longLivedToken", command: "tools claude info")
        let who = caller(arguments: ["gt-claude", "/repo/src/claude/index.ts", "info"],
                         environment: ["CLAUDE_CODE_SESSION_ID=0f3a-session", "CMUX_SURFACE_ID=surface-9"],
                         ancestors: [(100, "GenesisTools gt-claude"), (90, "zsh"), (80, "claude")])
        let session = VaultSession.describe(who)
        let body = VaultWindow.body(params, caller: who, session: session)

        XCTAssertEqual(session, "Claude Code session 0f3a-session, cmux tab surface-9")
        XCTAssertTrue(body.contains("Why: match the session's token to an account for the statusline"))
        XCTAssertTrue(body.contains("It was reading: ai/acc_work/longLivedToken"))
        XCTAssertTrue(body.contains("Executable: /Users/alice/.genesis-tools/bin/gt-claude"))
        XCTAssertTrue(body.contains("Script: /repo/src/claude/index.ts"))
        XCTAssertTrue(body.contains("Started by: GenesisTools gt-claude (100) ← zsh (90) ← claude (80)"))
        XCTAssertTrue(body.contains("Session: Claude Code session 0f3a-session"))
        XCTAssertFalse(body.contains("Extra code"))
    }

    func testASecondRequestFromTheSameToolGetsNoSecondWindow() throws {
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("vault-window-test-\(UUID().uuidString).lock")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let first = try XCTUnwrap(VaultWindowLock.acquire(path))

        XCTAssertNil(VaultWindowLock.acquire(path), "the first window holds the lock")
        close(first)
        XCTAssertNotNil(VaultWindowLock.acquire(path), "a closed window frees it")
        XCTAssertNotEqual(VaultWindowLock.path(for: "vault|claude|/a|"), VaultWindowLock.path(for: "vault|say|/a|"))
    }

    func testWithoutASessionIdTheAgentInTheParentChainNamesIt() {
        let who = caller(arguments: ["gt-say", "/repo/src/say/index.ts"], ancestors: [(90, "zsh"), (80, "codex exec")])

        XCTAssertEqual(VaultSession.describe(who), "codex exec (pid 80)")
    }
}
