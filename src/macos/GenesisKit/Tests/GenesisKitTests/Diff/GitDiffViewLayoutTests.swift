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
