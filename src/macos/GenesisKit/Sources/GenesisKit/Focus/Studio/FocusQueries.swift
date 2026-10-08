// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Studio/FocusQueries.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation

/// Spec 22 (S6) §10.8 — the aggregation the Studio draws and the CLI prints.
///
/// Pure functions over rows, so the same numbers can be asserted in a test without a window,
/// and so no view body ever runs a query. The rules match `apps/cli/lib/activityDb.ts`
/// deliberately: idle never counts as focus, and idle breaks a stretch rather than creating a
/// context switch.
public enum FocusAggregate {
    public struct Bucket: Identifiable, Equatable {
        public let key: String
        public let ms: Int64
        public let share: Double
        public let visits: Int
        /// Carried so a row can draw the app's real icon. Nil for sites and projects.
        public let bundleId: String?
        public var id: String { key }

        public init(key: String, ms: Int64, share: Double, visits: Int, bundleId: String? = nil) {
            self.key = key
            self.ms = ms
            self.share = share
            self.visits = visits
            self.bundleId = bundleId
        }
    }

    public struct Totals: Equatable {
        public var focusedMs: Int64 = 0
        public var idleMs: Int64 = 0
        public var switches: Int = 0
        public var longestStretchMs: Int64 = 0
    }

    /// Duration of a segment clipped into a range; an open segment is clipped at `now`.
    public static func span(_ segment: ActivityStore.Segment, from: Int64, to: Int64, now: Int64) -> Int64 {
        let start = max(segment.startedMs, from)
        let end = min(segment.endedMs ?? now, to)
        return max(0, end - start)
    }

    public static func totals(_ segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64) -> Totals {
        var totals = Totals()
        var previousApp: String?
        for segment in segments {
            let ms = span(segment, from: from, to: to, now: now)
            if segment.idle {
                totals.idleMs += ms
                previousApp = nil
                continue
            }
            totals.focusedMs += ms
            totals.longestStretchMs = max(totals.longestStretchMs, ms)
            if let previous = previousApp, previous != segment.appBundle { totals.switches += 1 }
            previousApp = segment.appBundle
        }
        return totals
    }

    /// `bundle` is optional because only app buckets have an icon to draw; sites and projects
    /// pass nil and render with the fallback glyph.
    public static func buckets(_ segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64,
                        bundle: ((ActivityStore.Segment) -> String?)? = nil,
                        key: (ActivityStore.Segment) -> String?) -> [Bucket] {
        var totals: [String: (ms: Int64, visits: Int, bundleId: String?)] = [:]
        var previous: String?
        for segment in segments where !segment.idle {
            guard let name = key(segment) else { continue }
            let ms = span(segment, from: from, to: to, now: now)
            guard ms > 0 else { continue }
            var entry = totals[name] ?? (0, 0, bundle?(segment))
            entry.ms += ms
            if previous != name { entry.visits += 1 }
            if entry.bundleId == nil { entry.bundleId = bundle?(segment) }
            totals[name] = entry
            previous = name
        }
        let sum = totals.values.reduce(Int64(0)) { $0 + $1.ms }
        return totals
            .map { Bucket(key: $0.key, ms: $0.value.ms, share: sum > 0 ? Double($0.value.ms) / Double(sum) : 0,
                          visits: $0.value.visits, bundleId: $0.value.bundleId) }
            .sorted { $0.ms > $1.ms }
    }

    /// Focused minutes per (weekday, hour) cell, for the heatmap. Clipped to the range like
    /// `totals` and `buckets`, so the heatmap never shows more focus than the footer.
    public static func heatmap(_ segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64,
                        calendar: Calendar = .current) -> [HeatCell] {
        var cells: [HeatKey: Int64] = [:]
        for segment in segments where !segment.idle {
            let ms = span(segment, from: from, to: to, now: now)
            guard ms > 0 else { continue }
            let start = Date(timeIntervalSince1970: Double(max(segment.startedMs, from)) / 1000)
            // Attribute to the hour the segment started in. Splitting across hour boundaries
            // would be more exact and would also make a 25-minute flow unreadable as one block.
            let hour = calendar.component(.hour, from: start)
            let weekday = calendar.component(.weekday, from: start)
            let key = HeatKey(weekday: weekday, hour: hour)
            cells[key, default: 0] += ms
        }
        return cells.map { HeatCell(weekday: $0.key.weekday, hour: $0.key.hour, ms: $0.value) }
    }

    public struct HeatKey: Hashable { public let weekday: Int; public let hour: Int }

    public struct HeatCell: Identifiable, Equatable {
        public let weekday: Int
        public let hour: Int
        public let ms: Int64
        public var id: String { "\(weekday)-\(hour)" }
    }
}

// MARK: - Formatting

public enum FocusFormat {
    /// "1h 30m" / "45m" / "20s" — the same shape the CLI prints, so a screenshot and a terminal
    /// never disagree about the same range.
    public static func duration(_ ms: Int64) -> String {
        if ms < 60_000 { return "\(max(0, ms / 1000))s" }
        let minutes = Int((Double(ms) / 60_000).rounded())
        let hours = minutes / 60
        return hours == 0 ? "\(minutes)m" : "\(hours)h \(String(format: "%02d", minutes % 60))m"
    }

    public static func percent(_ share: Double) -> String { "\(Int((share * 100).rounded()))%" }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = .autoupdatingCurrent
        formatter.timeZone = .autoupdatingCurrent
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    public static func clockTime(_ ms: Int64) -> String {
        clockFormatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }

    public static func dayKey(_ date: Date, calendar: Calendar = .current) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }
}

// MARK: - Ranges

public struct FocusRange: Equatable {
    public enum Granularity: String, CaseIterable, Identifiable {
        case day = "D", week = "W", month = "M", year = "Y"
        public var id: String { rawValue }
    }

    public var fromMs: Int64
    public var toMs: Int64
    public var granularity: Granularity
    public var label: String

    public static func make(_ granularity: Granularity, containing date: Date = Date(),
                     calendar: Calendar = .current) -> FocusRange {
        var calendar = calendar
        calendar.firstWeekday = 2 // Monday, like the rest of this program
        let component: Calendar.Component = switch granularity {
        case .day: .day
        case .week: .weekOfYear
        case .month: .month
        case .year: .year
        }
        guard let interval = calendar.dateInterval(of: component, for: date) else {
            let start = calendar.startOfDay(for: date)
            return FocusRange(fromMs: ms(start), toMs: ms(start.addingTimeInterval(86_400)),
                              granularity: granularity, label: FocusFormat.dayKey(start))
        }
        return FocusRange(fromMs: ms(interval.start), toMs: ms(interval.end), granularity: granularity,
                          label: label(for: granularity, start: interval.start, end: interval.end))
    }

    public func stepped(by delta: Int, calendar: Calendar = .current) -> FocusRange {
        let anchor = Date(timeIntervalSince1970: Double(fromMs) / 1000)
        let component: Calendar.Component = switch granularity {
        case .day: .day
        case .week: .weekOfYear
        case .month: .month
        case .year: .year
        }
        let moved = calendar.date(byAdding: component, value: delta, to: anchor) ?? anchor
        return FocusRange.make(granularity, containing: moved, calendar: calendar)
    }

    private static func ms(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1000) }

    private static func label(for granularity: Granularity, start: Date, end: Date) -> String {
        switch granularity {
        case .day: return FocusFormat.dayKey(start)
        case .week: return "\(FocusFormat.dayKey(start)) → \(FocusFormat.dayKey(end.addingTimeInterval(-1)))"
        case .month:
            let formatter = DateFormatter()
            formatter.dateFormat = "LLLL yyyy"
            return formatter.string(from: start)
        case .year:
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyy"
            return formatter.string(from: start)
        }
    }
}

// MARK: - Day summary (menu-bar popover)

public struct FocusDaySummary: Equatable {
    public var focusedMs: Int64
    public var sessionsDone: Int
    public var switches: Int
    public var topApps: [ActivityRecorder.AppShare]

    public static let empty = FocusDaySummary(focusedMs: 0, sessionsDone: 0, switches: 0, topApps: [])

    public static func today(store: ActivityStore, now: Date = Date()) -> FocusDaySummary {
        let range = FocusRange.make(.day, containing: now)
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        guard let segments = try? store.segments(from: range.fromMs, to: range.toMs),
              let sessions = try? store.sessions(from: range.fromMs, to: range.toMs)
        else { return .empty }

        let totals = FocusAggregate.totals(segments, from: range.fromMs, to: range.toMs, now: nowMs)
        let apps = FocusAggregate.buckets(segments, from: range.fromMs, to: range.toMs, now: nowMs,
                                          bundle: { $0.appBundle }) { $0.appName }
        return FocusDaySummary(
            focusedMs: totals.focusedMs,
            sessionsDone: sessions.filter { $0.state == ActivityStore.SessionState.done.rawValue }.count,
            switches: totals.switches,
            topApps: apps.prefix(3).map {
                ActivityRecorder.AppShare(appName: $0.key, bundleId: $0.bundleId, ms: $0.ms, share: $0.share)
            })
    }
}
