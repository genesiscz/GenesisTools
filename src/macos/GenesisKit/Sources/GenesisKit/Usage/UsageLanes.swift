import CoreGraphics
import Foundation

// The burn lanes of the Usage window (proposals 1, 3, 4, 5, 8 and 15), as values: one lane per window of an account,
// with its readings, resets, the spans it had no limit, the forecast, the poll coverage, the events and the spikes.
// Built once per load off the main thread (`UsageLaneBuilder`), so drawing only maps values to points
// (`UsageLaneGeometry`), and both are plain functions a test can run.

/// One reading. A raw point has `min == max == value`; a min-max bin keeps its extremes, so a 5h peak just before a
/// reset stays visible at 30 days.
public struct UsageLaneSample: Equatable, Sendable {
    public let date: Date
    public let value: Double
    public let min: Double
    public let max: Double
    public let severity: String?

    public init(date: Date, value: Double, min: Double? = nil, max: Double? = nil, severity: String? = nil) {
        self.date = date
        self.value = value
        self.min = min ?? value
        self.max = max ?? value
        self.severity = severity
    }

    public var isBin: Bool { min != max }
}

public struct UsageLaneSpan: Equatable, Sendable {
    public let from: Date
    public let to: Date
    /// A poll outcome for a coverage run; `absent` for a span with no limit.
    public let state: String

    public init(from: Date, to: Date, state: String) {
        self.from = from
        self.to = to
        self.state = state
    }
}

public struct UsageLaneEvent: Equatable, Sendable {
    public let date: Date
    public let kind: String
    public let text: String
}

public struct UsageLaneSpike: Equatable, Sendable, Identifiable {
    public let id: String
    public let from: Date
    public let to: Date
    public let start: Double
    public let end: Double
    public let delta: Double
    /// "+14 points in 9 min · top: GenesisTools $4.20", or the unattributed note.
    public let text: String
    public let topSession: String?
}

/// The forecast in drawing terms: from the last reading, at the rate, the slow and fast pace, and the safe pace.
public struct UsageLaneForecast: Equatable, Sendable {
    public let start: Date
    public let value: Double
    public let ratePerHour: Double?
    public let lowPerHour: Double?
    public let highPerHour: Double?
    public let safePerHour: Double?
    public let resetAt: Date?
    public let exhaustAt: Date?
    public let beforeReset: Bool

    public init(start: Date, value: Double, ratePerHour: Double?, lowPerHour: Double?, highPerHour: Double?,
                safePerHour: Double?, resetAt: Date?, exhaustAt: Date?, beforeReset: Bool) {
        self.start = start
        self.value = value
        self.ratePerHour = ratePerHour
        self.lowPerHour = lowPerHour
        self.highPerHour = highPerHour
        self.safePerHour = safePerHour
        self.resetAt = resetAt
        self.exhaustAt = exhaustAt
        self.beforeReset = beforeReset
    }

    /// When the value reaches 100 % at `perHour`; nil when it never does at that pace.
    public func crossing(perHour: Double?) -> Date? {
        guard let perHour, perHour > 0 else { return nil }
        if value >= 100 { return start }
        return start.addingTimeInterval((100 - value) / perHour * 3600)
    }

    /// The cone's run-out span: the fast pace's crossing first, the slow pace's last. Nil when even the fast pace
    /// lasts past the reset.
    public var outSpan: (from: Date, to: Date?)? {
        guard let early = crossing(perHour: highPerHour ?? ratePerHour) else { return nil }
        if let resetAt, early >= resetAt { return nil }
        var late = crossing(perHour: lowPerHour ?? ratePerHour)
        // The slow pace lasts past the reset, or the pace has no spread: the span has no end of its own.
        if let end = late, (resetAt.map { end >= $0 } ?? false) || end.timeIntervalSince(early) < 60 { late = nil }
        return (early, late)
    }

    /// "out 16:20 to 17:05, reset 18:00", "lasts to the reset 18:00", or nil without a rate.
    public func label(now: Date = Date()) -> String? {
        let reset = resetAt.map { "reset " + UsageFormat.clock($0, now: now) }
        if let span = outSpan {
            let out = "out " + UsageFormat.clock(span.from, now: now) + (span.to.map { " to " + UsageFormat.clock($0, now: now) } ?? "")
            return [out, reset].compactMap { $0 }.joined(separator: ", ")
        }
        guard ratePerHour != nil else { return nil }
        return reset.map { "lasts to the " + $0 } ?? "lasts"
    }
}

public struct UsageLane: Identifiable, Equatable, Sendable {
    public let id: String
    public let account: UsageAccountKey
    public let key: String
    public let kind: String?
    public let title: String
    public let samples: [UsageLaneSample]
    public let resets: [Date]
    public let periodSeconds: TimeInterval?
    /// Spans this account had no such limit.
    public let absent: [UsageLaneSpan]
    /// The newest poll lists the window as absent: the lane is the "No limit" band.
    public let absentNow: Bool
    public let current: Double?
    public let currentSeverity: String?
    public let forecast: UsageLaneForecast?
    public let events: [UsageLaneEvent]
    public let spikes: [UsageLaneSpike]

    public init(id: String, account: UsageAccountKey, key: String, kind: String?, title: String, samples: [UsageLaneSample],
                resets: [Date] = [], periodSeconds: TimeInterval? = nil, absent: [UsageLaneSpan] = [], absentNow: Bool = false,
                current: Double? = nil, currentSeverity: String? = nil, forecast: UsageLaneForecast? = nil,
                events: [UsageLaneEvent] = [], spikes: [UsageLaneSpike] = []) {
        self.id = id
        self.account = account
        self.key = key
        self.kind = kind
        self.title = title
        self.samples = samples
        self.resets = resets
        self.periodSeconds = periodSeconds
        self.absent = absent
        self.absentNow = absentNow
        self.current = current
        self.currentSeverity = currentSeverity
        self.forecast = forecast
        self.events = events
        self.spikes = spikes
    }

    /// The reading at or before `date`, and the one before it (the hover's "change since").
    public func reading(at date: Date) -> (sample: UsageLaneSample, previous: UsageLaneSample?)? {
        guard let index = samples.lastIndex(where: { $0.date <= date }) else { return nil }
        return (samples[index], index > 0 ? samples[index - 1] : nil)
    }
}

/// An account's lanes with the poll coverage strip under them.
public struct UsageAccountLanes: Identifiable, Equatable, Sendable {
    public let account: UsageAccountKey
    public let lanes: [UsageLane]
    public let coverage: [UsageLaneSpan]
    /// No poll-run record reaches this account yet: the strip says so instead of painting the whole range grey.
    public let coverageRecorded: Bool
    public var id: String { account.id }
}

public enum UsageLaneBuilder {
    /// Lanes per account, in the series' order. Scoped windows only with `settings.scopedWindows`; a window that is
    /// absent for the whole range only with `settings.absentWindow == .band`.
    public static func build(series: UsageSeriesData, spikes: [UsageSpike] = [], settings: UsageSettings) -> [UsageAccountLanes] {
        var order: [String] = []
        var lanes: [String: [UsageLane]] = [:]
        var accounts: [String: UsageAccountKey] = [:]
        for item in series.series where settings.scopedWindows || !item.isScoped {
            let lane = lane(item, events: series.events, spikes: spikes)
            if settings.absentWindow == .hide, lane.absentNow, lane.samples.allSatisfy({ $0.value == 0 }) { continue }
            let key = item.account.id
            if accounts[key] == nil {
                order.append(key)
                accounts[key] = item.account
            }
            lanes[key, default: []].append(lane)
        }
        return order.compactMap { key in
            guard let account = accounts[key] else { return nil }
            let runs = series.coverage.first { $0.account.id == key }?.runs ?? []
            let coverage = runs.compactMap { run -> UsageLaneSpan? in
                guard let from = UsageTime.date(run.from), let to = UsageTime.date(run.to) else { return nil }
                return UsageLaneSpan(from: from, to: to, state: run.outcome)
            }
            let sorted = (lanes[key] ?? []).sorted { laneOrder($0.kind) < laneOrder($1.kind) }
            return UsageAccountLanes(account: account, lanes: sorted, coverage: coverage, coverageRecorded: !runs.isEmpty)
        }
    }

    /// 5h first, then the week, then the rest: the order of the table's columns.
    static func laneOrder(_ kind: String?) -> Int {
        ["session": 0, "weekly": 1, "monthly": 2, "scoped": 3][kind ?? ""] ?? 4
    }

    public static func lane(_ item: UsageSeriesItem, events: [UsageEventRow] = [], spikes: [UsageSpike] = []) -> UsageLane {
        let samples: [UsageLaneSample]
        if let bins = item.bins {
            samples = bins.compactMap { bin in
                UsageTime.date(bin.t).map { UsageLaneSample(date: $0, value: bin.close, min: bin.min, max: bin.max, severity: bin.severity) }
            }
        } else {
            samples = (item.points ?? []).compactMap { point in
                UsageTime.date(point.t).map { UsageLaneSample(date: $0, value: point.v, severity: point.severity) }
            }
        }
        let absent = item.availability.compactMap { span -> UsageLaneSpan? in
            guard span.state == "absent", let from = UsageTime.date(span.from), let to = UsageTime.date(span.to) else { return nil }
            return UsageLaneSpan(from: from, to: to, state: "absent")
        }
        let account = item.account
        let mine = events.filter { event in
            event.provider == account.provider && (event.accountId == account.accountId || event.accountName == account.accountName)
        }
        let laneEvents = mine.compactMap { event -> UsageLaneEvent? in
            UsageTime.date(event.ts).map { UsageLaneEvent(date: $0, kind: event.kind, text: eventText(event)) }
        }
        let laneSpikes = spikes.filter { $0.account.id == account.id && $0.key == item.key }.compactMap(spike)
        return UsageLane(
            id: item.id, account: account, key: item.key, kind: item.kind,
            title: UsageFormat.windowName(kind: item.kind, label: item.label, scopeModel: item.scopeModel),
            samples: samples, resets: item.resets.compactMap(UsageTime.date),
            periodSeconds: item.periodMs.map { $0 / 1000 }, absent: absent,
            absentNow: item.availableNow == "absent",
            current: item.current?.utilization, currentSeverity: item.current?.severity,
            forecast: forecast(item, last: samples.last), events: laneEvents, spikes: laneSpikes)
    }

    static func forecast(_ item: UsageSeriesItem, last: UsageLaneSample?) -> UsageLaneForecast? {
        guard let forecast = item.forecast, item.availableNow != "absent", forecast.stale != true else { return nil }
        let start = UsageTime.date(item.current?.fetchedAt) ?? UsageTime.date(forecast.lastSampleAt) ?? last?.date
        guard let start else { return nil }
        return UsageLaneForecast(
            start: start, value: item.current?.utilization ?? forecast.utilization,
            ratePerHour: forecast.ratePctPerHour, lowPerHour: forecast.paceBand?.lowPctPerHour,
            highPerHour: forecast.paceBand?.highPctPerHour, safePerHour: forecast.safePctPerHour,
            resetAt: UsageTime.date(forecast.resetsAt ?? item.current?.resetsAt), exhaustAt: UsageTime.date(forecast.exhaustAt),
            beforeReset: forecast.beforeReset)
    }

    /// A spike of `limits spikes` as the lanes mark it; the Spikes list picks through the same value as a diamond.
    public static func spike(_ spike: UsageSpike) -> UsageLaneSpike? {
        guard let from = UsageTime.date(spike.from), let to = UsageTime.date(spike.to) else { return nil }
        let minutes = Int((to.timeIntervalSince(from) / 60).rounded())
        let top = spike.sessions.first
        let who = top.map { "top: \(UsageFormat.project($0.project)) \(UsageFormat.usd($0.costUsd))" }
            ?? "unattributed (another host or a missing pin)"
        return UsageLaneSpike(
            id: spike.id, from: from, to: to, start: spike.startPercent, end: spike.endPercent, delta: spike.delta,
            text: "+\(Int(spike.delta.rounded())) points in \(minutes) min · \(who)", topSession: top?.sessionId)
    }

    static func eventText(_ event: UsageEventRow) -> String {
        let what: String
        switch event.kind {
        case "usage-429": what = "Usage endpoint answered 429"
        case "rate-limited": what = "Proxy request rate limited"
        case "cooldown": what = "Cooldown"
        case "poll-backoff": what = "Poll paused"
        case "org-blocked": what = "Blocked by the organization"
        case "probe-refused": what = "Quota probe refused"
        default: what = event.kind
        }
        let count = event.count > 1 ? " ×\(event.count)" : ""
        let retry = event.retryAfterMs.map { " for \(UsageFormat.duration($0 / 1000))" } ?? ""
        return what + count + retry + (event.model.map { " · \($0)" } ?? "")
    }
}

/// Values to points for one lane's rectangle. The top of the rectangle is `yMax` (100 %, or more when a reading
/// went over).
public struct UsageLaneGeometry: Sendable {
    public let domain: ClosedRange<Date>
    public let size: CGSize
    public let yMax: Double

    public init(domain: ClosedRange<Date>, size: CGSize, yMax: Double = 100) {
        self.domain = domain
        self.size = size
        self.yMax = Swift.max(100, yMax)
    }

    public func x(_ date: Date) -> CGFloat {
        let span = domain.upperBound.timeIntervalSince(domain.lowerBound)
        guard span > 0 else { return 0 }
        return CGFloat(date.timeIntervalSince(domain.lowerBound) / span) * size.width
    }

    public func y(_ value: Double) -> CGFloat {
        size.height - CGFloat(Swift.max(0, Swift.min(value, yMax)) / yMax) * size.height
    }

    public func date(atX x: CGFloat) -> Date {
        let span = domain.upperBound.timeIntervalSince(domain.lowerBound)
        return domain.lowerBound.addingTimeInterval(TimeInterval(x / Swift.max(1, size.width)) * span)
    }

    /// The line's vertices. Step: hold each value until the next reading, then move (a reset is the vertical drop).
    /// Linear: straight from reading to reading. The last value runs on to `extendTo`.
    public func line(_ samples: [UsageLaneSample], shape: UsageLineShape, extendTo end: Date?) -> [CGPoint] {
        var points: [CGPoint] = []
        for sample in samples {
            let point = CGPoint(x: x(sample.date), y: y(sample.value))
            if shape == .step, let previous = points.last {
                points.append(CGPoint(x: point.x, y: previous.y))
            }
            points.append(point)
        }
        if let end, let last = samples.last, end > last.date {
            points.append(CGPoint(x: x(end), y: y(last.value)))
        }
        return points
    }

    /// The cone between the slow and the fast pace from the last reading to `end`: start, slow end, fast end.
    public func cone(_ forecast: UsageLaneForecast, until end: Date) -> [CGPoint]? {
        guard let low = forecast.lowPerHour, let high = forecast.highPerHour, end > forecast.start else { return nil }
        let hours = end.timeIntervalSince(forecast.start) / 3600
        let start = CGPoint(x: x(forecast.start), y: y(forecast.value))
        return [start, CGPoint(x: x(end), y: y(forecast.value + low * hours)), CGPoint(x: x(end), y: y(forecast.value + high * hours))]
    }

    /// A straight line from the last reading at `perHour` to `end`.
    public func projection(_ forecast: UsageLaneForecast, perHour: Double?, until end: Date) -> [CGPoint]? {
        guard let perHour, end > forecast.start else { return nil }
        let hours = end.timeIntervalSince(forecast.start) / 3600
        return [CGPoint(x: x(forecast.start), y: y(forecast.value)), CGPoint(x: x(end), y: y(forecast.value + perHour * hours))]
    }
}

extension UsageAccountLanes {
    /// The time the chart ends: now, plus room for the projection when one is drawn (at most a quarter of the range,
    /// or up to the nearest reset if that comes sooner).
    public static func domainEnd(_ lanes: [UsageAccountLanes], now: Date, range: TimeInterval, projection: Bool) -> Date {
        guard projection else { return now }
        let resets = lanes.flatMap(\.lanes).compactMap { $0.forecast?.resetAt }.filter { $0 > now }
        let room = range * 0.25
        let nearest = resets.min().map { Swift.min($0.timeIntervalSince(now), room) } ?? room
        return now.addingTimeInterval(Swift.max(nearest, range * 0.08))
    }
}
