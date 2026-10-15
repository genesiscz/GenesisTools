import WebKit
import XCTest
@testable import GenesisKit

/// A file's two sides per scope (GitFileDiffModel), and the rendered diff the Changes mode shows for a note.
@MainActor
final class GitFileDiffTests: XCTestCase {
    private func git(_ args: [String], in repo: URL) throws -> String {
        let result = try GenesisKitGTCLIProvider().git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
        return String(decoding: result.stdout, as: UTF8.self).trimmed
    }

    func testUntrackedFilesFoldUnderTheShallowestFolderWithNoOtherChange() {
        let entries = [
            GitStatusEntry(path: "notes/plan.md", unstaged: .modified),
            GitStatusEntry(path: "notes/new.md", unstaged: .untracked),
            GitStatusEntry(path: "data/run1/a.json", unstaged: .untracked),
            GitStatusEntry(path: "data/run1/b.json", unstaged: .untracked),
            GitStatusEntry(path: "data/run2/c.json", unstaged: .untracked),
            GitStatusEntry(path: "misc/deep/only.md", unstaged: .untracked),
            GitStatusEntry(path: "loose.md", unstaged: .untracked),
        ]
        let fold = GitChangeList.foldUntracked(entries)
        XCTAssertEqual(fold.groups.map(\.folder), ["data"])
        XCTAssertEqual(fold.groups.first?.files.count, 3)
        XCTAssertEqual(Set(fold.files.map(\.path)), ["notes/new.md", "misc/deep/only.md", "loose.md"], "a changed folder and a one-file folder stay as files")
    }

    func testTheSortButtonCyclesAndEachOrderSorts() {
        XCTAssertEqual(GitChangeOrder.lastUpdate.next, .name)
        XCTAssertEqual(GitChangeOrder.kind.next, .lastUpdate)
        let entries = [
            GitStatusEntry(path: "b/zeta.md", unstaged: .deleted),
            GitStatusEntry(path: "a/alpha.md", unstaged: .modified),
            GitStatusEntry(path: "c/beta.md", unstaged: .added),
        ]
        let now = Date()
        let dates = ["b/zeta.md": now, "a/alpha.md": now.addingTimeInterval(-3600), "c/beta.md": now.addingTimeInterval(-60)]
        XCTAssertEqual(GitChangeList.sorted(entries, by: .lastUpdate, dates: dates, staged: false).map(\.path), ["b/zeta.md", "c/beta.md", "a/alpha.md"])
        XCTAssertEqual(GitChangeList.sorted(entries, by: .name, dates: dates, staged: false).map(\.path), ["a/alpha.md", "c/beta.md", "b/zeta.md"])
        XCTAssertEqual(GitChangeList.sorted(entries, by: .folder, dates: dates, staged: false).map(\.path), ["a/alpha.md", "b/zeta.md", "c/beta.md"])
        XCTAssertEqual(GitChangeList.sorted(entries, by: .kind, dates: dates, staged: false).map(\.path), ["a/alpha.md", "c/beta.md", "b/zeta.md"])
    }

    func testADiffRequestReadsEveryScopeAndRefusesTheRest() {
        XCTAssertEqual(MarkdownDiffRequest.parse("staged"), MarkdownDiffRequest(scope: .staged))
        XCTAssertEqual(MarkdownDiffRequest.parse(" Uncommitted "), MarkdownDiffRequest(scope: .uncommitted))
        XCTAssertEqual(MarkdownDiffRequest.parse("last"), MarkdownDiffRequest(scope: .lastCommit))
        XCTAssertEqual(MarkdownDiffRequest.parse("commit:A1B2C3D"), MarkdownDiffRequest(scope: .lastCommit, commit: "a1b2c3d"))
        for bad in [nil, "", "head", "commit:", "commit:xyz"] {
            XCTAssertNil(MarkdownDiffRequest.parse(bad), "\(bad ?? "nil")")
        }
        for request in [MarkdownDiffRequest(scope: .branch), MarkdownDiffRequest(scope: .lastCommit), MarkdownDiffRequest(scope: .lastCommit, commit: "abc123")] {
            XCTAssertEqual(MarkdownDiffRequest.parse(request.queryValue), request)
        }
        XCTAssertEqual(MarkdownDiffRequest.fromQuery([URLQueryItem(name: "diff", value: "unstaged")])?.scope, .unstaged)
    }

    func testEveryScopeReadsTheRightSides() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("filediff-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let note = repo.appendingPathComponent("plan.md")
        _ = try git(["init", "-q", "-b", "main"], in: repo)
        try "v1\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "."], in: repo)
        _ = try git(["commit", "-q", "-m", "First"], in: repo)
        _ = try git(["checkout", "-q", "-b", "feat/x"], in: repo)
        try "v2\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["commit", "-q", "-am", "Second"], in: repo)
        try "v3\n".write(to: note, atomically: true, encoding: .utf8)
        _ = try git(["add", "plan.md"], in: repo)
        // The working side is the text on screen, an unsaved draft included.
        let draft = "v4 draft\n"
        let provider = GenesisKitGTCLIProvider()
        func sides(_ scope: GitFileScope, pick: String? = nil) throws -> GitFileDiffModel.Sides {
            try GitFileDiffModel.sides(note, text: draft, scope: scope, pick: pick, provider: provider)
        }
        XCTAssertEqual(try sides(.unstaged).old, "v3\n")
        XCTAssertEqual(try sides(.unstaged).new, draft)
        XCTAssertEqual(try sides(.staged).old, "v2\n")
        XCTAssertEqual(try sides(.staged).new, "v3\n")
        XCTAssertEqual(try sides(.uncommitted).old, "v2\n")
        let last = try sides(.lastCommit)
        XCTAssertEqual(last.commit?.subject, "Second")
        XCTAssertEqual(last.old, "v1\n")
        XCTAssertEqual(last.new, "v2\n")
        XCTAssertEqual(last.history.map(\.subject), ["Second", "First"])
        let first = try sides(.lastCommit, pick: last.history[1].sha)
        XCTAssertNil(first.old, "the first commit added the file")
        XCTAssertEqual(first.new, "v1\n")
        XCTAssertEqual(GitFileDiffModel.diffFile(path: first.path, old: first.old, new: first.new).status, .added)
        // The branch against its base: main is the base here, merge base is First.
        XCTAssertEqual(try sides(.branch).old, "v1\n")
    }

    func testTheRenderedDiffMarksAddedChangedAndRemovedBlocks() async throws {
        final class Loaded: NSObject, WKNavigationDelegate {
            var done: XCTestExpectation?
            func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done?.fulfill() }
        }
        let loaded = Loaded()
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: config)
        web.navigationDelegate = loaded
        let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = web
        defer { window.contentView = nil }
        let done = expectation(description: "page loaded")
        loaded.done = done
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
        await fulfillment(of: [done], timeout: 10)

        let old = "---\ntags: [a]\n---\n# Title\n\nThe quick brown fox.\n\nGone paragraph.\n\nKept.\n"
        let new = "---\ntags: [a, b]\n---\n# Title\n\nThe quick red fox jumps.\n\nKept.\n\nBrand new.\n"
        let marks = MarkdownWebView.DiffMark.between(old: old, new: new)
        XCTAssertEqual(marks.map(\.kind), [.modified, .deleted, .added], "the frontmatter is not part of the diff")
        let body = MarkdownFrontmatter.split(new).1
        _ = try await web.evaluateJavaScript("window.gnRender(\(MarkdownWebView.jsString(body)),[],false,null,{},false,1)")
        _ = try await web.evaluateJavaScript("window.gnDiff([\(marks.map(\.json).joined(separator: ","))])")
        func strings(_ js: String) async throws -> [String] {
            try await web.evaluateJavaScript(js) as? [String] ?? []
        }
        let changed = try await strings("Array.from(document.querySelectorAll('.gn-diff-mod,.gn-diff-add')).map(function(e){return e.className.replace(/.*gn-diff-/,'')+':'+e.textContent})")
        XCTAssertEqual(changed, ["mod:The quick red fox jumps.", "add:Brand new."])
        let olds = try await strings("Array.from(document.querySelectorAll('.gn-diff-old')).map(function(e){return (e.classList.contains('gn-diff-pair')?'pair:':'gone:')+e.textContent.trim()})")
        XCTAssertEqual(olds, ["pair:The quick brown fox.", "gone:Gone paragraph."])
        let words = try await strings("Array.from(document.querySelectorAll('mark.gn-ins,mark.gn-del')).map(function(e){return e.className+':'+e.textContent})")
        XCTAssertEqual(words, ["gn-del:brown", "gn-del:fox.", "gn-ins:red", "gn-ins:fox", "gn-ins:jumps."])
        // A second diff replaces the first instead of stacking on it.
        _ = try await web.evaluateJavaScript("window.gnDiff([])")
        let left = try await web.evaluateJavaScript("document.querySelectorAll('.gn-diff-old,.gn-diff-mod,.gn-diff-add,mark.gn-ins').length") as? Int
        XCTAssertEqual(left, 0)
    }
}
