import SwiftUI

extension WidgetUsageStore {
    /// The widget's Usage module. `ringWindow` reads the widget preference each time the module draws.
    func usageModule(ringWindow: @escaping () -> WidgetUsageRingWindow) -> WidgetModuleDescriptor {
        WidgetModuleDescriptor(
            id: WidgetModuleChoice.usage.id, title: WidgetModuleChoice.usage.title, symbol: WidgetModuleChoice.usage.symbol,
            tint: .mint,
            summary: { [weak self] in self?.summary ?? "AI usage" },
            visibilityChanged: { [weak self] in self?.visibilityChanged($0) }
        ) { [weak self] presentation in
            if let self {
                WidgetUsageModuleView(store: self, presentation: presentation, ringWindow: ringWindow())
            }
        }
    }

    /// "2 accounts over 75% · 1 alert".
    var summary: String {
        let high = rows.filter { row in row.cells.values.contains { ($0.percent ?? 0) >= 75 } }.count
        let alerts = openAlerts.count
        var parts: [String] = []
        if high > 0 { parts.append("\(Plural.count(high, "account")) over 75%") }
        if alerts > 0 { parts.append(Plural.count(alerts, "alert")) }
        return parts.isEmpty ? "Every account has room" : parts.joined(separator: " · ")
    }
}

/// Collapsed: one ring per account for its window. The hover preview and the panel: each account's 5h (or "no 5h"),
/// week and scoped windows, the burn against the safe pace, the time to the limit, and the open alerts with
/// Acknowledge and Open in the hub.
struct WidgetUsageModuleView: View {
    @ObservedObject var store: WidgetUsageStore
    let presentation: WidgetModulePresentation
    let ringWindow: WidgetUsageRingWindow

    var body: some View {
        Group {
            if presentation == .compact {
                compact
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    header
                    if let error = store.error {
                        Text(verbatim: error).font(.caption2).foregroundStyle(KitPalette.removed).lineLimit(3)
                    }
                    if store.rows.isEmpty, store.loading {
                        Label("Reading usage…", systemImage: "ellipsis").font(.caption)
                    } else if store.rows.isEmpty, store.error == nil {
                        Text("No account has a polled limit yet.").font(.caption).foregroundStyle(.secondary)
                    }
                    alertsList(limit: presentation == .expanded ? 3 : 1)
                    rowsList(limit: presentation == .expanded ? 40 : 5)
                }
                .padding(.horizontal, 18).padding(.vertical, 16)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("usage-widget")
    }

    /// The accounts that are fullest first, at most five rings.
    private var compact: some View {
        let ranked = store.rows
            .map { ($0, WidgetUsageStore.ring($0, window: ringWindow)) }
            .sorted { ($0.1.percent ?? -1) > ($1.1.percent ?? -1) }
            .prefix(5)
        return HStack(spacing: 7) {
            if ranked.isEmpty {
                Image(systemName: WidgetModuleChoice.usage.symbol).foregroundStyle(.mint)
                Text("Usage").font(.system(size: 11, weight: .medium))
            }
            ForEach(Array(ranked), id: \.0.id) { row, ring in
                UsageRing(percent: ring.percent, severity: ring.severity, size: 22)
                    .overlay(alignment: .bottomTrailing) {
                        if ring.absent {
                            Text("no 5h").font(.system(size: 6.5, weight: .bold)).foregroundStyle(.secondary).offset(x: 6, y: 4)
                        }
                    }
                    .instantTooltip("\(row.account.accountName): \(ring.label) \(UsageFormat.percent(ring.percent))\(ring.absent ? ", no 5h limit" : "")")
                    .accessibilityLabel(Text("\(row.account.accountName) \(ring.label) \(UsageFormat.percent(ring.percent))"))
            }
        }
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: WidgetModuleChoice.usage.symbol).foregroundStyle(.mint)
            Text("Usage").font(.system(size: 15, weight: .semibold))
            Spacer()
            if store.loading { SpinningArc(color: .mint).frame(width: 13, height: 13) }
            if let loadedAt = store.loadedAt {
                LiveAgo(date: loadedAt, style: .brief).font(.system(size: 10)).foregroundStyle(.secondary)
            }
            IconButton(systemName: "arrow.clockwise", tooltip: "Read usage again") { store.load() }
            IconButton(systemName: "chart.bar.xaxis", tooltip: "Open the hub's Usage mode") { store.openHub(["--mode", "usage"]) }
        }
    }

    @ViewBuilder
    private func alertsList(limit: Int) -> some View {
        ForEach(store.openAlerts.prefix(limit)) { alert in
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: alert.level == "critical" ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(UsageTone.alertLevel(alert.level)).font(.system(size: 11))
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: alert.title).font(.system(size: 12, weight: .medium)).lineLimit(2)
                    Text(verbatim: alert.message).font(.system(size: 10.5)).foregroundStyle(.secondary).lineLimit(2)
                    HStack(spacing: 6) {
                        GhostButton("Acknowledge", symbol: "checkmark", tooltip: "Mark this alert as seen", height: 20) {
                            store.acknowledge(alert)
                        }
                        if let account = alert.accountName ?? alert.accountId {
                            GhostButton("Open", symbol: "chart.xyaxis.line", tooltip: "Show \(account)'s burn lanes in the hub", height: 20) {
                                store.openHub(["--usage-account", account])
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func rowsList(limit: Int) -> some View {
        VStack(spacing: 0) {
            ForEach(store.rows.prefix(limit)) { row in
                WidgetUsageRow(row: row) { store.openHub(["--usage-account", row.account.accountId]) }
                    .equatable()
            }
        }
        if store.rows.count > limit {
            Text(verbatim: "\(store.rows.count - limit) more in the hub").font(.caption2).foregroundStyle(.secondary)
        }
    }
}

/// One account: its mark and name, 5h (or "no 5h"), week, then the time to the limit ("past reset" when it lasts)
/// above the burn against the safe pace.
struct WidgetUsageRow: View, Equatable {
    let row: UsageTableRow
    let open: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row }

    var body: some View {
        HStack(spacing: 7) {
            AIProviderGlyph(meta: AIProviders.meta(for: row.account.provider), size: 13)
            Text(verbatim: row.account.accountName).font(.system(size: 11.5)).lineLimit(1)
            Spacer(minLength: 4)
            cell("5h", row.cells["session"])
            cell("wk", row.cells["weekly"])
            VStack(alignment: .trailing, spacing: 0) {
                Text(verbatim: row.limitText ?? "—")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(row.limitBeforeReset ? UsageTone.severity("warning") : .secondary)
                Text(verbatim: UsageFormat.pace(row.ratePerHour, safe: row.safePerHour))
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            .lineLimit(1)
            .frame(width: 92, alignment: .trailing)
        }
        .frame(height: 24)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6, open)
        .liveRow()
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func cell(_ label: String, _ cell: UsageTableCell?) -> some View {
        if cell?.absent == true {
            Text("no \(label)").font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 46, alignment: .trailing)
        } else {
            Text(verbatim: "\(label) \(UsageFormat.percent(cell?.percent))")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(cell == nil ? Color.secondary : UsageTone.severity(cell?.severity))
                .frame(width: 58, alignment: .trailing)
        }
    }
}

/// A ring for a percent used, in its severity's colour; empty for no reading.
public struct UsageRing: View {
    let percent: Double?
    let severity: String?
    let size: CGFloat

    public init(percent: Double?, severity: String?, size: CGFloat = 22) {
        self.percent = percent
        self.severity = severity
        self.size = size
    }

    public var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: 2.5)
            Circle()
                .trim(from: 0, to: CGFloat(min(1, max(0, (percent ?? 0) / 100))))
                .stroke(UsageTone.severity(severity ?? percent.map(UsageTone.severity(forPercent:))), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(verbatim: percent.map { String(Int($0.rounded())) } ?? "—")
                .font(.system(size: size * 0.36, weight: .semibold, design: .monospaced))
        }
        .frame(width: size, height: size)
    }
}
