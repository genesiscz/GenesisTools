import Foundation

// The money doors: `tools ai-spend pivot | plans | proxy | waste | workers` (usage.spend.*@1, except workers, which
// keeps its older shape), `limits attribution` (usage.limits.attribution@1), `limits drift` (usage.limits.drift@1),
// `usage digest` (usage.digest@1) and `tools ai sessions report <id>` (sessions.report@1). Money is USD; an event with
// no known rate is a count (`unpriced`), never $0.

// MARK: - spend.pivot@1

public struct UsagePivotData: Decodable, Equatable, Sendable {
    public let by: [String]
    public let grain: String
    public let tz: String?
    public let total: UsageSpendTotal
    public let groups: [UsagePivotGroup]
    public let heatmap: UsagePivotHeatmap?
}

public struct UsageSpendTotal: Decodable, Equatable, Sendable {
    public let costUsd: Double
    public let tokens: Double
    public let unpriced: Int
}

/// One combination of the `--by` dimensions (`{ provider: "anthropic-sub" }`) with its buckets.
public struct UsagePivotGroup: Decodable, Equatable, Sendable, Identifiable {
    public let key: [String: String]
    public let costUsd: Double
    public let tokens: Double
    public let unpriced: Int
    public let points: [UsagePivotPoint]

    public var id: String { key.keys.sorted().map { "\($0)=\(key[$0] ?? "")" }.joined(separator: "&") }
    /// The dimension values joined for a legend: "anthropic-sub · claude-opus-5-5".
    public func label(_ order: [String]) -> String { order.compactMap { key[$0] }.joined(separator: " · ") }
}

/// One bucket: `t` is the local bucket key (`2026-10-27T06` for an hour, `2026-10-27` for a day).
public struct UsagePivotPoint: Decodable, Equatable, Sendable {
    public let t: String
    public let costUsd: Double
    public let tokens: Double
}

/// Average dollars by weekday (rows, Monday first) and hour (columns).
public struct UsagePivotHeatmap: Decodable, Equatable, Sendable {
    public let cells: [[Double]]
    public let weeks: Double?
}

// MARK: - spend.plans@1

public struct UsagePlansData: Decodable, Equatable, Sendable {
    public let plans: [UsagePlanCycle]
}

/// One subscription account's current billing cycle: list-price spend against the plan's price.
public struct UsagePlanCycle: Decodable, Equatable, Sendable, Identifiable {
    public let account: UsageAccountKey
    /// Nil when the account's login recorded no plan name.
    public let plan: String?
    public let cycle: UsageCycle
    public let renewsInDays: Double?
    public let spendUsd: Double
    /// The plan's price per cycle from the usage config; nil until `tools ai-spend plans price` sets it.
    public let price: Double?
    public let paidBackX: Double?
    public let weeklyRisePct: Double?
    /// Share of the cycle's weekly capacity used, 0..1.
    public let capacityUsed: Double?
    public let usdPerWeeklyPoint: Double?
    public let approximate: Bool?

    public var id: String { account.id + "\u{1}" + (plan ?? "") }
}

public struct UsageCycle: Decodable, Equatable, Sendable {
    public let from: String
    public let to: String
    public let guessed: Bool?
}

// MARK: - spend.proxy@1

public struct UsageProxyData: Decodable, Equatable, Sendable {
    public let clients: [UsageProxyClientMonth]
    public let accounts: [UsageProxyAccountDay]
}

public struct UsageProxyClientMonth: Decodable, Equatable, Sendable, Identifiable {
    public let month: String
    public let client: String
    public let requests: Int
    public let totalTokens: Double
    public let costUsd: Double
    public let unpricedRequests: Int?
    public var id: String { month + "\u{1}" + client }
}

public struct UsageProxyAccountDay: Decodable, Equatable, Sendable, Identifiable {
    public let day: String
    public let account: String
    public let requests: Int
    public let totalTokens: Double
    public let rateLimited: Int
    public let errors: Int
    public let cacheReadShare: Double?
    public var id: String { day + "\u{1}" + account }
}

// MARK: - spend.waste@1

public struct UsageWasteData: Decodable, Equatable, Sendable {
    public let by: [String]
    public let total: UsageWasteTotal
    public let groups: [UsageWasteGroup]
    public let top: [UsageWasteItem]
}

public struct UsageWasteTotal: Decodable, Equatable, Sendable {
    public let usd: Double
    public let tokens: Double
    public let items: Int
}

public struct UsageWasteGroup: Decodable, Equatable, Sendable, Identifiable {
    public let key: [String: String]
    public let usd: Double
    public let tokens: Double
    public let items: Int
    public var id: String { key.keys.sorted().map { "\($0)=\(key[$0] ?? "")" }.joined(separator: "&") }
}

/// One avoidable cost: a cache rebuild after an idle gap, a compaction or a model change.
public struct UsageWasteItem: Decodable, Equatable, Sendable, Identifiable {
    public let kind: String
    public let t: String
    public let model: String?
    public let tokens: Double
    public let usd: Double
    public let evidence: String
    public let agent: String
    public let sessionId: String
    public let project: String?
    public let account: String?
    public let next: String?
    public var id: String { sessionId + "\u{1}" + t + "\u{1}" + kind }
}

// MARK: - ai-spend workers --json (its own shape, not an envelope)

public struct UsageWorkersReport: Decodable, Equatable, Sendable {
    public let dimensions: [String]
    public let groups: [UsageWorkerGroup]
    public let total: UsageWorkerGroup?
    public let notes: [String]?
}

public struct UsageWorkerGroup: Decodable, Equatable, Sendable, Identifiable {
    public let key: [String: String]?
    public let sessions: Int
    public let turns: Int
    public let requests: Int
    public let durationMs: Double
    public let toolCalls: Int
    public let apiEquivalentUsd: Double
    public let billedUsd: Double
    public let unpricedRequests: Int?
    public let claudeOpusUsd: Double?
    public let claudeSonnetUsd: Double?

    public var id: String { (key ?? [:]).keys.sorted().map { "\($0)=\(key?[$0] ?? "")" }.joined(separator: "&") }
    public func label(_ order: [String]) -> String { order.compactMap { key?[$0] }.joined(separator: " · ") }
}

// MARK: - limits.attribution@1

public struct UsageAttributionData: Decodable, Equatable, Sendable {
    public let bars: [UsageAttributionBar]
}

/// Who ate one window of one account since its last reset: projects, then sessions, in dollars and points.
public struct UsageAttributionBar: Decodable, Equatable, Sendable, Identifiable {
    public let account: UsageAccountKey
    public let kind: String?
    public let key: String
    public let since: String?
    public let sinceReset: Bool?
    public let risePercent: Double?
    public let current: Double?
    public let usdPerPercent: Double?
    public let totalUsd: Double
    public let unpriced: Int?
    public let projects: [UsageProjectShare]
    public let sessions: [UsageSessionShare]
    public let unattributed: UsageUnattributed?

    public var id: String { account.id + "\u{1}" + key }
}

/// A bar is one choice of a picker: hashed by its identity, equal by its whole value.
extension UsageAttributionBar: Hashable {
    public func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

public struct UsageProjectShare: Decodable, Equatable, Sendable, Identifiable {
    public let project: String
    public let costUsd: Double
    public let share: Double
    public let barPercent: Double?
    public var id: String { project }
}

// MARK: - limits.drift@1

public struct UsageDriftData: Decodable, Equatable, Sendable {
    public let rows: [UsageDriftRow]
}

/// What one point of a window buys per week, against the account's baseline, with a verdict when the confidence
/// interval of the newest week leaves the baseline's ("limit cut?", "limit raised?").
public struct UsageDriftRow: Decodable, Equatable, Sendable, Identifiable {
    public let account: UsageAccountKey
    public let kind: String
    public let model: String
    public let weeks: [UsageDriftWeek]
    public let baseline: UsageDriftBaseline?
    public let verdict: String?
    public var id: String { account.id + "\u{1}" + kind + "\u{1}" + model }
}

public struct UsageDriftWeek: Decodable, Equatable, Sendable, Identifiable {
    public let week: String
    public let windows: Int
    public let tokensPerPct: Double?
    public let usdPerPct: Double?
    public let ci: [Double]?
    public let status: String
    public var id: String { week }
}

public struct UsageDriftBaseline: Decodable, Equatable, Sendable {
    public let tokensPerPct: Double?
    public let ci: [Double]?
}

// MARK: - usage.digest@1

public struct UsageDigestData: Decodable, Equatable, Sendable {
    public let period: String
    public let days: [String]
    public let windows: [UsageDigestWindow]
    public let alerts: UsageDigestAlerts?
    public let spend: UsageDigestSpend?
    public let outlook: [UsageDigestOutlook]
}

public struct UsageDigestWindow: Decodable, Equatable, Sendable, Identifiable {
    public let account: UsageAccountKey
    public let kind: String?
    public let key: String
    public let startPct: Double?
    public let endPct: Double?
    public let peakPct: Double?
    public let resets: Int
    public let cyclesOver90: Int
    /// The first day the account had no limit for this window; its figures are left out.
    public let noLimitSince: String?
    public var id: String { account.id + "\u{1}" + key }
}

public struct UsageDigestAlerts: Decodable, Equatable, Sendable {
    public let total: Int
    public let byRule: [String: Int]
    public let budget: Int
}

public struct UsageDigestSpend: Decodable, Equatable, Sendable {
    public let totalUsd: Double
    public let byProvider: [UsageNamedAmount]
    public let byModel: [UsageNamedAmount]
    public let topSessions: [UsageDigestSession]
    public let unpriced: Int
}

/// `{ provider, usd }` or `{ model, usd }`: the name under whichever key the CLI used.
public struct UsageNamedAmount: Decodable, Equatable, Sendable, Identifiable {
    public let name: String
    public let usd: Double
    public var id: String { name }

    private enum CodingKeys: String, CodingKey { case provider, model, usd }

    public init(name: String, usd: Double) {
        self.name = name
        self.usd = usd
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decodeIfPresent(String.self, forKey: .provider)
            ?? container.decodeIfPresent(String.self, forKey: .model) ?? "?"
        usd = try container.decode(Double.self, forKey: .usd)
    }
}

public struct UsageDigestSession: Decodable, Equatable, Sendable, Identifiable {
    public let agent: String
    public let sessionId: String
    public let project: String
    public let account: UsageAccountKey?
    public let costUsd: Double
    public let next: String?
    public var id: String { agent + ":" + sessionId }
}

public struct UsageDigestOutlook: Decodable, Equatable, Sendable, Identifiable {
    public let account: UsageAccountKey
    public let label: String
    public let utilization: Double
    public let exhaustAt: String?
    public let resetsAt: String?
    public var id: String { account.id + "\u{1}" + label }
}

// MARK: - usage.budgets@1

public struct UsageBudgetsData: Decodable, Equatable, Sendable {
    public let windows: [UsageBudgetWindowRow]
    public let spend: [UsageSpendBudgetRow]
}

/// A window target with today's pace: keep `reservePct` at the reset, use at most the allowance per day.
public struct UsageBudgetWindowRow: Decodable, Equatable, Sendable, Identifiable {
    public let provider: String
    public let accountId: String
    public let accountName: String
    public let kind: String
    public let key: String
    public let label: String
    public let utilization: Double
    public let resetsAt: String?
    public let budget: UsageWindowBudget
    public let pace: UsageBudgetPace
    public var id: String { provider + "\u{1}" + accountId + "\u{1}" + kind }
}

public struct UsageWindowBudget: Decodable, Equatable, Sendable {
    public let reservePct: Double?
    public let dailyAllowancePct: Double?
}

public struct UsageBudgetPace: Decodable, Equatable, Sendable {
    public let reservePct: Double
    public let allowancePct: Double?
    public let burnedTodayPct: Double?
    public let paceRatio: Double?
    public let headroomPct: Double
    /// `on-pace`, `over-pace`, `under-reserve` or `no-target` (`PaceStatus` in src/utils/ai/usage/budgets/budgets.ts).
    public let status: String
}

/// A spend target: today's dollars against the daily target, for everything (`global`) or one provider.
public struct UsageSpendBudgetRow: Decodable, Equatable, Sendable, Identifiable {
    public let scope: String
    public let dailyUsd: Double
    public let todayUsd: Double
    public let ratio: Double
    public var id: String { scope }
}

// MARK: - sessions.report@1

public struct UsageSessionReportEnvelope: Decodable, Equatable, Sendable {
    public let schema: String
    public let session: UsageReportSession
    public let report: UsageSessionReport
}

public struct UsageReportSession: Decodable, Equatable, Sendable {
    /// The harness that wrote the transcript: `claude`, `codex`, `grok`.
    public let provider: String
    public let sessionId: String
    public let filePath: String?
}

public struct UsageSessionReport: Decodable, Equatable, Sendable {
    public let overview: UsageReportOverview
    public let tokens: UsageReportTokens
    public let cost: UsageReportCost
    public let quotaWeight: Double?
    public let models: [UsageReportModel]
    public let cache: UsageReportCache?
    public let losses: [UsageReportLoss]
    public let topCalls: [UsageReportCall]
    public let gaps: [UsageReportGap]
    /// The facts this transcript cannot give, by name (`callTrace`, `compactions`), with the reason. A missing fact
    /// is shown as not measured, never as zero. Absent in a report from before the field.
    public let unsupported: [String: String]?

    /// Why `fact` is not in this transcript; nil when it is.
    public func unsupportedReason(_ fact: String) -> String? { unsupported?[fact] }
}

public struct UsageReportOverview: Decodable, Equatable, Sendable {
    public let first: String?
    public let last: String?
    public let durationMinutes: Double?
    public let calls: Int
    public let models: [String]
    public let compactions: Int?
    public let subagentCalls: Int?
}

public struct UsageReportTokens: Decodable, Equatable, Sendable {
    public let input: Double
    public let cacheRead: Double
    public let cacheWrite: Double
    public let output: Double
}

public struct UsageReportCost: Decodable, Equatable, Sendable {
    public let totalUsd: Double
    public let mainUsd: Double
    public let subagentUsd: Double
    public let noCacheUsd: Double?
    public let savingsUsd: Double?
    public let unpricedModels: [String]?
}

public struct UsageReportModel: Decodable, Equatable, Sendable, Identifiable {
    public let model: String
    public let calls: Int
    public let costUsd: Double?
    public var id: String { model }
}

public struct UsageReportCache: Decodable, Equatable, Sendable {
    public let requests: Int
    public let hitPercent: Double?
    public let p10: Double?
    public let median: Double?
    public let p90: Double?
    public let losses: Int?
}

/// A call whose cache read fell: why (`idle`, `compaction`, …), and the gap before it.
public struct UsageReportLoss: Decodable, Equatable, Sendable, Identifiable {
    public let call: Int
    /// Epoch milliseconds.
    public let t: Double
    public let before: Double
    public let after: Double
    public let gapMin: Double?
    public let cause: String
    public let reason: String
    public var id: Int { call }
}

public struct UsageReportCall: Decodable, Equatable, Sendable, Identifiable {
    public let index: Int
    public let t: String
    public let model: String
    public let context: Double?
    public let output: Double?
    public let costUsd: Double
    public let tags: [String]
    public var id: Int { index }
}

public struct UsageReportGap: Decodable, Equatable, Sendable, Identifiable {
    public let after: String
    public let minutes: Double
    public var id: String { after }
}
