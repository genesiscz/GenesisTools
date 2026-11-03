import Charts
import GenesisKitCharts
import SwiftUI

// UI5: Attribution (proposal 14), Efficiency (13), Plans (17), Agents (19) and the session analysis screen (2).

// MARK: - Attribution

/// Who ate the bar: a sunburst of one window's rise since its reset, by project, then session, then the session's
/// main loop and its sub-agents; the top sessions beside it with the points each took.
struct UsageAttributionSection: View {
    @ObservedObject var usage: HubUsageModel
    @State private var picked: String?
    @State private var focus: String?

    var body: some View {
        let bars = (usage.attribution?.data.bars ?? []).filter { $0.totalUsd > 0 }
        if let bar = bars.first(where: { $0.id == picked }) ?? bars.first {
            VStack(alignment: .leading, spacing: 14) {
                UsageSegments(options: bars, selection: Binding(get: { bar }, set: { picked = $0.id; focus = nil }),
                              title: \.pickerTitle, tooltip: { "Who ate \($0.account.accountName)'s \($0.windowTitle) since its reset" })
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(verbatim: UsageFormat.usd(bar.totalUsd)).font(.system(size: 18, weight: .semibold, design: .monospaced))
                    Text(verbatim: summary(bar)).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                HStack(alignment: .top, spacing: 24) {
                    SunburstChart(root: Self.tree(bar), focus: $focus, maxDepth: 3, identifier: "usage.attribution",
                                  valueText: { UsageFormat.usd($0) }) { id in
                        if let session = bar.sessions.first(where: { "s:" + $0.id == id }) {
                            usage.openSession(session.sessionId, harness: session.agent)
                        }
                    }
                    .frame(width: 320, height: 320)
                    VStack(alignment: .leading, spacing: 2) {
                        UsageSectionTitle(text: "Top sessions", detail: "points of the bar each took")
                        ForEach(bar.sessions.prefix(10)) { session in
                            UsageSessionLine(
                                sessionId: session.sessionId, harness: session.agent, project: session.project,
                                costUsd: session.costUsd, share: session.share,
                                detail: session.barPercent.map { Plural.count(Int($0.rounded()), "point") }
                            ) { id, harness in usage.openSession(id, harness: harness) }
                            .equatable()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else {
            UsageEmpty(loading: usage.loading.contains(.attribution), symbol: "chart.pie",
                       text: "No priced spend since the last reset of any window.")
        }
    }

    private func summary(_ bar: UsageAttributionBar) -> String {
        var parts = [bar.windowTitle]
        if let rise = bar.risePercent { parts.append("+\(Int(rise.rounded())) points since \(bar.sinceReset == true ? "the reset" : "the range start")") }
        if let per = bar.usdPerPercent { parts.append("\(UsageFormat.usd(per)) per point") }
        if let unpriced = bar.unpriced, unpriced > 0 { parts.append(Plural.count(unpriced, "unpriced event")) }
        return parts.joined(separator: " · ")
    }

    /// Projects, then their sessions, then each session's main loop and sub-agents; spend no account claims is a grey
    /// slice of its own.
    static func tree(_ bar: UsageAttributionBar) -> ChartNode {
        let byProject = Dictionary(grouping: bar.sessions, by: \.project)
        var children = bar.projects.map { project in
            ChartNode(
                id: "p:" + project.project, name: UsageFormat.project(project.project), value: project.costUsd,
                children: (byProject[project.project] ?? []).map { session in
                    ChartNode(
                        id: "s:" + session.id, name: String(session.sessionId.prefix(8)), value: session.costUsd,
                        children: [
                            ChartNode(id: "m:" + session.id, name: "main loop", value: session.mainUsd ?? 0),
                            ChartNode(id: "a:" + session.id, name: "sub-agents", value: session.subagentUsd ?? 0),
                        ])
                })
        }
        if let unattributed = bar.unattributed, unattributed.costUsd > 0 {
            children.append(ChartNode(id: "unattributed", name: "unpinned", value: unattributed.costUsd, muted: true))
        }
        return ChartNode(id: "root", name: bar.account.accountName, value: bar.totalUsd, children: children)
    }
}

extension UsageAttributionBar {
    var windowTitle: String { UsageFormat.windowName(kind: kind, label: key) }
    var pickerTitle: String { "\(account.accountName) \(windowTitle)" }
}

// MARK: - Efficiency

/// What one point buys per week, against the baseline, with the verdict when a week leaves it.
struct UsageEfficiencySection: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        let rows = usage.drift?.data.rows ?? []
        if rows.isEmpty {
            UsageEmpty(loading: usage.loading.contains(.drift), symbol: "scalemass",
                       text: "Not enough exclusive windows to measure a point yet.",
                       detail: "A week counts once one account rose while no other moved, at least five times.")
        } else {
            VStack(alignment: .leading, spacing: 18) {
                ForEach(rows) { row in
                    UsageDriftCard(row: row)
                }
            }
        }
    }
}

struct UsageDriftCard: View {
    let row: UsageDriftRow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                AIProviderGlyph(meta: AIProviders.meta(for: row.account.provider), size: 13)
                Text(verbatim: row.account.accountName).font(.system(size: 12.5, weight: .semibold))
                Text(verbatim: "\(UsageFormat.windowName(kind: row.kind, label: row.kind)) · \(row.model)")
                    .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                if let verdict = row.verdict, verdict != "ok" {
                    // A question ("limit cut?") is a finding; "steady" is the normal case.
                    let tint = verdict.hasSuffix("?") ? ReviewPalette.modified : ReviewPalette.dim
                    Text(verbatim: verdict)
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundColor(tint)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(tint.opacity(0.15)))
                        .instantTooltip("This week's interval left the baseline's: a point buys a different amount than before")
                }
                Spacer()
                if let week = row.weeks.last, let usd = week.usdPerPct {
                    Text(verbatim: "\(UsageFormat.usd(usd)) per point this week")
                        .font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                }
            }
            Chart {
                if let baseline = row.baseline, let ci = baseline.ci, ci.count == 2, let first = row.weeks.first, let last = row.weeks.last {
                    RectangleMark(xStart: .value("Week", first.week), xEnd: .value("Week", last.week),
                                  yStart: .value("Tokens", ci[0]), yEnd: .value("Tokens", ci[1]))
                        .foregroundStyle(Color.white.opacity(0.06))
                }
                ForEach(row.weeks) { week in
                    if let ci = week.ci, ci.count == 2 {
                        RuleMark(x: .value("Week", week.week), yStart: .value("Tokens", ci[0]), yEnd: .value("Tokens", ci[1]))
                            .foregroundStyle(Color.white.opacity(0.35))
                    }
                    if let tokens = week.tokensPerPct {
                        PointMark(x: .value("Week", week.week), y: .value("Tokens", tokens))
                            .foregroundStyle(week.status == "ok" ? Color(red: 0.45, green: 0.66, blue: 0.98) : ReviewPalette.modified)
                    }
                }
            }
            .chartYAxis { AxisMarks { value in
                AxisGridLine().foregroundStyle(Color.white.opacity(0.06))
                AxisValueLabel { Text(verbatim: UsageFormat.tokens(value.as(Double.self))).font(.system(size: 9.5)) }
            } }
            // The weeks in their own order: a category axis otherwise follows the order the marks first named them.
            .chartXScale(domain: row.weeks.map(\.week))
            .frame(height: 140)
            .accessibilityLabel(Text("Tokens per point by week for \(row.account.accountName)"))
            Text("Tokens per point by week, with the 95% interval; the band is the baseline.")
                .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.03)))
        .liveRow()
    }
}

// MARK: - Plans

/// Each subscription's current cycle: what it would have cost at list price, against the plan's price.
struct UsagePlansSection: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        let plans = usage.plans?.data.plans ?? []
        if plans.isEmpty {
            UsageEmpty(loading: usage.loading.contains(.plans), symbol: "creditcard", text: "No subscription account found.")
        } else {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(plans) { plan in
                    UsagePlanRow(plan: plan).equatable()
                }
                Text("List price: what the same tokens would cost on the API. Capacity: the sum of the weekly rises in this cycle.")
                    .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                    .padding(.top, 6)
            }
        }
    }
}

struct UsagePlanRow: View, Equatable {
    let plan: UsagePlanCycle

    var body: some View {
        HStack(spacing: 10) {
            AIProviderGlyph(meta: AIProviders.meta(for: plan.account.provider), size: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: plan.account.accountName).font(.system(size: 12, weight: .medium))
                Text(verbatim: "\(plan.plan ?? "no plan recorded") · \(UsageFormat.day(UsageTime.date(plan.cycle.from))) to \(UsageFormat.day(UsageTime.date(plan.cycle.to)))\(plan.cycle.guessed == true ? " (guessed)" : "")")
                    .font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
            }
            .frame(width: 220, alignment: .leading)
            metric(UsageFormat.usd(plan.spendUsd), "list price")
            if let paid = plan.paidBackX {
                metric(String(format: "%.1fx", paid), "paid back", tint: paid >= 1 ? ReviewPalette.added : ReviewPalette.modified)
            } else if let name = plan.plan {
                CopyChip(label: "set price", value: "tools ai-spend plans price \(plan.account.provider) \(name) <amount>",
                         tooltip: "Copy the command that sets this plan's price per cycle")
                    .frame(width: 92, alignment: .leading)
            } else {
                metric("—", "paid back")
            }
            metric(plan.capacityUsed.map { "\(Int(($0 * 100).rounded()))%" } ?? "—", "capacity used")
            metric(UsageFormat.usd(plan.usdPerWeeklyPoint), "per weekly point")
            Spacer(minLength: 0)
            if let days = plan.renewsInDays {
                // A cycle whose renewal passed has no new cycle recorded yet.
                let whole = Int(days.rounded())
                Text(verbatim: whole >= 0 ? "renews in \(Plural.count(whole, "day"))" : "renewal \(Plural.count(-whole, "day")) ago, no new cycle yet")
                    .font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
            }
        }
        .frame(height: 38)
        .liveRow()
    }

    private func metric(_ value: String, _ label: String, tint: Color = Color.white.opacity(0.88)) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: value).font(.system(size: 12, weight: .semibold, design: .monospaced)).foregroundColor(tint)
            Text(label).font(.system(size: 9.5)).foregroundColor(ReviewPalette.dim)
        }
        .frame(width: 92, alignment: .leading)
    }
}

// MARK: - Agents

/// Headless workers by backend, model and outcome, then what the ai-proxy served per client and per account.
struct UsageAgentsSection: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let workers = usage.workers, !workers.groups.isEmpty {
                UsageSectionTitle(text: "Workers", detail: workers.dimensions.joined(separator: " · "))
                HStack(spacing: 8) {
                    Text("Group").frame(maxWidth: .infinity, alignment: .leading)
                    Text("Sessions").frame(width: 60, alignment: .trailing)
                    Text("Turns").frame(width: 50, alignment: .trailing)
                    Text("API equiv.").frame(width: 76, alignment: .trailing)
                    Text("Billed").frame(width: 64, alignment: .trailing)
                    Text("As Opus").frame(width: 70, alignment: .trailing)
                }
                .font(.system(size: 10, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                VStack(spacing: 0) {
                    ForEach(workers.groups.sorted { $0.apiEquivalentUsd > $1.apiEquivalentUsd }) { group in
                        workerRow(group.label(workers.dimensions), group, failed: group.key?["outcome"].map { $0 != "completed" } ?? false)
                    }
                    if let total = workers.total {
                        Divider().overlay(ReviewPalette.hairline)
                        workerRow("Total", total, failed: false).font(.system(size: 11.5, weight: .semibold))
                    }
                }
                ForEach(workers.notes ?? [], id: \.self) { note in
                    Text(verbatim: note).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim)
                }
            } else {
                UsageEmpty(loading: usage.loading.contains(.workers), symbol: "person.2.wave.2", text: "No worker spend recorded.")
            }
            if let proxy = usage.proxy?.data {
                UsageSectionTitle(text: "ai-proxy clients", detail: "booked cost per month")
                VStack(spacing: 0) {
                ForEach(proxy.clients) { client in
                    HStack(spacing: 8) {
                        Text(verbatim: client.month).font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: client.client).font(.system(size: 12))
                        Spacer()
                        Text(verbatim: Plural.count(client.requests, "request")).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: UsageFormat.tokens(client.totalTokens)).font(.system(size: 11, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim).frame(width: 60, alignment: .trailing)
                        Text(verbatim: UsageFormat.usd(client.costUsd)).font(.system(size: 11.5, design: .monospaced))
                            .frame(width: 70, alignment: .trailing)
                    }
                    .frame(height: 22)
                    .liveRow()
                }
                }
                UsageSectionTitle(text: "ai-proxy accounts", detail: "requests, rate limits and errors per day")
                VStack(spacing: 0) {
                ForEach(proxy.accounts.prefix(30)) { day in
                    HStack(spacing: 8) {
                        Text(verbatim: day.day).font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: day.account).font(.system(size: 12))
                        Spacer()
                        Text(verbatim: Plural.count(day.requests, "request")).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: "\(day.rateLimited) limited").font(.system(size: 11))
                            .foregroundColor(day.rateLimited > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                        Text(verbatim: "\(day.errors) errors").font(.system(size: 11))
                            .foregroundColor(day.errors > 0 ? ReviewPalette.removed : ReviewPalette.dim)
                        Text(verbatim: day.cacheReadShare.map { "cache \(Int(($0 * 100).rounded()))%" } ?? "")
                            .font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                            .frame(width: 76, alignment: .trailing)
                    }
                    .frame(height: 22)
                    .liveRow()
                }
                }
            }
        }
    }

    private func workerRow(_ label: String, _ group: UsageWorkerGroup, failed: Bool) -> some View {
        HStack(spacing: 8) {
            Text(verbatim: label).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                .foregroundColor(failed ? ReviewPalette.modified : Color.white.opacity(0.85))
            Text(verbatim: String(group.sessions)).frame(width: 60, alignment: .trailing)
            Text(verbatim: String(group.turns)).frame(width: 50, alignment: .trailing)
            Text(verbatim: UsageFormat.usd(group.apiEquivalentUsd)).frame(width: 76, alignment: .trailing)
            Text(verbatim: UsageFormat.usd(group.billedUsd)).frame(width: 64, alignment: .trailing)
            Text(verbatim: UsageFormat.usd(group.claudeOpusUsd)).frame(width: 70, alignment: .trailing)
        }
        .font(.system(size: 11.5, design: .monospaced))
        .frame(height: 22)
        .liveRow()
    }
}

// MARK: - Session analysis

/// One session: cost by model, main loop and sub-agents, the cache, its losses and the costliest calls
/// (`tools ai sessions report <id> --json`).
struct UsageSessionSection: View {
    @ObservedObject var usage: HubUsageModel

    var body: some View {
        if let report = usage.report, report.session.sessionId == usage.analysisSession?.id {
            let body = report.report
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    ProviderBadge(provider: report.session.provider, size: 16)
                    Text(verbatim: report.session.sessionId).font(.system(size: 12, design: .monospaced))
                    CopyChip(label: "report", value: "tools ai sessions report \(report.session.sessionId)",
                             tooltip: "Copy the command that prints this report")
                    if let path = report.session.filePath {
                        PathLabel(path: path)
                    }
                }
                let noCalls = body.unsupportedReason("callTrace") != nil
                let noCompactions = body.unsupportedReason("compactions") != nil
                HStack(spacing: 18) {
                    metric(noCalls ? "—" : UsageFormat.usd(body.cost.totalUsd), "total")
                    metric(noCalls ? "—" : UsageFormat.usd(body.cost.mainUsd), "main loop")
                    metric(noCalls ? "—" : UsageFormat.usd(body.cost.subagentUsd), "sub-agents")
                    metric(noCalls ? "—" : UsageFormat.usd(body.cost.savingsUsd), "saved by the cache")
                    metric(noCalls ? "—" : String(body.overview.calls), "calls")
                    metric(body.overview.durationMinutes.map { UsageFormat.duration($0 * 60) } ?? "—", "span")
                    metric(noCompactions ? "—" : String(body.overview.compactions ?? 0), "compactions")
                }
                // A fact the transcript cannot give is named with its reason, so a dash never reads as zero.
                ForEach((body.unsupported ?? [:]).sorted { $0.key < $1.key }, id: \.key) { fact, reason in
                    Label {
                        Text(verbatim: "\(Self.factName(fact)) not measured: \(reason)")
                    } icon: {
                        Image(systemName: "info.circle")
                    }
                    .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                if let cache = body.cache {
                    Text(verbatim: "Cache hit \(UsageFormat.percent(cache.hitPercent)) (p10 \(UsageFormat.percent(cache.p10)), median \(UsageFormat.percent(cache.median)), p90 \(UsageFormat.percent(cache.p90))) over \(Plural.count(cache.requests, "request"))")
                        .font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                UsageSectionTitle(text: "Models")
                VStack(spacing: 0) {
                ForEach(body.models) { model in
                    HStack {
                        Text(verbatim: model.model).font(.system(size: 12))
                        Spacer()
                        Text(verbatim: Plural.count(model.calls, "call")).font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: UsageFormat.usd(model.costUsd)).font(.system(size: 11.5, design: .monospaced))
                            .frame(width: 72, alignment: .trailing)
                    }
                    .frame(height: 22)
                }
                }
                if !body.losses.isEmpty {
                    UsageSectionTitle(text: "Cache losses", detail: Plural.count(body.losses.count, "loss"))
                    VStack(spacing: 0) {
                    ForEach(body.losses) { loss in
                        HStack(spacing: 8) {
                            Image(systemName: loss.cause == "idle" ? "moon.zzz" : "arrow.triangle.2.circlepath")
                                .foregroundColor(ReviewPalette.modified).font(.system(size: 11))
                            Text(verbatim: "call \(loss.call)").font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                            Text(verbatim: loss.reason).font(.system(size: 12))
                            Spacer()
                            Text(verbatim: "\(UsageFormat.tokens(loss.before)) → \(UsageFormat.tokens(loss.after)) cached")
                                .font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                        }
                        .frame(height: 22)
                    }
                    }
                }
                UsageSectionTitle(text: "Costliest calls")
                VStack(spacing: 0) {
                ForEach(body.topCalls) { call in
                    HStack(spacing: 8) {
                        Text(verbatim: "#\(call.index)").font(.system(size: 11, design: .monospaced)).foregroundColor(ReviewPalette.dim)
                            .frame(width: 40, alignment: .leading)
                        Text(verbatim: UsageFormat.clock(UsageTime.date(call.t))).font(.system(size: 11, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                        Text(verbatim: call.model).font(.system(size: 11.5))
                        Text(verbatim: call.tags.joined(separator: ", ")).font(.system(size: 10.5)).foregroundColor(ReviewPalette.modified)
                        Spacer()
                        Text(verbatim: "\(UsageFormat.tokens(call.context)) context").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                        Text(verbatim: UsageFormat.usd(call.costUsd)).font(.system(size: 11.5, design: .monospaced))
                            .frame(width: 64, alignment: .trailing)
                    }
                    .frame(height: 22)
                    .liveRow()
                }
                }
            }
        } else {
            UsageEmpty(loading: usage.loading.contains(.report), symbol: "waveform.path.ecg.rectangle",
                       text: usage.analysisSession == nil ? "Pick a session to analyze." : "No report for this session.",
                       detail: "Analyze opens from a spike, the attribution, the waste list or the Today digest.")
        }
    }

    static func factName(_ fact: String) -> String {
        switch fact {
        case "callTrace": return "Model calls and cost"
        case "compactions": return "Compactions"
        default: return fact
        }
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: value).font(.system(size: 15, weight: .semibold, design: .monospaced))
            Text(label).font(.system(size: 10)).foregroundColor(ReviewPalette.dim)
        }
    }
}
