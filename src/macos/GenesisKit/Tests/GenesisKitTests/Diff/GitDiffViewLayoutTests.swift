import AppKit
import SwiftUI
import WebKit
import XCTest
@testable import GenesisKit

/// The Changes pane's Split / Unified choice reaches the diff page and re-lays the diff out (Martin, 2026-10-13: the
/// buttons did nothing). Needs the diff page, so it uses the installed app's copy and skips without one.
@MainActor
final class GitDiffViewLayoutTests: XCTestCase {
    final class Choice: ObservableObject {
        @Published var unified = false
    }

    struct Host: View {
        @ObservedObject var choice: Choice
        let file: DiffFile
        var body: some View {
            GitDiffView(files: [file], options: DiffViewOptions(diffStyle: choice.unified ? .unified : .split, wrap: true, fontSize: 12))
        }
    }

    private func webView(in view: NSView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        for sub in view.subviews {
            if let web = webView(in: sub) { return web }
        }
        return nil
    }

    /// The `data-diff-type` of every rendered diff ("split" or "single"), through pierre's shadow roots.
    private func layouts(_ web: WKWebView) async throws -> String {
        let script = """
        (() => { const out = []; const walk = (root) => { root.querySelectorAll('*').forEach(el => {
          const type = el.getAttribute && el.getAttribute('data-diff-type'); if (type) out.push(type);
          if (el.shadowRoot) walk(el.shadowRoot); }); }; walk(document); return out.join(','); })()
        """
        return (try await web.evaluateJavaScript(script) as? String) ?? ""
    }

    private func wait(_ web: WKWebView, for layout: String) async throws -> String {
        var seen = ""
        for _ in 0..<50 {
            try await Task.sleep(nanoseconds: 200_000_000)
            seen = try await layouts(web)
            if seen.contains(layout) { break }
        }
        return seen
    }

    /// Runs `script` over the page and every pierre shadow root (`roots` is the list of them) and returns its string.
    private func query(_ web: WKWebView, _ script: String) async throws -> String {
        let walk = """
        (() => { const roots = [document]; const walk = (root) => root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } }); walk(document); \(script) })()
        """
        return (try await web.evaluateJavaScript(walk) as? String) ?? ""
    }

    private func poll(_ web: WKWebView, _ script: String, until done: (String) -> Bool) async throws -> String {
        var seen = ""
        for _ in 0..<50 {
            try await Task.sleep(nanoseconds: 200_000_000)
            seen = try await query(web, script)
            if done(seen) { break }
        }
        return seen
    }

    /// An SVG shows as code with a "Show image" switch in its header; the switch puts its picture in place of the code.
    func testAnSVGShowsAsCodeUntilItsHeaderSwitchShowsThePicture() async throws {
        let dir = NSHomeDirectory() + "/Applications/GenesisTools.app/Contents/Resources/diff-viewer"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: dir + "/index.html"), "no installed diff page")
        setenv("GENESIS_DIFF_VIEWER_DIR", dir, 1)
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("gk-svg-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let svg = { (fill: String) in
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"><rect width=\"40\" height=\"40\" fill=\"\(fill)\"/></svg>\n"
        }
        let oldPath = folder.appendingPathComponent("old.svg").path
        let newPath = folder.appendingPathComponent("icon.svg").path
        try svg("red").write(toFile: oldPath, atomically: true, encoding: .utf8)
        try svg("blue").write(toFile: newPath, atomically: true, encoding: .utf8)
        let file = DiffFile(id: "icon.svg", path: "icon.svg", status: .modified, additions: 1, deletions: 1,
                            oldContents: svg("red"), newContents: svg("blue"),
                            image: DiffImage(old: .file(oldPath), new: .file(newPath)))
        let hosting = NSHostingView(rootView: GitDiffView(files: [file], options: DiffViewOptions(diffStyle: .split, wrap: true, fontSize: 12)))
        hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.contentView = nil }
        hosting.layoutSubtreeIfNeeded()
        let web = try XCTUnwrap(webView(in: hosting))
        web.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16); window.cancelAnimationFrame = (id) => clearTimeout(id);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        try await Task.sleep(nanoseconds: 1_000_000_000)
        web.reload()

        let state = "const button = roots.flatMap(r => [...r.querySelectorAll('button')]).find(b => /Show (image|code)/.test(b.textContent));" +
            " const imgs = roots.flatMap(r => [...r.querySelectorAll('img')]);" +
            " return (button ? button.textContent : 'none') + '|' + imgs.length + '|' + imgs.filter(i => i.complete && i.naturalWidth > 0).length;"
        let before = try await poll(web, state) { $0.hasPrefix("Show image") }
        XCTAssertEqual(before, "Show image|0|0", "code first: the switch offers the picture and no picture shows")

        _ = try await query(web, "roots.flatMap(r => [...r.querySelectorAll('button')]).find(b => b.textContent === 'Show image')?.click(); return '';")
        let after = try await poll(web, state) { $0 == "Show code|2|2" }
        XCTAssertEqual(after, "Show code|2|2", "after the switch: before and after pictures, both loaded through the page's scheme")
    }

    func testTheLayoutChoiceReachesThePage() async throws {
        let dir = NSHomeDirectory() + "/Applications/GenesisTools.app/Contents/Resources/diff-viewer"
        try XCTSkipUnless(FileManager.default.fileExists(atPath: dir + "/index.html"), "no installed diff page")
        setenv("GENESIS_DIFF_VIEWER_DIR", dir, 1)
        let old = (1...40).map { "line \($0)" }.joined(separator: "\n") + "\n"
        let new = old.replacingOccurrences(of: "line 7\n", with: "line seven\n")
        let file = DiffFile(id: "a.md", path: "a.md", status: .modified, additions: 1, deletions: 1, oldContents: old, newContents: new)
        let choice = Choice()
        let hosting = NSHostingView(rootView: Host(choice: choice, file: file))
        hosting.frame = NSRect(x: 0, y: 0, width: 900, height: 600)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.contentView = nil }
        hosting.layoutSubtreeIfNeeded()
        let web = try XCTUnwrap(webView(in: hosting))
        // A window that is never shown is a hidden page, and a hidden page gets no animation frames, which is where
        // pierre lays a changed diff out. Frames from timers, then a reload: the renderer sends everything again.
        web.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16); window.cancelAnimationFrame = (id) => clearTimeout(id);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true
        ))
        try await Task.sleep(nanoseconds: 1_000_000_000)
        web.reload()

        let before = try await wait(web, for: "split")
        XCTAssertTrue(before.contains("split"), "the diff opens split, the page shows \(before)")
        choice.unified = true
        hosting.layoutSubtreeIfNeeded()
        let after = try await wait(web, for: "single")
        XCTAssertTrue(after.contains("single") && !after.contains("split"), "after Unified the page shows \(after)")
    }
}
