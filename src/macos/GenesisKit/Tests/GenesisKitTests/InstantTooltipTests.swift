import AppKit
import SwiftUI
import XCTest
// Moved from GenesisAIMonitorKit on 2026-09-30 with the tooltip it tests.
@testable import GenesisKit

/// The presenter is a singleton that reuses one panel, gates every hide behind
/// an ownership token and runs a watchdog timer. None of that was covered.
///
/// The two behaviours worth pinning are the ones the comments in the source
/// call out as bug fixes: a dying row must not be able to hide a newer row's
/// bubble (the UUID token), and the bubble must come down when its anchor stops
/// being hoverable without a `mouseExited` — a closed window or a scrolled row.
@MainActor
final class InstantTooltipTests: XCTestCase {
    private var windows: [NSWindow] = []
    private var owners: [UUID] = []

    override func setUp() {
        super.setUp()
        // These tests drive the presenter directly; the pointer is wherever the person left it.
        TooltipGuard.checksPointerCover = false
    }

    override func tearDown() {
        TooltipGuard.checksPointerCover = true
        for owner in owners {
            TooltipPresenter.shared.hide(owner: owner)
        }

        owners.removeAll()

        for window in windows {
            window.orderOut(nil)
        }

        windows.removeAll()
        super.tearDown()
    }

    /// A visible borderless window with an anchor view inside it. The window has
    /// to be on screen: the watchdog checks `window.isVisible` and `visibleRect`.
    private func makeAnchor(at origin: CGPoint) -> NSView {
        let window = NSWindow(
            contentRect: CGRect(origin: origin, size: CGSize(width: 200, height: 120)),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.orderFront(nil)
        windows.append(window)

        let anchor = NSView(frame: CGRect(x: 10, y: 10, width: 80, height: 24))
        window.contentView?.addSubview(anchor)
        window.contentView?.layoutSubtreeIfNeeded()

        return anchor
    }

    private func defaultAnchor() -> NSView {
        let visible = NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1000, height: 800)
        return makeAnchor(at: CGPoint(x: visible.midX, y: visible.midY))
    }

    @discardableResult
    private func show(_ text: String = "tooltip", on anchor: NSView) -> UUID {
        let owner = UUID()
        owners.append(owner)
        TooltipPresenter.shared.show(owner: owner, text: text, anchorView: anchor, below: true)
        return owner
    }

    private func screenRect(of view: NSView) -> CGRect {
        guard let window = view.window else { return .zero }
        return window.convertToScreen(view.convert(view.bounds, to: nil))
    }

    func testShowPutsThePanelOnScreenAndTakesOwnership() {
        let owner = show(on: defaultAnchor())

        XCTAssertEqual(TooltipPresenter.shared.currentOwner, owner)
        XCTAssertEqual(TooltipPresenter.shared.panel?.isVisible, true)
        XCTAssertNotNil(TooltipPresenter.shared.watchdog)
    }

    /// The regression the UUID token exists for: a row that goes away later must
    /// not tear down the bubble a newer row has already claimed.
    func testStaleOwnerCannotHideALiveTooltip() {
        let stale = UUID()
        let live = show(on: defaultAnchor())

        TooltipPresenter.shared.hide(owner: stale)

        XCTAssertEqual(TooltipPresenter.shared.currentOwner, live)
        XCTAssertEqual(TooltipPresenter.shared.panel?.isVisible, true)
    }

    func testMatchingOwnerHidesAndTearsDownTheWatchdog() {
        let owner = show(on: defaultAnchor())

        TooltipPresenter.shared.hide(owner: owner)

        XCTAssertNil(TooltipPresenter.shared.currentOwner)
        XCTAssertNil(TooltipPresenter.shared.watchdog)
        XCTAssertEqual(TooltipPresenter.shared.panel?.isVisible, false)
    }

    /// One panel for the whole app: a second show must not leak another NSPanel.
    func testPanelIsReusedAcrossConsecutiveShows() {
        show(on: defaultAnchor())
        let first = TooltipPresenter.shared.panel

        show("second", on: defaultAnchor())
        let second = TooltipPresenter.shared.panel

        XCTAssertNotNil(first)
        XCTAssertTrue(first === second)
    }

    func testEmptyTextIsIgnored() {
        show("", on: defaultAnchor())

        XCTAssertNil(TooltipPresenter.shared.currentOwner)
    }

    func testAnchorWithoutAWindowIsIgnored() {
        let orphan = NSView(frame: CGRect(x: 0, y: 0, width: 80, height: 24))

        show(on: orphan)

        XCTAssertNil(TooltipPresenter.shared.currentOwner)
    }

    /// `mouseExited` never fires when the anchor's window closes under the
    /// pointer, which is the case that left a bubble hanging mid-screen.
    func testWatchdogDismissesWhenTheAnchorWindowCloses() {
        let anchor = defaultAnchor()
        show(on: anchor)

        anchor.window?.orderOut(nil)
        TooltipPresenter.shared.watchdogTick()

        XCTAssertNil(TooltipPresenter.shared.currentOwner)
        XCTAssertEqual(TooltipPresenter.shared.panel?.isVisible, false)
    }

    /// The other no-`mouseExited` case: the row scrolled out from under a
    /// stationary cursor, so the anchor moved away from where we anchored.
    func testWatchdogDismissesWhenTheAnchorMovesAway() {
        let anchor = defaultAnchor()
        show(on: anchor)

        anchor.frame = anchor.frame.offsetBy(dx: 0, dy: 40)
        TooltipPresenter.shared.watchdogTick()

        XCTAssertNil(TooltipPresenter.shared.currentOwner)
    }

    func testWatchdogStopsItselfWhenNothingIsShown() {
        let owner = show(on: defaultAnchor())
        TooltipPresenter.shared.hide(owner: owner)

        TooltipPresenter.shared.watchdogTick()

        XCTAssertNil(TooltipPresenter.shared.watchdog)
    }

    /// Negative control for the three dismiss paths above: an anchor that is
    /// still live, still where it was, and still under the pointer must KEEP the
    /// bubble. Without this a watchdog that hides unconditionally would pass
    /// every other test here.
    func testWatchdogKeepsALiveTooltipUnderThePointer() throws {
        let mouse = NSEvent.mouseLocation
        // Anchor sits at (10, 10) in a 200x120 window, so this origin centres it
        // on the pointer.
        let anchor = makeAnchor(at: CGPoint(x: mouse.x - 50, y: mouse.y - 22))
        show(on: anchor)

        let rect = screenRect(of: anchor).insetBy(dx: -3, dy: -3)
        try XCTSkipUnless(
            rect.contains(NSEvent.mouseLocation),
            "pointer is not over the test anchor (window placement clamped, or the mouse moved)"
        )

        TooltipPresenter.shared.watchdogTick()

        XCTAssertNotNil(TooltipPresenter.shared.currentOwner)
        XCTAssertEqual(TooltipPresenter.shared.panel?.isVisible, true)
    }
    /// A row and a badge inside it. Returns (row, badge) in one window.
    private func makeNestedAnchors() -> (outer: NSView, inner: NSView) {
        let outer = defaultAnchor()
        outer.frame = CGRect(x: 10, y: 10, width: 180, height: 60)
        let inner = NSView(frame: CGRect(x: 20, y: 20, width: 40, height: 20))
        outer.addSubview(inner)
        outer.window?.contentView?.layoutSubtreeIfNeeded()
        return (outer, inner)
    }

    /// Both sensors see `mouseEntered` when the pointer lands on a badge inside
    /// a row. The row firing second must not replace the badge's own text.
    func testEnclosingAnchorDoesNotReplaceANestedTooltip() {
        let (outer, inner) = makeNestedAnchors()
        let badge = show("badge", on: inner)

        show("row", on: outer)

        XCTAssertEqual(TooltipPresenter.shared.currentOwner, badge)
    }

    /// The other order: the row showed first, then the pointer reached the
    /// badge, whose tooltip takes over.
    func testNestedAnchorReplacesTheEnclosingTooltip() {
        let (outer, inner) = makeNestedAnchors()
        show("row", on: outer)

        let badge = show("badge", on: inner)

        XCTAssertEqual(TooltipPresenter.shared.currentOwner, badge)
    }

    /// Long text wraps inside the width cap instead of running off the screen.
    func testLongTextWrapsWithinTheWidthCap() throws {
        show("short", on: defaultAnchor())
        let oneLine = try XCTUnwrap(TooltipPresenter.shared.panel?.frame)

        show(String(repeating: "a long tooltip sentence ", count: 12), on: defaultAnchor())
        let wrapped = try XCTUnwrap(TooltipPresenter.shared.panel?.frame)

        XCTAssertLessThanOrEqual(wrapped.width, TooltipPresenter.maxBubbleWidth + 0.5)
        XCTAssertGreaterThan(wrapped.height, oneLine.height * 2)
    }

    /// Long bullets wrap inside the cap too, with the title above them.
    func testTitledBulletsWrapWithinTheWidthCap() throws {
        let owner = UUID()
        owners.append(owner)
        let long = String(repeating: "a reason that keeps going ", count: 6)
        let content = TooltipContent(title: "Blocked", bullets: [long, "CI is still running"])
        TooltipPresenter.shared.show(owner: owner, content: content, anchorView: defaultAnchor(), below: true)
        let frame = try XCTUnwrap(TooltipPresenter.shared.panel?.frame)

        XCTAssertLessThanOrEqual(frame.width, TooltipPresenter.maxBubbleWidth + 0.5)
        XCTAssertGreaterThan(frame.height, 60)
    }

    func testPlainTextReadsAsTitleParagraphsAndBullets() {
        XCTAssertEqual(TooltipContent("one line"), TooltipContent(lines: [.text("one line")]))
        XCTAssertEqual(
            TooltipContent("Blocked\n• It is a draft\n• CI is still running\nDetails on the forge"),
            TooltipContent(title: "Blocked", lines: [.bullet("It is a draft"), .bullet("CI is still running"), .text("Details on the forge")])
        )
        // A list with no title line stays a list.
        XCTAssertEqual(TooltipContent("• a\n• b"), TooltipContent(lines: [.bullet("a"), .bullet("b")]))
        // Monospaced text is shown as it is: no title, no bullets.
        XCTAssertEqual(TooltipContent("git push\n• x", monospaced: true), TooltipContent(lines: [.text("git push\n• x")], monospaced: true))
        XCTAssertTrue(TooltipContent("").isEmpty)
    }
}
