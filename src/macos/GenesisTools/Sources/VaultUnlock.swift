// The vault key's approval window (`--rpc {"method":"vault.unlock"}`), Martin's DECISION 131 b (2026-10-15):
// "App approval window, but it probably should have enough context so i know exactly what / who / which session /
// triggered that and why (each caller should give that context possibly)".
//
// A `gt-<tool>` process needs the GenesisTools vault master key. Before this, each tool's own bun link read the
// keychain item and macOS asked "gt-claude wants to use your confidential information" with nothing to judge. Now the
// tool starts this process, and the app hands the key on after its own window.
//
// WHO comes from the kernel, never from the request: this process is the caller's child, so `getppid()` is the caller,
// and its executable, script, arguments, environment (the session ids), working folder and parent chain are read from
// there. WHY and WHAT come from the request, because only the caller knows them. A remembered approval for the same
// executable and script skips the window; otherwise Touch ID confirms an allow. Every outcome goes to the gate's audit
// log. A deny, a cancel, a failed authentication and a timeout all reply "deny" with a reason.
//
// Second version, after Martin's first look (2026-10-15 00:28, "this can be probably nicer", and "it wanted touchid
// and when i gave it it wanted password 2 times always"): a SwiftUI panel instead of an NSAlert (whose modal loop
// also kept the 170 s deadline from ever firing), `bun run <script>` read as the script it runs, and the app's own
// copy of the key, so the login-keychain password is asked once per key rather than on every allow.

import AppKit
import Darwin
import Foundation
import LocalAuthentication
import Security

struct VaultUnlockParams: Decodable {
    var tool: String
    var purpose: String
    var secret: String?
    var command: String?
}

/// `KERN_PROCARGS2` of a process: the executable path, then `argc` arguments, then the environment.
struct ProcArgs: Equatable {
    var executable: String
    var arguments: [String]
    var environment: [String]

    func environmentValue(_ name: String) -> String? {
        let prefix = "\(name)="
        return environment.first { $0.hasPrefix(prefix) }.map { String($0.dropFirst(prefix.count)) }
    }
}

/// What the kernel says about one process.
struct VaultCaller {
    var pid: pid_t
    var executable: String?
    var args: ProcArgs?
    var cwd: String?
    var ancestors: [(pid: pid_t, command: String)]

    private static let scriptExtensions = [".ts", ".tsx", ".js", ".mjs", ".cjs"]

    /// Interpreter flags whose value is the next argument (`--preload <file>`): that value is not the script.
    private static let valueFlags: Set<String> = [
        "--preload", "-r", "--require", "--import", "--loader", "--config", "--cwd", "--env-file",
    ]

    /// The preloads the `tools` wrapper passes to every tool, relative to the checkout the script is in. They are
    /// GenesisTools' own code, so they load no extra code (2026-10-15: every `tools claude login` could only be
    /// allowed once, and the window named the preload as the program).
    static let ownPreloads = [
        "src/utils/bun/preload-solid-scoped.ts", "src/utils/search/stores/sqlite-vec-preload.ts",
        "src/utils/bun/preload-orphan-watchdog.ts",
    ]

    /// The interpreter's flags before the script, each with its value (`--preload=x` or `--preload x`).
    private var leadingFlags: [(flag: String, value: String?)] {
        guard let arguments = args?.arguments, arguments.count > 1 else { return [] }
        var flags: [(flag: String, value: String?)] = []
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "run" { index += 1; continue }
            guard argument.hasPrefix("-") else { break }
            if let equals = argument.firstIndex(of: "=") {
                flags.append((String(argument[..<equals]), String(argument[argument.index(after: equals)...])))
                index += 1
            } else if Self.valueFlags.contains(argument) {
                flags.append((argument, index + 1 < arguments.count ? arguments[index + 1] : nil))
                index += 2
            } else {
                flags.append((argument, nil))
                index += 1
            }
        }
        return flags
    }

    /// Where the script sits in the arguments: after the interpreter's flags (and their values) and the `run` of
    /// `bun run <script>`.
    private var scriptIndex: Int? {
        guard let arguments = args?.arguments, arguments.count > 1 else { return nil }
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            if argument == "run" { index += 1; continue }
            guard argument.hasPrefix("-") else { break }
            index += !argument.contains("=") && Self.valueFlags.contains(argument) ? 2 : 1
        }

        guard index < arguments.count, Self.scriptExtensions.contains(where: arguments[index].hasSuffix) else { return nil }
        return index
    }

    /// The script an interpreter runs (`bun run …/src/ai/commands/usage/poll-daemon.ts`): with the executable, the
    /// identity a remembered approval is for.
    var script: String? {
        guard let raw = scriptIndex.flatMap({ args?.arguments[$0] }) else { return nil }
        if raw.hasPrefix("/") { return (raw as NSString).standardizingPath }
        // `bun scratch/x.ts` names a different program in every folder: remembered as typed, an approval matched
        // the same relative path anywhere (live check, 2026-10-15 00:49). Without the working folder it is unknown.
        guard let cwd else { return nil }
        return ((cwd as NSString).appendingPathComponent(raw) as NSString).standardizingPath
    }

    /// bun, node, deno, or a `gt-<tool>` link of bun: the program is the script, not the executable.
    var isInterpreter: Bool {
        let name = executable.map { ($0 as NSString).lastPathComponent } ?? ""
        return ["bun", "node", "deno"].contains(name) || name.hasPrefix("gt-")
    }

    /// The tool as GenesisTools names it, from the kernel's view: `src/<tool>/` in the script, else the `gt-<tool>` link.
    var toolName: String? {
        if let script, let range = script.range(of: #"/src/([^/]+)/"#, options: .regularExpression) {
            return String(script[range].dropFirst(5).dropLast())
        }

        let name = executable.map { ($0 as NSString).lastPathComponent } ?? ""
        return name.hasPrefix("gt-") ? String(name.dropFirst(3)) : nil
    }

    /// Flags and environment that load code the script path does not name. Any of them: no remembered approval.
    var injected: [String] {
        var found: [String] = []
        let environment = args?.environmentValue
        if let value = environment?("DYLD_INSERT_LIBRARIES"), !value.isEmpty {
            found.append("DYLD_INSERT_LIBRARIES")
        }

        for name in ["NODE_OPTIONS", "BUN_OPTIONS"] {
            if let value = environment?(name), ["--require", "-r ", "--import", "--loader", "--preload"].contains(where: value.contains) {
                found.append(name)
            }
        }

        // A checkout's own preloads are part of the program; any other preload, or any other loading flag, is not.
        let checkout = script.flatMap { path in path.range(of: "/src/").map { String(path[..<$0.lowerBound]) } }
        let own = Set(Self.ownPreloads.compactMap { relative in checkout.map { root in "\(root)/\(relative)" } })
        let foreign = leadingFlags.filter { flag in
            !(flag.flag == "--preload" && flag.value.map { value in own.contains((value as NSString).standardizingPath) } == true)
        }
        if foreign.contains(where: { ["--preload", "-r", "--require", "--import", "--loader"].contains($0.flag) }) {
            let shown = foreign.map { flag in flag.value.map { value in "\(flag.flag) \(value)" } ?? flag.flag }
            found.append("interpreter flags \(shown.joined(separator: " "))")
        }

        return found
    }

    /// Why this request can only be allowed once, or nil when an allow may be remembered.
    var onceOnlyReason: String? {
        if !injected.isEmpty { return "extra code may be loaded" }
        if isInterpreter, script == nil { return "the script it runs is not known" }
        return nil
    }
}

enum VaultProcess {
    /// Little-endian `argc`, the executable path, NUL padding, `argc` arguments, the environment up to an empty entry.
    static func parseProcArgs(_ bytes: [UInt8]) -> ProcArgs? {
        guard bytes.count > 4 else { return nil }
        let argc = Int(bytes[0]) | Int(bytes[1]) << 8 | Int(bytes[2]) << 16 | Int(bytes[3]) << 24
        var index = 4

        func next() -> String? {
            guard index < bytes.count else { return nil }
            let start = index
            while index < bytes.count, bytes[index] != 0 {
                index += 1
            }

            let value = String(decoding: bytes[start..<index], as: UTF8.self)
            index += 1
            return value
        }

        guard let executable = next() else { return nil }
        while index < bytes.count, bytes[index] == 0 {
            index += 1
        }

        var arguments: [String] = []
        for _ in 0..<max(0, argc) {
            guard let argument = next() else { break }
            arguments.append(argument)
        }

        var environment: [String] = []
        while let entry = next(), !entry.isEmpty {
            environment.append(entry)
        }

        return ProcArgs(executable: executable, arguments: arguments, environment: environment)
    }

    static func procArgs(_ pid: pid_t) -> ProcArgs? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else { return nil }
        return parseProcArgs(Array(buffer.prefix(size)))
    }

    static func path(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }

    static func cwd(_ pid: pid_t) -> String? {
        var info = proc_vnodepathinfo()
        let size = proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, Int32(MemoryLayout<proc_vnodepathinfo>.size))
        guard size > 0 else { return nil }
        return withUnsafePointer(to: info.pvi_cdir.vip_path) {
            String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self))
        }
    }

    static func parent(_ pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        guard size > 0, info.pbi_ppid > 0 else { return nil }
        return pid_t(info.pbi_ppid)
    }

    /// `name first-argument` of a process, short enough for one link of the chain.
    static func label(_ pid: pid_t) -> String {
        let name = path(pid).map { ($0 as NSString).lastPathComponent } ?? "pid \(pid)"
        let first = procArgs(pid)?.arguments.dropFirst().first { !$0.hasPrefix("-") }.map { ($0 as NSString).lastPathComponent }
        let text = [name, first].compactMap { $0 }.joined(separator: " ")
        return text.count > 60 ? String(text.prefix(59)) + "…" : text
    }

    static func caller(_ pid: pid_t) -> VaultCaller {
        var ancestors: [(pid: pid_t, command: String)] = []
        var current = parent(pid)
        while let ancestor = current, ancestor > 1, ancestors.count < 8 {
            ancestors.append((ancestor, label(ancestor)))
            current = parent(ancestor)
        }

        return VaultCaller(pid: pid, executable: path(pid), args: procArgs(pid), cwd: cwd(pid), ancestors: ancestors)
    }
}

/// The agent session the caller belongs to, from its own environment, its parent chain and the session's transcript.
struct VaultSessionInfo: Equatable {
    var sessionId: String?
    var title: String?
    var agent: String?
    var cmuxTab: String?

    /// "genesis-tools-native (Claude Code)", "Claude Code session 1b4001ba", "codex exec (pid 80)", or nil.
    var summary: String? {
        if let sessionId {
            return title.map { "\($0) (Claude Code)" } ?? "Claude Code session \(sessionId.prefix(8))"
        }

        return agent
    }
}

enum VaultSession {
    static func info(_ caller: VaultCaller, claudeHome: String) -> VaultSessionInfo {
        var info = VaultSessionInfo()
        if let id = caller.args?.environmentValue("CLAUDE_CODE_SESSION_ID"), !id.isEmpty {
            info.sessionId = id
            info.title = claudeTitle(sessionId: id, claudeHome: caller.args?.environmentValue("CLAUDE_CONFIG_DIR") ?? claudeHome)
        } else if let agent = caller.ancestors.first(where: { ["claude", "codex", "grok"].contains($0.command.split(separator: " ").first.map(String.init) ?? "") }) {
            info.agent = "\(agent.command) (pid \(agent.pid))"
        }

        if let tab = caller.args?.environmentValue("CMUX_SURFACE_ID"), !tab.isEmpty {
            info.cmuxTab = tab
        }

        return info
    }

    /// The session's name as Claude Code shows it, from the last 512 KB of its transcript (the title rows repeat).
    static func claudeTitle(sessionId: String, claudeHome: String) -> String? {
        let projects = (claudeHome as NSString).appendingPathComponent("projects")
        guard sessionId.range(of: #"^[A-Za-z0-9-]+$"#, options: .regularExpression) != nil,
              let folders = try? FileManager.default.contentsOfDirectory(atPath: projects) else { return nil }

        for folder in folders {
            let path = (projects as NSString).appendingPathComponent("\(folder)/\(sessionId).jsonl")
            guard let handle = FileHandle(forReadingAtPath: path) else { continue }
            defer { try? handle.close() }
            let size = (try? handle.seekToEnd()) ?? 0
            try? handle.seek(toOffset: size > 524_288 ? size - 524_288 : 0)
            guard let data = try? handle.readToEnd() else { return nil }
            return title(fromTranscriptTail: String(decoding: data, as: UTF8.self))
        }

        return nil
    }

    /// A name the user gave (`/rename`) beats the agent name, which beats the generated title; the last of each wins.
    static func title(fromTranscriptTail text: String) -> String? {
        for field in ["customTitle", "agentName", "aiTitle"] {
            let pattern = "\"\(field)\":\"((?:[^\"\\\\]|\\\\.)*)\""
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(text.startIndex..., in: text)
            guard let match = regex.matches(in: text, range: range).last,
                  let raw = Range(match.range(at: 1), in: text),
                  let value = try? JSONDecoder().decode(String.self, from: Data("\"\(text[raw])\"".utf8)),
                  !value.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            return value
        }

        return nil
    }
}

/// One remembered approval: this executable, this script. `tool` is for display and `revoke <tool>` only.
struct VaultGrant: Codable, Equatable {
    var key: String
    var tool: String
    var executable: String
    var script: String?
    var grantedAt: Int64
    /// Epoch milliseconds; nil means "always", until revoked with `tools ai gate revoke`.
    var until: Int64?
    var method: String

    func isLive(at now: Int64) -> Bool {
        until.map { $0 > now } ?? true
    }

    /// A grant without a script, for an interpreter, would cover every program it runs; the first version stored such
    /// grants for `bun run <script>` callers. They match nothing and go on the next write.
    var isTooBroad: Bool {
        guard script == nil else { return false }
        let name = (executable as NSString).lastPathComponent
        return ["bun", "node", "deno"].contains(name) || name.hasPrefix("gt-")
    }
}

struct VaultGrantsFile: Codable {
    var version: Int
    var grants: [VaultGrant]
}

enum VaultGrants {
    static func key(tool: String, executable: String, script: String?) -> String {
        "vault|\(tool)|\(executable)|\(script ?? "")"
    }

    static var directory: String {
        (genesisHome() as NSString).appendingPathComponent(".genesis-tools/ai/gate")
    }

    static var path: String {
        (directory as NSString).appendingPathComponent("vault-grants.json")
    }

    static func load(from path: String = path) -> VaultGrantsFile {
        guard let data = FileManager.default.contents(atPath: path),
              let file = try? JSONDecoder().decode(VaultGrantsFile.self, from: data) else {
            return VaultGrantsFile(version: 1, grants: [])
        }

        return file
    }

    /// The runtime a grant is keyed by. Bun and GenesisTools' `gt-<tool>` launchers are one program: every launcher is
    /// a hard link of `~/.bun/bin/bun`, and which one starts a script depends on the tool that spawned it. The usage
    /// daemon ran as bun, gt-services, gt-claude and gt-codex on one morning (2026-10-15), and each asked again for the
    /// same script after "Always". Only these paths count, so a binary elsewhere that calls itself bun still asks.
    static func runtime(of executable: String, home: String = genesisHome()) -> String {
        let bun = ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
        let launchers = "\(home)/.genesis-tools/bin/"
        let isLauncher = executable.hasPrefix(launchers) && (executable as NSString).lastPathComponent.hasPrefix("gt-")
            && !executable.dropFirst(launchers.count).contains("/")
        return bun.contains(executable) || isLauncher ? "bun" : executable
    }

    static func sameProgram(_ grant: VaultGrant, executable: String, script: String?, home: String = genesisHome()) -> Bool {
        grant.script == script && runtime(of: grant.executable, home: home) == runtime(of: executable, home: home)
    }

    static func live(executable: String, script: String?, now: Int64, in file: VaultGrantsFile,
                     home: String = genesisHome()) -> VaultGrant? {
        file.grants.last {
            sameProgram($0, executable: executable, script: script, home: home) && !$0.isTooBroad && $0.isLive(at: now)
        }
    }

    /// Replaces any grant for the same program and drops expired and too-broad ones.
    static func remember(_ grant: VaultGrant, now: Int64, in file: VaultGrantsFile,
                         home: String = genesisHome()) -> VaultGrantsFile {
        var next = file
        next.grants = file.grants.filter {
            !sameProgram($0, executable: grant.executable, script: grant.script, home: home) && !$0.isTooBroad
                && $0.isLive(at: now)
        } + [grant]
        return next
    }

    static func save(_ file: VaultGrantsFile, to path: String = path) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(file) else { return }
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let temporary = path + ".tmp-\(getpid())"
        guard FileManager.default.createFile(atPath: temporary, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        _ = rename(temporary, path)
    }
}

/// One open window per program: the usage daemon starts a process every minute, and without this each one would open
/// its own window while the first waits for an answer. The lock lives as long as this process (one request, one window).
enum VaultWindowLock {
    static func path(for key: String) -> String {
        let hash = key.utf8.reduce(UInt64(14_695_981_039_346_656_037)) { ($0 ^ UInt64($1)) &* 1_099_511_628_211 }
        return (VaultGrants.directory as NSString).appendingPathComponent("vault-window-\(String(hash, radix: 16)).lock")
    }

    /// The descriptor holding the lock, or nil when another process holds it. Never closed: the process exits with it.
    static func acquire(_ path: String) -> Int32? {
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let fd = open(path, O_CREAT | O_RDWR, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return nil
        }

        return fd
    }
}

/// What the window shows, built from the request, the kernel's caller and its session. Pure, so tests read it.
struct VaultWindowContent {
    var title: String
    var purpose: String
    var facts: [ApprovalFact]
    var details: [ApprovalFact]
    var warning: String?
    var onceOnlyReason: String?

    static let rememberChoices = [
        ApprovalRemember(seconds: 0, title: "Just this once"),
        ApprovalRemember(seconds: 8 * 3_600, title: "For 8 hours"),
        ApprovalRemember(seconds: 7 * 86_400, title: "For 7 days"),
        ApprovalRemember(seconds: nil, title: "Always for this program"),
    ]

    static let footnote = "The vault key unlocks every secret GenesisTools stores (AI account tokens and API keys), so an allowed program can read all of them."

    static func shortPath(_ path: String, home: String = NSHomeDirectory()) -> String {
        path == home ? "~" : path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    /// A script inside a project reads from the project's folder: `GenesisTools/src/ai/commands/usage/poll-daemon.ts`,
    /// not a home path cut in the middle (Martin's screenshot, 2026-10-15 00:46).
    static func programPath(_ path: String, home: String = NSHomeDirectory()) -> String {
        guard let range = path.range(of: "/src/") else { return shortPath(path, home: home) }
        let project = (String(path[..<range.lowerBound]) as NSString).lastPathComponent
        return project.isEmpty ? shortPath(path, home: home) : project + path[range.lowerBound...]
    }

    /// `ai/acc_work/apiKey` reads as `acc_work › apiKey`.
    static func secretLabel(_ secret: String) -> String {
        let parts = secret.split(separator: "/").map(String.init)
        return (parts.first == "ai" ? Array(parts.dropFirst()) : parts).joined(separator: " › ")
    }

    /// The caller's phrase as a sentence: capital first letter, a full stop at the end.
    static func sentence(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return trimmed }
        let capitalised = first.uppercased() + trimmed.dropFirst()
        return [".", "!", "?", ")"].contains(where: capitalised.hasSuffix) ? capitalised : capitalised + "."
    }

    static func build(_ params: VaultUnlockParams, caller: VaultCaller, session: VaultSessionInfo,
                      home: String = NSHomeDirectory()) -> VaultWindowContent {
        let tool = caller.toolName ?? params.tool
        let starter = caller.ancestors.last.map { "None: started by \($0.command)" } ?? "None: started by launchd"
        var facts = [ApprovalFact("Session", session.summary ?? starter)]

        if let script = caller.script {
            facts.append(ApprovalFact("Program", "\(tool) · \(programPath(script, home: home))",
                                      help: "\(caller.executable ?? "unknown") \(script)"))
        } else {
            facts.append(ApprovalFact("Program", "\(tool) · \(shortPath(caller.executable ?? "unknown", home: home))",
                                      help: caller.executable))
        }

        if let cwd = caller.cwd {
            facts.append(ApprovalFact("Folder", shortPath(cwd, home: home), help: cwd))
        }

        if let secret = params.secret, !secret.isEmpty {
            facts.append(ApprovalFact("Reading", secretLabel(secret), help: secret))
        }

        var details = [ApprovalFact("Process", "pid \(caller.pid)"),
                       ApprovalFact("Executable", caller.executable ?? "unknown", monospaced: true)]
        if let arguments = caller.args?.arguments, !arguments.isEmpty {
            let command = arguments.joined(separator: " ")
            details.append(ApprovalFact("Command", command.count > 400 ? String(command.prefix(399)) + "…" : command,
                                        help: command, monospaced: true))
        }

        if !caller.ancestors.isEmpty {
            details.append(ApprovalFact("Started by", caller.ancestors.map { "\($0.command) (\($0.pid))" }.joined(separator: " ← ")))
        }

        if let id = session.sessionId {
            details.append(ApprovalFact("Session ID", id, monospaced: true))
        }

        if let tab = session.cmuxTab {
            details.append(ApprovalFact("cmux tab", tab, monospaced: true))
        }

        let injected = caller.injected
        return VaultWindowContent(
            title: "“\(tool)” wants the vault key",
            purpose: sentence(params.purpose),
            facts: facts,
            details: details,
            warning: injected.isEmpty ? nil : "Extra code may be loaded (\(injected.joined(separator: ", "))). It can only be allowed once.",
            onceOnlyReason: caller.onceOnlyReason)
    }
}

/// The app's own copy of the key. The bun keychain rung created the `genesis-tools` item, so macOS asks for the login
/// password whenever another program (this app) reads it; Martin got that twice per allow. The app reads it once, keeps
/// a copy in an item it creates itself (its creator reads it without a prompt), and stamps the copy with the source
/// item's modification date, so a rotated key is read again. Reading attributes alone never prompts.
enum VaultKeychain {
    static let service = "genesis-tools"
    static let copyService = "genesis-tools-app-copy"
    static let account = "master-key"

    enum Outcome: Equatable {
        case key(String, fromCopy: Bool)
        case missing
        case failed(String)
    }

    /// The copy may answer only for the exact source it was taken from.
    static func copyIsCurrent(copyStamp: String?, sourceStamp: String?) -> Bool {
        guard let copyStamp, let sourceStamp else { return false }
        return copyStamp == sourceStamp
    }

    private static func query(_ service: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecMatchLimit as String: kSecMatchLimitOne]
    }

    private static func stamp(of service: String) -> (status: OSStatus, stamp: String?) {
        var request = query(service)
        request[kSecReturnAttributes as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        let attributes = item as? [String: Any]
        let date = attributes?[kSecAttrModificationDate as String] as? Date
        return (status, date.map { ISO8601DateFormatter().string(from: $0) })
    }

    private static func read(_ service: String) -> (status: OSStatus, value: String?, generic: String?) {
        var request = query(service)
        request[kSecReturnAttributes as String] = true
        request[kSecReturnData as String] = true
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        let attributes = item as? [String: Any]
        let value = (attributes?[kSecValueData as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
        let generic = (attributes?[kSecAttrGeneric as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
        return (status, value, generic)
    }

    private static func writeCopy(_ value: String, stamp: String) {
        let fields: [String: Any] = [kSecValueData as String: Data(value.utf8),
                                     kSecAttrGeneric as String: Data(stamp.utf8),
                                     kSecAttrLabel as String: "GenesisTools vault key (app copy)"]
        var lookup = query(copyService)
        lookup.removeValue(forKey: kSecMatchLimit as String)
        if SecItemUpdate(lookup as CFDictionary, fields as CFDictionary) == errSecItemNotFound {
            _ = SecItemAdd(lookup.merging(fields) { $1 } as CFDictionary, nil)
        }
    }

    static func key() -> Outcome {
        let source = stamp(of: service)
        if source.status == errSecItemNotFound { return .missing }

        let copy = read(copyService)
        if copy.status == errSecSuccess, let value = copy.value, copyIsCurrent(copyStamp: copy.generic, sourceStamp: source.stamp) {
            return .key(value, fromCopy: true)
        }

        let original = read(service)
        guard original.status == errSecSuccess, let value = original.value else {
            if original.status == errSecItemNotFound { return .missing }
            return .failed(SecCopyErrorMessageString(original.status, nil) as String? ?? "status \(original.status)")
        }

        if let stamp = source.stamp {
            writeCopy(value, stamp: stamp)
        }

        return .key(value, fromCopy: false)
    }
}

/// Every request's line in `audit.jsonl` carries what decides it (the command, its parents, the folder, any loaded-code
/// signal, why it is once-only) and, for `prompted`, everything the window showed, warnings included: an approval can
/// be audited later from the file alone (Martin, 2026-10-16).
private func vaultAudit(_ event: String, params: VaultUnlockParams, caller: VaultCaller, session: VaultSessionInfo, detail: String = "",
                        shown: VaultWindowContent? = nil) {
    var parts = ["purpose: \(params.purpose)"]
    if let secret = params.secret { parts.append("secret: \(secret)") }
    if let summary = session.summary { parts.append("session: \(summary)") }
    if let id = session.sessionId { parts.append("session id: \(id)") }
    if !detail.isEmpty { parts.append(detail) }

    var client: [String: Any] = ["name": caller.toolName ?? params.tool, "pid": Int(caller.pid)]
    client["executable"] = caller.executable
    client["script"] = caller.script
    client["cwd"] = caller.cwd
    client["argv"] = caller.args?.arguments
    client["parents"] = caller.ancestors.map { ["pid": Int($0.pid), "command": $0.command] }
    client["injected"] = caller.injected

    var entry: [String: Any] = [
        "at": ISO8601DateFormatter().string(from: Date()),
        "event": event,
        "client": client,
        "account": "vault",
        "detail": parts.joined(separator: "; "),
    ]
    entry["onceOnly"] = caller.onceOnlyReason
    if let shown {
        entry["shown"] = [
            "title": shown.title,
            "purpose": shown.purpose,
            "facts": (shown.facts + shown.details).map { ["label": $0.label, "value": $0.help ?? $0.value] },
            "warning": shown.warning as Any,
            "onceOnly": shown.onceOnlyReason as Any,
        ]
    }
    GateAudit.write(gate: "vault", event: event, entry)
    guard let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else { return }
    let path = (VaultGrants.directory as NSString).appendingPathComponent("audit.jsonl")
    try? FileManager.default.createDirectory(atPath: VaultGrants.directory, withIntermediateDirectories: true)
    if !FileManager.default.fileExists(atPath: path) {
        FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
    }

    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: data + Data("\n".utf8))
}

private func emitVaultKey(remembered: Bool) -> Never {
    switch VaultKeychain.key() {
    case let .key(key, fromCopy):
        logClick("vault.unlock key from=\(fromCopy ? "app copy" : "keychain item")")
        emitResult(["decision": "allow", "key": key, "remembered": remembered])
    case .missing:
        emitError(code: "no_key", message: "the keychain holds no genesis-tools master key", exitCode: 66)
    case let .failed(reason):
        emitError(code: "keychain", message: "GenesisTools could not read the vault key: \(reason)", exitCode: 74)
    }
}

private func vaultDeny(_ reason: String) -> Never {
    logClick("vault.unlock decision=deny reason=\(reason)")
    emitResult(["decision": "deny", "reason": reason])
}

@MainActor private let vaultPresenter = ApprovalPanelPresenter()

func unlockVault(_ params: VaultUnlockParams) {
    let caller = VaultProcess.caller(getppid())
    let session = VaultSession.info(caller, claudeHome: (NSHomeDirectory() as NSString).appendingPathComponent(".claude"))
    guard let executable = caller.executable else {
        vaultAudit("denied", params: params, caller: caller, session: session, detail: "the caller's executable could not be read")
        vaultDeny("the caller's executable could not be read")
    }

    let tool = caller.toolName ?? params.tool
    let rememberable = caller.onceOnlyReason == nil
    let key = VaultGrants.key(tool: tool, executable: executable, script: caller.script)
    let now = Int64(Date().timeIntervalSince1970 * 1_000)

    if rememberable, VaultGrants.live(executable: executable, script: caller.script, now: now, in: VaultGrants.load()) != nil {
        vaultAudit("remembered", params: params, caller: caller, session: session)
        emitVaultKey(remembered: true)
    }

    guard VaultWindowLock.acquire(VaultWindowLock.path(for: "vault|\(VaultGrants.runtime(of: executable))|\(caller.script ?? "")")) != nil else {
        vaultAudit("denied", params: params, caller: caller, session: session, detail: "an approval window for this program is already open")
        vaultDeny("an approval window for “\(tool)” is already open; answer that one first")
    }

    let deadlineSeconds = 170.0
    let content = VaultWindowContent.build(params, caller: caller, session: session)
    let biometric = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)

    DispatchQueue.main.async {
        let model = ApprovalDialogModel(
            title: content.title, purpose: content.purpose, symbol: "key.fill", facts: content.facts, details: content.details,
            warning: content.warning, footnote: VaultWindowContent.footnote,
            rememberChoices: rememberable ? VaultWindowContent.rememberChoices : [],
            rememberNote: content.onceOnlyReason.map { "Only once: \($0)" },
            allowTitle: biometric ? "Allow with Touch ID" : "Allow…",
            deadline: Date().addingTimeInterval(deadlineSeconds), identifier: "vault-unlock")

        // A modal loop would hold the main queue and this timer with it; the panel leaves the run loop free.
        let deadline = DispatchWorkItem {
            vaultAudit("denied", params: params, caller: caller, session: session, detail: "no answer within \(Int(deadlineSeconds)) s")
            vaultDeny("no answer within \(Int(deadlineSeconds)) s")
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + deadlineSeconds, execute: deadline)

        model.onDeny = {
            deadline.cancel()
            vaultPresenter.close()
            vaultAudit("denied", params: params, caller: caller, session: session, detail: "denied in the window")
            vaultDeny("denied in the approval window")
        }

        model.onAllow = { choice in
            // From the click on, Touch ID has the time the caller allows (180 s), not the window's deadline.
            deadline.cancel()
            vaultPresenter.close()
            let remember = choice?.seconds ?? 0
            authenticate(reason: "give “\(tool)” the GenesisTools vault key") { method, failure in
                DispatchQueue.main.async {
                    guard let method else {
                        vaultAudit("denied", params: params, caller: caller, session: session, detail: failure)
                        vaultDeny(failure)
                    }

                    let forever = rememberable && choice != nil && choice?.seconds == nil
                    if rememberable, remember != 0 || forever {
                        let until = forever ? nil : Optional(now + Int64(remember) * 1_000)
                        let grant = VaultGrant(key: key, tool: tool, executable: executable, script: caller.script,
                                               grantedAt: now, until: until, method: method)
                        VaultGrants.save(VaultGrants.remember(grant, now: now, in: VaultGrants.load()))
                    }

                    vaultAudit("allowed", params: params, caller: caller, session: session,
                               detail: "method: \(method); remembered: \(forever ? "always" : remember == 0 ? "once" : "\(remember / 3_600) h")")
                    logClick("vault.unlock decision=allow tool=\(tool) method=\(method)")
                    emitVaultKey(remembered: false)
                }
            }
        }

        vaultAudit("prompted", params: params, caller: caller, session: session, shown: content)
        vaultPresenter.present(model)
    }
}
