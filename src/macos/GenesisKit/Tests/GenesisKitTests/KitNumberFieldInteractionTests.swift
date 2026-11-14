import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// `KitNumberField` under a real press and real keys, in a window that never shows: a press steps once, a held button
/// keeps stepping, and the host gets one write for each gesture.
@MainActor
final class KitNumberFieldInteractionTests: XCTestCase {
    @MainActor
    private final class Box: ObservableObject {
        @Published var value = 48
        /// Every value the field wrote, in order.
        var writes: [Int] = []
    }

    private struct Field: View {
        @ObservedObject var box: Box

        var body: some View {
            KitNumberField("Look back", value: Binding(get: { box.value }, set: {
                box.writes.append($0)
                box.value = $0
            }), in: 1...336, suffix: .counted("hour"), identifier: "fixture.lookback")
                .frameProbe("number")
        }
    }

    private static let size = NSSize(width: 300, height: 120)

    override func setUp() async throws {
        FrameProbe.reset()
        FrameProbe.enabled = true
    }

    override func tearDown() async throws {
        FrameProbe.enabled = false
        FrameProbe.reset()
    }

    /// A step button's middle in window coordinates (from the bottom): the buttons are 22 pt squares, 2 pt inside
    /// the field's two ends.
    private func button(plus: Bool) throws -> CGPoint {
        let frame = try XCTUnwrap(FrameProbe.frames["number"], "the field reported its frame")
        return CGPoint(x: plus ? frame.maxX - 13 : frame.minX + 13, y: Self.size.height - frame.midY)
    }

    private func host(_ box: Box) -> NSWindow {
        _ = NSApplication.shared
        // Shown, as SwiftUI needs for a press, but invisible and under every window; never key.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: Self.size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: -1000)
        window.contentView = NSHostingView(rootView: Field(box: box).frame(width: Self.size.width, height: Self.size.height))
        window.orderFrontRegardless()
        pump()
        return window
    }

    private func pump(_ seconds: Double = 0.3) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func mouse(_ type: NSEvent.EventType, at point: CGPoint, in window: NSWindow) throws -> NSEvent {
        try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                                         timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                                         context: nil, eventNumber: 0, clickCount: 1, pressure: 1))
    }

    private func key(_ type: NSEvent.EventType, _ characters: String, code: UInt16, in window: NSWindow) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [],
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
        return try XCTUnwrap(window.contentView.flatMap(find), "the number is an editable text field")
    }

    func testAPressStepsOnceAndWritesOnce() throws {
        let box = Box()
        let window = host(box)
        defer { window.orderOut(nil) }
        window.sendEvent(try mouse(.leftMouseDown, at: try button(plus: true), in: window))
        pump(0.1)
        window.sendEvent(try mouse(.leftMouseUp, at: try button(plus: true), in: window))
        pump(0.2)
        XCTAssertEqual(box.value, 49)
        XCTAssertEqual(box.writes, [49], "one press is one write")

        window.sendEvent(try mouse(.leftMouseDown, at: try button(plus: false), in: window))
        pump(0.1)
        window.sendEvent(try mouse(.leftMouseUp, at: try button(plus: false), in: window))
        pump(0.2)
        XCTAssertEqual(box.writes, [49, 48])
    }

    func testAHeldButtonKeepsSteppingAndWritesOnceAtTheRelease() throws {
        let box = Box()
        let window = host(box)
        defer { window.orderOut(nil) }
        window.sendEvent(try mouse(.leftMouseDown, at: try button(plus: true), in: window))
        pump(1.2)
        XCTAssertEqual(box.writes, [], "nothing is written while the button is held")
        window.sendEvent(try mouse(.leftMouseUp, at: try button(plus: true), in: window))
        pump(0.2)
        XCTAssertEqual(box.writes.count, 1, "the hold is one write")
        XCTAssertGreaterThanOrEqual(box.value, 51, "the press and at least two repeats in 1.2 s")
        XCTAssertEqual(box.writes.first, box.value)
        let after = box.value
        pump(0.3)
        XCTAssertEqual(box.value, after, "the repeat stops at the release")
    }

    func testTheKeyboardStepsCommitsAndPutsBack() throws {
        let box = Box()
        let window = host(box)
        defer { window.orderOut(nil) }
        let field = try textField(in: window)
        XCTAssertTrue(window.makeFirstResponder(field))
        pump(0.2)

        window.sendEvent(try key(.keyDown, "\u{F700}", code: 126, in: window))
        window.sendEvent(try key(.keyUp, "\u{F700}", code: 126, in: window))
        pump(0.2)
        XCTAssertEqual(box.writes, [49], "Up is one step and one write")

        // A typed value is the field's own until Return: Escape puts the saved value back and writes nothing.
        window.sendEvent(try key(.keyDown, "7", code: 26, in: window))
        pump(0.1)
        window.sendEvent(try key(.keyDown, "\u{1B}", code: 53, in: window))
        pump(0.2)
        XCTAssertEqual(box.writes, [49])
        XCTAssertEqual(field.stringValue, "49")

        XCTAssertTrue(window.makeFirstResponder(field))
        pump(0.2)
        field.currentEditor()?.selectAll(nil)
        for digit in ["5", "0", "0"] {
            window.sendEvent(try key(.keyDown, digit, code: 0, in: window))
        }
        window.sendEvent(try key(.keyDown, "\r", code: 36, in: window))
        pump(0.2)
        XCTAssertEqual(box.writes, [49, 336], "a typed value over the range lands on its upper limit")
        XCTAssertEqual(field.stringValue, "336")
    }
}
