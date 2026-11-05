import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// `GrowingTextEditor`, the answer field of the widget and the hub (Martin, 2026-11-04: a long answer showed four lines
/// in a TextField, and a wheel over the field without the keyboard scrolled the panel instead of the text). The window
/// has alpha 0, sits below the desktop and is never activated.
@MainActor
final class GrowingTextEditorTests: XCTestCase {
    private final class Box: ObservableObject {
        @Published var text: String
        var returns: [Bool] = []
        init(_ text: String) { self.text = text }
    }

    private struct Field: View {
        @ObservedObject var box: Box
        var body: some View {
            GrowingTextEditor("Write my own answer…", text: $box.text) { press in
                GrowingTextEditor.returnKey(press) { box.returns.append($0) }
            }
        }
    }

    private func host(_ box: Box) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 380, height: 300), styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.alphaValue = 0
        window.level = NSWindow.Level(rawValue: -1000)
        // As in the widget panel: the field sits in a scroll view with other content around it.
        window.contentView = NSHostingView(rootView: ScrollView {
            VStack(spacing: 12) {
                Color.gray.frame(height: 120)
                Field(box: box).frame(width: 340)
                Color.gray.frame(height: 400)
            }.padding(20)
        })
        window.orderFrontRegardless()
        pump()
        return window
    }

    private func pump(_ seconds: Double = 0.4) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func views<T: NSView>(_ type: T.Type, in view: NSView) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views(type, in: $0) }
    }

    private func editor(in window: NSWindow) throws -> NSTextView {
        try XCTUnwrap(views(NSTextView.self, in: try XCTUnwrap(window.contentView)).first)
    }

    /// The widget's panel: borderless and non-activating, key once something in it needs the keyboard.
    private final class FieldPanel: EditingPanel {
        override var canBecomeKey: Bool { true }
    }

    private final class Focused: ObservableObject {
        @Published var text = ""
        @Published var request = 0
    }

    /// The field as the widget's answer box holds it: its focus set from code, as the box's `activate` does.
    private struct ActivatedField: View {
        @ObservedObject var box: Focused
        @FocusState private var focused: Bool

        var body: some View {
            GrowingTextEditor("Write my own answer…", text: $box.text, focus: $focused)
                .onChange(of: box.request) { _, _ in focused = true }
        }
    }

    /// In the widget's non-activating panel, the field its box focuses takes the keyboard and the typing. Martin,
    /// 2026-11-05: "i can't even fill in the input - it just pings the system sound when i click it".
    func testTheFieldFocusedFromCodeTakesTypingInANonActivatingPanel() throws {
        let box = Focused()
        let panel = FieldPanel(contentRect: NSRect(x: 0, y: 0, width: 380, height: 120),
                               styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.alphaValue = 0
        panel.level = NSWindow.Level(rawValue: -1000)
        panel.contentView = NSHostingView(rootView: ActivatedField(box: box).frame(width: 340).padding(20))
        panel.orderFrontRegardless()
        panel.makeKey()
        defer { panel.orderOut(nil) }
        pump()
        box.request += 1
        pump(0.3)
        XCTAssertTrue(panel.firstResponder is NSTextView, "the field took the keyboard")
        panel.sendEvent(try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: panel.windowNumber,
            context: nil, characters: "x", charactersIgnoringModifiers: "x", isARepeat: false, keyCode: 7)))
        pump(0.2)
        XCTAssertEqual(box.text, "x", "the typing reached it")
    }

    /// A one-line field draws no scroll bar: with scroll bars always shown, its 15 pt track was a grey square beside
    /// the send button (Martin, 2026-11-05). A long answer still scrolls with the wheel and the keys.
    func testTheFieldDrawsNoScrollBar() throws {
        let window = host(Box("one line"))
        defer { window.orderOut(nil) }
        let scroll = try XCTUnwrap(try editor(in: window).enclosingScrollView)
        XCTAssertFalse(scroll.hasVerticalScroller && scroll.verticalScroller?.isHidden == false,
                       "the field's scroll view shows its vertical scroller")
    }

    func testTheFieldIsAsTallAsItsLinesUpToFourThenItsTextScrolls() throws {
        for (lines, height) in [(1, 15.0), (2, 30.0), (4, 60.0), (12, 60.0)] {
            let box = Box((1...lines).map { "Line \($0)" }.joined(separator: "\n"))
            let window = host(box)
            defer { window.orderOut(nil) }
            let scroll = try XCTUnwrap(try editor(in: window).enclosingScrollView)
            XCTAssertEqual(scroll.frame.height, height, accuracy: 1, "\(lines) lines")
        }
    }

    func testAWheelOverTheFieldWithoutTheKeyboardScrollsItsTextNotThePanel() throws {
        let box = Box((1...40).map { "Sentence \($0) of a long decision answer that wraps across the field." }
            .joined(separator: " "))
        let window = host(box)
        defer { window.orderOut(nil) }
        window.makeFirstResponder(nil)
        pump(0.2)
        let content = try XCTUnwrap(window.contentView)
        let inner = try XCTUnwrap(try editor(in: window).enclosingScrollView)
        let panel = try XCTUnwrap(views(NSScrollView.self, in: content).first { !($0.documentView is NSTextView) })
        let centre = inner.convert(NSPoint(x: inner.bounds.midX, y: inner.bounds.midY), to: nil)
        let target = try XCTUnwrap(content.hitTest(try XCTUnwrap(content.superview).convert(centre, from: nil)))
        let wheel = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: -6,
                                          wheel2: 0, wheel3: 0).flatMap(NSEvent.init(cgEvent:)))
        target.scrollWheel(with: wheel)
        pump()
        XCTAssertGreaterThan(inner.contentView.bounds.origin.y, 0, "the field's own text moved")
        XCTAssertEqual(panel.contentView.bounds.origin.y, 0, "the panel around it stayed")
    }

    func testReturnGoesToTheFieldsActionAndOptionReturnIsANewLine() throws {
        let box = Box("an answer")
        let window = host(box)
        defer { window.orderOut(nil) }
        let editor = try editor(in: window)
        window.makeFirstResponder(editor)
        editor.setSelectedRange(NSRange(location: (box.text as NSString).length, length: 0))
        pump(0.2)
        func key(_ flags: NSEvent.ModifierFlags) throws -> NSEvent {
            try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                           windowNumber: window.windowNumber, context: nil, characters: "\r",
                                           charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        }
        window.sendEvent(try key([]))
        window.sendEvent(try key([.command]))
        pump(0.2)
        XCTAssertEqual(box.returns, [false, true], "Return and ⌘-Return reach the action")
        XCTAssertEqual(box.text, "an answer", "and type nothing")
        window.sendEvent(try key([.option]))
        pump(0.2)
        XCTAssertEqual(box.text, "an answer\n", "Option-Return is a new line")
        XCTAssertEqual(box.returns.count, 2)
    }

    func testTheSizingTextCountsATrailingNewLineAndAnEmptyField() {
        XCTAssertEqual(GrowingTextEditor.sizingText(""), " ")
        XCTAssertEqual(GrowingTextEditor.sizingText("one\n"), "one\n ")
        XCTAssertEqual(GrowingTextEditor.sizingText("one"), "one")
    }
}
