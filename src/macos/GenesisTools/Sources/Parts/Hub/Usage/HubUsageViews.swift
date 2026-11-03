import SwiftUI

/// The Usage mode's sidebar: the sections, then every account with the window that binds it now. A click on an
/// account opens Limits with that account's lanes; ⌘-click adds it to the lanes shown.
struct UsageListView: View {
    @ObservedObject var usage: HubUsageModel
    /// The sidebar's "Filter accounts…" text.
    let filter: String

    /// Whether an account row shows under the filter: its name, provider or plan holds every word (case-insensitive).
    static func matches(_ account: UsageAccountKey, plan: String?, filter: String) -> Bool {
        let text = [account.accountName, account.provider, plan ?? ""].joined(separator: " ").lowercased()
        return filter.lowercased().split(whereSeparator: \.isWhitespace).allSatisfy { text.contains($0) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(HubUsageSection.allCases.filter { $0 != .session || usage.analysisSession != nil }) { section in
                    UsageSectionRow(section: section, selected: usage.section == section) {
                        usage.section = section
                    }
                    .equatable()
                }
                if !usage.table.rows.isEmpty {
                    Text("Accounts")
                        .kicker(size: 9.5)
                        .padding(.top, 14)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 2)
                    let rows = usage.table.rows.filter { Self.matches($0.account, plan: $0.plan, filter: filter) }
                    if rows.isEmpty {
                        Text("No account matches “\(filter.trimmingCharacters(in: .whitespaces))”")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 10)
                    }
                    ForEach(rows) { row in
                        UsageAccountListRow(row: row, selected: usage.selectedAccounts.contains(row.id)) { additive in
                            usage.select(account: row.id, additive: additive)
                            usage.section = .limits
                        }
                        .equatable()
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
        }
    }
}

struct UsageSectionRow: View, Equatable {
    let section: HubUsageSection
    let selected: Bool
    let action: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.section == rhs.section && lhs.selected == rhs.selected }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: section.symbol)
                .font(.system(size: 11.5))
                .foregroundColor(selected ? .white : ReviewPalette.dim)
                .frame(width: 18)
            Text(section.title)
                .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                .foregroundColor(Color.white.opacity(selected ? 0.95 : 0.78))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6, action)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.1) : .clear))
        .instantTooltip(section.detail)
        .liveRow(selected: selected)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// An account in the sidebar: provider mark, name, and the binding window's percent.
struct UsageAccountListRow: View, Equatable {
    let row: UsageTableRow
    let selected: Bool
    let action: (Bool) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row && lhs.selected == rhs.selected }

    private var headline: (String, String?) {
        if let session = row.cells["session"], !session.absent { return (UsageFormat.percent(session.percent), session.severity) }
        if let week = row.cells["weekly"] { return (UsageFormat.percent(week.percent), week.severity) }
        return ("—", nil)
    }

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(UsageTone.outcome(row.health ?? "unmeasured")).frame(width: 5, height: 5)
            AIProviderGlyph(meta: AIProviders.meta(for: row.account.provider), size: 13)
            Text(verbatim: row.account.accountName)
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.82))
                .lineLimit(1)
            Spacer(minLength: 4)
            if row.cells["session"]?.absent == true {
                Text("no 5h").font(.system(size: 9.5)).foregroundColor(ReviewPalette.dim)
            }
            Text(verbatim: headline.0)
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(UsageTone.severity(headline.1))
        }
        .padding(.horizontal, 8)
        .frame(height: 24)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { action(NSEvent.modifierFlags.contains(.command)) }
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.1) : .clear))
        .liveRow(selected: selected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// The Usage mode's main view: the header (section, range, refresh, settings), the doors' warnings and failures, then
/// the open section.
struct UsageMain: View {
    var model: HubModel
    @ObservedObject var usage: HubUsageModel
    @ObservedObject private var preferences: UsagePreferences

    init(model: HubModel, usage: HubUsageModel) {
        self.model = model
        self.usage = usage
        preferences = usage.preferences
    }

    var body: some View {
        let _ = RenderProbe.hit("usage.main.body")
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(usage.sectionErrors, id: \.self) { error in
                        NoticePill(text: "A usage door failed.", more: error, tone: .error,
                                   fixes: [.button("Retry", symbol: "arrow.clockwise") { usage.reload() }])
                    }
                    if !usage.warnings.isEmpty {
                        InfoStrip(usage.warnings.map(\.message).joined(separator: "\n"))
                    }
                    content
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .hubSurface(.content)
        .onChange(of: preferences.settings) { old, new in
            if old.range != new.range || old.resolution != new.resolution || old.spendStack != new.spendStack {
                usage.rangeChanged()
            } else {
                usage.settingsChanged()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch usage.section {
        case .limits: UsageLimitsSection(usage: usage, settings: preferences.settings)
        case .spend: UsageSpendSection(usage: usage, settings: preferences.settings)
        case .waste: UsageWasteSection(usage: usage)
        case .attribution: UsageAttributionSection(usage: usage)
        case .efficiency: UsageEfficiencySection(usage: usage)
        case .plans: UsagePlansSection(usage: usage)
        case .agents: UsageAgentsSection(usage: usage)
        case .session: UsageSessionSection(usage: usage)
        }
    }

    /// The ranges apply to the sections that read a span; the others read their own (since the reset, the cycle).
    private var showsRange: Bool { [.limits, .spend, .waste].contains(usage.section) }

    private var header: some View {
        TitlebarHeader {
            HStack(spacing: 10) {
                Group {
                    Image(systemName: usage.section.symbol).foregroundColor(ReviewPalette.renamed)
                    Text(usage.section.title).font(.system(size: 14, weight: .semibold))
                    Text(verbatim: subtitle)
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                }
                .titlebarLabel()
                Spacer()
                if showsRange {
                    UsageSegments(options: UsageRange.allCases, selection: preferences.binding(\.range), title: \.title,
                                  tooltip: { "Show the last \($0.title)" })
                }
                if usage.sectionLoading {
                    RefreshingMark(showingCache: false, what: "usage")
                } else {
                    LiveAgo(date: usage.builtAt) { "read \($0)" }
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .titlebarLabel()
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Read this section's usage again") { usage.reload() }
                IconButton(systemName: "slider.horizontal.3", tooltip: "Usage chart settings: range, line shape, forecast, markers") {
                    FeatureSettingsLaunch.open(pageID: UsageSettingsPages.pageID)
                }
            }
        }
    }

    private var subtitle: String {
        switch usage.section {
        case .session: return usage.analysisSession.map { String($0.id.prefix(8)) } ?? "no session"
        case .limits:
            let accounts = usage.table.rows.count
            return accounts == 0 ? "" : Plural.count(accounts, "account")
        default: return usage.section.detail
        }
    }
}

/// A row of small segment buttons (a range, a stack), drawn, with one tooltip per segment.
struct UsageSegments<Option: Hashable & Identifiable>: View {
    let options: [Option]
    @Binding var selection: Option
    let title: KeyPath<Option, String>
    let tooltip: (Option) -> String

    var body: some View {
        HStack(spacing: 1) {
            ForEach(options) { option in
                let selected = option == selection
                Button {
                    selection = option
                } label: {
                    Text(option[keyPath: title])
                        .font(.system(size: 11, weight: selected ? .semibold : .regular))
                        .foregroundColor(selected ? .white : Color.white.opacity(0.62))
                        .padding(.horizontal, 8)
                        .frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: 5).fill(selected ? Color.white.opacity(0.16) : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(tooltip(option))
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(ReviewPalette.hairline))
    }
}

/// A section's title inside the scroll: a small kicker and an optional count.
struct UsageSectionTitle: View {
    let text: String
    var detail: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(text).font(.system(size: 12.5, weight: .semibold)).foregroundColor(Color.white.opacity(0.9))
            if let detail {
                Text(verbatim: detail).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
            }
            Spacer(minLength: 0)
        }
    }
}

/// Shown while a section's first read runs, and when it found nothing.
struct UsageEmpty: View {
    let loading: Bool
    let symbol: String
    let text: String
    var detail: String?

    var body: some View {
        if loading {
            SkeletonRows(count: 6, leading: .dot)
                .skeletonShimmer()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Reading usage")
        } else {
            EmptyState(symbol: symbol, text: text, detail: detail)
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
        }
    }
}

/// A session a usage row names: its project and cost, with Analyze (the session analysis screen) and the report
/// command to copy.
struct UsageSessionLine: View, Equatable {
    let sessionId: String
    let harness: String?
    let project: String
    let costUsd: Double
    let share: Double?
    let detail: String?
    let analyze: (String, String?) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.sessionId == rhs.sessionId && lhs.costUsd == rhs.costUsd && lhs.share == rhs.share && lhs.detail == rhs.detail
            && lhs.project == rhs.project && lhs.harness == rhs.harness
    }

    var body: some View {
        HStack(spacing: 8) {
            if let harness {
                ProviderBadge(provider: harness, size: 14)
            }
            Text(verbatim: UsageFormat.project(project))
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.85))
                .lineLimit(1)
            Text(verbatim: String(sessionId.prefix(8)))
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
            if let detail {
                Text(verbatim: detail).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(1)
            }
            Spacer(minLength: 6)
            if let share {
                ShareBar(share: share).frame(width: 60, height: 5)
            }
            Text(verbatim: UsageFormat.usd(costUsd))
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundColor(Color.white.opacity(0.85))
                .frame(width: 64, alignment: .trailing)
            IconButton(systemName: "waveform.path.ecg.rectangle", tooltip: "Analyze this session: cost by model, costliest calls, cache losses") {
                analyze(sessionId, harness)
            }
        }
        .frame(height: 24)
        .liveRow()
    }
}

/// A thin bar for a 0..1 share.
struct ShareBar: View {
    let share: Double
    var tint: Color = Color(red: 0.45, green: 0.66, blue: 0.98)

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule().fill(tint).frame(width: max(2, proxy.size.width * CGFloat(min(1, max(0, share)))))
            }
        }
        .accessibilityLabel(Text("\(Int((share * 100).rounded()))%"))
    }
}
