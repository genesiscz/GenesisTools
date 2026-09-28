import AppKit
import SwiftUI
import XCTest
@testable import GenesisTools

/// The title bar strip of a full-size-content window (WindowTitlebar.swift): what a click there does,
/// which clicks reach it, and where a row of controls in it sits. The window tests render into a
/// window nobody sees (alpha 0, below the desktop, never activated), as LiveTimeTests does.
@MainActor
final class WindowTitlebarTests: XCTestCase {
    // MARK: The decision

    func testDoubleClickFollowsTheSystemSetting() {
        XCTAssertEqual(WindowTitlebar.action(clickCount: 2, preference: nil), .zoom)
        XCTAssertEqual(WindowTitlebar.action(clickCount: 2, preference: "Maximize"), .zoom)
        XCTAssertEqual(WindowTitlebar.action(clickCount: 2, preference: "Fill"), .zoom)
        XCTAssertEqual(WindowTitlebar.action(clickCount: 2, preference: "Minimize"), .minimize)
        XCTAssertEqual(WindowTitlebar.action(clickCount: 2, preference: "Miniaturize"), .minimize)
        XCTAssertEqual(WindowTitlebar.action(clickCount: 2, preference: "None"), .none)
    }

    func testASingleClickDragsAndATripleClickDoesNothing() {
        for preference in [nil, "Maximize", "Minimize", "None"] {
            XCTAssertEqual(WindowTitlebar.action(clickCount: 1, preference: preference), .drag)
            XCTAssertEqual(WindowTitlebar.action(clickCount: 3, preference: preference), .none)
        }
    }

    // MARK: The snapshot's audit line

    func testAuditMergesSamplesAndNamesWhatIsWrong() {
        let samples: [(x: CGFloat, kind: WindowTitlebar.Audit.Kind)] = [
            (0, .window), (2, .window), (4, .zone), (6, .zone), (8, .content), (10, .zone),
        ]
        let runs = WindowTitlebar.Audit.runs(samples, step: 2)
        XCTAssertEqual(runs, [
            .init(kind: .window, minX: 0, maxX: 4), .init(kind: .zone, minX: 4, maxX: 8),
            .init(kind: .content, minX: 8, maxX: 10), .init(kind: .zone, minX: 10, maxX: 12),
        ])
        XCTAssertEqual(WindowTitlebar.Audit(stripHeight: 32, leadingReserve: 6, runs: runs).problems, [])
        // A control that starts under the traffic lights or the title.
        XCTAssertEqual(WindowTitlebar.Audit(stripHeight: 32, leadingReserve: 40, runs: runs).problems.count, 1)
        // A view over the whole strip: no double-click can reach the zone.
        let blocked = WindowTitlebar.Audit(stripHeight: 32, leadingReserve: 0, runs: [.init(kind: .content, minX: 0, maxX: 900)])
        XCTAssertEqual(blocked.problems.count, 1)
        XCTAssertTrue(blocked.line.contains("no empty strip reaches the zone"))
        // All window: AppKit's own title bar, nothing to fix. The same strip with a row expected: the row is missing.
        let native = WindowTitlebar.Audit(stripHeight: 28, leadingReserve: 80, runs: [.init(kind: .window, minX: 0, maxX: 900)])
        XCTAssertEqual(native.problems, [])
        var missingRow = WindowTitlebar.Audit(stripHeight: 32, leadingReserve: 80, runs: [.init(kind: .zone, minX: 0, maxX: 900)])
        XCTAssertEqual(missingRow.problems, [])
        missingRow.expectsRow = true
        XCTAssertTrue(missingRow.line.contains("nothing in the strip"), missingRow.line)
    }

    func testTheWidestFlatStretchIsTheBand() {
        typealias Band = WindowTitlebar.Audit.Band
        let sidebar: UInt32 = 0x1818_1AFF
        let content: UInt32 = 0x1313_14FF
        func column(_ height: CGFloat, _ color: UInt32, edge: Bool = false) -> Band.Column {
            Band.Column(height: height, color: color, edge: edge)
        }

        // Sidebar, a divider, then a content column flat for 34 pt: the band starts after the divider.
        let padded = [column(14, sidebar), column(20, sidebar), column(0, sidebar, edge: true),
                      column(40, content), column(34, content), column(36, content)]
        XCTAssertEqual(Band.widest(columns: padded, columnWidth: 8), Band(minX: 24, maxX: 48, height: 34))
        // Where the colour under the strip changes, a region starts too.
        let noDivider = [column(4, sidebar), column(30, content), column(30, content)]
        XCTAssertEqual(Band.widest(columns: noDivider, columnWidth: 8), Band(minX: 8, maxX: 24, height: 30))
        // Text on a row's left, nothing on its right: the flat right part starts beside the text, no band.
        let rowWithText = [column(0, content, edge: true), column(5, content), column(5, content),
                           column(32, content), column(32, content)]
        XCTAssertEqual(Band.widest(columns: rowWithText, columnWidth: 8), nil)
        XCTAssertNil(Band.widest(columns: [column(4, content), column(11, content)], columnWidth: 8))
        // A band counts only under a header meant for the title bar, and only across much of the window.
        var audit = WindowTitlebar.Audit(stripHeight: 32, leadingReserve: 80, runs: [.init(kind: .zone, minX: 0, maxX: 900)],
                                         width: 900, band: Band(minX: 300, maxX: 900, height: 34))
        XCTAssertNil(audit.emptyBand, "an empty state (no header) may leave the area under the strip blank")
        audit.expectsRow = true
        XCTAssertEqual(audit.emptyBand?.height, 34)
        XCTAssertTrue(audit.line.contains("an empty band 34 pt"), audit.line)
        audit.band = Band(minX: 300, maxX: 500, height: 34)
        XCTAssertNil(audit.emptyBand, "a gap narrower than 40% of the window is a gap between buttons")
    }

    /// Every hub mode had its header's first row 34 pt under the title bar: the audit names that band,
    /// and the same header with its row in the title bar has none.
    func testAHeaderPaddedUnderTheStripLeavesABandThatTheAuditNames() {
        let padded = WindowTitlebar.audit(makeWindow(sidebar: 300, padded: true), expectsRow: true)
        let band = padded.emptyBand
        XCTAssertNotNil(band, padded.line)
        XCTAssertGreaterThanOrEqual(band?.height ?? 0, 30, padded.line)
        let moved = WindowTitlebar.audit(makeWindow(sidebar: 300), expectsRow: true)
        XCTAssertNil(moved.emptyBand, moved.line)
        XCTAssertEqual(moved.problems, [], moved.line)
    }

    /// The settings window (App/GenesisToolsApp.swift) has a standard title bar: AppKit's own view takes
    /// the strip's clicks and zooms, so it needs no zone.
    func testAStandardTitleBarIsAppKitsOwn() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 500),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "GenesisTools"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: Color.gray.frame(minWidth: 900, minHeight: 500))
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        windows.append(window)
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        let audit = WindowTitlebar.audit(window)
        XCTAssertGreaterThan(audit.stripHeight, 20, audit.line)
        XCTAssertEqual(Set(audit.runs.map(\.kind)), [.window], audit.line)
        XCTAssertEqual(audit.problems, [], audit.line)
    }

    // MARK: A real window

    private final class Clicks {
        var count = 0
    }

    /// Hub-shaped: a sidebar and a main column whose hub surfaces paint the strip, and a row of controls
    /// moved up into the strip. `sidebar: 0` puts the row's first control under the traffic lights;
    /// `padded` keeps the row under the strip behind a 34 pt padding, as every hub mode had it.
    private struct Root: View {
        let sidebar: CGFloat
        let clicks: Clicks
        var padded = false

        private var row: some View {
            HStack(spacing: 8) {
                Button("Pane") { clicks.count += 1 }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("A pane")
                Spacer()
                IconButton(systemName: "doc.richtext", tooltip: "Copy") {}
            }
            .padding(.horizontal, 14)
        }

        var body: some View {
            HStack(spacing: 0) {
                if sidebar > 0 {
                    VStack {
                        Text("Sessions")
                        Spacer()
                    }
                    .frame(width: sidebar)
                    .hubSurface(.chrome)
                }
                VStack(spacing: 0) {
                    if padded {
                        row.frame(height: 28).padding(.top, 34)
                    } else {
                        row.titlebarRow()
                    }
                    Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
                    Color.clear
                }
                .hubSurface(.content)
            }
        }
    }

    private var windows: [NSWindow] = []

    override func tearDown() {
        for window in windows {
            window.orderOut(nil)
        }
        windows = []
        super.tearDown()
    }

    private func makeWindow(sidebar: CGFloat, clicks: Clicks = Clicks(), padded: Bool = false) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 500),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Agents"
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.contentView = HubGlass.makeContentView(root: Root(sidebar: sidebar, clicks: clicks, padded: padded).titlebarZone())
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        windows.append(window)
        // The zone reports the strip on the next turn of the run loop; the row then moves up.
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        window.contentView?.layoutSubtreeIfNeeded()
        return window
    }

    /// The view a click at `x`, `yFromTop` (window points) lands on.
    private func hit(_ window: NSWindow, x: CGFloat, yFromTop: CGFloat) -> NSView? {
        let frameView = window.contentView!.superview!
        return frameView.hitTest(frameView.convert(NSPoint(x: x, y: window.frame.height - yFromTop), from: nil))
    }

    func testEmptyStripReachesTheZoneAndControlsKeepTheirClicks() {
        let window = makeWindow(sidebar: 300)
        let strip = WindowTitlebar.stripHeight(of: window)
        XCTAssertGreaterThan(strip, 20, "a full-size-content window has a title bar strip")
        let audit = WindowTitlebar.audit(window)
        XCTAssertEqual(audit.problems, [], audit.line)
        // Over the sidebar and in the row's empty middle: the zone.
        XCTAssertTrue(hit(window, x: 200, yFromTop: strip / 2) is TitlebarZoneView, audit.line)
        XCTAssertTrue(hit(window, x: 600, yFromTop: strip / 2) is TitlebarZoneView, audit.line)
        // The row's controls are in the strip and keep their clicks.
        let controls = audit.runs.filter { $0.kind == .content }
        XCTAssertEqual(controls.count, 2, audit.line)
        XCTAssertGreaterThanOrEqual(controls.first?.minX ?? 0, 300, audit.line)
        // Below the strip nothing reaches the zone.
        XCTAssertFalse(hit(window, x: 600, yFromTop: strip + 40) is TitlebarZoneView)
        XCTAssertFalse(hit(window, x: 150, yFromTop: strip + 40) is TitlebarZoneView)
    }

    func testARowThatStartsUnderTheTrafficLightsMovesRight() throws {
        let window = makeWindow(sidebar: 0)
        let zoom = try XCTUnwrap(window.standardWindowButton(.zoomButton))
        let audit = WindowTitlebar.audit(window)
        // The reserve covers the traffic lights and the title after them.
        XCTAssertGreaterThan(audit.leadingReserve, zoom.convert(zoom.bounds, to: nil).maxX + WindowTitlebar.reserveGap, audit.line)
        XCTAssertEqual(audit.problems, [], audit.line)
        let first = try XCTUnwrap(audit.runs.first { $0.kind == .content }, audit.line)
        XCTAssertGreaterThanOrEqual(first.minX, audit.leadingReserve - WindowTitlebar.Audit.reserveSlack, audit.line)
    }

    private func withDoubleClickPreference(_ value: String, _ body: () throws -> Void) rethrows {
        let defaults = UserDefaults.standard
        let saved = defaults.volatileDomain(forName: UserDefaults.argumentDomain)
        var domain = saved
        domain[WindowTitlebar.preferenceKey] = value
        defaults.setVolatileDomain(domain, forName: UserDefaults.argumentDomain)
        defer { defaults.setVolatileDomain(saved, forName: UserDefaults.argumentDomain) }
        try body()
    }

    /// A down and an up at `x`, `yFromTop`. The up waits in the queue first: a control that tracks
    /// the mouse inside its mouse-down reads it from there.
    private func click(_ window: NSWindow, x: CGFloat, yFromTop: CGFloat, count: Int) {
        let location = NSPoint(x: x, y: window.frame.height - yFromTop)
        func event(_ type: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(
                with: type, location: location, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: count, pressure: 1
            )!
        }
        NSApp.postEvent(event(.leftMouseDown), atStart: false)
        NSApp.postEvent(event(.leftMouseUp), atStart: false)
        let deadline = Date().addingTimeInterval(0.6)
        while Date() < deadline {
            if let next = NSApp.nextEvent(matching: .any, until: deadline, inMode: .default, dequeue: true) {
                NSApp.sendEvent(next)
            }
        }
    }

    func testDoubleClickOnTheEmptyStripZoomsAsTheSettingSays() {
        let window = makeWindow(sidebar: 300)
        let start = window.frame
        let strip = WindowTitlebar.stripHeight(of: window)
        withDoubleClickPreference("None") {
            click(window, x: 600, yFromTop: strip / 2, count: 2)
            XCTAssertEqual(window.frame, start, "None: a double-click does nothing")
        }
        withDoubleClickPreference("Maximize") {
            click(window, x: 600, yFromTop: strip / 2, count: 2)
            XCTAssertTrue(window.isZoomed, "Maximize: the double-click zooms, frame \(window.frame)")
            // Again: back to the size it had.
            click(window, x: 600, yFromTop: WindowTitlebar.stripHeight(of: window) / 2, count: 2)
            XCTAssertEqual(window.frame.size, start.size)
        }
    }

    /// Chrome the zone does not cover (Genesis's markdown tab bar) calls the same action directly.
    func testADoubleClickOnOtherChromeFollowsTheSettingToo() {
        let window = makeWindow(sidebar: 300)
        let start = window.frame
        withDoubleClickPreference("None") {
            WindowTitlebar.performDoubleClick(on: window)
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            XCTAssertEqual(window.frame, start)
        }
        withDoubleClickPreference("Maximize") {
            WindowTitlebar.performDoubleClick(on: window)
            RunLoop.main.run(until: Date().addingTimeInterval(0.5))
            XCTAssertTrue(window.isZoomed, "frame \(window.frame)")
        }
    }

    func testDoubleClickOnAControlInTheStripDoesNotZoom() throws {
        let clicks = Clicks()
        let window = makeWindow(sidebar: 300, clicks: clicks)
        let audit = WindowTitlebar.audit(window)
        let button = try XCTUnwrap(audit.runs.first { $0.kind == .content }, audit.line)
        let start = window.frame
        withDoubleClickPreference("Maximize") {
            click(window, x: (button.minX + button.maxX) / 2, yFromTop: audit.stripHeight / 2, count: 1)
            click(window, x: (button.minX + button.maxX) / 2, yFromTop: audit.stripHeight / 2, count: 2)
        }
        XCTAssertEqual(window.frame, start, "the control took the double-click, the window did not zoom")
        XCTAssertGreaterThan(clicks.count, 0, "the button in the strip got its click")
    }
}
