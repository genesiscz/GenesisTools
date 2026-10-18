// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/MonitorSnapshot.swift at 2026-09-24T03:59:28+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
// Excerpt: lines 90-329 (SessionCacheStatus, SessionCmuxRef, MonitorSessionRow, SessionListEnvelope); the rest is spend/usage state.
import Foundation

public enum SessionCacheStatus: String, Equatable, Sendable, Codable {
    case HOT
    case COOLING
    case CRITICAL
    case COLD
}

/// Recorded cmux location from the refs journal (where the session started, unverified).
public struct SessionCmuxRef: Equatable, Sendable, Codable {
    public var workspaceId: String?
    public var workspaceRef: String?
    public var paneRef: String?
    public var surfaceId: String?
    public var surfaceRef: String?
    public var windowRef: String?
    public var at: Double

    public init(
        workspaceId: String? = nil,
        workspaceRef: String? = nil,
        paneRef: String? = nil,
        surfaceId: String? = nil,
        surfaceRef: String? = nil,
        windowRef: String? = nil,
        at: Double = 0
    ) {
        self.workspaceId = workspaceId
        self.workspaceRef = workspaceRef
        self.paneRef = paneRef
        self.surfaceId = surfaceId
        self.surfaceRef = surfaceRef
        self.windowRef = windowRef
        self.at = at
    }
}

public struct MonitorSessionRow: Equatable, Sendable, Codable, Identifiable {
    /// Per-TRANSCRIPT-FILE identity, not per session id.
    ///
    /// The same session id legitimately appears twice: a repo checked out
    /// twice (a worktree plus the main clone) has the transcript in two
    /// project folders, each with its own cache, its own heat and possibly its
    /// own account, and both may be running. Keying on the session id alone
    /// put two different rows into one `ForEach` identity — undefined
    /// behaviour in SwiftUI, and how the popup wedged on 2026-09-03 (100% of
    /// one core in a single update that never returned to the run loop).
    public var id: String { filePath.isEmpty ? sessionId : "\(sessionId)@\(filePath)" }
    /// Vendor alias the row came from: `claude`, `codex` or `grok` (the `provider` field of
    /// `tools ai usage sessions --json`). Rows from the older Claude-only command carry no
    /// provider and decode as `claude`. Which fields below are present follows from this.
    public var provider: String
    public var sessionId: String
    public var title: String?
    public var cwd: String
    public var cwdShort: String
    public var project: String?
    // GenesisTools adaptation: the branch the transcript recorded (`gitBranch` in the tools JSON),
    // so the hub maps a session to a branch, not only to a folder.
    public var gitBranch: String?
    public var mtime: Double
    /// Last main-thread user/assistant timestamp (epoch ms) — stable across polls,
    /// unlike mtime, which metadata rewrites can bump with no real activity.
    public var lastCacheAt: Double?
    public var model: String?
    public var modelSwitched: Bool
    /// Prompt-cache clock. Present for Claude (1 h), Codex (30 min) and Grok (30 min
    /// warning clock). Older payloads omit the keys: the fields stay nil rather than
    /// reading as zero — a `0` TTL would say "expired right now" about a cache the
    /// provider never reported.
    public var cacheStatus: SessionCacheStatus?
    public var cacheTtlSec: Int?
    /// Full prompt-cache lifetime in seconds (3600 Claude, 1800 Codex). Nil on older rows.
    public var cacheLifetimeSec: Int?
    public var totalTokens: Int?
    public var cacheReadTokens: Int?
    public var cacheCreateTokens: Int?
    /// Server-computed context size (exact `postTokens` right after a compaction).
    public var contextTokens: Int?
    /// True when a compaction follows the last real turn (contextTokens is the post-compact size).
    public var compacted: Bool?
    /// Last real typed user message, epoch ms.
    public var lastUserAt: Double?
    /// Account this session bills. Claude and Codex: the SessionStart pin journal, which every
    /// agent's hook writes. Grok: the account whose login the session's home holds.
    ///
    /// nil is a real answer on every provider — the session was started outside
    /// `tools <agent> run`, so no account was recorded. Codex records nothing of its own
    /// (every account shares one home, and no rollout names one), so for Codex nil also
    /// covers every session that predates the hook learning about Codex.
    public var account: String?
    public var cmux: SessionCmuxRef?
    public var filePath: String
    /// Native home the session was read from (`~/.codex`, `~/.grok`). Codex's only provenance.
    public var sourceHome: String?
    public var archived: Bool?

    public static let claudeProvider = "claude"
    public static let codexProvider = "codex"
    public static let grokProvider = "grok"

    /// True when the provider reports a prompt-cache clock for this row.
    public var hasCacheClock: Bool { cacheStatus != nil }

    /// Rows without a cache clock still need an "is this still going" answer for the Cold
    /// toggle and the sort. That answer is plain recency: activity inside the last cache
    /// lifetime counts as live, older counts as dormant. It is an activity window, not a
    /// cache, and the views never label it as one.
    public func isDormant(now: Date = Date()) -> Bool {
        if let cacheStatus {
            return cacheStatus == .COLD
        }
        guard mtime > 0 else { return true }
        return now.timeIntervalSince1970 - mtime / 1000 > SessionStatusFormat.cacheLifetimeSec
    }

    /// A throwaway run rather than a session you are working in: headless
    /// `claude -p` probes (skill batteries, canaries, smoke tests) live in a
    /// temp directory, answer once and exit. They are real sessions with real
    /// caches, so they otherwise fill the list and the banner ladder.
    public var isOneShot: Bool {
        Self.oneShotPrefixes.contains { cwd.hasPrefix($0) }
    }

    /// macOS hands out `/var/folders/...`, and `/tmp` is a symlink to
    /// `/private/tmp`, so a cwd can arrive spelled either way.
    static let oneShotPrefixes = ["/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/"]

    /// Context size to display: the server value, else the legacy sum. nil when the
    /// provider reported no token counts at all.
    public var displayContextTokens: Int? {
        if let contextTokens { return contextTokens }
        guard cacheReadTokens != nil || cacheCreateTokens != nil || totalTokens != nil else { return nil }
        return (cacheReadTokens ?? 0) + (cacheCreateTokens ?? 0) + (totalTokens ?? 0)
    }

    /// Title with harness XML and image placeholders removed.
    public var displayTitle: String {
        if let cleaned = TitleFormatter.cleanSessionTitle(title), !cleaned.isEmpty {
            return cleaned
        }
        return String(sessionId.prefix(8))
    }

    /// Defaults describe a Claude row with a cold cache, which is what every existing
    /// caller and test built before the other providers arrived.
    public init(
        provider: String = MonitorSessionRow.claudeProvider,
        sessionId: String,
        title: String? = nil,
        cwd: String = "",
        cwdShort: String = "",
        project: String? = nil,
        gitBranch: String? = nil,
        mtime: Double = 0,
        lastCacheAt: Double? = nil,
        model: String? = nil,
        modelSwitched: Bool = false,
        cacheStatus: SessionCacheStatus? = .COLD,
        cacheTtlSec: Int? = 0,
        cacheLifetimeSec: Int? = nil,
        totalTokens: Int? = 0,
        cacheReadTokens: Int? = 0,
        cacheCreateTokens: Int? = 0,
        contextTokens: Int? = nil,
        compacted: Bool? = nil,
        lastUserAt: Double? = nil,
        account: String? = nil,
        cmux: SessionCmuxRef? = nil,
        filePath: String = "",
        sourceHome: String? = nil,
        archived: Bool? = nil
    ) {
        self.provider = provider
        self.sessionId = sessionId
        self.title = title
        self.cwd = cwd
        self.cwdShort = cwdShort
        self.project = project
        self.gitBranch = gitBranch
        self.mtime = mtime
        self.lastCacheAt = lastCacheAt
        self.model = model
        self.modelSwitched = modelSwitched
        self.cacheStatus = cacheStatus
        self.cacheTtlSec = cacheTtlSec
        self.cacheLifetimeSec = cacheLifetimeSec
        self.totalTokens = totalTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheCreateTokens = cacheCreateTokens
        self.contextTokens = contextTokens
        self.compacted = compacted
        self.lastUserAt = lastUserAt
        self.account = account
        self.cmux = cmux
        self.filePath = filePath
        self.sourceHome = sourceHome
        self.archived = archived
    }

    private enum CodingKeys: String, CodingKey {
        case provider, sessionId, title, cwd, cwdShort, project, gitBranch, mtime, lastCacheAt, model, modelSwitched
        case cacheStatus, cacheTtlSec, cacheLifetimeSec, totalTokens, cacheReadTokens, cacheCreateTokens, contextTokens
        case compacted, lastUserAt, account, cmux, filePath, sourceHome, archived
    }

    /// Lenient on the two keys older writers omit: `provider` (the Claude-only command never
    /// wrote one) and `modelSwitched`. Everything provider-specific is optional by type.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? Self.claudeProvider
        sessionId = try c.decode(String.self, forKey: .sessionId)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        cwdShort = try c.decodeIfPresent(String.self, forKey: .cwdShort) ?? ""
        project = try c.decodeIfPresent(String.self, forKey: .project)
        // GenesisTools adaptation: `gitBranch` is in CodingKeys and the init too, or every decoded row lost it.
        gitBranch = try c.decodeIfPresent(String.self, forKey: .gitBranch)
        mtime = try c.decodeIfPresent(Double.self, forKey: .mtime) ?? 0
        lastCacheAt = try c.decodeIfPresent(Double.self, forKey: .lastCacheAt)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        modelSwitched = try c.decodeIfPresent(Bool.self, forKey: .modelSwitched) ?? false
        cacheStatus = try c.decodeIfPresent(SessionCacheStatus.self, forKey: .cacheStatus)
        cacheTtlSec = try c.decodeIfPresent(Int.self, forKey: .cacheTtlSec)
        cacheLifetimeSec = try c.decodeIfPresent(Int.self, forKey: .cacheLifetimeSec)
        totalTokens = try c.decodeIfPresent(Int.self, forKey: .totalTokens)
        cacheReadTokens = try c.decodeIfPresent(Int.self, forKey: .cacheReadTokens)
        cacheCreateTokens = try c.decodeIfPresent(Int.self, forKey: .cacheCreateTokens)
        contextTokens = try c.decodeIfPresent(Int.self, forKey: .contextTokens)
        compacted = try c.decodeIfPresent(Bool.self, forKey: .compacted)
        lastUserAt = try c.decodeIfPresent(Double.self, forKey: .lastUserAt)
        account = try c.decodeIfPresent(String.self, forKey: .account)
        cmux = try c.decodeIfPresent(SessionCmuxRef.self, forKey: .cmux)
        filePath = try c.decodeIfPresent(String.self, forKey: .filePath) ?? ""
        sourceHome = try c.decodeIfPresent(String.self, forKey: .sourceHome)
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived)
    }
}

public struct SessionListEnvelope: Equatable, Sendable, Codable {
    public var fetchedAt: Double?
    public var rows: [MonitorSessionRow]

    public init(fetchedAt: Double? = nil, rows: [MonitorSessionRow] = []) {
        self.fetchedAt = fetchedAt
        self.rows = rows
    }
}
