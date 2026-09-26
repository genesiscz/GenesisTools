// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionPalette.swift at 2026-09-24T05:05:15+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
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

enum SessionPalette {
    static let backgroundNS = NSColor(srgbRed: 0.075, green: 0.075, blue: 0.08, alpha: 1)
    static let background = Color(nsColor: backgroundNS)
    static let sidebar = Color(nsColor: NSColor(srgbRed: 0.095, green: 0.095, blue: 0.1, alpha: 1))
    /// Cards on the ground: the diff viewer's comment card (#16171a).
    static let card = Color(red: 0.086, green: 0.090, blue: 0.102)
    static let hairline = Color.white.opacity(0.08)
    static let cardBorder = Color.white.opacity(0.10)
    static let fill = Color.white.opacity(0.04)
    static let fillStrong = Color.white.opacity(0.07)

    static let text = Color.white.opacity(0.92)
    static let secondary = Color.white.opacity(0.70)
    static let dim = Color.white.opacity(0.50)
    static let faint = Color.white.opacity(0.32)

    static let green = Color(red: 0.36, green: 0.80, blue: 0.47)
    static let red = Color(red: 0.96, green: 0.38, blue: 0.40)
    static let orange = Color(red: 0.98, green: 0.66, blue: 0.25)
    static let blue = Color(red: 0.45, green: 0.62, blue: 0.98)
    static let purple = Color(red: 0.72, green: 0.56, blue: 0.98)

    static let codeFont = Font.system(size: 11.5, design: .monospaced)

    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// A 6 pt status dot, the review window's file-status marker.
struct SessionStatusDot: View {
    let color: Color
    var size: CGFloat = 6

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: size, height: size)
    }
}

/// A capsule badge with a hairline border: the comment card's "Local" pill.
struct SessionPill: View {
    let text: String
    var color: Color = SessionPalette.secondary

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 10.5, weight: .medium))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 1.5)
            .overlay(Capsule().strokeBorder(color.opacity(0.35), lineWidth: 1))
    }
}

/// A small caps section title with an optional monospaced count on the right.
struct SessionSectionTitle: View {
    let title: String
    var count: Int?

    var body: some View {
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
}

/// One stat: a dim label over a monospaced value. Used in a two-column grid.
struct SessionStatChip: View {
    let label: String
    let value: String
    var color: Color = SessionPalette.text

    var body: some View {
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
enum SessionFormat {
    static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1000 { return String(format: "%.1fK", Double(value) / 1000) }
        return String(value)
    }

    static func usd(_ value: Double) -> String {
        value >= 100 ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
    }

    /// `850ms`, `12s`, `4m 12s`, `2h 05m` (`LiveTimeFormat` holds every time wording).
    static func duration(_ seconds: TimeInterval) -> String {
        LiveTimeFormat.elapsed(seconds)
    }

    /// `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago`. A label that must stay current
    /// is a `LiveTime` instead.
    static func ago(_ seconds: TimeInterval) -> String {
        LiveTimeFormat.ago(seconds)
    }

    static func chars(_ count: Int) -> String {
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

    static func clock(_ date: Date) -> String { clockFormatter.string(from: date) }
    static func shortClock(_ date: Date) -> String { shortClockFormatter.string(from: date) }

    /// Today: `14:32`. Another day: `Sep 23, 14:32`.
    static func moment(_ date: Date, now: Date = Date()) -> String {
        Calendar.current.isDate(date, inSameDayAs: now) ? shortClock(date) : dayFormatter.string(from: date)
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso = ISO8601DateFormatter()

    static func parseISO(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        return isoWithFraction.date(from: value) ?? iso.date(from: value)
    }
}
