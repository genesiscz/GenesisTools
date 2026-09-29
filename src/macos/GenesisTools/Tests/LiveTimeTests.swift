// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/UI/LiveTimeTests.swift at 2026-09-25T22:24:28+02:00 at commit hash 09d2ee1252400c65d735e279aecd931735f57e5f
import AppKit
import SwiftUI
import XCTest
// GenesisTools adaptation: this app's module.
@testable import GenesisTools

/// `LiveTime`: the wording of every relative time, the moments it ticks, and that a tick redraws
/// the label and never the view that holds it.
@MainActor
final class LiveTimeTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_790_000_000)

    // MARK: Wording

    func testEachStyleKeepsItsScreensWording() {
        func text(_ style: LiveTimeStyle, _ seconds: TimeInterval) -> String? {
            LiveTimeFormat.text(style, start, now: start.addingTimeInterval(seconds))
        }
        XCTAssertEqual(text(.ago, 4), "just now")
        XCTAssertEqual(text(.ago, 20), "20s ago")
        XCTAssertEqual(text(.ago, 12 * 60 + 5), "12m ago")
        XCTAssertEqual(text(.ago, 7 * 3600 + 14 * 60), "7h 14m ago")
        XCTAssertEqual(text(.ago, 86400), "1d ago")
        XCTAssertEqual(text(.elapsed, 12), "12s")
        XCTAssertEqual(text(.elapsed, 4 * 60 + 12), "4m 12s")
        XCTAssertEqual(text(.compact, 30), "just now")
        XCTAssertEqual(text(.compact, 2 * 3600 + 5 * 60), "2h 05m")
        XCTAssertEqual(text(.until, -12 * 60), "in 12m")
        XCTAssertNil(text(.until, 5))
        XCTAssertEqual(text(.brief, 30), "now")
        XCTAssertEqual(text(.brief, 14 * 86400), "2w ago")
        XCTAssertEqual(text(.briefCompact, 370 * 86400), "1y")
        XCTAssertEqual(text(.spelled, 60), "now")
        // The old entry points read the same.
        XCTAssertEqual(SessionFormat.ago(20), "20s ago")
        // GenesisTools adaptation: Genesis's Home and chat list entry points are not in this app.
    }

    /// The system's words, as this Mac prints them in English.
    func testSystemWordingStyles() throws {
        try XCTSkipUnless(Locale.current.language.languageCode?.identifier == "en", "the system's words are English here")
        func text(_ style: LiveTimeStyle, _ seconds: TimeInterval) -> String? {
            LiveTimeFormat.text(style, start, now: start.addingTimeInterval(seconds))
        }
        XCTAssertEqual(text(.short, 20), "20 sec. ago")
        XCTAssertEqual(text(.short, 5 * 60), "5 min. ago")
        XCTAssertEqual(text(.short, 2 * 3600), "2 hr. ago")
        XCTAssertEqual(text(.short, 2 * 86400), "2 days ago")
        XCTAssertEqual(text(.spelled, 5 * 60), "5m ago")
        XCTAssertEqual(text(.spelled, 2 * 86400), "2d ago")
        // GenesisTools adaptation: `LiveAgo` keeps the words `HubFormat.ago` printed.
        for seconds: TimeInterval in [20, 5 * 60, 2 * 3600, 2 * 86400] {
            let date = start.addingTimeInterval(-seconds)
            XCTAssertEqual(LiveTimeFormat.text(.short, date, now: start), HubFormat.relative.localizedString(for: date, relativeTo: start))
        }
    }

    // MARK: Ticks

    func testTicksEverySecondUnderAMinuteThenOnTheMinute() {
        func next(_ style: LiveTimeStyle, _ seconds: TimeInterval) -> TimeInterval? {
            LiveTimeFormat.nextChange(style, start, after: start.addingTimeInterval(seconds))?.timeIntervalSince(start)
        }
        // "just now" holds for ten seconds, then each second changes the text.
        XCTAssertEqual(next(.ago, 3), 10)
        XCTAssertEqual(next(.ago, 20.4), 21)
        // Past a minute, only the next whole minute changes it.
        XCTAssertEqual(next(.ago, 150), 180)
        XCTAssertEqual(next(.ago, 3 * 86400 + 10), 3 * 86400 + 3600)
        // A running clock shows seconds for an hour.
        XCTAssertEqual(next(.elapsed, 125.5), 126)
        XCTAssertEqual(next(.compact, 10), 45)
        XCTAssertEqual(next(.brief, 10), 60)
        // The short words show seconds, so they tick each second under a minute, then on the minute.
        XCTAssertEqual(next(.short, 20.4), 21)
        XCTAssertEqual(next(.short, 150), 180)
        // A countdown changes on whole minutes left, and stops once it has passed.
        XCTAssertEqual(next(.until, -150), -120)
        XCTAssertEqual(next(.until, -30), 0)
        XCTAssertNil(next(.until, 1))
    }

    func testScheduleEntriesAreTheChangesInOrder() {
        var entries = LiveTimeSchedule(date: start, style: .ago)
            .entries(from: start.addingTimeInterval(57), mode: .normal)
        let offsets = (0..<5).compactMap { _ in entries.next()?.timeIntervalSince(start) }
        XCTAssertEqual(offsets, [57, 58, 59, 60, 120])
    }

    func testWidthTemplateMakesDigitChangesTheSameWidth() {
        XCTAssertEqual(LiveTimeFormat.widthTemplate("active 12s ago"), LiveTimeFormat.widthTemplate("active 47s ago"))
        XCTAssertNotEqual(LiveTimeFormat.widthTemplate("active 9s ago"), LiveTimeFormat.widthTemplate("active 10s ago"))
    }

    // MARK: Rendering

    /// The label ticks each second on its own; the view that holds it renders once.
    func testALiveLabelTicksWithoutItsParent() throws {
        RenderProbe.enabled = true
        _ = RenderProbe.take()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 80), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Holder(date: Date().addingTimeInterval(-12)))
        // Never visible: alpha 0, below the desktop, ignores the mouse, the app is not activated.
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
            RenderProbe.enabled = false
        }

        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let first = RenderProbe.take()
        XCTAssertEqual(first["holder.body"], 1, "the holder renders once when it appears")

        RunLoop.main.run(until: Date().addingTimeInterval(3.2))
        let later = RenderProbe.take()
        XCTAssertGreaterThanOrEqual(later["liveTime.tick"] ?? 0, 3, "the label must tick about once a second while it reads in seconds")
        XCTAssertNil(later["holder.body"], "a tick must not render the view that holds the label")
    }

    private struct Holder: View {
        let date: Date

        var body: some View {
            let _ = RenderProbe.hit("holder.body")
            HStack {
                Text(verbatim: "Session")
                LiveTime(date: date) { "active \($0)" }
            }
        }
    }
}
