import SwiftUI
import WebKit
import XCTest
@testable import GenesisKit

/// Task boxes on the real page, in hidden windows that are never ordered front: which items get a box, a locked page,
/// a click through the app's coordinator, and the whole path from a click to the file on disk without a new render.
@MainActor
final class MarkdownTaskWebTests: XCTestCase {
    private var window: NSWindow?
    private var coordinator: MarkdownWebView.Coordinator?
    private var folder: URL?

    override func tearDown() {
        coordinator?.hideNotice()
        window?.contentView = nil
        window = nil
        coordinator = nil
        if let folder { try? FileManager.default.removeItem(at: folder) }
        folder = nil
    }

    private static let extras = MarkdownWebView.PageExtras(headingAnchors: false, codeBlockBar: false, stickySection: false)

    private func view(_ markdown: String, tasks: MarkdownTaskBoxes) -> MarkdownWebView {
        MarkdownWebView(markdown: markdown, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
                        onWikilink: { _ in }, onActiveSection: { _ in }, pageExtras: Self.extras, tasks: tasks)
    }

    /// A page driven by the app's own coordinator, its first render done.
    private func page(_ view: MarkdownWebView, size: NSSize = NSSize(width: 900, height: 640))
        async throws -> (WKWebView, MarkdownWebView.Coordinator) {
        let coordinator = MarkdownWebView.Coordinator(view)
        coordinator.lastMarkdown = view.markdown
        _ = coordinator.syncPageExtras()
        let web = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: MarkdownWebView.configuration(for: coordinator))
        web.navigationDelegate = coordinator
        coordinator.web = web
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        for _ in 0..<100 where !coordinator.ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(coordinator.ready)
        try await Task.sleep(nanoseconds: 150_000_000)
        self.window = window
        self.coordinator = coordinator
        return (web, coordinator)
    }

    private func js<T>(_ web: WKWebView, _ script: String, as: T.Type = T.self) async throws -> T? {
        try await web.evaluateJavaScript(script) as? T
    }

    /// Boxes as `line|checked|disabled|label`.
    private func boxes(_ web: WKWebView) async throws -> [String] {
        try await js(web, """
        Array.from(document.querySelectorAll('#gn-article input.gn-task')).map(function(b){
          return b.getAttribute('data-task-line')+'|'+b.checked+'|'+b.disabled+'|'+b.getAttribute('aria-label');})
        """) ?? []
    }

    private static let note = """
    # Tasks

    - [ ] open item
    - [x] done item
    * [X] star upper
    1. [ ] ordered
       - [ ] nested **bold**
    - plain item
    - see [x] mid-line
    > - [ ] quoted

    ```
    - [ ] in code
    ```

    > [!todo] Callout
    > - [ ] in callout
    """

    private static let editable = MarkdownTaskBoxes(lock: nil) { _, answer in answer(true) }

    // MARK: Which items get a box

    func testTaskItemsGetANamedBoxAndCodeAndMidLineBoxesStayText() async throws {
        let (web, _) = try await page(view(Self.note, tasks: Self.editable))
        let drawn = try await boxes(web)
        XCTAssertEqual(drawn, [
            "2|false|false|Mark done: open item",
            "3|true|false|Mark done: done item",
            "4|true|false|Mark done: star upper",
            "5|false|false|Mark done: ordered",
            "6|false|false|Mark done: nested bold",
            "9|false|false|Mark done: quoted",
            "16|false|false|Mark done: in callout",
        ])
        XCTAssertEqual(MarkdownTaskList.items(in: Array(Self.note.utf8)).map(\.line), [2, 3, 4, 5, 6, 9, 16],
                       "the page and the Swift scanner name the same lines")
        let code = try await js(web, "document.querySelector('#gn-article pre').textContent", as: String.self)
        XCTAssertEqual(code?.contains("- [ ] in code"), true)
        let text = try await js(web, "document.getElementById('gn-article').textContent", as: String.self) ?? ""
        XCTAssertTrue(text.contains("see [x] mid-line"), "a box in the middle of a line stays text")
        XCTAssertFalse(text.contains("[ ] open item"), "the box replaces the brackets")
        let done = try await js(web, """
        Array.from(document.querySelectorAll('#gn-article li.gn-task-done > .gn-task-text')).map(function(s){return s.textContent.trim()})
        """, as: [String].self)
        XCTAssertEqual(done, ["done item", "star upper"], "the done items' own text, not the nested items")
        let nestedText = try await js(web, """
        document.querySelector('#gn-article input[data-task-line="5"]').closest('li').querySelector(':scope > .gn-task-text').textContent.trim()
        """, as: String.self)
        XCTAssertEqual(nestedText, "ordered", "the span stops at the nested list")
    }

    /// Indented code, a paragraph's next line and nested items: the page draws a box on exactly the lines the Swift
    /// scanner names, so a click never lands on a line the scanner reads as text, or the other way round.
    func testThePageDrawsBoxesOnTheLinesTheScannerNames() async throws {
        let note = MarkdownTaskListTests.indentNote
        let (web, _) = try await page(view(note, tasks: Self.editable))
        let lines = try await boxes(web).map { Int($0.split(separator: "|")[0]) ?? -1 }
        XCTAssertEqual(lines, MarkdownTaskList.items(in: Array(note.utf8)).map(\.line))
        XCTAssertEqual(lines, [0, 1, 2, 4, 10, 15, 16, 21])
    }

    func testALockedPageShowsDisabledBoxesWithTheReasonAndCanBeUnlockedInPlace() async throws {
        let (web, coordinator) = try await page(view(Self.note, tasks: .locked("A past version of the note.")))
        let locked = try await boxes(web)
        XCTAssertEqual(locked.count, 7)
        XCTAssertTrue(locked.allSatisfy { $0.contains("|true|Mark done:") }, "every box disabled: \(locked)")
        let title = try await js(web, "document.querySelector('#gn-article .gn-task-hit').getAttribute('title')", as: String.self)
        XCTAssertEqual(title, "A past version of the note.")
        let tag = try await js(web, "window.gnRenderedTag", as: String.self)

        coordinator.parent = view(Self.note, tasks: Self.editable)
        coordinator.applyTaskMode()
        try await Task.sleep(nanoseconds: 50_000_000)
        let unlocked = try await boxes(web)
        XCTAssertTrue(unlocked.allSatisfy { $0.contains("|false|Mark done:") }, "all enabled: \(unlocked)")
        let after = try await js(web, "[window.gnRenderedTag,document.querySelector('#gn-article .gn-task-hit').hasAttribute('title')]",
                                 as: [Any].self)
        XCTAssertEqual(after?.first as? String, tag, "no render for a mode change")
        XCTAssertEqual(after?.last as? Bool, false)
    }

    func testThePreviewDefaultIsReadOnly() async throws {
        let plain = MarkdownWebView(markdown: Self.note, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
                                    onWikilink: { _ in }, onActiveSection: { _ in }, pageExtras: Self.extras)
        XCTAssertFalse(plain.tasks.editable)
        let (web, _) = try await page(plain)
        let drawn = try await boxes(web)
        XCTAssertEqual(drawn.count, 7)
        XCTAssertTrue(drawn.allSatisfy { $0.contains("|true|Mark done:") }, "\(drawn)")
    }

    // MARK: A click through the coordinator

    func testAClickHandsTheItemToTheHostAndThePageIsNotDrawnAgain() async throws {
        var asked: [MarkdownTaskTarget] = []
        var answers: [(Bool) -> Void] = []
        let tasks = MarkdownTaskBoxes(lock: nil) { target, answer in
            asked.append(target)
            answers.append(answer)
        }
        let (web, coordinator) = try await page(view(Self.note, tasks: tasks))
        let tag = try await js(web, "document.getElementById('gn-article').firstElementChild.gnMark=1;window.gnRenderedTag", as: String.self)

        _ = try await js(web, "document.querySelector('#gn-article input[data-task-line=\"3\"]').click();true", as: Bool.self)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(asked, [MarkdownTaskTarget(line: 3, lineBytes: Array("- [x] done item".utf8), text: "done item", checked: false)])
        XCTAssertEqual(coordinator.lastMarkdown, Self.note.replacingOccurrences(of: "- [x] done item", with: "- [ ] done item"))
        XCTAssertEqual(coordinator.taskHolds, [Self.note], "the text from before the click waits for the answer")
        answers[0](true)
        XCTAssertEqual(coordinator.taskHolds, [])
        let state = try await js(web, """
        var b=document.querySelector('#gn-article input[data-task-line="3"]');
        [b.checked,b.closest('li').classList.contains('gn-task-done'),!!document.getElementById('gn-article').firstElementChild.gnMark,window.gnRenderedTag]
        """, as: [Any].self)
        XCTAssertEqual(state?[0] as? Bool, false)
        XCTAssertEqual(state?[1] as? Bool, false, "the item no longer looks done")
        XCTAssertEqual(state?[2] as? Bool, true, "the same page: nothing was drawn again")
        XCTAssertEqual(state?[3] as? String, tag)

        // A refusal puts the box back and the drawn text back.
        let before = coordinator.lastMarkdown
        _ = try await js(web, "document.querySelector('#gn-article input[data-task-line=\"2\"]').click();true", as: Bool.self)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(asked.count, 2)
        answers[1](false)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(coordinator.lastMarkdown, before)
        let reverted = try await js(web, "document.querySelector('#gn-article input[data-task-line=\"2\"]').checked", as: Bool.self)
        XCTAssertEqual(reverted, false)
    }

    func testARefusalPutsBackOnlyItsOwnBoxWhileALaterClickWaits() async throws {
        var answers: [(Bool) -> Void] = []
        let tasks = MarkdownTaskBoxes(lock: nil) { _, answer in answers.append(answer) }
        let (web, coordinator) = try await page(view(Self.note, tasks: tasks))
        _ = try await js(web, """
        document.querySelector('#gn-article input[data-task-line="2"]').click();
        document.querySelector('#gn-article input[data-task-line="5"]').click();true
        """, as: Bool.self)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(answers.count, 2)
        answers[0](false)
        try await Task.sleep(nanoseconds: 50_000_000)
        let drawn = try await boxes(web).filter { $0.hasPrefix("2|") || $0.hasPrefix("5|") }
        XCTAssertEqual(drawn, ["2|false|false|Mark done: open item", "5|true|false|Mark done: ordered"])
        XCTAssertEqual(coordinator.lastMarkdown, Self.note.replacingOccurrences(of: "1. [ ] ordered", with: "1. [x] ordered"),
                       "the page's text loses the refused click and keeps the one still on its way")
    }

    // MARK: From the click to the file

    /// The pane's own shape: a SwiftUI view that observes the document and hands its text to the page.
    private struct Host: View {
        @ObservedObject var doc: MarkdownDocument
        let tasks: MarkdownTaskBoxes
        var body: some View {
            MarkdownWebView(markdown: doc.displayText, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
                            onWikilink: { _ in }, onActiveSection: { _ in }, pageExtras: MarkdownTaskWebTests.extras,
                            tasks: tasks)
        }
    }

    /// The text the host hands the page, observed, so a change goes through the view's real update.
    private final class Shown: ObservableObject {
        @Published var text: String
        init(_ text: String) { self.text = text }
    }

    private struct ShownHost: View {
        @ObservedObject var shown: Shown
        let tasks: MarkdownTaskBoxes
        var body: some View {
            MarkdownWebView(markdown: shown.text, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
                            onWikilink: { _ in }, onActiveSection: { _ in }, pageExtras: MarkdownTaskWebTests.extras,
                            tasks: tasks)
        }
    }

    private func webView(in view: NSView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        for sub in view.subviews { if let web = webView(in: sub) { return web } }
        return nil
    }

    func testAClickWritesOnlyTheBoxToTheFileAndKeepsThePageAndItsScroll() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("genesiskit-taskweb-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        self.folder = folder
        let filler = (1...60).map { "Paragraph \($0) of the note, long enough to fill the page." }.joined(separator: "\r\n\r\n")
        let text = "# Disk full\r\n\r\n\(filler)\r\n\r\n- [ ] **openclaw-regenerable** · 6.4 GB · **OPEN**\r\n- [x] done\r\n"
        let url = folder.appendingPathComponent("Disk full.md")
        try Data(text.utf8).write(to: url)
        let doc = MarkdownDocument(url: url)
        let tasks = MarkdownTaskBoxes(lock: nil) { target, answer in
            doc.setTask(target, saveAtOnce: true) { answer($0.applied) }
        }
        let hosting = NSHostingView(rootView: Host(doc: doc, tasks: tasks))
        hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 640)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        self.window = window
        hosting.layoutSubtreeIfNeeded()
        var page: WKWebView?
        for _ in 0..<100 {
            page = webView(in: hosting)
            if let page, (try? await page.evaluateJavaScript("document.querySelectorAll('#gn-article input.gn-task').length") as? Int) == 2 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let web = try XCTUnwrap(page)
        let top = try await js(web, """
        var sc=document.scrollingElement;sc.scrollTop=sc.scrollHeight;
        document.getElementById('gn-article').firstElementChild.gnMark=1;sc.scrollTop
        """, as: Double.self)
        XCTAssertGreaterThan(top ?? 0, 500, "scrolled down to the tasks")
        let tag = try await js(web, "window.gnRenderedTag", as: String.self)

        _ = try await js(web, "document.querySelector('#gn-article input.gn-task:not(:checked)').click();true", as: Bool.self)
        for _ in 0..<100 where doc.text == text {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(try Data(contentsOf: url), Data(text.replacingOccurrences(of: "- [ ] **open", with: "- [x] **open").utf8),
                       "one byte changed, CRLF kept")
        XCTAssertEqual(doc.text, text.replacingOccurrences(of: "- [ ] **open", with: "- [x] **open"))
        let after = try await js(web, """
        [window.gnRenderedTag,!!document.getElementById('gn-article').firstElementChild.gnMark,document.scrollingElement.scrollTop,
         document.querySelector('#gn-article input.gn-task').checked]
        """, as: [Any].self)
        XCTAssertEqual(after?[0] as? String, tag, "the reload drew nothing again")
        XCTAssertEqual(after?[1] as? Bool, true)
        XCTAssertEqual(after?[2] as? Double, top, "the reading position stays")
        XCTAssertEqual(after?[3] as? Bool, true)
    }

    /// The note reloads while a click's write is on its way, with a line added above, and then the click is refused.
    /// The box now on the clicked line is another item, drawn from the new text: it stays as the new text says.
    func testARefusalAfterTheNoteReloadedLeavesTheNewDrawingAlone() async throws {
        var answers: [(Bool) -> Void] = []
        let tasks = MarkdownTaskBoxes(lock: nil) { _, answer in answers.append(answer) }
        let shown = Shown("# Tasks\n\n- [ ] open item\n- [x] done item\n")
        let hosting = NSHostingView(rootView: ShownHost(shown: shown, tasks: tasks))
        hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 640)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        self.window = window
        hosting.layoutSubtreeIfNeeded()
        var page: WKWebView?
        for _ in 0..<100 {
            page = webView(in: hosting)
            if let page, (try? await page.evaluateJavaScript("document.querySelectorAll('#gn-article input.gn-task').length") as? Int) == 2 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let web = try XCTUnwrap(page)

        _ = try await js(web, "document.querySelector('#gn-article input[data-task-line=\"2\"]').click();true", as: Bool.self)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(answers.count, 1)
        shown.text = "# Tasks\n\n- [x] inserted item\n- [ ] open item\n- [x] done item\n"
        for _ in 0..<100 {
            if try await boxes(web).count == 3 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let reloaded = try await boxes(web)
        XCTAssertEqual(reloaded.count, 3, "the new text is drawn: \(reloaded)")

        answers[0](false)
        try await Task.sleep(nanoseconds: 100_000_000)
        let after = try await boxes(web)
        XCTAssertEqual(after, ["2|true|false|Mark done: inserted item", "3|false|false|Mark done: open item",
                               "4|true|false|Mark done: done item"])
    }

    // MARK: Pictures for review

    /// `MARKDOWN_TASK_SHOTS=<folder>` renders a task-list note in the Light and Genesis (dark) themes at 900 x 640 and
    /// writes `tasks-light.png` and `tasks-dark.png`. `MARKDOWN_TASK_SHOTS_NOTE=<file>` picks the note (read only).
    func testRenderTaskShotsWhenAsked() async throws {
        guard let out = ProcessInfo.processInfo.environment["MARKDOWN_TASK_SHOTS"] else {
            throw XCTSkip("set MARKDOWN_TASK_SHOTS to a folder to render the pictures")
        }
        let note = try ProcessInfo.processInfo.environment["MARKDOWN_TASK_SHOTS_NOTE"]
            .map { try String(contentsOfFile: $0, encoding: .utf8) } ?? Self.note
        let body = MarkdownFrontmatter.split(note).body
        for (name, theme, done) in [("light", MarkdownTheme.light, MarkdownTaskDoneStyle.dim),
                                    ("dark", MarkdownTheme.genesis, MarkdownTaskDoneStyle.dim),
                                    ("dark-strike", MarkdownTheme.genesis, MarkdownTaskDoneStyle.dimStrike),
                                    ("dark-locked", MarkdownTheme.genesis, MarkdownTaskDoneStyle.dim)] {
            let tasks: MarkdownTaskBoxes = name == "dark-locked" ? .locked("Read-only") : Self.editable
            let (web, coordinator) = try await page(view(body, tasks: tasks))
            coordinator.applyTheme(theme.cssVariables)
            coordinator.eval(MarkdownWebView.PageExtras(headingAnchors: false, codeBlockBar: false, stickySection: false,
                                                        taskDone: done).script)
            if name == "light" {
                // The pointer over the first box, as the hover plate would show it.
                _ = try await js(web, "document.querySelector('#gn-article .gn-task-hit').style.background='rgba(127,127,127,.18)';true", as: Bool.self)
            }
            try await Task.sleep(nanoseconds: 300_000_000)
            let image = try await web.takeSnapshot(configuration: nil)
            let rep = try XCTUnwrap(image.cgImage(forProposedRect: nil, context: nil, hints: nil).map(NSBitmapImageRep.init(cgImage:)))
            let png = try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: out).appendingPathComponent("tasks-\(name).png"))
            coordinator.hideNotice()
            window?.contentView = nil
        }
    }
}
