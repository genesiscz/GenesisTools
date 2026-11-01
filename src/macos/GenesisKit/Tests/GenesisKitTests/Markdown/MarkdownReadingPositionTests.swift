import AppKit
import WebKit
import XCTest
@testable import GenesisKit

/// A note that changes on disk keeps the reader where they were (Martin, 2026-11-01: "when the Genesis Markdown
/// markdown is updated it shouldnt jump to the start of the document - restore the position i was in"). The page
/// tests run the real template in a hidden window that is never ordered front; the editor tests use a plain TextKit 1
/// text view in a hidden window.
@MainActor
final class MarkdownReadingPositionTests: XCTestCase {
    private final class Loaded: NSObject, WKNavigationDelegate {
        var done: XCTestExpectation?
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.fulfill() }
    }

    private var web: WKWebView!
    private var loaded: Loaded!
    private var window: NSWindow!
    private var tag = 0

    override func setUp() async throws {
        loaded = Loaded()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: config)
        web.navigationDelegate = loaded
        window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        let done = expectation(description: "page loaded")
        loaded.done = done
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [done], timeout: 10)
    }

    override func tearDown() {
        window?.contentView = nil
        window = nil
        web = nil
    }

    // MARK: The page

    private func render(_ markdown: String, same: Bool = true) async throws {
        tag += 1
        _ = try await web.evaluateJavaScript(
            "window.gnRender(\(MarkdownWebView.jsString(markdown)),[],false,null,{},false,\(tag),\(same));true")
    }

    private func js<T>(_ script: String, as: T.Type = T.self) async throws -> T? {
        try await web.evaluateJavaScript(script) as? T
    }

    private static func paragraphs(_ numbers: [Int], prefix: String = "Paragraph") -> String {
        numbers.map { "\(prefix) \($0): a line of the note that an agent keeps writing to." }.joined(separator: "\n\n")
    }

    private static let note = paragraphs(Array(1...80))

    /// The paragraph whose box crosses the top edge, and where its top is.
    private func topBlock() async throws -> (text: String, top: Double) {
        let pair = try await js("""
        (function(){var ps=document.querySelectorAll('#gn-article p');
          for(var i=0;i<ps.length;i++){var r=ps[i].getBoundingClientRect();if(r.bottom>0)return [ps[i].textContent,r.top];}
          return ['',0];})()
        """, as: [Any].self)
        return (pair?.first as? String ?? "", (pair?.last as? NSNumber)?.doubleValue ?? .nan)
    }

    /// Puts the paragraph that starts with `prefix` at `top` points from the window's top edge.
    private func scroll(to prefix: String, top: Double) async throws {
        _ = try await js("""
        (function(){var ps=document.querySelectorAll('#gn-article p'),sc=document.scrollingElement;
          for(var i=0;i<ps.length;i++){if(ps[i].textContent.indexOf(\(MarkdownWebView.jsString(prefix)))===0){
            sc.scrollTop=ps[i].getBoundingClientRect().top+sc.scrollTop-(\(top));return true;}}return false;})()
        """, as: Bool.self)
    }

    func testLinesAddedAboveKeepTheSameParagraphAtTheSameOffset() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: -12)
        let before = try await topBlock()
        XCTAssertTrue(before.text.hasPrefix("Paragraph 40:"), before.text)

        try await render(Self.paragraphs(Array(1...10), prefix: "Added") + "\n\n" + Self.note)
        let after = try await topBlock()
        XCTAssertTrue(after.text.hasPrefix("Paragraph 40:"), "the same words stay at the top: \(after.text)")
        XCTAssertEqual(after.top, before.top, accuracy: 1)
    }

    func testTextRemovedAboveKeepsTheSameParagraphAtTheSameOffset() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: -20)
        let before = try await topBlock()
        try await render(Self.paragraphs(Array(11...80)))
        let after = try await topBlock()
        XCTAssertTrue(after.text.hasPrefix("Paragraph 40:"), after.text)
        XCTAssertEqual(after.top, before.top, accuracy: 1)
    }

    func testADeletedParagraphGivesItsPlaceToTheBlockNearestItsLine() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: -12)
        try await render(Self.paragraphs(Array(1...39)) + "\n\n## A heading now\n\n" + Self.paragraphs(Array(41...80)))
        let heading = try await js(
            "document.querySelector('#gn-article h2').getBoundingClientRect().top", as: Double.self)
        XCTAssertEqual(heading ?? -1, 0, accuracy: 1, "the block on its line now, at the top edge")
    }

    func testTypingInTheTopBlockKeepsItsOffset() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: -12)
        let before = try await topBlock()
        var edited = Array(1...80).map { "Paragraph \($0): a line of the note that an agent keeps writing to." }
        edited[39] = "Paragraph 40: a line of the note that an agent keeps writing to, and more words."
        try await render(edited.joined(separator: "\n\n"))
        let after = try await topBlock()
        XCTAssertTrue(after.text.hasSuffix("and more words."), after.text)
        XCTAssertEqual(after.top, before.top, accuracy: 1, "the edited block stays where it was")
    }

    func testAReaderAtTheBottomFollowsAnAppend() async throws {
        try await render(Self.note)
        _ = try await js("var sc=document.scrollingElement;sc.scrollTop=sc.scrollHeight;true", as: Bool.self)
        try await render(Self.note + "\n\n" + Self.paragraphs(Array(1...6), prefix: "Appended"))
        let gap = try await js("var sc=document.scrollingElement;sc.scrollHeight-sc.clientHeight-sc.scrollTop", as: Double.self)
        XCTAssertEqual(gap ?? -1, 0, accuracy: 1, "still at the very bottom")
        let last = try await js("document.querySelector('#gn-article p:last-child').textContent", as: String.self)
        XCTAssertEqual(last?.hasPrefix("Appended 6:"), true)
    }

    func testAHalfWrittenFileReadOnTheWayDoesNotLoseThePlace() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: -12)
        let before = try await topBlock()
        try await render(Self.paragraphs(Array(1...3)), same: true)
        try await render(Self.paragraphs([0]) + "\n\n" + Self.note)
        let after = try await topBlock()
        XCTAssertTrue(after.text.hasPrefix("Paragraph 40:"), "back on the paragraph once the file is whole: \(after.text)")
        XCTAssertEqual(after.top, before.top, accuracy: 1)
    }

    func testTheSelectionStaysOnTheSameWords() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: 40)
        _ = try await js("""
        (function(){var p=Array.from(document.querySelectorAll('#gn-article p')).find(function(p){return p.textContent.indexOf('Paragraph 40:')===0;});
          var t=p.firstChild,r=document.createRange();r.setStart(t,14);r.setEnd(t,29);
          var s=window.getSelection();s.removeAllRanges();s.addRange(r);return true;})()
        """, as: Bool.self)
        let before = try await js("window.getSelection().toString()", as: String.self)
        XCTAssertEqual(before, "a line of the n")
        try await render(Self.paragraphs(Array(1...5), prefix: "Added") + "\n\n" + Self.note)
        let after = try await js(
            "var s=window.getSelection();[s.toString(),s.anchorNode.parentNode.textContent.slice(0,13)]", as: [String].self)
        XCTAssertEqual(after, ["a line of the n", "Paragraph 40:"])
    }

    /// The page script is one scope, and a second `function x(` replaces the first without a word: the selection
    /// restore's `gnPointAt` was silently the find's own helper of that name until this test.
    func testThePageScriptDeclaresEachFunctionOnce() throws {
        let pattern = try NSRegularExpression(pattern: #"function (\w+)\("#)
        let script = MarkdownWebView.template as NSString
        var counts: [String: Int] = [:]
        for match in pattern.matches(in: MarkdownWebView.template, range: NSRange(location: 0, length: script.length)) {
            counts[script.substring(with: match.range(at: 1)), default: 0] += 1
        }
        XCTAssertGreaterThan(counts.count, 50, "the scan sees the page's functions (92 on 2026-11-01)")
        XCTAssertEqual(counts.filter { $0.value > 1 }.keys.sorted(), [])
    }

    func testAnotherDocumentKeepsThePixelOffsetAndNoAnchor() async throws {
        try await render(Self.note)
        try await scroll(to: "Paragraph 40:", top: -12)
        let top = try await js("document.scrollingElement.scrollTop", as: Double.self)
        try await render(Self.paragraphs(Array(1...10), prefix: "Added") + "\n\n" + Self.note, same: false)
        let after = try await js("document.scrollingElement.scrollTop", as: Double.self)
        XCTAssertEqual(after, top, "a new document is not searched for the old one's paragraph")
    }

    // MARK: The source editor

    private func editor(_ text: String) -> NSTextView {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 500, height: 300))
        let view = NSTextView(usingTextLayoutManager: false)
        view.frame = NSRect(x: 0, y: 0, width: 500, height: 300)
        view.minSize = NSSize(width: 0, height: 300)
        view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        scroll.documentView = view
        scroll.hasVerticalScroller = true
        window.contentView = scroll
        view.string = text
        if let layout = view.layoutManager, let container = view.textContainer { layout.ensureLayout(for: container) }
        view.sizeToFit()
        return view
    }

    private func top(of line: Int, in view: NSTextView) -> CGFloat {
        let starts = SourceEditing.lineStarts(view.string)
        let layout = view.layoutManager!
        let glyph = layout.glyphIndexForCharacter(at: starts[line])
        return layout.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY + view.textContainerInset.height
    }

    private func scroll(_ view: NSTextView, to y: CGFloat) {
        let clip = view.enclosingScrollView!.contentView
        clip.scroll(to: NSPoint(x: 0, y: y))
        view.enclosingScrollView!.reflectScrolledClipView(clip)
    }

    /// The change the editor makes when the file changed from outside, and the restore after it.
    private func replace(_ view: NSTextView, with text: String) {
        let oldStarts = SourceEditing.lineStarts(view.string)
        let anchor = MarkdownSourceEditor.ReadingAnchor.capture(view, starts: oldStarts)
        let change = MarkdownSourceEditor.changedRange(old: view.string as NSString, new: text as NSString)
        view.textStorage?.replaceCharacters(in: change.range, with: change.replacement)
        anchor?.restore(in: view, starts: SourceEditing.lineStarts(view.string), oldStart: anchor.map { oldStarts[$0.line] } ?? 0,
                        change: change.range, inserted: (change.replacement as NSString).length)
    }

    private static let lines = (0..<300).map { "line \($0) of the source" }.joined(separator: "\n")

    func testTheEditorKeepsItsTopLineWhenLinesAreAddedAbove() {
        let view = editor(Self.lines)
        scroll(view, to: top(of: 150, in: view) + 5)
        let before = MarkdownSourceEditor.ReadingAnchor.capture(view, starts: SourceEditing.lineStarts(view.string))
        XCTAssertEqual(before?.text, "line 150 of the source")
        XCTAssertEqual(before?.offset ?? -1, 5, accuracy: 0.5)

        let added = (0..<20).map { "added \($0)" }.joined(separator: "\n") + "\n"
        replace(view, with: added + Self.lines)
        let after = MarkdownSourceEditor.ReadingAnchor.capture(view, starts: SourceEditing.lineStarts(view.string))
        XCTAssertEqual(after?.text, "line 150 of the source", "the same text at the top")
        XCTAssertEqual(after?.line, 170)
        XCTAssertEqual(after?.offset ?? -1, 5, accuracy: 0.5)
    }

    func testTheEditorAtTheBottomFollowsAnAppend() {
        let view = editor(Self.lines)
        scroll(view, to: view.frame.height - 300)
        replace(view, with: Self.lines + "\n" + (0..<30).map { "appended \($0)" }.joined(separator: "\n"))
        let clip = view.enclosingScrollView!.contentView.bounds
        XCTAssertEqual(clip.maxY, view.frame.height, accuracy: 1)
    }

    func testTheSelectionMovesWithItsText() {
        let change = NSRange(location: 0, length: 0)
        XCTAssertEqual(MarkdownSourceEditor.ReadingAnchor.selection(NSRange(location: 50, length: 4), through: change, inserted: 10, length: 200),
                       NSRange(location: 60, length: 4), "text added above moves the selection with its words")
        let after = NSRange(location: 100, length: 0)
        XCTAssertEqual(MarkdownSourceEditor.ReadingAnchor.selection(NSRange(location: 50, length: 4), through: after, inserted: 10, length: 200),
                       NSRange(location: 50, length: 4), "an append below leaves it")
        let over = NSRange(location: 48, length: 10)
        XCTAssertEqual(MarkdownSourceEditor.ReadingAnchor.selection(NSRange(location: 50, length: 4), through: over, inserted: 3, length: 200),
                       NSRange(location: 50, length: 0), "a change through it collapses it where it was")
    }
}
