// The vault key with no approval window for agent-started commands on a list. Martin's DECISION 57 c (2026-11-10): "No
// window at all for agent-started commands on a list (warmup, usage), with a log line and a notification each time."
// The trigger: Grok Bot ran `tools claude warmup --all --json`, and the window could only allow it once, because Grok
// Bot (an Electron app) puts NODE_PATH into every shell it opens, and the gate never remembers such a request.
//
// The list lives in `~/.genesis-tools/ai/gate/vault-auto-allow.json`, written by `tools ai gate auto-allow`
// (src/utils/ai/gate/auto-allow.ts holds the same defaults). A request passes only when the script is a tool of the
// GenesisTools checkout this app was built from, run by Bun or a `gt-<tool>` launcher, the command is on the list, an
// agent process is among the caller's ancestors, and NODE_PATH is the only variable that loads extra code, with every
// entry inside the bundle of a listed agent app in /Applications (the value Grok Bot gives it; any other module folder
// could load code the script path does not name). Anything else still gets the window. Every pass writes an audit
// line, and a notification when `notify` is on.
//
// The file also lists GenesisTools' own background programs (`daemons`, decision 61 b of 2026-11-10: "A built-in list
// of GenesisTools' own daemons of the installed checkout gets the key with no window, with an audit line and a
// notification"). A daemon passes when its script is that file of the checkout this app was built from and bun itself
// runs it; who started it does not count. It reads the key about once a minute, so its notification comes at most once
// in `daemonNotifyHours`; the audit line is written for every pass.

import Foundation
import GenesisKitBase
import UserNotifications

struct VaultAutoAllowSettings: Decodable, Equatable {
    var enabled = true
    var notify = true
    var commands = ["claude warmup", "claude usage", "ai warmup", "ai usage"]
    var agentApps = ["Grok Bot"]
    /// GenesisTools' own background programs, each as its script's path from the checkout's root.
    var daemons = VaultAutoAllowSettings.ownDaemons
    /// Hours between two notifications for one daemon; 0 is one for every pass.
    var daemonNotifyHours = 24.0

    /// The usage daemon and the Codex daemon (src/utils/ai/gate/auto-allow.ts holds the same list).
    static let ownDaemons = ["src/ai/commands/usage/poll-daemon.ts", "src/codex/daemon.ts"]
    static let disabled = VaultAutoAllowSettings(enabled: false, notify: false, commands: [], agentApps: [], daemons: [])

    init(enabled: Bool = true, notify: Bool = true,
         commands: [String] = ["claude warmup", "claude usage", "ai warmup", "ai usage"], agentApps: [String] = ["Grok Bot"],
         daemons: [String] = VaultAutoAllowSettings.ownDaemons, daemonNotifyHours: Double = 24) {
        self.enabled = enabled
        self.notify = notify
        self.commands = commands
        self.agentApps = agentApps
        self.daemons = daemons
        self.daemonNotifyHours = daemonNotifyHours
    }

    /// A key the file leaves out keeps its default, as on the TypeScript side.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = VaultAutoAllowSettings()
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? defaults.enabled
        notify = try container.decodeIfPresent(Bool.self, forKey: .notify) ?? defaults.notify
        commands = try container.decodeIfPresent([String].self, forKey: .commands) ?? defaults.commands
        agentApps = try container.decodeIfPresent([String].self, forKey: .agentApps) ?? defaults.agentApps
        daemons = try container.decodeIfPresent([String].self, forKey: .daemons) ?? defaults.daemons
        daemonNotifyHours = max(0, try container.decodeIfPresent(Double.self, forKey: .daemonNotifyHours) ?? defaults.daemonNotifyHours)
    }

    private enum CodingKeys: String, CodingKey { case enabled, notify, commands, agentApps, daemons, daemonNotifyHours }

    static var path: String {
        (VaultGrants.directory as NSString).appendingPathComponent("vault-auto-allow.json")
    }

    /// A missing file is the defaults; a file that does not decode turns the feature off, so a typo never widens it.
    static func load(from path: String = path) -> VaultAutoAllowSettings {
        guard FileManager.default.fileExists(atPath: path) else { return VaultAutoAllowSettings() }
        guard let data = FileManager.default.contents(atPath: path),
              let settings = try? JSONDecoder().decode(VaultAutoAllowSettings.self, from: data) else {
            logClick("vault.unlock auto-allow off: \(path) does not decode")
            return .disabled
        }

        return settings
    }
}

struct VaultAutoAllowMatch: Equatable {
    /// `claude warmup`, as typed after `tools`: a list entry, never the caller's own arguments.
    var command: String
    /// Who started it, with no argument of any process: "Grok Bot" (a listed app), "codex (pid 80)" (a CLI's executable
    /// name and pid). A process label also carries its first argument, which can be a prompt, so it never goes here.
    var agent: String

    /// The `detail` of the `auto-allowed` audit line.
    var auditDetail: String { "command: tools \(command); agent: \(agent)" }
}

enum VaultAutoAllow {
    /// The one code-loading variable a pass tolerates: Electron agent apps put their own bundle's modules there.
    static let toleratedInjection = "NODE_PATH"

    /// Nothing loads extra code, or only NODE_PATH does and every entry of it lies inside the bundle of a listed agent
    /// app in /Applications. The name alone proves nothing: NODE_PATH=/tmp/x makes the script load modules from there.
    static func loadsOnlyTrustedCode(_ caller: VaultCaller, apps: [String]) -> Bool {
        let injected = caller.injected
        if injected.isEmpty { return true }
        guard injected == [toleratedInjection], let value = caller.args?.environmentValue(toleratedInjection) else { return false }
        return nodePath(value, isInsideBundlesOf: apps)
    }

    /// True when every entry of a NODE_PATH value (an empty one included) is an absolute path inside
    /// `/Applications/<app>.app/Contents/` for an app on the list, before and after its symbolic links are resolved.
    static func nodePath(_ value: String, isInsideBundlesOf apps: [String]) -> Bool {
        let bundles = apps.filter { !$0.isEmpty && !$0.contains("/") && $0 != "." && $0 != ".." }
            .map { "/Applications/\($0).app/Contents/" }
        guard !bundles.isEmpty else { return false }
        return value.split(separator: ":", omittingEmptySubsequences: false).allSatisfy { entry in
            guard entry.hasPrefix("/") else { return false }
            let standard = (String(entry) as NSString).standardizingPath
            let resolved = (standard as NSString).resolvingSymlinksInPath
            return bundles.contains { bundle in standard.hasPrefix(bundle) && resolved.hasPrefix(bundle) }
        }
    }

    /// The listed command and the agent behind it, or nil for the window. The executable must be Bun or a `gt-<tool>`
    /// launcher at their known paths (`VaultGrants.runtime`): the script path is only an argument, and any other program
    /// can pass it without running it. The subcommand must be the first argument after the script: with an option
    /// before it, the first bare word may be that option's value (`say --model voices`), so the command is unknown.
    static func match(caller: VaultCaller, settings: VaultAutoAllowSettings, trustedRoot: String?,
                      home: String = GenesisToolsHome.home()) -> VaultAutoAllowMatch? {
        guard settings.enabled, let trustedRoot, let executable = caller.executable,
              VaultGrants.runtime(of: executable, home: home) == "bun",
              let script = caller.script, caller.args != nil,
              loadsOnlyTrustedCode(caller, apps: settings.agentApps),
              let tool = tool(of: script, root: trustedRoot),
              let subcommand = caller.scriptArguments.first, !subcommand.hasPrefix("-") else { return nil }

        let command = "\(tool) \(subcommand)"
        guard settings.commands.contains(command),
              let agent = agent(caller: caller, apps: settings.agentApps) else { return nil }
        return VaultAutoAllowMatch(command: command, agent: agent)
    }

    /// The listed daemon a request is from: its script is that file of the checkout this app was built from, bun
    /// itself runs it (by path, or as the same file under another name), and nothing loads extra code besides the
    /// tolerated variable with an agent app's value. Who started it does not count: the daemon runner is no agent.
    static func daemon(caller: VaultCaller, settings: VaultAutoAllowSettings, trustedRoot: String?,
                       runtime: (String) -> String = { VaultGrants.runtime(of: $0) }) -> String? {
        guard settings.enabled, let trustedRoot, let script = caller.script, caller.args != nil,
              let executable = caller.executable, runtime(executable) == "bun",
              loadsOnlyTrustedCode(caller, apps: settings.agentApps) else { return nil }
        let root = (trustedRoot as NSString).standardizingPath
        return settings.daemons.first { entry in
            entry.hasPrefix("src/") && !entry.contains("..") && "\(root)/\(entry)" == script
        }
    }

    /// `<root>/src/<tool>/index.ts` (or `.tsx`) names `<tool>`; any other script names nothing.
    static func tool(of script: String, root: String) -> String? {
        let prefix = (root as NSString).standardizingPath + "/src/"
        guard script.hasPrefix(prefix) else { return nil }
        let parts = script.dropFirst(prefix.count).split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, ["index.ts", "index.tsx"].contains(String(parts[1])) else { return nil }
        return String(parts[0])
    }

    /// The agent among the caller's ancestors, from the kernel's process chain: a Claude, Codex or Grok CLI process, or
    /// a process named like a listed app. `CLAUDE_CODE_SESSION_ID` (any process can set it) proves nothing, and a session
    /// title is no label either: Claude Code generates it from the prompt. The label is the executable's name and pid.
    static func agent(caller: VaultCaller, apps: [String]) -> String? {
        for ancestor in caller.ancestors {
            if let name = ancestor.command.split(separator: " ").first.map(String.init),
               Harness.allCases.contains(where: { $0.binary == name }) {
                return "\(name) (pid \(ancestor.pid))"
            }

            if let app = apps.first(where: { ancestor.command == $0 || ancestor.command.hasPrefix($0 + " ") }) {
                return app
            }
        }

        return nil
    }

    /// The checkout this app was built from (the build manifest's `sourceRoot`), as its main checkout: a worktree's
    /// `.git` file names `<main>/.git/worktrees/<name>`.
    static func trustedRoot(home: String = GenesisToolsHome.home()) -> String? {
        let manifest = GenesisToolsHome.path("app/manifest.json", in: home)
        guard let data = FileManager.default.contents(atPath: manifest),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let source = object["sourceRoot"] as? String, !source.isEmpty else { return nil }
        return mainCheckout(of: source)
    }

    static func mainCheckout(of root: String) -> String {
        let standard = (root as NSString).standardizingPath
        let dotGit = (standard as NSString).appendingPathComponent(".git")
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dotGit, isDirectory: &isDirectory), !isDirectory.boolValue,
              let text = try? String(contentsOfFile: dotGit, encoding: .utf8),
              let line = text.split(separator: "\n").first, line.hasPrefix("gitdir: ") else { return standard }
        let gitdir = line.dropFirst("gitdir: ".count).trimmingCharacters(in: .whitespaces)
        guard let range = gitdir.range(of: "/.git/worktrees/") else { return standard }
        return (String(gitdir[..<range.lowerBound]) as NSString).standardizingPath
    }

    /// The notification's words: the listed command and the agent label, so no argument of any process appears.
    static func notificationText(_ match: VaultAutoAllowMatch) -> (title: String, body: String) {
        ("Vault key given to “tools \(match.command)”",
         "Started by \(match.agent). No window: the command is on the vault's auto-allow list (tools ai gate auto-allow).")
    }

    /// One notification per pass, no sound and no arguments (a command line can carry private values). Waits at most
    /// 2 s for Notification Center, because the process ends right after it hands the key on.
    static func notify(_ match: VaultAutoAllowMatch) {
        let text = notificationText(match)
        post(title: text.title, body: text.body)
    }

    /// A daemon's notification, at most once in `everyHours`: it reads the key about once a minute. A stamp that
    /// cannot be saved posts nothing, because one notification a minute is worse than none; the audit line names
    /// every pass.
    static func notifyDaemon(_ daemon: String, everyHours: Double, now: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)) {
        guard VaultDaemonNotices.reserve(daemon, now: now, everyHours: everyHours) else { return }
        post(title: "Vault key given to GenesisTools' own “\((daemon as NSString).lastPathComponent)”",
             body: "\(daemon) is on the vault's daemons list, so it gets the key with no window (tools ai gate auto-allow).")
    }

    private static func post(title: String, body: String) {
        guard NSClassFromString("XCTestCase") == nil, Bundle.main.bundlePath.hasSuffix(".app") else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = "vault.auto-allow"
        let done = DispatchSemaphore(value: 0)
        let request = UNNotificationRequest(identifier: "vault.auto-allow.\(UUID().uuidString)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { error in
            if let error { logClick("vault.unlock auto-allow notification failed: \(error.localizedDescription)") }
            done.signal()
        }
        if done.wait(timeout: .now() + 2) == .timedOut { logClick("vault.unlock auto-allow notification still pending after 2 s") }
    }
}

/// When each daemon's notification was posted last (epoch milliseconds, by the daemon's path from the checkout).
enum VaultDaemonNotices {
    static var path: String {
        (VaultGrants.directory as NSString).appendingPathComponent("vault-auto-allow-notified.json")
    }

    static func isDue(_ daemon: String, now: Int64, everyHours: Double, stamps: [String: Int64]) -> Bool {
        guard let last = stamps[daemon] else { return true }
        return Double(now - last) >= everyHours * 3_600_000
    }

    static func load(from path: String = path) -> [String: Int64] {
        guard let data = FileManager.default.contents(atPath: path) else { return [:] }
        return (try? JSONDecoder().decode([String: Int64].self, from: data)) ?? [:]
    }

    /// Reads the stamps, checks the daemon is due and saves its new stamp as one step, under a lock that other
    /// processes share: two unlock processes that read the same expired stamp can no longer both pass, and one
    /// daemon's stamp can no longer overwrite another's. True for the one process that may post.
    static func reserve(_ daemon: String, now: Int64, everyHours: Double, in path: String = path) -> Bool {
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let lock = open(path + ".lock", O_CREAT | O_RDWR, 0o600)
        guard lock >= 0 else {
            logClick("vault.unlock auto-allow: the daemon notification lock could not be opened")
            return false
        }

        defer { close(lock) }
        guard flock(lock, LOCK_EX) == 0 else { return false }
        defer { flock(lock, LOCK_UN) }
        guard isDue(daemon, now: now, everyHours: everyHours, stamps: load(from: path)) else { return false }
        return mark(daemon, now: now, in: path)
    }

    /// True when the stamp is on disk.
    static func mark(_ daemon: String, now: Int64, in path: String = path) -> Bool {
        var stamps = load(from: path)
        stamps[daemon] = now
        do {
            try JSONEncoder().encode(stamps).write(to: URL(fileURLWithPath: path), options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
            return true
        } catch {
            logClick("vault.unlock auto-allow: the daemon notification stamp was not saved: \(error.localizedDescription)")
            return false
        }
    }
}
