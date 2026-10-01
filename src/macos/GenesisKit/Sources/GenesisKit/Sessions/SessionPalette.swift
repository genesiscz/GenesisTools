//
//  SessionPalette.swift
//  Genesis
//
//  Tokens and small shared pieces for the Session Details window (header, transcript, sidebar).
//  The look follows the GenesisTools review window (`ReviewPalette` in
//  GenesisTools/src/macos/GenesisTools/Sources/Review/ReviewWindow.swift): near-black ground,
//  hairlines at white 8%, status dots, monospaced counters, 10 pt cards, SF system fonts.
//
//  Portable: this file needs SwiftUI and AppKit only, so GenesisTools.app can copy it as is.
//

import AppKit
import SwiftUI

public enum SessionPalette {
    public static let backgroundNS = NSColor(srgbRed: 0.075, green: 0.075, blue: 0.08, alpha: 1)
    public static let background = Color(nsColor: backgroundNS)
    public static let sidebar = Color(nsColor: NSColor(srgbRed: 0.095, green: 0.095, blue: 0.1, alpha: 1))
    /// Cards on the ground: the diff viewer's comment card (#16171a).
    public static let card = Color(red: 0.086, green: 0.090, blue: 0.102)
    public static let hairline = Color.white.opacity(0.08)
    public static let cardBorder = Color.white.opacity(0.10)
    public static let fill = Color.white.opacity(0.04)
    public static let fillStrong = Color.white.opacity(0.07)

    public static let text = Color.white.opacity(0.92)
    public static let secondary = Color.white.opacity(0.70)
    public static let dim = Color.white.opacity(0.50)
    public static let faint = Color.white.opacity(0.32)

    public static let green = Color(red: 0.36, green: 0.80, blue: 0.47)
    public static let red = Color(red: 0.96, green: 0.38, blue: 0.40)
    public static let orange = Color(red: 0.98, green: 0.66, blue: 0.25)
    public static let blue = Color(red: 0.45, green: 0.62, blue: 0.98)
    public static let purple = Color(red: 0.72, green: 0.56, blue: 0.98)

    public static let codeFont = Font.system(size: 11.5, design: .monospaced)

    public static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// A 6 pt status dot, the review window's file-status marker.
public struct SessionStatusDot: View {
    public let color: Color
    public var size: CGFloat = 6

    public var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
    }

    public init(
        color: Color,
        size: CGFloat = 6
    ) {
        self.color = color
        self.size = size
    }
}

/// A capsule badge with a hairline border: the comment card's "Local" pill.
public struct SessionPill: View {
    public let text: String
    public var color: Color = SessionPalette.secondary

    public var body: some View {
        Text(verbatim: text)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 1.5)
            .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
    }

    public init(
        text: String,
        color: Color = SessionPalette.secondary
    ) {
        self.text = text
        self.color = color
    }
}

/// A small caps section title with an optional monospaced count on the right.
public struct SessionSectionTitle: View {
    public let title: String
    public var count: Int?

    public var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: title.uppercased())
                .font(.system(size: 10.5, weight: .semibold))
                .tracking(0.6)
                .foregroundStyle(SessionPalette.dim)
            if let count {
                Text(verbatim: "\(count)")
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
            }
            Spacer(minLength: 0)
        }
    }

    public init(
        title: String,
        count: Int? = nil
    ) {
        self.title = title
        self.count = count
    }
}

/// One stat: a dim label over a monospaced value. Used in a two-column grid.
public struct SessionStatChip: View {
    public let label: String
    public let value: String
    public var color: Color = SessionPalette.text

    public init(label: String, value: String, color: Color = SessionPalette.text) {
        self.label = label
        self.value = value
        self.color = color
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: label)
                .font(.system(size: 10.5))
                .foregroundStyle(SessionPalette.dim)
            Text(verbatim: value)
                .font(SessionPalette.mono(12.5, weight: .medium))
                .foregroundStyle(color)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(SessionPalette.fill))
    }
}

/// Number formats shared by the header, the sidebar and the transcript.
public enum SessionFormat {
    public static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1000 { return String(format: "%.1fK", Double(value) / 1000) }
        return String(value)
    }

    public static func usd(_ value: Double) -> String {
        value >= 100 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
    }

    /// `850ms`, `12s`, `4m 12s`, `2h 05m` (`LiveTimeFormat` holds every time wording).
    public static func duration(_ seconds: TimeInterval) -> String {
        LiveTimeFormat.elapsed(seconds)
    }

    /// `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago`. A label that must stay current
    /// is a `LiveTime` instead.
    public static func ago(_ seconds: TimeInterval) -> String {
        LiveTimeFormat.ago(seconds)
    }

    public static func chars(_ count: Int) -> String {
        count >= 1000 ? String(format: "%.1fK chars", Double(count) / 1000) : "\(count) chars"
    }

    private static let clockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        // Fixed-format formatter: pin the locale (QA1480).
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    private static let shortClockFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d, HH:mm"
        return formatter
    }()

    public static func clock(_ date: Date) -> String { clockFormatter.string(from: date) }
    /// Every transcript row carries one, and the chat rebuilds all of them each 90 ms tick while a
    /// reply streams: the formatter was a quarter of `ChatTranscript.build` (sampled 2026-09-26).
    /// Rows share minutes, and every zone offset is whole minutes, so each minute is formatted once.
    public static func shortClock(_ date: Date) -> String {
        let minute = Int((date.timeIntervalSinceReferenceDate / 60).rounded(.down))
        shortClockLock.lock()
        if let hit = shortClockMemo[minute] {
            shortClockLock.unlock()
            return hit
        }
        shortClockLock.unlock()
        let text = shortClockFormatter.string(from: date)
        shortClockLock.lock()
        if shortClockMemo.count >= 4096 {
            shortClockMemo.removeAll(keepingCapacity: true)
        }
        shortClockMemo[minute] = text
        shortClockLock.unlock()
        return text
    }

    private static let shortClockLock = NSLock()
    private nonisolated(unsafe) static var shortClockMemo: [Int: String] = [:]

    /// Today: `14:32`. Another day: `Sep 23, 14:32`.
    public static func moment(_ date: Date, now: Date = Date()) -> String {
        Calendar.current.isDate(date, inSameDayAs: now) ? shortClock(date) : dayFormatter.string(from: date)
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso = ISO8601DateFormatter()

    public static func parseISO(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return isoWithFraction.date(from: value) ?? iso.date(from: value)
    }
}
