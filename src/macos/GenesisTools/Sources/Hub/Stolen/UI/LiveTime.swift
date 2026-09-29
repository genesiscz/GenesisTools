// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/UI/LiveTime.swift at 2026-09-25T22:22:02+02:00 at commit hash 09d2ee1252400c65d735e279aecd931735f57e5f
//
//  LiveTime.swift
//  Genesis
//
//  A time label that keeps itself current ("active 20s ago", "4m 12s", "in 12m") and nothing
//  else does. Its clock is its own `TimelineView`, so a tick redraws this label only: no model,
//  parent or `@State` above it holds a `now`. `LiveTimeFormat` is the one formatter behind every
//  relative time in the app; each style keeps the wording its screen had before it went live.
//
//  Portable: Foundation and SwiftUI only (GenesisTools.app copies it with the Sessions views).
//

import Foundation
import SwiftUI

/// How a live time reads.
enum LiveTimeStyle: Sendable, Equatable {
    /// `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago` (Session Details).
    case ago
    /// `12s`, `4m 12s`, `2h 05m` since the date: a turn that is still running.
    case elapsed
    /// `just now`, `4m`, `2h 05m`, `3d` (Home rows).
    case compact
    /// `in 12m`, `in 2h 05m`, and nothing once the date has passed (Home).
    case until
    /// `now`, `5m ago`, `2h ago`, `3d ago`, `2w ago` (chat lists, the web's `timeAgo`).
    case brief
    /// `now`, `5m`, `2h`, `3d`, `2w`, `1y` (the chat sidebar's age column).
    case briefCompact
    /// `now` under a minute and a half, then the system's abbreviated words: `5m ago`, `2h ago`,
    /// `2d ago`.
    case spelled
    /// The system's short words: `20 sec. ago`, `5 min. ago`, `2 hr. ago`, `2 days ago` (the
    /// GenesisTools hub's lists).
    case short
}

/// A label that shows `date` in `style` and updates itself: every second while the text shows
/// seconds, then on the minute the text changes. `format` wraps the time (`{ "active \($0)" }`).
///
/// The width comes from a hidden copy of the text with every digit a zero, and the digits are
/// tabular, so a tick that changes only digits changes no size: the views around the label are
/// not laid out again. Only a new digit or unit (9s to 10s, 59s to 1m) resizes it.
struct LiveTime: View {
    let date: Date
    var style: LiveTimeStyle = .ago
    var alignment: Alignment = .leading
    var format: (String) -> String = { $0 }

    var body: some View {
        TimelineView(LiveTimeSchedule(date: date, style: style)) { context in
            let _ = RenderProbe.hit("liveTime.tick")
            let text = format(LiveTimeFormat.text(style, date, now: context.date) ?? "")
            Text(verbatim: LiveTimeFormat.widthTemplate(text))
                .hidden()
                .overlay(alignment: alignment) {
                    Text(verbatim: text)
                }
                .monospacedDigit()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: text))
        }
    }
}

/// The moments `LiveTime`'s text can change, and no others.
struct LiveTimeSchedule: TimelineSchedule {
    let date: Date
    let style: LiveTimeStyle

    func entries(from start: Date, mode: TimelineScheduleMode) -> Entries {
        Entries(date: date, style: style, upcoming: start)
    }

    struct Entries: Sequence, IteratorProtocol {
        let date: Date
        let style: LiveTimeStyle
        var upcoming: Date?

        mutating func next() -> Date? {
            guard let current = upcoming else { return nil }
            upcoming = LiveTimeFormat.nextChange(style, date, after: current)
            return current
        }
    }
}

/// The wording of every relative time, and when it next changes.
enum LiveTimeFormat {
    /// `date` in `style` as seen at `now`; nil for `until` once the date has passed.
    static func text(_ style: LiveTimeStyle, _ date: Date, now: Date) -> String? {
        let age = now.timeIntervalSince(date)
        switch style {
        case .ago: return ago(age)
        case .elapsed: return elapsed(age)
        case .compact: return compact(age)
        case .until: return until(-age)
        case .brief: return brief(age)
        case .briefCompact: return briefCompact(age)
        case .spelled: return spelled(date, now: now)
        case .short: return shortFormatter.localizedString(for: date, relativeTo: now)
        }
    }

    /// The first moment after `now` when `text` can read differently; nil when it never will.
    static func nextChange(_ style: LiveTimeStyle, _ date: Date, after now: Date) -> Date? {
        let age = now.timeIntervalSince(date)
        // The next whole `unit` of age, strictly after now.
        func next(_ unit: TimeInterval) -> Date {
            date.addingTimeInterval(((age / unit).rounded(.down) + 1) * unit)
        }
        // Minutes for two days, then hours: the coarser units print no minutes.
        func coarse() -> Date {
            age < 2 * 86400 ? next(60) : next(3600)
        }
        switch style {
        case .ago:
            if age < 10 { return date.addingTimeInterval(10) }
            return age < 60 ? next(1) : coarse()
        case .elapsed:
            return age < 3600 ? next(1) : next(60)
        case .compact:
            return age < 45 ? date.addingTimeInterval(45) : coarse()
        case .until:
            let left = -age
            guard left > 0 else { return nil }
            return date.addingTimeInterval(-((left / 60).rounded(.up) - 1) * 60)
        case .brief, .briefCompact:
            return age < 60 ? date.addingTimeInterval(60) : coarse()
        case .spelled:
            if age < 90 { return date.addingTimeInterval(90) }
            return coarse()
        case .short:
            return age < 60 ? next(1) : coarse()
        }
    }

    /// `text` with every digit a zero: as wide as `text` in tabular digits.
    static func widthTemplate(_ text: String) -> String {
        String(text.map { $0.isNumber ? "0" : $0 })
    }

    // MARK: Wordings

    /// `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago`.
    static func ago(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        if total < 10 { return "just now" }
        if total < 60 { return "\(total)s ago" }
        if total < 3600 { return "\(total / 60)m ago" }
        if total < 86400 {
            let minutes = (total % 3600) / 60
            return minutes == 0 ? "\(total / 3600)h ago" : "\(total / 3600)h \(minutes)m ago"
        }
        return "\(total / 86400)d ago"
    }

    /// `850ms`, `12s`, `4m 12s`, `2h 05m`.
    static func elapsed(_ seconds: TimeInterval) -> String {
        if seconds < 1 { return "\(Int((max(0, seconds) * 1000).rounded()))ms" }
        let total = Int(seconds.rounded())
        if total < 60 { return "\(total)s" }
        if total < 3600 { return "\(total / 60)m \(String(format: "%02d", total % 60))s" }
        return "\(total / 3600)h \(String(format: "%02d", (total % 3600) / 60))m"
    }

    /// `just now`, `4m`, `2h 05m`, `3d`.
    static func compact(_ seconds: TimeInterval) -> String {
        let seconds = max(0, seconds)
        if seconds < 45 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 {
            let minutes = Int(seconds.truncatingRemainder(dividingBy: 3600) / 60)
            return "\(Int(seconds / 3600))h \(String(format: "%02d", minutes))m"
        }
        return "\(Int(seconds / 86400))d"
    }

    /// `in 12m`, `in 2h 05m`; nil when `seconds` (time left) is not positive.
    static func until(_ seconds: TimeInterval) -> String? {
        guard seconds > 0 else { return nil }
        if seconds < 3600 { return "in \(max(1, Int(seconds / 60)))m" }
        let minutes = Int(seconds.truncatingRemainder(dividingBy: 3600) / 60)
        return "in \(Int(seconds / 3600))h \(String(format: "%02d", minutes))m"
    }

    /// `now`, `5m ago`, `2h ago`, `3d ago`, `2w ago`.
    static func brief(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "now" }
        let m = s / 60
        if m < 60 { return "\(m)m ago" }
        let h = m / 60
        if h < 24 { return "\(h)h ago" }
        let d = h / 24
        if d < 7 { return "\(d)d ago" }
        return "\(d / 7)w ago"
    }

    /// `now`, `5m`, `2h`, `3d`, `2w`, `1y`.
    static func briefCompact(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "now" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        let d = h / 24
        if d < 7 { return "\(d)d" }
        if d < 365 { return "\(d / 7)w" }
        return "\(d / 365)y"
    }

    /// `now` under a minute and a half, then `5m ago`, `2h ago`, `2d ago`.
    static func spelled(_ date: Date, now: Date) -> String {
        if now.timeIntervalSince(date) < 90 { return "now" }
        return spelledFormatter.localizedString(for: date, relativeTo: now)
    }

    // Built once: a `RelativeDateTimeFormatter` is not cheap, and labels ask per tick.
    private static let spelledFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()

    private static let shortFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()
}
