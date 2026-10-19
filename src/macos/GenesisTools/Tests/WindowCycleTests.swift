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

    func testRepeatedPressesVisitEveryWindowInAFixedOrderAcrossProcesses() {
        let hub = WindowCycle.Candidate(pid: 1, number: 30)
        let review = WindowCycle.Candidate(pid: 2, number: 12)
        let settings = WindowCycle.Candidate(pid: 3, number: 51)
        let all = [hub, review, settings]
        XCTAssertEqual(WindowCycle.next(after: 12, in: all, backwards: false), hub)
        XCTAssertEqual(WindowCycle.next(after: 30, in: all, backwards: false), settings)
        XCTAssertEqual(WindowCycle.next(after: 51, in: all, backwards: false), review, "wraps around")
        XCTAssertEqual(WindowCycle.next(after: 12, in: all, backwards: true), settings)
        XCTAssertEqual(WindowCycle.next(after: 30, in: all, backwards: true), review)
        XCTAssertEqual(WindowCycle.next(after: 40, in: all, backwards: false), settings, "a key window not in the list still has a place")
        XCTAssertNil(WindowCycle.next(after: 30, in: [hub], backwards: false), "one window: nothing to move to")
    }
}
