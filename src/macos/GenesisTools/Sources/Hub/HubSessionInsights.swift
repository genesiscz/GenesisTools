import AppKit
import SwiftUI

// Session Details insights: the per-prompt cost timeline and the tool analytics in the sidebar. The
// numbers come from `tools hub insights <id> --json` (src/hub/lib/insights), run off the main thread
// and cached per session file by the CLI; nothing here recomputes them. A click on a bar or a tool
// reaches the transcript through `HubTranscriptBus` (jump to a turn, filter to one tool).

// MARK: - Payload

struct InsightTotals: Decodable, Equatable {
    var inputTokens = 0
    var outputTokens = 0
    var cacheReadTokens = 0
    var cacheWriteTokens = 0
    var reasoningTokens = 0
    var modelCalls = 0
    var costUsd: Double?
}

/// One prompt and the work until the next one (`TurnCost` in src/hub/lib/insights/types.ts).
struct InsightTurn: Decodable, Equatable, Identifiable {
    let number: Int
    let index: Int
    let turnId: String
    let label: String
    let at: String?
    let durationMs: Double?
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let reasoningTokens: Int
    let modelCalls: Int
    let costUsd: Double?
    let models: [String]
    let toolCount: Int
    let errorCount: Int
    let rank: Int?

    var id: String { turnId }
    /// Tokens billed near the input rate or above; cache reads cost a tenth and would flatten every bar.
    var billableTokens: Int { inputTokens + cacheWriteTokens + outputTokens }
    /// The transcript row the jump lands on: the prompt, or the list top for work before the first prompt.
    var rowId: String { number > 0 ? "p-\(turnId)" : "top" }
    var title: String { number > 0 ? "#\(number) \(label)" : label }
}

struct InsightTool: Decodable, Equatable, Identifiable {
    let name: String
    let count: Int
    let failures: Int
    let failureRate: Double
    let totalMs: Double
    let slowestMs: Double?
    let slowestToolId: String?
    let slowestTurnIndex: Int?
    let timing: String

    var id: String { name }
    var displayName: String { TranscriptDocument.displayName(name) }
}

/// `StuckVerdict` in src/hub/lib/insights/types.ts.
struct StuckVerdict: Decodable, Equatable {
    let kind: String
    let tool: String
    let argument: String
    let detail: String
    let since: String?
    let elapsedMs: Double?
    let count: Int
    let failures: Int
    let turnIndex: Int
    let toolId: String

    var isLoop: Bool { kind == "repeat-loop" }
    var badge: String { isLoop ? "loop" : "stuck" }
    var color: Color { isLoop ? SessionPalette.red : SessionPalette.orange }
    /// The header line: what, then the call itself.
    var line: String {
        let call = argument.isEmpty ? "" : ": \(argument)"
        return "\(isLoop ? "Looping" : "Stuck")? \(detail)\(call)"
    }
}

struct StuckThresholds: Decodable, Equatable {
    let toolMinutes: Int
    let repeats: Int
    let maxAgeHours: Int
    let activeMinutes: Int
}

struct SessionInsightsPayload: Decodable, Equatable {
    let sessionId: String
    let provider: String
    let turnCount: Int
    let priced: Bool
    let pricingNote: String
    let totals: InsightTotals
    let turns: [InsightTurn]
    let tools: [InsightTool]
    let stuck: StuckVerdict?
    let thresholds: StuckThresholds

    var ranked: [InsightTurn] { turns.filter { $0.rank != nil }.sorted { ($0.rank ?? 0) < ($1.rank ?? 0) } }
    /// Prompts only, for the handoff composer's range pickers.
    var prompts: [InsightTurn] { turns.filter { $0.number > 0 } }
}

enum HubInsights {
    static func decode(_ data: Data) throws -> SessionInsightsPayload {
        try JSONDecoder().decode(SessionInsightsPayload.self, from: MonitorJSON.dataByDroppingPreamble(data))
    }

    /// Blocking (a `tools` run; a cache hit is ~0.4 s, a large session's first run a few seconds): off the main thread.
    static func load(sessionId: String) throws -> SessionInsightsPayload {
        try decode(ToolsCLIRunner.run(["hub", "insights", sessionId, "--json"]))
    }
}

// MARK: - Transcript bus

/// What the sidebar asks of the transcript. A jump goes to the host first, which loads the window
/// holding the turn when it is before the loaded one, then tells the list to reveal the row.
enum HubTranscriptCommand: Equatable {
    case jump(turnIndex: Int, rowId: String)
    case reveal(rowId: String)
}

struct HubTranscriptMessage {
    let sessionId: String
    let command: HubTranscriptCommand
}

enum HubTranscriptBus {
    /// Sidebar → host (`HubSessionDetailHost`).
    static let request = Notification.Name("hub.transcript.request")
    /// Host → list (`SessionTranscriptList`, a marked adaptation).
    static let list = Notification.Name("hub.transcript.list")

    static func post(_ name: Notification.Name, sessionId: String, _ command: HubTranscriptCommand) {
        NotificationCenter.default.post(name: name, object: HubTranscriptMessage(sessionId: sessionId, command: command))
    }

    static func message(_ note: Notification, for name: Notification.Name, sessionId: String) -> HubTranscriptCommand? {
        guard note.name == name, let message = note.object as? HubTranscriptMessage, !sessionId.isEmpty, message.sessionId == sessionId else {
            return nil
        }

        return message.command
    }

    /// Only the calls of one tool, each under its prompt; a prompt with none of them goes.
    static func onlyTool(_ name: String?, in sections: [TranscriptSection]) -> [TranscriptSection] {
        guard let name else { return sections }
        return sections.compactMap { section in
            var copy = section
            copy.rows = section.rows.filter { row in
                if row.isPrompt { return true }
                if case .tool(let line) = row.kind { return line.name == name }
                return false
            }
            return copy.rows.contains { !$0.isPrompt } ? copy : nil
        }
    }

    /// The visible row that shows `rowId`: the row itself, or the folded group holding that call.
    static func visibleRow(_ rowId: String, in sections: [TranscriptSection]) -> String? {
        for section in sections {
            for row in section.rows {
                if row.id == rowId { return row.id }
                if case .toolGroup(let group) = row.kind, group.members.contains(where: { $0.id == rowId }) {
                    return row.id
                }
            }
        }
        return nil
    }

    static func contains(_ rowId: String, in sections: [TranscriptSection]) -> Bool {
        visibleRow(rowId, in: sections) != nil
    }
}

/// The transcript's tool filter per session: set by a click in the sidebar's tool list, cleared by
/// the chip it puts in the transcript toolbar. Keyed by session id so another session opens unfiltered.
@MainActor
final class HubTranscriptFilters: ObservableObject {
    static let shared = HubTranscriptFilters()
    @Published private(set) var tools: [String: String] = [:]

    func tool(for sessionId: String) -> String? { tools[sessionId] }

    func setTool(_ name: String?, for sessionId: String) {
        guard !sessionId.isEmpty, tools[sessionId] != name else { return }
        HubPerf.log("transcript.toolFilter \(sessionId.prefix(8)) \(name ?? "off")")
        tools[sessionId] = name
    }
}

// MARK: - Model

/// Loads one session's insights, off the main thread. A live session re-reads at most once per
/// `minInterval`: the session file grows with every tail event, and each growth is a cache miss.
@MainActor
final class SessionInsightsModel: ObservableObject {
    @Published private(set) var payload: SessionInsightsPayload?
    @Published private(set) var error: String?
    @Published private(set) var loading = false

    static let minInterval: TimeInterval = 90
    private var sessionId = ""
    private var lastLoad = Date.distantPast
    private var again = false
    private var scheduled: Task<Void, Never>?

    func open(_ id: String) async {
        scheduled?.cancel()
        scheduled = nil
        if id != sessionId {
            sessionId = id
            payload = nil
            error = nil
        }
        await load()
    }

    /// The transcript grew: reload now, or once the interval since the last load has passed.
    func grew() {
        guard !sessionId.isEmpty else { return }
        if loading {
            again = true
            return
        }

        let wait = Self.minInterval - Date().timeIntervalSince(lastLoad)
        guard wait > 0 else {
            Task { await load() }
            return
        }

        guard scheduled == nil else { return }
        scheduled = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            self?.scheduled = nil
            await self?.load()
        }
    }

    private func load() async {
        let id = sessionId
        loading = true
        lastLoad = Date()
        let span = HubPerf.begin("insights.load", String(id.prefix(8)), awaits: true)
        let result = await Task.detached(priority: .utility) { Result { try HubInsights.load(sessionId: id) } }.value
        guard id == sessionId else {
            span.end("superseded")
            return
        }

        loading = false
        switch result {
        case .success(let fresh):
            span.end("\(fresh.turns.count) prompts, \(fresh.tools.count) tools")
            if payload != fresh {
                payload = fresh
            }
            error = nil
            HubStuckStore.shared.apply(fresh.stuck, sessionId: id)
        case .failure(let failure):
            span.end("failed")
            error = "Insights failed: \(failure.localizedDescription)"
        }

        if again {
            again = false
            grew()
        }
    }
}

// MARK: - Formatting

enum InsightFormat {
    static func duration(ms: Double?) -> String {
        guard let ms else { return "—" }
        return SessionFormat.duration(ms / 1000)
    }

    /// One unit, for the sidebar's narrow table: "42s", "7m", "1.5h", "3d". Tooltips keep `duration`.
    static func compactDuration(ms: Double?) -> String {
        guard let ms else { return "—" }
        let seconds = ms / 1000
        if seconds < 1 { return "<1s" }
        if seconds < 60 { return "\(Int(seconds))s" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86_400 { return String(format: seconds < 36_000 ? "%.1fh" : "%.0fh", seconds / 3600) }
        return "\(Int(seconds / 86_400))d"
    }

    static func usd(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value < 0.01 && value > 0 ? "<$0.01" : SessionFormat.usd(value)
    }

    static func percent(_ rate: Double) -> String {
        rate <= 0 ? "0%" : rate < 0.01 ? "<1%" : "\(Int((rate * 100).rounded()))%"
    }

    /// `#942 fix the export · $18.33 · in 1.2K · cache 3.4M · out 12K · 14 tools, 2 failed · 12m`
    static func summary(_ turn: InsightTurn, priced: Bool) -> String {
        var parts = [turn.title]
        if priced || turn.costUsd != nil { parts.append(usd(turn.costUsd)) }
        if turn.inputTokens > 0 { parts.append("in \(SessionFormat.tokens(turn.inputTokens))") }
        let cache = turn.cacheReadTokens + turn.cacheWriteTokens
        if cache > 0 { parts.append("cache \(SessionFormat.tokens(cache))") }
        if turn.outputTokens > 0 { parts.append("out \(SessionFormat.tokens(turn.outputTokens))") }
        if turn.toolCount > 0 {
            parts.append("\(turn.toolCount) tool\(turn.toolCount == 1 ? "" : "s")" + (turn.errorCount > 0 ? ", \(turn.errorCount) failed" : ""))
        }
        if let ms = turn.durationMs { parts.append(duration(ms: ms)) }
        if !turn.models.isEmpty { parts.append(turn.models.joined(separator: ", ")) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Chart buckets

/// One bar: a prompt, or several consecutive prompts when the session has more than fit.
struct InsightBar {
    let turns: ArraySlice<InsightTurn>
    let cost: Double
    let input: Int
    let cacheWrite: Int
    let output: Int
    let cacheRead: Int
    /// The bar's most expensive prompt: what a click jumps to and the hover line names.
    let lead: InsightTurn
    /// The best rank inside the bar, for its marker.
    let rank: Int?

    var billable: Int { input + cacheWrite + output }

    /// At most `maxBars` bars, consecutive prompts summed when there are more. Empty for no turns.
    static func bucket(_ turns: [InsightTurn], maxBars: Int, priced: Bool) -> [InsightBar] {
        guard !turns.isEmpty, maxBars > 0 else { return [] }
        let size = Int((Double(turns.count) / Double(maxBars)).rounded(.up))
        return stride(from: 0, to: turns.count, by: size).map { start in
            let slice = turns[start..<min(start + size, turns.count)]
            let lead = slice.max { a, b in
                priced ? (a.costUsd ?? 0) < (b.costUsd ?? 0) : a.billableTokens < b.billableTokens
            } ?? slice[slice.startIndex]
            return InsightBar(
                turns: slice,
                cost: slice.reduce(0) { $0 + ($1.costUsd ?? 0) },
                input: slice.reduce(0) { $0 + $1.inputTokens },
                cacheWrite: slice.reduce(0) { $0 + $1.cacheWriteTokens },
                output: slice.reduce(0) { $0 + $1.outputTokens },
                cacheRead: slice.reduce(0) { $0 + $1.cacheReadTokens },
                lead: lead,
                rank: slice.compactMap(\.rank).min()
            )
        }
    }

    /// The bar under `x` in a chart `width` wide, or nil outside it.
    static func index(at x: CGFloat, width: CGFloat, count: Int) -> Int? {
        guard count > 0, width > 0, x >= 0, x < width else { return nil }
        return min(count - 1, Int(x / (width / CGFloat(count))))
    }
}

// MARK: - Sidebar sections

/// The sidebar's insights: cost timeline, tools, handoff. Loads when the sidebar shows, reloads
/// (throttled) as the transcript grows.
struct SessionInsightsSection: View {
    let session: HubSession
    /// The session's turn count as the transcript knows it; a change means the file grew.
    let turnCount: Int
    @StateObject private var model = SessionInsightsModel()
    @ObservedObject private var filters = HubTranscriptFilters.shared
    @State private var composer: HandoffComposerRequest?

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            if let payload = model.payload {
                TurnCostTimelineSection(payload: payload, onJump: jump, onHandoff: { turn in
                    composer = HandoffComposerRequest(session: session, prompts: payload.prompts, from: turn.number)
                })
                // Keyed by the transcript's own id, the one the list reads (`TranscriptServices.sessionId`).
                ToolAnalyticsSection(tools: payload.tools, active: filters.tool(for: payload.sessionId), onFilter: { name in
                    let current = filters.tool(for: payload.sessionId)
                    filters.setTool(current == name ? nil : name, for: payload.sessionId)
                }, onSlowest: { tool in
                    guard let index = tool.slowestTurnIndex, let id = tool.slowestToolId else { return }
                    jump(turnIndex: index, rowId: "t-\(id)")
                })
            } else if let error = model.error {
                Text(verbatim: error)
                    .font(.system(size: 11))
                    .foregroundStyle(SessionPalette.red)
                    .textSelection(.enabled)
            } else {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text("Reading cost and tool analytics…")
                }
                .font(.system(size: 11.5))
                .foregroundStyle(SessionPalette.faint)
            }
            HandoffSidebarRow(
                thresholds: model.payload?.thresholds,
                onCompose: { composer = HandoffComposerRequest(session: session, prompts: model.payload?.prompts ?? [], from: nil) }
            )
        }
        .task(id: session.sessionId) { await model.open(session.sessionId) }
        .onChange(of: turnCount) { model.grew() }
        .sheet(item: $composer) { request in
            HandoffComposerSheet(request: request) { composer = nil }
        }
        // `tools hub --handoff`: the publisher replays its current value, so a request made before
        // this sidebar appeared still opens the composer.
        .onReceive(HubHandoffRequests.shared.$pending) { pending in
            guard pending != nil, HubHandoffRequests.shared.claim(session.sessionId) else { return }
            composer = HandoffComposerRequest(session: session, prompts: model.payload?.prompts ?? [], from: nil)
        }
    }

    private func jump(_ turn: InsightTurn) {
        jump(turnIndex: turn.index, rowId: turn.rowId)
    }

    private func jump(turnIndex: Int, rowId: String) {
        HubTranscriptBus.post(HubTranscriptBus.request, sessionId: session.sessionId, .jump(turnIndex: turnIndex, rowId: rowId))
    }
}

/// Per-prompt bars (cost when every call is priced, tokens otherwise) with the most expensive
/// prompts marked. One Canvas, one hover handler and one tap handler: no view per bar, so a session
/// with hundreds of prompts costs one layer.
struct TurnCostTimelineSection: View {
    let payload: SessionInsightsPayload
    let onJump: (InsightTurn) -> Void
    let onHandoff: (InsightTurn) -> Void

    @AppStorage("hub.insights.metric", store: HubDefaults.store) private var metricRaw = "cost"
    @State private var hovered: Int?
    /// The chart's drawn width, for mapping a pointer position to a bar.
    @State private var chartWidth: CGFloat = 272

    static let chartHeight: CGFloat = 64
    static let maxBars = 90

    private var showsCost: Bool { payload.priced && metricRaw == "cost" }
    /// A file with no per-call usage (Grok) has nothing to chart or to switch between.
    private var hasUsage: Bool { payload.turns.contains { $0.billableTokens + $0.cacheReadTokens > 0 } }

    var body: some View {
        let bars = InsightBar.bucket(payload.turns, maxBars: Self.maxBars, priced: payload.priced)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                SessionSectionTitle(title: "Cost per prompt", count: payload.turns.count)
                Spacer(minLength: 4)
                if payload.priced && hasUsage {
                    MenuButton {
                        [
                            .action("Cost (list price)", checked: showsCost) { metricRaw = "cost" },
                            .action("Tokens", checked: !showsCost) { metricRaw = "tokens" },
                        ]
                    } label: {
                        HStack(spacing: 3) {
                            Text(verbatim: showsCost ? "Cost" : "Tokens")
                            Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
                        }
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(SessionPalette.dim)
                    }
                    .fixedSize()
                    .instantTooltip("What the bar height measures")
                }
            }
            .padding(.bottom, 2)
            if bars.isEmpty || !hasUsage {
                Text("This session's file records no token counts per prompt, so there is nothing to chart.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.faint)
            } else {
                chart(bars)
                Text(verbatim: hoverLine(bars))
                    .font(.system(size: 10.5))
                    .foregroundStyle(hovered == nil ? SessionPalette.faint : SessionPalette.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, minHeight: 28, alignment: .topLeading)
                ranked
            }
        }
        .accessibilityIdentifier("session-details-cost-timeline")
    }

    private func chart(_ bars: [InsightBar]) -> some View {
        let costMax = max(bars.map(\.cost).max() ?? 0, 0.000_001)
        let tokenMax = Double(max(bars.map(\.billable).max() ?? 0, 1))
        let readMax = Double(max(bars.map(\.cacheRead).max() ?? 0, 1))
        let cost = showsCost
        let focus = hovered
        return Canvas { context, size in
            let slot = size.width / CGFloat(bars.count)
            let gap: CGFloat = slot > 4 ? 1 : 0
            let top: CGFloat = 12
            let height = size.height - top
            for (i, bar) in bars.enumerated() {
                let x = CGFloat(i) * slot
                let width = max(1, slot - gap)
                func segment(_ fraction: Double, from base: CGFloat, color: Color) -> CGFloat {
                    let h = CGFloat(fraction) * height
                    guard h > 0 else { return base }
                    context.fill(Path(CGRect(x: x, y: size.height - base - h, width: width, height: h)), with: .color(color))
                    return base + h
                }
                let dim = focus != nil && focus != i
                let opacity = dim ? 0.55 : 1
                if cost {
                    _ = segment(bar.cost / costMax, from: 0, color: SessionPalette.orange.opacity(opacity))
                } else {
                    // Cache reads on their own scale, behind: they are 100× the rest and would flatten it.
                    _ = segment(Double(bar.cacheRead) / readMax, from: 0, color: Color.white.opacity(dim ? 0.05 : 0.09))
                    var base: CGFloat = 0
                    base = segment(Double(bar.input) / tokenMax, from: base, color: SessionPalette.blue.opacity(opacity))
                    base = segment(Double(bar.cacheWrite) / tokenMax, from: base, color: SessionPalette.purple.opacity(opacity))
                    _ = segment(Double(bar.output) / tokenMax, from: base, color: SessionPalette.green.opacity(opacity))
                }
                if let rank = bar.rank {
                    let marker = context.resolve(Text(verbatim: "\(rank)").font(.system(size: 8.5, weight: .bold)).foregroundColor(SessionPalette.red))
                    context.draw(marker, at: CGPoint(x: x + width / 2, y: 5))
                }
            }
        }
        .frame(height: Self.chartHeight)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { chartWidth = $0 }
        .background(RoundedRectangle(cornerRadius: 4).fill(Color.white.opacity(0.025)))
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            switch phase {
            case .active(let point):
                let index = InsightBar.index(at: point.x, width: chartWidth, count: bars.count)
                if index != hovered { hovered = index }
            case .ended:
                if hovered != nil { hovered = nil }
            }
        }
        .gesture(SpatialTapGesture().onEnded { tap in
            guard let index = InsightBar.index(at: tap.location.x, width: chartWidth, count: bars.count) else { return }
            onJump(bars[index].lead)
        })
        .instantTooltip("Click a bar to open its prompt in the transcript")
        .accessibilityIdentifier("session-details-cost-chart")
    }


    private func hoverLine(_ bars: [InsightBar]) -> String {
        guard let hovered, bars.indices.contains(hovered) else {
            let total = payload.priced ? "\(InsightFormat.usd(payload.totals.costUsd)) at list price" : "not every model has a price"
            return showsCost
                ? "\(total) · hover a bar, click to open its prompt"
                : "blue in · purple cache write · green out · grey cache reads (own scale)"
        }

        let bar = bars[hovered]
        let prefix = bar.turns.count > 1 ? "\(bar.turns.count) prompts, the costliest: " : ""
        return prefix + InsightFormat.summary(bar.lead, priced: payload.priced)
    }

    private var ranked: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(payload.ranked) { turn in
                HStack(spacing: 8) {
                    Text(verbatim: "\(turn.rank ?? 0)")
                        .font(SessionPalette.mono(10, weight: .bold))
                        .foregroundStyle(SessionPalette.red)
                        .frame(width: 14)
                    Text(verbatim: turn.title)
                        .font(.system(size: 12))
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(verbatim: payload.priced ? InsightFormat.usd(turn.costUsd) : SessionFormat.tokens(turn.billableTokens))
                        .font(SessionPalette.mono(11, weight: .semibold))
                        .foregroundStyle(payload.priced ? SessionPalette.orange : SessionPalette.secondary)
                        .fixedSize()
                }
                .padding(.horizontal, 4)
                .frame(height: 24)
                .contentShape(Rectangle())
                .rowButton(cornerRadius: 6) { onJump(turn) }
                .instantTooltip(InsightFormat.summary(turn, priced: payload.priced) + "\nClick to open it in the transcript")
                .contextMenu {
                    Button("Open in the transcript") { onJump(turn) }
                    Button("Compose a handoff from this prompt…") { onHandoff(turn) }
                    Button("Copy the summary") { PathOpener.copy(InsightFormat.summary(turn, priced: payload.priced), what: "summary") }
                }
            }
        }
        .accessibilityIdentifier("session-details-expensive-turns")
    }
}

/// Tools used in the session: calls, failure rate, total and slowest time. A click filters the
/// transcript to that tool's calls; a second click (or the toolbar chip) clears it.
struct ToolAnalyticsSection: View {
    let tools: [InsightTool]
    let active: String?
    let onFilter: (String) -> Void
    let onSlowest: (InsightTool) -> Void

    @State private var showAll = false
    private static let limit = 8

    var body: some View {
        let shown = showAll ? tools : Array(tools.prefix(Self.limit))
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                SessionSectionTitle(title: "Tools", count: tools.count)
                Spacer(minLength: 4)
                Text("calls · failed · total · slowest")
                    .font(.system(size: 9.5))
                    .foregroundStyle(SessionPalette.faint)
            }
            .padding(.bottom, 5)
            if tools.isEmpty {
                Text("No tool calls.")
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.faint)
                    .frame(height: 22)
            }
            ForEach(shown) { tool in
                row(tool)
            }
            if tools.count > Self.limit {
                Button(showAll ? "Show fewer" : "Show \(tools.count - Self.limit) more") { showAll.toggle() }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(SessionPalette.blue)
                    .padding(.leading, 4)
                    .frame(height: 22)
            }
            if tools.contains(where: { $0.timing != "exact" }) {
                Text("Times marked ≤ are the gap to the next transcript entry, an upper bound.")
                    .font(.system(size: 10))
                    .foregroundStyle(SessionPalette.faint)
                    .padding(.top, 4)
            }
        }
        .accessibilityIdentifier("session-details-tools")
    }

    private func row(_ tool: InsightTool) -> some View {
        let on = active == tool.name
        let bound = tool.timing == "exact" ? "" : "≤"
        return HStack(spacing: 6) {
            Image(systemName: TranscriptToolKind.of(tool.name).symbol)
                .font(.system(size: 10))
                .foregroundStyle(on ? SessionPalette.orange : SessionPalette.faint)
                .frame(width: 14)
            Text(verbatim: tool.displayName)
                .font(.system(size: 12, weight: on ? .semibold : .regular))
                .foregroundStyle(on ? SessionPalette.text : SessionPalette.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            Spacer(minLength: 4)
            Text(verbatim: "\(tool.count)")
                .foregroundStyle(SessionPalette.secondary)
                .fixedSize()
            Text(verbatim: InsightFormat.percent(tool.failureRate))
                .foregroundStyle(tool.failures > 0 ? SessionPalette.red : SessionPalette.faint)
                .frame(minWidth: 30, alignment: .trailing)
            Text(verbatim: bound + InsightFormat.compactDuration(ms: tool.totalMs > 0 ? tool.totalMs : nil))
                .foregroundStyle(SessionPalette.dim)
                .fixedSize()
                .frame(minWidth: 40, alignment: .trailing)
            Text(verbatim: bound + InsightFormat.compactDuration(ms: tool.slowestMs))
                .foregroundStyle(SessionPalette.dim)
                .fixedSize()
                .frame(minWidth: 36, alignment: .trailing)
        }
        .font(SessionPalette.mono(10.5))
        .padding(.horizontal, 4)
        .frame(height: 24)
        .background(RoundedRectangle(cornerRadius: 6).fill(on ? SessionPalette.orange.opacity(0.14) : Color.clear))
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6) { onFilter(tool.name) }
        .instantTooltip(tooltip(tool, on: on))
        .contextMenu {
            Button(on ? "Show every row again" : "Show only \(tool.displayName) calls") { onFilter(tool.name) }
            if tool.slowestToolId != nil {
                Button("Open the slowest call") { onSlowest(tool) }
            }
            Button("Copy the tool name") { PathOpener.copy(tool.name, what: "tool name") }
        }
    }

    private func tooltip(_ tool: InsightTool, on: Bool) -> String {
        let failed = tool.failures > 0 ? "\(tool.failures) failed (\(InsightFormat.percent(tool.failureRate)))" : "none failed"
        let timing = tool.timing == "exact" ? "exact times from the session file" : "times are upper bounds"
        let action = on ? "Click to show every row again" : "Click to show only these calls (in the loaded turns)"
        let bound = tool.timing == "exact" ? "" : "≤"
        let times = "total \(bound)\(InsightFormat.duration(ms: tool.totalMs > 0 ? tool.totalMs : nil)), slowest \(bound)\(InsightFormat.duration(ms: tool.slowestMs))"
        return "\(tool.name): \(tool.count) calls, \(failed), \(times), \(timing)\n\(action)"
    }
}
