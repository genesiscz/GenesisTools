import Foundation
import SwiftUI

// Usage forecast: when each account's 5-hour and weekly windows run out at the recent burn rate.
// `tools hub forecast --json` (src/hub/lib/forecast.ts) only reads the usage snapshots the usage poller
// already recorded, so a load never spends an API call. It loads when the window becomes key and on
// the digest's refresh, at most every two minutes; no timer runs. Shown beside a session's account
// (`HubForecastChip`) and as the Usage section of the Today digest (`HubForecastList`).

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

    /// "42% · out 16:20" / "42% · lasts" / "42%": the chip's words.
    func summary(clock: (Date) -> String = HubForecastFormat.clock) -> String {
        let used = "\(Int(utilization.rounded()))%"
        if stale, let sampled = HubFormat.date(lastSampleAt) {
            return "\(used) · \(HubFormat.ago(sampled))"
        }
        if let exhaustAt = HubFormat.date(exhaustAt), beforeReset {
            return "\(used) · out \(clock(exhaustAt))"
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
            parts.append(beforeReset ? "runs out \(clock(exhaust)), before the reset" : "lasts to the reset (\(Int((projectedAtReset ?? 0).rounded()))% then)")
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

    var id: String { "\(provider):\(account)" }

    var current: [HubForecastWindow] { windows.filter(\.isCurrent) }

    /// The window the chip shows: the one that runs out first before its reset, else the 5h, else the first current.
    var headline: HubForecastWindow? {
        let current = current
        let early = current.filter(\.beforeReset).min { ($0.exhaustAt ?? "") < ($1.exhaustAt ?? "") }
        return early ?? current.first { $0.kind == "session" } ?? current.first
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
        Task {
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
/// out before it resets. Nothing when the account has no recorded usage.
struct HubForecastChip: View {
    let account: String?
    @ObservedObject private var store = HubForecastStore.shared

    var body: some View {
        if let entry = store.account(named: account), let window = entry.headline {
            HStack(spacing: 3) {
                Image(systemName: window.beforeReset ? "exclamationmark.triangle.fill" : "gauge.with.dots.needle.33percent")
                    .font(.system(size: 9.5))
                Text(verbatim: "\(window.label) \(window.summary())")
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
            }
            .foregroundColor(window.beforeReset ? ReviewPalette.modified : ReviewPalette.dim)
            .instantTooltip(entry.current.map { $0.detail() }.joined(separator: "\n") + "\nFrom recorded usage snapshots (tools hub forecast)")
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
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: entry.account)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.88))
                        .frame(width: 150, alignment: .leading)
                        .lineLimit(1)
                        .instantTooltip("\(entry.account) · \(entry.provider)")
                    ForEach(entry.current) { window in
                        Text(verbatim: "\(window.label) \(window.summary())")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(window.beforeReset ? ReviewPalette.modified : (window.stale ? ReviewPalette.dim.opacity(0.7) : ReviewPalette.dim))
                            .instantTooltip(window.detail())
                    }
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 22)
            }
        }
    }
}
