import AppKit
import GenesisKitFixtures
import XCTest
@testable import GenesisKit

@MainActor
final class RecordingPickerTests: XCTestCase {
    private let front = RecordingWindow(id: 11, pid: 41, app: "Canvas", title: "Page",
                                        bounds: .init(x: 5, y: 5, width: 50, height: 50))
    private let back = RecordingWindow(id: 12, pid: 41, app: "Canvas", title: "Page",
                                       bounds: .init(x: 0, y: 0, width: 100, height: 100))
    private let display = RecordingDisplay(index: 0, name: "Main", isPrimary: true, width: 900, height: 700)
    private let side = RecordingDisplay(index: 1, name: "Side", isPrimary: false, width: 700, height: 500)

    func testTheRecordableRuleMatchesTheCLIContract() throws {
        struct Contract: Decodable {
            struct Rect: Decodable { let x, y, width, height: Double }
            struct Case: Decodable {
                let name: String
                let window: RecordableWindow.Facts
                let reason: RecordableWindow.Reason?
            }
            let displays: [Rect]
            let cases: [Case]
        }
        let contract = try JSONDecoder().decode(Contract.self, from: KitFixture.data("contract-recordable-windows.json", in: "Recording"))
        XCTAssertGreaterThanOrEqual(contract.cases.count, 20)
        let displays = contract.displays.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
        for item in contract.cases {
            XCTAssertEqual(RecordableWindow.reason(item.window, displays: displays), item.reason, item.name)
        }
    }

    func testAClickOnADimmedWindowPicksTheWindowNotTheDimmer() {
        let display = CGRect(x: 0, y: 0, width: 1440, height: 900)
        func row(_ id: UInt32, pid: Int32, app: String, title: String?, frame: CGRect, alpha: Double = 1,
                 layer: Int = 0, sharing: Int = 1) -> [String: Any] {
            var row: [String: Any] = [kCGWindowNumber as String: id, kCGWindowOwnerPID as String: pid,
                                      kCGWindowOwnerName as String: app, kCGWindowLayer as String: layer,
                                      kCGWindowAlpha as String: alpha, kCGWindowSharingState as String: sharing,
                                      kCGWindowBounds as String: frame.dictionaryRepresentation]
            row[kCGWindowName as String] = title
            return row
        }
        // Front to back: the active window, a palette, the dimmer under it, a dimmed window, the picker's own panel.
        let rows = [
            row(1, pid: 10, app: "Editor", title: "Active", frame: CGRect(x: 600, y: 100, width: 700, height: 500)),
            row(2, pid: 10, app: "Editor", title: "Colors", frame: CGRect(x: 40, y: 40, width: 200, height: 260), layer: 3),
            row(3, pid: 20, app: "Dimmer", title: nil, frame: display, alpha: 0.63),
            row(4, pid: 30, app: "Notes", title: "Dimmed", frame: CGRect(x: 20, y: 20, width: 500, height: 400)),
            row(5, pid: 40, app: "GenesisTools", title: "Pick", frame: display, sharing: 0),
        ]
        let kinds: [Int32: RecordableWindow.OwnerKind] = [10: .regular, 20: .accessory, 30: .regular, 40: .accessory]
        let offered = RecordableWindow.offered(rows: rows, displays: [display]) { kinds[$0] ?? .none }
        XCTAssertEqual(offered.map(\.id), [1, 4])
        XCTAssertEqual(WindowClickPicker.window(at: CGPoint(x: 100, y: 100), in: offered, excluding: [])?.title, "Dimmed")
        XCTAssertNil(WindowClickPicker.window(at: CGPoint(x: 1400, y: 880), in: offered, excluding: []),
                     "the dimmer alone under the pointer offers nothing")
    }

    func testTheDisplaysTabOffersFollowDisplayFirstWhenTheEngineCanFollow() {
        let targets = RecordingTargets(windows: [], apps: [], displays: [display, side])
        let offered = RecordingPickerRow.rows(targets, tab: .displays, query: "", offersFollow: true)
        XCTAssertEqual(offered.map(\.id), ["display-follow", "display-0", "display-1"])
        XCTAssertEqual(offered.first?.target, .followDisplay)
        XCTAssertEqual(RecordingPickerRow.rows(targets, tab: .displays, query: "").map(\.id), ["display-0", "display-1"])
        XCTAssertEqual(RecordingPickerRow.rows(targets, tab: .displays, query: "follow", offersFollow: true).map(\.id),
                       ["display-follow"])
        XCTAssertEqual(RecordingPickerRow.rows(targets, tab: .displays, query: "side", offersFollow: true).map(\.id),
                       ["display-1"])
        // The outline marks the display a following take starts on: the one under the pointer.
        let screens = [CGRect(x: 0, y: 0, width: 900, height: 700), CGRect(x: 900, y: 0, width: 700, height: 500)]
        XCTAssertEqual(RecordingPickerGeometry.rects(.followDisplay, windows: [], screens: screens, pointer: CGPoint(x: 1000, y: 10)),
                       [screens[1].insetBy(dx: 6, dy: 6)])
        XCTAssertEqual(RecordingPickerGeometry.rects(.followDisplay, windows: [], screens: screens),
                       [screens[0].insetBy(dx: 6, dy: 6)])
        XCTAssertTrue(WidgetSessionEngine.movieCapabilities.targets.contains(.follow))
    }

    func testTabsAndPhysicalChords() {
        let tabs = RecordingPickerTab.allCases
        XCTAssertEqual(tabs.map(\.rawValue), ["windows", "apps", "displays", "area", "click"])
        XCTAssertEqual(tabs.map { RecordingPickerKey.label($0.keyCode, layout: TableKeyLayout.us) },
                       ["⌘1", "⌘2", "⌘3", "⌘4", "⌘5"])
        XCTAssertEqual(RecordingPickerTab.forKey(code: 21, character: "č")?.rawValue, "area")
        XCTAssertEqual(RecordingPickerTab.forKey(code: 23, character: "ř")?.rawValue, "click")
    }

    func testHoverWaitsForTheRowWhereTheHighlightStops() {
        var now = Duration.zero
        var due = Duration.zero
        var pending: (@MainActor () -> Void)?
        let feedback = RecordingPickerFeedback { delay, action in
            due = now + delay
            pending = action
            return { pending = nil }
        }
        func advance(_ milliseconds: Int) {
            now += .milliseconds(milliseconds)
            if now >= due {
                let fire = pending
                pending = nil
                fire?()
            }
        }
        var calls: [String] = []
        feedback.highlight(front.target) { calls.append("crossed") }
        advance(80)
        feedback.highlight(back.target) { calls.append("hover") }
        advance(119)
        feedback.highlight(back.target) { XCTFail("moving within one row reset its delay") }
        XCTAssertEqual(calls, [])
        advance(1)
        XCTAssertEqual(calls, ["hover"])
        feedback.leave { calls.append("clear") }
        feedback.highlight(front.target) { XCTFail("the pointer already left") }
        feedback.leave { calls.append("clear") }
        advance(120)
        XCTAssertEqual(calls, ["hover", "clear", "clear"])
    }

    func testBackgroundChoiceRaisesTheExactWindowBeforeItsPulse() {
        let windows = [front, back]
        let target = back.target
        let background = WindowClickPicker.windowToRaise(for: target, in: windows, excluding: [], enabled: true)
        XCTAssertEqual(background, back)
        XCTAssertNil(WindowClickPicker.windowToRaise(for: front.target, in: windows, excluding: [], enabled: true))
        XCTAssertNil(WindowClickPicker.windowToRaise(for: target, in: windows, excluding: [], enabled: false))
        let feedback = RecordingPickerFeedback()
        var order: [String] = []
        var didRaise: (() -> Void)?
        feedback.choose(background: background, front: { window, done in
            XCTAssertEqual(window.id, self.back.id)
            order.append("raise")
            didRaise = done
        }, pulse: { raised in
            XCTAssertTrue(raised)
            order.append("pulse")
        }, restore: {}, commit: { order.append("apply") })
        XCTAssertEqual(order, ["raise"])
        didRaise?()
        didRaise?()
        XCTAssertEqual(order, ["raise", "pulse", "apply"])
    }

    /// Measures AppKit ordering the real, preallocated pulse panel. Keep the fixture outside every physical screen.
    func testHoverOrdersThePreparedOutline() async throws {
        _ = NSApplication.shared
        let left = NSScreen.screens.map(\.frame.minX).min() ?? 0
        let screen = CGRect(x: left - 1500, y: 0, width: 400, height: 300)
        let pulse = TargetPulse(screens: [screen])
        let windowID = try XCTUnwrap(pulse.windowIDs.first)
        let panel = try XCTUnwrap(NSApp.window(withWindowNumber: windowID))
        guard NSScreen.screens.allSatisfy({ !$0.frame.intersects(panel.frame) }) else {
            throw XCTSkip("WindowServer moved the test panel onto a physical display")
        }
        defer { pulse.clear() }
        let feedback = RecordingPickerFeedback()
        let shown = expectation(description: "prepared outline panel ordered front")
        let start = ContinuousClock.now
        feedback.highlight(display.target) {
            pulse.hover([screen.insetBy(dx: 20, dy: 20)])
            XCTAssertTrue(panel.isVisible)
            let elapsed = start.duration(to: .now).components
            let milliseconds = Double(elapsed.seconds) * 1000 + Double(elapsed.attoseconds) / 1e15
            print(String(format: "Picker highlight to AppKit outline: %.1f ms", milliseconds))
            shown.fulfill()
        }
        await fulfillment(of: [shown], timeout: 3)
    }

    func testChoiceUpdatesTheBarWithoutStartingWhenChoiceStartsIsOff() {
        let engine = PickerTestEngine()
        let bar = RecordingBarModel(engine: engine, setup: RecordingSetup(countdownSeconds: nil))
        let picker = RecordingTargetPicker(load: .loading, bar: bar, overlays: .init(screens: []), onChoose: {}, onCancel: {})
        picker.commitChoice(display.target, choiceStarts: false)
        XCTAssertEqual(bar.setup.target, display.target)
        XCTAssertEqual(bar.phase, .setup)
        XCTAssertEqual(engine.starts, [])
    }

    func testChoiceStartsOneTakeWithTheChosenTargetWhenEnabled() async {
        let engine = PickerTestEngine()
        let started = expectation(description: "adapter accepted the start")
        engine.started = { started.fulfill() }
        let bar = RecordingBarModel(engine: engine, setup: RecordingSetup(countdownSeconds: nil))
        let picker = RecordingTargetPicker(load: .loading, bar: bar, overlays: .init(screens: []), onChoose: {}, onCancel: {})
        picker.commitChoice(side.target, choiceStarts: true)
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(engine.starts, [side.target])
    }

    func testCheckedDisplaysResolveToTheSingleOrMultipleTarget() {
        let listed = [display, side]
        XCTAssertNil(RecordingDisplaySelection.target([], displays: listed))
        XCTAssertEqual(RecordingDisplaySelection.target([1], displays: listed), side.target)
        XCTAssertEqual(RecordingDisplaySelection.target([1, 0], displays: listed), .displays(indices: [0, 1]))
        XCTAssertEqual(RecordingDisplaySelection.indices(of: .displays(indices: [0, 1])), [0, 1])
        XCTAssertEqual(RecordingDisplaySelection.target([0, 1], displays: [side]), side.target)
    }

    func testClickUsesFrontToBackWindowIDsAndSkipsExcludedPanels() {
        let point = CGPoint(x: 10, y: 10)
        let windows = [front, back]
        XCTAssertEqual(WindowClickPicker.window(at: point, in: windows, excluding: []), front)
        XCTAssertEqual(WindowClickPicker.window(at: point, in: windows, excluding: [front.id]), back)
        XCTAssertNil(WindowClickPicker.window(at: point, in: windows, excluding: [front.id, back.id]))
        XCTAssertEqual(WindowClickPicker.window(at: CGPoint(x: 90, y: 90), in: windows, excluding: []), back)
        XCTAssertNil(WindowClickPicker.window(at: CGPoint(x: -5, y: 0), in: windows, excluding: []))
    }

    func testSmallAreaCanBeRetriedOrEscapedWithoutCommitting() {
        let view = RecordingAreaSelectionView(frame: CGRect(x: 0, y: 0, width: 300, height: 200))
        var selected: [CGRect] = []
        var cancellations = 0
        view.onSelect = { selected.append($0) }
        view.onCancel = { cancellations += 1 }
        view.begin(at: CGPoint(x: 50, y: 50))
        view.drag(to: CGPoint(x: 57, y: 80))
        view.confirm()
        XCTAssertTrue(view.tooSmall)
        XCTAssertEqual(selected, [])
        XCTAssertEqual(cancellations, 0)
        view.cancelOperation(nil)
        XCTAssertEqual(cancellations, 1)
        XCTAssertEqual(selected, [])
        view.begin(at: CGPoint(x: 100, y: 90))
        view.drag(to: CGPoint(x: 5, y: -20))
        view.confirm()
        XCTAssertEqual(selected, [CGRect(x: 5, y: 0, width: 95, height: 90)])
        XCTAssertFalse(view.tooSmall)
    }

    func testAreaAndWindowOutlinesUseTheSecondaryDisplaysCocoaOrigin() {
        let screens = [CGRect(x: 0, y: 0, width: 900, height: 700), CGRect(x: -700, y: -50, width: 700, height: 500)]
        let rect = CGRect(x: 100, y: 10, width: 200, height: 80)
        XCTAssertEqual(RecordingPickerGeometry.rects(.area(rect: rect, display: 1), windows: [], screens: screens),
                       [CGRect(x: -600, y: -40, width: 200, height: 80)])
        XCTAssertEqual(RecordingPickerGeometry.rects(back.target, windows: [front, back], screens: screens),
                       [CGRect(x: 0, y: 600, width: 100, height: 100)])
        XCTAssertEqual(RecordingPickerGeometry.rects(.displays(indices: [0, 1]), windows: [], screens: screens),
                       screens.map { $0.insetBy(dx: 6, dy: 6) })
    }
}

@MainActor
private final class PickerTestEngine: RecordingEngineAdapter {
    let capabilities = RecordingCapabilities(targets: [.display, .displays, .window, .area])
    let nextTakeID = "picker-fixture"
    let events = AsyncStream<RecordingEngineEvent> { $0.finish() }
    var starts: [RecordingTarget] = []
    var started: (() -> Void)?
    func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws {
        if let target = setup.target { starts.append(target) }
        started?()
    }
    func pause() async throws {}
    func resume() async throws {}
    func stop() async throws -> URL? { nil }
    func discard() async throws {}
    func restart() async throws {}
    func apply(_ change: RecordingSetupChange) async throws {}
    func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice]) { ([], []) }
}
