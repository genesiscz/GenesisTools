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

import Foundation
import UserNotifications

struct VaultAutoAllowSettings: Decodable, Equatable {
    var enabled = true
    var notify = true
    var commands = ["claude warmup", "claude usage", "ai warmup", "ai usage"]
    var agentApps = ["Grok Bot"]

    static let disabled = VaultAutoAllowSettings(enabled: false, notify: false, commands: [], agentApps: [])

    init(enabled: Bool = true, notify: Bool = true,
         commands: [String] = ["claude warmup", "claude usage", "ai warmup", "ai usage"], agentApps: [String] = ["Grok Bot"]) {
        self.enabled = enabled
        self.notify = notify
        self.commands = commands
        self.agentApps = agentApps
    }

    /// A key the file leaves out keeps its default, as on the TypeScript side.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let defaults = VaultAutoAllowSettings()
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? defaults.enabled
        notify = try container.decodeIfPresent(Bool.self, forKey: .notify) ?? defaults.notify
        commands = try container.decodeIfPresent([String].self, forKey: .commands) ?? defaults.commands
        agentApps = try container.decodeIfPresent([String].self, forKey: .agentApps) ?? defaults.agentApps
    }

    private enum CodingKeys: String, CodingKey { case enabled, notify, commands, agentApps }

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
                      home: String = genesisHome()) -> VaultAutoAllowMatch? {
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
    static func trustedRoot(home: String = genesisHome()) -> String? {
        let manifest = (home as NSString).appendingPathComponent(".genesis-tools/app/manifest.json")
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
        guard NSClassFromString("XCTestCase") == nil, Bundle.main.bundlePath.hasSuffix(".app") else { return }
        let text = notificationText(match)
        let content = UNMutableNotificationContent()
        content.title = text.title
        content.body = text.body
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
