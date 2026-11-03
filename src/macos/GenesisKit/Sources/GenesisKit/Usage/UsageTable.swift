import SwiftUI

// The usage table (proposal 1, top half): one row per account of every provider. A health dot, the account, one
// column per window kind (5h, Week, then each scoped model such as Fable), the burn rate against the safe pace, the
// time to the limit and a sparkline of the range. Rows are values (`UsageTableRow`), built once per load.

public struct UsageTableCell: Equatable, Sendable {
    public let percent: Double?
    public let resetsAt: Date?
    public let severity: String?
    /// The account has no limit for this window: "no limit", never 0%.
    public let absent: Bool

    public init(percent: Double?, resetsAt: Date?, severity: String?, absent: Bool = false) {
        self.percent = percent
        self.resetsAt = resetsAt
        self.severity = severity
        self.absent = absent
    }
}

public struct UsageTableRow: Identifiable, Equatable, Sendable {
    public let account: UsageAccountKey
    public let plan: String?
    /// The poll health outcome (`ok`, `stale`, `blocked`, `unmeasured`, …); nil before health loaded.
    public let health: String?
    public let cells: [String: UsageTableCell]
    public let ratePerHour: Double?
    public let safePerHour: Double?
    /// "16:20", "Tue 16:20", "past reset" (the account lasts to its reset), or nil without a forecast.
    public let limitText: String?
    public let limitBeforeReset: Bool
    public let sparkline: [Double]
    /// A drift verdict ("limit cut?") from `limits drift`.
    public let verdict: String?
    public let error: String?

    public var id: String { account.id }
}

/// The table's columns: 5h, Week, Month, then each scoped model in name order.
public struct UsageTableColumn: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
}

public enum UsageTableBuilder {
    public static func columnKey(kind: String?, scopeModel: String?, key: String) -> String {
        if let scopeModel, !scopeModel.isEmpty { return "scoped:" + scopeModel }
        return kind ?? key
    }

    public static func build(
        limits: UsageLimitsData, series: UsageSeriesData? = nil, health: UsageHealthData? = nil,
        drift: UsageDriftData? = nil, now: Date = Date()
    ) -> (columns: [UsageTableColumn], rows: [UsageTableRow]) {
        var scoped = Set<String>()
        var kinds = Set<String>()
        let rows = limits.accounts.map { account -> UsageTableRow in
            var cells: [String: UsageTableCell] = [:]
            for limit in account.limits {
                let key = columnKey(kind: limit.kind, scopeModel: limit.scopeModel, key: limit.key)
                if key.hasPrefix("scoped:") { scoped.insert(key) } else { kinds.insert(key) }
                cells[key] = UsageTableCell(
                    percent: limit.percentUsed, resetsAt: UsageTime.date(limit.resetsAt),
                    severity: limit.severity ?? limit.percentUsed.map(UsageTone.severity(forPercent:)))
            }
            for absent in account.absentLimits ?? [] {
                let key = absent.kind ?? absent.key
                kinds.insert(key)
                cells[key] = UsageTableCell(percent: nil, resetsAt: nil, severity: nil, absent: true)
            }
            let mine = (series?.series ?? []).filter { $0.account.id == account.key.id || ($0.provider == account.provider && $0.accountName == account.accountName) }
            let binding = bindingForecast(mine)
            let sparkSource = mine.first { $0.kind == "session" && $0.availableNow != "absent" } ?? mine.first { $0.kind == "weekly" }
            let spark = sparkSource.map { item in (item.bins?.map(\.close) ?? item.points?.map(\.v) ?? []) } ?? []
            let accountHealth = health?.accounts.first { $0.account.id == account.key.id }
            let verdict = drift?.rows.first { $0.account.id == account.key.id && $0.verdict != nil && $0.verdict != "ok" }?.verdict
            return UsageTableRow(
                account: account.key, plan: account.label, health: accountHealth?.outcome, cells: cells,
                ratePerHour: binding?.ratePctPerHour, safePerHour: binding?.safePctPerHour,
                limitText: limitText(binding, now: now), limitBeforeReset: binding?.beforeReset ?? false,
                sparkline: downsample(spark, to: 48), verdict: verdict, error: account.error)
        }
        let ordered = ["session", "weekly", "monthly"].filter(kinds.contains)
            + kinds.subtracting(["session", "weekly", "monthly"]).sorted()
        let columns = ordered.map { UsageTableColumn(id: $0, title: UsageFormat.windowName(kind: $0, label: $0)) }
            + scoped.sorted().map { UsageTableColumn(id: $0, title: String($0.dropFirst("scoped:".count))) }
        return (columns, rows)
    }

    /// The window that decides the account: the one that runs out first before its reset, else the 5h (when the
    /// account has one), else the week.
    static func bindingForecast(_ items: [UsageSeriesItem]) -> UsageLimitForecast? {
        let forecasts = items.filter { $0.availableNow != "absent" }.compactMap { item in item.forecast.map { (item, $0) } }
        let early = forecasts.filter { $0.1.beforeReset }.min { ($0.1.exhaustAt ?? "") < ($1.1.exhaustAt ?? "") }
        return (early ?? forecasts.first { $0.0.kind == "session" } ?? forecasts.first { $0.0.kind == "weekly" })?.1
    }

    static func limitText(_ forecast: UsageLimitForecast?, now: Date) -> String? {
        guard let forecast else { return nil }
        if forecast.beforeReset, let exhaust = UsageTime.date(forecast.exhaustAt) {
            return exhaust <= now ? "at limit" : UsageFormat.clock(exhaust, now: now)
        }
        return forecast.ratePctPerHour == nil ? nil : "past reset"
    }

    /// At most `count` values, keeping each slice's last value (the series holds the last value of a bin too).
    static func downsample(_ values: [Double], to count: Int) -> [Double] {
        guard values.count > count, count > 0 else { return values }
        let slice = Double(values.count) / Double(count)
        return (0..<count).map { index in values[min(values.count - 1, Int((Double(index + 1) * slice).rounded(.up)) - 1)] }
    }
}

/// The table's header row.
public struct UsageTableHeader: View {
    let columns: [UsageTableColumn]

    public init(columns: [UsageTableColumn]) { self.columns = columns }

    public var body: some View {
        HStack(spacing: 8) {
            Text("Account").frame(width: UsageTableRowView.accountWidth + 14, alignment: .leading)
            ForEach(columns) { column in
                Text(verbatim: column.title).frame(width: UsageTableRowView.cellWidth, alignment: .leading)
            }
            Text("Rate · safe").frame(width: UsageTableRowView.rateWidth, alignment: .leading)
            Text("Limit").frame(width: 64, alignment: .leading)
            Text("Trend").frame(minWidth: 60, alignment: .leading)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Color.white.opacity(0.45))
        .padding(.horizontal, 8)
        .accessibilityHidden(true)
    }
}

/// One account. A click selects its lanes; ⌘-click adds it to the ones shown (`onSelect(additive)`).
public struct UsageTableRowView: View, Equatable {
    public let row: UsageTableRow
    public let columns: [UsageTableColumn]
    public let selected: Bool
    public let now: Date
    let onSelect: (Bool) -> Void

    public init(row: UsageTableRow, columns: [UsageTableColumn], selected: Bool, now: Date, onSelect: @escaping (Bool) -> Void) {
        self.row = row
        self.columns = columns
        self.selected = selected
        self.now = now
        self.onSelect = onSelect
    }

    nonisolated public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.columns == rhs.columns && lhs.selected == rhs.selected && lhs.now == rhs.now
    }

    static let accountWidth: CGFloat = 170
    static let cellWidth: CGFloat = 92
    static let rateWidth: CGFloat = 104

    public var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(UsageTone.outcome(row.health ?? "unmeasured"))
                .frame(width: 6, height: 6)
                .instantTooltip("Polling: " + UsageTone.outcomeTitle(row.health ?? "unmeasured") + (row.error.map { "\n" + $0 } ?? ""))
            HStack(spacing: 5) {
                AIProviderGlyph(meta: AIProviders.meta(for: row.account.provider), size: 14)
                Text(verbatim: row.account.accountName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .lineLimit(1)
                if let verdict = row.verdict {
                    Text(verbatim: verdict)
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(UsageTone.severity("warning"))
                        .instantTooltip("Limit drift: one point of this window buys a different amount than its baseline (tools ai usage limits drift)")
                }
            }
            .frame(width: Self.accountWidth, alignment: .leading)
            ForEach(columns) { column in
                cell(row.cells[column.id])
                    .frame(width: Self.cellWidth, alignment: .leading)
            }
            Text(verbatim: rateText)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(rateTone)
                .frame(width: Self.rateWidth, alignment: .leading)
                .instantTooltip("Burn rate now, and the safe pace: the constant rate that lands at exactly 100% at the reset")
            Text(verbatim: row.limitText ?? "—")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(row.limitBeforeReset ? UsageTone.severity("warning") : Color.white.opacity(0.6))
                .frame(width: 64, alignment: .leading)
            Sparkline(values: row.sparkline, tint: Color.white.opacity(0.55), lineWidth: 1, range: 0...100,
                      label: "\(row.account.accountName) trend", valueText: { UsageFormat.percent($0) })
                .frame(minWidth: 60, maxWidth: 120)
                .frame(height: 16)
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { onSelect(NSEvent.modifierFlags.contains(.command)) }
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .liveRow(selected: selected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private var rateText: String {
        guard let rate = row.ratePerHour else { return "—" }
        guard let safe = row.safePerHour else { return UsageFormat.rate(rate) }
        return "\(UsageFormat.rate(rate)) · \(UsageFormat.rate(safe))"
    }

    private var rateTone: Color {
        guard let rate = row.ratePerHour, let safe = row.safePerHour else { return Color.white.opacity(0.6) }
        return rate > safe ? UsageTone.severity("warning") : Color.white.opacity(0.75)
    }

    @ViewBuilder
    private func cell(_ cell: UsageTableCell?) -> some View {
        if let cell, cell.absent {
            Text("no limit")
                .font(.system(size: 11))
                .foregroundStyle(Color.white.opacity(0.4))
                .instantTooltip("This account has no such limit")
        } else if let cell {
            HStack(spacing: 4) {
                Text(verbatim: UsageFormat.percent(cell.percent))
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .foregroundStyle(UsageTone.severity(cell.severity))
                // A reset in the past is an old reading's; its countdown would read "now" forever.
                if let reset = cell.resetsAt, reset > now {
                    Text(verbatim: UsageFormat.countdown(to: reset, now: now))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Color.white.opacity(0.42))
                }
            }
        } else {
            Text(verbatim: "—").foregroundStyle(Color.white.opacity(0.25))
        }
    }
}
