import XCTest
@testable import GenesisKit

final class TitleFormatterTests: XCTestCase {
    func testFormatMTokThreePointOneMillion() {
        XCTAssertEqual(TitleFormatter.formatMTok(3_100_000), "3.10 MTok")
    }

    func testFormatCtxCompact() {
        XCTAssertEqual(TitleFormatter.formatCtx(0), "0 ctx")
        XCTAssertEqual(TitleFormatter.formatCtx(12_400), "12k ctx")
        XCTAssertEqual(TitleFormatter.formatCtx(3_100_000), "3.10M ctx")
    }

    func testFormatCostTwoFractionDigits() {
        XCTAssertEqual(TitleFormatter.formatCost(12.3), "$12.30")
    }

    func testQuotaAndSpendExactDryRunString() {
        let title = TitleFormatter.title(
            mode: .quotaAndSpend,
            alias: "LF",
            fiveHourLeftPct: 82,
            todayCost: 12.3,
            todayTokens: 3_100_000,
            weekCost: nil,
            monthCost: nil,
            timeRemaining: nil
        )
        XCTAssertEqual(title, "LF 82% · $12.30 · 3.10 MTok")
    }

    func testFormatTimeRemainingNinetyFiveMinutes() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let until = now.addingTimeInterval(95 * 60)
        XCTAssertEqual(
            TitleFormatter.formatTimeRemaining(until: until, now: now, template: "{h}h{m}m"),
            "1h35m"
        )
    }

    func testTodayUsageJoinsCostAndTokens() {
        let title = TitleFormatter.title(
            mode: .todayUsage,
            alias: nil,
            fiveHourLeftPct: nil,
            todayCost: 12.3,
            todayTokens: 3_100_000,
            weekCost: nil,
            monthCost: nil,
            timeRemaining: nil
        )
        XCTAssertEqual(title, "$12.30 · 3.10 MTok")
    }

    func testRaycastCostTokenAndPercentModes() {
        func title(_ mode: MenuBarTitleMode, seven: Double? = nil) -> String? {
            TitleFormatter.title(
                mode: mode,
                alias: "LE",
                fiveHourLeftPct: 82,
                todayCost: 12.3,
                todayTokens: 3_100_000,
                weekCost: 40.5,
                monthCost: 99.1,
                timeRemaining: nil,
                sevenDayLeftPct: seven
            )
        }
        XCTAssertEqual(title(.todayCost), "$12.30")
        XCTAssertEqual(title(.weeklyCost), "$40.50")
        XCTAssertEqual(title(.monthlyCost), "$99.10")
        XCTAssertEqual(title(.todayTokens), "3.10 MTok")
        XCTAssertEqual(title(.fiveHour), "82%")
        XCTAssertEqual(title(.sevenDay, seven: 61), "61%")
        XCTAssertEqual(title(.utilization, seven: 40), "40%")
        XCTAssertNil(title(.none))
    }

    func testTimeRemainingAppendsToCoreTitle() {
        let title = TitleFormatter.title(
            mode: .todayCost,
            alias: nil,
            fiveHourLeftPct: nil,
            todayCost: 12.3,
            todayTokens: nil,
            weekCost: nil,
            monthCost: nil,
            timeRemaining: "1h35m"
        )
        XCTAssertEqual(title, "$12.30 · 1h35m")
    }

    func testNoneWithOnlyTimeRemainingUsesTheCountdown() {
        let title = TitleFormatter.title(
            mode: .none,
            alias: nil,
            fiveHourLeftPct: nil,
            todayCost: nil,
            todayTokens: nil,
            weekCost: nil,
            monthCost: nil,
            timeRemaining: "1h35m"
        )
        XCTAssertEqual(title, "1h35m")
    }

    func testQuotaAndSpendNilWhenPiecesMissing() {
        let title = TitleFormatter.title(
            mode: .quotaAndSpend,
            alias: "LF",
            fiveHourLeftPct: 82,
            todayCost: 12.3,
            todayTokens: nil,
            weekCost: nil,
            monthCost: nil,
            timeRemaining: nil
        )
        XCTAssertNil(title)
    }

    func testLapsedTimeRemainingIsEmpty() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let until = now.addingTimeInterval(-60)
        XCTAssertEqual(
            TitleFormatter.formatTimeRemaining(until: until, now: now, template: "{h}h{m}m"),
            ""
        )
    }

    func testTimeRemainingFractionalAndTotalMinutes() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let until = now.addingTimeInterval(95 * 60)
        XCTAssertEqual(
            TitleFormatter.formatTimeRemaining(until: until, now: now, template: "{M}m"),
            "95m"
        )
        XCTAssertEqual(
            TitleFormatter.formatTimeRemaining(until: until, now: now, template: "{h.f}h"),
            "1.58h"
        )
    }

    func testCatalogHasNoBlockProjection() {
        XCTAssertFalse(MenuBarTitleMode.allCases.map(\.rawValue).contains("blockProjection"))
        XCTAssertEqual(
            MenuBarTitleMode.allCases.map(\.rawValue),
            [
                "quotaAndSpend",
                "todayUsage",
                "todayCost",
                "weeklyCost",
                "monthlyCost",
                "todayTokens",
                "fiveHour",
                "sevenDay",
                "utilization",
                "none",
            ]
        )
    }

    /// Regression: slash-command XML leaked into session titles and banners.
    func testCleanSessionTitleTurnsCommandNameIntoSlashCommand() {
        let raw = """
        <command-message>
        <command-name>speckit.implement</command-name>
        <command-args>the login screen</command-args>
        </command-message>
        """
        XCTAssertEqual(TitleFormatter.cleanSessionTitle(raw), "/speckit.implement the login screen")
    }

    /// Regression: a cold-session banner read `1f8fe45d · /clear`, which named the harness
    /// rather than the session. A command with no arguments is dropped now.
    func testCleanSessionTitleDropsArgumentLessCommands() {
        let raw = """
        <command-name>/clear</command-name>
        <command-message>clear</command-message>
        <command-args></command-args>
        """
        XCTAssertNil(TitleFormatter.cleanSessionTitle(raw))
        XCTAssertNil(TitleFormatter.cleanSessionTitle("<command-name>/compact</command-name>"))
    }

    func testSlashInvocationsPairEachCommandWithItsOwnArguments() {
        let raw = """
        <command-name>/clear</command-name><command-args></command-args>
        <command-name>/rename</command-name><command-args>board-polish</command-args>
        """
        XCTAssertEqual(
            TitleFormatter.slashInvocations(in: raw),
            [
                TitleFormatter.SlashInvocation(name: "/clear", args: ""),
                TitleFormatter.SlashInvocation(name: "/rename", args: "board-polish"),
            ]
        )
    }

    func testCleanSessionTitleStripsImagePlaceholders() {
        XCTAssertEqual(
            TitleFormatter.cleanSessionTitle("[Image #1] fix the login"),
            "fix the login"
        )
        XCTAssertEqual(
            TitleFormatter.cleanSessionTitle("[Image #12]\n[Image #3] ship it"),
            "ship it"
        )
    }

    func testCleanSessionTitleKeepsPlainText() {
        XCTAssertEqual(TitleFormatter.cleanSessionTitle("fix the auth callback"), "fix the auth callback")
    }

    func testCleanSessionTitleNilWhenOnlyMarkup() {
        XCTAssertNil(TitleFormatter.cleanSessionTitle("   "))
        XCTAssertNil(TitleFormatter.cleanSessionTitle(Optional<String>.none))
        XCTAssertNil(TitleFormatter.cleanSessionTitle("<command-args></command-args>"))
    }

}

extension TitleFormatterTests {
    /// 6b.15 - the provider chip strip appended to the menu-bar title.
    func testProviderChipsRenderGlyphAndValue() {
        let chips = [
            TitleFormatter.ProviderChip(glyph: "C", value: "41%"),
            TitleFormatter.ProviderChip(glyph: "X", value: "12%"),
            TitleFormatter.ProviderChip(glyph: "G", value: "$3"),
        ]

        XCTAssertEqual(TitleFormatter.providerChips(chips), "C 41% · X 12% · G $3")
        XCTAssertNil(TitleFormatter.providerChips([]))
    }

    /// Menu-bar money drops cents it does not need, and keeps the ones it does.
    func testFormatCostCompactDropsWholeCents() {
        XCTAssertEqual(TitleFormatter.formatCostCompact(3), "$3")
        XCTAssertEqual(TitleFormatter.formatCostCompact(3.004), "$3")
        XCTAssertEqual(TitleFormatter.formatCostCompact(3.25), "$3.25")
        XCTAssertEqual(TitleFormatter.formatCostCompact(0), "$0")
    }

    /// PR #80 t20: the value comes from a cache file. `usedMinor: 1e22` is valid JSON, is
    /// integral after scaling, and used to trap in `Int(_:)`; so did an infinity.
    func testFormatCostCompactSurvivesValuesPastIntMax() {
        XCTAssertEqual(TitleFormatter.formatCostCompact(1e20), "$100000000000000000000")
        XCTAssertFalse(TitleFormatter.formatCostCompact(.infinity).isEmpty)
        XCTAssertFalse(TitleFormatter.formatCostCompact(-.infinity).isEmpty)
        XCTAssertFalse(TitleFormatter.formatCostCompact(.nan).isEmpty)
    }

}
