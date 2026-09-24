// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/TitleFormatter.swift at 2026-09-24T03:59:28+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
import Foundation

extension TitleFormatter {
    /// `1h32m`, `32m`, `2d4h`; nil when the date is past or missing.
    public static func formatShortCountdown(until: Date?, now: Date = Date()) -> String? {
        guard let until else { return nil }
        let seconds = until.timeIntervalSince(now)
        guard seconds > 0 else { return nil }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 {
            let rest = minutes % 60
            return rest == 0 ? "\(hours)h" : "\(hours)h\(rest)m"
        }
        let days = hours / 24
        let restHours = hours % 24
        return restHours == 0 ? "\(days)d" : "\(days)d\(restHours)h"
    }
}

/// Menu-bar title catalog. Matches Raycast `MenuBarTitleMode` plus our
/// `quotaAndSpend` default. `blockProjection` is deliberately absent (needs
/// ccusage blocks parsing).
public enum MenuBarTitleMode: String, CaseIterable, Equatable, Sendable {
    case quotaAndSpend
    case todayUsage, todayCost, weeklyCost, monthlyCost, todayTokens
    case fiveHour, sevenDay, utilization, none
}

public enum TitleFormatter {
    public static func formatCost(_ value: Double) -> String {
        formatMoney(value, currency: "USD", fractionDigits: 2)
    }

    /// Money in its own currency: `$3.00`, `€3.00`, `¥300`. The ISO 4217 code picks the
    /// symbol and, unless `fractionDigits` overrides it, the currency's usual decimals.
    /// An empty code is read as USD, the only currency the cache wrote before it had one.
    public static func formatMoney(
        _ value: Double,
        currency: String,
        fractionDigits: Int? = nil,
        grouping: Bool = true
    ) -> String {
        let code = currency.isEmpty ? "USD" : currency.uppercased()
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .currency
        f.currencyCode = code
        if code == "USD" { f.currencySymbol = "$" }
        f.usesGroupingSeparator = grouping
        if let fractionDigits {
            f.minimumFractionDigits = fractionDigits
            f.maximumFractionDigits = fractionDigits
        }
        return f.string(from: NSNumber(value: value)) ?? "\(code) \(value)"
    }

    /// Menu-bar money: `$3` rather than `$3.00`, because the strip pays for every character.
    /// Anything with real cents keeps them. Never converts to `Int`: the value comes from a
    /// cache file, and `Int(_: Double)` traps on an infinity or anything past `Int.max`.
    public static func formatCostCompact(_ value: Double, currency: String = "USD") -> String {
        let rounded = (value * 100).rounded() / 100
        let whole = rounded.isFinite && rounded == rounded.rounded()
        return formatMoney(rounded, currency: currency, fractionDigits: whole ? 0 : nil, grouping: false)
    }

    /// One provider's contribution to the title strip: a glyph and a value.
    public struct ProviderChip: Equatable, Sendable {
        public var glyph: String
        public var value: String

        public init(glyph: String, value: String) {
            self.glyph = glyph
            self.value = value
        }
    }

    /// `C 41% · X 12% · G $3`. nil when nothing is visible, so the caller appends nothing.
    public static func providerChips(_ chips: [ProviderChip]) -> String? {
        guard !chips.isEmpty else { return nil }
        return chips.map { "\($0.glyph) \($0.value)" }.joined(separator: " · ")
    }

    public static func formatMTok(_ tokens: Int) -> String {
        String(format: "%.2f MTok", Double(tokens) / 1_000_000.0)
    }

    /// Compact context window size for session rows (`12k ctx`, `3.1M ctx`).
    public static func formatCtx(_ tokens: Int) -> String {
        if tokens < 1000 { return "\(tokens) ctx" }
        if tokens < 1_000_000 {
            let k = Double(tokens) / 1000.0
            return String(format: k >= 10 ? "%.0fk ctx" : "%.1fk ctx", k)
        }
        return String(format: "%.2fM ctx", Double(tokens) / 1_000_000.0)
    }

    /// Expand `{h}` / `{m}` (and Raycast's `{M}` / `{h.f}`) until `until`.
    /// Empty string when the window has already lapsed.
    public static func formatTimeRemaining(until: Date, now: Date, template: String) -> String {
        let diff = until.timeIntervalSince(now)
        guard diff > 0 else { return "" }

        let totalMinutes = Int((diff / 60.0).rounded())
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        let fractionalHours = String(format: "%.2f", Double(totalMinutes) / 60.0)

        // `{h.f}` before `{h}` so the shorter token cannot eat the longer one.
        return template
            .replacingOccurrences(of: "{h.f}", with: fractionalHours)
            .replacingOccurrences(of: "{M}", with: String(totalMinutes))
            .replacingOccurrences(of: "{h}", with: String(hours))
            .replacingOccurrences(of: "{m}", with: String(minutes))
    }

    /// `fiveHourLeftPct` / `sevenDayLeftPct` are leftover (headroom) percents.
    /// `utilization` shows the smallest leftover, i.e. the most depleted window.
    public static func title(
        mode: MenuBarTitleMode,
        alias: String?,
        fiveHourLeftPct: Double?,
        todayCost: Double?,
        todayTokens: Int?,
        weekCost: Double?,
        monthCost: Double?,
        timeRemaining: String?,
        sevenDayLeftPct: Double? = nil
    ) -> String? {
        let core: String?
        switch mode {
        case .none:
            core = nil
        case .quotaAndSpend:
            if let alias, let pct = fiveHourLeftPct, let cost = todayCost, let tokens = todayTokens {
                core = "\(alias) \(Int(pct))% · \(formatCost(cost)) · \(formatMTok(tokens))"
            } else {
                core = nil
            }
        case .todayUsage:
            if let cost = todayCost, let tokens = todayTokens {
                core = "\(formatCost(cost)) · \(formatMTok(tokens))"
            } else {
                core = nil
            }
        case .todayCost:
            core = todayCost.map(formatCost)
        case .weeklyCost:
            core = weekCost.map(formatCost)
        case .monthlyCost:
            core = monthCost.map(formatCost)
        case .todayTokens:
            core = todayTokens.map(formatMTok)
        case .fiveHour:
            core = fiveHourLeftPct.map { "\(Int($0))%" }
        case .sevenDay:
            core = sevenDayLeftPct.map { "\(Int($0))%" }
        case .utilization:
            let parts = [fiveHourLeftPct, sevenDayLeftPct].compactMap { $0 }
            core = parts.min().map { "\(Int($0))%" }
        }

        let extra = timeRemaining.flatMap { $0.isEmpty ? nil : $0 }
        switch (core, extra) {
        case (nil, nil): return nil
        case (let text?, nil): return text
        case (nil, let text?): return text
        case (let text?, let suffix?): return "\(text) · \(suffix)"
        }
    }

    /// One slash-command invocation: the name, plus the arguments the user typed after it.
    public struct SlashInvocation: Equatable, Sendable {
        public var name: String
        public var args: String

        public init(name: String, args: String) {
            self.name = name
            self.args = args
        }
    }

    /// Every `<command-name>` in the text, paired with the `<command-args>` that follows it.
    ///
    /// The arguments are read from the span between this command name and the next one, so a
    /// turn carrying several invocations keeps each one's arguments with the right command.
    public static func slashInvocations(in text: String) -> [SlashInvocation] {
        guard let nameRegex = try? NSRegularExpression(
            pattern: #"<command-name>\s*([^<]+?)\s*</command-name>"#,
            options: .caseInsensitive
        ) else { return [] }

        let ns = text as NSString
        let matches = nameRegex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length))
        let argsRegex = try? NSRegularExpression(
            pattern: #"<command-args>([\s\S]*?)</command-args>"#,
            options: .caseInsensitive
        )

        var invocations: [SlashInvocation] = []
        for (index, match) in matches.enumerated() where match.numberOfRanges >= 2 {
            let name = ns.substring(with: match.range(at: 1))
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }

            let from = match.range.location + match.range.length
            let to = index + 1 < matches.count ? matches[index + 1].range.location : ns.length
            var args = ""
            if let argsRegex, to > from,
               let argsMatch = argsRegex.firstMatch(
                   in: text,
                   options: [],
                   range: NSRange(location: from, length: to - from)
               ),
               argsMatch.numberOfRanges >= 2 {
                args = ns.substring(with: argsMatch.range(at: 1))
                    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }

            invocations.append(SlashInvocation(name: name.hasPrefix("/") ? name : "/\(name)", args: args))
        }

        return invocations
    }

    /// Session titles as the user typed them: drop harness XML and image placeholders.
    ///
    /// A slash command the user typed no arguments for (`/clear`, `/compact`, `/model`) is
    /// dropped rather than named. It carries none of the user's own words, so a row or a
    /// notification reading `1f8fe45d · /clear` said nothing about the session; the caller
    /// falls through to the next candidate instead.
    public static func cleanSessionTitle(_ raw: String?) -> String? {
        guard var text = raw else { return nil }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }

        text = text.replacingOccurrences(
            of: #"\[Image #\d+\]"#,
            with: " ",
            options: .regularExpression
        )

        let commands = slashInvocations(in: text)

        let noiseTags = [
            "local-command-caveat",
            "local-command-stdout",
            "system-reminder",
            "command-name",
            "command-message",
            "command-args",
        ]
        for tag in noiseTags {
            text = text.replacingOccurrences(
                of: "<\(tag)>[\\s\\S]*?</\(tag)>",
                with: " ",
                options: [.regularExpression, .caseInsensitive]
            )
        }

        text = text.replacingOccurrences(
            of: #"</?[A-Za-z][\w-]*[^>]*>"#,
            with: " ",
            options: .regularExpression
        )
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        if text.isEmpty {
            let joined = commands
                .filter { !$0.args.isEmpty }
                .map { "\($0.name) \($0.args)" }
                .joined(separator: " ")
            return joined.isEmpty ? nil : joined
        }
        return text
    }
}
