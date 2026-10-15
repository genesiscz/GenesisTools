import AppKit
import XCTest
@testable import GenesisKit

/// ⌘B, ⌘I, ⌘K and ⌘⇧X in the markdown source editor. Pure edits, so the
/// behaviour is pinned without a window.
final class SourceFormattingTests: XCTestCase {
    private func apply(_ edit: SourceEditing.Edit, to text: String) -> String {
        let ns = NSMutableString(string: text)
        ns.replaceCharacters(in: edit.range, with: edit.replacement)
        return ns as String
    }

    func testBoldWrapsTheSelectionAndTakesItOffAgain() {
        let text = "make this loud"
        let sel = NSRange(location: 5, length: 4)   // "this"
        let on = SourceEditing.wrap(text, selection: sel, marks: "**")
        XCTAssertEqual(apply(on, to: text), "make **this** loud")
        XCTAssertEqual(on.selection, NSRange(location: 7, length: 4))

        // The same selection inside the marks turns them off.
        let wrapped = "make **this** loud"
        let off = SourceEditing.wrap(wrapped, selection: NSRange(location: 7, length: 4), marks: "**")
        XCTAssertEqual(apply(off, to: wrapped), text)
        // And so does a selection that includes them.
        let offOuter = SourceEditing.wrap(wrapped, selection: NSRange(location: 5, length: 8), marks: "**")
        XCTAssertEqual(apply(offOuter, to: wrapped), text)
    }

    func testWithNoSelectionBoldTakesTheWordUnderTheCaret() {
        let text = "make this loud"
        let edit = SourceEditing.wrap(text, selection: NSRange(location: 7, length: 0), marks: "*")
        XCTAssertEqual(apply(edit, to: text), "make *this* loud")

        // On empty space the marks go in and the caret sits between them.
        let empty = "a  b"
        let spaced = SourceEditing.wrap(empty, selection: NSRange(location: 2, length: 0), marks: "**")
        XCTAssertEqual(apply(spaced, to: empty), "a **** b")
        XCTAssertEqual(spaced.selection, NSRange(location: 4, length: 0))
    }

    func testLinkWrapsTheSelectionAndParksTheCaretForTheAddress() {
        let text = "see the docs"
        let edit = SourceEditing.link(text, selection: NSRange(location: 8, length: 4))
        XCTAssertEqual(apply(edit, to: text), "see the [docs]()")
        XCTAssertEqual(edit.selection, NSRange(location: 15, length: 0))

        // A pasted URL over a selection becomes the address instead.
        let pasted = SourceEditing.link(text, selection: NSRange(location: 8, length: 4), url: "https://x.dev/a")
        XCTAssertEqual(apply(pasted, to: text), "see the [docs](https://x.dev/a)")
        XCTAssertTrue(SourceEditing.isURL("https://x.dev/a"))
        XCTAssertFalse(SourceEditing.isURL("not a url"))
        XCTAssertFalse(SourceEditing.isURL("word"))
    }

    func testTaskTogglesTickAndUntickAWholeBlock() {
        let text = "- one\n- two\n"
        let all = NSRange(location: 0, length: 11)
        let ticked = SourceEditing.toggleTask(text, selection: all)
        XCTAssertEqual(apply(ticked, to: text), "- [ ] one\n- [ ] two\n")

        let open = "- [ ] one\n- [x] two\n"
        // A block with one open box ticks everything, rather than flipping each.
        let done = SourceEditing.toggleTask(open, selection: NSRange(location: 0, length: 19))
        XCTAssertEqual(apply(done, to: open), "- [x] one\n- [x] two\n")

        let allDone = "- [x] one\n- [x] two\n"
        let reopened = SourceEditing.toggleTask(allDone, selection: NSRange(location: 0, length: 19))
        XCTAssertEqual(apply(reopened, to: allDone), "- [ ] one\n- [ ] two\n")

        // Plain prose becomes a task, indentation kept.
        let prose = "  buy milk\n"
        let one = SourceEditing.toggleTask(prose, selection: NSRange(location: 3, length: 0))
        XCTAssertEqual(apply(one, to: prose), "  - [ ] buy milk\n")
    }

    /// The live editor routes ⌘B through `performKeyEquivalent`, because a
    /// plain NSTextView has no bold command of its own.
    @MainActor
    func testTheTextViewClaimsTheFormattingKeys() throws {
        let view = SourceTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
        var seen: [String] = []
        view.onKeyEquivalent = { event in
            seen.append(event.charactersIgnoringModifiers ?? "")
            return true
        }
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = NSView(frame: view.frame)
        window.contentView?.addSubview(view)
        window.makeFirstResponder(view)

        let event = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [.command], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, characters: "b",
            charactersIgnoringModifiers: "b", isARepeat: false, keyCode: 11
        ))
        XCTAssertTrue(view.performKeyEquivalent(with: event))
        XCTAssertEqual(seen, ["b"])
        window.contentView = nil
    }
}
