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

    @ViewBuilder
    private var advice: some View {
        let picks = (usage.advise?.data.providers ?? []).compactMap { provider -> (String, UsageAdvicePick)? in
            guard let pick = provider.profiles.first(where: { $0.profile == "default" })?.pick ?? provider.profiles.first?.pick else { return nil }
            return (provider.provider, pick)
        }
        if !picks.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(picks, id: \.0) { provider, pick in
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.right.circle").foregroundColor(ReviewPalette.added).font(.system(size: 11))
                        AIProviderGlyph(meta: AIProviders.meta(for: provider), size: 13)
                        Text(verbatim: "Next: \(pick.accountName)")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.88))
                        Text(verbatim: pick.why)
                            .font(.system(size: 11))
                            .foregroundColor(ReviewPalette.dim)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .instantTooltip("The account the advisor picks for the next session (tools ai usage limits advise): \(pick.why)")
                }
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
            VStack(alignment: .leading, spacing: 2) {
                UsageTableHeader(columns: usage.table.columns)
                ForEach(usage.table.rows) { row in
                    UsageTableRowView(row: row, columns: usage.table.columns,
                                      selected: usage.selectedAccounts.contains(row.id), now: usage.builtAt) { additive in
                        usage.select(account: row.id, additive: additive)
                    }
                    .equatable()
                }
            }
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
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(spike.sessions.prefix(8)) { session in
                            UsageSessionLine(
                                sessionId: session.sessionId, harness: session.agent, project: session.project,
                                costUsd: session.costUsd, share: session.share,
                                detail: session.approximate == true ? "by \(session.basis ?? "pin")" : nil
                            ) { id, harness in usage.openSession(id, harness: harness) }
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
        }
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
                        Text(verbatim: alert.title)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.9))
                        Text(verbatim: alert.message)
                            .font(.system(size: 11))
                            .foregroundColor(ReviewPalette.dim)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        LiveAgo(date: UsageTime.date(alert.firedAt), style: .brief)
                            .font(.system(size: 10.5))
                            .foregroundColor(ReviewPalette.dim)
                        GhostButton("Acknowledge", symbol: "checkmark", tooltip: "Mark this alert as seen (tools ai usage alerts ack \(alert.id))", height: 22) {
                            usage.acknowledge(alert)
                        }
                    }
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(UsageTone.alertLevel("warning").opacity(0.08)))
        }
    }
}
