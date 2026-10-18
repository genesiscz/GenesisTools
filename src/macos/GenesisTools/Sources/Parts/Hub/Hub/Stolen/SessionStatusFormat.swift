// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/SessionStatusFormat.swift at 2026-09-24T03:59:28+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
import Foundation

/// Second line of a collapsed session row in the usage popup.
public struct SessionCollapsedMeta: Equatable, Sendable {
    public var cwd: String
    public var account: String?
    /// nil when the provider reported no model (Codex and Grok rows today).
    public var model: String?
    /// nil when the provider reported no token counts; the cell is then left out, never `0 ctx`.
    public var ctx: String?
    public var compacted: Bool

    public init(cwd: String, account: String?, model: String?, ctx: String?, compacted: Bool) {
        self.cwd = cwd
        self.account = account
        self.model = model
        self.ctx = ctx
        self.compacted = compacted
    }
}

public enum SessionStatusFormat {
    /// Minutes of prompt cache left, e.g. `55m`; `cold` when it is gone.
    /// The status color carries hot/cooling/critical, so no word is needed.
    public static func label(_ status: SessionCacheStatus, ttlSec: Int) -> String {
        switch status {
        case .COLD:
            return "cold"
        case .HOT, .COOLING, .CRITICAL:
            return ttlPhrase(ttlSec)
        }
    }

    public static func ttlPhrase(_ sec: Int) -> String {
        if sec <= 0 { return "0s" }
        let minutes = sec / 60
        if minutes == 0 { return "\(sec)s" }
        return "\(minutes)m"
    }

    /// Fallback lifetime when a row carries no `cacheLifetimeSec`. Claude's hour.
    public static let cacheLifetimeSec: TimeInterval = 60 * 60
    /// Codex GPT-5.6+ documented minimum / Grok warning clock, used when the row
    /// omitted `cacheLifetimeSec`.
    public static let thirtyMinuteCacheLifetimeSec: TimeInterval = 30 * 60

    /// Per-row prompt-cache lifetime. Prefer the CLI's `cacheLifetimeSec`; fall back
    /// by provider so a Codex COLD row does not wait a second hour before showing age.
    public static func cacheLifetimeSec(for row: MonitorSessionRow) -> TimeInterval {
        if let sec = row.cacheLifetimeSec, sec > 0 {
            return TimeInterval(sec)
        }
        if row.provider == MonitorSessionRow.codexProvider || row.provider == MonitorSessionRow.grokProvider {
            return thirtyMinuteCacheLifetimeSec
        }
        return cacheLifetimeSec
    }

    /// When the cache expired, epoch ms. That is the clock a cold row shows.
    public static func coldSinceMs(for row: MonitorSessionRow) -> Double? {
        guard let clock = clockMs(for: row) else { return nil }
        return clock + cacheLifetimeSec(for: row) * 1000
    }

    /// Seconds since the cache expired, floored at 0 for a row that has just
    /// gone cold (or one the CLI called cold a little early).
    public static func coldSeconds(for row: MonitorSessionRow, now: Date = Date()) -> TimeInterval? {
        guard let since = coldSinceMs(for: row) else { return nil }
        return max(0, now.timeIntervalSince1970 - since / 1000)
    }

    /// Last-turn clock for forgotten-session age. `lastCacheAt` first, then `lastUserAt`, then `mtime`.
    public static func clockMs(for row: MonitorSessionRow) -> Double? {
        if let value = row.lastCacheAt, value > 0 { return value }
        if let value = row.lastUserAt, value > 0 { return value }
        if row.mtime > 0 { return row.mtime }
        return nil
    }

    /// Status-column age: floor to one unit so `○ 3h` fits 50pt.
    public static func compactAge(seconds: TimeInterval) -> String {
        let value = max(0, Int(seconds))
        if value < 60 { return "<1m" }
        if value < 3600 { return "\(value / 60)m" }
        if value < 48 * 3600 { return "\(value / 3600)h" }
        return "\(value / 86_400)d"
    }

    /// Live "3m ago" / "just now" for relative clocks.
    public static func agoPhrase(seconds: TimeInterval) -> String {
        if seconds < 60 { return "just now" }
        return "\(longAge(seconds: seconds)) ago"
    }

    /// Window / expand-row age. Hours keep leftover minutes; days do not.
    public static func longAge(seconds: TimeInterval) -> String {
        let value = max(0, Int(seconds))
        if value < 60 { return "<1m" }
        let minutes = value / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 {
            let leftover = minutes % 60
            return leftover == 0 ? "\(hours)h" : "\(hours)h \(leftover)m"
        }
        return "\(hours / 24)d"
    }

    /// Compact status-column phrase. COLD rows show how long they have been
    /// cold, not how long ago the last turn was. A row with no cache clock
    /// shows the age of its last activity.
    public static func listLabel(for row: MonitorSessionRow, now: Date = Date()) -> String {
        guard let status = row.cacheStatus else {
            guard let seconds = ageSeconds(for: row, now: now) else { return "—" }
            return compactAge(seconds: seconds)
        }
        guard status == .COLD else {
            return ttlPhrase(row.cacheTtlSec ?? 0)
        }
        guard let seconds = coldSeconds(for: row, now: now) else { return "cold" }
        return compactAge(seconds: seconds)
    }

    /// Tooltip for a row whose provider reports no prompt-cache clock.
    public static func noClockTooltip(for row: MonitorSessionRow, now: Date = Date()) -> String {
        let name = AIProviders.meta(for: row.provider).displayName
        guard let age = ageSeconds(for: row, now: now) else {
            return "\(name) reports no prompt-cache clock"
        }
        return "last activity \(longAge(seconds: age)) ago · \(name) reports no prompt-cache clock"
    }

    public static func ageSeconds(for row: MonitorSessionRow, now: Date = Date()) -> TimeInterval? {
        guard let clock = clockMs(for: row) else { return nil }
        return max(0, now.timeIntervalSince1970 - clock / 1000)
    }

    public static func coldTooltip(for row: MonitorSessionRow, now: Date = Date()) -> String {
        guard let cold = coldSeconds(for: row, now: now), let age = ageSeconds(for: row, now: now) else {
            return "cold"
        }
        return "cold for \(longAge(seconds: cold)) · last turn \(longAge(seconds: age)) ago"
    }

    /// The `account` detail cell.
    ///
    /// An empty account now means the same thing on every provider: the session was started
    /// outside `tools <agent> run`, so the SessionStart hook had no account to record. It used
    /// to read "— (Codex records none)", which said the attribution was impossible rather than
    /// simply absent.
    public static func accountLabel(for row: MonitorSessionRow) -> String {
        if let account = row.account?.trimmingCharacters(in: .whitespacesAndNewlines), !account.isEmpty {
            return account
        }
        return "—"
    }

    /// Cwd, pinned account, model, context size — the collapsed row's second line.
    public static func collapsedMeta(for row: MonitorSessionRow) -> SessionCollapsedMeta {
        let account = row.account?.trimmingCharacters(in: .whitespacesAndNewlines)
        return SessionCollapsedMeta(
            cwd: row.cwdShort,
            account: (account?.isEmpty == false) ? account : nil,
            model: row.model,
            ctx: row.displayContextTokens.map(TitleFormatter.formatCtx),
            compacted: row.compacted == true
        )
    }
}
