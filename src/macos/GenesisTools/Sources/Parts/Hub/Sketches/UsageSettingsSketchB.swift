import SwiftUI

// Hub UX wave 2, area "usageSettings", option B: the accounts are the navigation. Drawn only in a run started with
// `--sketch usageSettings=b` (GenesisKit `DesignSketch`); without the flag the hub draws its current Usage views.
//
// - The sidebar is the account source list: "All accounts", then each provider's accounts with the room left in
//   their tightest window. The Limits pane no longer repeats them as a table (C45).
// - "All accounts" is one bar per account (room left, reset, run-out) instead of a nine-column matrix (C44b).
// - An account opens its own page: its lanes first, under a time axis drawn above them, then its windows in words
//   and its spikes. Comparing every account's burn is a switch on "All accounts" (C47, sol-20).

/// The tightest window of an account (5h or week), from the cells the table row already has.
struct UsageSketchRoomB: Equatable {
    let window: String
    let used: Double
    let resetsAt: Date?
    let severity: String?

    var left: Int { Int(max(0, 100 - used).rounded()) }

    static func of(_ row: UsageTableRow) -> UsageSketchRoomB? {
        let windows: [(String, UsageTableCell?)] = [("5h", row.cells["session"]), ("week", row.cells["weekly"])]
        let readings = windows.compactMap { name, cell -> UsageSketchRoomB? in
            guard let cell, !cell.absent, let used = cell.percent else { return nil }
            return UsageSketchRoomB(window: name, used: used, resetsAt: cell.resetsAt, severity: cell.severity)
        }
        return readings.max { $0.used < $1.used }
    }
}

/// A thin bar of the room left, coloured by how much of the window is used.
struct UsageSketchRoomBarB: View {
    let room: UsageSketchRoomB?
    let width: CGFloat

    var body: some View {
        ZStack(alignment: .leading) {
            Capsule().fill(Color.white.opacity(0.08))
            if let room {
                Capsule()
                    .fill(UsageTone.severity(room.severity))
                    .frame(width: width * CGFloat(room.left) / 100)
            }
        }
        .frame(width: width, height: 4)
        .accessibilityHidden(true)
    }
}

/// The Usage sidebar of option B: the sections, then "All accounts" and every account grouped by provider. A click
/// opens that account's page in Limits; ⌘-click adds it beside the open one.
struct UsageSettingsSketchSidebarB: View {
    @ObservedObject var usage: HubUsageModel
    let filter: String

    private var groups: [(provider: String, rows: [UsageTableRow])] {
        var order: [String] = []
        var rows: [String: [UsageTableRow]] = [:]
        for row in usage.table.rows where UsageListView.matches(row.account, plan: row.plan, filter: filter) {
            if rows[row.account.provider] == nil { order.append(row.account.provider) }
            rows[row.account.provider, default: []].append(row)
        }
        return order.map { ($0, rows[$0] ?? []) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(HubUsageSection.allCases.filter { $0 != .session || usage.analysisSession != nil }) { section in
                    UsageSectionRow(section: section, selected: usage.section == section && !(section == .limits && !usage.selectedAccounts.isEmpty)) {
                        usage.section = section
                        if section == .limits { usage.selectedAccounts = [] }
                    }
                    .equatable()
                }
                if !usage.table.rows.isEmpty {
                    allAccounts
                        .padding(.top, 12)
                    ForEach(groups, id: \.provider) { group in
                        Text(verbatim: AIProviders.meta(for: group.provider).displayName)
                            .kicker(size: 9.5)
                            .padding(.top, 12)
                            .padding(.horizontal, 10)
                            .padding(.bottom, 2)
                        ForEach(group.rows) { row in
                            UsageSketchSidebarAccountRowB(
                                row: row, room: UsageSketchRoomB.of(row), now: usage.builtAt,
                                selected: usage.section == .limits && usage.selectedAccounts.contains(row.id)
                            ) { additive in
                                if additive {
                                    usage.select(account: row.id, additive: true)
                                } else {
                                    usage.selectedAccounts = [row.id]
                                }
                                usage.section = .limits
                            }
                            .equatable()
                        }
                    }
                    if groups.isEmpty {
                        Text("No account matches “\(filter.trimmingCharacters(in: .whitespaces))”")
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 10)
                    }
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .genScrollBars()
        }
    }

    private var allAccounts: some View {
        let selected = usage.section == .limits && usage.selectedAccounts.isEmpty
        return HStack(spacing: 8) {
            Image(systemName: "square.stack.3d.up")
                .font(.system(size: 11.5))
                .foregroundColor(selected ? .white : ReviewPalette.dim)
                .frame(width: 18)
            Text("All accounts")
                .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                .foregroundColor(Color.white.opacity(selected ? 0.95 : 0.78))
            Spacer(minLength: 0)
            Text(verbatim: "\(usage.table.rows.count)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) {
            usage.selectedAccounts = []
            usage.section = .limits
        }
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.1) : .clear))
        .liveRow(selected: selected)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// An account in option B's sidebar: health dot, name, a bar of the room left and its percent, the reset under it.
struct UsageSketchSidebarAccountRowB: View, Equatable {
    let row: UsageTableRow
    let room: UsageSketchRoomB?
    let now: Date
    let selected: Bool
    let action: (Bool) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.room == rhs.room && lhs.now == rhs.now && lhs.selected == rhs.selected
    }

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(UsageTone.outcome(row.health ?? "unmeasured")).frame(width: 5, height: 5)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: row.account.accountName)
                    .font(.system(size: 12, weight: selected ? .semibold : .regular))
                    .foregroundColor(Color.white.opacity(selected ? 0.95 : 0.82))
                    .lineLimit(1)
                Text(verbatim: resetLine)
                    .font(.system(size: 10))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 3) {
                Text(verbatim: room.map { "\($0.left)%" } ?? "–")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(UsageTone.severity(room?.severity))
                UsageSketchRoomBarB(room: room, width: 38)
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 34)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { action(NSEvent.modifierFlags.contains(.command)) }
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.1) : .clear))
        .liveRow(selected: selected)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(row.account.accountName), \(room.map { "\($0.left) percent of the \($0.window) window left" } ?? "no reading"), \(resetLine)"))
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private var resetLine: String {
        guard let room else { return "no reading" }
        guard let reset = room.resetsAt, reset > now else { return "left of the \(room.window)" }
        return "\(room.window) resets in \(UsageFormat.countdown(to: reset, now: now))"
    }
}

/// Limits, option B: "All accounts" (room bars, then the burn comparison on request), or the page of each selected
/// account (its lanes first, then its windows in words and its spikes).
struct UsageSettingsSketchLimitsB: View {
    @ObservedObject var usage: HubUsageModel
    let settings: UsageSettings
    /// "Compare burn" on All accounts: one lane per account on one axis. View state only.
    @State private var compare = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            UsageAlertsStrip(usage: usage)
            if usage.table.rows.isEmpty {
                UsageEmpty(loading: usage.loading.contains(.limits), symbol: "gauge.with.dots.needle.0percent",
                           text: "No account has a polled limit yet.",
                           detail: "The usage poller records each account's windows (tools ai usage daemon register).")
            } else if usage.selectedAccounts.isEmpty {
                overview
            } else {
                ForEach(usage.table.rows.filter { usage.selectedAccounts.contains($0.id) }) { row in
                    accountPage(row)
                }
            }
        }
    }

    // MARK: All accounts

    private var picks: Set<String> {
        let ids = (usage.advise?.data.providers ?? []).compactMap { provider -> String? in
            guard let pick = provider.profiles.first(where: { $0.profile == "default" })?.pick ?? provider.profiles.first?.pick else { return nil }
            return usage.table.rows.first { $0.account.provider == pick.provider && $0.account.accountId == pick.accountId }?.id
        }
        return Set(ids)
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text("Room left")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(Color.white.opacity(0.9))
                    Text("in each account's tightest window, the advisor's picks marked Use next")
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 4)
                ForEach(usage.table.rows) { row in
                    UsageSketchRoomRowB(row: row, room: UsageSketchRoomB.of(row), pick: picks.contains(row.id), now: usage.builtAt) {
                        usage.selectedAccounts = [row.id]
                    }
                    .equatable()
                }
            }
            Divider()
            HStack(spacing: 8) {
                Text("Burn")
                    .font(.system(size: 12.5, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.9))
                Text(compare ? "the deciding window of every account, on one axis" : "open an account for its lanes, or compare every account here")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                Spacer(minLength: 0)
                GenSegmentedTabs(
                    "Burn", items: [.init(false, "Hide"), .init(true, "Compare all")], selection: $compare,
                    minSegmentWidth: 84, identifier: "usageSketchB.compare")
            }
            if compare {
                comparison
            }
        }
    }

    /// One lane per account, its deciding window only (5h when it has one, else the week), 30 pt tall, under one axis.
    private var comparison: some View {
        VStack(alignment: .leading, spacing: 4) {
            UsageTimeAxis(domain: usage.domain, now: usage.builtAt)
                .padding(.leading, 150 + 6)
            ForEach(usage.lanes) { account in
                if let lane = account.lanes.first(where: { $0.kind == "session" && !$0.absentNow })
                    ?? account.lanes.first(where: { $0.kind == "weekly" })
                {
                    HStack(spacing: 6) {
                        HStack(spacing: 5) {
                            AIProviderGlyph(meta: AIProviders.meta(for: account.account.provider), size: 12)
                            Text(verbatim: account.account.accountName)
                                .font(.system(size: 11))
                                .foregroundColor(Color.white.opacity(0.8))
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            Text(verbatim: lane.title)
                                .font(.system(size: 10))
                                .foregroundColor(ReviewPalette.dim)
                        }
                        .frame(width: 150)
                        UsageBurnLaneView(lane: lane, domain: usage.domain, settings: settings, now: usage.builtAt,
                                          extendTo: usage.builtAt, labelled: false, height: 30)
                    }
                }
            }
        }
    }

    // MARK: One account

    private func accountPage(_ row: UsageTableRow) -> some View {
        let lanes = usage.lanes.filter { $0.account.id == row.id }
        let spikes = (usage.spikes?.data.spikes ?? []).filter { $0.account.id == row.id }.sorted { $0.delta > $1.delta }
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                AIProviderGlyph(meta: AIProviders.meta(for: row.account.provider), size: 16)
                Text(verbatim: row.account.accountName)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.95))
                if let plan = row.plan {
                    Text(verbatim: plan).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                Text(verbatim: "Poll: " + UsageTone.outcomeTitle(row.health ?? "unmeasured"))
                    .font(.system(size: 11))
                    .foregroundColor(UsageTone.outcome(row.health ?? "unmeasured"))
                if let verdict = row.verdict {
                    Text(verbatim: verdict)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(UsageTone.severity("warning"))
                }
                Spacer(minLength: 0)
                if usage.selectedAccounts.count == 1 {
                    Button("All accounts") { usage.selectedAccounts = [] }
                        .buttonStyle(.genHoverPlain())
                        .font(.system(size: 11.5))
                }
            }
            if let error = row.error {
                NoticePill(text: "The last poll of this account failed.", more: error, tone: .error)
            }
            Text(verbatim: summary(row))
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.78))
                .fixedSize(horizontal: false, vertical: true)
            if lanes.isEmpty {
                UsageEmpty(loading: usage.loading.contains(.series), symbol: "chart.xyaxis.line",
                           text: "No readings in this range.", detail: "Pick a longer range above.")
            } else {
                UsageTimeAxis(domain: usage.domain, now: usage.builtAt)
                    .padding(.leading, UsageBurnChart.labelWidth + 6)
                UsageBurnChart(accounts: lanes, domain: usage.domain, settings: settings, now: usage.builtAt) { spike in
                    usage.selectedSpike = spike
                }
                UsageLegend(settings: settings)
            }
            windows(row)
            if !spikes.isEmpty {
                UsageSectionTitle(text: "Spikes", detail: Plural.count(spikes.count, "spike") + " on this account")
                ForEach(spikes.prefix(6)) { spike in
                    UsageSpikeRow(spike: spike, selected: usage.selectedSpike?.id == spike.id) {
                        usage.selectedSpike = usage.selectedSpike?.id == spike.id ? nil : UsageLaneBuilder.spike(spike)
                    }
                    .equatable()
                }
            }
            Divider().padding(.top, 6)
        }
    }

    /// "Uses 30.0% of its 5h window per hour, faster than the safe 11.5%. Runs out at 01:46, before the reset."
    private func summary(_ row: UsageTableRow) -> String {
        var sentences: [String] = []
        if let room = UsageSketchRoomB.of(row) {
            var text = "\(room.left)% of the \(room.window) window left"
            if let reset = room.resetsAt, reset > usage.builtAt { text += ", reset in \(UsageFormat.countdown(to: reset, now: usage.builtAt))" }
            sentences.append(text + ".")
        }
        if let rate = row.ratePerHour, rate.isFinite {
            var text = "Burns " + String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), rate) + " an hour"
            if let safe = row.safePerHour, safe.isFinite {
                text += (rate > safe ? ", faster than the safe " : ", within the safe ")
                    + String(format: "%.1f%%", locale: Locale(identifier: "en_US_POSIX"), safe)
            }
            sentences.append(text + ".")
        }
        if let limit = row.limitText {
            sentences.append(limit == "past reset" ? "Lasts to its reset." : limit == "at limit" ? "At its limit now." : "Runs out at \(limit), before the reset.")
        }
        return sentences.isEmpty ? "No forecast for this account in this range." : sentences.joined(separator: " ")
    }

    /// Every window the account has, one line each: name, used, left, reset.
    private func windows(_ row: UsageTableRow) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(usage.table.columns.filter { row.cells[$0.id] != nil }) { column in
                let cell = row.cells[column.id]
                HStack(spacing: 10) {
                    Text(verbatim: column.title)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.75))
                        .frame(width: 90, alignment: .leading)
                    if cell?.absent == true {
                        Text("no limit").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    } else if let used = cell?.percent {
                        Text(verbatim: "\(UsageFormat.percent(used)) used")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundColor(UsageTone.severity(cell?.severity))
                            .frame(width: 90, alignment: .leading)
                        Text(verbatim: "\(Int(max(0, 100 - used).rounded()))% left")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundColor(Color.white.opacity(0.6))
                            .frame(width: 70, alignment: .leading)
                        if let reset = cell?.resetsAt, reset > usage.builtAt {
                            Text(verbatim: "resets in \(UsageFormat.countdown(to: reset, now: usage.builtAt))")
                                .font(.system(size: 11))
                                .foregroundColor(ReviewPalette.dim)
                        }
                    } else {
                        Text("no reading").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                    }
                    Spacer(minLength: 0)
                }
                .frame(height: 20)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// One account on option B's "All accounts": name, a wide bar of the room left, the words, the reset and the run-out.
struct UsageSketchRoomRowB: View, Equatable {
    let row: UsageTableRow
    let room: UsageSketchRoomB?
    let pick: Bool
    let now: Date
    let action: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.row == rhs.row && lhs.room == rhs.room && lhs.pick == rhs.pick && lhs.now == rhs.now
    }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                Circle().fill(UsageTone.outcome(row.health ?? "unmeasured")).frame(width: 6, height: 6)
                AIProviderGlyph(meta: AIProviders.meta(for: row.account.provider), size: 14)
                Text(verbatim: row.account.accountName)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.9))
                    .lineLimit(1)
                if pick {
                    Text("Use next")
                        .font(.system(size: 9.5, weight: .semibold))
                        .foregroundStyle(ReviewPalette.added)
                }
            }
            .frame(width: 240, alignment: .leading)
            UsageSketchRoomBarB(room: room, width: 260)
            Text(verbatim: room.map { "\($0.left)% of \($0.window) left" } ?? "no reading")
                .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                .foregroundStyle(room == nil ? Color.white.opacity(0.35) : UsageTone.severity(room?.severity))
                .frame(width: 140, alignment: .leading)
            Text(verbatim: resetText)
                .font(.system(size: 11))
                .foregroundStyle(Color.white.opacity(0.55))
                .frame(width: 130, alignment: .leading)
            Text(verbatim: runOutText)
                .font(.system(size: 11))
                .foregroundStyle(row.limitBeforeReset ? UsageTone.severity("warning") : Color.white.opacity(0.45))
                .lineLimit(1)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 9))
                .foregroundColor(ReviewPalette.dim)
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6, action)
        .liveRow(selected: false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: [row.account.accountName, room.map { "\($0.left) percent of the \($0.window) window left" } ?? "no reading", resetText, runOutText].filter { !$0.isEmpty }.joined(separator: ", ")))
        .accessibilityHint(Text("Opens this account's page"))
        .accessibilityAddTraits(.isButton)
    }

    private var resetText: String {
        guard let reset = room?.resetsAt, reset > now else { return "" }
        return "resets in \(UsageFormat.countdown(to: reset, now: now))"
    }

    private var runOutText: String {
        guard let text = row.limitText else { return "" }
        if text == "past reset" { return "lasts to its reset" }
        return text == "at limit" ? "at its limit" : "runs out \(text)"
    }
}
