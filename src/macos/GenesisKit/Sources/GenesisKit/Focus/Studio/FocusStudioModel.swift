// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusStudioModel.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation

/// Spec 22 (S6) §10.4 — everything Focus Studio draws, computed off the view body.
///
/// One load per range or filter change. Views read published arrays; they never query the store
/// and never aggregate in a body, because a body re-runs on every invalidation and this work is
/// proportional to a day of segments.
@MainActor
public final class FocusStudioModel: ObservableObject {
    public enum Tab: String, CaseIterable, Identifiable {
        case timeline = "Timeline"
        case breakdown = "Breakdown"
        case heatmap = "Heatmap"
        case sessions = "Sessions"
        public var id: String { rawValue }
    }

    /// A segment as the timeline draws it: already clipped to the range and given its lane.
    public struct TimelineBar: Identifiable, Equatable {
        public let segmentId: Int64
        public let laneKey: String
        /// Absolute times, for the tooltip and for any caller that needs the real clock.
        public let startedMs: Int64
        public let endedMs: Int64
        /// Milliseconds from the START OF THE LANE. Every lane is drawn across the full width,
        /// so 19:23 in the 19:00 lane is 23 minutes in, not "wherever 19:23 falls in the day".
        public let offsetStartMs: Int64
        public let offsetEndMs: Int64
        public var id: String { "\(segmentId)-\(laneKey)-\(offsetStartMs)" }
        public let appName: String
        public let appBundle: String
        public let detail: String
        public let idle: Bool
        public let sessionId: Int64?
    }

    /// One pomodoro phase as the timeline draws it: a band behind the segments that belong to
    /// it, so a flow and the break after it are two visibly different stretches rather than one
    /// continuous smear of app colours.
    public struct PhaseBand: Identifiable, Equatable {
        public let sessionId: Int64
        /// The lane this piece of the band belongs to. A band is cut per lane and clipped to it:
        /// drawing the whole band in every lane made a 20:30 flow appear in the 18:00 row.
        public let laneKey: String
        public let kind: String
        public let tag: String?
        public let startedMs: Int64
        public let endedMs: Int64
        public let offsetStartMs: Int64
        public let offsetEndMs: Int64
        public var id: String { "\(sessionId)-\(laneKey)" }
        public var isBreak: Bool { kind != ActivityStore.SessionKind.flow.rawValue }
        public var label: String {
            let base = isBreak ? "break" : "flow"
            return tag.map { "\(base) · \($0)" } ?? base
        }
    }

    /// A stretch nothing was recorded in, clipped to the range.
    public struct GapBar: Identifiable, Equatable {
        public let gapId: Int64
        public let laneKey: String
        public let startedMs: Int64
        public let endedMs: Int64
        public let offsetStartMs: Int64
        public let offsetEndMs: Int64
        public let reason: String
        public var id: String { "\(gapId)-\(laneKey)" }

        public var label: String {
            switch reason {
            case "app_not_running": return "app closed"
            case "capture_paused": return "capture paused"
            case "capture_off": return "capture off"
            default: return "not measured"
            }
        }
    }

    public struct SessionCard: Identifiable, Equatable {
        public let id: Int64
        public let kind: String
        public let tag: String?
        public let note: String?
        public let startedMs: Int64
        public let actualMs: Int64
        public let plannedMs: Int64
        public let interruptions: Int
        public let state: String
        public let keys: Int
        public let topApps: [FocusAggregate.Bucket]
    }

    /// Why a range is empty. "Nothing happened" and "nothing was recorded" must never look the
    /// same, so the empty state asks this rather than guessing.
    public enum Emptiness: Equatable {
        case notEmpty
        case nothingRecorded
        case captureWasOff
        case noMatches
    }

    @Published public var tab: Tab = .timeline
    @Published public var range = FocusRange.make(.day)
    @Published public var tagFilter: String?
    @Published public var projectFilter: String?
    @Published public var search = ""

    @Published public private(set) var totals = FocusAggregate.Totals()
    @Published public private(set) var bars: [TimelineBar] = []
    @Published public private(set) var lanes: [String] = []
    @Published public private(set) var appBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var hostBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var projectBuckets: [FocusAggregate.Bucket] = []
    @Published public private(set) var heatCells: [FocusAggregate.HeatCell] = []
    @Published public private(set) var sessionCards: [SessionCard] = []
    @Published public private(set) var childBuckets: [String: [FocusAggregate.Bucket]] = [:]
    @Published public private(set) var emptiness: Emptiness = .notEmpty
    @Published public private(set) var keys = 0
    /// Milliseconds inside the range that nothing was recording, from `capture_gap`.
    @Published public private(set) var unmeasuredMs: Int64 = 0
    /// The gaps themselves, so the timeline can draw the hole instead of closing over it.
    @Published public private(set) var gapBars: [GapBar] = []
    /// Flow and break spans for the timeline's background bands.
    @Published public private(set) var phaseBands: [PhaseBand] = []
    /// When set, every view is scoped to this one session instead of the whole range.
    @Published public var sessionFilter: Int64?
    /// Sessions the session picker offers, newest first.
    @Published public private(set) var sessionOptions: [SessionCard] = []
    @Published public private(set) var availableTags: [String] = []
    @Published public private(set) var availableProjects: [String] = []

    /// Opening a window is the app's job, not the model's; the Sessions tab calls this and
    /// `FocusController` decides what a session window is.
    public var onOpenSession: ((Int64) -> Void)?

    private let store: ActivityStore

    public init(store: ActivityStore) {
        self.store = store
    }

    // MARK: - Loading

    public func reload(now: Date = Date()) {
        PerfLog.span("focus.studio.reload") { reloadSnapshot(now: now) }
    }

    private func reloadSnapshot(now: Date) {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        let from = range.fromMs
        let to = range.toMs

        let rangeSessions = (try? store.sessions(from: from, to: to)) ?? []
        // A tag names a set of SESSIONS, so filtering by one scopes every view to the work done
        // inside them. Until 2026-09-21 21:30 it only filtered the Sessions list, which made
        // picking a tag look like it did nothing at all on the other three tabs.
        tagScopedSessionIds = tagFilter.map { tag in
            Set(rangeSessions.filter { $0.tag == tag }.map(\.id))
        }
        let taggedSessions = tagFilter == nil ? rangeSessions : rangeSessions.filter { $0.tag == tagFilter }
        // A session filter narrows the window itself, so totals, breakdown and heatmap all
        // describe that one pomodoro rather than the day it happened in.
        let focused = sessionFilter.flatMap { id in rangeSessions.first { $0.id == id } }
        let windowFrom = focused?.startedMs ?? from
        let windowTo = focused.map { $0.endedMs ?? nowMs } ?? to
        let sessions = focused.map { [$0] } ?? rangeSessions

        // The picker describes whole sessions, including phases crossing the range boundary.
        // Read their union once, then scope the visible charts in memory.
        let readFrom = min(from, rangeSessions.map(\.startedMs).min() ?? from)
        let readTo = max(to, rangeSessions.map { $0.endedMs ?? nowMs }.max() ?? to)
        let allSegments = (try? store.segments(from: readFrom, to: readTo)) ?? []
        let input = InputIndex((try? store.inputSeries(from: readFrom, to: readTo)) ?? [])
        let gaps = (try? store.gaps(from: windowFrom, to: windowTo)) ?? []
        let windowSegments = allSegments.filter {
            $0.startedMs < windowTo && ($0.endedMs ?? nowMs) > windowFrom
        }
        let segments = windowSegments.filter(matchesFilters)
        totals = FocusAggregate.totals(segments, from: windowFrom, to: windowTo, now: nowMs)
        appBuckets = FocusAggregate.buckets(segments, from: windowFrom, to: windowTo, now: nowMs,
                                            bundle: { $0.appBundle }) { $0.appName }
        hostBuckets = FocusAggregate.buckets(segments, from: windowFrom, to: windowTo, now: nowMs) { $0.urlHost }
        projectBuckets = FocusAggregate.buckets(segments, from: windowFrom, to: windowTo, now: nowMs) { $0.project }
        heatCells = FocusAggregate.heatmap(segments, from: windowFrom, to: windowTo, now: nowMs)
        // Keystrokes and gaps are stored against wall-clock time, not against a session, so a
        // tag filter has to be applied as a set of time spans or the footer keeps reporting the
        // whole day while every other number is scoped.
        let spans: [(from: Int64, to: Int64)] = tagFilter == nil
            ? [(windowFrom, windowTo)]
            : taggedSessions.compactMap { session in
                let start = max(session.startedMs, windowFrom)
                let end = min(session.endedMs ?? nowMs, windowTo)
                return end > start ? (start, end) : nil
            }
        keys = spans.reduce(0) { $0 + input.keys(from: $1.from, to: $1.to) }

        childBuckets = Dictionary(uniqueKeysWithValues: appBuckets.map { bucket in
            let rows = segments.filter { $0.appName == bucket.key }
            let children = FocusAggregate.buckets(rows, from: windowFrom, to: windowTo, now: nowMs) {
                $0.urlHost ?? $0.windowTitle ?? "untitled window"
            }
            return (bucket.key, Array(children.prefix(8)))
        })

        buildLanes(segments, from: windowFrom, to: windowTo, now: nowMs)
        phaseBands = taggedSessions.flatMap { session -> [PhaseBand] in
            let start = max(session.startedMs, windowFrom)
            let end = min(session.endedMs ?? nowMs, windowTo)
            guard end > start else { return [] }
            return lanePieces(from: start, to: end).map { piece in
                let laneStart = laneWindows[piece.lane]?.from ?? piece.from
                return PhaseBand(sessionId: session.id, laneKey: piece.lane, kind: session.kind,
                                 tag: session.tag, startedMs: piece.from, endedMs: piece.to,
                                 offsetStartMs: piece.from - laneStart,
                                 offsetEndMs: piece.to - laneStart)
            }
        }
        unmeasuredMs = gaps.reduce(Int64(0)) { total, gap in
            let start = max(gap.startedMs, windowFrom)
            let end = min(gap.endedMs ?? nowMs, windowTo)
            return total + spans.reduce(Int64(0)) { inner, span in
                inner + max(0, min(end, span.to) - max(start, span.from))
            }
        }
        gapBars = gaps.flatMap { gap -> [GapBar] in
            let clipped = max(gap.startedMs, windowFrom)
            let clippedEnd = min(gap.endedMs ?? nowMs, windowTo)
            // A gap outside every scoped span belongs to work this filter excluded.
            guard let span = spans.first(where: { clippedEnd > $0.from && clipped < $0.to }) else { return [] }
            let start = max(clipped, span.from)
            let end = min(clippedEnd, span.to)
            guard end - start >= 30_000 else { return [] }
            return lanePieces(from: start, to: end).map { piece in
                let laneStart = laneWindows[piece.lane]?.from ?? piece.from
                return GapBar(gapId: gap.id, laneKey: piece.lane, startedMs: piece.from,
                              endedMs: piece.to, offsetStartMs: piece.from - laneStart,
                              offsetEndMs: piece.to - laneStart, reason: gap.reason)
            }
        }
        let allCards = sessionCardsFor(rangeSessions, segments: allSegments, input: input, now: nowMs)
        let visibleSessionIDs = Set(sessions.filter { tagFilter == nil || $0.tag == tagFilter }.map(\.id))
        if projectFilter == nil && search.isEmpty {
            sessionCards = allCards.filter { visibleSessionIDs.contains($0.id) }
        } else {
            sessionCards = sessionCardsFor(sessions.filter { visibleSessionIDs.contains($0.id) },
                                           segments: segments, input: input, now: nowMs)
        }

        // Resolve icons here rather than inside a row body: the first lookup is disk work.
        AppIconService.shared.preload(appBuckets.map(\.bundleId))

        // Tags come from every session in the RANGE, not from the filtered set, or picking one
        // tag would empty the menu that picked it.
        availableTags = Array(Set(rangeSessions.compactMap(\.tag))).sorted()
        // The tag list always comes from the whole range, never from the filtered set: sourcing
        // it from the filtered sessions would empty the menu that just picked a tag.
        availableProjects = Array(Set(allSegments.compactMap(\.project))).sorted()
        sessionOptions = allCards
        emptiness = segments.isEmpty && !windowSegments.isEmpty
            ? .noMatches
            : resolveEmptiness(segments: segments, from: windowFrom, to: windowTo, now: nowMs)
    }

    /// Minutes in one lane: 60 on a day view, 1440 otherwise. The timeline's x domain.
    public var laneSpanMinutes: Double { range.granularity == .day ? 60 : 1440 }

    /// Session ids carrying the chosen tag, or nil when no tag is chosen. Held rather than
    /// recomputed, because `matchesFilters` runs once per segment.
    private var tagScopedSessionIds: Set<Int64>?

    private func matchesFilters(_ segment: ActivityStore.Segment) -> Bool {
        if let tagScopedSessionIds {
            // Work done outside any pomodoro carries no tag, so it cannot match one.
            guard let sessionId = segment.sessionId, tagScopedSessionIds.contains(sessionId) else { return false }
        }
        if let projectFilter, segment.project != projectFilter { return false }
        if !search.isEmpty {
            let haystack = [segment.appName, segment.windowTitle ?? "", segment.urlHost ?? ""].joined(separator: " ")
            if !haystack.localizedCaseInsensitiveContains(search) { return false }
        }
        return true
    }

    /// Start and end of every lane currently drawn, keyed by lane. Built with the lanes, because
    /// a lane key ("18:00", "2026-09-21") cannot be parsed back into a time range safely.
    private var laneWindows: [String: (from: Int64, to: Int64)] = [:]

    /// Every lane a span crosses, with the span clipped to that lane.
    private func lanePieces(from: Int64, to: Int64) -> [(lane: String, from: Int64, to: Int64)] {
        laneWindows.compactMap { key, window in
            let start = max(from, window.from)
            let end = min(to, window.to)
            guard end > start else { return nil }
            return (key, start, end)
        }
    }

    /// One lane per day in a multi-day range, one per hour when looking at a single day.
    ///
    /// **Every lane spans the full width.** The x axis inside a lane is the offset within that
    /// lane, not the position of the clock in the range, so the 19:00 row reads 19:00 → 20:00
    /// left to right. Drawing lanes on one shared day axis made them a waterfall: each row held
    /// a short block somewhere along an otherwise empty line, and 23 hours of every row were
    /// dead space.
    private func buildLanes(_ segments: [ActivityStore.Segment], from windowFrom: Int64,
                            to windowTo: Int64, now: Int64) {
        var calendar = Calendar.current
        calendar.firstWeekday = 2
        let perHour = range.granularity == .day
        let unit: Calendar.Component = perHour ? .hour : .day
        var windows: [String: (from: Int64, to: Int64)] = [:]

        /// Names the lane containing `ms` and remembers its time window the first time it is seen.
        func note(_ ms: Int64) -> (key: String, to: Int64)? {
            let date = Date(timeIntervalSince1970: Double(ms) / 1000)
            let key = perHour
                ? String(format: "%02d:00", calendar.component(.hour, from: date))
                : FocusFormat.dayKey(date, calendar: calendar)
            if let existing = windows[key] { return (key, existing.to) }
            guard let interval = calendar.dateInterval(of: unit, for: date) else { return nil }
            let window = (from: Int64(interval.start.timeIntervalSince1970 * 1000),
                          to: Int64(interval.end.timeIntervalSince1970 * 1000))
            windows[key] = window
            return (key, window.to)
        }

        // First pass: every lane any segment TOUCHES, so a stretch that runs across a boundary
        // creates the lane on the far side of it too.
        for segment in segments {
            let from = max(segment.startedMs, windowFrom)
            let to = min(segment.endedMs ?? now, windowTo)
            guard to > from else { continue }
            var cursor = from
            while cursor < to {
                guard let step = note(cursor) else { break }
                cursor = step.to
            }
        }
        laneWindows = windows
        lanes = windows.keys.sorted()

        // Second pass: one bar per lane the segment crosses, each clipped to its lane.
        var built: [TimelineBar] = []
        for segment in segments {
            let from = max(segment.startedMs, windowFrom)
            let to = min(segment.endedMs ?? now, windowTo)
            guard to > from else { continue }
            for piece in lanePieces(from: from, to: to) {
                let laneStart = laneWindows[piece.lane]?.from ?? piece.from
                built.append(TimelineBar(
                    segmentId: segment.id,
                    laneKey: piece.lane,
                    startedMs: piece.from,
                    endedMs: piece.to,
                    offsetStartMs: piece.from - laneStart,
                    offsetEndMs: piece.to - laneStart,
                    appName: segment.appName,
                    appBundle: segment.appBundle,
                    detail: segment.urlHost ?? segment.windowTitle ?? segment.appName,
                    idle: segment.idle,
                    sessionId: segment.sessionId))
            }
        }
        bars = built
    }

    private struct InputIndex {
        let times: [Int64]
        let cumulativeKeys: [Int]

        init(_ samples: [ActivityStore.InputSample]) {
            times = samples.map(\.bucketMs)
            var sums = [0]
            sums.reserveCapacity(samples.count + 1)
            for sample in samples { sums.append(sums[sums.count - 1] + sample.counts.keys) }
            cumulativeKeys = sums
        }

        func keys(from: Int64, to: Int64) -> Int {
            guard to > from else { return 0 }
            return cumulativeKeys[lowerBound(to)] - cumulativeKeys[lowerBound(from)]
        }

        private func lowerBound(_ value: Int64) -> Int {
            var lower = 0
            var upper = times.count
            while lower < upper {
                let middle = lower + (upper - lower) / 2
                if times[middle] < value { lower = middle + 1 } else { upper = middle }
            }
            return lower
        }
    }

    private func sessionCardsFor(_ sessions: [ActivityStore.FocusSession],
                                 segments: [ActivityStore.Segment], input: InputIndex,
                                 now: Int64) -> [SessionCard] {
        let bySession = Dictionary(grouping: segments, by: \.sessionId)
        return sessions.reversed().map { session in
            let own = bySession[session.id] ?? []
            let ended = session.endedMs ?? now
            let apps = FocusAggregate.buckets(own, from: session.startedMs, to: ended, now: now,
                                              bundle: { $0.appBundle }) { $0.appName }
            let count = input.keys(from: session.startedMs, to: ended)
            return SessionCard(
                id: session.id,
                kind: session.kind,
                tag: session.tag,
                note: session.note,
                startedMs: session.startedMs,
                actualMs: ended - session.startedMs,
                plannedMs: Int64(session.plannedSec) * 1000,
                interruptions: session.interruptions,
                state: session.state,
                keys: count,
                topApps: Array(apps.prefix(3)))
        }
    }

    /// The difference that matters: an empty day with capture on means nothing happened; an
    /// empty day with capture off means nothing was measured, and saying "no data" for both is
    /// the lie this app does not tell.
    private func resolveEmptiness(segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64) -> Emptiness {
        guard segments.isEmpty else { return .notEmpty }
        let elapsed = min(now, to) - from
        guard elapsed > 0 else { return .nothingRecorded }
        return unmeasuredMs * 2 >= elapsed ? .captureWasOff : .nothingRecorded
    }

    // MARK: - Commands

    public func step(_ delta: Int) {
        range = range.stepped(by: delta)
        reload()
    }

    public func setGranularity(_ granularity: FocusRange.Granularity) {
        let anchor = Date(timeIntervalSince1970: Double(range.fromMs) / 1000)
        range = FocusRange.make(granularity, containing: anchor)
        reload()
    }

    /// The digest the CLI prints, for the copy button — same numbers, same wording.
    public func digestMarkdown() -> String {
        var lines = ["# Focus digest — \(range.label)", ""]
        lines.append("Focused \(FocusFormat.duration(totals.focusedMs)) · idle \(FocusFormat.duration(totals.idleMs)) · "
            + "\(totals.switches) context switches · longest unbroken \(FocusFormat.duration(totals.longestStretchMs))")
        lines.append("Keystrokes \(keys)")
        lines.append("")
        lines.append("## Sessions — \(sessionCards.count)")
        for card in sessionCards {
            let tag = card.tag.map { " #\($0)" } ?? ""
            lines.append("- \(FocusFormat.clockTime(card.startedMs)) \(card.kind)\(tag) \(FocusFormat.duration(card.actualMs))")
        }
        if !appBuckets.isEmpty {
            lines.append("")
            lines.append("## Apps")
            for bucket in appBuckets.prefix(6) {
                lines.append("- \(bucket.key) \(FocusFormat.duration(bucket.ms)) (\(FocusFormat.percent(bucket.share)))")
            }
        }
        return lines.joined(separator: "\n")
    }
}
