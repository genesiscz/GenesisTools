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
    /// The drift verdicts worth a badge; `steady` and `insufficient` are the normal answers (src/utils/ai/usage/drift).
    static let driftWarnings: Set<String> = ["limit cut?", "limit raised?"]

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
            let binding = bindingForecast(mine, now: now)
            let sparkSource = mine.first { $0.kind == "session" && $0.availableNow != "absent" } ?? mine.first { $0.kind == "weekly" }
            let spark = sparkSource.map { item in (item.bins?.map(\.close) ?? item.points?.map(\.v) ?? []) } ?? []
            let accountHealth = health?.accounts.first { $0.account.id == account.key.id }
            let verdict = drift?.rows.first { $0.account.id == account.key.id && driftWarnings.contains($0.verdict ?? "") }?.verdict
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

    /// The columns at least one account has a reading for. A column of blanks and "no limit" cells says nothing, and
    /// it pushed the table's useful columns apart (the "Hide empty columns" setting, on by default).
    public static func columnsWithReadings(_ columns: [UsageTableColumn], rows: [UsageTableRow]) -> [UsageTableColumn] {
        columns.filter { column in rows.contains { $0.cells[column.id]?.percent != nil } }
    }

    /// The window that decides the account: the one that runs out first before its reset, else the 5h (when the
    /// account has one), else the week. A stale forecast, or one whose reset has passed (since its last sample, or by
    /// the clock), says nothing about the window now, as the lanes and the hub forecast already treat it.
    static func bindingForecast(_ items: [UsageSeriesItem], now: Date) -> UsageLimitForecast? {
        let forecasts = items.filter { $0.availableNow != "absent" }
            .compactMap { item in item.forecast.map { (item, $0) } }
            .filter { isCurrent($0.1, now: now) }
        let early = forecasts.filter { $0.1.beforeReset }.min { ($0.1.exhaustAt ?? "") < ($1.1.exhaustAt ?? "") }
        return (early ?? forecasts.first { $0.0.kind == "session" } ?? forecasts.first { $0.0.kind == "weekly" })?.1
    }

    static func isCurrent(_ forecast: UsageLimitForecast, now: Date) -> Bool {
        if forecast.stale == true || forecast.resetSinceSample == true { return false }
        guard let reset = UsageTime.date(forecast.resetsAt) else { return true }
        return reset > now
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

/// The table's header row. Plain, sentence-case names; each column keeps the row's frame, so the two line up at any
/// width and the table fills the pane (the Trend column takes what is left).
public struct UsageTableHeader: View {
    let columns: [UsageTableColumn]

    public init(columns: [UsageTableColumn]) { self.columns = columns }

    public var body: some View {
        HStack(spacing: 8) {
            Text("Account").usageTableColumn(UsageTableRowView.accountColumn, extra: 14)
            ForEach(columns) { column in
                Text(verbatim: column.title).usageTableColumn(UsageTableRowView.cellColumn)
            }
            Text("Burn per hour").usageTableColumn(UsageTableRowView.rateColumn)
            Text("Runs out").usageTableColumn(UsageTableRowView.limitColumn)
            Text("Trend").usageTableColumn(UsageTableRowView.trendColumn)
        }
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Color.white.opacity(0.45))
        .lineLimit(1)
        .padding(.horizontal, 8)
        .accessibilityHidden(true)
    }
}

/// A column's width: at least `min`, growing to `max` when the pane is wider (nil: no bound).
struct UsageTableColumnWidth {
    let min: CGFloat
    let max: CGFloat?
}

extension View {
    /// One frame for a header title and its cells, so the header and every row lay out the same at any width.
    func usageTableColumn(_ width: UsageTableColumnWidth, extra: CGFloat = 0) -> some View {
        frame(minWidth: width.min + extra, maxWidth: width.max.map { $0 + extra } ?? .infinity, alignment: .leading)
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

    static let accountColumn = UsageTableColumnWidth(min: 156, max: 240)
    static let cellColumn = UsageTableColumnWidth(min: 92, max: 128)
    static let rateColumn = UsageTableColumnWidth(min: 128, max: 160)
    static let limitColumn = UsageTableColumnWidth(min: 84, max: 116)
    static let trendColumn = UsageTableColumnWidth(min: 100, max: nil)

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
            .usageTableColumn(Self.accountColumn)
            // The header row is hidden from VoiceOver, so each value names its own column.
            ForEach(columns) { column in
                cell(row.cells[column.id])
                    .usageTableColumn(Self.cellColumn)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Self.spokenCell(row.cells[column.id], title: column.title, now: now))
            }
            Text(verbatim: rateText)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(rateTone)
                .lineLimit(1)
                .usageTableColumn(Self.rateColumn)
                .instantTooltip("How fast this account uses its deciding window now, and the safe pace: the steady rate that reaches exactly 100% at the reset")
                .accessibilityLabel("Burn per hour: \(rateText.isEmpty ? "not known" : rateText)")
            Text(verbatim: limitText)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(row.limitBeforeReset ? UsageTone.severity("warning") : Color.white.opacity(0.6))
                .lineLimit(1)
                .usageTableColumn(Self.limitColumn)
                .instantTooltip("When the deciding window runs out at this pace, or \"lasts to reset\" when it does not run out first")
                .accessibilityLabel("Runs out: \(limitText.isEmpty ? "not known" : limitText)")
            Sparkline(values: row.sparkline, tint: Color.white.opacity(0.55), lineWidth: 1, range: 0...100,
                      label: "\(row.account.accountName) trend", valueText: { UsageFormat.percent($0) })
                .frame(height: 16)
                .usageTableColumn(Self.trendColumn)
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

    /// What VoiceOver reads for one cell: the window's name first, then its use or absence, then its reset.
    static func spokenCell(_ cell: UsageTableCell?, title: String, now: Date) -> String {
        guard let cell else { return "\(title): no reading" }
        if cell.absent { return "\(title): no limit" }
        let used = "\(title): \(UsageFormat.percent(cell.percent)) used"
        guard let reset = cell.resetsAt, reset > now else { return used }
        return "\(used), resets in \(UsageFormat.countdown(to: reset, now: now))"
    }

    /// "60.3% · safe 14.4%", per hour (the header says so); empty without a forecast, so an account that burns
    /// nothing reads as a quiet blank instead of a column of dashes.
    private var rateText: String {
        guard let rate = row.ratePerHour, rate.isFinite else { return "" }
        let now = String(format: "%.1f%%", locale: Self.numbers, rate)
        guard let safe = row.safePerHour, safe.isFinite else { return now }
        return now + " · safe " + String(format: "%.1f%%", locale: Self.numbers, safe)
    }

    private static let numbers = Locale(identifier: "en_US_POSIX")

    /// The run-out time, "at limit", or "lasts to reset"; empty without a forecast.
    private var limitText: String {
        guard let text = row.limitText else { return "" }
        return text == "past reset" ? "lasts to reset" : text
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
            // No reading for this window: a blank, so the windows the account has stand out.
            Color.clear.frame(height: 1)
        }
    }
}
