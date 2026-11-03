import Charts
import SwiftUI

/// One stacked bar segment: a bucket, a group, its dollars.
struct UsageSpendBar: Identifiable, Equatable {
    let bucket: Date
    let group: String
    let usd: Double
    var id: String { "\(bucket.timeIntervalSince1970)|\(group)" }

    /// The pivot's groups as bars. A bucket key is local (`2026-10-27T06` an hour, `2026-10-27` a day); the largest
    /// `keep` groups keep their names, the rest stack as "other".
    static func bars(_ pivot: UsagePivotData, keep: Int = 7) -> [UsageSpendBar] {
        let ranked = pivot.groups.sorted { $0.costUsd > $1.costUsd }
        let named = Set(ranked.prefix(keep).map(\.id))
        var sums: [String: UsageSpendBar] = [:]
        for group in ranked {
            let name = named.contains(group.id) ? label(group, by: pivot.by) : "other"
            for point in group.points {
                guard let bucket = bucketDate(point.t, timeZone: pivot.tz) else { continue }
                let key = "\(bucket.timeIntervalSince1970)|\(name)"
                let usd = (sums[key]?.usd ?? 0) + point.costUsd
                sums[key] = UsageSpendBar(bucket: bucket, group: name, usd: usd)
            }
        }
        return sums.values.sorted { $0.bucket < $1.bucket || ($0.bucket == $1.bucket && $0.group < $1.group) }
    }

    static func label(_ group: UsagePivotGroup, by: [String]) -> String {
        by.compactMap { dimension in
            group.key[dimension].map { dimension == "project" ? UsageFormat.project($0) : $0 }
        }.joined(separator: " · ")
    }

    private static func formatter(_ format: String, _ zone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = format
        return formatter
    }

    static func bucketDate(_ key: String, timeZone: String?) -> Date? {
        let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
        if key.count == 13 { return formatter("yyyy-MM-dd'T'HH", zone).date(from: key) }
        if key.count == 10 { return formatter("yyyy-MM-dd", zone).date(from: key) }
        return UsageTime.date(key)
    }
}

/// Spend (UI5, proposal 10): dollars per hour or day, stacked by the dimension picked, the hour-by-weekday heatmap,
/// and the groups ranked.
struct UsageSpendSection: View {
    @ObservedObject var usage: HubUsageModel
    let settings: UsageSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Text("Stack by").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                UsageSegments(options: UsageSpendStack.allCases, selection: usage.preferences.binding(\.spendStack),
                              title: \.title, tooltip: { "Split the bars by \($0.rawValue)" })
                Spacer()
                if let total = usage.pivot?.data.total {
                    Text(verbatim: UsageFormat.usd(total.costUsd))
                        .font(.system(size: 16, weight: .semibold, design: .monospaced))
                    Text(verbatim: "\(UsageFormat.tokens(total.tokens)) tokens")
                        .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    if total.unpriced > 0 {
                        Text(verbatim: Plural.count(total.unpriced, "unpriced event"))
                            .font(.system(size: 11)).foregroundColor(ReviewPalette.modified)
                            .instantTooltip("These events have no known rate: their cost is missing, not $0")
                    }
                }
            }
            if let pivot = usage.pivot?.data, !pivot.groups.isEmpty {
                let bars = UsageSpendBar.bars(pivot)
                Chart(bars) { bar in
                    BarMark(x: .value("Time", bar.bucket, unit: pivot.grain == "day" ? .day : pivot.grain == "week" ? .weekOfYear : .hour),
                            y: .value("Dollars", bar.usd))
                        .foregroundStyle(by: .value("Group", bar.group))
                }
                .chartYAxis { AxisMarks { value in
                    AxisGridLine().foregroundStyle(Color.white.opacity(0.06))
                    AxisValueLabel { Text(verbatim: UsageFormat.usd(value.as(Double.self))).font(.system(size: 9.5)) }
                } }
                .chartLegend(position: .bottom, alignment: .leading)
                .frame(height: 220)
                .accessibilityLabel(Text("Spend over time by \(pivot.by.joined(separator: " and "))"))
                if let heatmap = pivot.heatmap, heatmap.cells.count == 7 {
                    UsageSectionTitle(text: "When the money goes", detail: "average dollars per hour of the week")
                    NativeMatrixHeatmap(
                        rows: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
                        columns: (0..<24).map { String(format: "%02d", $0) },
                        cells: heatmap.cells.enumerated().flatMap { row, values in
                            values.enumerated().map { NativeHeatmapCell(row: row, column: $0.offset, value: $0.element) }
                        },
                        valueText: { UsageFormat.usd($0) + " on average" })
                }
                UsageSectionTitle(text: "Groups", detail: Plural.count(pivot.groups.count, "group"))
                VStack(spacing: 0) {
                    ForEach(pivot.groups.sorted { $0.costUsd > $1.costUsd }.prefix(20)) { group in
                        HStack(spacing: 8) {
                            Text(verbatim: UsageSpendBar.label(group, by: pivot.by))
                                .font(.system(size: 12)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1)
                            Spacer(minLength: 6)
                            ShareBar(share: pivot.total.costUsd > 0 ? group.costUsd / pivot.total.costUsd : 0).frame(width: 80, height: 5)
                            Text(verbatim: UsageFormat.tokens(group.tokens))
                                .font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                                .frame(width: 56, alignment: .trailing)
                            Text(verbatim: UsageFormat.usd(group.costUsd))
                                .font(.system(size: 11.5, design: .monospaced)).frame(width: 72, alignment: .trailing)
                        }
                        .frame(height: 24)
                        .liveRow()
                    }
                }
            } else {
                UsageEmpty(loading: usage.loading.contains(.pivot), symbol: "chart.bar.xaxis",
                           text: "No transcript spend in this range.")
            }
        }
    }
}

/// Waste (proposal 12): avoidable spend by kind and account, then the costliest items with their evidence.
struct UsageWasteSection: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        if let waste = usage.waste?.data, waste.total.items > 0 {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(verbatim: UsageFormat.usd(waste.total.usd))
                        .font(.system(size: 18, weight: .semibold, design: .monospaced))
                    Text(verbatim: "avoidable · \(Plural.count(waste.total.items, "rebuild")) · \(UsageFormat.tokens(waste.total.tokens)) tokens")
                        .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                UsageSectionTitle(text: "By \(waste.by.joined(separator: " and "))")
                VStack(spacing: 0) {
                    ForEach(waste.groups.sorted { $0.usd > $1.usd }.prefix(16)) { group in
                        HStack(spacing: 8) {
                            Text(verbatim: waste.by.compactMap { group.key[$0] }.map(Self.kindTitle).joined(separator: " · "))
                                .font(.system(size: 12)).foregroundColor(Color.white.opacity(0.85))
                            Spacer(minLength: 6)
                            Text(verbatim: Plural.count(group.items, "item"))
                                .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                            ShareBar(share: waste.total.usd > 0 ? group.usd / waste.total.usd : 0, tint: ReviewPalette.modified)
                                .frame(width: 80, height: 5)
                            Text(verbatim: UsageFormat.usd(group.usd))
                                .font(.system(size: 11.5, design: .monospaced)).frame(width: 72, alignment: .trailing)
                        }
                        .frame(height: 24)
                        .liveRow()
                    }
                }
                UsageSectionTitle(text: "Top leaks", detail: "the costliest single rebuilds")
                VStack(spacing: 4) {
                    ForEach(waste.top.prefix(12)) { item in
                        VStack(alignment: .leading, spacing: 1) {
                            UsageSessionLine(
                                sessionId: item.sessionId, harness: item.agent, project: item.project ?? "",
                                costUsd: item.usd, share: nil,
                                detail: "\(Self.kindTitle(item.kind)) · \(UsageFormat.clock(UsageTime.date(item.t)))"
                            ) { id, harness in usage.openSession(id, harness: harness) }
                            .equatable()
                            Text(verbatim: item.evidence)
                                .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(2)
                                .padding(.leading, 22)
                        }
                    }
                }
            }
        } else {
            UsageEmpty(loading: usage.loading.contains(.waste), symbol: "flame",
                       text: "No avoidable spend in this range.",
                       detail: "A rebuild counts when the cache was written again after an idle gap, a compaction or a model change.")
        }
    }

    static func kindTitle(_ kind: String) -> String {
        switch kind {
        case "cache-rebuild-idle": return "rebuild after idle"
        case "cache-rebuild-compaction": return "rebuild after compaction"
        case "cache-rebuild-model": return "rebuild after a model change"
        case "cache-rebuild-other": return "rebuild, prefix changed"
        default: return kind
        }
    }
}
