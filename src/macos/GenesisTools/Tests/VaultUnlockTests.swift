import GenesisKit
import SwiftUI
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

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

    func testVaultRecipientRequiresTheCallerToBeTheOnlyPeerHolder() {
        let identity = VaultRecipient.Identity(pid: 42, startSeconds: 100, startMicroseconds: 7, executable: "/bin/client")
        let channels: [(VaultRecipient.Endpoint, VaultRecipient.Endpoint)] = [
            (.pipe(handle: 10, peer: 20), .pipe(handle: 20, peer: 10)),
            (.socket(pcb: 10, peer: 20), .socket(pcb: 20, peer: 10)),
        ]
        for (output, peer) in channels {
            let caller = VaultRecipient.ProcessFDs(pid: 42, endpoints: [peer, peer])
            let unrelated = VaultRecipient.ProcessFDs(pid: 43, endpoints: [.pipe(handle: 30, peer: 40), output])
            XCTAssertNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                  processes: [caller, unrelated]), "duplicated fds in one process are allowed")
            let child = VaultRecipient.ProcessFDs(pid: 44, endpoints: [peer])
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                     processes: [caller, child]), "a forked reader denies release")
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                     processes: [child]), "the sole reader must be the verified caller")
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                     processes: [unrelated]), "no reader denies release")
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                     processes: [caller, .init(pid: 45, endpoints: nil)]))
        }
    }

    func testVaultRecipientInspectsProcessesThatStartDuringInspection() {
        let inspect = { (pid: pid_t) in VaultRecipient.ProcessFDs(pid: pid, endpoints: []) }
        var lists: [Set<pid_t>] = [[1, 2], [1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4]]
        let settled = VaultRecipient.settledTables(rounds: 16, list: { lists.removeFirst() }, inspect: inspect,
                                                   exited: { _ in false })
        XCTAssertEqual(settled?.map(\.pid), [1, 2, 3, 4], "a process that starts meanwhile is inspected, not a denial")

        var exits: [Set<pid_t>] = [[1, 2], [1], [1]]
        XCTAssertEqual(VaultRecipient.settledTables(rounds: 16, list: { exits.removeFirst() }, inspect: inspect,
                                                    exited: { $0 == 2 })?.map(\.pid), [1, 2])

        var uidChange: [Set<pid_t>] = [[1, 2], [1]]
        XCTAssertNil(VaultRecipient.settledTables(rounds: 16, list: { uidChange.removeFirst() }, inspect: inspect,
                                                  exited: { _ in false }), "a process that left without exiting denies")

        var next: pid_t = 10
        let neverSettles = VaultRecipient.settledTables(rounds: 4, list: { () -> Set<pid_t> in
            next += 1
            return Set(10...next)
        }, inspect: inspect, exited: { _ in false })
        XCTAssertNil(neverSettles, "a list that keeps growing past the rounds still denies")
    }

    func testVaultRecipientSkipsOnlyExitedOrPermissionDeniedSystemProcesses() {
        let identity = VaultRecipient.Identity(pid: 42, startSeconds: 100, startMicroseconds: 7, executable: "/bin/client")
        let output = VaultRecipient.Endpoint.pipe(handle: 10, peer: 20)
        let caller = VaultRecipient.ProcessFDs(pid: 42, endpoints: [.pipe(handle: 20, peer: 10)])
        let exited = VaultRecipient.ProcessFDs(pid: 43, endpoints: nil, failure: .exited)
        XCTAssertNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity, processes: [caller, exited]))
        for executable in ["/usr/bin/login", "/usr/sbin/service", "/usr/libexec/service", "/bin/sh", "/sbin/service", "/System/Library/service"] {
            let protected = VaultRecipient.ProcessFDs(pid: 43, endpoints: nil,
                failure: .unavailable(code: EPERM, executable: executable))
            XCTAssertNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                  processes: [caller, protected]), executable)
        }
        for executable in ["/Users/x/evil", "/usr/local/bin/evil", "/usr/bin-evil/program", "/Systematic/evil", "/usr/bin/../local/bin/evil", "/System/Volumes/Data/Users/x/evil", nil] {
            let unreadable = VaultRecipient.ProcessFDs(pid: 43, endpoints: nil,
                failure: .unavailable(code: EPERM, executable: executable))
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity,
                                                     processes: [caller, unreadable]))
        }
        let otherError = VaultRecipient.ProcessFDs(pid: 43, endpoints: nil,
            failure: .unavailable(code: EIO, executable: "/usr/bin/login"))
        XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity, processes: [caller, otherError]))
        let reader = VaultRecipient.ProcessFDs(pid: 43, endpoints: [.pipe(handle: 20, peer: 10)],
            failure: .unavailable(code: EPERM, executable: "/usr/bin/login"))
        XCTAssertEqual(VaultRecipient.rejection(stdout: output, caller: identity, current: identity, processes: [caller, reader]),
                       "another process holds the output", "readable holders are never skipped")
        XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity, processes: [exited]),
                        "skipping an exited caller cannot authorize release")
    }

    func testVaultRecipientRejectsChangedOrUnknownProcessIdentity() {
        let identity = VaultRecipient.Identity(pid: 42, startSeconds: 100, startMicroseconds: 7, executable: "/bin/client")
        let output = VaultRecipient.Endpoint.pipe(handle: 10, peer: 20)
        let processes = [VaultRecipient.ProcessFDs(pid: 42, endpoints: [.pipe(handle: 20, peer: 10)])]
        var changedSeconds = identity
        changedSeconds.startSeconds += 1
        var changedMicroseconds = identity
        changedMicroseconds.startMicroseconds += 1
        var changedPath = identity
        changedPath.executable = "/bin/other"
        var changedPid = identity
        changedPid.pid += 1
        for current in [changedSeconds, changedMicroseconds, changedPath, changedPid, nil] {
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: current, processes: processes))
        }
        XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: nil, current: identity, processes: processes))
    }

    func testVaultRecipientRejectsUnsupportedDisconnectedAndWrongKindEndpoints() {
        let identity = VaultRecipient.Identity(pid: 42, startSeconds: 100, startMicroseconds: 7, executable: "/bin/client")
        let processes = [VaultRecipient.ProcessFDs(pid: 42, endpoints: [.pipe(handle: 20, peer: 10)])]
        for output in [VaultRecipient.Endpoint.other, .pipe(handle: 10, peer: 0), .socket(pcb: 0, peer: 20),
                       .pipe(handle: 10, peer: 10), .socket(pcb: 10, peer: 20)] {
            XCTAssertNotNil(VaultRecipient.rejection(stdout: output, caller: identity, current: identity, processes: processes))
        }
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

        let relative = caller("/Users/alice/.bun/bin/bun", arguments: ["/Users/alice/.bun/bin/bun", "scratch/../scratch/x.ts"])
        XCTAssertEqual(relative.script, "/Users/alice/project/scratch/x.ts", "a relative script is the one in the caller's folder")

        let bare = caller("/Users/alice/.bun/bin/bun", arguments: ["/Users/alice/.bun/bin/bun", "repl"])
        XCTAssertNil(bare.script)
        XCTAssertEqual(bare.onceOnlyReason, "the script it runs is not known")
    }

    func testCheckoutUnderSourceParentUsesLastSourceSegment() {
        let root = "/work/src/GenesisTools"
        let preloads = VaultCaller.ownPreloads.flatMap { ["--preload", "\(root)/\($0)"] }
        let who = caller("/usr/bin/bun", arguments: ["bun"] + preloads + ["\(root)/src/claude/index.ts"])
        XCTAssertEqual(who.toolName, "claude")
        XCTAssertNil(who.onceOnlyReason)
        XCTAssertEqual(VaultWindowContent.programPath("\(root)/src/claude/index.ts"), "GenesisTools/src/claude/index.ts")
    }

    func testOtherInterpretersWithoutAKnownScriptCannotRememberOrMatchABroadGrant() {
        for name in ["Python", "python3.12", "pypy3", "ruby", "perl", "php", "lua", "tclsh", "osascript", "java", "pwsh", "sh", "bash", "zsh", "fish"] {
            let executable = "/usr/bin/\(name)"
            let who = caller(executable, arguments: [executable, "program.py"])
            XCTAssertTrue(who.isInterpreter, name)
            XCTAssertEqual(who.onceOnlyReason, "the script it runs is not known", name)
            let broad = VaultGrant(key: name, tool: name, executable: executable, script: nil,
                                   grantedAt: 1_000, until: nil, method: "touch-id")
            XCTAssertTrue(broad.isTooBroad, name)
            XCTAssertNil(VaultGrants.live(executable: executable, script: nil, now: 1_500,
                                          in: VaultGrantsFile(version: 1, grants: [broad])), name)
        }
        XCTAssertNil(caller("/usr/bin/python3", arguments: ["python3", "run", "/approved/script.ts"]).script)
        XCTAssertNil(caller("/usr/bin/bun", arguments: ["bun", "run", "run", "/approved/script.ts"]).script)
        XCTAssertFalse(caller("/usr/bin/native-client", arguments: ["native-client"]).isInterpreter)
        XCTAssertNil(caller("/usr/bin/native-client", arguments: ["native-client"]).onceOnlyReason)
    }

    func testInlineCodeAndUnknownLeadingFlagsCannotUseAnApprovedScriptGrant() {
        let executable = "/Users/alice/.bun/bin/bun"
        let script = "/repo/src/claude/index.ts"
        let grant = VaultGrant(key: "k", tool: "claude", executable: executable, script: script,
                               grantedAt: 1_000, until: nil, method: "touch-id")
        let file = VaultGrantsFile(version: 1, grants: [grant])
        for flags in [["--eval=arbitrary()"], ["--print=arbitrary()"], ["-e", "arbitrary()"], ["-p", "arbitrary()"],
                      ["--eval", "arbitrary()"], ["--print", "arbitrary()"], ["-e=arbitrary()"], ["-p=arbitrary()"], ["--unknown"]] {
            let who = caller(executable, arguments: [executable] + flags + [script])
            XCTAssertEqual(who.onceOnlyReason, "extra code may be loaded", flags.joined(separator: " "))
            let matched = who.onceOnlyReason == nil
                ? VaultGrants.live(executable: executable, script: who.script, now: 1_500, in: file) : nil
            XCTAssertNil(matched)
        }
    }

    func testVaultAuditRedactsBothFilesAndTheCommandHelp() throws {
        let home = (NSTemporaryDirectory() as NSString).appendingPathComponent("vault-audit-\(UUID().uuidString)")
        setenv("GENESIS_TOOLS_HOME", home, 1)
        defer { unsetenv("GENESIS_TOOLS_HOME"); try? FileManager.default.removeItem(atPath: home) }
        let token = "fixture-secret-never-real"
        let command = "tools claude config add work --token \(token)"
        let params = VaultUnlockParams(tool: "claude", purpose: "run \(command)", secret: nil, command: command)
        let who = caller(arguments: ["gt-claude", "/repo/src/claude/index.ts", "config", "add", "work", "--token", token])
        let content = VaultWindowContent.build(params, caller: who, session: VaultSessionInfo())
        let fact = try XCTUnwrap(content.details.first { $0.label == "Command" })
        XCTAssertFalse(content.purpose.contains(token))
        XCTAssertFalse((fact.help ?? "").contains(token))
        vaultAudit("prompted", params: params, caller: who, session: VaultSessionInfo(), shown: content)
        for path in [GateAudit.path, (VaultGrants.directory as NSString).appendingPathComponent("audit.jsonl")] {
            let text = try String(contentsOfFile: path, encoding: .utf8)
            XCTAssertFalse(text.contains(token), path)
            XCTAssertTrue(text.contains("[REDACTED]"), path)
            XCTAssertTrue(text.contains("config add work"), path)
        }
    }

    func testGrantTransactionsWaitForTheSharedPidLockAndReloadAfterRevocation() async throws {
        let directory = (NSTemporaryDirectory() as NSString).appendingPathComponent("vault-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let path = (directory as NSString).appendingPathComponent("vault-grants.json")
        let lock = path + ".lock"
        let old = VaultGrant(key: "old", tool: "old", executable: "/bin/native-old", script: nil,
                             grantedAt: 1_000, until: nil, method: "touch-id")
        let next = VaultGrant(key: "next", tool: "next", executable: "/bin/native-next", script: nil,
                              grantedAt: 1_000, until: nil, method: "touch-id")
        XCTAssertTrue(VaultGrants.save(VaultGrantsFile(version: 1, grants: [old]), to: path))
        try Data("\(getpid())\n".utf8).write(to: URL(fileURLWithPath: lock))
        let blocked = await VaultGrants.store(next, now: 1_500, to: path, timeout: 0)
        XCTAssertFalse(blocked, "a TypeScript lock must prevent the native write")
        XCTAssertEqual(VaultGrants.load(from: path).grants, [old])
        // The TypeScript revoker publishes its empty snapshot before releasing this lock.
        XCTAssertTrue(VaultGrants.save(VaultGrantsFile(version: 1, grants: []), to: path))
        try FileManager.default.removeItem(atPath: lock)
        let arbiter = lock + ".claim-arbitration.lock"
        try FileManager.default.createDirectory(atPath: arbiter, withIntermediateDirectories: false)
        let arbitrating = await VaultGrants.store(next, now: 1_500, to: path, timeout: 0)
        XCTAssertFalse(arbitrating, "the TypeScript claim/stale-takeover arbiter must also be respected")
        try FileManager.default.removeItem(atPath: arbiter)
        let stored = await VaultGrants.store(next, now: 1_500, to: path)
        XCTAssertTrue(stored)
        XCTAssertEqual(VaultGrants.load(from: path).grants, [next], "revoked grants are never resurrected")
        async let first = VaultGrants.store(old, now: 1_500, to: path)
        async let second = VaultGrants.store(next, now: 1_500, to: path)
        let results = await [first, second]
        XCTAssertEqual(results, [true, true])
        XCTAssertEqual(Set(VaultGrants.load(from: path).grants.map(\.key)), ["old", "next"])
    }

    func testLoaderEnvironmentAndUnreadableArgumentsCannotReuseNativeGrants() {
        let executable = "/usr/bin/native-client"
        let grant = VaultGrant(key: "native", tool: "native", executable: executable, script: nil,
                               grantedAt: 1_000, until: nil, method: "touch-id")
        let grants = VaultGrantsFile(version: 1, grants: [grant])
        for name in ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH"] {
            let who = caller(executable, arguments: [executable], environment: ["\(name)=/fixture/library"])
            XCTAssertTrue(who.injected.contains(name), name)
            XCTAssertEqual(who.onceOnlyReason, "extra code may be loaded", name)
            XCTAssertNil(who.onceOnlyReason == nil
                ? VaultGrants.live(executable: executable, script: nil, now: 1_500, in: grants) : nil)
        }
        var unreadable = caller(executable, arguments: [executable])
        unreadable.args = nil
        XCTAssertEqual(unreadable.onceOnlyReason, "the caller's arguments and environment could not be read")
        let normal = caller(executable, arguments: [executable], environment: ["PATH=/usr/bin", "NODE_OPTIONS=--conditions=fixture"])
        XCTAssertNil(normal.onceOnlyReason, "native code does not execute Node options")
        XCTAssertNotNil(VaultGrants.live(executable: executable, script: nil, now: 1_500, in: grants))
    }

    func testInterpreterEnvironmentChecksMatchTheAccountGateConservativePolicy() {
        let names = ["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_INSPECT_PRELOAD", "DENO_AUTH_TOKENS",
                     "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "PERLLIB",
                     "BASH_ENV", "ZDOTDIR", "ENV"]
        for name in names {
            let who = caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"], environment: ["\(name)=fixture"])
            XCTAssertTrue(who.injected.contains(name), name)
            XCTAssertEqual(who.onceOnlyReason, "extra code may be loaded", name)
        }
        XCTAssertFalse(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"], environment: ["NODE_OPTIONS="]).injected.isEmpty)
        XCTAssertNil(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"], environment: ["PATH=/usr/bin"]).onceOnlyReason)
    }

    func testLoadedExtraCodeAllowsOnlyOnce() {
        XCTAssertEqual(caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"]).injected, [])
        XCTAssertFalse(caller(arguments: ["gt-claude", "--preload", "/tmp/x.ts", "/repo/src/claude/index.ts"]).injected.isEmpty)
        XCTAssertFalse(caller(arguments: ["gt-claude", "run", "--preload", "/tmp/x.ts"]).injected.isEmpty)
        let injected = caller(arguments: ["gt-claude", "/repo/src/claude/index.ts"], environment: ["DYLD_INSERT_LIBRARIES=/tmp/x.dylib"])
        XCTAssertEqual(injected.onceOnlyReason, "extra code may be loaded")
    }

    func testGenesisToolsOwnPreloadsAreNotExtraCodeAndDoNotHideTheScript() {
        // `tools claude login-long admin` as the tools wrapper starts it (2026-10-15: the window named the preload as
        // the program and allowed it only once).
        let login = caller(arguments: ["gt-claude", "--preload", "/repo/src/utils/bun/preload-solid-scoped.ts",
                                       "--preload", "/repo/src/utils/search/stores/sqlite-vec-preload.ts",
                                       "/repo/src/claude/index.ts", "login-long", "admin"])
        XCTAssertEqual(login.script, "/repo/src/claude/index.ts")
        XCTAssertEqual(login.toolName, "claude")
        XCTAssertEqual(login.injected, [])
        XCTAssertNil(login.onceOnlyReason)

        // The gateway as the app's launcher starts it: the orphan watchdog comes first (2026-10-16: "Extra code may be
        // loaded" on every gateway start, so its approval could never be remembered).
        let gateway = caller(arguments: ["gt-mcp-manager", "--preload", "/repo/src/utils/bun/preload-orphan-watchdog.ts",
                                         "--preload", "/repo/src/utils/bun/preload-solid-scoped.ts",
                                         "--preload", "/repo/src/utils/search/stores/sqlite-vec-preload.ts",
                                         "/repo/src/mcp-manager/index.ts", "gateway", "start", "--supervised"])
        XCTAssertEqual(gateway.script, "/repo/src/mcp-manager/index.ts")
        XCTAssertEqual(gateway.injected, [])
        XCTAssertNil(gateway.onceOnlyReason)

        // The same file from another checkout, or another file in this one, is still extra code.
        let foreign = caller(arguments: ["gt-claude", "--preload", "/other/src/utils/bun/preload-solid-scoped.ts",
                                         "/repo/src/claude/index.ts"])
        XCTAssertEqual(foreign.script, "/repo/src/claude/index.ts")
        XCTAssertFalse(foreign.injected.isEmpty)
        let other = caller(arguments: ["gt-claude", "--preload=/repo/src/utils/bun/other.ts", "/repo/src/claude/index.ts"])
        XCTAssertFalse(other.injected.isEmpty)
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

    func testBunAndEveryGtLauncherAreOneProgramForTheSameScript() {
        let home = "/Users/alice"
        let daemon = "/repo/src/ai/commands/usage/poll-daemon.ts"
        let grant = VaultGrant(key: "k", tool: "ai", executable: "\(home)/.bun/bin/bun", script: daemon,
                               grantedAt: 1_000, until: nil, method: "touch-id")
        let file = VaultGrants.remember(grant, now: 1_000, in: VaultGrantsFile(version: 1, grants: []), home: home)

        for launcher in ["\(home)/.genesis-tools/bin/gt-codex", "\(home)/.genesis-tools/bin/gt-services", "\(home)/.bun/bin/bun"] {
            XCTAssertNotNil(VaultGrants.live(executable: launcher, script: daemon, now: 2_000, in: file, home: home), launcher)
        }

        XCTAssertNil(VaultGrants.live(executable: "/tmp/evil/bun", script: daemon, now: 2_000, in: file, home: home),
                     "a binary elsewhere that calls itself bun is not the runtime")
        XCTAssertNil(VaultGrants.live(executable: "\(home)/.genesis-tools/bin/sub/gt-x", script: daemon, now: 2_000, in: file, home: home))
        XCTAssertNil(VaultGrants.live(executable: "\(home)/.genesis-tools/bin/gt-codex", script: "/repo/src/other.ts",
                                      now: 2_000, in: file, home: home), "the script still decides")

        let again = VaultGrant(key: "k2", tool: "ai", executable: "\(home)/.genesis-tools/bin/gt-claude", script: daemon,
                               grantedAt: 3_000, until: nil, method: "touch-id")
        XCTAssertEqual(VaultGrants.remember(again, now: 3_000, in: file, home: home).grants, [again],
                       "one grant per runtime and script, not one per launcher")
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
        XCTAssertEqual(facts["Program"], "claude · repo/src/claude/index.ts")
        XCTAssertEqual(VaultWindowContent.programPath("/Users/alice/tools/run.ts", home: "/Users/alice"), "~/tools/run.ts")
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

        let daemon = caller("/Users/alice/.bun/bin/bun", arguments: ["/Users/alice/.bun/bin/bun", "run", "/repo/src/ai/commands/usage/poll-daemon.ts"],
                            ancestors: [(4904, "bun usage-supervisor.ts")])
        let content = VaultWindowContent.build(VaultUnlockParams(tool: "ai", purpose: "refresh", secret: nil, command: nil), caller: daemon,
                                               session: VaultSessionInfo(), home: "/Users/alice")
        XCTAssertEqual(content.facts.first?.value, "None: started by bun usage-supervisor.ts")
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

    /// Draws the real window into a window that is never shown, for review: `APPROVAL_SNAPSHOT_DIR=<dir>` writes
    /// `vault-window.png` and `vault-window-details.png`. Skipped otherwise.
    @MainActor
    func testRenderTheVaultWindowWhenAsked() throws {
        guard let dir = ProcessInfo.processInfo.environment["APPROVAL_SNAPSHOT_DIR"] else {
            throw XCTSkip("set APPROVAL_SNAPSHOT_DIR to render the window")
        }

        let daemon = caller("/Users/alice/.bun/bin/bun",
                            arguments: ["/Users/alice/.bun/bin/bun", "run", "/Users/alice/Projects/GenesisTools/src/ai/commands/usage/poll-daemon.ts"],
                            environment: ["CLAUDE_CODE_SESSION_ID=0f3a9c1e-5b7d-4e2a-9f10-2c4b6d8e0a13", "CMUX_SURFACE_ID=D5A60715-1C64-4556-ADB6-2D0B14E12FEB"],
                            ancestors: [(4904, "bun usage-supervisor.ts"), (812, "zsh"), (640, "claude")])
        let params = VaultUnlockParams(tool: "ai", purpose: "refresh the usage of every AI account (the usage daemon, once a minute in the background)",
                                       secret: "ai/acc_work/accessToken", command: nil)
        let session = VaultSessionInfo(sessionId: "0f3a9c1e-5b7d-4e2a-9f10-2c4b6d8e0a13", title: "review-loop", agent: nil,
                                       cmuxTab: "D5A60715-1C64-4556-ADB6-2D0B14E12FEB")
        let content = VaultWindowContent.build(params, caller: daemon, session: session, home: "/Users/alice")

        for (name, open) in [("vault-window", false), ("vault-window-details", true)] {
            let model = ApprovalDialogModel(
                title: content.title, purpose: content.purpose, symbol: "key.fill", facts: content.facts, details: content.details,
                warning: content.warning, footnote: VaultWindowContent.footnote, rememberChoices: VaultWindowContent.rememberChoices,
                rememberNote: nil, allowTitle: "Allow with Touch ID", deadline: Date().addingTimeInterval(170), identifier: "vault-unlock")
            model.showsDetails = open
            let host = NSHostingView(rootView: ApprovalDialogView(model: model)
                .background(Color(nsColor: .windowBackgroundColor))
                .environment(\.colorScheme, .dark))
            host.frame = CGRect(origin: .zero, size: host.fittingSize)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: .darkAqua)
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: (dir as NSString).appendingPathComponent("\(name).png")))
        }
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
