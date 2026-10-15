import WebKit
import XCTest
@testable import GenesisKit

/// The gutter's hunks against HEAD, their revert, and the bars the page draws for them.
@MainActor
final class GitHunksTests: XCTestCase {
    func testOldHunksCannotReturnAfterFollowingStops() async throws {
        final class Head: GenesisKitGTCLIProvider {
            override func contents(of file: URL, at revision: GitRevision) throws -> String? { "old\n" }
        }
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = Head()
        defer { GenesisKitGT.provider = previous }
        let model = GitGutterModel()
        let started = expectation(description: "hunks started"), finished = expectation(description: "hunks finished")
        let gate = DispatchSemaphore(value: 0)
        model.computeHunks = { old, new in
            started.fulfill()
            _ = gate.wait(timeout: .now() + 5)
            finished.fulfill()
            return GitHunks.between(old: old, new: new)
        }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("absent-gutter-\(UUID())/note.md")
        model.follow(file, text: "new\n")
        await fulfillment(of: [started], timeout: 3)
        model.follow(nil, text: "")
        gate.signal()
        await fulfillment(of: [finished], timeout: 3)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(model.hunks.isEmpty)
        model.computeHunks = { GitHunks.between(old: $0, new: $1) }
        model.follow(file, text: "new\n")
        let end = Date().addingTimeInterval(3)
        while model.hunks.isEmpty, Date() < end { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertEqual(model.hunks.first?.kind, .modified)
        model.follow(nil, text: "")
    }

    func testAddedChangedAndRemovedLinesBecomeThreeHunks() {
        let old = "a\nb\nc\nd\ne\n"
        let new = "a\nB\nc\nnew\nd\n"
        let hunks = GitHunks.between(old: old, new: new)
        XCTAssertEqual(hunks.map(\.kind), [.modified, .added, .deleted])
        XCTAssertEqual(hunks[0].newStart, 1)
        XCTAssertEqual(hunks[0].oldLines, ["b"])
        XCTAssertEqual(hunks[1].newStart, 3)
        XCTAssertEqual(hunks[1].newCount, 1)
        XCTAssertEqual(hunks[2].newStart, 5)
        XCTAssertEqual(hunks[2].oldLines, ["e"])
        XCTAssertEqual(hunks[2].title, "1 line removed before line 6")
        XCTAssertEqual(hunks[0].title, "Line 2 changed")
    }

    func testRevertingEveryHunkGivesHeadBack() {
        let old = "# Plan\n\nIntro.\n\n- one\n- two\n"
        let new = "# Plan v2\n\nIntro, longer.\nExtra line.\n\n- one\n"
        var text = new
        // From the bottom, so the earlier hunks' lines stay where they were.
        for hunk in GitHunks.between(old: old, new: new).reversed() {
            text = GitHunks.revert(hunk, in: text)
        }
        XCTAssertEqual(text, old)
        XCTAssertTrue(GitHunks.between(old: old, new: old).isEmpty)
    }

    func testRevertRestoresExactEOFBytes() {
        let texts = ["", "only", "only\n", "other", "other\n", "a\nb", "a\nb\n", "a\nB", "a\nB\n", "\n", "\n\n"]
        for old in texts {
            for new in texts {
                let hunks = GitHunks.between(old: old, new: new)
                XCTAssertEqual(hunks.isEmpty, old == new)
                let reverted = hunks.reversed().reduce(new) { GitHunks.revert($1, in: $0) }
                XCTAssertEqual(reverted, old, "old=\(old.debugDescription), new=\(new.debugDescription)")
            }
        }
        let old = "first\nkept\nlast", new = "FIRST\nkept\nlast\n"
        let hunks = GitHunks.between(old: old, new: new)
        XCTAssertEqual(hunks.count, 2)
        XCTAssertEqual(GitHunks.revert(hunks[0], in: new), "first\nkept\nlast\n", "an earlier hunk leaves EOF alone")
        XCTAssertEqual(GitHunks.revert(hunks[1], in: new), "FIRST\nkept\nlast", "the EOF hunk leaves earlier edits alone")
    }

    func testAFileThatWasEmptyGetsItsLinesAndNewlineBack() {
        let hunks = GitHunks.between(old: "only\n", new: "")
        XCTAssertEqual(hunks.map(\.kind), [.deleted])
        XCTAssertEqual(GitHunks.revert(hunks[0], in: ""), "only\n")
    }

    func testThePageMarksTheChangedBlocksAndReportsAClickOnABar() async throws {
        final class Bridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
            var clicks: [Int] = []
            var loaded: XCTestExpectation?
            func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
                guard let body = message.body as? [String: Any], body["type"] as? String == "gitMark" else { return }
                clicks.append(body["index"] as? Int ?? -1)
            }
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.fulfill() }
        }
        let bridge = Bridge()
        let controller = WKUserContentController()
        controller.add(bridge, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: config)
        web.navigationDelegate = bridge
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let loaded = expectation(description: "page loaded")
        bridge.loaded = loaded
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [loaded], timeout: 10)

        // Body lines: 0 heading, 2 first paragraph, 4 second paragraph, 6 list.
        let body = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n- item one\n- item two\n"
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(body)),[],false,null,{},false,1)")
        let marks = [
            MarkdownWebView.GitMark(first: 2, last: 2, kind: .modified, index: 0),
            MarkdownWebView.GitMark(first: 7, last: 7, kind: .added, index: 1),
            MarkdownWebView.GitMark(first: 4, last: 4, kind: .deleted, index: 2),
        ]
        _ = try await web.evaluateJavaScript("window.gnGitMarks([\(marks.map(\.json).joined(separator: ","))])")
        let marked = try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('[data-gn-git]')).map(function(e){return e.tagName+':'+e.getAttribute('data-gn-git')+':'+e.textContent.trim().slice(0,12)})"
        ) as? [String]
        XCTAssertEqual(marked, ["P:modified:First paragr", "P:deleted:Second parag", "LI:added:item two"])

        // A render keeps the marks; a click left of a marked block reports its index.
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(body)),[],false,null,{},false,2)")
        let after = try await web.evaluateJavaScript("document.querySelectorAll('[data-gn-git]').length") as? Int
        XCTAssertEqual(after, 3)
        _ = try await web.evaluateJavaScript("""
            (function(){var el=document.querySelector('[data-gn-git="modified"]');var r=el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left-14,clientY:r.top+4}));return 1;})()
            """)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(bridge.clicks, [0])

        // Every bar stands in one column left of the text: the list item's bar does not sit in the list's indent.
        let column = try await web.evaluateJavaScript("""
            (function(){var bars=Array.from(document.querySelectorAll('.gn-git-bar'));
            var text=document.querySelector('#gn-article p').getBoundingClientRect().left;
            return bars.map(function(b){return Math.round(b.getBoundingClientRect().left)+':'+(b.getBoundingClientRect().right<=text)}).join(',');})()
            """) as? String
        let bars = column?.split(separator: ",") ?? []
        XCTAssertEqual(bars.count, 3, column ?? "nil")
        XCTAssertEqual(Set(bars.map { $0.split(separator: ":")[0] }).count, 1, column ?? "nil")
        XCTAssertTrue(bars.allSatisfy { $0.hasSuffix(":true") }, column ?? "nil")
        // A click on a bar reports its change.
        _ = try await web.evaluateJavaScript("document.querySelector('.gn-git-bar[data-k=\"added\"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))")
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(bridge.clicks, [0, 1])
        // Native buttons provide Tab, Return/Space and accessibility activation without custom key handlers.
        let actions = try await web.evaluateJavaScript("""
            Array.from(document.querySelectorAll('.gn-git-bar')).map(function(b){
              return b.tagName+':'+b.tabIndex+':'+b.getAttribute('aria-label');})
            """) as? [String]
        XCTAssertEqual(actions, [
            "BUTTON:0:Body line 3 modified. Show previous content and revert options",
            "BUTTON:0:Body line 5 deleted. Show previous content and revert options",
            "BUTTON:0:Body line 8 added. Show previous content and revert options",
        ])
        // Reapply through the public bridge: gnLayoutGit is private to the page's closure.
        let focused = try await web.evaluateJavaScript("""
            (function(){var b=document.querySelector('.gn-git-bar');b.focus();
              window.gnGitMarks([\(marks.map(\.json).joined(separator: ","))]);
              return !b.isConnected&&document.activeElement.className==='gn-git-bar'
                &&document.activeElement.getAttribute('data-i')===b.getAttribute('data-i');})()
            """) as? Bool
        XCTAssertEqual(focused, true, "layout retains the focused hunk action")
        _ = try await web.evaluateJavaScript("document.activeElement.click()")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(bridge.clicks, [0, 1, 0])

        // A changed table row gets a bar too (a row cannot hold a positioned ::before).
        let table = "Intro.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n"
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(table)),[],false,null,{},false,3)")
        _ = try await web.evaluateJavaScript("window.gnGitMarks([\(MarkdownWebView.GitMark(first: 4, last: 4, kind: .modified, index: 0).json)])")
        let rowBar = try await web.evaluateJavaScript(
            "(function(){var b=document.querySelector('.gn-git-bar');return b?Math.round(b.getBoundingClientRect().height):-1;})()"
        ) as? Int
        XCTAssertGreaterThan(rowBar ?? -1, 4)
    }
}
