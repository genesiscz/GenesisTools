import SwiftUI

// Hub UX wave 2, area "usageSettings", option A: decide first, details on demand.
// HubLayout reads the saved choice, Classic by default; --sketch usageSettings=a overrides it for this process.
//
// - The sidebar holds the Usage sections only. The accounts live once, in the Limits table (C45).
// - The Limits table answers "which account next" in four columns: account, room left now, reset, run-out. "All
//   windows" brings back the full matrix of the current view (C44b).
// - The table and the lanes sit side by side: the focused account's lanes are on screen at once, under a time axis
//   drawn above them, and "Compare all" is one click away (C47, sol-20).

/// The Usage sidebar of option A: the sections, nothing else. The accounts are rows of the Limits table.
struct UsageSettingsSketchSidebarA: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(HubUsageSection.allCases.filter { $0 != .session || usage.analysisSession != nil }) { section in
                    UsageSectionRow(section: section, selected: usage.section == section) {
                        usage.section = section
                    }
                    .equatable()
                }
                Text("Accounts are rows of the Limits table. Filter accounts narrows that table.")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10)
                    .padding(.top, 12)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .genScrollBars()
        }
    }
}

/// The window with the least room left now (the 5h window or the week), from the cells the table row already has.
struct UsageSketchRoomA: Equatable {
    let window: String
    let used: Double
    let resetsAt: Date?
    let severity: String?

    var left: Int { Int(max(0, 100 - used).rounded()) }

    static func of(_ row: UsageTableRow) -> UsageSketchRoomA? {
        let windows: [(String, UsageTableCell?)] = [("5h", row.cells["session"]), ("week", row.cells["weekly"])]
        let readings = windows.compactMap { name, cell -> UsageSketchRoomA? in
            guard let cell, !cell.absent, let used = cell.percent else { return nil }
            return UsageSketchRoomA(window: name, used: used, resetsAt: cell.resetsAt, severity: cell.severity)
        }
        return readings.max { $0.used < $1.used }
    }
}

/// Limits, option A: the "Use next" line and the alerts, then the account table on the left and the focused account's
/// lanes on the right, then the spikes of what the lanes show.
struct UsageSettingsSketchLimitsA: View {
    @ObservedObject var usage: HubUsageModel
    let settings: UsageSettings
    /// The sidebar's "Filter accounts…" text: it narrows the table, since the sidebar has no account rows.
    let filter: String
    /// The two display choices are Usage preferences (Settings → Usage charts, Limits table), so a return to Limits
    /// keeps them: they were view state and reset to Decide and This account.
    @ObservedObject private var preferences = UsagePreferences.shared
    /// "All windows": the full matrix of the current view instead of the four decision columns.
    private var allWindows: Bool { preferences.settings.limitsAllWindows }
    /// "Compare all": every account's lanes instead of the focused account's.
    private var compareAll: Bool { preferences.settings.compareAllAccounts }

    /// A row is marked while it is selected; with no selection, the account the lanes show.
    private func marked(_ row: UsageTableRow) -> Bool {
        usage.selectedAccounts.isEmpty ? row.id == focusID : usage.selectedAccounts.contains(row.id)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            advice
            UsageAlertsStrip(usage: usage)
            if usage.table.rows.isEmpty {
                UsageEmpty(loading: usage.loading.contains(.limits), symbol: "gauge.with.dots.needle.0percent",
                           text: "No account has a polled limit yet.",
                           detail: "The usage poller records each account's windows (tools ai usage daemon register).")
            } else {
                if allWindows {
                    // Every window is a wide table: the lanes go below it, not beside a fixed 900 pt column.
                    VStack(alignment: .leading, spacing: 16) {
                        accounts
                        Divider()
                        lanes
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                } else {
                    HStack(alignment: .top, spacing: 0) {
                        accounts
                            .frame(width: 470, alignment: .topLeading)
                        Divider()
                            .padding(.horizontal, 16)
                        lanes
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                }
            }
            spikes
        }
    }

    // MARK: Focus

    private var picks: [(String, UsageAdvicePick)] {
        (usage.advise?.data.providers ?? []).compactMap { provider -> (String, UsageAdvicePick)? in
            guard let pick = provider.profiles.first(where: { $0.profile == "default" })?.pick ?? provider.profiles.first?.pick else { return nil }
            return (provider.provider, pick)
        }
    }

    /// The account the lanes show: the selected one, else the advisor's first pick, else the first row.
    private var focusID: String? {
        if let selected = usage.selectedAccounts.first { return selected }
        if let pick = picks.first?.1,
            let row = usage.table.rows.first(where: { $0.account.provider == pick.provider && $0.account.accountId == pick.accountId })
        {
            return row.id
        }
        return usage.table.rows.first?.id
    }

    private var focusRow: UsageTableRow? {
        guard let focusID else { return nil }
        return usage.table.rows.first { $0.id == focusID }
    }

    private var rows: [UsageTableRow] {
        usage.table.rows.filter { UsageListView.matches($0.account, plan: $0.plan, filter: filter) }
    }

    // MARK: Advice

    @ViewBuilder
    private var advice: some View {
        if !picks.isEmpty {
            HStack(spacing: 12) {
                HStack(spacing: 5) {
                    Image(systemName: "arrow.right.circle").foregroundColor(ReviewPalette.added).font(.system(size: 11))
                    Text("Use next")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.88))
                }
                ForEach(picks, id: \.0) { provider, pick in
                    let row = usage.table.rows.first { $0.account.provider == pick.provider && $0.account.accountId == pick.accountId }
                    UsageAdvicePickChip(provider: provider, pick: pick, row: row, now: usage.builtAt) {
                        // Selects the pick, never toggles it off: a toggle cleared a selected pick and the lanes fell
                        // back to the first provider's.
                        if let row { usage.selectedAccounts = [row.id] }
                    }
                    .equatable()
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: Accounts

    private var accounts: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Accounts")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.9))
                Text(verbatim: Plural.count(rows.count, "account"))
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                Spacer(minLength: 0)
                GenSegmentedTabs(
                    "Columns", items: [.init(false, "Decide"), .init(true, "All windows")], selection: preferences.binding(\.limitsAllWindows),
                    minSegmentWidth: 84, identifier: "usageSketchA.columns")
                    .instantTooltip("Decide shows the room left, the reset and the run-out. All windows shows every window, the burn rate and the trend.")
            }
            if rows.isEmpty {
                // The filter hides every account: the headers alone said nothing.
                Text("No account matches “\(filter.trimmingCharacters(in: .whitespaces))”")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                    .padding(.vertical, 8)
            } else if allWindows {
                fullMatrix
            } else {
                decisionTable
            }
        }
    }

    private var decisionTable: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Text("Account").frame(maxWidth: .infinity, alignment: .leading)
                Text("Left now").frame(width: 132, alignment: .leading)
                Text("Resets in").frame(width: 70, alignment: .leading)
                Text("Runs out").frame(width: 76, alignment: .leading)
            }
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Color.white.opacity(0.45))
            .padding(.leading, 22)
            .padding(.trailing, 8)
            .accessibilityHidden(true)
            ForEach(rows) { row in
                UsageSketchAccountRowA(
                    row: row, room: UsageSketchRoomA.of(row), selected: marked(row), now: usage.builtAt
                ) { additive in
                    usage.select(account: row.id, additive: additive)
                }
                .equatable()
            }
        }
    }

    /// The current view's matrix, unchanged, for the reader who wants every window.
    private var fullMatrix: some View {
        let columns = settings.hideEmptyColumns
            ? UsageTableBuilder.columnsWithReadings(usage.table.columns, rows: usage.table.rows)
            : usage.table.columns
        return VStack(alignment: .leading, spacing: 2) {
            UsageTableHeader(columns: columns)
            ForEach(rows) { row in
                UsageTableRowView(row: row, columns: columns, selected: marked(row), now: usage.builtAt) { additive in
                    usage.select(account: row.id, additive: additive)
                }
                .equatable()
            }
        }
    }

    // MARK: Lanes

    private var shownLanes: [UsageAccountLanes] {
        if compareAll { return usage.lanes }
        let ids = usage.selectedAccounts.isEmpty ? [focusID].compactMap { $0 } : usage.selectedAccounts
        return usage.lanes.filter { ids.contains($0.account.id) }
    }

    private var lanes: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: lanesTitle)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(Color.white.opacity(0.9))
                        .lineLimit(1)
                    Text(verbatim: lanesDetail)
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                GenSegmentedTabs(
                    "Lanes", items: [.init(false, "This account"), .init(true, "Compare all")], selection: preferences.binding(\.compareAllAccounts),
                    minSegmentWidth: 96, identifier: "usageSketchA.lanes")
            }
            if shownLanes.isEmpty {
                UsageEmpty(loading: usage.loading.contains(.series), symbol: "chart.xyaxis.line",
                           text: "No readings in this range.", detail: "Pick a longer range above.")
            } else {
                // The time axis sits above the lanes as well as under them, so the reader sees the hours before the
                // first lane, not after scrolling past every account.
                UsageTimeAxis(domain: usage.domain, now: usage.builtAt)
                    .padding(.leading, UsageBurnChart.labelWidth + 6)
                UsageBurnChart(accounts: shownLanes, domain: usage.domain, settings: settings, now: usage.builtAt) { spike in
                    usage.selectedSpike = spike
                }
                UsageLegend(settings: settings)
            }
        }
    }

    private var lanesTitle: String {
        if compareAll { return "Burn of every account" }
        if usage.selectedAccounts.count > 1 { return "Burn of \(Plural.count(usage.selectedAccounts.count, "account"))" }
        return focusRow.map { "Burn of \($0.account.accountName)" } ?? "Burn"
    }

    private var lanesDetail: String {
        if compareAll { return "One axis for all accounts. Click a table row to show one account." }
        guard let row = focusRow else { return "" }
        var parts: [String] = []
        if let room = UsageSketchRoomA.of(row) {
            var text = "\(room.left)% of the \(room.window) window left"
            if let reset = room.resetsAt, reset > usage.builtAt {
                text += ", resets in \(UsageFormat.countdown(to: reset, now: usage.builtAt))"
            }
            parts.append(text)
        }
        if usage.selectedAccounts.isEmpty { parts.append("the advisor's pick until you click a row") }
        return parts.joined(separator: " · ")
    }

    // MARK: Spikes

    @ViewBuilder
    private var spikes: some View {
        let ids = Set(shownLanes.map(\.account.id))
        let all = (usage.spikes?.data.spikes ?? []).filter { ids.contains($0.account.id) }.sorted { $0.delta > $1.delta }
        VStack(alignment: .leading, spacing: 6) {
            UsageSectionTitle(
                text: "Spikes",
                detail: all.isEmpty ? "none for these lanes in this range" : Plural.count(all.count, "spike") + " for these lanes")
            ForEach(all.prefix(8)) { spike in
                UsageSpikeRow(spike: spike, selected: usage.selectedSpike?.id == spike.id) {
                    usage.selectedSpike = usage.selectedSpike?.id == spike.id ? nil : UsageLaneBuilder.spike(spike)
                }
                .equatable()
                if usage.selectedSpike?.id == spike.id {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(spike.sessions.prefix(8)) { session in
                            UsageSessionLine(
                                sessionId: session.sessionId, harness: session.agent, project: session.project,
                                costUsd: session.costUsd, share: session.share,
                                detail: session.approximate == true ? "by \(session.basis ?? "pin")" : nil
                            ) { id, harness in usage.openSession(id, harness: harness) }
                            .equatable()
                        }
                    }
                    .padding(.leading, 22)
                    .transition(.genReveal)
                }
            }
        }
    }
}

/// One account in option A's decision table: health dot, provider mark, name, a bar of the room left in its tightest
/// window with the words, the reset and the run-out.
struct UsageSketchAccountRowA: View, Equatable {
    let row: UsageTableRow
    let room: UsageSketchRoomA?
    let selected: Bool
    let now: Date
    let onSelect: (Bool) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.room == rhs.room && lhs.selected == rhs.selected && lhs.now == rhs.now
    }

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(UsageTone.outcome(row.health ?? "unmeasured"))
                .frame(width: 6, height: 6)
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
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            roomCell.frame(width: 132, alignment: .leading)
            Text(verbatim: resetText)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.white.opacity(0.6))
                .frame(width: 70, alignment: .leading)
            Text(verbatim: runOutText)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(row.limitBeforeReset ? UsageTone.severity("warning") : Color.white.opacity(0.45))
                .lineLimit(1)
                .frame(width: 76, alignment: .leading)
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { onSelect(NSEvent.modifierFlags.contains(.command)) }
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .liveRow(selected: selected)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: spoken))
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    @ViewBuilder
    private var roomCell: some View {
        if let room {
            HStack(spacing: 6) {
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule()
                        .fill(UsageTone.severity(room.severity))
                        .frame(width: 44 * CGFloat(room.left) / 100)
                }
                .frame(width: 44, height: 5)
                Text(verbatim: "\(room.left)% of \(room.window)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(UsageTone.severity(room.severity))
                    .lineLimit(1)
            }
        } else {
            Text("no reading")
                .font(.system(size: 11))
                .foregroundStyle(Color.white.opacity(0.35))
        }
    }

    private var resetText: String {
        guard let reset = room?.resetsAt, reset > now else { return "" }
        return UsageFormat.countdown(to: reset, now: now)
    }

    private var runOutText: String {
        guard let text = row.limitText else { return "" }
        return text == "past reset" ? "lasts" : text
    }

    private var spoken: String {
        var parts = [row.account.accountName]
        if let room { parts.append("\(room.left) percent of the \(room.window) window left") } else { parts.append("no reading") }
        if !resetText.isEmpty { parts.append("resets in \(resetText)") }
        if !runOutText.isEmpty { parts.append(runOutText == "lasts" ? "lasts to its reset" : "runs out \(runOutText)") }
        if let health = row.health { parts.append("poll \(health)") }
        if let verdict = row.verdict { parts.append(verdict) }
        return parts.joined(separator: ", ")
    }
}
