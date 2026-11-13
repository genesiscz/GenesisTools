import SwiftUI

/// Limits (UI1): the advisor's pick, the open alerts, the usage table, the burn lanes of the selected accounts (all
/// when none is selected) with their forecast, spikes, events and coverage, then the spikes of the range with the
/// sessions behind the one picked.
struct UsageLimitsSection: View {
    @ObservedObject var usage: HubUsageModel
    let settings: UsageSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            advice
            UsageAlertsStrip(usage: usage)
            table
            lanesBlock
            spikesBlock
        }
    }

    // MARK: Advice

    /// One summary line: "Use next", then each provider's pick with the room it has left. The advisor's reasoning
    /// (`tools ai usage limits advise`) is in each pick's tooltip; a click shows that account's lanes.
    @ViewBuilder
    private var advice: some View {
        let picks = (usage.advise?.data.providers ?? []).compactMap { provider -> (String, UsageAdvicePick)? in
            guard let pick = provider.profiles.first(where: { $0.profile == "default" })?.pick ?? provider.profiles.first?.pick else { return nil }
            return (provider.provider, pick)
        }
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
                        if let row { usage.select(account: row.id, additive: false) }
                    }
                    .equatable()
                }
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: Table

    @ViewBuilder
    private var table: some View {
        if usage.table.rows.isEmpty {
            UsageEmpty(loading: usage.loading.contains(.limits), symbol: "gauge.with.dots.needle.0percent",
                       text: "No account has a polled limit yet.",
                       detail: "The usage poller records each account's windows (tools ai usage daemon register).")
        } else {
            let columns = settings.hideEmptyColumns
                ? UsageTableBuilder.columnsWithReadings(usage.table.columns, rows: usage.table.rows)
                : usage.table.columns
            VStack(alignment: .leading, spacing: 2) {
                UsageTableHeader(columns: columns)
                ForEach(usage.table.rows) { row in
                    UsageTableRowView(row: row, columns: columns,
                                      selected: usage.selectedAccounts.contains(row.id), now: usage.builtAt) { additive in
                        usage.select(account: row.id, additive: additive)
                    }
                    .equatable()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: Lanes

    @ViewBuilder
    private var lanesBlock: some View {
        let shown = usage.shownLanes
        VStack(alignment: .leading, spacing: 8) {
            UsageSectionTitle(
                text: "Burn",
                detail: usage.selectedAccounts.isEmpty
                    ? "every account · click a row to show one, ⌘-click to compare"
                    : Plural.count(usage.selectedAccounts.count, "account") + " · click the row again to show all")
            if shown.isEmpty {
                UsageEmpty(loading: usage.loading.contains(.series), symbol: "chart.xyaxis.line",
                           text: "No readings in this range.", detail: "Pick a longer range above.")
            } else {
                UsageBurnChart(accounts: shown, domain: usage.domain, settings: settings, now: usage.builtAt) { spike in
                    usage.selectedSpike = spike
                }
                UsageLegend(settings: settings)
            }
        }
    }

    // MARK: Spikes

    @ViewBuilder
    private var spikesBlock: some View {
        let spikes = (usage.spikes?.data.spikes ?? []).sorted { $0.delta > $1.delta }
        // The top twelve, plus the spike a chart diamond selected when it ranks lower, so its sessions still show.
        let selected = spikes.dropFirst(12).first { $0.id == usage.selectedSpike?.id }
        let shown = Array(spikes.prefix(12)) + (selected.map { [$0] } ?? [])
        VStack(alignment: .leading, spacing: 6) {
            UsageSectionTitle(text: "Spikes", detail: spikes.isEmpty ? "none in this range" : Plural.count(spikes.count, "spike"))
            ForEach(shown) { spike in
                UsageSpikeRow(spike: spike, selected: usage.selectedSpike?.id == spike.id) {
                    usage.selectedSpike = usage.selectedSpike?.id == spike.id ? nil : UsageLaneBuilder.spike(spike)
                }
                .equatable()
                if usage.selectedSpike?.id == spike.id {
                    UsageSpikeSessions(spike: spike) { id, harness in usage.openSession(id, harness: harness) }
                }
            }
        }
    }
}



/// One provider's pick in the "Use next" line: its mark, the account, and the room left in its tightest window, said
/// plainly ("90% of the week left"). The tooltip spells out both windows and the advisor's own reasoning.
struct UsageAdvicePickChip: View, Equatable {
    let provider: String
    let pick: UsageAdvicePick
    let row: UsageTableRow?
    let now: Date
    let action: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.provider == rhs.provider && lhs.pick == rhs.pick && lhs.row == rhs.row && lhs.now == rhs.now
    }

    /// The windows the account has a reading for, as (name, cell).
    private var windows: [(String, UsageTableCell)] {
        [("the week", row?.cells["weekly"]), ("the 5h window", row?.cells["session"])].compactMap { name, cell in
            guard let cell, !cell.absent, cell.percent != nil else { return nil }
            return (name, cell)
        }
    }

    /// "90% of the week left": the window with the least room.
    private var room: String? {
        guard let tight = windows.max(by: { ($0.1.percent ?? 0) < ($1.1.percent ?? 0) }) else { return nil }
        return "\(Int(max(0, 100 - (tight.1.percent ?? 0)).rounded()))% of \(tight.0) left"
    }

    private var tooltip: String {
        let name = AIProviders.meta(for: provider).displayName
        var lines = ["\(name): the advisor picks \(pick.accountName) for the next session."]
        for (window, cell) in windows {
            let left = "\(Int(max(0, 100 - (cell.percent ?? 0)).rounded()))% of \(window) left"
            if let reset = cell.resetsAt, reset > now {
                lines.append(left.prefix(1).uppercased() + left.dropFirst() + ", resets in \(UsageFormat.countdown(to: reset, now: now)).")
            } else {
                lines.append(left.prefix(1).uppercased() + left.dropFirst() + ".")
            }
        }
        lines.append("Advisor: " + pick.why)
        if row != nil { lines.append("Click to show its lanes.") }
        return lines.joined(separator: "\n")
    }

    var body: some View {
        HStack(spacing: 5) {
            AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 13)
            Text(verbatim: pick.accountName)
                .font(.system(size: 12, weight: .medium))
                .foregroundColor(Color.white.opacity(0.88))
                .lineLimit(1)
            if let room {
                Text(verbatim: room)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 6)
        .frame(height: 22)
        .contentShape(Rectangle())
        // lint-rules-ignore: short list (one "Use next" chip per provider, at most a few)
        .rowButton(cornerRadius: 6, action)
        .instantTooltip(tooltip)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
    }
}

struct UsageSpikeRow: View, Equatable {
    let spike: UsageSpike
    let selected: Bool
    let action: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.spike == rhs.spike && lhs.selected == rhs.selected }

    var body: some View {
        let top = spike.sessions.first
        HStack(spacing: 8) {
            Image(systemName: "diamond.fill")
                .font(.system(size: 9))
                .foregroundColor(UsageTone.severity(top == nil ? "critical" : "warning"))
            Text(verbatim: "+\(Int(spike.delta.rounded()))")
                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                .frame(width: 34, alignment: .leading)
            Text(verbatim: spike.account.accountName)
                .font(.system(size: 12))
                .foregroundColor(Color.white.opacity(0.85))
            Text(verbatim: UsageFormat.windowName(kind: spike.kind, label: spike.key))
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
            Text(verbatim: UsageFormat.clock(UsageTime.date(spike.to)))
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
            Spacer(minLength: 6)
            Text(verbatim: top.map { "\(UsageFormat.project($0.project)) \(UsageFormat.usd($0.costUsd))" } ?? "unattributed")
                .font(.system(size: 11))
                .foregroundColor(top == nil ? UsageTone.severity("critical") : ReviewPalette.dim)
                .lineLimit(1)
            Image(systemName: selected ? "chevron.down" : "chevron.right")
                .font(.system(size: 9))
                .foregroundColor(ReviewPalette.dim)
        }
        .padding(.horizontal, 6)
        .frame(height: 24)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { GenMotion.perform(expanding: !selected, reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, action) }
        .liveRow(selected: selected)
        .accessibilityElement(children: .combine)
        .accessibilityHint(Text("Shows the sessions that spent on this account then"))
    }
}

/// The lanes' marks in words.
struct UsageLegend: View {
    let settings: UsageSettings

    var body: some View {
        HStack(spacing: 14) {
            if settings.spikeMarkers { item(Image(systemName: "diamond.fill"), UsageTone.severity("warning"), "spike (click: sessions)") }
            if settings.projection { item(Image(systemName: "line.diagonal"), .white, "projection to the reset") }
            if settings.cone { item(Image(systemName: "triangle.fill"), Color.white.opacity(0.4), "slow to fast pace") }
            if settings.safePace { item(Image(systemName: "line.diagonal"), Color(red: 0.45, green: 0.66, blue: 0.98), "safe pace") }
            if settings.eventMarkers { item(Image(systemName: "line.vertical"), UsageTone.event("rate-limited"), "rate limit, cooldown, probe") }
            item(Image(systemName: "square.fill"), Color.white.opacity(0.25), "no limit (hatched)")
        }
        .font(.system(size: 10.5))
        .foregroundColor(ReviewPalette.dim)
        .padding(.leading, UsageBurnChart.labelWidth + 6)
    }

    private func item(_ image: Image, _ tint: Color, _ text: String) -> some View {
        HStack(spacing: 4) {
            image.font(.system(size: 8)).foregroundColor(tint)
            Text(text)
        }
    }
}

/// The open alerts, newest first, at most three, each with Acknowledge.
struct UsageAlertsStrip: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        let open = (usage.alerts?.data.alerts ?? []).filter(\.isOpen).prefix(3)
        if !open.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(open)) { alert in
                    HStack(spacing: 8) {
                        Image(systemName: alert.level == "critical" ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                            .foregroundColor(UsageTone.alertLevel(alert.level))
                            .font(.system(size: 11))
                        // The part that differs comes first: two alerts of one kind share their title, so a cut
                        // title-first line read as the same words twice ("Usage runs out before the res…").
                        Text(verbatim: Self.lead(alert))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.9))
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                            .instantTooltip("\(alert.title)\n\(Self.lead(alert))")
                        // The shared title shows only when it fits whole: cut to its first letter it read as a stray "U".
                        ViewThatFits(in: .horizontal) {
                            Text(verbatim: alert.title)
                                .font(.system(size: 11))
                                .foregroundColor(ReviewPalette.dim)
                                .lineLimit(1)
                                .fixedSize()
                            Color.clear.frame(width: 0, height: 0)
                        }
                        Spacer(minLength: 6)
                        // The age and the button never give way: the message has priority over the title only.
                        LiveAgo(date: UsageTime.date(alert.firedAt), style: .brief)
                            .font(.system(size: 10.5))
                            .foregroundColor(ReviewPalette.dim)
                            .fixedSize()
                            .layoutPriority(2)
                        GhostButton("Acknowledge", symbol: "checkmark", tooltip: "Mark this alert as seen (tools ai usage alerts ack \(alert.id))", height: 22) {
                            usage.acknowledge(alert)
                        }
                        .fixedSize()
                        .layoutPriority(2)
                    }
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(UsageTone.alertLevel("warning").opacity(0.08)))
        }
    }

    /// The alert's own sentence, led by its account when the message does not already start with it.
    static func lead(_ alert: UsageAlert) -> String {
        guard let name = alert.accountName, !name.isEmpty, !alert.message.hasPrefix(name) else { return alert.message }
        return "\(name): \(alert.message)"
    }
}
/// Sessions attributed to a selected spike, shared by the Classic and compact account pages.
struct UsageSpikeSessions: View {
    let spike: UsageSpike
    let openSession: (String, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(spike.sessions.prefix(8)) { session in
                UsageSessionLine(
                    sessionId: session.sessionId, harness: session.agent, project: session.project,
                    costUsd: session.costUsd, share: session.share,
                    detail: session.approximate == true ? "by \(session.basis ?? "pin")" : nil
                ) { id, harness in openSession(id, harness) }
                .equatable()
            }
            if let unattributed = spike.unattributed, unattributed.costUsd > 0 {
                Text(verbatim: "Unattributed (another host or a missing pin): \(UsageFormat.usd(unattributed.costUsd))")
                    .font(.system(size: 11))
                    .foregroundColor(UsageTone.severity("critical"))
            }
        }
        .padding(.leading, 22)
        .transition(.genReveal)
    }
}
