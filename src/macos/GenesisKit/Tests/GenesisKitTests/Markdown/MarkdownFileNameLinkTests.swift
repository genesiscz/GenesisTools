import AppKit
import WebKit
import XCTest
@testable import GenesisKit

/// A bare file name in prose (`UpgradePlan.md line 72 reads …`) is no web address, although linkify reads `.md`,
/// `.sh` and `.py` as country domains. It links only when the file exists for this note, and then opens it like a
/// relative link (Martin, 2026-11-01: "try if it stats the file in that folder … and if it doesnt then do not link it
/// at all"). Pages run in hidden windows that are never ordered front; files live in a temporary folder.
@MainActor
final class MarkdownFileNameLinkTests: XCTestCase {
    private var folder: URL!
    private var window: NSWindow?
    private var coordinator: MarkdownWebView.Coordinator?

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("genesiskit-filenames-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data("# Plan\n".utf8).write(to: folder.appendingPathComponent("UpgradePlan.md"))
        try Data("echo hi\n".utf8).write(to: folder.appendingPathComponent("deploy.sh"))
    }

    override func tearDown() {
        coordinator?.hideNotice()
        window?.contentView = nil
        window = nil
        coordinator = nil
        try? FileManager.default.removeItem(at: folder)
    }

    func testOnlyNamesThatLookLikeDomainsAreCandidates() {
        let names = MarkdownMedia.bareFileNames(in: """
        UpgradePlan.md line 72, run deploy.sh, main.py, lib.rs, a.ts, archive.zip, clip.mov,
        https://example.md/x, notes/Inner.md, ./Rel.md, x@y.md, UpgradePlan.md again
        """)
        XCTAssertEqual(names, ["UpgradePlan.md", "deploy.sh", "main.py", "lib.rs", "archive.zip", "clip.mov"])
    }

    func testTheRegistryMarksOnlyNamesThatOpenSomething() {
        let registry = MarkdownMediaRegistry()
        let map = registry.update(markdown: "UpgradePlan.md, Missing.md and deploy.sh",
                                  context: MarkdownMedia.Context(folder: folder, vaultRoot: nil))
        XCTAssertEqual(map["UpgradePlan.md"]?["kind"], "file")
        XCTAssertEqual(map["deploy.sh"]?["kind"], "file")
        XCTAssertNil(map["Missing.md"])
    }

    // MARK: The page

    private func page(_ markdown: String, onRelativeLink: @escaping (String) -> Void) async throws -> WKWebView {
        let view = MarkdownWebView(markdown: markdown, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
                                   onWikilink: { _ in }, onActiveSection: { _ in }, onRelativeLink: onRelativeLink,
                                   documentURL: folder.appendingPathComponent("Note.md"))
        let coordinator = MarkdownWebView.Coordinator(view)
        coordinator.lastMarkdown = markdown
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), configuration: MarkdownWebView.configuration(for: coordinator))
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
        return web
    }

    private func links(_ web: WKWebView) async throws -> [String] {
        try await web.evaluateJavaScript(
            "Array.from(document.querySelectorAll('#gn-article a')).map(function(a){return a.textContent+' -> '+a.getAttribute('href')})"
        ) as? [String] ?? []
    }

    func testAnExistingSiblingLinksAndOpensAMissingOneIsTextAndWebLinksStay() async throws {
        var opened: [String] = []
        let markdown = """
        UpgradePlan.md line 72 reads it. Missing.md is gone. Run deploy.sh, not main.py.

        https://example.md/x and www.example.md stay web links. `UpgradePlan.md` stays code.
        """
        let web = try await page(markdown) { opened.append($0) }
        let found = try await links(web)
        XCTAssertEqual(found, [
            "UpgradePlan.md -> UpgradePlan.md",
            "deploy.sh -> deploy.sh",
            "https://example.md/x -> https://example.md/x",
            "www.example.md -> http://www.example.md",
        ])
        let text = try await web.evaluateJavaScript("document.getElementById('gn-article').textContent") as? String ?? ""
        XCTAssertTrue(text.contains("Missing.md is gone."), "a missing name stays as text, word for word")
        XCTAssertTrue(text.contains("not main.py."))
        let code = try await web.evaluateJavaScript("document.querySelector('#gn-article code').textContent") as? String
        XCTAssertEqual(code, "UpgradePlan.md")

        _ = try await web.evaluateJavaScript("document.querySelector('#gn-article a').click();true")
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(opened, ["UpgradePlan.md"], "opened like a relative link")
    }
}
