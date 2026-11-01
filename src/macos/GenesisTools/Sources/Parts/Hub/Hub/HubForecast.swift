import Foundation
import SwiftUI

// Usage forecast: when each account's 5-hour and weekly windows run out at the recent burn rate.
// `tools hub forecast --json` (src/hub/lib/forecast.ts) only reads the usage snapshots the usage poller
// already recorded, so a load never spends an API call. It loads when the window becomes key and on
// the digest's refresh, at most every two minutes; no timer runs. Shown beside a session's account
// (`HubForecastChip`) and as the Usage section of the Today digest (`HubForecastList`).
// Since 2026-10-31 some Claude accounts have no 5-hour limit. The CLI then sends no window for it and names it in
// `absentWindows`: the chip leaves it out and says so in its tooltip, the digest row shows `5h —`. Never `5h 0%`.

struct HubForecastWindow: Decodable, Equatable, Identifiable, Sendable {
    let bucket: String
    let kind: String
    let label: String
    let utilization: Double
    let resetsAt: String?
    let lastSampleAt: String
    let samples: Int
    let ratePctPerHour: Double?
    let basis: String?
    let exhaustAt: String?
    let minutesToExhaust: Int?
    let beforeReset: Bool
    let projectedAtReset: Double?
    let resetSinceSample: Bool
    let stale: Bool

    var id: String { bucket }

    /// A window whose reset already passed says nothing about now.
    var isCurrent: Bool { !resetSinceSample }

    /// "42% · out 16:20" / "42% · lasts" / "42%": the chip's words. A stale window says how old its number is:
    /// "100% as of 4 days ago". "100% · 4 days ago" read as "it hit 100% four days ago" (hub inventory H12).
    /// `now` is injectable: against the real clock a fixture's run-out time passed and the test flipped.
    func summary(now: Date = Date(), clock: (Date) -> String = HubForecastFormat.clock) -> String {
        let used = "\(Int(utilization.rounded()))%"
        if stale, let sampled = HubFormat.date(lastSampleAt) {
            return "\(used) as of \(HubFormat.ago(sampled))"
        }
        if let exhaustAt = HubFormat.date(exhaustAt), beforeReset {
            // Projected from the last sample, so the time can already have passed.
            return exhaustAt <= now ? "\(used) · at limit" : "\(used) · out \(clock(exhaustAt))"
        }
        if exhaustAt != nil {
            return "\(used) · lasts"
        }
        return used
    }

    /// One line for tooltips and the digest: used, rate, reset and the outlook.
    func detail(clock: (Date) -> String = HubForecastFormat.clock) -> String {
        var parts = ["\(label) \(Int(utilization.rounded()))% used"]
        if let rate = ratePctPerHour {
            parts.append(String(format: "%.1f%%/h (%@)", rate, basis ?? "rate"))
        }
        if let reset = HubFormat.date(resetsAt) {
            parts.append("resets \(clock(reset))")
        }
        if let exhaust = HubFormat.date(exhaustAt) {
            let outlook = exhaust <= Date() ? "projected at its limit now, before the reset" : "runs out \(clock(exhaust)), before the reset"
            parts.append(beforeReset ? outlook : "lasts to the reset (\(Int((projectedAtReset ?? 0).rounded()))% then)")
        } else if isCurrent {
            parts.append("no burn in this window")
        }
        if stale {
            parts.append("data from \(HubFormat.ago(HubFormat.date(lastSampleAt)))")
        }
        return parts.joined(separator: " · ")
    }
}

struct HubForecastAccount: Decodable, Equatable, Identifiable, Sendable {
    let provider: String
    let account: String
    let windows: [HubForecastWindow]
    let warning: String?
    /// The window keys (buckets) this account has no limit for, such as `five_hour`. Output from a CLI or hub server
    /// older than the field has no key: nil, read as none.
    let absentWindows: [String]?

    var id: String { "\(provider):\(account)" }

    var absent: [String] { absentWindows ?? [] }

    /// The windows that say something about now. A window the account has no limit for is never one, even if a
    /// writer still sends it: it is no constraint.
    var current: [HubForecastWindow] {
        let absent = absent
        return windows.filter { $0.isCurrent && !absent.contains($0.bucket) }
    }

    /// The digest row: `5h —` for each window the account has no limit for (the 5h comes first in the other rows
    /// too), then the current windows.
    var cells: [HubForecastCell] { absent.map(HubForecastCell.absent) + current.map(HubForecastCell.window) }

    /// The chip's tooltip: a line per current window, a line per window the account has no limit for, the source.
    var tooltip: String {
        (current.map { $0.detail() } + absent.map(HubForecastFormat.absentNote) + ["From recorded usage snapshots (tools hub forecast)"])
            .joined(separator: "\n")
    }

    /// The window the chip shows: the one that runs out first before its reset, else the 5h (when the account has
    /// one), else the first current.
    var headline: HubForecastWindow? {
        let current = current
        let early = current.filter(\.beforeReset).min { ($0.exhaustAt ?? "") < ($1.exhaustAt ?? "") }
        return early ?? current.first { $0.kind == "session" } ?? current.first
    }
}

enum HubForecastCell: Equatable, Identifiable, Sendable {
    case window(HubForecastWindow)
    /// A window key the account has no limit for.
    case absent(String)

    var id: String {
        switch self {
        case .window(let window): return "window:\(window.bucket)"
        case .absent(let bucket): return "absent:\(bucket)"
        }
    }
}

struct HubForecastResult: Decodable, Equatable, Sendable {
    let generatedAt: String
    let source: String?
    let accounts: [HubForecastAccount]
}

enum HubForecastFormat {
    static func clock(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "EEE HH:mm"
        return formatter.string(from: date)
    }

    /// The short name of a window the CLI lists as absent: it sends only the key. The forecast's own label
    /// (src/hub/lib/forecast.ts `windowLabel`) for a key it has one for, else the key.
    static func absentLabel(_ bucket: String) -> String {
        ["five_hour": "5h"][bucket] ?? bucket
    }

    static func absentNote(_ bucket: String) -> String {
        "No \(absentLabel(bucket)) limit on this account"
    }
}

@MainActor
final class HubForecastStore: ObservableObject {
    static let shared = HubForecastStore()
    static let maxAge: TimeInterval = 120

    @Published private(set) var accounts: [HubForecastAccount] = []
    @Published private(set) var error: String?
    @Published private(set) var loading = false
    private var loadedAt: Date?

    /// The accounts named `name` (the session's pinned account), current windows only.
    func account(named name: String?) -> HubForecastAccount? {
        guard let name, !name.isEmpty else { return nil }
        return accounts.first { $0.account == name && !$0.current.isEmpty }
    }

    func loadIfStale(maxAge: TimeInterval = HubForecastStore.maxAge) {
        guard !loading else { return }
        if let loadedAt, Date().timeIntervalSince(loadedAt) < maxAge { return }
        load()
    }

    func load() {
        loading = true
        let loaded = HubSnapshotLoads.begin("forecast")
        Task {
            defer { loaded() }
            do {
                let result = try await HubDailyCLI.decode(HubForecastResult.self, ["forecast", "--json"], span: "forecast.load")
                accounts = result.accounts
                error = nil
            } catch {
                self.error = "Forecast failed: \(error)"
            }
            loadedAt = Date()
            loading = false
        }
    }
}

/// Beside a session's account in its header: the account's most urgent window, orange when it runs
/// out before it resets. Nothing when the account has no recorded usage. A window the account has no limit for
/// is left out of the chip (a compact strip) and named in the tooltip.
struct HubForecastChip: View {
    let account: String?
    @ObservedObject private var store = HubForecastStore.shared

    var body: some View {
        if let entry = store.account(named: account), let window = entry.headline {
            HStack(spacing: 3) {
                // A stale number gets a clock, not a gauge: it is an old reading, not a level now.
                Image(systemName: window.beforeReset ? "exclamationmark.triangle.fill" : window.stale ? "clock.arrow.circlepath" : "gauge.with.dots.needle.33percent")
                    .font(.system(size: 9.5))
                HubForecastSummary(window: window)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundColor(window.beforeReset ? ReviewPalette.modified : window.stale ? ReviewPalette.dim.opacity(0.7) : ReviewPalette.dim)
            .instantTooltip(entry.tooltip)
        }
    }
}

/// A window's chip words on screen. A stale window's "as of 4d ago" keeps counting (`LiveAgo`);
/// `summary()` formats it once, for tests and plain text.
struct HubForecastSummary: View {
    let window: HubForecastWindow

    var body: some View {
        if window.stale, let sampled = HubFormat.date(window.lastSampleAt) {
            LiveAgo(date: sampled, style: .brief) { "\(window.label) \(Int(window.utilization.rounded()))% as of \($0)" }
        } else {
            Text(verbatim: "\(window.label) \(window.summary())")
        }
    }
}

/// The digest's Usage section: every account with a current window, one row per window.
struct HubForecastList: View {
    @ObservedObject private var store = HubForecastStore.shared

    var body: some View {
        let accounts = store.accounts.filter { !$0.current.isEmpty }
        VStack(alignment: .leading, spacing: 4) {
            if let error = store.error {
                Text(verbatim: error).font(.system(size: 11)).foregroundColor(ReviewPalette.removed)
            }
            if accounts.isEmpty, store.error == nil {
                Text(store.loading ? "Reading usage snapshots…" : "No recorded usage in a current window (the usage poller records it).")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
            }
            ForEach(accounts) { entry in
                HubForecastRow(entry: entry)
            }
        }
    }
}

/// One account of the digest's Usage section: its name, then a chip per cell (`5h —` for a window it has no
/// limit for, as a table shows a missing value).
struct HubForecastRow: View {
    let entry: HubForecastAccount

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: entry.account)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color.white.opacity(0.88))
                .frame(width: 150, alignment: .leading)
                .lineLimit(1)
                .instantTooltip("\(entry.account) · \(entry.provider)")
            ForEach(entry.cells) { cell in
                switch cell {
                case .window(let window):
                    HubForecastSummary(window: window)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(window.beforeReset ? ReviewPalette.modified : (window.stale ? ReviewPalette.dim.opacity(0.7) : ReviewPalette.dim))
                        .instantTooltip(window.detail())
                case .absent(let bucket):
                    Text(verbatim: "\(HubForecastFormat.absentLabel(bucket)) —")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim.opacity(0.7))
                        .instantTooltip(HubForecastFormat.absentNote(bucket))
                        .accessibilityLabel(HubForecastFormat.absentNote(bucket))
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 22)
    }
}
