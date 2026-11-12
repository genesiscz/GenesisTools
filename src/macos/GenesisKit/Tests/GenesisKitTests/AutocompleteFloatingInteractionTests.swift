import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The floating list of an `AutocompleteField` under real keys and a real press, in a window that never shows: typing
/// shows the list in a child window, a press on a row takes it while the field keeps the keyboard, Escape closes the
/// list and keeps the text, and Return takes the marked row.
@MainActor
final class AutocompleteFloatingInteractionTests: XCTestCase {
    @MainActor
    private final class Box: ObservableObject {
        @Published var text = ""
        var chosen: [String] = []
    }

    private struct Field: View {
        @ObservedObject var box: Box
        let items = ["Work", "Work · Team", "Home", "Birthdays"].map { AutocompleteValue($0, symbol: "calendar") }

        var body: some View {
            VStack {
                AutocompleteField("Add a calendar", text: $box.text, items: items, identifier: "fixture.calendar") { choice in
                    box.chosen.append(choice.text)
                    box.text = ""
                }
                .frame(width: 260)
                Spacer()
            }
            .padding(20)
        }
    }

    private func host(_ box: Box) -> NSWindow {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 200, y: 300, width: 320, height: 300), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: -1000)
        window.contentView = NSHostingView(rootView: Field(box: box).frame(width: 320, height: 300))
        window.orderFrontRegardless()
        pump()
        return window
    }

    private func pump(_ seconds: Double = 0.3) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func key(_ characters: String, code: UInt16, in window: NSWindow) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
                                       timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                       context: nil, characters: characters, charactersIgnoringModifiers: characters,
                                       isARepeat: false, keyCode: code))
    }

    private func textField(in window: NSWindow) throws -> NSTextField {
        func find(_ view: NSView) -> NSTextField? {
            if let field = view as? NSTextField, field.isEditable { return field }
            for child in view.subviews {
                if let found = find(child) { return found }
            }
            return nil
        }
        return try XCTUnwrap(window.contentView.flatMap(find))
    }

    /// The list's panel while it shows.
    private func panel(of window: NSWindow) -> NSWindow? {
        window.childWindows?.first
    }

    private func type(_ text: String, in window: NSWindow) throws {
        for character in text {
            window.sendEvent(try key(String(character), code: 0, in: window))
        }
        pump()
    }

    func testAPressOnARowTakesItAndTheFieldKeepsTheKeyboard() throws {
        let box = Box()
        let window = host(box)
        defer { window.orderOut(nil) }
        let field = try textField(in: window)
        XCTAssertNil(panel(of: window), "no list before the field has the keyboard")
        XCTAssertTrue(window.makeFirstResponder(field))
        pump()

        try type("w", in: window)
        let list = try XCTUnwrap(panel(of: window), "the list shows in a child window")
        XCTAssertFalse(list.canBecomeKey)

        // The first row, inside the visible list's own frame.
        let point = CGPoint(x: 60, y: list.frame.height - 16)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            list.sendEvent(try XCTUnwrap(NSEvent.mouseEvent(
                with: type, location: point, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: list.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)))
            pump(0.15)
        }
        pump()
        XCTAssertEqual(box.chosen, ["Work"], "the press took the first row")
        XCTAssertNil(panel(of: window), "a taken value closes the list")
        XCTAssertTrue(window.firstResponder === field.currentEditor(), "the field still has the keyboard")
    }

    func testEscapeClosesTheListAndReturnTakesTheMarkedRow() throws {
        let box = Box()
        let window = host(box)
        defer { window.orderOut(nil) }
        let field = try textField(in: window)
        XCTAssertTrue(window.makeFirstResponder(field))
        pump()

        try type("w", in: window)
        XCTAssertNotNil(panel(of: window))
        window.sendEvent(try key("\u{1B}", code: 53, in: window))
        pump()
        XCTAssertNil(panel(of: window), "Escape closes the list")
        XCTAssertEqual(box.text, "w", "and keeps the text")
        XCTAssertEqual(box.chosen, [])

        window.sendEvent(try key("\u{F701}", code: 125, in: window))
        pump()
        XCTAssertNotNil(panel(of: window), "Down opens it again")
        window.sendEvent(try key("\u{F701}", code: 125, in: window))
        window.sendEvent(try key("\r", code: 36, in: window))
        pump()
        XCTAssertEqual(box.chosen.count, 1, "Return takes the marked row")
        XCTAssertTrue(box.chosen.first?.hasPrefix("Work") == true)
        XCTAssertNil(panel(of: window), "and closes the list")
    }
}
