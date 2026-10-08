// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusSessionDetailModel.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation

/// Spec 22 (S6) §10.7 — one pomodoro, in full.
///
/// The Studio's Sessions tab answers "which session"; this answers "what was that session".
/// Everything is read once per load and published as plain arrays, for the same reason the
/// Studio model does it: a body must never query a ledger.
///
/// The unit of truth here is the **event**, not the bucket. A breakdown that only ranks apps
/// cannot answer "what did I do at 14:32", so segments, pauses and capture gaps are merged into
/// one chronological list, and the rankings are derived from it.
@MainActor
public final class FocusSessionDetailModel: ObservableObject {
    /// One thing that happened inside the session, whatever kind of thing it was.
    public struct Event: Identifiable, Equatable {
        public enum Kind: Equatable {
            case work
            case idle
            case pause(String)
            case gap(String)

            public var isWork: Bool { self == .work }
        }

        public let id: String
        public let kind: Kind
        public let startedMs: Int64
        public let endedMs: Int64
        public let appName: String
        public let appBundle: String?
        public let windowTitle: String?
        public let urlHost: String?
        public let urlPath: String?
        public let project: String?
        public let cmux: String?
        public let keys: Int

        public var durationMs: Int64 { max(0, endedMs - startedMs) }

        /// The one line a row shows under the app name.
        public var detail: String? {
            if let urlHost {
                guard let urlPath, urlPath != "/" , !urlPath.isEmpty else { return urlHost }
                return urlHost + urlPath
            }
            if let cmux { return "cmux · \(cmux)" }
            return windowTitle
        }
    }

    /// Keystrokes and clicks in one slot of the effort chart.
    public struct EffortPoint: Identifiable, Equatable {
        public let id: Int64
        public let startedMs: Int64
        public let keys: Int
        public let clicks: Int
    }

    @Published public private(set) var session: ActivityStore.FocusSession?
    @Published public private(set) var totals = FocusAggregate.Totals()
    @Published public private(set) var appBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var windowBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var siteBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var projectBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var events: [Event] = []
    @Published public private(set) var effort: [EffortPoint] = []
    @Published public private(set) var counts = ActivityStore.InputCounts()
    @Published public private(set) var pausedMs: Int64 = 0
    @Published public private(set) var unmeasuredMs: Int64 = 0
    /// True when the row is gone (forgotten through the privacy path, or a stale window).
    @Published public private(set) var missing = false

    public let sessionId: Int64
    private let store: ActivityStore

    public init(store: ActivityStore, sessionId: Int64) {
        self.store = store
        self.sessionId = sessionId
    }

    // MARK: - Loading

    public func reload(now: Date = Date()) {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        guard let session = try? store.session(id: sessionId) else {
            missing = true
            return
        }
        missing = false
        self.session = session

        let from = session.startedMs
        let to = session.endedMs ?? nowMs
        // A segment that started before the session still counts for the part inside it, so the
        // window is widened by one hour and every span is clipped below.
        let all = (try? store.segments(from: from - 3_600_000, to: to)) ?? []
        let segments = all.filter { ($0.endedMs ?? nowMs) > from && $0.startedMs < max(to, from + 1) }
        let gaps = (try? store.gaps(from: from, to: to)) ?? []
        let pauses = (try? store.pauses(sessionId: sessionId)) ?? []
        let samples = (try? store.inputSeries(from: from, to: to)) ?? []

        totals = FocusAggregate.totals(segments, from: from, to: to, now: nowMs)
        appBuckets = FocusAggregate.buckets(segments, from: from, to: to, now: nowMs,
                                            bundle: { $0.appBundle }) { $0.appName }
        windowBuckets = FocusAggregate.buckets(segments, from: from, to: to, now: nowMs,
                                               bundle: { $0.appBundle }) {
            $0.windowTitle ?? $0.urlHost ?? $0.appName
        }
        siteBuckets = FocusAggregate.buckets(segments, from: from, to: to, now: nowMs) { $0.urlHost }
        projectBuckets = FocusAggregate.buckets(segments, from: from, to: to, now: nowMs) { $0.project }

        counts = samples.reduce(ActivityStore.InputCounts()) { $0 + $1.counts }
        pausedMs = (try? store.pausedMs(sessionId: sessionId, now: nowMs)) ?? 0
        unmeasuredMs = gaps.reduce(Int64(0)) { total, gap in
            total + max(0, min(gap.endedMs ?? nowMs, to) - max(gap.startedMs, from))
        }

        var keysBySegment: [Int64: Int] = [:]
        for sample in samples { keysBySegment[sample.segmentId, default: 0] += sample.counts.keys }

        events = buildEvents(segments: segments, pauses: pauses, gaps: gaps,
                             keysBySegment: keysBySegment, from: from, to: to, now: nowMs)
        effort = buildEffort(samples, from: from, to: to, now: nowMs)

        AppIconService.shared.preload(appBuckets.map(\.bundleId))
    }

    private func buildEvents(segments: [ActivityStore.Segment],
                             pauses: [ActivityStore.Pause],
                             gaps: [ActivityStore.Gap],
                             keysBySegment: [Int64: Int],
                             from: Int64, to: Int64, now: Int64) -> [Event] {
        var rows: [Event] = segments.compactMap { segment in
            let start = max(segment.startedMs, from)
            let end = min(segment.endedMs ?? now, max(to, start))
            guard end > start else { return nil }
            return Event(
                id: "s\(segment.id)",
                kind: segment.idle ? .idle : .work,
                startedMs: start,
                endedMs: end,
                appName: segment.idle ? "idle" : segment.appName,
                appBundle: segment.idle ? nil : segment.appBundle,
                windowTitle: segment.windowTitle,
                urlHost: segment.urlHost,
                urlPath: segment.urlPath,
                project: segment.project,
                cmux: segment.cmuxPane ?? segment.cmuxSession,
                keys: keysBySegment[segment.id] ?? 0)
        }
        rows += pauses.compactMap { pause in
            let start = max(pause.startedMs, from)
            let end = min(pause.endedMs ?? now, max(to, start))
            guard end > start else { return nil }
            return Event(id: "p\(pause.id)", kind: .pause(pause.reason), startedMs: start, endedMs: end,
                         appName: "paused", appBundle: nil, windowTitle: nil, urlHost: nil,
                         urlPath: nil, project: nil, cmux: nil, keys: 0)
        }
        rows += gaps.compactMap { gap in
            let start = max(gap.startedMs, from)
            let end = min(gap.endedMs ?? now, max(to, start))
            guard end - start >= 5_000 else { return nil }
            return Event(id: "g\(gap.id)", kind: .gap(gap.reason), startedMs: start, endedMs: end,
                         appName: "not measured", appBundle: nil, windowTitle: nil, urlHost: nil,
                         urlPath: nil, project: nil, cmux: nil, keys: 0)
        }
        return rows.sorted { $0.startedMs < $1.startedMs }
    }

    /// At most 60 bars: a 25-minute pomodoro gets its real minutes, a three-hour overrun gets
    /// wider slots rather than a chart nobody can read.
    private func buildEffort(_ samples: [ActivityStore.InputSample],
                             from: Int64, to: Int64, now: Int64) -> [EffortPoint] {
        let end = max(to, from + 60_000)
        let span = end - from
        let slot = max(Int64(60_000), Int64((Double(span) / 60).rounded(.up)))
        let count = Int(max(1, (span + slot - 1) / slot))
        var keys = [Int](repeating: 0, count: count)
        var clicks = [Int](repeating: 0, count: count)
        for sample in samples {
            let index = Int((sample.bucketMs - from) / slot)
            guard index >= 0, index < count else { continue }
            keys[index] += sample.counts.keys
            clicks[index] += sample.counts.clicks
        }
        return (0 ..< count).map { index in
            EffortPoint(id: Int64(index), startedMs: from + Int64(index) * slot,
                        keys: keys[index], clicks: clicks[index])
        }
    }

    // MARK: - Derived

    public var title: String {
        guard let session else { return "Session \(sessionId)" }
        let kind = session.kind.replacingOccurrences(of: "_", with: " ")
        let tag = session.tag.map { " · \($0)" } ?? ""
        return "\(kind.capitalized)\(tag) — \(FocusFormat.clockTime(session.startedMs))"
    }

    public var plannedMs: Int64 { Int64(session?.plannedSec ?? 0) * 1000 }

    public var actualMs: Int64 {
        guard let session else { return 0 }
        return (session.endedMs ?? Int64(Date().timeIntervalSince1970 * 1000)) - session.startedMs
    }

    /// Fraction of the planned length that was actually spent, capped at 1 for the ring.
    public var completion: Double {
        guard plannedMs > 0 else { return actualMs > 0 ? 1 : 0 }
        return min(1, Double(actualMs) / Double(plannedMs))
    }

    /// The share of the session spent focused on something, as opposed to idle, paused or
    /// unrecorded. This is the number that says whether a pomodoro was real.
    public var density: Double {
        guard actualMs > 0 else { return 0 }
        return min(1, Double(totals.focusedMs) / Double(actualMs))
    }

    /// Same numbers, pasteable. Deliberately the shape `genesis focus sessions` prints.
    public func markdown() -> String {
        guard let session else { return "Session \(sessionId) is no longer recorded." }
        var lines = ["# \(title)", ""]
        let ended = session.endedMs.map(FocusFormat.clockTime) ?? "running"
        lines.append("\(FocusFormat.clockTime(session.startedMs)) → \(ended) · "
            + "planned \(FocusFormat.duration(plannedMs)) · actual \(FocusFormat.duration(actualMs)) · \(session.state)")
        lines.append("Focused \(FocusFormat.duration(totals.focusedMs)) (\(FocusFormat.percent(density))) · "
            + "idle \(FocusFormat.duration(totals.idleMs)) · paused \(FocusFormat.duration(pausedMs)) · "
            + "\(totals.switches) switches · \(session.interruptions) interruptions")
        lines.append("Keystrokes \(counts.keys) · clicks \(counts.clicks)")
        if let note = session.note, !note.isEmpty { lines.append("Note: \(note)") }
        if !appBuckets.isEmpty {
            lines.append("")
            lines.append("## Apps")
            for bucket in appBuckets {
                lines.append("- \(bucket.key) \(FocusFormat.duration(bucket.ms)) (\(FocusFormat.percent(bucket.share)))"
                    + " · \(bucket.visits) visits")
            }
        }
        if !siteBuckets.isEmpty {
            lines.append("")
            lines.append("## Sites")
            for bucket in siteBuckets.prefix(12) {
                lines.append("- \(bucket.key) \(FocusFormat.duration(bucket.ms))")
            }
        }
        lines.append("")
        lines.append("## Timeline")
        for event in events {
            let label: String = switch event.kind {
            case .work: event.detail.map { "\(event.appName) — \($0)" } ?? event.appName
            case .idle: "idle"
            case .pause(let reason): "paused (\(reason))"
            case .gap(let reason): "not measured (\(reason))"
            }
            lines.append("- \(FocusFormat.clockTime(event.startedMs)) \(FocusFormat.duration(event.durationMs))  \(label)")
        }
        return lines.joined(separator: "\n")
    }
}
