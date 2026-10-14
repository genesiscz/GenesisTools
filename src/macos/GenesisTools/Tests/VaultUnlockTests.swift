import GenesisKit
import XCTest
@testable import GenesisTools

/// The vault approval window's pure parts (Sources/VaultUnlock.swift): reading a process from the kernel's bytes,
/// what counts as the same program for a remembered approval, the session's name, and what the window tells the user.
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

    private func caller(_ executable: String = "/Users/alice/.genesis-tools/bin/gt-claude", arguments: [String],
                        environment: [String] = [], ancestors: [(pid_t, String)] = []) -> VaultCaller {
        VaultCaller(pid: 4242, executable: executable,
                    args: ProcArgs(executable: executable, arguments: arguments, environment: environment),
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

    func testTheProgramIsTheScriptAnInterpreterRunsEvenThroughBunRun() {
        let daemon = caller("/Users/alice/.bun/bin/bun", arguments: ["/Users/alice/.bun/bin/bun", "run", "/repo/src/ai/commands/usage/poll-daemon.ts"])

        XCTAssertEqual(daemon.script, "/repo/src/ai/commands/usage/poll-daemon.ts", "the first version saw no script here")
        XCTAssertEqual(daemon.toolName, "ai")
        XCTAssertNil(daemon.onceOnlyReason)

        let hook = caller(arguments: ["gt-claude", "/repo/hooks/statusline.ts"])
        XCTAssertEqual(hook.toolName, "claude", "no src/<tool>/ in the script: the gt- link names the tool")

        let bare = caller("/Users/alice/.bun/bin/bun", arguments: ["/Users/alice/.bun/bin/bun", "repl"])
        XCTAssertNil(bare.script)
        XCTAssertEqual(bare.onceOnlyReason, "the script it runs is not known")
    }

    func testLoadedExtraCodeAllowsOnlyOnce() {
        XCTAssertEqual(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"]).injected, [])
        XCTAssertFalse(caller(arguments: ["gt-claude", "--preload", "/tmp/x.ts", "/repo/src/claude/index.ts"]).injected.isEmpty)
        XCTAssertFalse(caller(arguments: ["gt-claude", "run", "--preload", "/tmp/x.ts"]).injected.isEmpty)
        let injected = caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"], environment: ["DYLD_INSERT_LIBRARIES=/tmp/x.dylib"])
        XCTAssertEqual(injected.onceOnlyReason, "extra code may be loaded")
    }

    func testARememberedApprovalCoversOnlyTheSameExecutableAndScriptUntilItEnds() {
        let grant = VaultGrant(key: "k", tool: "claude", executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts",
                               grantedAt: 1_000, until: 2_000, method: "touch-id")
        let file = VaultGrants.remember(grant, now: 1_000, in: VaultGrantsFile(version: 1, grants: []))

        XCTAssertNotNil(VaultGrants.live(executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts", now: 1_500, in: file))
        XCTAssertNil(VaultGrants.live(executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts", now: 2_000, in: file), "a timed approval ends")
        XCTAssertNil(VaultGrants.live(executable: "/bin/gt-claude", script: "/tmp/other.ts", now: 1_500, in: file))
        XCTAssertNil(VaultGrants.live(executable: "/bin/gt-say", script: "/repo/src/claude/index.ts", now: 1_500, in: file))

        var always = grant
        always.until = nil
        XCTAssertNotNil(VaultGrants.live(executable: "/bin/gt-claude", script: "/repo/src/claude/index.ts", now: Int64.max,
                                         in: VaultGrants.remember(always, now: 1_000, in: file)), "always lasts until revoked")
    }

    func testAGrantWithoutAScriptForAnInterpreterMatchesNothingAndGoesOnTheNextWrite() {
        let broad = VaultGrant(key: "vault|bun|/Users/alice/.bun/bin/bun|", tool: "bun", executable: "/Users/alice/.bun/bin/bun",
                               script: nil, grantedAt: 1_000, until: nil, method: "touch-id")
        let file = VaultGrantsFile(version: 1, grants: [broad])

        XCTAssertNil(VaultGrants.live(executable: "/Users/alice/.bun/bin/bun", script: nil, now: 1_500, in: file))

        let next = VaultGrant(key: "k", tool: "say", executable: "/Users/alice/.bun/bin/bun", script: "/repo/src/say/index.ts",
                              grantedAt: 1_500, until: nil, method: "touch-id")
        XCTAssertEqual(VaultGrants.remember(next, now: 1_500, in: file).grants, [next])
    }

    func testTheWindowLeadsWithWhyThenSessionProgramFolderAndSecret() {
        let params = VaultUnlockParams(tool: "bun", purpose: "match this Claude session's token to a configured account, for the statusline",
                                       secret: "ai/acc_work/longLivedToken", command: "tools claude info")
        let who = caller(arguments: ["gt-claude", "/Users/alice/repo/src/claude/index.ts", "info"],
                         environment: ["CLAUDE_CODE_SESSION_ID=0f3a-session", "CMUX_SURFACE_ID=surface-9"],
                         ancestors: [(100, "GenesisTools gt-claude"), (90, "zsh"), (80, "claude")])
        let session = VaultSessionInfo(sessionId: "0f3a-session", title: "review-loop", agent: nil, cmuxTab: "surface-9")
        let content = VaultWindowContent.build(params, caller: who, session: session, home: "/Users/alice")
        let facts = Dictionary(uniqueKeysWithValues: content.facts.map { ($0.label, $0.value) })
        let details = Dictionary(uniqueKeysWithValues: content.details.map { ($0.label, $0.value) })

        XCTAssertEqual(content.title, "“claude” wants the vault key", "the kernel's tool, not the request's")
        XCTAssertEqual(content.purpose, "Match this Claude session's token to a configured account, for the statusline.")
        XCTAssertEqual(content.facts.map(\.label), ["Session", "Program", "Folder", "Reading"])
        XCTAssertEqual(facts["Session"], "review-loop (Claude Code)")
        XCTAssertEqual(facts["Program"], "claude · ~/repo/src/claude/index.ts")
        XCTAssertEqual(facts["Folder"], "~/project")
        XCTAssertEqual(facts["Reading"], "acc_work › longLivedToken")
        XCTAssertEqual(details["Started by"], "GenesisTools gt-claude (100) ← zsh (90) ← claude (80)")
        XCTAssertEqual(details["Session ID"], "0f3a-session")
        XCTAssertEqual(details["cmux tab"], "surface-9")
        XCTAssertNil(content.warning)
        XCTAssertNil(content.onceOnlyReason)
    }

    func testTheSessionIsNamedFromItsTranscript() throws {
        let tail = """
        {"type":"ai-title","aiTitle":"Generated title","sessionId":"s"}
        {"type":"agent-name","agentName":"old-name","sessionId":"s"}
        {"type":"custom-title","customTitle":"first","sessionId":"s"}
        {"type":"custom-title","customTitle":"review \\"loop\\"","sessionId":"s"}
        """
        XCTAssertEqual(VaultSession.title(fromTranscriptTail: tail), "review \"loop\"", "a /rename wins, the last one")
        XCTAssertEqual(VaultSession.title(fromTranscriptTail: #"{"agentName":"bot"}{"aiTitle":"x"}"#), "bot")
        XCTAssertNil(VaultSession.title(fromTranscriptTail: "{}"))

        let home = (NSTemporaryDirectory() as NSString).appendingPathComponent("vault-claude-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(atPath: home) }
        let folder = (home as NSString).appendingPathComponent("projects/-Users-alice-repo")
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try Data(tail.utf8).write(to: URL(fileURLWithPath: (folder as NSString).appendingPathComponent("0f3a-session.jsonl")))

        XCTAssertEqual(VaultSession.claudeTitle(sessionId: "0f3a-session", claudeHome: home), "review \"loop\"")
        XCTAssertNil(VaultSession.claudeTitle(sessionId: "../escape", claudeHome: home))
    }

    func testWithoutASessionIdTheAgentInTheParentChainNamesIt() {
        let who = caller(arguments: ["gt-say", "/repo/src/say/index.ts"], ancestors: [(90, "zsh"), (80, "codex exec")])

        XCTAssertEqual(VaultSession.info(who, claudeHome: "/nonexistent").summary, "codex exec (pid 80)")
    }

    func testTheAppCopyOfTheKeyAnswersOnlyForTheSourceItWasTakenFrom() {
        XCTAssertTrue(VaultKeychain.copyIsCurrent(copyStamp: "2026-07-29T02:41:12Z", sourceStamp: "2026-07-29T02:41:12Z"))
        XCTAssertFalse(VaultKeychain.copyIsCurrent(copyStamp: "2026-07-29T02:41:12Z", sourceStamp: "2026-10-15T00:00:00Z"), "a rotated key is read again")
        XCTAssertFalse(VaultKeychain.copyIsCurrent(copyStamp: nil, sourceStamp: "2026-07-29T02:41:12Z"))
        XCTAssertFalse(VaultKeychain.copyIsCurrent(copyStamp: "2026-07-29T02:41:12Z", sourceStamp: nil))
    }

    func testTheAccountGateWindowUsesTheSameLayout() throws {
        let json = """
        {"client":{"name":"Genesis","pid":11574,"executable":"/Applications/Genesis.app/Contents/MacOS/Genesis","cwd":"/",
          "ancestors":[{"pid":1,"command":"launchd"}],"isAncestor":true,"verified":false},
         "provider":"xai","account":{"id":"acc_1","name":"work","label":"alice@example.com"},"tokenKind":"api-key",
         "rememberChoicesSeconds":[0,28800,604800]}
        """
        let params = try JSONDecoder().decode(GateApproveParams.self, from: Data(json.utf8))
        let content = GateWindowContent.build(params, home: "/Users/alice")

        XCTAssertEqual(content.title, "“Genesis” wants the xai API key of work")
        XCTAssertTrue(content.purpose.hasPrefix("The API KEY itself is shared"))
        XCTAssertEqual(content.facts.map(\.label), ["Account", "Program", "Folder"])
        XCTAssertEqual(content.facts.first?.value, "work (alice@example.com) · xai")
        XCTAssertEqual(content.rememberChoices.map(\.title), ["Just this once", "For 8 hours", "For 7 days"])
        XCTAssertEqual(content.warning, "Unverified: its binary or script could not be established. It will not be remembered.")
    }

    func testASecondRequestFromTheSameProgramGetsNoSecondWindow() throws {
        let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("vault-window-test-\(UUID().uuidString).lock")
        defer { try? FileManager.default.removeItem(atPath: path) }
        let first = try XCTUnwrap(VaultWindowLock.acquire(path))

        XCTAssertNil(VaultWindowLock.acquire(path), "the first window holds the lock")
        close(first)
        XCTAssertNotNil(VaultWindowLock.acquire(path), "a closed window frees it")
        XCTAssertNotEqual(VaultWindowLock.path(for: "vault|/a|x.ts"), VaultWindowLock.path(for: "vault|/a|y.ts"))
    }
}
