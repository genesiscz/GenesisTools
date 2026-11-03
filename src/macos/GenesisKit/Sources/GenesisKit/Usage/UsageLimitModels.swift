import Foundation

// The limit doors: `tools ai usage limits` (usage.limits@1), `limits series` (usage.limits.series@1), `limits advise`
// (usage.limits.advise@1), `limits health` (usage.limits.health@1), `limits spikes` (usage.limits.spikes@1),
// `usage events` (usage.events@1) and `usage alerts` (usage.alerts@1). Field names follow the TypeScript types in
// src/utils/ai/usage-poll/series.ts, src/utils/ai/usage/poll-runs/health.ts, events/store.ts and alerts/types.ts.

// MARK: - limits@1

public struct UsageLimitsData: Decodable, Equatable, Sendable {
    public let accounts: [UsageLimitsAccount]
}

/// One account's windows now, from the last poll.
public struct UsageLimitsAccount: Decodable, Equatable, Sendable, Identifiable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    public let fetchedAt: String?
    /// The plan label ("max 20x").
    public let label: String?
    public let limits: [UsageLimitRow]
    /// Windows this account has no limit for (`five_hour` on an account without a 5h window). Never drawn as 0%.
    public let absentLimits: [UsageAbsentLimit]?
    public let error: String?

    public var key: UsageAccountKey { UsageAccountKey(provider: provider, accountId: accountId, accountName: accountName) }
    public var id: String { key.id }
}

public struct UsageLimitRow: Decodable, Equatable, Sendable, Identifiable {
    public let key: String
    public let label: String
    public let kind: String?
    public let percentUsed: Double?
    public let severity: String?
    public let isActive: Bool?
    public let resetsAt: String?
    public let periodMs: Double?
    public let scopeModel: String?
    public var id: String { key }
}

public struct UsageAbsentLimit: Decodable, Equatable, Sendable {
    public let key: String
    public let kind: String?
}

// MARK: - limits.series@1

public struct UsageSeriesData: Decodable, Equatable, Sendable {
    public let agg: String
    public let stepMs: Double
    public let series: [UsageSeriesItem]
    /// Poll coverage per account: the strip under its lanes.
    public let coverage: [UsageCoverage]
    /// Rate limits, cooldowns, poll pauses, blocks and probes in the window: the markers on the lanes.
    public let events: [UsageEventRow]

    private enum CodingKeys: String, CodingKey { case agg, stepMs, series, coverage, events }

    public init(agg: String, stepMs: Double, series: [UsageSeriesItem], coverage: [UsageCoverage] = [], events: [UsageEventRow] = []) {
        self.agg = agg
        self.stepMs = stepMs
        self.series = series
        self.coverage = coverage
        self.events = events
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        agg = try container.decodeIfPresent(String.self, forKey: .agg) ?? "last"
        stepMs = try container.decodeIfPresent(Double.self, forKey: .stepMs) ?? 0
        series = try container.decodeIfPresent([UsageSeriesItem].self, forKey: .series) ?? []
        coverage = try container.decodeIfPresent([UsageCoverage].self, forKey: .coverage) ?? []
        events = try container.decodeIfPresent([UsageEventRow].self, forKey: .events) ?? []
    }
}

/// One window of one account over time: raw points, or min-max bins above the raw range.
public struct UsageSeriesItem: Decodable, Equatable, Sendable, Identifiable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    /// The provider's own window key (`five_hour`, `primary`, `seven_day_fable`).
    public let key: String
    /// `session`, `weekly`, `monthly`, `scoped`, `credit`; nil for a window the store has no kind for.
    public let kind: String?
    public let scopeModel: String?
    public let label: String
    public let periodMs: Double?
    public let availability: [UsageAvailabilitySpan]
    /// The newest poll's word: `limited`, `absent` (the line ends) or `unknown`.
    public let availableNow: String?
    public let points: [UsageSeriesPoint]?
    public let bins: [UsageSeriesBin]?
    public let resets: [String]
    public let current: UsageLimitCurrent?
    public let forecast: UsageLimitForecast?

    public var account: UsageAccountKey { UsageAccountKey(provider: provider, accountId: accountId, accountName: accountName) }
    /// The kind is part of it: a window whose kind changed in the range (a Codex plan change) is two series.
    public var id: String { account.id + "\u{1}" + key + "\u{1}" + (kind ?? "") }

    /// A scoped window (Fable, Opus) sits behind the "Scoped windows" setting.
    public var isScoped: Bool { kind == "scoped" || scopeModel != nil }
}

public struct UsageSeriesPoint: Decodable, Equatable, Sendable {
    public let t: String
    public let v: Double
    public let severity: String?
}

public struct UsageSeriesBin: Decodable, Equatable, Sendable {
    public let t: String
    public let open: Double
    public let close: Double
    public let min: Double
    public let max: Double
    public let severity: String?
}

public struct UsageAvailabilitySpan: Decodable, Equatable, Sendable {
    public let from: String
    public let to: String
    /// `limited`, `absent` (no such limit on the account) or `unknown` (a row from before the store recorded it).
    public let state: String
}

public struct UsageLimitCurrent: Decodable, Equatable, Sendable {
    public let utilization: Double
    public let resetsAt: String?
    public let severity: String?
    public let fetchedAt: String
}

/// The run-out at the recent burn (`LimitForecast`): the rate, the pace band (25th to 75th percentile) and the safe
/// pace, the constant rate that lands at exactly 100 % at the reset.
public struct UsageLimitForecast: Decodable, Equatable, Sendable {
    public let bucket: String?
    public let kind: String?
    public let label: String?
    public let utilization: Double
    public let resetsAt: String?
    public let lastSampleAt: String?
    public let samples: Int?
    public let ratePctPerHour: Double?
    public let basis: String?
    public let exhaustAt: String?
    public let minutesToExhaust: Double?
    public let beforeReset: Bool
    public let projectedAtReset: Double?
    public let resetSinceSample: Bool?
    public let stale: Bool?
    public let paceBand: UsagePaceBand?
    public let safePctPerHour: Double?
}

public struct UsagePaceBand: Decodable, Equatable, Sendable {
    public let lowPctPerHour: Double
    public let highPctPerHour: Double
}

// MARK: - limits.health@1 and the series' coverage

public struct UsageCoverage: Decodable, Equatable, Sendable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    public let runs: [UsageHealthRun]

    public var account: UsageAccountKey { UsageAccountKey(provider: provider, accountId: accountId, accountName: accountName) }
}

/// A stretch of polls with one outcome: `ok`, `stale`, `error`, `blocked`, `backoff`, `needs-login`.
public struct UsageHealthRun: Decodable, Equatable, Sendable {
    public let from: String
    public let to: String
    public let outcome: String
    public let source: String?
    public let polls: Int?
}

public struct UsageHealthData: Decodable, Equatable, Sendable {
    public let accounts: [UsageAccountHealth]
    public let daemon: UsageDaemonHealth?
}

public struct UsageDaemonHealth: Decodable, Equatable, Sendable {
    public let heartbeatAgeMs: Double?
    public let alive: Bool
    public let lastRoundAt: String?
}

public struct UsageAccountHealth: Decodable, Equatable, Sendable, Identifiable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    /// The latest run's outcome, or `unmeasured` when no run reaches the present.
    public let outcome: String
    public let since: String?
    public let lastPollAt: String?
    public let gateUntil: String?
    public let reason: String?
    public let coveragePct: Double
    public let gaps: [UsageGap]
    public let runs: [UsageHealthRun]

    public var account: UsageAccountKey { UsageAccountKey(provider: provider, accountId: accountId, accountName: accountName) }
    public var id: String { account.id }
}

public struct UsageGap: Decodable, Equatable, Sendable {
    public let from: String
    public let to: String
    public let minutes: Double?
}

// MARK: - events@1

public struct UsageEventsData: Decodable, Equatable, Sendable {
    public let events: [UsageEventRow]
    public let counts: [String: Int]
}

/// One usage event (`UsageEventRow`): a 429, a cooldown, a poll pause, an org block or a quota probe.
public struct UsageEventRow: Decodable, Equatable, Sendable, Identifiable {
    public let id: Int
    public let ts: String
    public let provider: String
    public let accountId: String?
    public let accountName: String?
    public let source: String
    public let kind: String
    public let retryAfterMs: Double?
    public let model: String?
    public let detail: String?
    /// A daily count row's local day; nil on a single event.
    public let day: String?
    public let count: Int
}

// MARK: - alerts@1

public struct UsageAlertsData: Decodable, Equatable, Sendable {
    public let alerts: [UsageAlert]
    public let unacked: Int
}

/// A row of `usage_alerts`.
public struct UsageAlert: Decodable, Equatable, Sendable, Identifiable {
    public let id: Int
    public let rule: String
    public let provider: String?
    public let accountId: String?
    public let accountName: String?
    public let windowKind: String?
    public let windowKey: String?
    /// `info`, `warning` or `critical`.
    public let level: String
    public let title: String
    public let message: String
    public let firedAt: String
    public let channels: [String]?
    public let ackAt: String?

    public var isOpen: Bool { ackAt == nil }
}

// MARK: - limits.spikes@1

public struct UsageSpikesData: Decodable, Equatable, Sendable {
    public let spikes: [UsageSpike]
}

/// A rise of at least `minDelta` points within `windowMinutes`, with the sessions that spent on that account then.
public struct UsageSpike: Decodable, Equatable, Sendable, Identifiable {
    public let account: UsageAccountKey
    public let kind: String?
    public let key: String
    public let from: String
    public let to: String
    public let startPercent: Double
    public let endPercent: Double
    public let delta: Double
    public let sessions: [UsageSessionShare]
    public let unattributed: UsageUnattributed?
    public let totalUsd: Double
    public let unpriced: Int?

    public var id: String { account.id + "\u{1}" + key + "\u{1}" + from }
}

// MARK: - limits.advise@1

public struct UsageAdviseData: Decodable, Equatable, Sendable {
    public let providers: [UsageAdviceProvider]
}

public struct UsageAdviceProvider: Decodable, Equatable, Sendable, Identifiable {
    public let provider: String
    public let profiles: [UsageAdviceProfile]
    public let unusedAtReset: [UsageUnusedAtReset]
    public var id: String { provider }
}

public struct UsageAdviceProfile: Decodable, Equatable, Sendable, Identifiable {
    /// `default`, `fan-out`, `long-run`, or a model.
    public let profile: String
    public let pick: UsageAdvicePick?
    public let runnerUp: UsageAdvicePick?
    public var id: String { profile }
}

public struct UsageAdvicePick: Decodable, Equatable, Sendable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    public let tier: String
    public let why: String
    public let lastsMinutes: Double?
    public let bindingLabel: String?
}

public struct UsageUnusedAtReset: Decodable, Equatable, Sendable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    public let key: String
    public let label: String
    public let resetsAt: String?
    public let unusedPct: Double
}
