// The vault key's approval window (`--rpc {"method":"vault.unlock"}`), Martin's DECISION 131 b (2026-10-15):
// "App approval window, but it probably should have enough context so i know exactly what / who / which session /
// triggered that and why (each caller should give that context possibly)".
//
// A `gt-<tool>` process needs the GenesisTools vault master key. Before this, each tool's own bun link read the
// keychain item and macOS asked "gt-claude wants to use your confidential information" with nothing to judge. Now the
// tool starts this process and the app reads the item as itself (macOS asks once, naming GenesisTools).
//
// WHO comes from the kernel, never from the request: this process is the caller's child, so `getppid()` is the caller,
// and its executable, arguments, environment (the session ids), working folder and parent chain are read from there.
// WHY and WHAT come from the request, because only the caller knows them. A remembered approval for the same tool,
// executable and script skips the window; otherwise Touch ID confirms an allow. Every outcome goes to the gate's audit
// log. A deny, a cancel, a failed authentication and a timeout all reply "deny" with a reason.

import AppKit
import Darwin
import Foundation
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

    /// The script an interpreter runs (`bun …/src/claude/index.ts`), part of the identity a grant is remembered for.
    var script: String? {
        guard let arguments = args?.arguments, arguments.count > 1 else { return nil }
        let candidate = arguments.dropFirst().first { !$0.hasPrefix("-") }
        guard let candidate, [".ts", ".tsx", ".js", ".mjs", ".cjs"].contains(where: candidate.hasSuffix) else { return nil }
        return candidate
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

        let flags = (args?.arguments.dropFirst() ?? []).prefix { $0.hasPrefix("-") }
        if flags.contains(where: { ["--preload", "-r", "--require", "--import", "--loader"].contains($0) }) {
            found.append("interpreter flags \(flags.joined(separator: " "))")
        }

        return found
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

/// The session the caller belongs to, from its own environment and its parent chain.
enum VaultSession {
    static func describe(_ caller: VaultCaller) -> String? {
        var parts: [String] = []
        if let id = caller.args?.environmentValue("CLAUDE_CODE_SESSION_ID"), !id.isEmpty {
            parts.append("Claude Code session \(id)")
        } else if let agent = caller.ancestors.first(where: { ["claude", "codex", "grok"].contains($0.command.split(separator: " ").first.map(String.init) ?? "") }) {
            parts.append("\(agent.command) (pid \(agent.pid))")
        }

        if let tab = caller.args?.environmentValue("CMUX_SURFACE_ID"), !tab.isEmpty {
            parts.append("cmux tab \(tab)")
        }

        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }
}

/// One remembered approval: this tool, this executable, this script.
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

    static func live(_ key: String, now: Int64, in file: VaultGrantsFile) -> VaultGrant? {
        file.grants.last { $0.key == key && $0.isLive(at: now) }
    }

    /// Replaces any grant for the same key and drops expired ones.
    static func remember(_ grant: VaultGrant, now: Int64, in file: VaultGrantsFile) -> VaultGrantsFile {
        var next = file
        next.grants = file.grants.filter { $0.key != grant.key && $0.isLive(at: now) } + [grant]
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

/// One open window per tool: the usage daemon starts a process every minute, and without this each one would open its
/// own window while the first waits for an answer. The lock lives as long as this process (one request, one window).
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

enum VaultWindow {
    static func title(_ params: VaultUnlockParams) -> String {
        "“\(params.tool)” asks for the GenesisTools vault key"
    }

    static func body(_ params: VaultUnlockParams, caller: VaultCaller, session: String?) -> String {
        var lines: [String] = ["Why: \(params.purpose)"]
        if let secret = params.secret, !secret.isEmpty {
            lines.append("It was reading: \(secret)")
        }

        lines.append("")
        lines.append("Who (read from the system, not from the request):")
        lines.append("Process: pid \(caller.pid)")
        lines.append("Executable: \(caller.executable ?? "unknown")")
        if let script = caller.script {
            lines.append("Script: \(script)")
        }

        if let arguments = caller.args?.arguments, !arguments.isEmpty {
            let command = arguments.joined(separator: " ")
            lines.append("Command: \(command.count > 300 ? String(command.prefix(299)) + "…" : command)")
        }

        if let cwd = caller.cwd {
            lines.append("Working dir: \(cwd)")
        }

        if !caller.ancestors.isEmpty {
            lines.append("Started by: " + caller.ancestors.map { "\($0.command) (\($0.pid))" }.joined(separator: " ← "))
        }

        lines.append("Session: \(session ?? "none found (not started from an agent session)")")
        if !caller.injected.isEmpty {
            lines.append("⚠️ Extra code may be loaded: \(caller.injected.joined(separator: ", ")). Allow once at most.")
        }

        lines.append("")
        lines.append("The vault key decrypts every secret GenesisTools stores (AI account tokens and API keys): an allowed tool can read all of them. Touch ID confirms an allow.")
        return lines.joined(separator: "\n")
    }

    static func choices(rememberable: Bool) -> [Int?] {
        rememberable ? [0, 8 * 3_600, 7 * 86_400, nil] : [0]
    }

    static func label(_ seconds: Int?) -> String {
        guard let seconds else { return "Always allow this tool" }
        if seconds == 0 { return "Allow once" }
        if seconds % 86_400 == 0 { return "Allow for \(seconds / 86_400) days" }
        return "Allow for \(seconds / 3_600) hours"
    }
}

private func vaultAudit(_ event: String, params: VaultUnlockParams, caller: VaultCaller, session: String?, detail: String = "") {
    var parts = ["purpose: \(params.purpose)"]
    if let secret = params.secret { parts.append("secret: \(secret)") }
    if let session { parts.append("session: \(session)") }
    if !detail.isEmpty { parts.append(detail) }

    let entry: [String: Any] = [
        "at": ISO8601DateFormatter().string(from: Date()),
        "event": event,
        "client": ["name": params.tool, "pid": Int(caller.pid), "executable": caller.executable ?? NSNull(), "cwd": caller.cwd ?? NSNull()],
        "account": "vault",
        "detail": parts.joined(separator: "; "),
    ]
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

/// The keychain item the bun rung writes (`genesis-tools` / `master-key`, base64), read as this app.
private func emitVaultKey(remembered: Bool) -> Never {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "genesis-tools",
        kSecAttrAccount as String: "master-key",
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)

    guard status == errSecSuccess, let data = item as? Data, let key = String(data: data, encoding: .utf8) else {
        if status == errSecItemNotFound {
            emitError(code: "no_key", message: "the keychain holds no genesis-tools master key", exitCode: 66)
        }

        let reason = SecCopyErrorMessageString(status, nil) as String? ?? "status \(status)"
        emitError(code: "keychain", message: "GenesisTools could not read the vault key: \(reason)", exitCode: 74)
    }

    emitResult(["decision": "allow", "key": key, "remembered": remembered])
}

private func vaultDeny(_ reason: String) -> Never {
    logClick("vault.unlock decision=deny reason=\(reason)")
    emitResult(["decision": "deny", "reason": reason])
}

func unlockVault(_ params: VaultUnlockParams) {
    let caller = VaultProcess.caller(getppid())
    let session = VaultSession.describe(caller)
    guard let executable = caller.executable else {
        vaultAudit("denied", params: params, caller: caller, session: session, detail: "the caller's executable could not be read")
        vaultDeny("the caller's executable could not be read")
    }

    let rememberable = caller.injected.isEmpty
    let key = VaultGrants.key(tool: params.tool, executable: executable, script: caller.script)
    let now = Int64(Date().timeIntervalSince1970 * 1_000)

    if rememberable, VaultGrants.live(key, now: now, in: VaultGrants.load()) != nil {
        vaultAudit("remembered", params: params, caller: caller, session: session)
        emitVaultKey(remembered: true)
    }

    guard VaultWindowLock.acquire(VaultWindowLock.path(for: key)) != nil else {
        vaultAudit("denied", params: params, caller: caller, session: session, detail: "an approval window for this tool is already open")
        vaultDeny("an approval window for “\(params.tool)” is already open; answer that one first")
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 170) {
        vaultAudit("denied", params: params, caller: caller, session: session, detail: "no answer within 170 s")
        vaultDeny("no answer within 170 s")
    }

    DispatchQueue.main.async {
        NSApplication.shared.activate(ignoringOtherApps: true)
        vaultAudit("prompted", params: params, caller: caller, session: session)

        let choices = VaultWindow.choices(rememberable: rememberable)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = VaultWindow.title(params)
        alert.informativeText = VaultWindow.body(params, caller: caller, session: session)
        for seconds in choices {
            alert.addButton(withTitle: VaultWindow.label(seconds))
        }

        let deny = alert.addButton(withTitle: "Deny")
        deny.keyEquivalent = "\u{1b}"

        let index = alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        guard index >= 0, index < choices.count else {
            vaultAudit("denied", params: params, caller: caller, session: session, detail: "denied in the window")
            vaultDeny("denied in the approval window")
        }

        let remember = choices[index]
        authenticate(reason: "give “\(params.tool)” the GenesisTools vault key") { method, failure in
            guard let method else {
                vaultAudit("denied", params: params, caller: caller, session: session, detail: failure)
                vaultDeny(failure)
            }

            if remember != 0 {
                let until = remember.map { now + Int64($0) * 1_000 }
                let grant = VaultGrant(key: key, tool: params.tool, executable: executable, script: caller.script,
                                       grantedAt: now, until: until, method: method)
                VaultGrants.save(VaultGrants.remember(grant, now: now, in: VaultGrants.load()))
            }

            vaultAudit("allowed", params: params, caller: caller, session: session,
                       detail: "method: \(method); remembered: \(remember.map { $0 == 0 ? "once" : "\($0 / 3_600) h" } ?? "always")")
            logClick("vault.unlock decision=allow tool=\(params.tool) method=\(method)")
            emitVaultKey(remembered: false)
        }
    }
}
