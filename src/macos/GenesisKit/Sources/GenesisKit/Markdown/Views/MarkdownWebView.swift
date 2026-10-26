//
//  MarkdownWebView.swift
//  GenesisKit
//
//  Obsidian-parity vault reading pane. The native SwiftUI renderer couldn't do
//  mermaid diagrams, real syntax highlighting, or callouts — the user wants it
//  to look like the GenesisTools dev-dashboard shared-note renderer. So the
//  reading pane is a WKWebView that renders markdown with markdown-it +
//  highlight.js + mermaid, emitting the same HTML classes + CSS as
//  dev-dashboard/lib/obsidian (share-template.ts). JS↔Swift bridge carries
//  wikilink clicks, external links, scroll-to-heading, search blink, and a
//  scroll-spy that reports the topmost visible heading (drives the Sections tab).
//
//  OFFLINE: markdown-it / highlight.js / mermaid ship as app Resources
//  (Sources/Genesis/Resources/webview/, copied into the .app by install.ts) and
//  are served through a custom `genres://` scheme handler. A custom scheme is a
//  normal secure origin, so <script src>, CSS, and the mermaid UMD bundle all
//  load + execute with no network and none of the file:// CORS restrictions
//  that block loadHTMLString subresources. Mermaid uses the self-contained UMD
//  build (sets globalThis.mermaid, no lazy chunk imports) — not the ESM module.
//
//  PAGE EXTRAS (GenesisKitMarkdownConfiguration): a "#" beside every heading that
//  copies its link, a bar on every fenced block with its language and a Copy
//  button, the sticky line with the path of the section on screen, and link hover
//  reports for the chrome's preview. Their CSS and JS sit in "Page extras" blocks.
//

import SwiftUI
import WebKit
import Combine

/// One find-bar action. `delta` 0 starts a new search, +1 / -1 walk the matches.
/// `token` is bumped by the caller so the same query can be re-run.
struct MarkdownFindCommand: Equatable {
    var query: String
    var token: Int
    var delta: Int
    /// Match case, whole word, regex: the same rules as the source search (`SourceFind`).
    var options = MarkdownFindOptions()
    /// Find in selection. A new number makes the page take its DOM selection of
    /// that moment as the scope; nil = the whole page.
    var scope: Int? = nil
    /// Ticks on the page's right edge where the matches are.
    var scrollbarMarks = false
}

/// "Show me this body line." The token lets the same line be re-sent after a
/// render, which moves the blocks under the page's scroll position.
struct MarkdownLineSync: Equatable {
    var line: Int
    var token: Int
}

struct MarkdownWebView: NSViewRepresentable {
    /// A changed region against HEAD, as the page marks it: 0-based body lines, like `LineHighlight.Mode.blocks`.
    struct GitMark: Equatable {
        var first: Int
        var last: Int
        var kind: GitHunk.Kind
        /// The hunk's place in the list the host keeps, sent back on a click.
        var index: Int

        var json: String { "{a:\(first),b:\(last),k:'\(kind.rawValue)',i:\(index)}" }
    }

    /// A change for the rendered diff: the new text's 0-based body lines and the old text it replaced.
    struct DiffMark: Equatable, Sendable {
        var first: Int
        var last: Int
        var kind: GitHunk.Kind
        var old: String

        var json: String { "{a:\(first),b:\(last),k:'\(kind.rawValue)',old:\(MarkdownWebView.jsString(old))}" }

        /// The hunks between two notes' bodies (the frontmatter is the properties block, not part of the diff).
        static func between(old: String, new: String) -> [DiffMark] {
            let oldBody = MarkdownFrontmatter.split(old).1
            let newBody = MarkdownFrontmatter.split(new).1
            return GitHunks.between(old: oldBody, new: newBody).filter { !$0.isTrailingNewlineOnly }.map { hunk in
                DiffMark(first: hunk.newStart, last: hunk.newStart + max(1, hunk.newCount) - 1, kind: hunk.kind,
                         old: hunk.oldLines.joined(separator: "\n"))
            }
        }
    }

    /// Lines to mark, in the terms the page numbers them by (see `Mode`).
    struct LineHighlight: Equatable {
        enum Mode: String {
            /// 0-based body lines; every block whose source lines overlap is marked.
            case blocks
            /// 1-based lines of a numbered block (`lineNumbers`).
            case lines
            /// 1-based file lines of a CSV table: the header row is line 1.
            case rows
        }

        var first: Int
        var last: Int
        var mode: Mode
        var token: Int
    }

    let markdown: String
    var scrollTarget: String?
    var highlightQuery: String?
    var highlightToken: Int
    var onWikilink: (String) -> Void
    var onActiveSection: (String) -> Void
    /// A plain relative link (`[x](./x.pdf)`, `<./x.pdf>`). nil = ignored, as before.
    var onRelativeLink: ((String) -> Void)? = nil
    /// Find bar request. nil = the pane has no find bar (the vault pane).
    var findCommand: MarkdownFindCommand? = nil
    /// Reports `(index, count)` of the current match after every find command.
    var onFindResult: ((Int, Int) -> Void)? = nil
    /// The pointer rests on a link (its target and box), or left it (nil). nil = no hover reports.
    /// `href` is what a click on the link hands over: a wikilink's target (`Note#Heading`, `#Heading`),
    /// a local link as written (`./x.pdf`), or an external link's absolute URL. Nothing is reported
    /// while a mouse button is down or while the page scrolls.
    var onLinkHover: ((MarkdownLinkHover?) -> Void)? = nil
    /// Reading size, 1 = the stylesheet's own sizes.
    var zoom: Double = 1
    /// Hands the live web view to the toolbar (PDF export, print).
    var proxy: MarkdownWebProxy? = nil
    /// `--dd-*` overrides for the page. nil = the stylesheet's own dark palette.
    var cssVariables: [String: String]? = nil
    /// Reading column width in CSS px, dragged from the grips on either edge
    /// of the document. nil = the stylesheet's 860 px.
    var articleWidth: Double? = nil
    /// The width the reader dragged to; 0 means "back to the default".
    var onArticleWidth: ((Double) -> Void)? = nil
    /// The grips beside the page that drag the reading column. Off in split
    /// view, where the divider between the editor and the preview is the only
    /// boundary and the page simply fills its pane.
    var columnResizable = true
    /// Where this document was left, applied once after the first render.
    var restoreScroll: Double? = nil
    /// Reports the reading position as it changes, for the next visit.
    var onScroll: ((Double) -> Void)? = nil
    /// Split view scroll sync: the body line the editor has at its top. The
    /// page puts the block that owns that line at its own top.
    var syncLine: MarkdownLineSync? = nil
    /// A line number beside every line of a fenced block. On for a code, json,
    /// yaml or text file shown as one block, off for the code inside a note.
    var lineNumbers = false
    /// Lines to mark and scroll to (`range=`, a `#L10-L20` link).
    var lineHighlight: LineHighlight? = nil
    /// The reader clicked the page and the highlight faded out.
    var onLineHighlightCleared: (() -> Void)? = nil
    /// Bars beside the blocks that differ from HEAD. Empty: none.
    var gitMarks: [GitMark] = []
    /// The page as a rendered diff: these changes against the old text. Empty: a plain page.
    var diffMarks: [DiffMark] = []
    /// A click on a bar: the mark's `index` and its rect in the view.
    var onGitMark: ((Int, NSRect) -> Void)? = nil
    /// The vault's property keys and values as JSON, for the block's own
    /// completion. nil = no suggestions (the vault pane, tests).
    var propertyVocabulary: (() -> String)? = nil
    /// The frontmatter rows after an edit in the properties block. nil = the
    /// block is read-only (the rows still render like Obsidian's Properties).
    var onProperties: (([MarkdownProperty]) -> Void)? = nil
    /// Files dropped onto the page. nil = the page keeps AppKit's own handling.
    var onDropFiles: (([URL]) -> Void)? = nil
    /// The file being shown. Its images and JSON files resolve against its
    /// folder; nil = the page shows no local media.
    var documentURL: URL? = nil
    /// The Obsidian vault, for vault-rooted and name-only references.
    var vaultRoot: String? = nil
    /// Heading anchors, the code block bar and the sticky section. nil = what
    /// `GenesisKitMarkdownConfiguration.shared` says, followed while the page is open.
    var pageExtras: PageExtras? = nil

    /// The bridge plus both schemes: the bundled assets, and the media the
    /// coordinator registered for the current document.
    static func configuration(for coordinator: Coordinator) -> WKWebViewConfiguration {
        let controller = WKUserContentController()
        controller.add(coordinator, name: "bridge")
        let config = WKWebViewConfiguration()
        config.userContentController = controller
        // Serve the bundled markdown-it/highlight.js/mermaid via a custom scheme
        // (offline, no CDN, no file:// CORS). Base origin becomes genres://asset/.
        config.setURLSchemeHandler(AssetSchemeHandler(), forURLScheme: Self.assetScheme)
        config.setURLSchemeHandler(MarkdownMedia.SchemeHandler(registry: coordinator.media), forURLScheme: MarkdownMedia.scheme)
        return config
    }

    func makeNSView(context: Context) -> WKWebView {
        // A spare page made in a quiet moment, its scripts already loaded: creating a web view here ran on the main
        // thread on every tab switch (39% of a switch's main-thread time) and left the page blank until the template
        // loaded. Without a spare, build one as before.
        context.coordinator.renderReady = context.environment.genRenderReady
        if let spare = MarkdownWebSpare.shared.take(for: context.coordinator) {
            let web = spare.web
            web.onDropFiles = { [weak coordinator = context.coordinator] urls in
                coordinator?.parent.onDropFiles?(urls)
            }
            context.coordinator.web = web
            context.coordinator.observeConfiguration()
            proxy?.web = web
            if spare.ready {
                context.coordinator.becameReady("spare")
            } else {
                context.coordinator.armReadyWatchdog()
            }
            return web
        }
        let config = Self.configuration(for: context.coordinator)
        let web = MarkdownDropWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        // Finder drops open tabs instead of navigating the page away.
        web.registerForDraggedTypes(MarkdownDrop.draggedTypes)
        web.onDropFiles = { [weak coordinator = context.coordinator] urls in
            coordinator?.parent.onDropFiles?(urls)
        }
        Self.prepare(web)
        context.coordinator.web = web
        context.coordinator.observeConfiguration()
        proxy?.web = web
        web.loadHTMLString(Self.template, baseURL: URL(string: "\(Self.assetScheme)://asset/"))
        context.coordinator.armReadyWatchdog()
        MarkdownWebSpare.shared.prepareSoon()
        return web
    }

    /// A page leaving the window: its coordinator lets go of it, and it waits as the next spare
    /// (`MarkdownWebSpare.recycle`), so the next tab switch renders into a loaded page instead of building one.
    static func dismantleNSView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.renderReady = nil
        coordinator.hideNotice()
        coordinator.web = nil
        if coordinator.parent.proxy?.web === web {
            coordinator.parent.proxy?.web = nil
        }
        if let page = web as? MarkdownDropWebView {
            MarkdownWebSpare.shared.recycle(page, media: coordinator.media)
        }
    }

    /// Transparent, so the SwiftUI vault background shows through the margins, and pinch to zoom: a pinch magnifies the
    /// page around the fingers, past the column width, so a screenshot can be read up close (a two-finger double tap
    /// goes back). The A / 100% / A zoom is text size (`pageZoom`); it reflows, and images stay at the column width.
    static func prepare(_ web: WKWebView) {
        web.setValue(false, forKey: "drawsBackground")
        web.allowsMagnification = true
        // Safari's Develop menu can attach to the page: a render problem in the installed app can be looked at.
        if #available(macOS 13.3, *) {
            web.isInspectable = true
        }
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        let _ = RenderProbe.hit("md.webView.update")
        let c = context.coordinator
        c.parent = self
        if abs(web.pageZoom - CGFloat(zoom)) > 0.001 {
            web.pageZoom = CGFloat(zoom)
        }
        // Another document, or a step of the text zoom, starts unmagnified: a pinch never carries over.
        let magnifyKey = "\(documentURL?.path ?? "")|\(zoom)"
        if c.lastMagnifyKey != magnifyKey {
            if c.lastMagnifyKey != nil, web.magnification != 1 {
                web.magnification = 1
            }
            c.lastMagnifyKey = magnifyKey
        }
        c.renderReady = context.environment.genRenderReady
        if proxy?.web !== web {
            proxy?.web = web
        }
        if let vars = cssVariables, c.lastCSSVariables != vars {
            c.lastCSSVariables = vars
            c.applyTheme(vars)
        }
        if c.lastColumnResizable != columnResizable {
            c.lastColumnResizable = columnResizable
            c.applyGrips(columnResizable)
        }
        if c.lastArticleWidth != articleWidth {
            c.lastArticleWidth = articleWidth
            c.applyArticleWidth(articleWidth)
        }
        // Before the render below: the code block bar is drawn by the page's fence renderer.
        let extrasNeedRender = c.syncPageExtras()
        if extrasNeedRender || c.lastMarkdown != markdown || c.lastMediaContext != mediaContext || c.lastLineNumbers != lineNumbers {
            c.lastMarkdown = markdown
            c.lastMediaContext = mediaContext
            c.lastLineNumbers = lineNumbers
            c.render(markdown)
        }
        if let sync = syncLine, c.lastSyncLine != sync {
            c.lastSyncLine = sync
            c.eval("window.gnSyncLine(\(sync.line))")
        }
        if c.lastLineHighlight != lineHighlight {
            c.lastLineHighlight = lineHighlight
            c.applyLineHighlight(scroll: true)
        }
        if c.lastGitMarks != gitMarks {
            c.lastGitMarks = gitMarks
            c.applyGitMarks()
        }
        if c.lastDiffMarks != diffMarks {
            c.lastDiffMarks = diffMarks
            c.applyDiffMarks()
        }
        // nil is remembered too, so the same heading asked for again after a reset jumps again.
        if c.lastScrollTarget != scrollTarget {
            c.lastScrollTarget = scrollTarget
            if let t = scrollTarget, !t.isEmpty {
                c.scrollToHeading(t)
            }
        }
        if c.lastHighlightToken != highlightToken {
            c.lastHighlightToken = highlightToken
            if let q = highlightQuery, !q.isEmpty {
                c.eval("window.gnHighlight(\(Self.jsString(q)))")
            }
        }
        if let find = findCommand, c.lastFindToken != find.token {
            c.lastFindToken = find.token
            c.activeFindQuery = find.query.isEmpty ? nil : find.query
            c.activeFindOptions = find.jsOptions
            if find.delta == 0 {
                c.eval("window.gnFind(\(Self.jsString(find.query)),false,\(find.jsOptions))")
            } else {
                c.eval("window.gnFindStep(\(find.delta))")
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    /// A page problem: the host's log, the perf log and the unified log (`log show --predicate 'subsystem ==
    /// "genesiskit"'`), so it can be found in an app whose perf log is off.
    static func report(_ line: String) {
        GenesisKit.log("markdown page: \(line)")
        PerfLog.mark("markdown.page \(line)")
    }

    var mediaContext: MarkdownMedia.Context? {
        guard let documentURL, documentURL.isFileURL else { return nil }
        let vault = vaultRoot.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
        return MarkdownMedia.Context(folder: documentURL.deletingLastPathComponent(), vaultRoot: vault)
    }

    /// A picture the page loads from the web (`https:`), which the viewer never opens.
    static func isRemoteSource(_ src: String) -> Bool {
        let lower = src.trimmingCharacters(in: .whitespaces).lowercased()
        return lower.hasPrefix("https:") || lower.hasPrefix("http:")
    }

    static func jsString(_ s: String) -> String {
        // Encode as a JSON string literal — safe for arbitrary content.
        let data = try? JSONSerialization.data(withJSONObject: [s])
        let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
        return String(arr.dropFirst().dropLast()) // strip the surrounding [ ]
    }

    static let assetScheme = "genres"

    /// Schemes a link click in the page may hand to the system. A document is
    /// untrusted (a downloaded note), so anything else is dropped: no custom
    /// app handlers, no `file:` launches through this door.
    static let externalSchemes: Set<String> = ["http", "https", "mailto", "obsidian"]

    /// The URL an `openurl` message may open, or nil when its scheme is not allowed.
    static func externalURL(_ string: String) -> URL? {
        guard let url = URL(string: string), let scheme = url.scheme?.lowercased(),
              externalSchemes.contains(scheme) else { return nil }
        return url
    }

    /// An `openrel` message carries a path: relative, absolute, `~/…`, or a
    /// `file:` URL. Anything with another scheme belongs to `openurl`.
    static func isLocalHref(_ href: String) -> Bool {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let colon = trimmed.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*:"#, options: .regularExpression) else {
            return true
        }
        return trimmed[colon].lowercased() == "file:"
    }

    // Locate a bundled webview asset by filename. Installed app: the copy
    // install.ts drops in Contents/Resources/webview/ (Bundle.main). Dev /
    // `swift test` run-in-place: the SwiftPM resource bundle (Bundle.module).
    static func assetData(_ name: String) -> (Data, String)? {
        let mime = name.hasSuffix(".css") ? "text/css" : "text/javascript"
        if let main = Bundle.main.resourceURL?.appendingPathComponent("webview/\(name)"),
           let d = try? Data(contentsOf: main) { return (d, mime) }
        if let mod = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "webview"),
           let d = try? Data(contentsOf: mod) { return (d, mime) }
        if let mod = Bundle.module.url(forResource: name, withExtension: nil),
           let d = try? Data(contentsOf: mod) { return (d, mime) }
        return nil
    }

    final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
        func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
            guard let url = task.request.url else { return }
            let name = url.lastPathComponent
            guard let (data, mime) = MarkdownWebView.assetData(name) else {
                task.didFailWithError(NSError(domain: "genres", code: 404,
                    userInfo: [NSLocalizedDescriptionKey: "missing webview asset: \(name)"]))
                return
            }
            let resp = URLResponse(url: url, mimeType: mime,
                                   expectedContentLength: data.count, textEncodingName: "utf-8")
            task.didReceive(resp)
            task.didReceive(data)
            task.didFinish()
        }
        func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: MarkdownWebView
        weak var web: WKWebView?
        var ready = false
        /// The enclosing `GenRenderSwap`'s signal: called when a render has built the page.
        var renderReady: GenRenderReady?
        var pending: String?
        var lastMarkdown: String?
        var lastScrollTarget: String?
        var lastHighlightToken = -1
        var lastFindToken = -1
        /// Re-applied after every render, because a render replaces the marks.
        var activeFindQuery: String?
        /// The options that go with it (`MarkdownFindCommand.jsOptions`).
        var activeFindOptions = "{}"
        var lastCSSVariables: [String: String]?
        var lastArticleWidth: Double?
        var lastColumnResizable: Bool?
        var lastMagnifyKey: String?
        var lastSyncLine: MarkdownLineSync?
        var lastLineNumbers: Bool?
        var lastLineHighlight: LineHighlight?
        var lastGitMarks: [GitMark] = []
        var lastDiffMarks: [DiffMark] = []
        /// The notice over the page (`MarkdownPageNotice`), and what it shows.
        var noticeHost: MarkdownPageNoticeHost?
        var currentNotice: MarkdownPageNotice?
        var noticeToken = 0
        var noticeFrameWatch: NSObjectProtocol?

        func applyDiffMarks() {
            eval("window.gnDiff([\(lastDiffMarks.map(\.json).joined(separator: ","))])")
        }

        func applyGitMarks() {
            eval("window.gnGitMarks([\(lastGitMarks.map(\.json).joined(separator: ","))])")
        }
        var lastMediaContext: MarkdownMedia.Context?
        /// The images and JSON files the current document may load. A spare page brings its own (its media scheme
        /// handler was bound to it when the page was made).
        var media = MarkdownMediaRegistry()

        /// The page extras last sent to the page; nil until the first update.
        var lastPageExtras: PageExtras?
        private var configWatch: AnyCancellable?

        /// A setting flipped while the page is open reaches it without the host redrawing: the
        /// configuration says it is about to change, and the page follows on the next turn.
        @MainActor
        func observeConfiguration() {
            configWatch = GenesisKitMarkdownConfiguration.shared.objectWillChange.sink { [weak self] in
                DispatchQueue.main.async { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        if self.syncPageExtras(), let markdown = self.lastMarkdown {
                            self.render(markdown)
                        }
                    }
                }
            }
        }

        /// Sends the extras to the page when they changed. True when the page must render again:
        /// the code block bar is drawn by the fence renderer, not added afterwards.
        @MainActor
        func syncPageExtras() -> Bool {
            let extras = parent.pageExtras ?? PageExtras(GenesisKitMarkdownConfiguration.shared)
            guard extras != lastPageExtras else { return false }
            let barChanged = lastPageExtras.map { $0.codeBlockBar != extras.codeBlockBar } ?? false
            lastPageExtras = extras
            applyPageExtras()
            return barChanged && ready
        }

        func applyPageExtras() {
            if let extras = lastPageExtras {
                eval(extras.script)
            }
        }

        func applyGrips(_ on: Bool) {
            eval("window.gnGrips(\(on))")
        }

        func applyArticleWidth(_ width: Double?) {
            eval("window.gnWidth(\(width.map { String(Int($0)) } ?? "null"))")
        }

        func applyTheme(_ vars: [String: String]) {
            let pairs = vars.map { "\(MarkdownWebView.jsString($0.key)):\(MarkdownWebView.jsString($0.value))" }
            eval("window.gnTheme({\(pairs.joined(separator: ","))})")
        }

        init(_ parent: MarkdownWebView) { self.parent = parent }

        func applyLineHighlight(scroll: Bool) {
            guard let h = lastLineHighlight else {
                eval("window.gnHighlightLines(null)")
                return
            }
            eval("window.gnHighlightLines(\(h.first),\(h.last),'\(h.mode.rawValue)',\(scroll))")
        }

        func eval(_ js: String) {
            guard ready else { return }
            web?.evaluateJavaScript(js, completionHandler: nil)
        }

        /// The reading position is restored once per document; after that the
        /// reader (or the scroll sync) owns the scroll.
        var restored = false

        /// The tag of the last render sent to the page, and how often it was sent again because it never arrived.
        private var renderTag = 0
        private var resends = 0

        func render(_ md: String) {
            guard ready else { pending = md; return }
            renderTag += 1
            let tag = renderTag
            let (yaml, body) = MarkdownFrontmatter.split(md)
            let props = MarkdownFrontmatter.json(yaml.map(MarkdownFrontmatter.parse(yaml:)) ?? [])
            let editable = parent.onProperties != nil ? "true" : "false"
            let vocabulary = parent.propertyVocabulary?() ?? "null"
            let map = media.update(markdown: body, context: parent.mediaContext) { [weak self] in
                guard let self, self.renderTag == tag else { return }
                self.render(md)
            }
            let mediaJSON = (try? JSONSerialization.data(withJSONObject: map)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            web?.evaluateJavaScript(
                "window.gnRender(\(MarkdownWebView.jsString(body)),\(props),\(editable),\(vocabulary),\(mediaJSON),\(parent.lineNumbers),\(tag))"
            ) { [weak self] result, error in
                if let error {
                    MarkdownWebView.report("render \(tag) call failed: \(error.localizedDescription)")
                } else {
                    self?.renderReady?()
                    // A render that drew takes a failure notice away (Retry worked, or the text was fixed).
                    if (result as? String) == "ok" {
                        MainActor.assumeIsolated {
                            if self?.currentNotice?.kind == .failure { self?.hideNotice() }
                        }
                    }
                }
            }
            confirmRender(tag)
            if let q = activeFindQuery {
                // Same search, new content: keep the selected match, no scroll.
                eval("window.gnFind(\(MarkdownWebView.jsString(q)),true,\(activeFindOptions))")
            }
            // Lines asked for by a link or `range=` decide the position, not the last visit.
            if !restored, parent.lineHighlight != nil {
                restored = true
            }
            if !restored, let top = parent.restoreScroll, top > 0 {
                restored = true
                // After the layout the render just queued, not during it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    self?.eval("window.gnScrollTo(\(Int(top)))")
                }
            }
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            becameReady("didFinish")
        }

        /// A load of the page (the first one, a reload, a reload after a dead web process): nothing reaches it until it
        /// says it is ready again, and the text is sent again then.
        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            ready = false
        }

        /// A preview stuck at an empty page while the editor showed the note (Genesis Markdown and the GenesisTools
        /// viewer, 2026-10-13, in split view after a tab switch): the page had the empty first render and never the
        /// note's. So every render is checked: the page keeps the tag of the last render it got, and a render it does
        /// not have after half a second is sent again, at most three times, each one logged.
        private func confirmRender(_ tag: Int) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self, self.ready, self.renderTag == tag, let web = self.web else { return }
                web.evaluateJavaScript("window.gnRenderedTag") { [weak self] value, _ in
                    guard let self, self.renderTag == tag else { return }
                    let arrived = (value as? String) ?? "\(value ?? "nil")"
                    if arrived == String(tag) {
                        self.resends = 0
                        return
                    }
                    guard self.resends < 3, let markdown = self.lastMarkdown else {
                        MarkdownWebView.report("render \(tag) never reached the page (it has \(arrived)), giving up")
                        MainActor.assumeIsolated {
                            self.show(.failure("Render \(tag) never reached the page after 3 sends (the page has \(arrived))."))
                        }
                        return
                    }
                    self.resends += 1
                    MarkdownWebView.report("render \(tag) did not reach the page (it has \(arrived)), sending it again (\(self.resends))")
                    self.render(markdown)
                }
            }
        }

        /// The page's web process died (memory pressure): the page is blank until it loads again, and the text
        /// is sent again once it is ready.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            ready = false
            processEnds += 1
            // A page whose process ends again before it ever got ready would only loop: the reader gets Retry.
            guard processEnds < 2 else {
                MarkdownWebView.report("web process ended again before the page was ready, giving up")
                MainActor.assumeIsolated {
                    show(.failure("The page's web process ended twice before the page was ready."))
                }
                return
            }
            MarkdownWebView.report("web process ended, reloading the page")
            webView.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
            armReadyWatchdog()
        }

        private var watchdogReloads = 0
        /// Web process ends since the page was last ready.
        private var processEnds = 0

        /// Retry on the failure notice: the template again, from a clean count, and the text once it is ready.
        @MainActor
        func retryPage() {
            hideNotice()
            guard let web else { return }
            watchdogReloads = 0
            processEnds = 0
            resends = 0
            ready = false
            MarkdownWebView.report("retry: reloading the page")
            web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
            armReadyWatchdog()
        }

        /// A page that is not ready 5 s after it started loading is loaded again, at most twice.
        func armReadyWatchdog() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self, !self.ready, let web = self.web else { return }
                guard self.watchdogReloads < 2 else {
                    MarkdownWebView.report("page still not ready after \(self.watchdogReloads) reloads")
                    MainActor.assumeIsolated {
                        self.show(.failure("The page was not ready after \(self.watchdogReloads) reloads of 5 s each."))
                    }
                    return
                }
                self.watchdogReloads += 1
                MarkdownWebView.report("page not ready after 5 s, reloading (\(self.watchdogReloads))")
                web.loadHTMLString(MarkdownWebView.template, baseURL: URL(string: "\(MarkdownWebView.assetScheme)://asset/"))
                self.armReadyWatchdog()
            }
        }

        /// The first of the page's own `ready` message and the navigation's didFinish: applies what waited and
        /// renders the text. The second one finds the page ready and does nothing.
        func becameReady(_ via: String) {
            guard !ready else { return }
            ready = true
            processEnds = 0
            if let vars = lastCSSVariables {
                applyTheme(vars)
            }
            if let on = lastColumnResizable {
                applyGrips(on)
            }
            if let w = lastArticleWidth {
                applyArticleWidth(w)
            }
            // Before the render: the code block bar is part of it.
            applyPageExtras()
            if let p = pending { pending = nil; render(p) }
            else if let m = lastMarkdown { render(m) }
            if lastLineHighlight != nil {
                applyLineHighlight(scroll: true)
            }
            if !lastGitMarks.isEmpty {
                applyGitMarks()
            }
            if !lastDiffMarks.isEmpty {
                applyDiffMarks()
            }
            // A [[Note#Heading]] click opens a new pane: its target arrived
            // before the page was ready and would otherwise be dropped.
            if let t = lastScrollTarget, !t.isEmpty {
                scrollToHeading(t)
            }
        }

        /// A heading by its text or its slug (`examples-1` for the second "Examples"). The page names a heading it
        /// does not have (`deadAnchor`), so the click that asked for it gets an answer.
        func scrollToHeading(_ target: String) {
            let label = target.replacingOccurrences(of: MarkdownOutline.repeatMark, with: "")
            eval("window.gnScrollToSlug(\(MarkdownWebView.jsString(MarkdownBlocks.slugify(target))),\(MarkdownWebView.jsString(label)))")
        }

        // JS bridge.
        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            // Only the page's own script talks to Swift. Frames are stripped and
            // refused by the CSP; this is the last check if one ever appears.
            guard message.frameInfo.isMainFrame,
                  let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
            switch type {
            case "ready":
                becameReady("page")
            case "gitMark":
                guard let index = body["index"] as? Int, let web, let r = body["rect"] as? [String: Any] else { return }
                let zoom = web.pageZoom * web.magnification
                func n(_ key: String) -> CGFloat { CGFloat(r[key] as? Double ?? 0) * zoom }
                parent.onGitMark?(index, NSRect(x: n("x"), y: n("y"), width: max(4, n("w")), height: max(4, n("h"))))
            case "renderError":
                let message = body["message"] as? String ?? "?"
                let stack = body["stack"] as? String ?? ""
                MarkdownWebView.report("render failed: \(message) \(stack)")
                MainActor.assumeIsolated { show(.failure(stack.isEmpty ? message : "\(message)\n\(stack)")) }
            case "deadAnchor":
                let label = (body["label"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? body["slug"] as? String ?? ""
                MainActor.assumeIsolated { show(.noHeading(label)) }
            case "image.refused":
                let src = body["src"] as? String ?? ""
                MainActor.assumeIsolated { show(MarkdownWebView.isRemoteSource(src) ? .remotePicture(src) : .pictureGone) }
            case "propsRemoved":
                let name = body["key"] as? String ?? ""
                let notice: MarkdownPageNotice = (body["item"] as? String).map { .itemRemoved($0, from: name) }
                    ?? .propertyRemoved(name)
                MainActor.assumeIsolated { show(notice) }
            case "pageError":
                MarkdownWebView.report("page error line \(body["line"] as? Int ?? 0): \(body["message"] as? String ?? "?")")
            case "scroll":
                if let top = body["top"] as? Double { parent.onScroll?(top) }
            case "wikilink":
                if let target = body["target"] as? String { parent.onWikilink(target) }
            case "section":
                if let slug = body["slug"] as? String { parent.onActiveSection(slug) }
            case "openurl":
                guard let s = body["url"] as? String else { break }
                if let url = MarkdownWebView.externalURL(s) {
                    NSWorkspace.shared.open(url)
                } else {
                    MainActor.assumeIsolated { show(.blockedLink(s)) }
                }
            case "openrel":
                guard let href = body["href"] as? String, MarkdownWebView.isLocalHref(href) else { break }
                if let open = parent.onRelativeLink {
                    open(href)
                } else {
                    MainActor.assumeIsolated { show(.noFileLinks) }
                }
            case "json":
                // Only a token this render registered from the document's own references.
                guard let token = body["token"] as? String else { break }
                let text = media.jsonText(token)
                eval("window.gnShowJSON(\(MarkdownWebView.jsString(token)),\(text.map(MarkdownWebView.jsString) ?? "null"))")
            case "find":
                let index = body["index"] as? Int ?? 0
                let count = body["count"] as? Int ?? 0
                parent.onFindResult?(index, count)
            case "width":
                if let w = body["value"] as? Double { parent.onArticleWidth?(w) }
            case "hlcleared":
                parent.onLineHighlightCleared?()
            case "properties":
                if let props = MarkdownFrontmatter.properties(fromBridge: body["items"]) { parent.onProperties?(props) }
            case "image.press":
                // Script messages arrive on the main thread.
                MainActor.assumeIsolated { prefetchViewerImage(body) }
            case "image.open":
                MainActor.assumeIsolated { openImageViewer(body) }
            case "copy":
                // A code block's Copy button: the fenced block's own source.
                if let text = body["text"] as? String {
                    MarkdownWebView.copyToPasteboard(text)
                }
            case "anchor":
                // A heading's "#": its link, in the form the viewer's own wikilinks follow.
                if let heading = body["heading"] as? String {
                    MarkdownWebView.copyToPasteboard(MarkdownWebView.headingLink(heading, documentURL: parent.documentURL))
                }
            case "linkHover":
                parent.onLinkHover?(MarkdownWebView.linkHover(from: body, zoom: parent.zoom))
            default: break
            }
        }

        // The page itself (genres://asset/, its own #anchors) is the only thing
        // this view ever shows. A link the JS did not intercept goes to the
        // system only when its scheme is allowed; every other navigation is
        // refused, so a document can never replace the page that owns the bridge.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            let scheme = url?.scheme?.lowercased()
            let isPage = scheme == MarkdownWebView.assetScheme && ["", "/"].contains(url?.path ?? "")
            if isPage || scheme == "about" {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated,
               let url, let external = MarkdownWebView.externalURL(url.absoluteString) {
                NSWorkspace.shared.open(external)
            }
            decisionHandler(.cancel)
        }
    }
}

// MARK: - Page extras

extension MarkdownWebView {
    /// The page's own extras, which a host turns on and off in `GenesisKitMarkdownConfiguration`.
    struct PageExtras: Equatable {
        var headingAnchors: Bool
        var codeBlockBar: Bool
        var stickySection: Bool

        init(headingAnchors: Bool, codeBlockBar: Bool, stickySection: Bool) {
            self.headingAnchors = headingAnchors
            self.codeBlockBar = codeBlockBar
            self.stickySection = stickySection
        }

        @MainActor
        init(_ config: GenesisKitMarkdownConfiguration) {
            self.init(headingAnchors: config.headingAnchors, codeBlockBar: config.codeBlockBar, stickySection: config.stickySection)
        }

        /// The call that hands them to the page.
        var script: String {
            "window.gnPage({anchors:\(headingAnchors),codeBar:\(codeBlockBar),sticky:\(stickySection)})"
        }
    }

    /// The wikilink a heading's "#" copies: `[[plan#Setup]]` for `plan.md`, the form the viewer's
    /// own wikilinks follow, or `[[#Setup]]` when the page shows no file. The characters that end a
    /// wikilink or start a block reference (`[ ] | # ^`) become spaces, so the link stays one link.
    static func headingLink(_ heading: String, documentURL: URL?) -> String {
        let spaced = String(heading.map { "[]|#^".contains($0) ? " " : $0 })
        let text = spaced.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let note = documentURL.map { url in
            url.pathExtension.lowercased() == "md" ? url.deletingPathExtension().lastPathComponent : url.lastPathComponent
        } ?? ""
        return "[[\(note)#\(text)]]"
    }

    /// A `linkHover` message as the hover report: the link and its box in the web view's points
    /// (top-left origin, the page zoom applied), or nil when the pointer left the link.
    static func linkHover(from body: [String: Any], zoom: Double) -> MarkdownLinkHover? {
        guard let href = body["href"] as? String, !href.isEmpty else { return nil }
        let box = body["rect"] as? [String: Any] ?? [:]
        func points(_ key: String) -> CGFloat {
            CGFloat(((box[key] as? NSNumber)?.doubleValue ?? 0) * zoom)
        }
        return MarkdownLinkHover(href: href, rect: CGRect(x: points("x"), y: points("y"), width: points("w"), height: points("h")))
    }

    static func copyToPasteboard(_ text: String) {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
    }
}

extension MarkdownWebView {
    /// Per launch. Only the template's own inline scripts carry it, so the CSP
    /// refuses every inline handler and `javascript:` URL a document brings.
    static let scriptNonce = UUID().uuidString.replacingOccurrences(of: "-", with: "")

    static let template = templateSource.replacingOccurrences(of: "__GN_NONCE__", with: scriptNonce)

    private static let templateSource = #"""
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; script-src 'self' genres: 'nonce-__GN_NONCE__'; style-src 'self' genres: 'unsafe-inline'; font-src genres: data:; img-src gnmedia: data: https: http:; object-src 'none'; frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="genres://asset/atom-one-dark.min.css">
<script src="genres://asset/markdown-it.min.js"></script>
<script src="genres://asset/highlight.min.js"></script>
<script src="genres://asset/mermaid.min.js"></script>
<style>
:root{
  color-scheme:dark;
  --dd-bg:#0c0e10; --dd-bg-panel:#101316; --dd-bg-elevated:#161b20;
  --dd-border:#1e2428; --dd-border-strong:#2a3439;
  --dd-text:#e6edf3; --dd-text-dim:#8b96a0; --dd-text-faint:#5b6670;
  --dd-accent:#34d399; --dd-accent-2:#2dd4bf; --dd-link:#5eead4;
  --dd-tag-bg:rgba(52,211,153,0.1); --dd-tag-text:#5eead4;
  --dd-text-strong:#f4f8fb; --dd-link-underline:rgba(94,234,212,.3);
  --dd-code-bg:#0a0c0f; --dd-code-text:#e6edf3;
  --dd-sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --dd-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;padding:0;background:var(--dd-bg);color:var(--dd-text);
  font-family:var(--dd-sans);line-height:1.75;-webkit-font-smoothing:antialiased;}
body{padding:28px 30px 80px;}
/* The column is as wide as the reader last dragged it (`--gn-article-width`,
   set by window.gnWidth), never wider than the pane. The grips live in the
   30 px body padding on either side; drag one to resize, double-click to reset. */
#gn-column{position:relative;max-width:var(--gn-article-width,860px);margin:0 auto;}
article{font-size:16px;color:var(--dd-text);}
.gn-grip{position:absolute;top:0;bottom:0;width:16px;cursor:col-resize;opacity:0;transition:opacity .15s;}
.gn-grip::after{content:"";position:absolute;top:0;bottom:0;left:6px;width:3px;border-radius:2px;background:var(--dd-border-strong);}
.gn-grip:hover::after,.gn-grip.gn-active::after{background:var(--dd-accent);}
.gn-grip-l{left:-22px;} .gn-grip-r{right:-22px;}
#gn-column:hover .gn-grip,.gn-grip.gn-active,.gn-grip:focus-visible{opacity:1;}
.gn-grip:focus-visible{outline:0;} .gn-grip:focus-visible::after{background:var(--dd-accent);}
body.gn-resizing{cursor:col-resize;user-select:none;-webkit-user-select:none;}
/* Split view: the split divider is the only boundary, and the page fills
   whatever the divider left it. */
/* Property key / value suggestions, from what the vault already uses. */
#gn-suggest{position:absolute;z-index:40;min-width:160px;max-height:220px;overflow:auto;
  background:var(--dd-bg-elevated);border:1px solid var(--dd-border);border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.35);padding:4px;font-size:.92em;}
#gn-suggest div{padding:4px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;}
#gn-suggest div.gn-on,#gn-suggest div:hover{background:var(--dd-accent-soft,rgba(127,127,127,.2));color:var(--dd-text);}
body.gn-nogrips .gn-grip{display:none;}
body.gn-nogrips #gn-column{max-width:none;}
article > * + *{margin-top:1.25em;}
h1,h2,h3,h4,h5,h6{color:var(--dd-text);line-height:1.25;margin:1.5em 0 .55em;font-weight:600;scroll-margin-top:12px;}
h1{font-size:2em;border-bottom:1px solid var(--dd-border);padding-bottom:.3em;margin-top:.2em;letter-spacing:-.01em;}
h2{font-size:1.5em;border-bottom:1px solid var(--dd-border);padding-bottom:.25em;letter-spacing:-.01em;}
h3{font-size:1.22em;} h4{font-size:1.08em;color:var(--dd-text-dim);}
p{margin:.95em 0;}
a{color:var(--dd-link);text-decoration:none;border-bottom:1px solid var(--dd-link-underline);transition:border-color .15s,color .15s;}
a:hover{color:var(--dd-accent);border-bottom-color:var(--dd-accent);}
strong{color:var(--dd-text-strong);font-weight:600;} em{color:var(--dd-text);}
hr{border:0;border-top:1px solid var(--dd-border);margin:2em 0;}
ul,ol{padding-left:1.6em;margin:.95em 0;} li{margin:.45em 0;} li > ul,li > ol{margin:.35em 0;}
ul li::marker,ol li::marker{color:var(--dd-text-faint);}
blockquote{margin:1em 0;padding:.6em 1.1em;border-left:3px solid var(--dd-border-strong);
  background:rgba(255,255,255,.015);color:var(--dd-text-dim);border-radius:0 4px 4px 0;font-style:italic;}
blockquote > *{margin:.4em 0;}
code{font-family:var(--dd-mono);font-size:.88em;background:var(--dd-bg-elevated);
  border:1px solid var(--dd-border);border-radius:5px;padding:2px 7px;margin:0 1px;color:var(--dd-text-strong);
  -webkit-box-decoration-break:clone;box-decoration-break:clone;}
pre{margin:1.15em 0;padding:0;background:var(--dd-code-bg);border:1px solid var(--dd-border);
  border-radius:8px;overflow:auto;font-family:var(--dd-mono);font-size:13.5px;line-height:1.55;}
pre code,pre code.hljs{display:block;padding:14px 16px;background:transparent;border:0;border-radius:0;color:var(--dd-code-text);font-size:inherit;}
pre code.gn-numbered{padding-left:8px;}
.gn-ln{display:block;min-height:1.55em;}
.gn-ln::before{content:attr(data-ln);display:inline-block;width:var(--gn-ln-w,2ch);margin-right:1.4em;padding-left:6px;
  text-align:right;color:var(--dd-text-faint);user-select:none;-webkit-user-select:none;transition:color .5s ease-out;}
.gn-ln.gn-hl::before{color:var(--dd-accent);font-weight:600;}
#gn-hl-band{position:absolute;pointer-events:none;z-index:1;border-radius:8px;
  background:color-mix(in srgb,var(--dd-accent) 9%,transparent);
  box-shadow:inset 3px 0 0 color-mix(in srgb,var(--dd-accent) 75%,transparent);
  opacity:1;transition:opacity .5s ease-out;}
#gn-hl-band.gn-fading{opacity:0;}
table{border-collapse:collapse;margin:1.15em 0;width:100%;font-size:.95em;border-radius:8px;border:1px solid var(--dd-border);overflow:hidden;table-layout:auto;}
thead{background:var(--dd-bg-panel);}
/* A long unbreakable cell (a PDF file name, a path) used to push the table past
   the pane and give the whole document a horizontal scrollbar. Only links and
   code get broken mid-token; `anywhere` on every cell let the auto layout
   squeeze "Vendor" into two lines. */
th,td{text-align:left;padding:9px 13px;border-bottom:1px solid var(--dd-border);overflow-wrap:break-word;}
td a,td code,th code{overflow-wrap:anywhere;}
th{color:var(--dd-text);font-weight:600;} tr:last-child td{border-bottom:0;}
tbody tr:nth-child(even){background:rgba(255,255,255,.015);}
img{max-width:100%;height:auto;border-radius:6px;}
.dd-md-inline-tag{display:inline-block;background:var(--dd-tag-bg);color:var(--dd-tag-text);
  border:1px solid rgba(94,234,212,.18);border-radius:999px;padding:0 8px;font-size:.82em;font-weight:500;vertical-align:1px;}
.dd-wikilink{color:var(--dd-link);text-decoration:none;border-bottom:1px dashed var(--dd-link-underline);padding-bottom:1px;cursor:pointer;}
.dd-wikilink:hover{color:var(--dd-accent);border-bottom-color:var(--dd-accent);}
.dd-md-embed-stub{display:inline-flex;gap:8px;align-items:center;background:var(--dd-bg-panel);
  border:1px dashed var(--dd-border-strong);border-radius:6px;padding:2px 10px;color:var(--dd-text-dim);font-size:.9em;}
.dd-md-embed-icon{color:var(--dd-accent);}
.gn-img-missing{opacity:.85;border-style:dashed;}
#gn-article.gn-is-empty::after{content:"This note is empty.";display:block;color:var(--dd-text-dim);font-style:italic;}
.gn-img-pending{display:inline-block;min-width:120px;min-height:64px;border-radius:6px;background:var(--dd-bg-panel);vertical-align:middle;}
#gn-article img[data-gn-img]{cursor:zoom-in;}
#gn-article img[data-gn-img]:focus-visible{outline:2px solid var(--dd-accent);outline-offset:2px;}
a.dd-md-embed-stub{cursor:pointer;}
a.dd-md-embed-stub:hover{border-color:var(--dd-accent);color:var(--dd-accent);}
.gn-json-chip{display:inline-flex;gap:6px;align-items:center;background:var(--dd-bg-panel);border:1px solid var(--dd-border);
  border-radius:6px;padding:1px 8px;color:var(--dd-text);font:inherit;font-size:.92em;cursor:pointer;text-decoration:none;}
.gn-json-chip:hover{border-color:var(--dd-accent);color:var(--dd-accent);}
.gn-json-chip .gn-json-icon{color:var(--dd-accent);font-family:ui-monospace,monospace;font-size:.85em;}
.gn-json-panel{margin:10px 0;border:1px solid var(--dd-border);border-radius:8px;background:var(--dd-bg-panel);overflow:hidden;}
.gn-json-head{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--dd-border);
  font-size:.85em;color:var(--dd-text-dim,var(--dd-text));}
.gn-json-close{background:none;border:0;color:inherit;cursor:pointer;font-size:1.1em;line-height:1;}
.gn-json-panel pre{margin:0;border:0;border-radius:0;max-height:480px;overflow:auto;}
.markdown-alert{--cal:var(--dd-border-strong);margin:1.15em 0;padding:12px 16px 4px;
  border:1px solid color-mix(in srgb,var(--cal) 28%,transparent);border-left:4px solid var(--cal);
  border-radius:0 8px 8px 0;background:color-mix(in srgb,var(--cal) 8%,var(--dd-bg-panel));}
.markdown-alert-body > *{margin:.55em 0;} .markdown-alert-body > :first-child{margin-top:0;}
.markdown-alert-body > :last-child{margin-bottom:.4em;}
.markdown-alert:not(:has(.markdown-alert-body)){padding-bottom:12px;}
.markdown-alert-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:.97em;margin:0 0 8px;color:var(--cal);line-height:1.4;}
.markdown-alert-icon{flex:none;width:17px;height:17px;color:var(--cal);}
.markdown-alert-note{--cal:#4493f8;} .markdown-alert-abstract{--cal:#22d3ee;} .markdown-alert-info{--cal:#4493f8;}
.markdown-alert-todo{--cal:#38bdf8;} .markdown-alert-tip{--cal:#2dd4bf;} .markdown-alert-success{--cal:#34d399;}
.markdown-alert-question{--cal:#eab308;} .markdown-alert-warning{--cal:#f59e0b;} .markdown-alert-failure{--cal:#f87171;}
.markdown-alert-danger{--cal:#ef4444;} .markdown-alert-bug{--cal:#fb7185;} .markdown-alert-example{--cal:#a855f7;}
.markdown-alert-quote{--cal:var(--dd-text-dim);}
/* <details>: a fold you cannot miss. Accent bar, tinted card, a chevron, and a Show/Hide pill. */
details{--fold:#2dd4bf;margin:1.15em 0;border:1px solid color-mix(in srgb,var(--fold) 30%,var(--dd-border));
  border-left:4px solid var(--fold);border-radius:0 10px 10px 0;overflow:hidden;
  background:color-mix(in srgb,var(--fold) 6%,var(--dd-bg-panel));}
details > summary{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;font-weight:600;
  list-style:none;user-select:none;-webkit-user-select:none;}
details > summary::-webkit-details-marker{display:none;}
details > summary::before{content:"";flex:none;width:8px;height:8px;margin:0 4px 0 2px;
  border-right:2px solid var(--fold);border-bottom:2px solid var(--fold);transform:rotate(-45deg);transition:transform .15s ease;}
details[open] > summary::before{transform:rotate(45deg);}
details > summary::after{content:"Show";margin-left:auto;flex:none;font-size:.72em;font-weight:600;letter-spacing:.04em;
  text-transform:uppercase;color:var(--fold);padding:2px 9px;border-radius:999px;
  border:1px solid color-mix(in srgb,var(--fold) 45%,transparent);background:color-mix(in srgb,var(--fold) 12%,transparent);}
details[open] > summary::after{content:"Hide";}
details > summary:hover{background:color-mix(in srgb,var(--fold) 10%,transparent);}
details[open] > summary{border-bottom:1px solid color-mix(in srgb,var(--fold) 22%,var(--dd-border));}
details > :not(summary){margin-left:16px;margin-right:16px;}
details > summary + *{margin-top:12px;} details > :last-child:not(summary){margin-bottom:14px;}
/* Mermaid: render at NATURAL size and scroll (Obsidian parity) — never shrink
   the diagram to fit the column. Wide/tall diagrams get their own scrollbars. */
.mermaid{background:var(--dd-bg-panel);border:1px solid var(--dd-border);border-radius:8px;
  padding:16px;margin:1.15em 0;color:var(--dd-text-dim);font-family:var(--dd-mono);font-size:.85em;
  overflow:auto;max-height:80vh;}
.mermaid svg{max-width:none !important;width:auto;height:auto;display:block;margin:0 auto;}
.gn-flash{animation:gnflash .5s ease-in-out 2;border-radius:6px;}
@keyframes gnflash{0%,100%{background:transparent;}50%{background:rgba(255,200,110,.22);}}
mark.gn-find{background:rgba(250,204,21,.25);color:inherit;border-radius:2px;padding:0 1px;}
mark.gn-find-current{background:rgba(250,204,21,.75);color:#0c0e10;}
/* Find: match ticks on the right edge (GenesisKitMarkdownConfiguration.scrollbarMatchMarks).
   The lane is as tall as the window and stands for the whole page, like the
   scroller over it; the current match is in the accent colour, and a click on
   a tick goes to that match. Only the ticks take clicks, never the lane. */
#gn-find-ticks{position:fixed;top:0;right:0;bottom:0;width:12px;pointer-events:none;z-index:30;}
.gn-find-tick{position:absolute;right:1px;width:9px;height:3px;margin-top:-1px;border-radius:1.5px;
  background:rgba(250,204,21,.7);pointer-events:auto;cursor:pointer;}
.gn-find-tick-current{height:4px;background:var(--dd-accent);z-index:1;}
/* Properties: the frontmatter as Obsidian shows it. One row per key with a
   type icon, the key in the dim colour and the value editable in place. */
.gn-props{margin:0 0 1.4em;padding:2px 0 6px;border-bottom:1px solid var(--dd-border);font-size:.93em;}
.gn-prop{display:flex;align-items:flex-start;gap:6px;padding:2px 4px;border-radius:5px;min-height:28px;}
.gn-prop:hover{background:rgba(255,255,255,.03);}
.gn-prop-key{flex:0 0 190px;display:flex;align-items:center;gap:7px;color:var(--dd-text-dim);min-height:24px;position:relative;}
.gn-prop-icon{flex:none;width:16px;height:16px;color:var(--dd-text-faint);cursor:pointer;border-radius:4px;}
.gn-prop-icon:hover{color:var(--dd-text);}
.gn-prop-type{display:inline-flex;flex:none;padding:0;margin:0;border:0;background:transparent;color:inherit;border-radius:4px;cursor:pointer;}
.gn-prop-type:focus-visible{outline:1px solid var(--dd-accent);outline-offset:1px;}
.gn-prop-menu div:focus{outline:0;background:rgba(255,255,255,.06);}
.gn-prop-name{outline:0;padding:1px 4px;border-radius:4px;min-width:40px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.gn-prop-name:focus{background:var(--dd-bg-elevated);color:var(--dd-text);}
.gn-prop-value{flex:1 1 auto;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:4px;min-height:24px;color:var(--dd-text);}
.gn-prop-value input[type=text],.gn-prop-value input[type=number],.gn-prop-value input[type=date],.gn-prop-value input[type=datetime-local]{
  flex:1 1 auto;min-width:60px;background:transparent;border:1px solid transparent;border-radius:4px;color:var(--dd-text);
  font:inherit;padding:2px 6px;outline:0;color-scheme:dark;}
.gn-prop-value input:not([type=checkbox]):focus{background:var(--dd-bg-elevated);border-color:var(--dd-border-strong);}
.gn-prop-value input:disabled{opacity:1;color:var(--dd-text);}
.gn-prop-value input[type=checkbox]{width:15px;height:15px;margin:4px 6px;accent-color:var(--dd-accent);}
.gn-prop-value .gn-chip{display:inline-flex;align-items:center;gap:3px;background:var(--dd-bg-elevated);border:1px solid var(--dd-border);
  border-radius:4px;padding:1px 6px;font-size:.92em;color:var(--dd-text);max-width:100%;}
.gn-prop-tags .gn-chip{background:var(--dd-tag-bg);color:var(--dd-tag-text);border-color:rgba(94,234,212,.18);border-radius:999px;}
.gn-chip-x{cursor:pointer;color:var(--dd-text-faint);margin:-3px -5px -3px 0;padding:3px 5px;border:0;border-radius:4px;background:transparent;font:inherit;line-height:1;}
.gn-chip-x:hover,.gn-chip-x:focus-visible{color:var(--dd-text);background:rgba(127,127,127,.18);}
.gn-chip-x:focus-visible{outline:1px solid var(--dd-accent);outline-offset:0;}
.gn-prop-value .gn-chip-in{flex:1 1 80px;}
.gn-prop-value a{border-bottom:1px dashed var(--dd-link-underline);}
.gn-prop-remove{flex:none;opacity:0;border:0;background:transparent;color:var(--dd-text-faint);cursor:pointer;font-size:15px;line-height:1;padding:4px 7px;min-width:24px;min-height:24px;border-radius:4px;}
.gn-prop:hover .gn-prop-remove,.gn-prop:focus-within .gn-prop-remove{opacity:1;} .gn-prop-remove:hover{color:var(--dd-text);background:var(--dd-bg-elevated);}
.gn-prop-remove:focus-visible{outline:1px solid var(--dd-accent);outline-offset:-1px;}
.gn-props-add{margin:4px 0 0 4px;border:0;background:transparent;color:var(--dd-text-faint);cursor:pointer;font:inherit;font-size:.92em;padding:3px 6px;border-radius:4px;}
#gn-git-layer{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2;}
.gn-git-bar{position:absolute;width:3px;border:0;padding:0;margin:0;border-radius:2px;pointer-events:auto;cursor:pointer;}
.gn-git-bar:focus-visible{outline:2px solid var(--dd-text);outline-offset:4px;}
.gn-git-bar::after{content:'';position:absolute;left:-5px;right:-5px;top:0;bottom:0;}
.gn-git-bar[data-k="added"]{background:rgba(89,217,140,.9);}
.gn-git-bar[data-k="modified"]{background:rgba(115,166,255,.95);}
.gn-git-bar[data-k="deleted"]{width:0;height:0;border-radius:0;border-left:6px solid rgba(255,89,89,.95);border-top:4px solid transparent;border-bottom:4px solid transparent;}
.gn-git-bar[data-k="removed"]{background:rgba(255,89,89,.9);}
.gn-git-bar[data-i^="d"]{pointer-events:none;cursor:default;}
.gn-git-bar[data-i^="d"]::after{display:none;}
.gn-diff-old{margin:10px 0;opacity:.75;}
.gn-diff-old:not(.gn-diff-pair) *{text-decoration:line-through;text-decoration-color:rgba(255,89,89,.75);}
.gn-diff-old>:first-child{margin-top:0;}.gn-diff-old>:last-child{margin-bottom:0;}
mark.gn-del{background:rgba(255,89,89,.32);color:inherit;text-decoration:line-through;border-radius:2px;}
mark.gn-ins{background:rgba(89,217,140,.32);color:inherit;border-radius:2px;}
.gn-props-add:hover{color:var(--dd-text);background:var(--dd-bg-elevated);}
.gn-prop-menu{position:absolute;left:0;top:26px;z-index:5;background:var(--dd-bg-elevated);border:1px solid var(--dd-border-strong);border-radius:6px;
  padding:4px;min-width:150px;box-shadow:0 8px 24px rgba(0,0,0,.45);}
.gn-prop-menu div{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;cursor:pointer;color:var(--dd-text);white-space:nowrap;}
.gn-prop-menu div:hover{background:rgba(255,255,255,.06);} .gn-prop-menu div.gn-cur{color:var(--dd-accent);}
.gn-props.gn-ro .gn-prop-remove,.gn-props.gn-ro .gn-props-add,.gn-props.gn-ro .gn-chip-x,.gn-props.gn-ro .gn-chip-in{display:none;}
.gn-props.gn-ro .gn-prop-icon{cursor:default;}
/* ---- Page extras: heading anchors, code block bar, sticky section ------------------
   Switched by window.gnPage (GenesisKitMarkdownConfiguration). The labels come from
   attributes through ::before/::after, so the find and a text copy never see them. */
:root{--gn-sticky-h:30px;}
h1,h2,h3,h4,h5,h6{position:relative;}
.gn-anchor{display:none;position:absolute;left:-26px;top:0;width:22px;height:1.25em;margin:0;padding:0;border:0;border-radius:5px;
  font:inherit;background:transparent;color:var(--dd-text-faint);cursor:pointer;align-items:center;justify-content:center;
  opacity:0;transition:opacity .12s ease-out,color .12s ease-out;}
body.gn-anchors .gn-anchor{display:flex;}
.gn-anchor::before{content:"#";font-family:var(--dd-sans);font-size:15px;font-weight:600;line-height:1;}
h1:hover > .gn-anchor,h2:hover > .gn-anchor,h3:hover > .gn-anchor,h4:hover > .gn-anchor,h5:hover > .gn-anchor,h6:hover > .gn-anchor,
.gn-anchor:focus-visible{opacity:1;}
.gn-anchor:hover{color:var(--dd-accent);}
.gn-anchor:focus-visible{outline:1px solid var(--dd-accent);outline-offset:-1px;}
#gn-toast{position:absolute;z-index:60;pointer-events:none;padding:2px 8px;border-radius:6px;transform:translateY(-50%);
  font:600 11.5px/1.5 var(--dd-sans);color:var(--dd-bg);background:var(--dd-accent);opacity:0;transition:opacity .15s ease-out;}
#gn-toast.gn-on{opacity:1;}
/* Read by VoiceOver only: what a button did ("Copied"). */
#gn-live{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.gn-code{margin:1.15em 0;background:var(--dd-code-bg);border:1px solid var(--dd-border);border-radius:8px;overflow:hidden;}
.gn-code > pre{margin:0;border:0;border-radius:0;}
.gn-code-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;height:30px;padding:0 6px 0 14px;
  background:var(--dd-bg-panel);border-bottom:1px solid var(--dd-border);user-select:none;-webkit-user-select:none;}
.gn-code-lang::before{content:attr(data-lang);font-family:var(--dd-mono);font-size:11.5px;color:var(--dd-text-faint);letter-spacing:.02em;}
.gn-code-copy{display:inline-flex;align-items:center;gap:5px;margin:0;padding:3px 8px;border:0;border-radius:5px;background:transparent;
  color:var(--dd-text-dim);font:500 11.5px/1.4 var(--dd-sans);cursor:pointer;transition:color .12s ease-out,background-color .12s ease-out;}
.gn-code-copy::after{content:attr(data-label);}
.gn-code-copy:hover{color:var(--dd-text);background:var(--dd-bg-elevated);}
.gn-code-copy.gn-done{color:var(--dd-accent);}
.gn-code-copy:focus-visible{outline:1px solid var(--dd-accent);outline-offset:-1px;}
#gn-sticky{position:fixed;top:0;left:0;right:0;z-index:30;height:var(--gn-sticky-h);padding:0 30px;
  background:color-mix(in srgb,var(--dd-bg) 88%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--dd-border);visibility:hidden;opacity:0;transform:translateY(-6px);
  transition:opacity .15s ease-out,transform .15s ease-out,visibility 0s linear .15s;}
#gn-sticky.gn-on{visibility:visible;opacity:1;transform:none;transition-delay:0s;}
.gn-sticky-in{display:flex;align-items:center;gap:2px;height:100%;min-width:0;max-width:var(--gn-article-width,860px);margin:0 auto;
  font-size:12.5px;color:var(--dd-text-dim);}
body.gn-nogrips .gn-sticky-in{max-width:none;}
.gn-sticky-part{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin:0;padding:2px 6px;border:0;
  border-radius:5px;background:transparent;color:inherit;font:inherit;cursor:pointer;}
.gn-sticky-part:last-child{color:var(--dd-text);font-weight:600;}
.gn-sticky-part:hover{color:var(--dd-accent);background:var(--dd-bg-elevated);}
.gn-sticky-part:focus-visible{outline:1px solid var(--dd-accent);outline-offset:-1px;}
.gn-sticky-sep{flex:none;color:var(--dd-text-faint);}
/* A jump leaves the bar's height free above the heading, so the bar never covers it. */
body.gn-sticky-on h1,body.gn-sticky-on h2,body.gn-sticky-on h3,body.gn-sticky-on h4,body.gn-sticky-on h5,body.gn-sticky-on h6{
  scroll-margin-top:calc(var(--gn-sticky-h) + 12px);}
@media (prefers-reduced-motion:reduce){.gn-anchor,#gn-toast,.gn-code-copy,#gn-sticky,details > summary::before{transition:none;}}
@media (prefers-reduced-transparency:reduce){#gn-sticky{background:var(--dd-bg);-webkit-backdrop-filter:none;backdrop-filter:none;}}
@media print{#gn-sticky,#gn-toast,.gn-anchor,.gn-code-copy{display:none !important;}}
body.gn-export #gn-sticky,body.gn-export #gn-toast,body.gn-export .gn-anchor,body.gn-export .gn-code-copy{display:none !important;}
</style>
</head>
<body>
<div id="gn-column"><div class="gn-grip gn-grip-l" role="separator" aria-orientation="vertical" aria-label="Reading width" aria-keyshortcuts="ArrowLeft ArrowRight Enter" tabindex="0"></div><article id="gn-article"></article><div class="gn-grip gn-grip-r" role="separator" aria-orientation="vertical" aria-label="Reading width" aria-keyshortcuts="ArrowLeft ArrowRight Enter" tabindex="0"></div></div>
<nav id="gn-sticky" aria-label="Current section"><div class="gn-sticky-in"></div></nav><div id="gn-toast" role="status" aria-live="polite"></div><div id="gn-live" role="status" aria-live="polite"></div>
<script nonce="__GN_NONCE__">
// mermaid.min.js (UMD) already set globalThis.mermaid synchronously above.
if(window.mermaid){
  window.mermaid.initialize({startOnLoad:false,theme:"dark",
    flowchart:{useMaxWidth:false},sequence:{useMaxWidth:false},class:{useMaxWidth:false},
    er:{useMaxWidth:false},state:{useMaxWidth:false},gantt:{useMaxWidth:false},
    journey:{useMaxWidth:false},themeVariables:{
    background:"#101316",primaryColor:"#101316",primaryTextColor:"#e6edf3",primaryBorderColor:"#34d399",
    lineColor:"#5b6670",secondaryColor:"#161b20",tertiaryColor:"#0c0e10",nodeBorder:"#34d399",
    clusterBkg:"#101316",clusterBorder:"#1e2428"},securityLevel:"strict"});
  window.gnMermaid = window.mermaid;
  if(window.gnRunMermaid) window.gnRunMermaid();
}
</script>
<script nonce="__GN_NONCE__">
(function(){
function gnEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function gnSlug(s){return String(s).toLowerCase().replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-');}
// Heading ids are unique per render: the second "Examples" is examples-1, the third examples-2, and a suffix
// already taken moves on. MarkdownBlocks.uniqueSlugs does the same for the outline, so a row names one heading.
var gnSlugSeen={};
function gnUniqueSlug(s){var c=s,n=0;while(Object.prototype.hasOwnProperty.call(gnSlugSeen,c)){n++;c=s+'-'+n;}gnSlugSeen[c]=1;return c;}
function gnPost(m){try{window.webkit.messageHandlers.bridge.postMessage(m);}catch(e){}}
var HLJS_ALIAS={ts:"typescript",tsx:"typescript",js:"javascript",jsx:"javascript",sh:"bash",shell:"bash",zsh:"bash",yml:"yaml",rb:"ruby",py:"python",rs:"rust",toml:"ini",conf:"ini",text:"plaintext",log:"plaintext"};
var GN_ALIAS={note:"note",abstract:"abstract",summary:"abstract",tldr:"abstract",info:"info",todo:"todo",
  tip:"tip",hint:"tip",important:"tip",idea:"tip",success:"success",check:"success",done:"success",
  question:"question",help:"question",faq:"question",warning:"warning",caution:"warning",attention:"warning",
  failure:"failure",fail:"failure",missing:"failure",danger:"danger",error:"danger",bug:"bug",example:"example",quote:"quote",cite:"quote"};
var GN_ICON={
  note:'<path d="M3 5a2 2 0 0 1 2-2h10l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  abstract:'<path d="M5 3h11l3 3v15H5z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  todo:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  tip:'<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12c1 1 1 2 1 3h6c0-1 0-2 1-3a7 7 0 0 0-4-12z"/>',
  success:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  question:'<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  warning:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  failure:'<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  danger:'<path d="M12 2 2 20h20z"/><path d="M12 9v4M12 17h.01"/>',
  bug:'<path d="M8 6h8M6 10h12M6 14h12M9 4l1 2M15 4l-1 2"/><rect x="7" y="6" width="10" height="12" rx="5"/>',
  example:'<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  quote:'<path d="M7 7h4v4c0 3-2 5-4 5M15 7h4v4c0 3-2 5-4 5"/>'};

var md=window.markdownit({html:true,linkify:true,breaks:false});
// markdown-it drops file: links by default, so `[x.ts:147](file:///…#L147)` rendered as text. Swift opens them (openrel).
var gnValidateLink=md.validateLink;md.validateLink=function(url){return /^file:/i.test(String(url).trim())||gnValidateLink(url);};

md.renderer.rules.heading_open=function(tokens,idx,options,env,self){
  var inline=tokens[idx+1];
  var text=(inline&&inline.content)?inline.content:'';
  tokens[idx].attrSet('id',gnUniqueSlug(gnSlug(text)));
  return self.renderToken(tokens,idx,options);
};
// A file shown as one code block (json, yaml, a source file, a log) numbers
// its lines. Each line becomes its own element, so a highlight.js span that
// runs over a line break (a block comment, a multi-line string) is closed at
// the end of the line and opened again on the next one.
var gnCodeLines=false;
function gnNumberLines(html){
  var lines=html.split('\n');
  if(lines.length>1&&lines[lines.length-1]==='')lines.pop();
  var open=[],out=[],width=String(lines.length).length;
  for(var i=0;i<lines.length;i++){
    var prefix=open.join(''),re=/<(\/?)span([^>]*)>/g,m;
    while((m=re.exec(lines[i]))){if(m[1])open.pop();else open.push('<span'+m[2]+'>');}
    var suffix='';for(var k=0;k<open.length;k++)suffix+='</span>';
    out.push('<span class="gn-ln" data-ln="'+(i+1)+'" style="--gn-ln-w:'+width+'ch">'+prefix+lines[i]+suffix+'</span>');
  }
  return out.join('');
}
md.renderer.rules.fence=function(tokens,idx){
  var t=tokens[idx];var info=(t.info||'').trim().split(/\s+/)[0];
  if(info==='mermaid') return '<div class="mermaid">'+gnEsc(t.content)+'</div>';
  var lang=HLJS_ALIAS[info]||info;var body;
  if(window.hljs&&lang&&window.hljs.getLanguage(lang)){body=window.hljs.highlight(t.content,{language:lang}).value;}
  else{body=gnEsc(t.content);}
  if(gnCodeLines)return '<pre><code class="hljs gn-numbered language-'+gnEsc(info)+'">'+gnNumberLines(body)+'</code></pre>';
  var pre='<pre><code class="hljs language-'+gnEsc(info)+'">'+body+'</code></pre>';
  // The bar (language, Copy) sits above the block, outside its scroller. See "Page extras".
  return gnOpt.codeBar?gnCodeBlock(info,pre,t.content):pre;
};
// Split view scroll sync: every top-level block carries the source line it
// started on, so Swift can say "the editor is at line N" and the page can put
// the matching block at the top. Same idea as VS Code's markdown preview.
(function(){
  var LINED=['paragraph_open','heading_open','blockquote_open','bullet_list_open',
             'ordered_list_open','list_item_open','table_open','tr_open','hr','html_block'];
  for(var i=0;i<LINED.length;i++){(function(name){
    var base=md.renderer.rules[name];
    md.renderer.rules[name]=function(tokens,idx,options,env,self){
      var t=tokens[idx];
      if(t.map){t.attrSet('data-line',String(gnSourceLine(t.map[0])));t.attrSet('data-line-end',String(gnSourceLine(t.map[1])));}
      return base?base(tokens,idx,options,env,self):self.renderToken(tokens,idx,options,env,self);
    };
  })(LINED[i]);}
  var fence=md.renderer.rules.fence;
  md.renderer.rules.fence=function(tokens,idx,options,env,self){
    var html=fence(tokens,idx,options,env,self);var t=tokens[idx];
    // A block with a code bar is marked on its wrapper, so the scroll sync and the line band take the bar along.
    if(t.map){var at=' data-line="'+gnSourceLine(t.map[0])+'" data-line-end="'+gnSourceLine(t.map[1])+'"';
      if(html.indexOf('<div class="gn-code">')===0)html=html.replace('<div class="gn-code">','<div class="gn-code"'+at+'>');
      else html=html.replace('<pre>','<pre'+at+'>').replace('<div class="mermaid">','<div class="mermaid"'+at+'>');}
    return html;
  };
})();

md.inline.ruler.before('link','wikilink',function(state,silent){
  var src=state.src,pos=state.pos;
  if(src.charCodeAt(pos)!==0x5B&&!(src.charCodeAt(pos)===0x21&&src.charCodeAt(pos+1)===0x5B))return false;
  // The note may be empty: [[#Heading]] points into this note.
  var m=/^!?\[\[([^\]\|#]*)(?:#([^\]\|]+))?(?:\|([^\]]+))?\]\]/.exec(src.slice(pos));
  if(!m||(!m[1].trim()&&!m[2]))return false;
  if(!silent){var tok=state.push('wikilink','',0);tok.meta={embed:src[pos]==='!',target:m[1].trim(),heading:m[2]||'',alias:m[3]||''};}
  state.pos+=m[0].length;return true;
});
md.renderer.rules.wikilink=function(tokens,idx){
  var meta=tokens[idx].meta;
  var label=meta.alias||(meta.heading?(meta.target?meta.target+' › '+meta.heading:meta.heading):meta.target);
  var hit=gnMedia[gnMediaKey(meta.target)];
  if(meta.embed&&hit&&hit.kind==='image'){
    // `![[x.png|600]]` / `|600x400` is a size in Obsidian, not a caption.
    var size=/^\s*(\d+)(?:x(\d+))?\s*$/.exec(meta.alias||'');
    return '<img data-gn-ref="'+gnEsc(meta.target)+'" alt="'+gnEsc(size?meta.target:label)+'"'
      +(size?' width="'+size[1]+'"'+(size[2]?' height="'+size[2]+'"':''):'')+'>';
  }
  if(hit&&hit.kind==='json')return gnJSONChip(hit,meta.alias||meta.target);
  if(meta.embed&&hit&&hit.kind==='pending')return gnPendingHTML(meta.target);
  if(meta.embed&&GN_IMG_EXT.test(meta.target))return gnMissingImage(meta.target).outerHTML;
  if(meta.embed){
    // `![[Other note]]`: drawn as a stub, and a click opens the note like its wikilink.
    var eref=meta.target+(meta.heading?'#'+meta.heading:'');
    return '<a href="#" class="dd-wikilink dd-md-embed-stub" data-wikilink="'+gnEsc(eref)+'" title="Open '+gnEsc(meta.target)+'"><span class="dd-md-embed-icon" aria-hidden="true">⧉</span> '+gnEsc(label)+'</a>';
  }
  var ref=meta.target+(meta.heading?'#'+meta.heading:'');
  return '<a href="#" class="dd-wikilink" data-wikilink="'+gnEsc(ref)+'">'+gnEsc(label)+'</a>';
};

// Source line of a line in the text markdown-it saw: the same number, unless
// gnExtractCallouts had to add a line (then gnLineMap says where each came from).
var gnLineMap=null;
function gnSourceLine(n){
  if(!gnLineMap)return n;
  return n<gnLineMap.length?gnLineMap[n]:gnLineMap[gnLineMap.length-1]+(n-gnLineMap.length+1);
}
function gnExtractCallouts(text){
  var lines=text.split('\n'),out=[],map=[],callouts=[],added=false,i=0;
  while(i<lines.length){
    var head=/^ {0,3}> ?\[!([A-Za-z][\w-]*)\]([-+])?[ \t]*(.*)$/.exec(lines[i]);
    if(head){
      var start=i,type=head[1],title=head[3]||'',body=[];i++;
      while(i<lines.length&&/^ {0,3}>/.test(lines[i])){body.push(lines[i].replace(/^ {0,3}> ?/,''));i++;}
      callouts.push({type:type,title:title,body:body.join('\n')});
      out.push('@@GNCALLOUT'+(callouts.length-1)+'@@');map.push(start);
      // One placeholder line per callout line, so every data-line after the
      // callout still names the source line it came from.
      for(var pad=1;pad<body.length+1;pad++){out.push('');map.push(start+pad);}
      // A callout ends at its last `>` line, but a line right under it (no
      // blank line, often a numbered list) would continue the placeholder's
      // paragraph, and the placeholder would show as text. A blank line keeps
      // it a paragraph of its own; gnLineMap keeps the source lines right.
      if(i<lines.length&&lines[i].trim()!==''&&out[out.length-1]!==''){out.push('');map.push(i);added=true;}
    }else{out.push(lines[i]);map.push(i);i++;}
  }
  return {text:out.join('\n'),callouts:callouts,lineMap:added?map:null};
}
function gnRenderCallout(c,attrs){
  var group=GN_ALIAS[c.type.toLowerCase()]||'note';
  var icon=GN_ICON[group]||GN_ICON.note;
  var title=(c.title||'').trim()||(c.type.charAt(0).toUpperCase()+c.type.slice(1));
  var bodyHtml=c.body.trim()?'<div class="markdown-alert-body">'+md.render(c.body)+'</div>':'';
  return '<div class="markdown-alert markdown-alert-'+group+'" data-callout="'+gnEsc(c.type)+'"'+(attrs||'')+'>'
    +'<p class="markdown-alert-title"><svg class="markdown-alert-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+icon+'</svg><span>'+gnEsc(title)+'</span></p>'+bodyHtml+'</div>';
}

// A document is untrusted (a downloaded note), and this page holds the native
// bridge. markdown-it keeps raw HTML for Obsidian parity (<details>, <kbd>,
// <br>, inline styles), so the rendered HTML is parsed inert in a <template>
// and scrubbed before it reaches the page: no script, frames, plugins, forms
// or <meta>/<base>, no on* handlers, no javascript:/vbscript: URLs, and no
// data: URL other than an image. The CSP in <head> is the second wall.
var GN_DROP={script:1,iframe:1,frame:1,frameset:1,object:1,embed:1,applet:1,base:1,meta:1,link:1,
  form:1,portal:1,template:1,set:1,animate:1,animatemotion:1,animatetransform:1,foreignobject:1};
var GN_URL_ATTR={href:1,'xlink:href':1,src:1,action:1,formaction:1,poster:1,background:1,cite:1,data:1,codebase:1};
// A <summary> sits inside a raw HTML block, which markdown-it never parses, so `code` and **bold**
// in a title stayed literal. Run each text node of a summary through the inline renderer, then the
// same sanitizer, so the title reads like the rest of the note.
function gnSummaryMarkdown(frag){
  var sums=frag.querySelectorAll('details > summary');
  for(var i=0;i<sums.length;i++){
    var kids=Array.prototype.slice.call(sums[i].childNodes);
    for(var j=0;j<kids.length;j++){
      var n=kids[j];
      if(n.nodeType!==3||!/[`*_\[~]/.test(n.nodeValue))continue;
      n.parentNode.replaceChild(gnSanitize(md.renderInline(n.nodeValue)),n);
    }
  }
  return frag;
}
function gnSanitize(html){
  var tpl=document.createElement('template');tpl.innerHTML=html;
  var all=tpl.content.querySelectorAll('*');
  for(var i=0;i<all.length;i++){
    var el=all[i];
    if(GN_DROP[el.localName.toLowerCase()]){if(el.parentNode)el.parentNode.removeChild(el);continue;}
    for(var j=el.attributes.length-1;j>=0;j--){
      var name=el.attributes[j].name.toLowerCase();
      var v=el.attributes[j].value.replace(/[\x00-\x20\x7f-\xa0]+/g,'').toLowerCase();
      if(name.indexOf('on')===0||name==='srcdoc'||/^(javascript|vbscript|livescript):/.test(v)
         ||(GN_URL_ATTR[name]&&v.indexOf('data:')===0&&v.indexOf('data:image/')!==0)){
        el.removeAttribute(el.attributes[j].name);
      }
    }
  }
  return tpl.content;
}

// Local media. Swift reads the document's own image and JSON references,
// resolves them, and hands over key -> {kind, name, token, src}. A local
// reference it did not resolve is shown as missing; the page never builds a
// file URL itself, and gnmedia: serves only the tokens in this map.
var gnMedia={};
var GN_IMG_EXT=/\.(webp|png|jpe?g|gif|avif|svg)$/i;
function gnMediaKey(s){
  s=String(s||'').trim();
  if(s.charAt(0)==='<'&&s.charAt(s.length-1)==='>')s=s.slice(1,-1);
  if(!/^file:/i.test(s)){var h=s.indexOf('#');if(h>=0)s=s.slice(0,h);}
  try{s=decodeURIComponent(s);}catch(e){}
  return s.trim();
}
function gnJSONChip(hit,label){
  return '<button type="button" class="gn-json-chip" aria-expanded="false" data-gn-json="'+gnEsc(hit.token)+'" title="'+gnEsc(hit.name)+'">'
    +'<span class="gn-json-icon">{ }</span> '+gnEsc(label||hit.name)+'</button>';
}
// A picture that is not there says so in its own words, not only in a tooltip, so VoiceOver reads it too.
function gnMissingImage(ref,alt,why){
  var text=(why||'Picture not found')+': '+(alt||ref);
  var s=document.createElement('span');s.className='dd-md-embed-stub gn-img-missing';s.title=ref;
  s.setAttribute('role','img');s.setAttribute('aria-label',text);
  s.innerHTML='<span class="dd-md-embed-icon" aria-hidden="true">⧉</span> ';s.appendChild(document.createTextNode(text));return s;
}
// The vault scan has not answered yet: a quiet box, no "not found", until Swift renders again.
function gnPendingHTML(ref){
  return '<span class="gn-img-pending" role="img" aria-label="Loading picture '+gnEsc(ref)+'"></span>';
}
function gnApplyMedia(frag){
  var imgs=frag.querySelectorAll('img');var viewable=0;
  for(var i=0;i<imgs.length;i++){
    var img=imgs[i];var ref=img.getAttribute('data-gn-ref')||img.getAttribute('src')||'';
    img.removeAttribute('data-gn-ref');img.removeAttribute('srcset');img.removeAttribute('data-gn-img');
    var hit=gnMedia[gnMediaKey(ref)];
    if(hit&&hit.kind==='image'){img.setAttribute('src',hit.src);}
    else if(hit&&hit.kind==='pending'){var tp=document.createElement('template');tp.innerHTML=gnPendingHTML(ref);img.parentNode.replaceChild(tp.content.firstChild,img);continue;}
    else if(!/^(https?:|data:image\/)/i.test(ref.trim())){img.parentNode.replaceChild(gnMissingImage(ref,img.getAttribute('alt')),img);continue;}
    // A file over the size limit, one deleted since the render, a web picture that does not load: the pill
    // with the cause, never the browser's broken-picture glyph.
    // The element stays (hidden), so the page keeps what the note wrote.
    (function(im,r){im.addEventListener('error',function(){if(!im.parentNode||im.gnFailed)return;im.gnFailed=true;
      im.style.display='none';im.parentNode.insertBefore(gnMissingImage(r,im.getAttribute('alt'),'Picture could not be loaded'),im.nextSibling);});})(img,ref);
    // The image viewer opens only what the page loads itself: a registered vault picture or an embedded one.
    // Return or Space opens it too, so the keyboard and VoiceOver reach it.
    if(/^(gnmedia:|data:image\/)/i.test(img.getAttribute('src')||'')){img.setAttribute('data-gn-img',String(viewable++));
      img.setAttribute('tabindex','0');img.setAttribute('role','button');
      img.setAttribute('aria-label','Open picture'+((img.getAttribute('alt')||'').trim()?' '+img.getAttribute('alt').trim():''));}
    // `![caption|300](x.png)`: Obsidian's size suffix on the alt text.
    var alt=img.getAttribute('alt')||'';var size=/\|\s*(\d+)(?:x(\d+))?\s*$/.exec(alt);
    if(size){img.setAttribute('alt',alt.slice(0,size.index).trim());img.setAttribute('width',size[1]);if(size[2])img.setAttribute('height',size[2]);}
  }
  var links=frag.querySelectorAll('a[href]:not(.dd-wikilink)');
  for(var j=0;j<links.length;j++){
    var a=links[j];var jh=gnMedia[gnMediaKey(a.getAttribute('href'))];
    if(!jh||jh.kind!=='json')continue;
    var t=document.createElement('template');t.innerHTML=gnJSONChip(jh,a.textContent);
    a.parentNode.replaceChild(t.content.firstChild,a);
  }
  return frag;
}
function gnWireJSON(){
  var chips=document.querySelectorAll('#gn-article .gn-json-chip[data-gn-json]');
  for(var i=0;i<chips.length;i++){(function(c){c.addEventListener('click',function(e){e.preventDefault();
    if(c.gnPanel&&c.gnPanel.parentNode){c.gnPanel.parentNode.removeChild(c.gnPanel);c.gnPanel=null;c.setAttribute('aria-expanded','false');return;}
    gnJSONPending=c;gnPost({type:'json',token:c.getAttribute('data-gn-json')});});})(chips[i]);}
}
var gnJSONPending=null;
// Swift's answer to a chip click: the file's text, or null when it could not be read.
window.gnShowJSON=function(token,text){
  var chip=gnJSONPending&&gnJSONPending.getAttribute('data-gn-json')===token?gnJSONPending
    :document.querySelector('#gn-article .gn-json-chip[data-gn-json="'+token.replace(/[^a-z0-9-]/gi,'')+'"]');
  gnJSONPending=null;
  if(!chip)return;
  if(chip.gnPanel&&chip.gnPanel.parentNode)chip.gnPanel.parentNode.removeChild(chip.gnPanel);
  var body;
  if(text==null){body='<p class="gn-json-error">This file could not be read.</p>';}
  else{
    var pretty=text;try{pretty=JSON.stringify(JSON.parse(text),null,2);}catch(e){}
    var code=window.hljs?window.hljs.highlight(pretty,{language:'json'}).value:gnEsc(pretty);
    body='<pre><code class="hljs language-json">'+code+'</code></pre>';
  }
  var panel=document.createElement('div');panel.className='gn-json-panel';
  // A disclosure: the chip says whether its panel is open and which element it is.
  panel.id='gn-json-panel-'+token.replace(/[^a-z0-9-]/gi,'');
  chip.setAttribute('aria-controls',panel.id);chip.setAttribute('aria-expanded','true');
  panel.innerHTML='<div class="gn-json-head"><span></span><button type="button" class="gn-json-close" aria-label="Close">×</button></div>'+body;
  panel.querySelector('.gn-json-head span').textContent=chip.getAttribute('title')||'';
  // Closing removes the focused button with the panel, so focus goes back to the chip that opened it.
  panel.querySelector('.gn-json-close').addEventListener('click',function(){panel.parentNode&&panel.parentNode.removeChild(panel);chip.gnPanel=null;chip.setAttribute('aria-expanded','false');chip.focus();});
  var host=chip.closest('p,li,td,th,h1,h2,h3,h4,h5,h6')||chip;
  if(host.localName==='li')host.appendChild(panel);else host.parentNode.insertBefore(panel,host.nextSibling);
  chip.gnPanel=panel;
};
// A link with a scheme (https:, mailto:, obsidian:) goes to Swift's allow-list
// as an external URL; a path (./x.pdf, ../Notes/A.md, file:) is a local file.
var GN_SCHEME=/^[a-z][a-z0-9+.-]*:/i;
function gnWireLinks(){
  var wl=document.querySelectorAll('a.dd-wikilink[data-wikilink]');
  for(var i=0;i<wl.length;i++){(function(a){a.addEventListener('click',function(e){e.preventDefault();var t=a.getAttribute('data-wikilink');if(t.charAt(0)==='#'){window.gnScrollToSlug(gnSlug(t.slice(1)),t.slice(1));return;}gnPost({type:'wikilink',target:t});});})(wl[i]);}
  // `[Setup](#setup)`: the page's own heading, answered like a wikilink's when it is not there.
  var hl=document.querySelectorAll('#gn-article a[href^="#"]:not(.dd-wikilink)');
  for(var h=0;h<hl.length;h++){(function(a){var frag=a.getAttribute('href').slice(1);if(!frag)return;
    a.addEventListener('click',function(e){e.preventDefault();var t=frag;try{t=decodeURIComponent(frag);}catch(x){}
      window.gnScrollToSlug(gnSlug(t),t);});})(hl[h]);}
  var xl=document.querySelectorAll('a[href]:not([href^="#"]):not(.dd-wikilink)');
  for(var j=0;j<xl.length;j++){(function(a){a.addEventListener('click',function(e){e.preventDefault();
    var href=a.getAttribute('href').trim();var scheme=GN_SCHEME.exec(href);
    if(scheme&&scheme[0].toLowerCase()!=='file:')gnPost({type:'openurl',url:a.href});
    else gnPost({type:'openrel',href:href});});})(xl[j]);}
}
window.gnRunMermaid=function(){if(window.gnMermaid){try{window.gnMermaid.run({nodes:document.querySelectorAll('.mermaid')});}catch(e){}}};

var gnLastSlug='';
var gnLastPosted=-1;
function gnPostScroll(){
  var sc=document.scrollingElement||document.documentElement;
  if(Math.abs(sc.scrollTop-gnLastPosted)<8)return;
  gnLastPosted=sc.scrollTop;gnPost({type:'scroll',top:sc.scrollTop});
}
function gnOnScroll(){
  var heads=document.querySelectorAll('#gn-article h1,#gn-article h2,#gn-article h3,#gn-article h4');
  var current='';
  for(var i=0;i<heads.length;i++){var r=heads[i].getBoundingClientRect();if(r.top<=90){current=heads[i].id;}else{break;}}
  if(!current&&heads.length)current=heads[0].id;
  if(current&&current!==gnLastSlug){gnLastSlug=current;gnPost({type:'section',slug:current});}
  gnStickyUpdate();
}
// The position is posted straight away (it is one cheap number and the reader
// may close the tab in the same breath); the heavier scroll-spy waits a frame.
window.addEventListener('scroll',function(){gnPostScroll();window.requestAnimationFrame(gnOnScroll);},{passive:true});


// ---- Page extras: heading anchors, code block bar, sticky section, link hover ----
// Swift sends the reader's choices (GenesisKitMarkdownConfiguration) through gnPage before the
// first render. Nothing here puts a text node inside #gn-article: the find walks those, and a copy
// of the page must not pick up "#" or "Copy". The labels are drawn by CSS from attributes; the
// toast and the sticky bar live outside the article.
var gnOpt={anchors:false,codeBar:false,sticky:false};
// The source of every fenced block this render drew a bar for; a Copy button names its index.
var gnCodeSrc=[];
var gnMotion=window.matchMedia?window.matchMedia('(prefers-reduced-motion: reduce)'):null;
function gnScrollBehavior(){return gnMotion&&gnMotion.matches?'auto':'smooth';}
var GN_COPY_ICON='<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
window.gnPage=function(o){
  o=o||{};
  gnOpt={anchors:!!o.anchors,codeBar:!!o.codeBar,sticky:!!o.sticky};
  document.body.classList.toggle('gn-anchors',gnOpt.anchors);
  document.body.classList.toggle('gn-sticky-on',gnOpt.sticky);
  gnStickyKey=null;gnStickyUpdate();
};
function gnCodeBlock(info,pre,source){
  var i=gnCodeSrc.length;gnCodeSrc.push(String(source||'').replace(/\n$/,''));
  return '<div class="gn-code"><div class="gn-code-bar"><span class="gn-code-lang" data-lang="'+gnEsc(info)+'"></span>'
    +'<button type="button" class="gn-code-copy" data-gn-code="'+i+'" data-label="Copy" aria-label="Copy code">'+GN_COPY_ICON+'</button></div>'+pre+'</div>';
}
// After every render: a "#" button in every heading (CSS hides it while anchors are off), and the
// sticky bar and the link hover start over with the new elements.
function gnPageAfterRender(){
  var hs=document.querySelectorAll('#gn-article h1,#gn-article h2,#gn-article h3,#gn-article h4,#gn-article h5,#gn-article h6');
  for(var i=0;i<hs.length;i++){
    var b=document.createElement('button');b.type='button';b.className='gn-anchor';
    b.setAttribute('aria-label','Copy link to this heading');hs[i].appendChild(b);
  }
  gnStickyHeads=null;gnStickyKey=null;gnHoverEnd();
}
function gnHeadingText(h){return (h.textContent||'').replace(/\s+/g,' ').trim();}
function gnCopied(btn){
  var live=document.getElementById('gn-live');if(live){live.textContent='';live.textContent='Copied';}
  btn.setAttribute('data-label','Copied');btn.setAttribute('aria-label','Copied');btn.classList.add('gn-done');
  clearTimeout(btn.gnT);
  btn.gnT=setTimeout(function(){btn.setAttribute('data-label','Copy');btn.setAttribute('aria-label','Copy code');btn.classList.remove('gn-done');},1400);
}
// "Copied" beside a heading's "#", placed in the document so it scrolls with the heading it names.
var gnToastT=0;
function gnToast(near,text){
  var t=document.getElementById('gn-toast');if(!t)return;
  var r=near.getBoundingClientRect(),sc=document.scrollingElement||document.documentElement;
  t.textContent=text;
  t.style.left=Math.round(r.right+6+sc.scrollLeft)+'px';t.style.top=Math.round(r.top+r.height/2+sc.scrollTop)+'px';
  t.classList.add('gn-on');clearTimeout(gnToastT);gnToastT=setTimeout(function(){t.classList.remove('gn-on');},1200);
}
function gnScrollToHeading(el){gnNav++;el.scrollIntoView({behavior:gnScrollBehavior(),block:'start'});}
document.addEventListener('click',function(e){
  var t=e.target;if(!t||!t.closest)return;
  var copy=t.closest('#gn-article .gn-code-copy[data-gn-code]');
  if(copy){
    e.preventDefault();var src=gnCodeSrc[+copy.getAttribute('data-gn-code')];
    if(src!=null){gnPost({type:'copy',text:src});gnCopied(copy);}
    return;
  }
  var anchor=t.closest('#gn-article .gn-anchor');
  if(anchor){
    e.preventDefault();var h=anchor.parentNode;
    gnScrollToHeading(h);gnPost({type:'anchor',heading:gnHeadingText(h)});gnToast(anchor,'Copied');
    return;
  }
  var part=t.closest('#gn-sticky .gn-sticky-part');
  if(part){e.preventDefault();var el=gnStickyPath[+part.getAttribute('data-i')];if(el)gnScrollToHeading(el);}
});
// Sticky section: the path (H1 › H2 › H3) of the section at the top of the page, made of the
// headings already scrolled under the bar. gnOnScroll, which reports the active section, runs it.
var gnStickyHeads=null,gnStickyPath=[],gnStickyKey=null;
function gnStickyRoom(){
  if(!gnOpt.sticky)return 0;
  var bar=document.getElementById('gn-sticky');return bar?bar.offsetHeight:0;
}
function gnStickyUpdate(){
  var bar=document.getElementById('gn-sticky');if(!bar)return;
  var path=[],key='';
  if(gnOpt.sticky){
    if(!gnStickyHeads){
      gnStickyHeads=[];
      var hs=document.querySelectorAll('#gn-article > h1,#gn-article > h2,#gn-article > h3,#gn-article > h4,#gn-article > h5,#gn-article > h6');
      for(var i=0;i<hs.length;i++)gnStickyHeads.push({el:hs[i],level:+hs[i].localName.charAt(1)});
    }
    var limit=bar.offsetHeight,cur=-1;
    for(var j=0;j<gnStickyHeads.length;j++){if(gnStickyHeads[j].el.getBoundingClientRect().top<=limit+1)cur=j;else break;}
    if(cur>=0){
      var chain=[cur],level=gnStickyHeads[cur].level;
      for(var k=cur-1;k>=0&&level>1;k--){if(gnStickyHeads[k].level<level){chain.unshift(k);level=gnStickyHeads[k].level;}}
      for(var m=0;m<chain.length;m++){
        var h=gnStickyHeads[chain[m]].el;
        if(h.getBoundingClientRect().bottom<=limit){path.push(h);key+=chain[m]+',';}
      }
    }
  }
  if(key===gnStickyKey)return;
  gnStickyKey=key;gnStickyPath=path;
  var row=bar.firstElementChild;row.textContent='';
  for(var n=0;n<path.length;n++){
    if(n){var sep=document.createElement('span');sep.className='gn-sticky-sep';sep.setAttribute('aria-hidden','true');sep.textContent='›';row.appendChild(sep);}
    var part=document.createElement('button');part.type='button';part.className='gn-sticky-part';part.setAttribute('data-i',String(n));
    part.textContent=gnHeadingText(path[n]);part.title=part.textContent;row.appendChild(part);
  }
  bar.classList.toggle('gn-on',path.length>0);
}
// Tests call it directly: requestAnimationFrame never runs in an off-screen web view.
window.gnStickyRefresh=gnStickyUpdate;
// A PDF export draws the screen, not print media: MarkdownWebProxy turns the screen-only chrome off for it.
window.gnExportMode=function(on){document.body.classList.toggle('gn-export',!!on);};
// Link hover, for the chrome's floating preview: the link under the pointer, then null when it
// leaves. Quiet while a button is down (a drag, a selection) and while the page scrolls.
var gnHoverEl=null,gnScrollQuiet=false,gnScrollQuietT=0;
function gnHoverTarget(t){return t&&t.closest?t.closest('#gn-article a[href],#gn-article .dd-wikilink'):null;}
function gnHoverHref(a){
  if(a.hasAttribute('data-wikilink'))return a.getAttribute('data-wikilink');
  var h=(a.getAttribute('href')||'').trim();if(!h)return null;
  var s=GN_SCHEME.exec(h);return s&&s[0].toLowerCase()!=='file:'?a.href:h;
}
function gnHoverEnd(){if(!gnHoverEl)return;gnHoverEl=null;gnPost({type:'linkHover',href:null});}
document.addEventListener('mouseover',function(e){
  if(e.buttons||gnScrollQuiet)return;
  var a=gnHoverTarget(e.target);if(a===gnHoverEl)return;
  gnHoverEnd();if(!a)return;
  var href=gnHoverHref(a);if(!href)return;
  gnHoverEl=a;var r=a.getBoundingClientRect();
  gnPost({type:'linkHover',href:href,rect:{x:r.left,y:r.top,w:r.width,h:r.height}});
});
document.addEventListener('mouseout',function(e){
  if(gnHoverEl&&!(e.relatedTarget&&gnHoverEl.contains(e.relatedTarget)))gnHoverEnd();
});
document.addEventListener('mousedown',gnHoverEnd,true);
window.addEventListener('scroll',function(){
  gnScrollQuiet=true;gnHoverEnd();clearTimeout(gnScrollQuietT);
  gnScrollQuietT=setTimeout(function(){gnScrollQuiet=false;},160);
},{passive:true});

// ---- Properties (frontmatter) -------------------------------------------
// Swift parses the YAML and hands over typed rows; the page renders them like
// Obsidian's Properties and posts the whole row list back after every commit
// (blur, Enter, checkbox, chip add/remove, type change, rename, remove, add).
var PROP_ICON={
  text:'<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  number:'<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  checkbox:'<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  date:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  datetime:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M12 13v3l2 1"/>',
  list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  tags:'<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><path d="M7 7h.01"/>'};
var PROP_LABEL={text:'Text',number:'Number',checkbox:'Checkbox',date:'Date',datetime:'Date & time',list:'List',tags:'Tags'};
var gnProps=[],gnPropsEditable=false,gnPropsFocus=null;
function gnIcon(kind){return '<svg class="gn-prop-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(PROP_ICON[kind]||PROP_ICON.text)+'</svg>';}
function gnPropText(v){
  // [[Note]] inside a text value is a link, like in Obsidian.
  return gnEsc(v).replace(/\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|([^\]]+))?\]\]/g,function(m,t,a){return '<a href="#" class="dd-wikilink" data-wikilink="'+gnEsc(t.trim())+'">'+gnEsc(a||t.trim())+'</a>';});
}
// Undo is valid only while the rows still match the state just after removal.
// Normalize like the host's render, so a round trip does not invalidate Undo.
var gnPropsBefore=null,gnPropsAfter=null;
function gnPropsItems(){return gnProps.map(function(p){return {key:p.key,kind:p.kind,value:p.value||'',items:p.items||[],inline:!!p.inline};});}
function gnPropsKeep(){gnPropsBefore=JSON.parse(JSON.stringify(gnPropsItems()));gnPropsAfter=null;}
window.gnPropsUndo=function(){
  var before=gnPropsBefore,after=gnPropsAfter;gnPropsBefore=null;gnPropsAfter=null;
  if(!before||JSON.stringify(gnPropsItems())!==after)return;
  gnProps=before;gnPropsPost();
};
function gnPropsPost(){
  var items=gnPropsItems();
  if(gnPropsBefore&&gnPropsAfter===null)gnPropsAfter=JSON.stringify(items);
  gnPost({type:'properties',items:items});
}
function gnConvert(p,kind){
  var v=p.kind==='list'||p.kind==='tags'?(p.items||[]).join(', '):(p.value||'');
  var q={key:p.key,kind:kind,value:'',items:[],inline:false};
  if(kind==='list'||kind==='tags'){q.items=p.kind==='list'||p.kind==='tags'?(p.items||[]).slice():(v?[v]:[]);}
  else if(kind==='checkbox'){q.value=(v==='true')?'true':'false';}
  else if(kind==='number'){q.value=/^-?\d+(\.\d+)?$/.test(v)?v:'';}
  else if(kind==='date'){q.value=/^\d{4}-\d{2}-\d{2}/.test(v)?v.slice(0,10):'';}
  else if(kind==='datetime'){q.value=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)?v.slice(0,16):(/^\d{4}-\d{2}-\d{2}$/.test(v)?v+'T00:00':'');}
  else{q.value=v;}
  return q;
}
function gnRenderProps(props,editable){
  gnProps=props||[];gnPropsEditable=!!editable;
  var art=document.getElementById('gn-article');
  var old=document.getElementById('gn-props');if(old)old.parentNode.removeChild(old);
  if(!gnProps.length&&!gnPropsEditable)return;
  var box=document.createElement('div');box.id='gn-props';box.className='gn-props'+(gnPropsEditable?'':' gn-ro');
  gnProps.forEach(function(p,i){box.appendChild(gnPropRow(p,i));});
  if(gnPropsEditable){
    var add=document.createElement('button');add.className='gn-props-add';add.textContent='+ Add property';
    add.addEventListener('click',function(){gnProps.push({key:'',kind:'text',value:'',items:[],inline:false});
      var row=gnPropRow(gnProps[gnProps.length-1],gnProps.length-1);box.insertBefore(row,add);row.querySelector('.gn-prop-name').focus();});
    box.appendChild(add);
  }
  art.insertBefore(box,art.firstChild);
  if(gnPropsFocus){var f=gnPropsFocus;gnPropsFocus=null;
    var sel='.gn-prop[data-key="'+CSS.escape(f.key)+'"] '+f.what;var el=box.querySelector(sel);if(el){el.focus();}}
}
function gnPropRow(p,i){
  var row=document.createElement('div');row.className='gn-prop';row.setAttribute('data-key',p.key);
  var keyBox=document.createElement('div');keyBox.className='gn-prop-key';
  // Editable: the type icon is a real button, so the keyboard and VoiceOver
  // reach the type menu too.
  var iconHtml=gnPropsEditable
    ?'<button type="button" class="gn-prop-type" aria-haspopup="menu" aria-label="Property type: '+PROP_LABEL[p.kind]+'">'+gnIcon(p.kind)+'</button>'
    :gnIcon(p.kind);
  keyBox.innerHTML=iconHtml+'<span class="gn-prop-name" spellcheck="false"'+(gnPropsEditable?' contenteditable="plaintext-only" role="textbox" aria-label="Property name"':'')+'>'+gnEsc(p.key)+'</span>';
  var name=keyBox.querySelector('.gn-prop-name');
  var icon=keyBox.querySelector('.gn-prop-type');
  if(gnPropsEditable){
    name.addEventListener('keydown',function(e){
      if(gnSugKey(e))return;
      if(e.key==='Enter'){e.preventDefault();name.blur();}if(e.key==='Escape'){name.textContent=p.key;name.blur();}});
    function suggestKey(){
      gnSugOpen(name,gnSugFilter(gnSugKeys(p),(name.textContent||'').trim()),function(v){
        name.textContent=v;name.blur();});
    }
    name.addEventListener('input',suggestKey);
    name.addEventListener('focus',suggestKey);
    name.addEventListener('blur',function(){gnSugClose();});
    name.addEventListener('blur',function(){var k=(name.textContent||'').trim();
      if(!k){if(!p.key){gnProps.splice(gnProps.indexOf(p),1);row.parentNode&&row.parentNode.removeChild(row);}else{name.textContent=p.key;}return;}
      if(k!==p.key){p.key=k;row.setAttribute('data-key',k);gnPropsFocus={key:k,what:'.gn-prop-value input'};gnPropsPost();}});
    icon.addEventListener('click',function(e){e.stopPropagation();gnPropMenu(keyBox,p,icon);});
  }
  var val=document.createElement('div');val.className='gn-prop-value'+(p.kind==='tags'?' gn-prop-tags':'');
  gnPropValue(val,p);
  row.appendChild(keyBox);row.appendChild(val);
  if(gnPropsEditable){
    var rm=document.createElement('button');rm.type='button';rm.className='gn-prop-remove';rm.title='Remove property';rm.textContent='×';
    rm.setAttribute('aria-label','Remove property '+(p.key||'(unnamed)'));
    rm.addEventListener('click',function(){gnPropsKeep();gnProps.splice(gnProps.indexOf(p),1);gnPropsPost();
      gnPost({type:'propsRemoved',key:p.key||''});});
    row.appendChild(rm);
  }
  return row;
}
function gnPropMenu(anchor,p,trigger){
  var oldm=document.querySelector('.gn-prop-menu');if(oldm)oldm.parentNode.removeChild(oldm);
  var m=document.createElement('div');m.className='gn-prop-menu';m.setAttribute('role','menu');
  function dismiss(){if(m.parentNode)m.parentNode.removeChild(m);if(trigger)trigger.focus();}
  Object.keys(PROP_LABEL).forEach(function(k){var d=document.createElement('div');if(k===p.kind)d.className='gn-cur';
    d.setAttribute('role','menuitemradio');d.setAttribute('aria-checked',k===p.kind?'true':'false');d.tabIndex=-1;
    d.innerHTML=gnIcon(k)+'<span>'+PROP_LABEL[k]+'</span>';
    d.addEventListener('click',function(e){e.stopPropagation();if(k===p.kind){dismiss();return;}
      m.parentNode.removeChild(m);
      // The row is rebuilt by the next render; focus comes back to its type button.
      var q=gnConvert(p,k);var idx=gnProps.indexOf(p);gnProps[idx]=q;gnPropsFocus={key:q.key,what:'.gn-prop-type'};gnPropsPost();});
    m.appendChild(d);});
  m.addEventListener('keydown',function(e){
    var items=Array.prototype.slice.call(m.children);var at=items.indexOf(document.activeElement);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();
      items[(at+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus();}
    else if(e.key==='Enter'||e.key===' '){e.preventDefault();if(at>=0)items[at].click();}
    else if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();dismiss();}
  });
  anchor.appendChild(m);
  (m.querySelector('.gn-cur')||m.firstChild).focus();
  setTimeout(function(){document.addEventListener('click',function close(){if(m.parentNode)m.parentNode.removeChild(m);document.removeEventListener('click',close);});},0);
}
function gnPropValue(val,p){
  val.innerHTML='';
  var ro=!gnPropsEditable;
  function commit(){gnPropsPost();}
  if(p.kind==='list'||p.kind==='tags'){
    (p.items||[]).forEach(function(it,j){var c=document.createElement('span');c.className='gn-chip';
      c.innerHTML='<span>'+(p.kind==='tags'?'#':'')+gnPropText(it)+'</span><button type="button" class="gn-chip-x" title="Remove">×</button>';
      var x=c.querySelector('.gn-chip-x');x.setAttribute('aria-label','Remove '+(p.kind==='tags'?'tag ':'')+it);
      x.addEventListener('click',function(){gnPropsKeep();p.items.splice(j,1);gnPropsFocus={key:p.key,what:'.gn-chip-in'};commit();
        gnPost({type:'propsRemoved',key:p.key||'',item:String(it)});});
      val.appendChild(c);});
    if(!ro){var inp=document.createElement('input');inp.type='text';inp.className='gn-chip-in';inp.placeholder=p.items&&p.items.length?'':(p.kind==='tags'?'Add tag…':'Add item…');
      inp.setAttribute('spellcheck','false');
      inp.setAttribute('aria-label',(p.kind==='tags'?'Add tag to ':'Add item to ')+(p.key||'new property'));
      // Only a tag drops its leading '#'; a list item keeps what was typed.
      var typed=function(){var v=inp.value.trim();return p.kind==='tags'?v.replace(/^#/,''):v;};
      // One path for Enter, comma, blur and a picked suggestion. The field is
      // emptied before the commit, so a blur that follows (the render waits
      // 220 ms in split view) cannot add the same item a second time.
      var addItem=function(v,refocus){inp.value='';if(!v)return;p.items=(p.items||[]).concat([v]);
        if(refocus)gnPropsFocus={key:p.key,what:'.gn-chip-in'};commit();};
      var suggestItem=function(){
        var pool=p.kind==='tags'?(gnVocab['tags']||[]):(gnVocab[p.key]||[]);
        gnSugOpen(inp,gnSugFilter(pool.filter(function(v){return (p.items||[]).indexOf(v)<0;}),typed()),
          function(v){addItem(v,true);});
      };
      inp.addEventListener('input',suggestItem);
      inp.addEventListener('focus',suggestItem);
      inp.addEventListener('blur',function(){gnSugClose();});
      inp.addEventListener('keydown',function(e){
        if(gnSugKey(e))return;
        if(e.key==='Enter'||e.key===','){e.preventDefault();addItem(typed(),true);}
        else if(e.key==='Backspace'&&!inp.value&&p.items&&p.items.length){gnPropsKeep();var gone=p.items.pop();gnPropsFocus={key:p.key,what:'.gn-chip-in'};commit();
          gnPost({type:'propsRemoved',key:p.key||'',item:String(gone)});}});
      inp.addEventListener('blur',function(){addItem(typed(),false);});
      val.appendChild(inp);}
    return;
  }
  // The key sits in another element, so every field names its property itself.
  var label=p.key||'New property';
  if(p.kind==='checkbox'){var cb=document.createElement('input');cb.type='checkbox';cb.checked=p.value==='true';cb.disabled=ro;
    cb.setAttribute('aria-label',label);
    cb.addEventListener('change',function(){p.value=cb.checked?'true':'false';commit();});val.appendChild(cb);return;}
  if(ro&&p.kind==='text'){var span=document.createElement('span');span.innerHTML=gnPropText(p.value||'');span.style.padding='2px 6px';val.appendChild(span);return;}
  var input=document.createElement('input');
  input.type=p.kind==='number'?'number':p.kind==='date'?'date':p.kind==='datetime'?'datetime-local':'text';
  if(p.kind==='number')input.step='any';
  input.value=p.value||'';input.disabled=ro;input.setAttribute('spellcheck','false');
  input.setAttribute('aria-label',label);
  if(p.kind==='text')input.placeholder='Empty';
  var start=input.value;
  input.addEventListener('keydown',function(e){
    if(gnSugKey(e))return;
    if(e.key==='Enter'){e.preventDefault();input.blur();}if(e.key==='Escape'){input.value=start;input.blur();}});
  if(p.kind==='text'&&!ro){
    var suggestValue=function(){
      gnSugOpen(input,gnSugFilter(gnVocab[p.key],input.value),function(v){
        input.value=v;p.value=v;commit();});
    };
    input.addEventListener('input',suggestValue);
    input.addEventListener('focus',suggestValue);
  }
  input.addEventListener('blur',function(){gnSugClose();if(input.value!==p.value){p.value=input.value;commit();}});
  if(p.kind==='date'||p.kind==='datetime'||p.kind==='checkbox')input.addEventListener('change',function(){if(input.value!==p.value){p.value=input.value;commit();}});
  val.appendChild(input);
}
// ---- Property suggestions -------------------------------------------------
// The vault's own vocabulary: which keys notes use, and which values each key
// is given. Swift hands it over with every render.
var gnVocab={};
var gnSug=null,gnSugIndex=-1,gnSugPick=null;

function gnSugClose(){
  if(gnSug&&gnSug.parentNode)gnSug.parentNode.removeChild(gnSug);
  gnSug=null;gnSugIndex=-1;gnSugPick=null;
}

function gnSugOpen(anchor,values,pick){
  gnSugClose();
  if(!values||!values.length)return;
  var box=document.createElement('div');box.id='gn-suggest';
  values.slice(0,12).forEach(function(v,i){
    var item=document.createElement('div');item.textContent=v;
    if(i===0)item.className='gn-on';
    item.addEventListener('mousedown',function(e){e.preventDefault();pick(v);gnSugClose();});
    box.appendChild(item);
  });
  document.body.appendChild(box);
  var r=anchor.getBoundingClientRect();
  var sc=document.scrollingElement||document.documentElement;
  box.style.left=Math.round(r.left+sc.scrollLeft)+'px';
  box.style.top=Math.round(r.bottom+sc.scrollTop+4)+'px';
  gnSug=box;gnSugIndex=0;gnSugPick=pick;
}

/// Returns true when the key was the list's, so the field ignores it.
function gnSugKey(e){
  if(!gnSug)return false;
  var items=gnSug.children;
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    items[gnSugIndex].className='';
    gnSugIndex=(gnSugIndex+(e.key==='ArrowDown'?1:items.length-1))%items.length;
    items[gnSugIndex].className='gn-on';
    items[gnSugIndex].scrollIntoView({block:'nearest'});
    return true;
  }
  if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();var v=items[gnSugIndex].textContent;var p=gnSugPick;gnSugClose();p(v);return true;}
  if(e.key==='Escape'){gnSugClose();return true;}
  return false;
}

function gnSugFilter(list,typed){
  var q=(typed||'').toLowerCase();
  return (list||[]).filter(function(v){return q===''||v.toLowerCase().indexOf(q)>=0;})
    .sort(function(a,b){var A=a.toLowerCase().indexOf(q)===0,B=b.toLowerCase().indexOf(q)===0;return A===B?0:(A?-1:1);});
}

/// Keys the note does not already carry.
function gnSugKeys(current){
  var used={};gnProps.forEach(function(p){if(p!==current)used[p.key]=1;});
  return Object.keys(gnVocab).filter(function(k){return !used[k];});
}

window.gnProperties=function(){return gnProps;};

// Bumped by every deliberate scroll (a heading, a find match). A render's own
// scroll restore checks it and stands down when one happened meanwhile.
// Not covered by a test: requestAnimationFrame never runs in the off-screen
// WKWebView the tests use (measured 2026-09-08), so the restore this guards
// only exists on screen.
var gnNav=0;
function gnRenderNow(markdown,props,editable,vocabulary,media,lines){
  window.gnLastRender=[markdown,props,editable,vocabulary,media,lines];
  if(vocabulary)gnVocab=vocabulary;
  gnCodeLines=!!lines;
  gnCodeSrc=[];
  gnMedia=media||{};
  var ex=gnExtractCallouts(markdown);
  gnLineMap=ex.lineMap;
  gnSlugSeen={};
  var html=md.render(ex.text);
  gnLineMap=null;
  for(var i=0;i<ex.callouts.length;i++){
    // The paragraph carries data-line (source sync), so match its attributes
    // and hand the line on to the callout: a literal <p> never matches.
    html=html.replace(new RegExp('<p( [^>]*)?>@@GNCALLOUT'+i+'@@<\/p>'),function(_,attrs){return gnRenderCallout(ex.callouts[i],attrs||'');});
  }
  // Replacing the article collapses the page height for an instant, which
  // clamps the scroll to the top. Split view re-renders while you type, so
  // the reading position has to survive every render.
  var sc=document.scrollingElement||document.documentElement;
  var keep=sc.scrollTop;
  var nav=gnNav;
  var art=document.getElementById('gn-article');
  art.textContent='';art.appendChild(gnApplyMedia(gnSummaryMarkdown(gnSanitize(html))));
  // An empty note says so, so it never looks like a page that failed to draw. Drawn by CSS: the find and a copy
  // of the page never see it.
  art.classList.toggle('gn-is-empty',!String(markdown||'').trim());
  gnRenderProps(props,editable);
  gnSugClose();
  gnWireLinks();gnWireJSON();window.gnRunMermaid();gnLastSlug='';
  gnPageAfterRender();
  gnApplyGit();
  gnApplyDiff();
  if(gnHL)gnApplyHL(false);
  if(keep>0){
    sc.scrollTop=keep;
    // Mermaid and image layout land a frame later and can shift the height.
    // A jump to a heading or to a find match counts as a deliberate move and
    // wins: Swift issues those right after the render, so without this guard
    // the correction would snap the reader back and cancel the jump.
    window.requestAnimationFrame(function(){
      if(gnNav!==nav)return;
      if(Math.abs(sc.scrollTop-keep)>1)sc.scrollTop=keep;
      gnOnScroll();
    });
  }
  gnOnScroll();
}
// A render that throws left an empty article and no word about it (Genesis Markdown, 2026-10-13: a note stuck at
// "+ Add property" in split view). Now the article says so, and Swift logs the error.
// The 7th argument is Swift's tag for this render. The page keeps the last tag it got, also when the render
// threw, so Swift can tell a render that never arrived from one that arrived and failed.
window.gnRenderedTag='';
// A render that throws keeps whatever the article shows (the last good text, when the throw came before it was
// replaced) and Swift puts "This page could not be drawn." with Retry over the page; the raw error sits behind
// its Details. The return value tells Swift the render drew ("ok"), which takes such a notice away.
window.gnRender=function(){
  window.gnRenderedTag=String(arguments[6]||'');
  try{gnRenderNow.apply(null,arguments);return 'ok';}
  catch(e){
    gnPost({type:'renderError',message:String(e&&e.message||e),stack:String(e&&e.stack||'').slice(0,2000)});
    return 'failed';
  }
};
window.addEventListener('error',function(e){gnPost({type:'pageError',message:String(e.message||''),line:e.lineno||0});});
window.gnTheme=function(vars){var s=document.documentElement.style;for(var k in vars){s.setProperty(k,vars[k]);}};
// Column width. Swift owns the remembered value; the grips only preview the
// drag live and report the final width on mouse-up (0 = back to the default).
var gnCancelGripDrag=null;
window.gnGrips=function(on){
  // Hiding the grips mid-drag would leave the window listeners running: the
  // mouse-up would still report a width from an interaction that is no longer
  // on screen, overwriting the remembered reading width.
  if(!on&&gnCancelGripDrag)gnCancelGripDrag();
  document.body.classList.toggle('gn-nogrips',!on);
};
window.gnWidth=function(px){var s=document.documentElement.style;if(px&&px>0)s.setProperty('--gn-article-width',Math.round(px)+'px');else s.removeProperty('--gn-article-width');};
(function(){
  var col=document.getElementById('gn-column');
  var grips=col.querySelectorAll('.gn-grip');
  for(var i=0;i<grips.length;i++){(function(grip){
    var sign=grip.classList.contains('gn-grip-r')?1:-1;
    grip.addEventListener('mousedown',function(e){
      if(e.button!==0)return;e.preventDefault();
      var startX=e.clientX,startW=col.getBoundingClientRect().width,w=startW;
      // The exact inline value before the drag, so an abandoned drag restores
      // it verbatim (an empty string means the stylesheet default was in use).
      var prev=document.documentElement.style.getPropertyValue('--gn-article-width');
      var minW=420,maxW=Math.max(minW,document.body.clientWidth-60);
      grip.classList.add('gn-active');document.body.classList.add('gn-resizing');
      // The column is centred, so one edge moving by dx widens it by 2*dx.
      function move(ev){w=Math.max(minW,Math.min(maxW,startW+sign*(ev.clientX-startX)*2));document.documentElement.style.setProperty('--gn-article-width',Math.round(w)+'px');}
      function stop(){window.removeEventListener('mousemove',move);window.removeEventListener('mouseup',up);
        grip.classList.remove('gn-active');document.body.classList.remove('gn-resizing');gnCancelGripDrag=null;}
      function up(){stop();gnPost({type:'width',value:Math.round(w)});}
      // Abandoned (split view took the grips away): put the width back and say nothing.
      gnCancelGripDrag=function(){stop();
        if(prev)document.documentElement.style.setProperty('--gn-article-width',prev);
        else document.documentElement.style.removeProperty('--gn-article-width');};
      window.addEventListener('mousemove',move);window.addEventListener('mouseup',up);
    });
    grip.addEventListener('dblclick',function(e){e.preventDefault();window.gnWidth(null);gnPost({type:'width',value:0});});
    // Keyboard: the arrows move this edge like a drag would (Shift = bigger
    // steps), Enter resets like a double-click.
    grip.addEventListener('keydown',function(e){
      if(e.key==='Enter'){e.preventDefault();window.gnWidth(null);gnPost({type:'width',value:0});return;}
      if(e.key!=='ArrowLeft'&&e.key!=='ArrowRight')return;
      e.preventDefault();
      var dx=(e.key==='ArrowRight'?1:-1)*(e.shiftKey?60:20);
      var minW=420,maxW=Math.max(minW,document.body.clientWidth-60);
      var w=Math.round(Math.max(minW,Math.min(maxW,col.getBoundingClientRect().width+sign*dx*2)));
      window.gnWidth(w);gnPost({type:'width',value:w});
    });
  })(grips[i]);}
})();
// Put the block that owns source line `n` at the top of the page. Blocks in
// between interpolate, so a slow scroll in the editor is a slow scroll here.
// `gnSyncGuard` keeps the scroll-spy from reporting a section during the jump.
window.gnSyncLine=function(n){
  var art=document.getElementById('gn-article');if(!art)return;
  var nodes=art.querySelectorAll('[data-line]');if(!nodes.length)return;
  var sc=document.scrollingElement||document.documentElement;
  var prev=null,next=null;
  for(var i=0;i<nodes.length;i++){
    var line=parseInt(nodes[i].getAttribute('data-line'),10);
    if(isNaN(line))continue;
    if(line<=n){prev={line:line,el:nodes[i]};}
    else{next={line:line,el:nodes[i]};break;}
  }
  var first=parseInt(nodes[0].getAttribute('data-line'),10);
  var top;
  // At (or above) the first block, show the top of the page: the properties
  // block and the title live above it and belong on screen.
  if(!prev||n<=first){top=0;}
  else{
    var a=prev.el.getBoundingClientRect().top+sc.scrollTop;
    if(next&&next.line>prev.line){
      var b=next.el.getBoundingClientRect().top+sc.scrollTop;
      top=a+(b-a)*Math.min(1,(n-prev.line)/(next.line-prev.line));
    }else{top=a;}
  }
  sc.scrollTop=top<=0?0:Math.max(0,top-12-gnStickyRoom());
};
// Lines a link or an open URL asked for. `blocks`: 0-based body lines, and
// every block whose source lines overlap is marked, the innermost one only (a
// list item, not the whole list). `lines`: the numbered lines of a code block.
// `rows`: table rows, the header row being file line 1. The marked elements
// get `gn-hl` (a code line's number is emphasised), and ONE band is drawn over
// all of them, so a range of paragraphs reads as one block, not a bar per
// paragraph. The marks survive a re-render; only a new range scrolls. A click
// anywhere fades the band out, and Swift forgets the range (`hlcleared`).
var gnHL=null,gnBand=null;
function gnDropBand(){if(gnBand&&gnBand.parentNode)gnBand.parentNode.removeChild(gnBand);gnBand=null;}
function gnPlaceBand(hit,mode){
  var top=Infinity,bottom=-Infinity,left=Infinity,right=-Infinity;
  for(var i=0;i<hit.length;i++){
    var r=hit[i].getBoundingClientRect();
    top=Math.min(top,r.top);bottom=Math.max(bottom,r.bottom);left=Math.min(left,r.left);right=Math.max(right,r.right);
  }
  var box=mode==='lines'?hit[0].closest('pre'):mode==='rows'?hit[0].closest('table'):null;
  if(box){var b=box.getBoundingClientRect();left=b.left+1;right=b.right-1;top-=2;bottom+=2;}
  else{left-=16;right+=10;top-=8;bottom+=8;}
  if(!gnBand){gnBand=document.createElement('div');gnBand.id='gn-hl-band';document.body.appendChild(gnBand);}
  var sc=document.scrollingElement||document.documentElement;
  gnBand.style.top=(top+sc.scrollTop)+'px';gnBand.style.left=(left+sc.scrollLeft)+'px';
  gnBand.style.width=Math.max(0,right-left)+'px';gnBand.style.height=Math.max(0,bottom-top)+'px';
}
function gnApplyHL(scroll){
  var old=document.querySelectorAll('.gn-hl');for(var i=0;i<old.length;i++)old[i].classList.remove('gn-hl');
  var art=document.getElementById('gn-article');
  if(!gnHL||!art){if(gnBand&&!gnBand.classList.contains('gn-fading'))gnDropBand();return;}
  if(gnBand&&gnBand.classList.contains('gn-fading'))gnDropBand();
  var a=gnHL.a,b=gnHL.b,hit=[],n,j;
  if(gnHL.mode==='lines'){
    var ls=art.querySelectorAll('.gn-ln');
    for(j=0;j<ls.length;j++){n=parseInt(ls[j].getAttribute('data-ln'),10);if(n>=a&&n<=b)hit.push(ls[j]);}
  }else if(gnHL.mode==='rows'){
    var rows=art.querySelectorAll('table tr');
    for(j=0;j<rows.length;j++){n=j+1;if(n>=a&&n<=b)hit.push(rows[j]);}
  }else{
    var nodes=art.querySelectorAll('[data-line]'),cand=[];
    for(j=0;j<nodes.length;j++){
      var s=parseInt(nodes[j].getAttribute('data-line'),10),e=parseInt(nodes[j].getAttribute('data-line-end'),10);
      if(isNaN(s))continue;if(isNaN(e)||e<=s)e=s+1;
      if(s<=b&&e>a)cand.push(nodes[j]);
    }
    for(j=0;j<cand.length;j++){
      var inner=false;
      for(var k=0;k<cand.length;k++){if(k!==j&&cand[j].contains(cand[k])){inner=true;break;}}
      if(!inner)hit.push(cand[j]);
    }
  }
  for(j=0;j<hit.length;j++)hit[j].classList.add('gn-hl');
  if(hit.length)gnPlaceBand(hit,gnHL.mode);else gnDropBand();
  if(scroll&&hit.length){
    gnNav++;
    var sc=document.scrollingElement||document.documentElement;
    sc.scrollTop=Math.max(0,hit[0].getBoundingClientRect().top+sc.scrollTop-80);
  }
}
window.addEventListener('resize',function(){if(gnHL)gnApplyHL(false);});
// Capture phase, nothing prevented: the click still selects text and follows links.
document.addEventListener('mousedown',function(){
  if(!gnHL||!gnBand||gnBand.classList.contains('gn-fading'))return;
  var band=gnBand;band.classList.add('gn-fading');
  var old=document.querySelectorAll('.gn-hl');for(var i=0;i<old.length;i++)old[i].classList.remove('gn-hl');
  gnHL=null;
  setTimeout(function(){if(band.parentNode)band.parentNode.removeChild(band);if(gnBand===band)gnBand=null;},600);
  gnPost({type:'hlcleared'});
},true);
// The image viewer (GenesisKit). The first click lets Swift decode the picture, so the double-click opens
// with it; the double-click sends every viewable picture in document order with its table row, and the
// clicked one's rect in CSS pixels. gnImageRect answers where a picture is now, for the zoom back.
function gnViewerImage(t){return t&&t.closest?t.closest('#gn-article img[data-gn-img]'):null;}
function gnViewerRect(im){var r=im.getBoundingClientRect();
  return {x:r.left,y:r.top,w:r.width,h:r.height,radius:parseFloat(getComputedStyle(im).borderTopLeftRadius)||0};}
document.addEventListener('mousedown',function(e){
  if(e.button!==0||e.detail!==1)return;
  var im=gnViewerImage(e.target);if(im)gnPost({type:'image.press',src:im.getAttribute('src')||''});
});
document.addEventListener('dblclick',function(e){
  var im=gnViewerImage(e.target);
  if(!im){
    // A picture the viewer does not open (a web picture): the double-click still gets an answer.
    var other=e.target&&e.target.closest?e.target.closest('#gn-article img'):null;
    if(other){e.preventDefault();gnPost({type:'image.refused',src:other.getAttribute('src')||''});}
    return;
  }
  e.preventDefault();gnOpenViewer(im);
});
document.addEventListener('keydown',function(e){
  if(e.key!=='Enter'&&e.key!==' ')return;
  var im=gnViewerImage(e.target);if(!im)return;
  e.preventDefault();gnOpenViewer(im);
});
function gnOpenViewer(im){
  var rows=Array.prototype.slice.call(document.querySelectorAll('#gn-article tr'));
  var all=document.querySelectorAll('#gn-article img[data-gn-img]');var images=[];
  for(var i=0;i<all.length;i++){var tr=all[i].closest('tr');
    images.push({n:+all[i].getAttribute('data-gn-img'),src:all[i].getAttribute('src')||'',alt:all[i].getAttribute('alt')||'',row:tr?'r'+rows.indexOf(tr):null});}
  gnPost({type:'image.open',n:+im.getAttribute('data-gn-img'),images:images,rect:gnViewerRect(im)});
}
window.gnImageRect=function(n){var im=document.querySelector('#gn-article img[data-gn-img="'+(+n)+'"]');return JSON.stringify(im?gnViewerRect(im):null);};
// The page as a rendered diff (Swift's DiffMark list, new body lines plus the old text): added blocks tinted green,
// changed ones blue with their old version above them struck through in red, removed text struck through where it
// stood. One paragraph changed into one paragraph gets word marks instead of a struck-through block.
var gnDiffList=[];
window.gnDiff=function(list){gnDiffList=list||[];var a=document.getElementById('gn-article');if(a&&window.gnLastRender)gnRenderNow.apply(null,window.gnLastRender);else gnApplyDiff();};
function gnBlocks(art){
  var nodes=art.querySelectorAll('[data-line]'),spans=[];
  for(var j=0;j<nodes.length;j++){
    if(nodes[j].closest('.gn-diff-old'))continue;
    var s=parseInt(nodes[j].getAttribute('data-line'),10),e=parseInt(nodes[j].getAttribute('data-line-end'),10);
    if(isNaN(s))continue;if(isNaN(e)||e<=s)e=s+1;spans.push({n:nodes[j],s:s,e:e});
  }
  return spans;
}
function gnInnermost(cand){
  var out=[];for(var j=0;j<cand.length;j++){var inner=true;for(var k=0;k<cand.length;k++){if(k!==j&&cand[j].contains(cand[k])){inner=false;break;}}if(inner)out.push(cand[j]);}
  return out;
}
function gnWordDiff(a,b){
  var ta=a.split(/(\s+)/),tb=b.split(/(\s+)/),n=ta.length,m=tb.length;
  if(n*m>250000)return null;
  var dp=[];for(var i=0;i<=n;i++)dp.push(new Int32Array(m+1));
  for(i=n-1;i>=0;i--)for(var j=m-1;j>=0;j--)dp[i][j]=ta[i]===tb[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  var del=[],ins=[],pa=0,pb=0;i=0;j=0;
  while(i<n||j<m){
    if(i<n&&j<m&&ta[i]===tb[j]){pa+=ta[i].length;pb+=tb[j].length;i++;j++;}
    else if(j<m&&(i>=n||dp[i][j+1]>=dp[i+1][j])){if(/\S/.test(tb[j]))ins.push([pb,pb+tb[j].length]);pb+=tb[j].length;j++;}
    else{if(/\S/.test(ta[i]))del.push([pa,pa+ta[i].length]);pa+=ta[i].length;i++;}
  }
  return {del:del,ins:ins};
}
function gnWrapRanges(root,ranges,cls){
  if(!ranges.length)return;
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),nodes=[],t;
  while((t=walker.nextNode()))nodes.push(t);
  var pos=0;
  for(var i=0;i<nodes.length;i++){
    t=nodes[i];var len=t.nodeValue.length,start=pos,end=pos+len;pos=end;
    var cuts=[];
    for(var k=0;k<ranges.length;k++){var r=ranges[k];if(r[1]<=start||r[0]>=end)continue;cuts.push([Math.max(r[0],start)-start,Math.min(r[1],end)-start]);}
    for(var c=cuts.length-1;c>=0;c--){
      var mid=t.splitText(cuts[c][0]);mid.splitText(cuts[c][1]-cuts[c][0]);
      var mark=document.createElement('mark');mark.className=cls;mid.parentNode.replaceChild(mark,mid);mark.appendChild(mid);
    }
  }
}
function gnApplyDiff(){
  var art=document.getElementById('gn-article');if(!art)return;
  if(!gnDiffList.length){gnLayoutGit();return;}
  var spans=gnBlocks(art);
  for(var h=0;h<gnDiffList.length;h++){
    var d=gnDiffList[h],hit=[],anchor=null,j;
    if(d.k!=='deleted'){
      var cand=[];for(j=0;j<spans.length;j++){if(spans[j].s<=d.b&&spans[j].e>d.a)cand.push(spans[j].n);}
      hit=gnInnermost(cand);
      // A strip in the bar column, no background: a whole changed block reads by its strip, a changed word by its
      // mark, and a table's changed rows got a background each, which read as odd and even rows (Martin, 2026-10-13).
      for(j=0;j<hit.length;j++){
        hit[j].classList.add(d.k==='added'?'gn-diff-add':'gn-diff-mod');
        hit[j].setAttribute('data-gn-diff',d.k==='added'?'added':'modified');hit[j].setAttribute('data-gn-diff-i',String(h));
      }
      anchor=hit[0]||null;
    }else{
      var after=null;for(j=0;j<spans.length;j++){if(spans[j].s>=d.a&&(!after||spans[j].s<after.s))after=spans[j];}
      anchor=after?after.n:null;
    }
    if(!d.old)continue;
    var box=document.createElement('div');box.className='gn-diff-old';
    box.setAttribute('data-gn-diff','removed');box.setAttribute('data-gn-diff-i',h+'o');
    box.appendChild(gnSanitize(md.render(d.old)));
    if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(box,anchor);else art.appendChild(box);
    // One paragraph for one paragraph: word marks on both, no struck-through block.
    if(d.k==='modified'&&hit.length===1&&box.children.length===1&&!/\n\s*\n/.test(d.old)){
      var wd=gnWordDiff(box.textContent,hit[0].textContent);
      if(wd){box.classList.add('gn-diff-pair');gnWrapRanges(box,wd.del,'gn-del');gnWrapRanges(hit[0],wd.ins,'gn-ins');}
    }
  }
  gnLayoutGit();
}
// Bars beside the blocks that differ from HEAD (Swift's GitMark list): a block whose source lines overlap a change
// gets the change's kind, the innermost such block as gnApplyHL picks them. A removal marks the first block at or
// after it. Re-applied after every render; a click left of a marked block posts the mark's index.
var gnGit=[];
window.gnGitMarks=function(list){gnGit=list||[];gnApplyGit();};
function gnApplyGit(){
  var art=document.getElementById('gn-article');if(!art)return;
  var old=art.querySelectorAll('[data-gn-git]');
  for(var i=0;i<old.length;i++){old[i].removeAttribute('data-gn-git');old[i].removeAttribute('data-gn-git-i');}
  if(!gnGit.length){gnLayoutGit();return;}
  var nodes=art.querySelectorAll('[data-line]'),spans=[];
  for(var j=0;j<nodes.length;j++){
    var s=parseInt(nodes[j].getAttribute('data-line'),10),e=parseInt(nodes[j].getAttribute('data-line-end'),10);
    if(isNaN(s))continue;if(isNaN(e)||e<=s)e=s+1;spans.push({n:nodes[j],s:s,e:e});
  }
  for(var h=0;h<gnGit.length;h++){
    var m=gnGit[h],cand=[];
    if(m.k==='deleted'){
      var after=null;for(j=0;j<spans.length;j++){if(spans[j].s>=m.a&&(!after||spans[j].s<after.s))after=spans[j];}
      if(after)cand.push(after.n);
    }else{
      for(j=0;j<spans.length;j++){if(spans[j].s<=m.b&&spans[j].e>m.a)cand.push(spans[j].n);}
    }
    for(j=0;j<cand.length;j++){
      var inner=true;for(var k=0;k<cand.length;k++){if(k!==j&&cand[j].contains(cand[k])){inner=false;break;}}
      if(inner&&!cand[j].hasAttribute('data-gn-git')){cand[j].setAttribute('data-gn-git',m.k);cand[j].setAttribute('data-gn-git-i',String(m.i));}
    }
  }
  gnLayoutGit();
}
// The bars: one per change, in one column 16 px left of the text, spanning every block the change touches. A bar on
// the block itself stood inside a list's indent over the item number, and a table row cannot hold a positioned
// ::before. A resize of the article (pictures, diagrams, the reading width) places them again.
var gnGitObserved=false;
function gnLayoutGit(){
  var art=document.getElementById('gn-article'),col=document.getElementById('gn-column');if(!art||!col)return;
  var layer=document.getElementById('gn-git-layer');
  if(!layer){layer=document.createElement('div');layer.id='gn-git-layer';col.appendChild(layer);}
  if(!gnGitObserved&&window.ResizeObserver){
    gnGitObserved=true;
    new ResizeObserver(function(){requestAnimationFrame(gnLayoutGit);}).observe(art);
  }
  var focused=layer.contains(document.activeElement)?document.activeElement.getAttribute('data-i'):null;
  layer.textContent='';
  // Git marks (Swift's list, clickable) and the rendered diff's marks (index "d…", not clickable) share the column.
  var marked=art.querySelectorAll('[data-gn-git],[data-gn-diff]');if(!marked.length)return;
  var c=col.getBoundingClientRect(),a=art.getBoundingClientRect();
  var x=a.left+(parseFloat(getComputedStyle(art).paddingLeft)||0)-c.left-16,groups={},order=[];
  for(var i=0;i<marked.length;i++){
    var el=marked[i],git=el.hasAttribute('data-gn-git'),r=el.getBoundingClientRect();
    var idx=git?el.getAttribute('data-gn-git-i'):'d'+el.getAttribute('data-gn-diff-i');
    if(!r.width&&!r.height)continue;
    var g=groups[idx];
    if(!g){g=groups[idx]={k:git?el.getAttribute('data-gn-git'):el.getAttribute('data-gn-diff'),t:r.top,b:r.bottom};order.push(idx);}
    else{g.t=Math.min(g.t,r.top);g.b=Math.max(g.b,r.bottom);}
  }
  for(var j=0;j<order.length;j++){
    var idx=order[j],interactive=idx.charAt(0)!=='d',gg=groups[idx];
    var bar=document.createElement(interactive?'button':'div');
    bar.className='gn-git-bar';bar.setAttribute('data-k',gg.k);bar.setAttribute('data-i',idx);
    if(interactive){
      bar.type='button';
      var mark=gnGit.find(function(m){return String(m.i)===idx;});
      var range=mark?(mark.a===mark.b?'Body line '+(mark.a+1):'Body lines '+(mark.a+1)+'–'+(mark.b+1)):'Change';
      bar.setAttribute('aria-label',range+' '+gg.k+'. Show previous content and revert options');
    }else{bar.setAttribute('aria-hidden','true');}
    bar.style.left=x+'px';
    if(gg.k==='deleted'){bar.style.top=(gg.t-c.top-5)+'px';}
    else{bar.style.top=(gg.t-c.top+2)+'px';bar.style.height=Math.max(4,gg.b-gg.t-4)+'px';}
    layer.appendChild(bar);
    if(interactive&&focused===idx)bar.focus({preventScroll:true});
  }
}
document.addEventListener('click',function(e){
  var bar=e.target&&e.target.closest?e.target.closest('.gn-git-bar'):null;
  if(bar){
    if(bar.tagName!=='BUTTON')return;
    var br=bar.getBoundingClientRect();e.preventDefault();e.stopPropagation();
    gnPost({type:'gitMark',index:parseInt(bar.getAttribute('data-i'),10),rect:{x:br.left-2,y:br.top,w:8,h:Math.max(br.height,8)}});
    return;
  }
  var el=e.target&&e.target.closest?e.target.closest('[data-gn-git]'):null;if(!el)return;
  var r=el.getBoundingClientRect();if(e.clientX>r.left)return;
  e.preventDefault();e.stopPropagation();
  gnPost({type:'gitMark',index:parseInt(el.getAttribute('data-gn-git-i'),10),rect:{x:r.left-18,y:r.top,w:8,h:r.height}});
},true);
window.gnHighlightLines=function(a,b,mode,scroll){
  gnHL=(a===null||a===undefined)?null:{a:a,b:b,mode:mode};
  gnApplyHL(!!scroll);
};
window.gnScrollTo=function(px){var sc=document.scrollingElement||document.documentElement;sc.scrollTop=Math.max(0,px||0);};
window.gnScrollTop=function(){var sc=document.scrollingElement||document.documentElement;return sc.scrollTop;};
// `label` is the heading as the link or the outline named it, for the answer when the note has no such heading.
window.gnScrollToSlug=function(slug,label){
  var el=slug?document.getElementById(slug):null;
  if(el&&document.getElementById('gn-article').contains(el)){gnNav++;el.scrollIntoView({behavior:gnScrollBehavior(),block:'start'});return true;}
  gnPost({type:'deadAnchor',slug:String(slug||''),label:String(label||slug||'')});return false;
};
// Find bar: wrap every occurrence in a <mark>, then walk them. The marks are
// plain DOM, so a re-render drops them and Swift re-issues the search.
// `opts` comes from Swift (MarkdownFindCommand.jsOptions): matchCase,
// wholeWord and regex follow the source search's rules (SourceFind.swift),
// `scope` is find in selection (a new token takes the DOM selection of that
// moment, as text offsets in the article; null = the whole page) and `ticks`
// draws the matches on the right edge. Missing options are all off.
var gnFindIdx=-1;
var gnFindOpts={};
var gnFindScope=null,gnFindScopeTok=null;
// A word on either side of a whole-word match: letters, digits, marks and _
// in any script, the class SourceFind uses. `\b` is ASCII-only here, so it
// would split a Czech word at every háček.
var gnWordCh='[\\p{L}\\p{N}\\p{M}_]';
function gnClearFind(){
  var art=document.getElementById('gn-article');if(!art)return;
  var ms=art.querySelectorAll('mark.gn-find');
  for(var i=0;i<ms.length;i++){var m=ms[i];m.parentNode.replaceChild(document.createTextNode(m.textContent),m);}
  art.normalize();
}
// Text offsets in the article. Rebuilding the marks replaces the text nodes a
// selection points into, which used to shrink the reader's selection on every
// keystroke; it is kept as offsets and put back, so find in selection still
// sees what the reader selected.
function gnTextOffset(art,node,off){
  var r=document.createRange();r.selectNodeContents(art);
  try{r.setEnd(node,off);}catch(e){return 0;}
  return r.toString().length;
}
function gnSelOffsets(art){
  var sel=window.getSelection();if(!sel||!sel.rangeCount)return null;
  var r=sel.getRangeAt(0);if(r.collapsed||!r.intersectsNode(art))return null;
  var n=(art.textContent||'').length;
  var s=Math.min(n,gnTextOffset(art,r.startContainer,r.startOffset));
  var e=Math.min(n,gnTextOffset(art,r.endContainer,r.endOffset));
  return e>s?{s:s,e:e}:null;
}
// On a boundary between two text nodes a start goes to the next node and an
// end stays in the earlier one: the end of the "\n" between two paragraphs is
// not a visible place, and WebKit moved such a start back into the paragraph
// before, so the selection grew by a line break.
function gnPointAt(art,off,start){
  var w=document.createTreeWalker(art,NodeFilter.SHOW_TEXT,null),n,acc=0,last=null;
  while((n=w.nextNode())){
    var l=(n.nodeValue||'').length;
    if(start?off<acc+l:off<=acc+l)return {node:n,offset:off-acc};
    acc+=l;last=n;
  }
  return last?{node:last,offset:(last.nodeValue||'').length}:{node:art,offset:0};
}
function gnRestoreSel(art,o){
  if(!o)return;
  var a=gnPointAt(art,o.s,true),b=gnPointAt(art,o.e,false);
  var r=document.createRange();r.setStart(a.node,a.offset);r.setEnd(b.node,b.offset);
  var sel=window.getSelection();sel.removeAllRanges();sel.addRange(r);
}
// The query as one RegExp, or null when the regex does not compile. A regex
// is checked on its own first, so a stray `)` cannot pair up with the
// whole-word wrapper and pass.
function gnFindRegex(q,o){
  var src=q;
  if(o.regex){try{new RegExp(q,'u');}catch(e){return null;}}
  else src=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(o.wholeWord)src='(?<!'+gnWordCh+')(?:'+src+')(?!'+gnWordCh+')';
  try{return new RegExp(src,'g'+(o.matchCase?'':'i')+(o.regex?'m':'')+'u');}catch(e){return null;}
}
// `keep` is a re-render of the same search (live preview while typing): the
// marks are rebuilt, the selected match stays selected and nothing scrolls.
// Only a new search or next/previous moves the page.
window.gnFind=function(q,keep,opts){
  var o=opts||{};gnFindOpts=o;
  var art=document.getElementById('gn-article');
  var sel=art?gnSelOffsets(art):null;
  if(o.scope===null||o.scope===undefined){gnFindScope=null;gnFindScopeTok=null;}
  else if(o.scope!==gnFindScopeTok){gnFindScopeTok=o.scope;gnFindScope=sel;}
  gnClearFind();
  q=q||'';if(!o.regex)q=q.trim();
  var re=q&&art?gnFindRegex(q,o):null;
  if(!re){
    gnFindIdx=-1;
    if(art)gnRestoreSel(art,sel);
    gnPlaceTicks();
    // -1: the pattern itself was refused, so the counter says so instead of "no match".
    gnPost({type:'find',index:q&&art?-1:0,count:0});return;
  }
  // Matched in the original text: lowercasing can change a string's length
  // (İ becomes two code units), so offsets into a lowercased copy drift.
  var walker=document.createTreeWalker(art,NodeFilter.SHOW_TEXT,null);
  var nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
  var sc=gnFindScope,acc=0;
  for(var i=0;i<nodes.length;i++){
    var node=nodes[i];var text=node.nodeValue||'';
    var base=acc;acc+=text.length;
    var parent=node.parentNode;
    if(!parent||parent.nodeName==='SCRIPT'||parent.nodeName==='STYLE')continue;
    if(sc&&(acc<=sc.s||base>=sc.e))continue;
    re.lastIndex=0;var m=re.exec(text);
    var frag=null,last=0;
    while(m){
      var len=m[0].length;
      // An empty match (`^`, `a*`) has nothing to mark; step past it.
      if(!len){re.lastIndex++;m=re.exec(text);continue;}
      if(!sc||(base+m.index>=sc.s&&base+m.index+len<=sc.e)){
        if(!frag)frag=document.createDocumentFragment();
        if(m.index>last)frag.appendChild(document.createTextNode(text.slice(last,m.index)));
        var mk=document.createElement('mark');mk.className='gn-find';
        mk.textContent=m[0];
        frag.appendChild(mk);last=m.index+len;
      }
      m=re.exec(text);
    }
    if(!frag)continue;
    if(last<text.length)frag.appendChild(document.createTextNode(text.slice(last)));
    parent.replaceChild(frag,node);
  }
  gnRestoreSel(art,sel);
  if(keep&&gnFindIdx>=0){
    var ms=art.querySelectorAll('mark.gn-find');
    if(!ms.length){gnFindIdx=-1;gnPlaceTicks();gnPost({type:'find',index:0,count:0});return;}
    gnFindIdx=Math.min(gnFindIdx,ms.length-1);
    ms[gnFindIdx].classList.add('gn-find-current');
    gnPlaceTicks();
    gnPost({type:'find',index:gnFindIdx+1,count:ms.length});
    return;
  }
  gnFindIdx=-1;
  window.gnFindStep(1);
};
window.gnFindStep=function(delta){
  var ms=document.querySelectorAll('#gn-article mark.gn-find');
  if(!ms.length){gnPost({type:'find',index:0,count:0});return;}
  // Nothing chosen yet: forward starts at the first match, back at the last.
  gnFindIdx=gnFindIdx<0?(delta>=0?0:ms.length-1):((gnFindIdx+delta)%ms.length+ms.length)%ms.length;
  for(var i=0;i<ms.length;i++)ms[i].classList.remove('gn-find-current');
  var cur=ms[gnFindIdx];
  cur.classList.add('gn-find-current');
  gnNav++;
  cur.scrollIntoView({behavior:gnScrollBehavior(),block:'center'});
  gnPlaceTicks();
  gnPost({type:'find',index:gnFindIdx+1,count:ms.length});
};
// A tick was clicked: that match becomes the current one.
function gnFindGo(i){gnFindIdx=i-1;window.gnFindStep(1);}
// Match ticks on the right edge (`opts.ticks`). The lane stands for the whole
// page, so a tick sits at the match's share of the scroll height. Ticks on the
// same pixel collapse into one; the current one is drawn last, on top. Placed
// after every search and step, and again when the page's height changes
// (images, mermaid, a resize), coalesced into one frame. No timers.
function gnTick(y,i,current){
  var t=document.createElement('div');
  t.className=current?'gn-find-tick gn-find-tick-current':'gn-find-tick';
  t.style.top=y+'px';t.setAttribute('data-i',String(i));
  return t;
}
function gnPlaceTicks(){
  var box=document.getElementById('gn-find-ticks');
  var ms=gnFindOpts.ticks?document.querySelectorAll('#gn-article mark.gn-find'):[];
  if(!ms.length){if(box)box.parentNode.removeChild(box);return;}
  if(!box){
    box=document.createElement('div');box.id='gn-find-ticks';box.setAttribute('aria-hidden','true');
    box.addEventListener('click',function(e){
      var i=e.target&&e.target.getAttribute?e.target.getAttribute('data-i'):null;
      if(i===null)return;
      e.preventDefault();gnFindGo(+i);
    });
    document.body.appendChild(box);
  }
  var sc=document.scrollingElement||document.documentElement;
  var total=Math.max(1,sc.scrollHeight),h=sc.clientHeight;
  var frag=document.createDocumentFragment(),seen={},cur=null;
  for(var i=0;i<ms.length;i++){
    var y=Math.max(1,Math.min(h-3,Math.round((ms[i].getBoundingClientRect().top+sc.scrollTop)/total*h)));
    if(i===gnFindIdx){cur={y:y,i:i};continue;}
    if(seen[y])continue;seen[y]=1;
    frag.appendChild(gnTick(y,i,false));
  }
  if(cur)frag.appendChild(gnTick(cur.y,cur.i,true));
  box.textContent='';box.appendChild(frag);
}
var gnTicksQueued=false;
function gnTicksSoon(){
  if(gnTicksQueued||!document.getElementById('gn-find-ticks'))return;
  gnTicksQueued=true;
  window.requestAnimationFrame(function(){gnTicksQueued=false;gnPlaceTicks();});
}
window.addEventListener('resize',gnTicksSoon);
(function(){var art=document.getElementById('gn-article');if(art&&window.ResizeObserver)new ResizeObserver(gnTicksSoon).observe(art);})();
window.gnHighlight=function(q){
  q=(q||'').toLowerCase().trim();if(!q)return;
  var els=document.querySelectorAll('#gn-article p,#gn-article li,#gn-article h1,#gn-article h2,#gn-article h3,#gn-article td');
  for(var i=0;i<els.length;i++){
    if((els[i].textContent||'').toLowerCase().indexOf(q)!==-1){
      els[i].scrollIntoView({behavior:gnScrollBehavior(),block:'center'});
      (function(el){el.classList.remove('gn-flash');void el.offsetWidth;el.classList.add('gn-flash');
        setTimeout(function(){el.classList.remove('gn-flash');},1300);})(els[i]);
      break;
    }
  }
};
// The page says it is ready itself, besides the navigation's didFinish: a render waiting for that callback alone
// waited forever when it never came.
gnPost({type:'ready'});
})();
</script>
</body>
</html>
"""#
}
/// The web renderer as a plain view, for a host's own reading pane (Genesis: the vault pane). The markdown window
/// uses `MarkdownWebView` itself, with its find, zoom, column and line-sync options.
public struct MarkdownWebPage: View {
    let markdown: String
    var scrollTarget: String?
    var highlightQuery: String?
    var highlightToken: Int
    var onWikilink: (String) -> Void
    var onActiveSection: (String) -> Void
    var onProperties: (([MarkdownProperty]) -> Void)?
    var documentURL: URL?
    var vaultRoot: String?

    public init(
        markdown: String,
        scrollTarget: String?,
        highlightQuery: String?,
        highlightToken: Int,
        onWikilink: @escaping (String) -> Void,
        onActiveSection: @escaping (String) -> Void,
        onProperties: (([MarkdownProperty]) -> Void)? = nil,
        documentURL: URL? = nil,
        vaultRoot: String? = nil
    ) {
        self.markdown = markdown
        self.scrollTarget = scrollTarget
        self.highlightQuery = highlightQuery
        self.highlightToken = highlightToken
        self.onWikilink = onWikilink
        self.onActiveSection = onActiveSection
        self.onProperties = onProperties
        self.documentURL = documentURL
        self.vaultRoot = vaultRoot
    }

    public var body: some View {
        MarkdownWebView(
            markdown: markdown,
            scrollTarget: scrollTarget,
            highlightQuery: highlightQuery,
            highlightToken: highlightToken,
            onWikilink: onWikilink,
            onActiveSection: onActiveSection,
            onProperties: onProperties,
            documentURL: documentURL,
            vaultRoot: vaultRoot
        )
    }
}
