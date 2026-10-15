import Foundation

/// How bad an alert is. Ordered: `info < warning < critical < emergency`.
public enum AlertSeverity: Int, Codable, Comparable, CaseIterable, Sendable {
    case info = 0
    case warning = 1
    case critical = 2
    case emergency = 3

    public static func < (lhs: AlertSeverity, rhs: AlertSeverity) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// One alert level of a measured value: free bytes under 10 GB is a warning, under 1 GB critical.
public struct AlertTier: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    /// The value at which the tier starts, in the policy's direction.
    public var threshold: Double
    public var severity: AlertSeverity
    /// How far past `threshold` the value must recover before the tier ends; nil uses the policy's hysteresis.
    public var clearMargin: Double?
    /// The reminder interval while this tier lasts; nil uses the policy's `repeatInterval`.
    public var repeatInterval: TimeInterval?

    public init(id: String, threshold: Double, severity: AlertSeverity, clearMargin: Double? = nil,
                repeatInterval: TimeInterval? = nil) {
        self.id = id
        self.threshold = threshold
        self.severity = severity
        self.clearMargin = clearMargin
        self.repeatInterval = repeatInterval
    }
}

/// Minutes since local midnight; `start > end` wraps past midnight (22:00 to 07:00).
public struct AlertQuietHours: Codable, Equatable, Hashable, Sendable {
    public var startMinute: Int
    public var endMinute: Int

    public init(startMinute: Int, endMinute: Int) {
        self.startMinute = startMinute
        self.endMinute = endMinute
    }

    public func contains(_ date: Date, calendar: Calendar = .current) -> Bool {
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        let start = ((startMinute % 1440) + 1440) % 1440
        let end = ((endMinute % 1440) + 1440) % 1440
        if start == end { return false }
        return start < end ? (minute >= start && minute < end) : (minute >= start || minute < end)
    }
}

/// Why an event was not meant to interrupt the user.
public enum AlertSuppression: String, Codable, Equatable, Sendable {
    case snoozed
    case quietHours
}

/// One change the policy reports. `notifies` is the policy's verdict for interrupting channels (banner, sound,
/// speech, glow); a status channel (menu tint, a page) shows every event.
public struct AlertEvent: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Equatable, Sendable {
        /// The value entered a tier from none.
        case raised
        /// The value entered a worse tier.
        case escalated
        /// The tier is still on and its reminder interval passed, or an alert held back by quiet hours or a
        /// snooze is now due. Always `notifies`.
        case reminder
        /// The value recovered into a milder tier.
        case improved
        /// The value recovered past every tier's clear point.
        case cleared
    }

    public var kind: Kind
    /// The tier now on; nil for `.cleared`.
    public var tier: AlertTier?
    /// The tier before this event; nil for `.raised` and `.reminder`.
    public var previousTier: AlertTier?
    public var value: Double
    public var date: Date
    public var notifies: Bool
    public var suppression: AlertSuppression?

    public init(kind: Kind, tier: AlertTier?, previousTier: AlertTier?, value: Double, date: Date,
                notifies: Bool, suppression: AlertSuppression?) {
        self.kind = kind
        self.tier = tier
        self.previousTier = previousTier
        self.value = value
        self.date = date
        self.notifies = notifies
        self.suppression = suppression
    }

    /// The severity a channel routes on: the tier's, or the cleared tier's for `.cleared`.
    public var severity: AlertSeverity { (tier ?? previousTier)?.severity ?? .info }
}

/// A snooze: until `until`, alerts at or below `severity` do not interrupt. A worse tier breaks through.
public struct AlertSnooze: Codable, Equatable, Sendable {
    public var until: Date
    public var severity: AlertSeverity

    public init(until: Date, severity: AlertSeverity) {
        self.until = until
        self.severity = severity
    }
}

/// What the policy remembers between samples. Codable, so a host can keep a snooze across a restart.
public struct AlertState: Codable, Equatable, Sendable {
    /// The id of the tier on now.
    public var tierID: String?
    /// When this tier last interrupted the user; nil when it never did (it was held back).
    public var lastNotified: Date?
    public var snooze: AlertSnooze?
    /// A worse tier the value reached that is not confirmed yet (`confirmSamples`, `confirmDuration`).
    public var pendingTierID: String?
    public var pendingSince: Date?
    public var pendingCount: Int

    public init(tierID: String? = nil, lastNotified: Date? = nil, snooze: AlertSnooze? = nil,
                pendingTierID: String? = nil, pendingSince: Date? = nil, pendingCount: Int = 0) {
        self.tierID = tierID
        self.lastNotified = lastNotified
        self.snooze = snooze
        self.pendingTierID = pendingTierID
        self.pendingSince = pendingSince
        self.pendingCount = pendingCount
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tierID = try container.decodeIfPresent(String.self, forKey: .tierID)
        lastNotified = try container.decodeIfPresent(Date.self, forKey: .lastNotified)
        snooze = try container.decodeIfPresent(AlertSnooze.self, forKey: .snooze)
        pendingTierID = try container.decodeIfPresent(String.self, forKey: .pendingTierID)
        pendingSince = try container.decodeIfPresent(Date.self, forKey: .pendingSince)
        pendingCount = try container.decodeIfPresent(Int.self, forKey: .pendingCount) ?? 0
    }
}

/// Turns a stream of measured values into alert events. Pure: no clock, no timer, no I/O; the caller passes each
/// value with its time and keeps the `AlertState`.
///
/// - Tiers: the value is in the worst tier whose threshold it crossed (`below`: under the threshold).
/// - Hysteresis: a tier, once on, ends only when the value recovers past `threshold ± margin`, so a value that
///   hovers at a threshold raises once and does not flap.
/// - Confirmation: with `confirmSamples` or `confirmDuration` set, a worse tier is entered only after the value
///   stayed past its threshold for that many samples and that long, so one dip does not alert.
/// - Escalation to a worse tier notifies at once; recovery into a milder tier reports `.improved`, and past every
///   tier `.cleared` (neither interrupts).
/// - Reminders: while a tier lasts it notifies again every `repeatInterval` (nil: never).
/// - Quiet hours and a snooze hold interrupting events back; an event at or above `emergencyOverride` breaks
///   through both, and a snooze ends early when the value reaches a worse severity than the snoozed one. A held
///   back alert notifies as a `.reminder` once the quiet hours or the snooze end.
public struct AlertPolicy: Codable, Equatable, Sendable {
    public enum Direction: String, Codable, Equatable, Sendable {
        /// Lower is worse (free space, a health score).
        case below
        /// Higher is worse (temperature, memory pressure).
        case above
    }

    public var direction: Direction
    public var tiers: [AlertTier]
    /// The default clear margin as a fraction of a tier's threshold (0.1: a 10 GB tier ends above 11 GB).
    public var hysteresisFraction: Double
    public var repeatInterval: TimeInterval?
    public var quietHours: AlertQuietHours?
    /// Events at or above this severity ignore quiet hours and a snooze; nil lets nothing through.
    public var emergencyOverride: AlertSeverity?
    /// A worse tier is entered only after this many consecutive samples past its threshold (1: at once).
    public var confirmSamples: Int
    /// ...and only once the value has stayed past it this long (0: at once).
    public var confirmDuration: TimeInterval

    public init(direction: Direction = .below, tiers: [AlertTier], hysteresisFraction: Double = 0.1,
                repeatInterval: TimeInterval? = 3600, quietHours: AlertQuietHours? = nil,
                emergencyOverride: AlertSeverity? = .emergency, confirmSamples: Int = 1,
                confirmDuration: TimeInterval = 0) {
        self.direction = direction
        self.tiers = tiers
        self.hysteresisFraction = hysteresisFraction
        self.repeatInterval = repeatInterval
        self.quietHours = quietHours
        self.emergencyOverride = emergencyOverride
        self.confirmSamples = confirmSamples
        self.confirmDuration = confirmDuration
    }

    /// A stored policy from an older build lacks the newer fields; they take their defaults.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        direction = try container.decodeIfPresent(Direction.self, forKey: .direction) ?? .below
        tiers = try container.decode([AlertTier].self, forKey: .tiers)
        hysteresisFraction = try container.decodeIfPresent(Double.self, forKey: .hysteresisFraction) ?? 0.1
        repeatInterval = try container.decodeIfPresent(TimeInterval.self, forKey: .repeatInterval)
        quietHours = try container.decodeIfPresent(AlertQuietHours.self, forKey: .quietHours)
        emergencyOverride = try container.decodeIfPresent(AlertSeverity.self, forKey: .emergencyOverride)
        confirmSamples = try container.decodeIfPresent(Int.self, forKey: .confirmSamples) ?? 1
        confirmDuration = try container.decodeIfPresent(TimeInterval.self, forKey: .confirmDuration) ?? 0
    }

    /// The tiers from mildest to worst.
    public var orderedTiers: [AlertTier] {
        tiers.sorted { lhs, rhs in
            if lhs.severity != rhs.severity { return lhs.severity < rhs.severity }
            return direction == .below ? lhs.threshold > rhs.threshold : lhs.threshold < rhs.threshold
        }
    }

    /// Whether `value` is past `tier`'s threshold.
    public func crosses(_ value: Double, _ tier: AlertTier) -> Bool {
        direction == .below ? value < tier.threshold : value > tier.threshold
    }

    /// The value at which `tier` ends once it is on.
    public func clearPoint(of tier: AlertTier) -> Double {
        let margin = tier.clearMargin ?? abs(tier.threshold) * max(0, hysteresisFraction)
        return direction == .below ? tier.threshold + margin : tier.threshold - margin
    }

    /// The tier `value` is in, given the tier on before: the worst tier it crossed, or the worst tier at or below
    /// the current one whose clear point it has not passed yet.
    public func tier(for value: Double, current: AlertTier?) -> AlertTier? {
        let ordered = orderedTiers
        let currentRank = current.flatMap { tier in ordered.firstIndex { $0.id == tier.id } }
        var result: Int?
        for (rank, tier) in ordered.enumerated() {
            let held: Bool
            if let currentRank, rank <= currentRank {
                held = direction == .below ? value < clearPoint(of: tier) : value > clearPoint(of: tier)
            } else {
                held = false
            }
            if crosses(value, tier) || held { result = rank }
        }
        return result.map { ordered[$0] }
    }

    /// Why an interrupting event at `severity` would be held back at `date`; nil when it may interrupt.
    public func suppression(for severity: AlertSeverity, at date: Date, state: AlertState,
                            calendar: Calendar = .current) -> AlertSuppression? {
        if let emergencyOverride, severity >= emergencyOverride { return nil }
        if let snooze = state.snooze, date < snooze.until, severity <= snooze.severity { return .snoozed }
        if let quietHours, quietHours.contains(date, calendar: calendar) { return .quietHours }
        return nil
    }

    /// Snoozes the tier on now (or `severity`) until `until`.
    public func snoozed(_ state: AlertState, until: Date, severity: AlertSeverity? = nil) -> AlertState {
        var next = state
        let current = state.tierID.flatMap { id in tiers.first { $0.id == id } }
        next.snooze = AlertSnooze(until: until, severity: severity ?? current?.severity ?? .critical)
        return next
    }

    /// Feeds one measured value. Updates `state` and returns the events it caused (usually none).
    public func evaluate(_ value: Double, at date: Date, state: inout AlertState,
                         calendar: Calendar = .current) -> [AlertEvent] {
        // A NaN or infinite reading crosses no tier; it must not clear an alert that is on.
        guard value.isFinite else { return [] }
        if let snooze = state.snooze, date >= snooze.until { state.snooze = nil }
        let current = state.tierID.flatMap { id in tiers.first { $0.id == id } }
        var next = tier(for: value, current: current)
        let ordered = orderedTiers
        func rank(_ tier: AlertTier?) -> Int {
            guard let tier else { return -1 }
            return ordered.firstIndex { $0.id == tier.id } ?? -1
        }

        if rank(next) > rank(current), confirmSamples > 1 || confirmDuration > 0 {
            // Each candidate tier must earn its own consecutive samples and confirmation duration.
            if state.pendingTierID != next?.id {
                state.pendingCount = 0
                state.pendingSince = date
            }
            state.pendingTierID = next?.id
            state.pendingCount += 1
            let since = state.pendingSince ?? date
            state.pendingSince = since
            if state.pendingCount < confirmSamples || date.timeIntervalSince(since) < confirmDuration {
                next = current
            } else {
                state.pendingTierID = nil
                state.pendingSince = nil
                state.pendingCount = 0
            }
        } else {
            state.pendingTierID = nil
            state.pendingSince = nil
            state.pendingCount = 0
        }

        if let next, next.severity > (state.snooze?.severity ?? .emergency) {
            // A worse severity than the snoozed one ends the snooze.
            state.snooze = nil
        }

        let kind: AlertEvent.Kind?
        if rank(next) > rank(current) {
            kind = current == nil ? .raised : .escalated
        } else if rank(next) < rank(current) {
            kind = next == nil ? .cleared : .improved
        } else if let next {
            // A reminder is due after the interval, or at once for a tier that was on but held back. It is reported
            // only when it may interrupt; a held-back reminder is no change at all.
            let interval = next.repeatInterval ?? repeatInterval
            let due = state.lastNotified.map { last in interval.map { date.timeIntervalSince(last) >= $0 } ?? false } ?? true
            kind = due && suppression(for: next.severity, at: date, state: state, calendar: calendar) == nil ? .reminder : nil
        } else {
            kind = nil
        }

        guard let kind else { return [] }
        state.tierID = next?.id
        switch kind {
        case .raised, .escalated, .reminder:
            let held = suppression(for: next?.severity ?? .info, at: date, state: state, calendar: calendar)
            state.lastNotified = held == nil ? date : nil
            return [AlertEvent(kind: kind, tier: next, previousTier: kind == .escalated ? current : nil,
                               value: value, date: date, notifies: held == nil, suppression: held)]
        case .improved, .cleared:
            if kind == .cleared { state.lastNotified = nil }
            return [AlertEvent(kind: kind, tier: next, previousTier: current, value: value, date: date,
                               notifies: false, suppression: nil)]
        }
    }
}
