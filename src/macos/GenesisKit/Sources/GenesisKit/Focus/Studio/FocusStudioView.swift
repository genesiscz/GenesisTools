// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusStudioView.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Charts
import SwiftUI

/// Spec 22 (S6) §10.4 — Focus Studio.
///
/// Four views over one range: what happened (Timeline), where it went (Breakdown), when you are
/// good at this (Heatmap), and what each pomodoro actually contained (Sessions). Every number
/// here is printable from `genesis focus digest` for the same range, which is the rule that
/// keeps the two surfaces honest.
public struct FocusStudioView: View {
    public init(model: FocusStudioModel) { self.model = model }

    @ObservedObject public var model: FocusStudioModel

    public var body: some View {
        VStack(spacing: 0) {
            chrome
            Divider().overlay(Color.genGlassBorder)
            content
            Divider().overlay(Color.genGlassBorder)
            footer
        }
        .background(Color.genBackground)
        .frame(minWidth: 880, minHeight: 560)
        .task { model.reload() }
        // Without `children: .contain`, a container's identifier propagates to every descendant
        // and the whole window reports "focus-studio" — which makes every control in it
        // unaddressable by identifier, from the UI harness and from `tools control` alike.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("focus-studio")
    }

    // MARK: - Chrome

    private var chrome: some View {
        VStack(spacing: GenSpacing.sm) {
            HStack(spacing: GenSpacing.md) {
                Picker("", selection: $model.tab) {
                    ForEach(FocusStudioModel.Tab.allCases) { tab in Text(tab.rawValue).tag(tab) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 380)
                .accessibilityIdentifier("focus-studio-tabs")

                Spacer()

                HStack(spacing: GenSpacing.xs) {
                    stepButton("chevron.left", -1)
                    Text(model.range.label)
                        .font(GenTypography.mono(12))
                        .foregroundStyle(Color.genTextPrimary)
                        .frame(minWidth: 190)
                        .accessibilityIdentifier("focus-studio-range")
                    stepButton("chevron.right", 1)
                }

                Picker("", selection: Binding(
                    get: { model.range.granularity },
                    set: { model.setGranularity($0) })) {
                    ForEach(FocusRange.Granularity.allCases) { value in Text(value.rawValue).tag(value) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 150)
                .accessibilityIdentifier("focus-studio-granularity")
                .instantTooltip("Range length: day, week, month or year")
            }

            HStack(spacing: GenSpacing.sm) {
                sessionMenu
                filterMenu(title: "tag", options: model.availableTags, selection: $model.tagFilter)
                filterMenu(title: "project", options: model.availableProjects, selection: $model.projectFilter)
                TextField("filter windows and sites", text: $model.search)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 260)
                    .onSubmit { model.reload() }
                    .accessibilityIdentifier("focus-studio-search")
                    .instantTooltip("Match app, window title or site, then press Return")
                Spacer()
                Button("Copy digest") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(model.digestMarkdown(), forType: .string)
                }
                .buttonStyle(.genHover(accent: .genAccent))
                .font(GenTypography.caption(11, weight: .semibold))
                .foregroundStyle(Color.genAccent)
                .accessibilityIdentifier("focus-studio-copy")
                .instantTooltip("Copy this range's digest as Markdown")
            }
        }
        .padding(GenSpacing.md)
    }

    private func stepButton(_ symbol: String, _ delta: Int) -> some View {
        Button { model.step(delta) } label: {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Color.genTextSecondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverIcon())
        .accessibilityIdentifier(delta < 0 ? "focus-studio-prev" : "focus-studio-next")
        .accessibilityLabel(delta < 0 ? "Previous range" : "Next range")
        .instantTooltip(delta < 0 ? "Previous range" : "Next range")
    }

    /// Scope everything to one pomodoro. The whole day is the default; this is how you ask
    /// "what did that 25 minutes actually contain".
    private var sessionMenu: some View {
        Menu {
            Button("whole range") { model.sessionFilter = nil; model.reload() }
            if !model.sessionOptions.isEmpty { Divider() }
            ForEach(model.sessionOptions) { card in
                Button("\(FocusFormat.clockTime(card.startedMs))  \(card.kind.replacingOccurrences(of: "_", with: " "))"
                       + (card.tag.map { " · \($0)" } ?? "")
                       + "  \(FocusFormat.duration(card.actualMs))") {
                    model.sessionFilter = card.id
                    model.reload()
                }
            }
        } label: {
            Text(selectedSessionLabel)
                .font(GenTypography.caption(11))
                .foregroundStyle(model.sessionFilter == nil ? Color.genTextTertiary : Color.genAccent)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(model.sessionOptions.isEmpty)
        .genHoverEffect(accent: .genAccent)
        .accessibilityIdentifier("focus-studio-session-filter")
        .instantTooltip("Scope every tab to one pomodoro")
    }

    private var selectedSessionLabel: String {
        guard let id = model.sessionFilter,
              let card = model.sessionOptions.first(where: { $0.id == id })
        else { return "session: whole range" }
        return "session: \(FocusFormat.clockTime(card.startedMs))"
    }

    private func filterMenu(title: String, options: [String], selection: Binding<String?>) -> some View {
        Menu {
            Button("any \(title)") { selection.wrappedValue = nil; model.reload() }
            ForEach(options, id: \.self) { option in
                Button(option) { selection.wrappedValue = option; model.reload() }
            }
        } label: {
            Text(selection.wrappedValue.map { "\(title): \($0)" } ?? "\(title): any")
                .font(GenTypography.caption(11))
                .foregroundStyle(selection.wrappedValue == nil ? Color.genTextTertiary : Color.genAccent)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .disabled(options.isEmpty)
        .genHoverEffect(accent: .genAccent)
        .accessibilityIdentifier("focus-studio-\(title)-filter")
        .instantTooltip("Scope every tab to one \(title)")
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if model.emptiness != .notEmpty {
            emptyState
        } else {
            switch model.tab {
            case .timeline: FocusTimelineView(model: model)
            case .breakdown: FocusBreakdownView(model: model)
            case .heatmap: FocusHeatmapView(model: model)
            case .sessions: FocusSessionsView(model: model)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: GenSpacing.sm) {
            Image(systemName: model.emptiness == .noMatches ? "line.3.horizontal.decrease.circle"
                  : model.emptiness == .captureWasOff ? "eye.slash" : "clock")
                .font(.system(size: 26))
                .foregroundStyle(Color.genTextMuted)
            Text(model.emptiness == .noMatches ? "No activity matches these filters."
                 : model.emptiness == .captureWasOff ? "Capture was off for \(model.range.label)."
                 : "Nothing recorded for \(model.range.label).")
                .font(GenTypography.body(14))
                .foregroundStyle(Color.genTextSecondary)
            Text(model.emptiness == .noMatches ? "Clear the search or choose another tag or project to see recorded activity."
                 : model.emptiness == .captureWasOff
                 ? "This range was not measured, which is not the same as an empty day. Turn capture back on in Settings → Focus."
                 : "Start a flow from the timer. Recorded activity appears here.")
                .font(GenTypography.caption(11))
                .foregroundStyle(Color.genTextTertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("focus-studio-empty")
    }

    private var footer: some View {
        HStack(spacing: GenSpacing.lg) {
            footerStat("focused", FocusFormat.duration(model.totals.focusedMs))
            footerStat("idle", FocusFormat.duration(model.totals.idleMs))
            footerStat("switches", "\(model.totals.switches)")
            footerStat("longest", FocusFormat.duration(model.totals.longestStretchMs))
                .instantTooltip("Longest unbroken focused stretch")
            footerStat("keystrokes", "\(model.keys)")
            if model.unmeasuredMs > 60_000 {
                footerStat("not measured", FocusFormat.duration(model.unmeasuredMs))
            }
            Spacer()
        }
        .padding(.horizontal, GenSpacing.md)
        .padding(.vertical, GenSpacing.sm)
    }

    private func footerStat(_ label: String, _ value: String) -> some View {
        HStack(spacing: GenSpacing.xs) {
            Text(label)
                .font(GenTypography.caption(10))
                .foregroundStyle(Color.genTextTertiary)
            Text(value)
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.genTextPrimary)
        }
    }
}

// MARK: - Timeline

public struct FocusTimelineView: View {
    @ObservedObject public var model: FocusStudioModel

    /// Which phase the pointer picked, and where it picked it. The first click on a flow or a
    /// break shows its card; the second opens the full breakdown. One click for "what was
    /// that", two for "show me everything" — the same escalation the Sessions tab has.
    @State private var picked: Picked?

    private struct Picked: Equatable {
        let sessionId: Int64
        let at: CGPoint
        /// The chart's real width at the tap, so the card is clamped to the chart as drawn.
        let chartWidth: CGFloat
    }

    /// A category axis stretches its lanes to fill whatever height it is given, so one lane on
    /// a fresh day would draw a 400pt block. Height follows the lane count instead, and scrolls
    /// once a week of lanes no longer fits.
    private var chartHeight: CGFloat {
        CGFloat(max(1, model.lanes.count)) * 34 + 40
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: GenSpacing.sm) {
                chart
                    .frame(height: chartHeight)
                    .overlay(alignment: .topLeading) { card }
                legend
            }
            .padding(GenSpacing.md)
        }
    }

    // MARK: - Hover card

    @ViewBuilder
    private var card: some View {
        if let picked, let session = model.sessionOptions.first(where: { $0.id == picked.sessionId }) {
            FocusSessionHoverCard(card: session) {
                model.onOpenSession?(session.id)
                self.picked = nil
            } onDismiss: {
                self.picked = nil
            }
            // Clamped so a phase near the right edge does not push its card off the window.
            .offset(x: max(8, min(picked.at.x - 110, picked.chartWidth - 240)),
                    y: max(0, picked.at.y - 96))
            .transition(.opacity)
            .zIndex(1)
        }
    }

    /// Maps a tap to the phase under it. A tap that lands on no phase clears the card, which is
    /// how you dismiss it without hunting for a close button.
    private func handleTap(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) {
        guard let anchor = proxy.plotFrame else { return }
        let plot = geometry[anchor]
        let x = location.x - plot.minX
        let y = location.y - plot.minY
        guard let minute = proxy.value(atX: x, as: Double.self),
              let lane = proxy.value(atY: y, as: String.self) else {
            picked = nil
            return
        }
        let offsetMs = Int64(minute * 60_000)
        let band = model.phaseBands.first { band in
            band.laneKey == lane && offsetMs >= band.offsetStartMs && offsetMs <= band.offsetEndMs
        }
        guard let band else {
            picked = nil
            return
        }
        if picked?.sessionId == band.sessionId {
            // Second click on the same phase: open the window the card was advertising.
            model.onOpenSession?(band.sessionId)
            picked = nil
        } else {
            picked = Picked(sessionId: band.sessionId, at: location, chartWidth: geometry.size.width)
        }
    }

    /// The chart's own legend cannot host an icon, so the legend is ours: the real app icon
    /// beside the swatch, which is how you recognise an app at a glance.
    private var legend: some View {
        HStack(spacing: GenSpacing.md) {
            ForEach(model.appBuckets.prefix(8)) { bucket in
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(FocusPalette.color(for: bucket.key))
                        .frame(width: 8, height: 8)
                    AppIcon(bundleId: bucket.bundleId, size: 13)
                    Text(bucket.key)
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextTertiary)
                }
            }
            if !model.phaseBands.isEmpty {
                ForEach([("flow", Color.genAccent), ("break", Color.genSuccess)], id: \.0) { entry in
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 1, style: .continuous)
                            .fill(entry.1)
                            .frame(width: 10, height: 3)
                        Text(entry.0)
                            .font(GenTypography.caption(10))
                            .foregroundStyle(Color.genTextTertiary)
                    }
                }
            }
            if !model.gapBars.isEmpty {
                HStack(spacing: 4) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(FocusPalette.gapFill)
                        .frame(width: 8, height: 8)
                    Text(model.gapBars.count == 1 ? model.gapBars[0].label : "not measured")
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextMuted)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var chart: some View {
        Chart {
            // Phase bands underneath everything: a flow and the break after it must read as two
            // stretches, not one continuous smear of app colours.
            ForEach(model.phaseBands) { band in
                RectangleMark(
                    xStart: .value("From", minutes(band.offsetStartMs)),
                    xEnd: .value("To", minutes(band.offsetEndMs)),
                    y: .value("Lane", band.laneKey))
                .foregroundStyle((band.isBreak ? Color.genSuccess : Color.genAccent).opacity(0.16))
            }
            // Gaps next, so a recorded segment always draws over the hole rather than under it.
            ForEach(model.gapBars) { gap in
                RectangleMark(
                    xStart: .value("From", minutes(gap.offsetStartMs)),
                    xEnd: .value("To", minutes(gap.offsetEndMs)),
                    y: .value("Lane", gap.laneKey))
                .foregroundStyle(FocusPalette.gapFill)
            }
            ForEach(model.bars) { bar in
                RectangleMark(
                    xStart: .value("From", minutes(bar.offsetStartMs)),
                    xEnd: .value("To", minutes(bar.offsetEndMs)),
                    y: .value("Lane", bar.laneKey))
                .foregroundStyle(bar.idle ? Color.genTextMuted.opacity(0.35) : FocusPalette.color(for: bar.appName))
            }
            // A solid strip at the foot of the lane: where one phase ends and the next begins is
            // the single most useful line on this chart.
            ForEach(model.phaseBands) { band in
                RectangleMark(
                    xStart: .value("From", minutes(band.offsetStartMs)),
                    xEnd: .value("To", minutes(band.offsetEndMs)),
                    y: .value("Lane", band.laneKey),
                    height: .fixed(3))
                    .offset(y: 13)
                    .foregroundStyle(band.isBreak ? Color.genSuccess : Color.genAccent)
            }
        }
        // Every lane is the same width and starts at its own beginning: the 19:00 row runs
        // 19:00 → 20:00 across the whole chart, rather than sitting somewhere along a day axis.
        .chartXScale(domain: 0 ... model.laneSpanMinutes)
        .chartYScale(domain: model.lanes)
        .chartXAxis {
            AxisMarks(values: axisValues) { value in
                AxisGridLine().foregroundStyle(Color.genGlassBorder.opacity(0.5))
                AxisValueLabel {
                    if let minute = value.as(Double.self) {
                        Text(axisLabel(minute))
                            .font(GenTypography.mono(10))
                            .foregroundStyle(Color.genTextTertiary)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading) { value in
                AxisValueLabel {
                    if let lane = value.as(String.self) {
                        Text(lane)
                            .font(GenTypography.mono(10))
                            .foregroundStyle(Color.genTextTertiary)
                    }
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .gesture(SpatialTapGesture().onEnded { value in
                        withAnimation(GenAnimation.quick) {
                            handleTap(at: value.location, proxy: proxy, geometry: geometry)
                        }
                    })
            }
        }
        .accessibilityIdentifier("focus-studio-timeline")
    }

    private func minutes(_ ms: Int64) -> Double { Double(ms) / 60_000 }

    /// Six ticks, whatever a lane spans.
    private var axisValues: [Double] {
        let step = model.laneSpanMinutes / 6
        return stride(from: 0, through: model.laneSpanMinutes, by: step).map { $0 }
    }

    /// Inside an hour lane the label is the minute (`:10`); inside a day lane it is the hour.
    private func axisLabel(_ minute: Double) -> String {
        if model.laneSpanMinutes <= 60 { return String(format: ":%02d", Int(minute.rounded())) }
        return String(format: "%02d:00", Int(minute.rounded()) / 60)
    }
}

// MARK: - Breakdown

public struct FocusBreakdownView: View {
    @ObservedObject public var model: FocusStudioModel
    @State private var expanded: Set<String> = []

    public var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                section("Apps", model.appBuckets, expandable: true)
                if !model.hostBuckets.isEmpty { section("Sites", model.hostBuckets, expandable: false) }
                if !model.projectBuckets.isEmpty { section("Projects", model.projectBuckets, expandable: false) }
            }
            .padding(GenSpacing.md)
        }
        .accessibilityIdentifier("focus-studio-breakdown")
    }

    @ViewBuilder
    private func section(_ title: String, _ buckets: [FocusAggregate.Bucket], expandable: Bool) -> some View {
        Text(title)
            .font(GenTypography.caption(10, weight: .semibold))
            .foregroundStyle(Color.genTextTertiary)
            .padding(.top, GenSpacing.sm)
            .padding(.bottom, GenSpacing.xs)

        ForEach(buckets) { bucket in
            VStack(spacing: 0) {
                row(bucket, expandable: expandable)
                if expandable, expanded.contains(bucket.key) {
                    ForEach(model.childBuckets[bucket.key] ?? []) { child in
                        HStack(spacing: GenSpacing.sm) {
                            Text(child.key)
                                .font(GenTypography.caption(11))
                                .foregroundStyle(Color.genTextTertiary)
                                .lineLimit(1)
                                .instantTooltip(child.key)
                            Spacer()
                            Text(FocusFormat.duration(child.ms))
                                .font(GenTypography.mono(11))
                                .foregroundStyle(Color.genTextTertiary)
                        }
                        .padding(.leading, GenSpacing.xl)
                        .padding(.vertical, 2)
                    }
                }
            }
        }
    }

    private func row(_ bucket: FocusAggregate.Bucket, expandable: Bool) -> some View {
        HStack(spacing: GenSpacing.sm) {
            if expandable {
                Image(systemName: expanded.contains(bucket.key) ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9))
                    .foregroundStyle(Color.genTextMuted)
                    .frame(width: 10)
            }
            AppIcon(bundleId: bucket.bundleId, size: 16)
            Text(bucket.key)
                .font(GenTypography.body(13))
                .foregroundStyle(Color.genTextPrimary)
                .lineLimit(1)
                .frame(width: 184, alignment: .leading)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.genGlassFill)
                    Capsule()
                        .fill(FocusPalette.color(for: bucket.key))
                        .frame(width: max(2, geometry.size.width * bucket.share))
                }
            }
            .frame(height: 8)

            Text(FocusFormat.percent(bucket.share))
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.genTextTertiary)
                .frame(width: 44, alignment: .trailing)
            Text(FocusFormat.duration(bucket.ms))
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.genTextPrimary)
                .frame(width: 70, alignment: .trailing)
            Text("\(bucket.visits)")
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.genTextMuted)
                .frame(width: 34, alignment: .trailing)
                .instantTooltip("\(bucket.visits) visits")
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .onTapGesture {
            guard expandable else { return }
            if expanded.contains(bucket.key) { expanded.remove(bucket.key) } else { expanded.insert(bucket.key) }
        }
        .instantTooltip(expandable
                        ? "\(expanded.contains(bucket.key) ? "Hide" : "Show") windows and sites for \(bucket.key)"
                        : bucket.key)
    }
}

// MARK: - Heatmap

public struct FocusHeatmapView: View {
    @ObservedObject public var model: FocusStudioModel

    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let hours = Array(0 ... 23)

    /// Drawn by hand rather than with Swift Charts. A `RectangleMark` grid has to be told its
    /// cell size in points on a continuous axis (`.ratio` measures against a step that a
    /// continuous scale does not have), which produced a sparse row of chips with no grid
    /// between them. Seven rows of twenty-four cells is a layout, not a chart.
    public var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.md) {
            grid
            legend
            Spacer(minLength: 0)
        }
        .padding(GenSpacing.md)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("focus-studio-heatmap")
    }

    private var grid: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Text("").frame(width: 30)
                ForEach(Self.hours, id: \.self) { hour in
                    Text(hour % 3 == 0 ? String(format: "%02d", hour) : "")
                        .font(GenTypography.mono(9))
                        .foregroundStyle(Color.genTextTertiary)
                        .frame(maxWidth: .infinity)
                }
            }
            ForEach(Array(Self.weekdays.enumerated()), id: \.offset) { index, day in
                HStack(spacing: 4) {
                    Text(day)
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextTertiary)
                        .frame(width: 30, alignment: .leading)
                    ForEach(Self.hours, id: \.self) { hour in
                        cell(weekday: index + 1, hour: hour)
                    }
                }
            }
        }
        .frame(maxWidth: 1100)
    }

    /// Every cell is drawn, empty ones included, with a border of its own: the grid has to be
    /// readable as a grid before any value in it means anything.
    private func cell(weekday: Int, hour: Int) -> some View {
        let ms = msByKey["\(weekday)-\(hour)"] ?? 0
        return RoundedRectangle(cornerRadius: 3, style: .continuous)
            .fill(ms > 0 ? Color.genAccent.opacity(intensity(ms)) : Color.genGlassFill.opacity(0.5))
            .overlay(
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .strokeBorder(Color.genGlassBorder.opacity(ms > 0 ? 0.8 : 0.45), lineWidth: 1))
            .frame(maxWidth: .infinity)
            .frame(height: 22)
            .instantTooltip("\(Self.weekdays[weekday - 1]) \(String(format: "%02d:00", hour)) · "
                  + (ms > 0 ? FocusFormat.duration(ms) : "nothing recorded"))
    }

    private var legend: some View {
        HStack(spacing: GenSpacing.xl) {
            HStack(spacing: 4) {
                Text("less").font(GenTypography.caption(10)).foregroundStyle(Color.genTextMuted)
                ForEach([0.0, 0.25, 0.5, 0.75, 1.0], id: \.self) { step in
                    RoundedRectangle(cornerRadius: 2, style: .continuous)
                        .fill(step == 0 ? Color.genGlassFill.opacity(0.5) : Color.genAccent.opacity(0.15 + 0.85 * step))
                        .overlay(RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .strokeBorder(Color.genGlassBorder.opacity(0.5), lineWidth: 1))
                        .frame(width: 14, height: 14)
                }
                Text("more").font(GenTypography.caption(10)).foregroundStyle(Color.genTextMuted)
            }
            if let best = model.heatCells.max(by: { $0.ms < $1.ms }) {
                Text("best hour  \(String(format: "%02d:00", best.hour)) · \(FocusFormat.duration(best.ms))")
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.genTextSecondary)
            }
            if let worst = model.heatCells.filter({ $0.ms > 0 }).min(by: { $0.ms < $1.ms }) {
                Text("thinnest hour  \(String(format: "%02d:00", worst.hour)) · \(FocusFormat.duration(worst.ms))")
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.genTextTertiary)
            }
            Spacer(minLength: 0)
        }
    }

    /// Recorded minutes per cell, keyed once per reload rather than searched per cell: 168 cells
    /// times a linear scan is work a body must not do.
    private var msByKey: [String: Int64] {
        Dictionary(model.heatCells.map { ("\($0.weekday)-\($0.hour)", $0.ms) },
                   uniquingKeysWith: { $0 + $1 })
    }

    private func intensity(_ ms: Int64) -> Double {
        let peak = Double(model.heatCells.map(\.ms).max() ?? 1)
        guard peak > 0 else { return 0.1 }
        return 0.15 + 0.85 * (Double(ms) / peak)
    }
}

// MARK: - Sessions

public struct FocusSessionsView: View {
    @ObservedObject public var model: FocusStudioModel

    public var body: some View {
        ScrollView {
            LazyVStack(spacing: GenSpacing.sm) {
                ForEach(model.sessionCards) { card in
                    // A card is a button: clicking it opens the full breakdown of that one
                    // pomodoro in its own window. The plain-style button keeps the card's own
                    // background instead of drawing a second one around it.
                    Button { model.onOpenSession?(card.id) } label: {
                        FocusSessionCardView(card: card)
                    }
                    .buttonStyle(.genHover(cornerRadius: GenRadius.md,
                                           padding: EdgeInsets(),
                                           drawsBackground: false,
                                           scale: 1.008))
                    .accessibilityIdentifier("focus-session-card-\(card.id)")
                    .accessibilityHint("Opens the full breakdown of this session")
                    .instantTooltip("Open the full breakdown of this session")
                }
            }
            .padding(GenSpacing.md)
        }
        .accessibilityIdentifier("focus-studio-sessions")
    }
}

public struct FocusSessionCardView: View {
    public let card: FocusStudioModel.SessionCard

    private var accent: Color {
        switch card.kind {
        case ActivityStore.SessionKind.flow.rawValue: return .genAccent
        case ActivityStore.SessionKind.shortBreak.rawValue: return .genSuccess
        default: return .genWaiting
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: GenSpacing.sm) {
            HStack(spacing: GenSpacing.sm) {
                Text(FocusFormat.clockTime(card.startedMs))
                    .font(GenTypography.mono(12))
                    .foregroundStyle(Color.genTextSecondary)
                Text(card.kind.replacingOccurrences(of: "_", with: " "))
                    .font(GenTypography.body(13, weight: .medium))
                    .foregroundStyle(Color.genTextPrimary)
                if let tag = card.tag {
                    Text("#\(tag)")
                        .font(GenTypography.caption(11))
                        .foregroundStyle(accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(accent.opacity(0.12)))
                }
                Spacer()
                if card.state != ActivityStore.SessionState.done.rawValue {
                    Text(card.state)
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextMuted)
                }
                Text(FocusFormat.duration(card.actualMs))
                    .font(GenTypography.mono(12))
                    .foregroundStyle(Color.genTextPrimary)
            }

            // Planned versus actual, because a 25-minute flow that ran 12 minutes is the
            // interesting one and a bare duration hides it.
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.genGlassFill)
                    Capsule()
                        .fill(accent.opacity(0.7))
                        .frame(width: max(2, geometry.size.width * plannedShare))
                }
            }
            .frame(height: 6)

            HStack(spacing: GenSpacing.md) {
                ForEach(card.topApps) { app in
                    HStack(spacing: 3) {
                        AppIcon(bundleId: app.bundleId, size: 13)
                        Text("\(app.key) \(FocusFormat.percent(app.share))")
                            .font(GenTypography.caption(10))
                            .foregroundStyle(Color.genTextTertiary)
                    }
                }
                Spacer()
                if card.interruptions > 0 {
                    Label("\(card.interruptions)", systemImage: "bell.badge")
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genWarning)
                        .instantTooltip("\(card.interruptions) interruptions")
                }
                if card.keys > 0 {
                    Text("\(card.keys) keys")
                        .font(GenTypography.mono(10))
                        .foregroundStyle(Color.genTextMuted)
                }
            }

            if let note = card.note, !note.isEmpty {
                Text(note)
                    .font(GenTypography.caption(11))
                    .foregroundStyle(Color.genTextSecondary)
            }
        }
        .padding(GenSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: GenRadius.md, style: .continuous)
                .fill(Color.genSurface)
                .overlay(RoundedRectangle(cornerRadius: GenRadius.md, style: .continuous)
                    .strokeBorder(Color.genGlassBorder, lineWidth: 1)))
    }

    private var plannedShare: Double {
        guard card.plannedMs > 0 else { return 1 }
        return min(1, Double(card.actualMs) / Double(card.plannedMs))
    }
}

// MARK: - Palette

/// Stable colours per app: the eight most common get named tokens, the rest hash into the same
/// set. Shuffling colours week to week would make the timeline unreadable at a glance.
public enum FocusPalette {
    public static let swatches: [Color] = [
        .genAccent, .jarvisTeal, .genWaiting, .genSuccess,
        .neonCyan, .neonPurple, .genWarning, Color(red: 0.55, green: 0.62, blue: 0.85),
    ]

    /// Gaps are drawn, never skipped: a hole in the record must look different from an idle
    /// stretch and from a busy one.
    public static let gapFill = Color.white.opacity(0.06)

    public static func color(for key: String) -> Color {
        var hash: UInt64 = 5381
        for byte in key.utf8 { hash = (hash &* 33) &+ UInt64(byte) }
        return swatches[Int(hash % UInt64(swatches.count))]
    }
}

// MARK: - Session hover card

/// Spec 22 (S6) §10.4 — what one click on a phase in the timeline says.
///
/// Deliberately short: the five numbers that decide whether the full breakdown is worth opening,
/// and a line saying how to open it. Anything more and the card is the breakdown.
public struct FocusSessionHoverCard: View {
    public let card: FocusStudioModel.SessionCard
    public var onOpen: () -> Void
    public var onDismiss: () -> Void

    private var accent: Color {
        switch card.kind {
        case ActivityStore.SessionKind.flow.rawValue: return .genAccent
        case ActivityStore.SessionKind.shortBreak.rawValue: return .genSuccess
        default: return .genWaiting
        }
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: GenSpacing.xs) {
                Circle().fill(accent).frame(width: 6, height: 6)
                Text(card.kind.replacingOccurrences(of: "_", with: " "))
                    .font(GenTypography.body(12, weight: .medium))
                    .foregroundStyle(Color.genTextPrimary)
                if let tag = card.tag {
                    Text("#\(tag)")
                        .font(GenTypography.caption(10))
                        .foregroundStyle(accent)
                }
                Spacer(minLength: GenSpacing.sm)
                Button {
                    onDismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(Color.genTextMuted)
                }
                .buttonStyle(.genHoverIcon(diameter: 16))
                .accessibilityIdentifier("focus-timeline-card-close")
                .instantTooltip("Close this card")
            }

            Text("\(FocusFormat.clockTime(card.startedMs)) · \(FocusFormat.duration(card.actualMs))"
                 + (card.plannedMs > 0 ? " of \(FocusFormat.duration(card.plannedMs))" : ""))
                .font(GenTypography.mono(11))
                .foregroundStyle(Color.genTextSecondary)

            if !card.topApps.isEmpty {
                HStack(spacing: GenSpacing.sm) {
                    ForEach(card.topApps.prefix(3)) { app in
                        HStack(spacing: 3) {
                            AppIcon(bundleId: app.bundleId, size: 12)
                            Text(FocusFormat.percent(app.share))
                                .font(GenTypography.caption(10))
                                .foregroundStyle(Color.genTextTertiary)
                        }
                    }
                }
            }

            HStack(spacing: GenSpacing.md) {
                if card.keys > 0 {
                    Text("\(card.keys) keys")
                        .font(GenTypography.mono(10))
                        .foregroundStyle(Color.genTextMuted)
                }
                if card.interruptions > 0 {
                    Label("\(card.interruptions)", systemImage: "bell.badge")
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genWarning)
                        .instantTooltip("\(card.interruptions) interruptions")
                }
                if card.state != ActivityStore.SessionState.done.rawValue {
                    Text(card.state)
                        .font(GenTypography.caption(10))
                        .foregroundStyle(Color.genTextMuted)
                }
            }

            Button(action: onOpen) {
                Text("click again for the full breakdown")
                    .font(GenTypography.caption(10, weight: .semibold))
                    .foregroundStyle(accent)
            }
            .buttonStyle(.genHover(accent: accent, cornerRadius: 4))
            .accessibilityIdentifier("focus-timeline-card-open")
            .instantTooltip("Open this session's full breakdown")
        }
        .padding(GenSpacing.sm)
        .frame(width: 228, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: GenRadius.md, style: .continuous)
                .fill(Color.genSurface)
                .overlay(RoundedRectangle(cornerRadius: GenRadius.md, style: .continuous)
                    .strokeBorder(accent.opacity(0.35), lineWidth: 1))
                .shadow(color: .black.opacity(0.45), radius: 12, y: 4))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("focus-timeline-session-card")
    }
}
