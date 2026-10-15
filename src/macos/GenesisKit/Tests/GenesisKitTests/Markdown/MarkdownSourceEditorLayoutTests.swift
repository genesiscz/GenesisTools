import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// Crash of 2026-10-07 18:25 (Genesis Markdown, SIGABRT in
/// `-[NSTextView _textSelectionForSelectedRanges:affinity:stillSelecting:]`,
/// `assert(textLayoutManager)`). Entering split view builds a fresh editor and
/// re-applies the find bar's match before the editor has been laid out. A
/// TextKit 2 text view defers that scroll to its first `layout`; the scroll
/// handler read `layoutManager`, which switches the view to TextKit 1 in the
/// middle of that `layout`, and AppKit then drew the (non-empty) selection
/// through a text layout manager that no longer existed.
@MainActor
final class MarkdownSourceEditorLayoutTests: XCTestCase {
    private var windows: [NSWindow] = []

    override func tearDown() {
        windows.forEach { $0.close() }
        windows = []
        super.tearDown()
    }

    private let document = (0..<2000).map { "line \($0) " + String(repeating: "word ", count: 30) }
        .joined(separator: "\n")

    private func host(_ editor: MarkdownSourceEditor) -> (NSWindow, NSTextView) {
        let hosting = NSHostingView(rootView: editor.frame(width: 500, height: 400))
        hosting.frame = NSRect(x: 0, y: 0, width: 500, height: 400)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        windows.append(window)
        window.orderFront(nil)
        window.layoutIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        window.layoutIfNeeded()
        window.displayIfNeeded()
        let textView = Self.textView(in: hosting)
        XCTAssertNotNil(textView, "the editor's text view is in the window")
        return (window, textView ?? NSTextView())
    }

    private static func textView(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        for sub in view.subviews {
            if let found = textView(in: sub) { return found }
        }
        return nil
    }

    /// The exact sequence of the crash: a new editor with a find match far
    /// down the document. Before the fix this aborts the test process.
    func testANewEditorWithAFindMatchDownTheDocumentLaysOutWithoutCrashing() {
        let length = (document as NSString).length
        let match = NSRange(location: length - 200, length: 4)
        let editor = MarkdownSourceEditor(
            text: .constant(document),
            font: .monospacedSystemFont(ofSize: 12, weight: .regular),
            textColor: .white,
            background: .black,
            selection: MarkdownSourceSelection(range: match, token: 1),
            onTopLine: { _ in }
        )
        let (_, view) = host(editor)

        XCTAssertEqual(view.selectedRange(), match, "the match stays selected")
        let scroll = try? XCTUnwrap(view.enclosingScrollView)
        XCTAssertGreaterThan(scroll?.contentView.bounds.origin.y ?? 0, 0, "the match was scrolled into view")
    }

    /// The editor never switches text systems after it is built: the scroll
    /// handler and the scroll restore both read `layoutManager`, and a switch
    /// from TextKit 2 at that moment is what tore the layout pass apart.
    func testTheEditorIsTextKit1FromTheStart() {
        let editor = MarkdownSourceEditor(
            text: .constant("alpha\nbeta"),
            font: .monospacedSystemFont(ofSize: 12, weight: .regular),
            textColor: .white,
            background: .black
        )
        let (_, view) = host(editor)
        XCTAssertNil(view.textLayoutManager, "built on TextKit 1, so reading layoutManager later switches nothing")
        XCTAssertNotNil(view.textContainer)
        XCTAssertTrue(view.textContainer?.widthTracksTextView ?? false, "lines wrap at the pane width")
    }
}
