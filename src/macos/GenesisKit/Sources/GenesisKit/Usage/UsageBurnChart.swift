import SwiftUI

/// The lanes of the Usage window: per account, one lane per window on one shared time axis, then the poll coverage
/// strip. Each lane draws in one `Canvas` from values built off the main thread (`UsageLaneBuilder`); only the lane
/// under the pointer redraws while it moves. A spike diamond is a button: `onSpike` gets it (the window lists its
/// sessions).
public struct UsageBurnChart: View {
    private let accounts: [UsageAccountLanes]
    private let domain: ClosedRange<Date>
    private let settings: UsageSettings
    private let now: Date
    private let onSpike: ((UsageLaneSpike) -> Void)?

    public init(accounts: [UsageAccountLanes], domain: ClosedRange<Date>, settings: UsageSettings, now: Date,
                onSpike: ((UsageLaneSpike) -> Void)? = nil) {
        self.accounts = accounts
        self.domain = domain
        self.settings = settings
        self.now = now
        self.onSpike = onSpike
    }

    public static let labelWidth: CGFloat = 54

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(accounts) { account in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        AIProviderGlyph(meta: AIProviders.meta(for: account.account.provider), size: 13)
                        Text(verbatim: account.account.accountName)
                            .font(.system(size: 11.5, weight: .semibold))
                            .foregroundStyle(Color.white.opacity(0.88))
                    }
                    .accessibilityElement(children: .combine)
                    ForEach(account.lanes) { lane in
                        UsageBurnLaneView(
                            lane: lane, domain: domain, settings: settings, now: now,
                            extendTo: extensionEnd(account), onSpike: onSpike)
                    }
                    if settings.coverageStrip {
                        UsageCoverageStrip(account: account, domain: domain)
                            .padding(.leading, Self.labelWidth + 6)
                    }
                }
            }
            UsageTimeAxis(domain: domain, now: now)
                .padding(.leading, Self.labelWidth + 6)
        }
    }

    /// The last value runs on only while a poll measured it: to the end of the last good run when the account has a
    /// coverage record, else to now.
    private func extensionEnd(_ account: UsageAccountLanes) -> Date {
        guard account.coverageRecorded, let lastOk = account.coverage.last(where: { $0.state == "ok" }) else { return now }
        return min(now, lastOk.to)
    }
}

/// One window's lane: its name and the value now on the left, the drawing on the right.
public struct UsageBurnLaneView: View {
    let lane: UsageLane
    let domain: ClosedRange<Date>
    let settings: UsageSettings
    let now: Date
    let extendTo: Date
    let onSpike: ((UsageLaneSpike) -> Void)?
    /// The window name and the value now on the left; a mini chart (the hub digest's cone) leaves them out.
    let labelled: Bool
    let height: CGFloat
    @State private var hoverX: CGFloat?

    public init(lane: UsageLane, domain: ClosedRange<Date>, settings: UsageSettings, now: Date, extendTo: Date,
                labelled: Bool = true, height: CGFloat = 56, onSpike: ((UsageLaneSpike) -> Void)? = nil) {
        self.lane = lane
        self.domain = domain
        self.settings = settings
        self.now = now
        self.extendTo = extendTo
        self.labelled = labelled
        self.height = height
        self.onSpike = onSpike
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if labelled {
            VStack(alignment: .trailing, spacing: 1) {
                Text(verbatim: lane.title)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(Color.white.opacity(0.62))
                Text(verbatim: lane.absentNow ? "no limit" : UsageFormat.percent(lane.current))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(lane.absentNow ? Color.white.opacity(0.4) : UsageTone.severity(lane.currentSeverity))
            }
            .frame(width: UsageBurnChart.labelWidth, alignment: .trailing)
            }
            GeometryReader { proxy in
                let geometry = UsageLaneGeometry(
                    domain: domain, size: proxy.size, yMax: lane.samples.map(\.max).max() ?? 100)
                ZStack(alignment: .topLeading) {
                    Canvas { context, _ in draw(context, geometry) }
                    if settings.spikeMarkers {
                        ForEach(lane.spikes) { spike in
                            spikeButton(spike, geometry)
                        }
                    }
                    if let hoverX {
                        readout(at: hoverX, geometry, width: proxy.size.width)
                    }
                }
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let point): hoverX = point.x
                    case .ended: hoverX = nil
                    }
                }
            }
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(accessibilityText))
    }

    private var accessibilityText: String {
        var parts = ["\(lane.account.accountName) \(lane.title)"]
        parts.append(lane.absentNow ? "no limit" : "\(UsageFormat.percent(lane.current)) used")
        if let label = lane.forecast?.label(now: now) { parts.append(label) }
        if !lane.spikes.isEmpty { parts.append(Plural.count(lane.spikes.count, "spike")) }
        return parts.joined(separator: ", ")
    }

    // MARK: Drawing

    private func draw(_ context: GraphicsContext, _ geometry: UsageLaneGeometry) {
        let size = geometry.size
        let frame = CGRect(origin: .zero, size: size)
        context.fill(Path(roundedRect: frame, cornerRadius: 4), with: .color(Color.white.opacity(0.025)))
        for level in [50.0, 100.0] {
            var grid = Path()
            grid.move(to: CGPoint(x: 0, y: geometry.y(level)))
            grid.addLine(to: CGPoint(x: size.width, y: geometry.y(level)))
            context.stroke(grid, with: .color(Color.white.opacity(level == 100 ? 0.12 : 0.06)),
                           style: StrokeStyle(lineWidth: 0.5, dash: [3, 3]))
        }
        if settings.resetBands { drawResets(context, geometry) }
        drawAbsent(context, geometry)
        drawWhiskers(context, geometry)
        drawLine(context, geometry)
        if settings.projection, let forecast = lane.forecast { drawForecast(context, geometry, forecast) }
        if settings.eventMarkers { drawEvents(context, geometry) }
        // Now: where the measured part ends and the projection begins.
        if now < domain.upperBound {
            var line = Path()
            line.move(to: CGPoint(x: geometry.x(now), y: 0))
            line.addLine(to: CGPoint(x: geometry.x(now), y: size.height))
            context.stroke(line, with: .color(Color.white.opacity(0.22)), style: StrokeStyle(lineWidth: 0.6, dash: [1, 2]))
        }
        if let hoverX {
            var line = Path()
            line.move(to: CGPoint(x: hoverX, y: 0))
            line.addLine(to: CGPoint(x: hoverX, y: size.height))
            context.stroke(line, with: .color(Color.white.opacity(0.35)), lineWidth: 0.6)
        }
    }

    /// A faint band for every other window period and a line at each reset.
    private func drawResets(_ context: GraphicsContext, _ geometry: UsageLaneGeometry) {
        let resets = lane.resets.filter { domain.contains($0) }.sorted()
        for (index, reset) in resets.enumerated() where index % 2 == 0 {
            let end = index + 1 < resets.count ? resets[index + 1] : domain.upperBound
            let band = CGRect(x: geometry.x(reset), y: 0, width: geometry.x(end) - geometry.x(reset), height: geometry.size.height)
            context.fill(Path(band), with: .color(Color.white.opacity(0.025)))
        }
        for reset in resets {
            var line = Path()
            line.move(to: CGPoint(x: geometry.x(reset), y: 0))
            line.addLine(to: CGPoint(x: geometry.x(reset), y: geometry.size.height))
            context.stroke(line, with: .color(Color.white.opacity(0.16)), lineWidth: 0.6)
        }
    }

    /// The spans the account had no such limit: a hatched band and its words, never a flat 0 % line.
    private func drawAbsent(_ context: GraphicsContext, _ geometry: UsageLaneGeometry) {
        var spans = lane.absent.map { ($0.from, $0.to) }
        if lane.absentNow, spans.isEmpty { spans = [(lane.samples.last?.date ?? domain.lowerBound, now)] }
        for (from, to) in spans {
            let rect = CGRect(x: geometry.x(max(from, domain.lowerBound)), y: 0,
                              width: geometry.x(min(to, domain.upperBound)) - geometry.x(max(from, domain.lowerBound)),
                              height: geometry.size.height)
            guard rect.width > 1 else { continue }
            var hatched = context
            hatched.clip(to: Path(rect))
            hatched.fill(Path(rect), with: .color(Color.white.opacity(0.03)))
            var stripes = Path()
            var x = rect.minX - rect.height
            while x < rect.maxX {
                stripes.move(to: CGPoint(x: x, y: rect.maxY))
                stripes.addLine(to: CGPoint(x: x + rect.height, y: rect.minY))
                x += 7
            }
            hatched.stroke(stripes, with: .color(Color.white.opacity(0.09)), lineWidth: 1)
            if rect.width > 80 {
                hatched.draw(
                    Text(verbatim: "No \(lane.title) limit").font(.system(size: 10, weight: .medium)).foregroundColor(Color.white.opacity(0.5)),
                    at: CGPoint(x: rect.midX, y: rect.midY))
            }
        }
    }

    /// Above the raw range each bin draws its min-to-max whisker.
    private func drawWhiskers(_ context: GraphicsContext, _ geometry: UsageLaneGeometry) {
        var whiskers = Path()
        for sample in lane.samples where sample.isBin {
            let x = geometry.x(sample.date)
            whiskers.move(to: CGPoint(x: x, y: geometry.y(sample.min)))
            whiskers.addLine(to: CGPoint(x: x, y: geometry.y(sample.max)))
        }
        context.stroke(whiskers, with: .color(Color.white.opacity(0.28)), lineWidth: 1)
    }

    /// The line, cut where its colour changes: by the severity of each reading, or one colour.
    private func drawLine(_ context: GraphicsContext, _ geometry: UsageLaneGeometry) {
        let samples = lane.samples
        guard !samples.isEmpty else { return }
        let points = geometry.line(samples, shape: settings.lineShape, extendTo: lane.absentNow ? nil : extendTo)
        // Step adds one corner per reading after the first, so reading i starts at 2i (step) or i (linear).
        let stride = settings.lineShape == .step ? 2 : 1
        var start = 0
        var colour = colourOf(samples[0])
        func flush(through end: Int) {
            guard end > start else { return }
            var path = Path()
            path.move(to: points[start])
            for index in (start + 1)...end { path.addLine(to: points[index]) }
            context.stroke(path, with: .color(colour), style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
        }
        for index in 1..<max(1, samples.count) {
            let next = colourOf(samples[index])
            guard next != colour else { continue }
            let end = index * stride
            flush(through: end)
            start = end
            colour = next
        }
        flush(through: points.count - 1)
    }

    private func colourOf(_ sample: UsageLaneSample) -> Color {
        guard settings.severityColour else { return AIProviders.meta(for: lane.account.provider).color }
        return UsageTone.severity(sample.severity ?? UsageTone.severity(forPercent: sample.value))
    }

    private func drawForecast(_ context: GraphicsContext, _ geometry: UsageLaneGeometry, _ forecast: UsageLaneForecast) {
        let end = min(forecast.resetAt ?? domain.upperBound, domain.upperBound)
        let tint = forecast.beforeReset ? UsageTone.severity("warning") : Color.white
        if settings.cone, let cone = geometry.cone(forecast, until: end) {
            var path = Path()
            path.addLines(cone)
            path.closeSubpath()
            context.fill(path, with: .color(tint.opacity(0.14)))
        }
        if let line = geometry.projection(forecast, perHour: forecast.ratePerHour, until: end) {
            var path = Path()
            path.addLines(line)
            context.stroke(path, with: .color(tint.opacity(0.7)), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        }
        if settings.safePace, let line = geometry.projection(forecast, perHour: forecast.safePerHour, until: end) {
            var path = Path()
            path.addLines(line)
            context.stroke(path, with: .color(Color(red: 0.45, green: 0.66, blue: 0.98).opacity(0.55)), lineWidth: 0.8)
        }
        if let label = forecast.label(now: now), geometry.x(end) - geometry.x(forecast.start) > 40 {
            context.draw(
                Text(verbatim: label).font(.system(size: 9.5)).foregroundColor(tint.opacity(0.8)),
                at: CGPoint(x: geometry.x(end) - 3, y: 2), anchor: .topTrailing)
        }
    }

    private func drawEvents(_ context: GraphicsContext, _ geometry: UsageLaneGeometry) {
        for event in lane.events where domain.contains(event.date) {
            var tick = Path()
            let x = geometry.x(event.date)
            tick.move(to: CGPoint(x: x, y: 0))
            tick.addLine(to: CGPoint(x: x, y: 8))
            context.stroke(tick, with: .color(UsageTone.event(event.kind)), lineWidth: 1.6)
        }
    }

    // MARK: Overlays

    private func spikeButton(_ spike: UsageLaneSpike, _ geometry: UsageLaneGeometry) -> some View {
        let side = min(14, 6 + CGFloat(spike.delta) / 3)
        return Button {
            onSpike?(spike)
        } label: {
            Rectangle()
                .fill(UsageTone.severity(spike.topSession == nil ? "critical" : "warning"))
                .frame(width: side, height: side)
                .rotationEffect(.degrees(45))
                .overlay(Rectangle().stroke(Color.black.opacity(0.4), lineWidth: 0.5).rotationEffect(.degrees(45)))
                .frame(width: side + 6, height: side + 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(spike.text)
        .accessibilityLabel(Text("Spike: \(spike.text)"))
        .position(x: geometry.x(spike.to), y: geometry.y(spike.end))
    }

    /// The hover's words: the local time, the value, the change since the reading before, its age, the rate, the reset.
    private func readout(at x: CGFloat, _ geometry: UsageLaneGeometry, width: CGFloat) -> some View {
        let date = geometry.date(atX: x)
        let text = Self.readoutText(lane: lane, at: date, now: now)
        return Text(verbatim: text)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(Color.white.opacity(0.9))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.82)))
            .fixedSize()
            .alignmentGuide(.leading) { dimensions in
                // Beside the pointer, flipped to its left near the right edge.
                x + 8 + dimensions.width > width ? -(x - 8 - dimensions.width) : -(x + 8)
            }
            .allowsHitTesting(false)
    }

    static func readoutText(lane: UsageLane, at date: Date, now: Date) -> String {
        let time = UsageFormat.clock(date, now: now)
        if lane.absent.contains(where: { $0.from <= date && date <= $0.to }) {
            return "\(time) · no \(lane.title) limit"
        }
        guard let reading = lane.reading(at: date) else { return "\(time) · no reading yet" }
        let sample = reading.sample
        var parts = [time, sample.isBin ? "\(UsageFormat.percent(sample.min))–\(UsageFormat.percent(sample.max))" : UsageFormat.percent(sample.value)]
        if let previous = reading.previous {
            let change = sample.value - previous.value
            let minutes = sample.date.timeIntervalSince(previous.date) / 60
            parts.append(String(format: "%+.0f in %@", change, UsageFormat.duration(minutes * 60)))
            if minutes > 0, change > 0 { parts.append(UsageFormat.rate(change / (minutes / 60))) }
        }
        if let reset = lane.resets.first(where: { $0 > sample.date }) ?? lane.forecast?.resetAt {
            parts.append("reset " + UsageFormat.clock(reset, now: now))
        }
        return parts.joined(separator: " · ")
    }
}

/// What the poller knew about an account: green measured, orange stale, red blocked or failed, purple held back,
/// grey not measured. Before the first recorded poll round it says so in words.
public struct UsageCoverageStrip: View {
    let account: UsageAccountLanes
    let domain: ClosedRange<Date>

    public init(account: UsageAccountLanes, domain: ClosedRange<Date>) {
        self.account = account
        self.domain = domain
    }

    public var body: some View {
        if account.coverageRecorded {
            GeometryReader { proxy in
                let geometry = UsageLaneGeometry(domain: domain, size: proxy.size)
                Canvas { context, size in
                    context.fill(Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 2),
                                 with: .color(UsageTone.outcome("unmeasured")))
                    for run in account.coverage {
                        let rect = CGRect(x: geometry.x(max(run.from, domain.lowerBound)), y: 0,
                                          width: max(1, geometry.x(min(run.to, domain.upperBound)) - geometry.x(max(run.from, domain.lowerBound))),
                                          height: size.height)
                        context.fill(Path(rect), with: .color(UsageTone.outcome(run.state)))
                    }
                }
            }
            .frame(height: 4)
            .instantTooltip(tooltip)
            .accessibilityLabel(Text(tooltip))
        } else {
            Text("No poll round recorded for this account yet")
                .font(.system(size: 9.5))
                .foregroundStyle(Color.white.opacity(0.35))
        }
    }

    private var tooltip: String {
        let span = domain.upperBound.timeIntervalSince(domain.lowerBound)
        guard span > 0 else { return "Poll coverage" }
        var seconds: [String: TimeInterval] = [:]
        for run in account.coverage {
            let from = max(run.from, domain.lowerBound)
            let to = min(run.to, domain.upperBound)
            if to > from { seconds[run.state, default: 0] += to.timeIntervalSince(from) }
        }
        let measured = seconds.values.reduce(0, +)
        var parts = seconds.sorted { $0.value > $1.value }.map { "\(UsageTone.outcomeTitle($0.key)) \(Int(($0.value / span * 100).rounded()))%" }
        if span - measured > 60 { parts.append("not measured \(Int(((span - measured) / span * 100).rounded()))%") }
        return "Poll coverage: " + parts.joined(separator: ", ")
    }
}

/// Time labels under the lanes, at a step that gives five to eight of them.
public struct UsageTimeAxis: View {
    let domain: ClosedRange<Date>
    let now: Date

    public init(domain: ClosedRange<Date>, now: Date) {
        self.domain = domain
        self.now = now
    }

    public var body: some View {
        GeometryReader { proxy in
            let geometry = UsageLaneGeometry(domain: domain, size: proxy.size)
            ForEach(Self.ticks(domain), id: \.self) { tick in
                Text(verbatim: Self.label(tick, span: domain.upperBound.timeIntervalSince(domain.lowerBound), now: now))
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(Color.white.opacity(0.45))
                    .fixedSize()
                    .position(x: geometry.x(tick), y: proxy.size.height / 2)
            }
        }
        .frame(height: 14)
        .accessibilityHidden(true)
    }

    static func ticks(_ domain: ClosedRange<Date>) -> [Date] {
        let span = domain.upperBound.timeIntervalSince(domain.lowerBound)
        let steps: [TimeInterval] = [1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400, 2 * 86400, 7 * 86400]
        let step = steps.first { span / $0 <= 8 } ?? 7 * 86400
        let offset = TimeInterval(TimeZone.current.secondsFromGMT(for: domain.lowerBound))
        var tick = ((domain.lowerBound.timeIntervalSince1970 + offset) / step).rounded(.up) * step - offset
        var ticks: [Date] = []
        while tick < domain.upperBound.timeIntervalSince1970 {
            ticks.append(Date(timeIntervalSince1970: tick))
            tick += step
        }
        return ticks
    }

    static func label(_ date: Date, span: TimeInterval, now: Date) -> String {
        span > 2 * 86400 ? UsageFormat.day(date) : UsageFormat.clock(date, now: now)
    }
}
