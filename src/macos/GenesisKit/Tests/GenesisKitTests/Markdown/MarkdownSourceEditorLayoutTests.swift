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

    // MARK: Text size and line spacing (2026-11-24)

    /// Split view set 12 pt SF Mono beside the page's 16 px body text, so the source read about a quarter smaller.
    /// The editor takes the page's code size, and the window's reading size scales both panes.
    func testTheEditorTextIsThePagesCodeSizeAndFollowsTheReadingSize() throws {
        XCTAssertEqual(MarkdownSourceEditor.textSize(zoom: 1, size: .page), 14)
        XCTAssertEqual(MarkdownSourceEditor.textSize(zoom: 1.5, size: .page), 21)
        XCTAssertEqual(MarkdownSourceEditor.textSize(zoom: 0.9, size: .page), 12.5, "half points")
        XCTAssertEqual(MarkdownSourceEditor.textSize(zoom: 1, size: .smaller), 12)
        XCTAssertEqual(MarkdownSourceEditor.textSize(zoom: 1, size: .larger), 16)
        // The two numbers are the page's own; a change to the stylesheet must move them too.
        let (data, _) = try XCTUnwrap(MarkdownWebView.assetData("markdown-page.css"))
        let css = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(css.contains("article{font-size:\(Int(MarkdownSourceEditor.pageBodySize))px;"))
        XCTAssertEqual(MarkdownSourceEditor.pageCodeScale, 0.88)
        XCTAssertTrue(css.contains("code{font-family:var(--dd-mono);font-size:.88em;"))
    }

    /// Every line is the wanted multiple of the text size with its text in the middle, as CSS `line-height` sets the
    /// page's; nil keeps the font's own height. A change of the setting reaches an open editor.
    func testTheLineHeightSetsEveryLineWithItsTextInTheMiddle() throws {
        let font = NSFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        func editor(_ lineHeight: CGFloat?) -> AnyView {
            AnyView(MarkdownSourceEditor(text: .constant("alpha\nbeta\ngamma"), font: font, textColor: .white, background: .black,
                                         lineHeight: lineHeight).frame(width: 400, height: 300))
        }
        // Off screen: a borderless window that is never ordered in.
        let hosting = NSHostingView(rootView: editor(nil))
        hosting.frame = NSRect(x: 0, y: 0, width: 400, height: 300)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        windows.append(window)
        func measure() throws -> (height: CGFloat, second: CGFloat, baseline: CGFloat) {
            hosting.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            hosting.layoutSubtreeIfNeeded()
            let view = try XCTUnwrap(Self.textView(in: hosting))
            let layout = try XCTUnwrap(view.layoutManager)
            layout.ensureLayout(for: try XCTUnwrap(view.textContainer))
            let first = layout.lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
            let second = layout.lineFragmentRect(forGlyphAt: 6, effectiveRange: nil)
            return (first.height, second.minY - first.minY, layout.location(forGlyphAt: 0).y)
        }
        let own = try measure()
        XCTAssertEqual(own.height, NSLayoutManager().defaultLineHeight(for: font), "nil: the font's own height")

        hosting.rootView = editor(1.6)
        let spaced = try measure()
        XCTAssertEqual(spaced.height, (1.6 * 14).rounded(), "1.6 times 14 pt")
        XCTAssertEqual(spaced.second, spaced.height, "every line is that tall")
        XCTAssertEqual(spaced.baseline - own.baseline, ((spaced.height - own.height) / 2).rounded(.down),
                       "the added space is split above and below the text")
    }
}
