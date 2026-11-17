// An approval of the vault key for a whole agent session, from Martin's question of 2026-11-17 21:27 about one Claude
// session that asked six times in four minutes for its own scratch script ("this is also bugging a lot during agent
// work on development which should be extempt somehow safely?").
//
// Such a script can never be remembered as a program: it is started as `bun <script>` without the launcher's
// `--config=`, so a preload of its folder could have hidden itself (decision 61 a, VaultUnlock.swift). It is also new
// code on every edit, so a program approval would say little about it. What the person really decides is whether this
// agent may read the vault, so the window offers that too: the agent's own process (named by its pid and its start
// time, both from the kernel) and every process it starts, for a fixed time. Only Touch ID in the window creates one,
// a process outside that tree can never use it, and the approval ends with the agent process or at its time.

import Darwin
import Foundation
import GenesisKitBase

/// One process of a caller's parent chain, as the kernel names it.
struct VaultLineageEntry: Equatable {
    var pid: Int32
    /// Microseconds since 1970 (`pbi_start_tvsec`, `pbi_start_tvusec`). A reused pid has another start.
    var startedAt: Int64
    /// The executable's file name (`claude`, `zsh`, `gt-claude`).
    var name: String
}

/// The process a session approval is for: the nearest agent harness (`claude`, `codex`, `grok`) above the caller.
struct VaultSessionAnchor: Codable, Equatable {
    var harness: String
    var pid: Int32
    var startedAt: Int64

    /// The nearest parent whose executable is an agent harness. A harness started inside another one (a headless
    /// `claude -p` under a Claude session) is the narrower scope, so the nearest wins.
    static func nearest(in lineage: [VaultLineageEntry],
                        harnesses: Set<String> = Set(Harness.allCases.map(\.binary))) -> VaultSessionAnchor? {
        lineage.first { harnesses.contains($0.name) }.map { VaultSessionAnchor(harness: $0.name, pid: $0.pid, startedAt: $0.startedAt) }
    }

    func isIn(_ lineage: [VaultLineageEntry]) -> Bool {
        lineage.contains { $0.pid == pid && $0.startedAt == startedAt }
    }

    /// `claude (pid 83427)`.
    var label: String { "\(harness) (pid \(pid))" }
}

/// One session approval: its process and everything that process starts, until `until` (epoch milliseconds).
struct VaultSessionGrant: Codable, Equatable {
    var anchor: VaultSessionAnchor
    /// Display only: the session the window named when the approval was given.
    var sessionId: String?
    var title: String?
    var grantedAt: Int64
    var until: Int64
    var method: String

    func isLive(at now: Int64) -> Bool { until > now }
}

struct VaultSessionGrantsFile: Codable {
    var version: Int
    var grants: [VaultSessionGrant]
}

enum VaultSessionGrants {
    static var path: String {
        (VaultGrants.directory as NSString).appendingPathComponent("vault-session-grants.json")
    }

    static func load(from path: String = path) -> VaultSessionGrantsFile {
        guard let data = FileManager.default.contents(atPath: path),
              let file = try? JSONDecoder().decode(VaultSessionGrantsFile.self, from: data) else {
            return VaultSessionGrantsFile(version: 1, grants: [])
        }

        return file
    }

    /// The live approval of any process in the caller's parent chain. A session approval covers everything its
    /// process starts, so a harness in between (a nested `claude -p`) does not end it.
    static func live(lineage: [VaultLineageEntry], now: Int64, in file: VaultSessionGrantsFile) -> VaultSessionGrant? {
        file.grants.last { $0.isLive(at: now) && $0.anchor.isIn(lineage) }
    }

    /// Replaces any approval of the same process and drops ended ones.
    static func remember(_ grant: VaultSessionGrant, now: Int64, in file: VaultSessionGrantsFile) -> VaultSessionGrantsFile {
        var next = file
        next.grants = file.grants.filter { $0.anchor != grant.anchor && $0.isLive(at: now) } + [grant]
        return next
    }

    /// Under the same lock protocol as the program approvals, which `tools ai gate revoke` also takes for this file.
    static func store(_ grant: VaultSessionGrant, now: Int64, to path: String = path, timeout: TimeInterval = 10) async -> Bool {
        await VaultGrants.withLock(path, timeout: timeout) {
            VaultGrants.save(remember(grant, now: now, in: load(from: path)), to: path)
        }
    }
}

extension VaultProcess {
    static func startedAt(_ pid: pid_t) -> Int64? {
        var info = proc_bsdinfo()
        let size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size))
        guard size > 0 else { return nil }
        return Int64(info.pbi_start_tvsec) * 1_000_000 + Int64(info.pbi_start_tvusec)
    }

    /// The parents of `pid`, nearest first, with their start times. Deeper than the window's chain of eight: a node
    /// tool five levels under a Claude session still finds it.
    static func lineage(of pid: pid_t, limit: Int = 32) -> [VaultLineageEntry] {
        var entries: [VaultLineageEntry] = []
        var current = parent(pid)
        while let ancestor = current, ancestor > 1, entries.count < limit {
            guard let start = startedAt(ancestor) else { break }
            let name = path(ancestor).map { ($0 as NSString).lastPathComponent } ?? ""
            entries.append(VaultLineageEntry(pid: ancestor, startedAt: start, name: name))
            current = parent(ancestor)
        }

        return entries
    }
}
