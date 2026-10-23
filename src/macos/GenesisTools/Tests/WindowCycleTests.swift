import AppKit
import XCTest
@testable import GenesisToolsHost

@MainActor
final class WindowCycleTests: XCTestCase {
    /// `com.apple.symbolichotkeys` as `defaults read` shows it: [character, key code, modifier flags].
    private func hotkey(_ parameters: [Int], enabled: Bool = true) -> [String: Any] {
        ["27": ["enabled": enabled, "value": ["parameters": parameters, "type": "standard"]]]
    }

    func testTheShortcutIsTheUsersBindingOfHotkey27OrTheSystemDefault() {
        XCTAssertEqual(WindowCycle.shortcut(from: hotkey([65535, 48, 524288])), .init(keyCode: 48, modifiers: .option))
        XCTAssertEqual(WindowCycle.shortcut(from: nil), .standard, "never changed: ⌘`")
        XCTAssertEqual(WindowCycle.shortcut(from: [:]), .standard)
        XCTAssertNil(WindowCycle.shortcut(from: hotkey([65535, 48, 524288], enabled: false)), "turned off: nothing is caught")
    }

    func testShiftReversesTheShortcutAndAnyOtherKeyIsLeftAlone() {
        let optionTab = WindowCycle.Shortcut(keyCode: 48, modifiers: .option)
        XCTAssertEqual(WindowCycle.direction(keyCode: 48, modifiers: [.option], shortcut: optionTab), false)
        XCTAssertEqual(WindowCycle.direction(keyCode: 48, modifiers: [.option, .shift], shortcut: optionTab), true)
        XCTAssertEqual(WindowCycle.direction(keyCode: 48, modifiers: [.option, .capsLock, .numericPad], shortcut: optionTab), false)
        XCTAssertNil(WindowCycle.direction(keyCode: 48, modifiers: [.command], shortcut: optionTab), "⌘⇥ is the app switcher")
        XCTAssertNil(WindowCycle.direction(keyCode: 48, modifiers: [], shortcut: optionTab), "a plain Tab moves focus in the window")
        XCTAssertNil(WindowCycle.direction(keyCode: 50, modifiers: [.option], shortcut: optionTab))
    }

    func testOnlyVisibleNormalWindowsOfTheFacesAreCandidates() {
        func window(_ number: Int, pid: Int, layer: Int = 0, alpha: Double = 1, size: CGSize = CGSize(width: 900, height: 600)) -> [String: Any] {
            [kCGWindowNumber as String: number, kCGWindowOwnerPID as String: pid, kCGWindowLayer as String: layer,
             kCGWindowAlpha as String: alpha,
             kCGWindowBounds as String: CGRect(origin: .zero, size: size).dictionaryRepresentation as NSDictionary]
        }
        let list = [
            window(10, pid: 1), window(11, pid: 2), window(12, pid: 3),
            window(13, pid: 1, layer: 3), window(14, pid: 2, alpha: 0), window(15, pid: 2, size: CGSize(width: 40, height: 20)),
        ]
        XCTAssertEqual(WindowCycle.candidates(list, pids: [1, 2]), [.init(pid: 1, number: 10), .init(pid: 2, number: 11)])
    }

    private let hub = WindowCycle.Candidate(pid: 1, number: 30)
    private let review = WindowCycle.Candidate(pid: 2, number: 12)
    private let settings = WindowCycle.Candidate(pid: 3, number: 51)
    private let markdown = WindowCycle.Candidate(pid: 4, number: 70)

    func testTheFrozenListIsTheKeyWindowThenTheLastFocusedThenTheUnseen() {
        let onScreen = [markdown, settings, hub, review]
        let recent = [review, WindowCycle.Candidate(pid: 2, number: 99), hub, settings]
        XCTAssertEqual(WindowCycle.order(onScreen, recent: recent, key: review), [review, hub, settings, markdown],
                       "a closed window (99) drops out; one never focused (markdown) comes last")
        XCTAssertEqual(WindowCycle.promote(settings, in: recent).prefix(2), [settings, review])
    }

    func testAHeldModifierVisitsEveryWindowAndOnePressGoesBackToThePreviousWindow() {
        let frozen = [review, hub, settings, markdown]
        let first = WindowCycle.Session.start(frozen, backwards: false, modifiers: .option)
        XCTAssertEqual(first?.landed, hub, "one press: the previous window")
        XCTAssertEqual(first?.step(backwards: false).landed, settings)
        XCTAssertEqual(first?.step(backwards: false).step(backwards: false).step(backwards: false).landed, review, "wraps around")
        XCTAssertEqual(WindowCycle.Session.start(frozen, backwards: true, modifiers: .option)?.landed, markdown)
        XCTAssertNil(WindowCycle.Session.start([review], backwards: false, modifiers: .option), "one window: nothing to move to")

        // Martin's case: three presses held, then a release, then a new run starts from the landed window.
        var recent = [review, hub, settings, markdown]
        var run = WindowCycle.Session.start(WindowCycle.order(frozen, recent: recent, key: review), backwards: false, modifiers: .option)!
        for _ in 1..<3 { run = run.step(backwards: false) }
        XCTAssertEqual(run.landed, markdown)
        recent = WindowCycle.promote(run.landed, in: recent)
        let next = WindowCycle.Session.start(WindowCycle.order(frozen, recent: recent, key: markdown), backwards: false, modifiers: .option)
        XCTAssertEqual(next?.landed, review, "the window the run started from, not the first by number")
    }

    func testCmdTabBackShowsTheWindowThatWasKeyWhenGenesisToolsLeft() {
        let onScreen = [hub, review, settings]
        XCTAssertEqual(WindowCycle.restoreTarget([markdown, settings, hub], candidates: onScreen, own: 1), settings,
                       "the markdown window closed meanwhile")
        XCTAssertNil(WindowCycle.restoreTarget([hub, review], candidates: onScreen, own: 1), "the hub's own window: AppKit shows it")
        XCTAssertTrue(WindowCycle.cameByCommandTab(sinceFlags: 0.05, sinceMouse: 4, sinceKey: 0.2))
        XCTAssertFalse(WindowCycle.cameByCommandTab(sinceFlags: 2, sinceMouse: 4, sinceKey: 0.1), "a typed key (a launcher)")
        XCTAssertFalse(WindowCycle.cameByCommandTab(sinceFlags: 0.3, sinceMouse: 0.02, sinceKey: 5), "a click (Dock, link, notification)")
    }

    /// Any process can post the raise and focus notifications: a payload that does not fit is a plain raise or is
    /// ignored, and never traps the face.
    func testAMalformedRaiseOrFocusPayloadIsRejected() {
        let option = Int(NSEvent.ModifierFlags.option.rawValue)
        func request(_ order: [Int], index: Int, modifiers: Int = option) -> [AnyHashable: Any] {
            ["order": order, "index": index, "modifiers": modifiers]
        }
        let known: [WindowCycle.Candidate] = [.init(pid: 1, number: 10), .init(pid: 2, number: 20), .init(pid: 3, number: 30)]
        XCTAssertEqual(WindowCycle.requestedSession(request([1, 10, 2, 20], index: 1), pid: 2, window: 20, known: known),
                       WindowCycle.Session(order: [.init(pid: 1, number: 10), .init(pid: 2, number: 20)], index: 1, modifiers: .option))
        XCTAssertNil(WindowCycle.requestedSession(request([1, 10, 2, 20], index: -1), pid: 2, window: 20, known: known), "a negative index")
        XCTAssertNil(WindowCycle.requestedSession(request([1, 10, 2, 20], index: 2), pid: 2, window: 20, known: known), "past the end")
        XCTAssertNil(WindowCycle.requestedSession(request([1, 10, 2, 20], index: 1, modifiers: -1), pid: 2, window: 20, known: known))
        XCTAssertNil(WindowCycle.requestedSession(request([1, 10, 2, 20], index: 1, modifiers: 0), pid: 2, window: 20, known: known),
                     "no modifier: no release would end the run")
        XCTAssertNil(WindowCycle.requestedSession(request([1, 10, Int(Int32.max) + 1, 20], index: 1), pid: 2, window: 20, known: known))
        XCTAssertNil(WindowCycle.requestedSession(request([], index: 0), pid: 2, window: 20, known: known))
        XCTAssertNil(WindowCycle.requestedSession(request([1, 10, 2, 20], index: 0), pid: 2, window: 20, known: known),
                     "the landed window is not the one to raise")

        // A window the sender made up (another app's pid) is dropped, so no press hands the activation to it.
        XCTAssertEqual(WindowCycle.requestedSession(request([1, 10, 99, 90, 2, 20, 3, 30], index: 2), pid: 2, window: 20, known: known),
                       WindowCycle.Session(order: [.init(pid: 1, number: 10), .init(pid: 2, number: 20), .init(pid: 3, number: 30)],
                                           index: 1, modifiers: .option))
        XCTAssertNil(WindowCycle.requestedSession(request([99, 90, 2, 20], index: 1), pid: 2, window: 20, known: known),
                     "only unknown windows besides the landed one: a plain raise")

        XCTAssertEqual(WindowCycle.focusedWindow(["pid": 2, "window": 20], own: 1), .init(pid: 2, number: 20))
        XCTAssertNil(WindowCycle.focusedWindow(["pid": 1, "window": 20], own: 1), "this face's own broadcast")
        XCTAssertNil(WindowCycle.focusedWindow(["pid": Int(Int32.max) + 1, "window": 20], own: 1))
    }
}
