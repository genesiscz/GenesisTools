//
//  MarkdownWebSpare.swift
//  GenesisKit
//
//  One markdown page made in a quiet moment, so a pane that opens (a tab switch, Read or Source → Split) takes a page
//  whose scripts (markdown-it, highlight.js, mermaid) are already loaded instead of creating a web view on the click.
//  Creating one runs on the main thread (140 ms median, up to 1.2 s measured in the hub) and the new page stays blank
//  until the template has loaded. A page that leaves a pane can become the spare again (`recycle`): the pane's own
//  state (marks, line highlight, column width, scroll, magnification, drop handler) is cleared first, because a page
//  keeps that state until something clears it. The next spare is made 1.5 s after one is taken, when none is waiting.
//

import AppKit
import WebKit

@MainActor
final class MarkdownWebSpare: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = MarkdownWebSpare()

    struct Taken {
        let web: MarkdownDropWebView
        /// The page already said it is ready (or finished loading) before a pane took it.
        let ready: Bool
    }

    private var web: MarkdownDropWebView?
    private var media: MarkdownMediaRegistry?
    private var ready = false
    private var scheduled = false
    /// Off in tests that count web views, and wherever a host does not want a page kept in memory.
    nonisolated(unsafe) static var enabled = true

    /// The spare, handed to `coordinator`: the page's messages and navigation go to it from now on, and it adopts the
    /// media registry the page's scheme handler was bound to. nil when no spare is ready to hand out.
    func take(for coordinator: MarkdownWebView.Coordinator) -> Taken? {
        guard Self.enabled, let web, let media, !web.isLoading || ready else {
            prepareSoon()
            return nil
        }
        self.web = nil
        self.media = nil
        let controller = web.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(coordinator, name: "bridge")
        web.navigationDelegate = coordinator
        coordinator.media = media
        let taken = Taken(web: web, ready: ready)
        ready = false
        prepareSoon()
        return taken
    }

    /// A page that left the window becomes the spare when none is waiting: its scripts are loaded, so the next tab
    /// switch renders into it at once. Building a web view on the click was 8 of the 38 stalls over 500 ms on
    /// 2026-10-15 (580 to 1799 ms each, a burst of opened tabs). Its marks, line highlight and scroll go first; the
    /// next pane's render replaces the article before the window shows it (`GenRenderSwap` waits for that render).
    func recycle(_ page: MarkdownDropWebView, media: MarkdownMediaRegistry) {
        guard Self.enabled, web == nil, !page.isLoading else { return }
        page.removeFromSuperview()
        let controller = page.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "bridge")
        controller.add(self, name: "bridge")
        page.navigationDelegate = self
        page.onDropFiles = nil
        page.magnification = 1
        // What a pane sets only when it has one (a column width, marks, a line highlight) must not carry over.
        page.evaluateJavaScript(
            "window.gnDiff([]);window.gnGitMarks([]);window.gnHighlightLines(null);window.gnWidth(null);window.scrollTo(0,0);"
        )
        web = page
        self.media = media
        ready = true
        recycled += 1
    }

    /// Pages taken back by `recycle` (tests and the log read it).
    private(set) var recycled = 0

    /// Makes the next spare a moment from now, once.
    func prepareSoon(after delay: TimeInterval = 1.5) {
        guard Self.enabled, web == nil, !scheduled else { return }
        scheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self else { return }
            self.scheduled = false
            self.prepare()
        }
    }

    private func prepare() {
        guard web == nil else { return }
        let media = MarkdownMediaRegistry()
        let controller = WKUserContentController()
        controller.add(self, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        config.setURLSchemeHandler(MarkdownWebView.AssetSchemeHandler(), forURLScheme: MarkdownWebView.assetScheme)
        config.setURLSchemeHandler(MarkdownMedia.SchemeHandler(registry: media), forURLScheme: MarkdownMedia.scheme)
        let web = MarkdownDropWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.registerForDraggedTypes(MarkdownDrop.draggedTypes)
        MarkdownWebView.prepare(web)
        ready = false
        self.web = web
        self.media = media
        web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], body["type"] as? String == "ready" else { return }
        ready = true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
    }

    /// A spare whose web process died is dropped; the next take builds a page the usual way and makes a new spare.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === web else { return }
        web = nil
        media = nil
        ready = false
    }
}
