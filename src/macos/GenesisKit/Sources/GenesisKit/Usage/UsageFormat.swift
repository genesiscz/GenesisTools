import Foundation
import SwiftUI

/// How the usage views write numbers: one English locale (a Czech Mac wrote "3,21 %"), whole percents, rates with one
/// decimal, dollars with grouping only above a thousand.
public enum UsageFormat {
    private static let locale = Locale(identifier: "en_US_POSIX")

    public static func percent(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return "\(Int(value.rounded()))%"
    }

    /// "3.1%/h".
    public static func rate(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        return String(format: "%.1f%%/h", locale: locale, value)
    }

    /// "$0.42", "$12.30", "$1,501".
    public static func usd(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        if abs(value) >= 1000 {
            let formatter = NumberFormatter()
            // POSIX has no grouping separator: "$1501".
            formatter.locale = Locale(identifier: "en_US")
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 0
            return "$" + (formatter.string(from: NSNumber(value: value.rounded())) ?? String(Int(value.rounded())))
        }
        return String(format: "$%.2f", locale: locale, value)
    }

    /// "830", "12.4K", "6.7M", "1.2B".
    public static func tokens(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        let magnitude = abs(value)
        let (scaled, suffix): (Double, String) = magnitude >= 1e9 ? (value / 1e9, "B")
            : magnitude >= 1e6 ? (value / 1e6, "M") : magnitude >= 1e3 ? (value / 1e3, "K") : (value, "")
        if suffix.isEmpty { return String(Int(value.rounded())) }
        return String(format: abs(scaled) >= 100 ? "%.0f%@" : "%.1f%@", locale: locale, scaled, suffix)
    }

    /// "2d 4h", "1h 32m", "12m", "now": how long until `date`.
    public static func countdown(to date: Date?, now: Date = Date()) -> String {
        guard let date else { return "—" }
        return duration(date.timeIntervalSince(now))
    }

    public static func duration(_ seconds: TimeInterval) -> String {
        let minutes = Int((seconds / 60).rounded())
        if minutes <= 0 { return "now" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 48 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m" }
        return hours % 24 == 0 ? "\(hours / 24)d" : "\(hours / 24)d \(hours % 24)h"
    }

    private static let clockToday: DateFormatter = formatter("HH:mm")
    private static let clockWeek: DateFormatter = formatter("EEE HH:mm")
    private static let dayMonth: DateFormatter = formatter("d MMM")

    private static func formatter(_ format: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_GB")
        formatter.dateFormat = format
        return formatter
    }

    /// "16:20" today, "Tue 16:20" another day: a reset or a run-out time.
    public static func clock(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "—" }
        return Calendar.current.isDate(date, inSameDayAs: now) ? clockToday.string(from: date) : clockWeek.string(from: date)
    }

    public static func day(_ date: Date?) -> String {
        guard let date else { return "—" }
        return dayMonth.string(from: date)
    }

    /// The short name of a window for a column or a lane: "5h", "Week", "Fable", or the CLI's label.
    public static func windowName(kind: String?, label: String, scopeModel: String? = nil) -> String {
        if let scopeModel, !scopeModel.isEmpty { return scopeModel }
        switch kind {
        case "session": return "5h"
        case "weekly": return "Week"
        case "monthly": return "Month"
        default: return label
        }
    }

    /// A project folder as the CLI prints it (`-Users-x-Projects-Repo`) to its last part.
    public static func project(_ value: String) -> String {
        let trimmed = value.hasPrefix("-") ? String(value.split(separator: "-").last ?? Substring(value)) : value
        return (trimmed as NSString).lastPathComponent
    }
}

/// The colours of a reading's severity and of a poll outcome. One table, so a lane, a table cell and the coverage
/// strip agree.
public enum UsageTone {
    public static func severity(_ severity: String?) -> Color {
        switch severity {
        case "critical": return Color(red: 0.94, green: 0.36, blue: 0.36)
        case "warning", "warn", "high": return Color(red: 0.96, green: 0.62, blue: 0.27)
        default: return Color(red: 0.36, green: 0.82, blue: 0.62)
        }
    }

    /// The severity a percent reads as when the CLI sent none: 90 and up critical, 75 and up warning.
    public static func severity(forPercent value: Double) -> String {
        value >= 90 ? "critical" : value >= 75 ? "warning" : "ok"
    }

    /// Green measured, grey not measured, orange stale, red blocked or failed, purple held back by the poll gate.
    public static func outcome(_ outcome: String) -> Color {
        switch outcome {
        case "ok": return Color(red: 0.36, green: 0.82, blue: 0.62)
        case "stale": return Color(red: 0.96, green: 0.62, blue: 0.27)
        case "blocked", "error", "needs-login": return Color(red: 0.94, green: 0.36, blue: 0.36)
        case "backoff": return Color(red: 0.66, green: 0.5, blue: 0.95)
        default: return Color.white.opacity(0.18)
        }
    }

    public static func outcomeTitle(_ outcome: String) -> String {
        switch outcome {
        case "ok": return "measured"
        case "stale": return "stale reading"
        case "blocked": return "blocked by the organization"
        case "error": return "poll failed"
        case "needs-login": return "needs a login"
        case "backoff": return "held back by the poll gate"
        case "unmeasured": return "not measured"
        default: return outcome
        }
    }

    /// Rate limits and blocks red, cooldowns and pauses orange, probes blue.
    public static func event(_ kind: String) -> Color {
        switch kind {
        case "usage-429", "rate-limited", "org-blocked": return Color(red: 0.94, green: 0.36, blue: 0.36)
        case "cooldown", "poll-backoff": return Color(red: 0.96, green: 0.62, blue: 0.27)
        default: return Color(red: 0.45, green: 0.66, blue: 0.98)
        }
    }

    public static func alertLevel(_ level: String) -> Color {
        switch level {
        case "critical": return severity("critical")
        case "warning": return severity("warning")
        default: return Color(red: 0.45, green: 0.66, blue: 0.98)
        }
    }
}
