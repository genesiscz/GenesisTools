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

/// What a click on a task box (`- [ ]`, `- [x]`) on the page does.
struct MarkdownTaskBoxes {
    /// Why the boxes cannot change the note, shown as the tooltip of a disabled box. nil with `set` = they can.
    var lock: String?
    /// Sets the item's box in the note and answers on the main thread: true when the note now has that state, false
    /// when it was refused (the host says why). nil = the boxes are read-only.
    var set: ((MarkdownTaskTarget, @escaping (Bool) -> Void) -> Void)?

    static let preview = MarkdownTaskBoxes(lock: "Open the note in Read or Split to check off its tasks.", set: nil)

    static func locked(_ reason: String) -> MarkdownTaskBoxes { MarkdownTaskBoxes(lock: reason, set: nil) }

    var editable: Bool { lock == nil && set != nil }

    /// What the page is told, compared to send it only when it changed.
    var pageMode: String { "\(editable)|\(lock ?? "")" }
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
            return GitHunks.between(old: oldBody, new: newBody).filter { !$0.isTrailingNewlineOnly }.flatMap { hunk -> [DiffMark] in
                // A line diff can absorb a removed paragraph into the preceding replacement.
                // Keep the paragraph boundary so the renderer can pair the changed paragraph.
                if hunk.kind == .modified, hunk.newCount > 0,
                   hunk.oldLines.firstIndex(of: "") == hunk.newCount,
                   hunk.oldLines.count > hunk.newCount + 1 {
                    return [
                        DiffMark(first: hunk.newStart, last: hunk.newStart + hunk.newCount - 1, kind: .modified,
                                 old: hunk.oldLines.prefix(hunk.newCount).joined(separator: "\n")),
                        DiffMark(first: hunk.newStart + hunk.newCount, last: hunk.newStart + hunk.newCount, kind: .deleted,
                                 old: hunk.oldLines.dropFirst(hunk.newCount + 1).joined(separator: "\n")),
                    ]
                }
                return [DiffMark(first: hunk.newStart, last: hunk.newStart + max(1, hunk.newCount) - 1, kind: hunk.kind,
                                 old: hunk.oldLines.joined(separator: "\n"))]
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
    /// Split view, preview to editor: the body line at the top after the reader scrolled the page.
    var onTopLine: ((Int) -> Void)? = nil
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
    /// What a click on a task box does. The default is a page that shows the boxes and cannot change the note (a
    /// hover preview, a diff, a past version).
    var tasks: MarkdownTaskBoxes = .preview

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
        let reverseSync = onTopLine != nil
        if c.lastReverseSync != reverseSync {
            c.lastReverseSync = reverseSync
            c.eval("window.gnReverseSync(\(reverseSync))")
        }
        // Before the render below: the code block bar is drawn by the page's fence renderer, the boxes by the task rule.
        let extrasNeedRender = c.syncPageExtras()
        if c.lastTaskMode != tasks.pageMode {
            c.lastTaskMode = tasks.pageMode
            c.applyTaskMode()
        }
        let shown = c.shownText(for: markdown)
        if extrasNeedRender || c.lastMarkdown != shown || c.lastMediaContext != mediaContext || c.lastLineNumbers != lineNumbers {
            c.lastMarkdown = shown
            c.lastMediaContext = mediaContext
            c.lastLineNumbers = lineNumbers
            c.render(shown)
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
        let allowed = GenesisKitMarkdownConfiguration.shared.pictureFolders
            .map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
        return MarkdownMedia.Context(folder: documentURL.deletingLastPathComponent(), vaultRoot: vault, extraRoots: allowed)
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
        var lastReverseSync: Bool?
        var lastLineNumbers: Bool?
        var lastLineHighlight: LineHighlight?
        var lastGitMarks: [GitMark] = []
        var lastDiffMarks: [DiffMark] = []
        /// `MarkdownTaskBoxes.pageMode` as last sent to the page.
        var lastTaskMode: String?
        /// The texts the page showed before a task click whose answer has not come back. An update that brings one of
        /// them is the document from before the click, not a change to draw.
        var taskHolds: [String] = []
        /// Counts the texts the host handed the page (the note reloaded, another document), not the page's own clicks.
        /// A refused click puts its box back only while this count is the one it saw: after a new text the page shows
        /// that text's boxes, and the box on the clicked line can be another item.
        var drawings = 0

        /// The text to draw for the host's `markdown`. The text from before a task click whose write is on its way
        /// keeps the drawn one: the page already shows the box as clicked, so drawing that text again would flip it
        /// back for a moment. Any other new text counts as a new drawing.
        func shownText(for markdown: String) -> String {
            let shown = taskHolds.contains(markdown) ? (lastMarkdown ?? markdown) : markdown
            if shown != lastMarkdown { drawings += 1 }
            return shown
        }
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
                        let extras = self.syncPageExtras()
                        // A folder allowed or removed in Settings changes which pictures the page may show.
                        let folders = self.lastMediaContext != self.parent.mediaContext
                        if folders { self.lastMediaContext = self.parent.mediaContext }
                        if extras || folders, let markdown = self.lastMarkdown {
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

        /// Turns the boxes on or off in place, and gives a disabled box the reason as its tooltip.
        func applyTaskMode() {
            let tasks = parent.tasks
            eval("window.gnTaskMode(\(tasks.editable),\(MarkdownWebView.jsString(tasks.lock ?? "")))")
        }

        /// A click on a task box. The page already shows the new state. The item is found in the text the page drew,
        /// the host sets it in the note, and the page keeps its drawing: no render, so no flicker, no scroll change and
        /// the keyboard stays on the box. A refusal puts the box back.
        @MainActor
        func setTask(_ body: [String: Any]) {
            guard let line = body["line"] as? Int, let checked = body["checked"] as? Bool else { return }
            let text = body["text"] as? String ?? ""
            guard let set = parent.tasks.set, parent.tasks.lock == nil, let drawn = lastMarkdown else {
                eval("window.gnTaskRevert(\(line),\(!checked))")
                return
            }
            guard let target = MarkdownTaskList.target(bodyLine: line, text: text, checked: checked, in: drawn) else {
                MarkdownWebView.report("task: body line \(line) is no task in the drawn text")
                eval("window.gnTaskRevert(\(line),\(!checked))")
                show(.taskNotFound)
                return
            }
            // nil when the drawn text already has that state: the drawing stays as it is.
            let after = MarkdownTaskList.applying(target, to: drawn) ?? drawn
            taskHolds.append(drawn)
            lastMarkdown = after
            let drawing = drawings
            let document = parent.documentURL
            set(target) { [weak self] applied in
                guard let self else { return }
                if let index = self.taskHolds.firstIndex(of: drawn) { self.taskHolds.remove(at: index) }
                guard !applied else { return }
                // The document did not take it. Once the host handed the page another text (the note reloaded while the
                // write was on its way, or this page shows another document), the page draws that text's own boxes,
                // and the box on this line may be another item: nothing is put back.
                guard self.drawings == drawing, self.parent.documentURL == document, let current = self.lastMarkdown else {
                    return
                }
                // The page's text loses this click, and keeps a later click on another box that is still on its way.
                if let undo = MarkdownTaskList.target(bodyLine: line, text: text, checked: !checked, in: current),
                   let undone = MarkdownTaskList.applying(undo, to: current) {
                    self.lastMarkdown = undone
                }
                self.eval("window.gnTaskRevert(\(line),\(!checked))")
            }
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
        /// The document of the last render. A render of the same one keeps the reader's place by block
        /// (`gnCaptureAnchor`); the first render here, or another document, does not look for the old place.
        private var renderedDocument: URL?
        private var renderedOnce = false

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
            let same = renderedOnce && renderedDocument == parent.documentURL
            renderedOnce = true
            renderedDocument = parent.documentURL
            web?.evaluateJavaScript(
                "window.gnRender(\(MarkdownWebView.jsString(body)),\(props),\(editable),\(vocabulary),\(mediaJSON),\(parent.lineNumbers),\(tag),\(same))"
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
            // A recycled or reloaded page receives the current reverse-sync state too.
            eval("window.gnReverseSync(\(parent.onTopLine != nil))")
            // Before the render: the task rule draws a box enabled or disabled.
            lastTaskMode = parent.tasks.pageMode
            applyTaskMode()
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
            case "pictureSettings":
                // The pill of a picture outside the allowed folders: the setting that allows one, opened for the reader.
                MainActor.assumeIsolated {
                    MarkdownSettingsWindow.shared.show(nil)
                    NativeSettingsHighlightCenter.shared.request(MarkdownSettingsView.picturesAnchor)
                }
            case "propsRemoved":
                let name = body["key"] as? String ?? ""
                let notice: MarkdownPageNotice = (body["item"] as? String).map { .itemRemoved($0, from: name) }
                    ?? .propertyRemoved(name)
                MainActor.assumeIsolated { show(notice) }
            case "pageError":
                MarkdownWebView.report("page error line \(body["line"] as? Int ?? 0): \(body["message"] as? String ?? "?")")
            case "scroll":
                if let top = body["top"] as? Double { parent.onScroll?(top) }
            case "topLine":
                if let line = body["line"] as? Int { parent.onTopLine?(line) }
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
            case "task":
                MainActor.assumeIsolated { setTask(body) }
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
        /// How a checked task's text looks. A class on the page's body, so a change needs no render.
        var taskDone: MarkdownTaskDoneStyle

        init(headingAnchors: Bool, codeBlockBar: Bool, stickySection: Bool, taskDone: MarkdownTaskDoneStyle = .dim) {
            self.headingAnchors = headingAnchors
            self.codeBlockBar = codeBlockBar
            self.stickySection = stickySection
            self.taskDone = taskDone
        }

        @MainActor
        init(_ config: GenesisKitMarkdownConfiguration) {
            self.init(headingAnchors: config.headingAnchors, codeBlockBar: config.codeBlockBar, stickySection: config.stickySection,
                      taskDone: config.taskDoneStyle)
        }

        /// The call that hands them to the page.
        var script: String {
            "window.gnPage({anchors:\(headingAnchors),codeBar:\(codeBlockBar),sticky:\(stickySection),taskDone:'\(taskDone.rawValue)'})"
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
    /// Per launch. The page loads its scripts from genres:; the nonce stays private,
    /// so document HTML cannot authorize inline scripts or handlers through the CSP.
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
<link rel="stylesheet" href="genres://asset/markdown-page.css">
</head>
<body>
<div id="gn-column"><div class="gn-grip gn-grip-l" role="separator" aria-orientation="vertical" aria-label="Reading width" aria-keyshortcuts="ArrowLeft ArrowRight Enter" tabindex="0"></div><article id="gn-article"></article><div class="gn-grip gn-grip-r" role="separator" aria-orientation="vertical" aria-label="Reading width" aria-keyshortcuts="ArrowLeft ArrowRight Enter" tabindex="0"></div></div>
<nav id="gn-sticky" aria-label="Current section"><div class="gn-sticky-in"></div></nav><div id="gn-toast" role="status" aria-live="polite"></div><div id="gn-live" role="status" aria-live="polite"></div>
<script src="genres://asset/markdown-init.js"></script>
<script src="genres://asset/markdown-page.js"></script>
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
