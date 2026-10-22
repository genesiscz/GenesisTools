import AppKit
import Foundation
import GenesisKit
import WebKit

/// DiffRenderer backed by @pierre/diffs (the renderer behind t3code / diffs.com) in a WKWebView.
/// The page is bundled into Contents/Resources/diff-viewer by `tools macos permissions build`
/// (web/diff-viewer/main.ts) and served through the `genesis-diff://` scheme, because its ES
/// module chunks (one per Shiki grammar) do not load from file://.
public final class PierreWebDiffRenderer: NSObject, DiffRenderer, WKScriptMessageHandler, WKNavigationDelegate {
    public static let scheme = "genesis-diff"

    /// One renderer made ahead, for the hub's next review. A new web view costs the main thread
    /// 140 ms (median) to 1.2 s while its web content process starts (130 times on 2026-10-08), and the
    /// hub makes one for every session, worktree or PR it shows changes for: that wait sat on the click.
    /// The spare is a fresh page with no review's state; it is made in a quiet moment after one is taken.
    @MainActor private static var spare: PierreWebDiffRenderer?
    @MainActor private static var spareScheduled = false

    /// The spare when there is one, else a new renderer; another is prepared once interaction settles.
    @MainActor public static func make() -> PierreWebDiffRenderer {
        let made = spare ?? PierreWebDiffRenderer()
        spare = nil
        scheduleSpare()
        return made
    }

    @MainActor private static func scheduleSpare() {
        guard !spareScheduled else { return }
        spareScheduled = true
        let meter = MainBusy.Meter()
        meter.start()
        let deadline = CFAbsoluteTimeGetCurrent() + 10
        var lastBusy = 0.0
        var quiet = 0
        var lastInput = CFAbsoluteTimeGetCurrent()
        let monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel, .mouseMoved]) { event in
            lastInput = CFAbsoluteTimeGetCurrent()
            return event
        }
        func check() {
            let now = CFAbsoluteTimeGetCurrent()
            let busy = meter.read().busyMs
            let step = busy - lastBusy
            lastBusy = busy
            let interacting = now - lastInput < 0.75 || NSEvent.pressedMouseButtons != 0 || NSApp.windows.contains(where: \.inLiveResize)
            quiet = !interacting && step < 20 ? quiet + 1 : 0
            guard quiet >= 3 || now >= deadline else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { MainActor.assumeIsolated { check() } }
                return
            }
            meter.stop()
            if let monitor { NSEvent.removeMonitor(monitor) }
            spareScheduled = false
            guard quiet >= 3, spare == nil else { return }
            spare = PerfSpans.measure("review.renderer.spare") { PierreWebDiffRenderer() }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { MainActor.assumeIsolated { check() } }
    }

    public let webView: WKWebView
    public var view: NSView { webView }
    public var onEvent: ((DiffRendererEvent) -> Void)?

    private var ready = false
    /// The latest call per method, replayed on every `ready`: the first load, and the reload after the
    /// web content process dies (memory pressure), which would otherwise leave the pane blank. One
    /// entry per method keeps it bounded: an unbounded queue of full-file `setFiles` payloads was the
    /// 550 GB leak of 2026-09-24, when a hidden web view never became ready while the repo watcher
    /// kept reloading. Files are not in it: `sendFiles` streams them and starts again on `ready`.
    private var latest: [(method: String, script: String)] = []
    /// When the web content process last died, for the reload limit in `webViewWebContentProcessDidTerminate`.
    private var recentTerminations: [Date] = []
    /// The file set the page shows. It goes in batches (`DiffBatchPlan`), each after the page ran the
    /// one before, and a new `show` or a page reload starts it again under a new generation.
    private var files: [DiffFile] = []
    private var filesFresh = true
    private var filesGeneration = 0
    /// JSON for a large diff is tens of MB: it is encoded here, never on the main thread.
    private let encodeQueue = DispatchQueue(label: "com.genesiscz.genesistools.diff-encode", qos: .userInitiated)

    public override init() {
        let configuration = WKWebViewConfiguration()
        // Tab stops on the page's links too (a thread author, a link in a comment), not only on fields.
        configuration.preferences.tabFocusesLinks = true
        configuration.setURLSchemeHandler(DiffViewerSchemeHandler(), forURLScheme: Self.scheme)
        let controller = WKUserContentController()
        configuration.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        controller.add(WeakMessageHandler(self), name: "genesisDiff")
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://viewer/index.html")!))
        // ⌘F is the diff's find when the keyboard is in the diff: the last click landed in it, or
        // it holds the first responder (Hub/HubPanelFind.swift decides, for every panel at once).
        MainActor.assumeIsolated {
            GenesisKit.host?.registerNativeFind(webView, scope: "diff") { [weak self] in self?.find() }
        }
        keepContentStillWhenTopMoves()
    }


    // MARK: Content still when the header above changes height

    /// The web view's distance from the window's top and its width, the last time its frame changed.
    private var topInset: CGFloat?
    private var lastWidth: CGFloat?
    private var frameObserver: NSObjectProtocol?

    /// The hub builds a renderer per worktree, session and PR; each one's observer goes with it.
    deinit {
        if let frameObserver {
            NotificationCenter.default.removeObserver(frameObserver)
        }
    }

    /// The rows above the diff (header, PR bar, notices) change height when the diff column changes width:
    /// a side panel's release re-wraps the header, and the diff's top edge moved by that much, so the code
    /// under the reader slid with it (recording 2026-10-07). When the top edge moves inside an unchanged
    /// window, the page scrolls by the same amount and the code stays where it was on screen.
    private func keepContentStillWhenTopMoves() {
        webView.postsFrameChangedNotifications = true
        frameObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: webView,
                                                               queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.frameChanged() }
        }
    }

    @MainActor
    private func frameChanged() {
        guard let window = webView.window, let content = window.contentView else {
            topInset = nil
            return
        }

        let inset = content.bounds.height - webView.convert(webView.bounds, to: nil).maxY
        let width = webView.bounds.width
        defer {
            topInset = inset
            lastWidth = width
        }
        guard let previous = topInset, let delta = DiffTopShift.scrollBy(previous: previous, now: inset, widthChanged: lastWidth.map { abs($0 - width) >= 1 } ?? false,
                                                                         windowResizing: window.inLiveResize) else { return }
        PerfSpans.log("review.diff top moved \(Int(delta)) pt: the page scrolls with it")
        webView.evaluateJavaScript("(() => { const host = document.getElementById('review'); if (host) host.scrollTop += \(delta); })()")
    }

    public func show(_ files: [DiffFile], fresh: Bool) {
        self.files = files
        filesFresh = fresh
        filesGeneration += 1
        if ready {
            sendFiles()
        }
    }

    /// Sends `files` batch by batch. Each batch is encoded off the main thread and evaluated only when
    /// the page finished the previous one, so the first files paint while the rest are still coming
    /// and the web view's IPC never holds the whole diff at once.
    private func sendFiles() {
        let generation = filesGeneration
        let files = files
        let fresh = filesFresh
        let batches = DiffBatchPlan.ranges(sizes: files.map(DiffBatchPlan.size))
        let span = PerfSpans.begin("review.send", "\(files.count) files, \(batches.count) batches", awaits: true)
        sendBatch(0, batches, files: files, fresh: fresh, generation: generation, span: span)
    }

    private func sendBatch(_ index: Int, _ batches: [Range<Int>], files: [DiffFile], fresh: Bool, generation: Int, span: PerfSpans.Span) {
        encodeQueue.async { [weak self] in
            let batch = BridgeFilesBatch(
                generation: generation,
                fresh: fresh,
                first: index == 0,
                last: index == batches.count - 1,
                total: files.count,
                files: files[batches[index]].map(BridgeFile.init)
            )
            guard let data = try? JSONEncoder().encode(batch), let json = String(data: data, encoding: .utf8) else {
                DispatchQueue.main.async { self?.onEvent?(.failed("could not encode a batch of \(batch.files.count) files")) }
                return
            }

            let script = "window.genesisDiff.addFiles(\(json));"
            DispatchQueue.main.async {
                guard let self, self.ready, generation == self.filesGeneration else {
                    span.end("superseded at batch \(index + 1)")
                    return
                }

                self.webView.evaluateJavaScript(script) { [weak self] _, error in
                    if let error {
                        self?.onEvent?(.failed("addFiles: \(error.localizedDescription)"))
                    }
                    if index + 1 < batches.count {
                        self?.sendBatch(index + 1, batches, files: files, fresh: fresh, generation: generation, span: span)
                    } else {
                        span.end()
                    }
                }
            }
        }
    }

    /// Opens the page's find bar. Not replayed after a page reload: a find bar that opens on its own
    /// would take the keyboard.
    public func find() {
        guard ready else { return }
        if let window = webView.window, window.firstResponder !== webView {
            window.makeFirstResponder(webView)
        }
        webView.evaluateJavaScript("window.genesisDiff.find();", completionHandler: nil)
    }

    public func apply(_ options: DiffViewOptions) {
        call("setOptions", BridgeOptions(diffStyle: options.diffStyle.rawValue, wrap: options.wrap, fontSize: options.fontSize))
    }

    public func reveal(fileID: String) {
        call("reveal", fileID)
    }

    public func showComments(_ comments: [RenderedComment]) {
        call("setComments", comments)
    }

    public func threadActionFinished(id: String, ok: Bool) {
        call("threadDone", BridgeThreadDone(id: id, ok: ok))
    }

    public func setThreadSelection(_ ids: [String]) {
        call("setSelection", ids)
    }

    /// Not replayed after a page reload: the reloaded page would jump to a thread on its own.
    public func focusThread(cardID: String?, reply: Bool) {
        evaluateOnce("focusThread", BridgeFocusThread(id: cardID, reply: reply))
    }

    public func showKeys(_ show: Bool) {
        evaluateOnce("showKeys", show)
    }

    public func setBlame(_ payload: AgentBlamePayload) {
        call("setBlame", payload)
    }

    public func showBlame(fileID: String, line: Int) {
        evaluateOnce("showBlameAt", BridgeBlameAt(fileId: fileID, line: line))
    }

    private func evaluateOnce<T: Encodable>(_ method: String, _ argument: T) {
        guard ready, let data = try? JSONEncoder().encode(argument), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.genesisDiff.\(method)(\(json));") { [weak self] _, error in
            if let error {
                self?.onEvent?(.failed("\(method): \(error.localizedDescription)"))
            }
        }
    }

    /// The page may still be loading or reloading; its next `ready` message replays the latest calls.
    private func call<T: Encodable>(_ method: String, _ argument: T) {
        guard let data = try? JSONEncoder().encode(argument), let json = String(data: data, encoding: .utf8) else {
            onEvent?(.failed("could not encode \(method) payload"))
            return
        }

        let script = "window.genesisDiff.\(method)(\(json));"
        latest.removeAll { $0.method == method }
        latest.append((method, script))
        if ready {
            webView.evaluateJavaScript(script) { [weak self] _, error in
                if let error {
                    self?.onEvent?(.failed("\(method): \(error.localizedDescription)"))
                }
            }
        }
    }

    public func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            // A reveal needs its file on the page, so it goes after the files it may precede in `latest`.
            for entry in latest.filter({ $0.method != "reveal" }) + latest.filter({ $0.method == "reveal" }) {
                webView.evaluateJavaScript(entry.script, completionHandler: nil)
            }
            // A new page has nothing: the files go again from the first batch, under a new generation
            // so a batch still in flight for the dead page stops there.
            filesGeneration += 1
            filesFresh = true
            sendFiles()
            onEvent?(.ready)
        case "rendered":
            // A set replaced before the page showed it says nothing about the set on screen now.
            guard body["generation"] as? Int == filesGeneration else { return }
            onEvent?(.rendered(count: body["count"] as? Int ?? 0))
        case "log":
            // A page event worth a line in app-perf.log (a fold, …): the page has no log of its own.
            PerfLog.mark("page \(body["message"] as? String ?? "")")
        default:
            // Every other message decodes without renderer state (DiffModel.swift), so tests pin
            // the page's literal shapes against the same code.
            if let event = DiffRendererEvent(pageMessage: body) {
                onEvent?(event)
            } else {
                PerfSpans.log("review.page message dropped: \(type) lacks a field its receiver needs")
            }
        }
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        // If the replayed payload itself exhausts memory, each reload dies again: stop after 3 in a minute.
        let now = Date()
        recentTerminations = recentTerminations.filter { now.timeIntervalSince($0) < 60 } + [now]
        guard recentTerminations.count <= 3 else {
            FileHandle.standardError.write(Data("review renderer: web content process ended \(recentTerminations.count) times in 60 s, not reloading\n".utf8))
            onEvent?(.failed("diff viewer crashed repeatedly; the diff may be too large"))
            return
        }

        // Not `.failed`: that sets the window's error, and the reload below recovers on its own.
        FileHandle.standardError.write(Data("review renderer: web content process ended, reloading\n".utf8))
        webView.reload()
    }

    /// The page's links have an href for the keyboard and VoiceOver, but a click goes through the
    /// page's `link` message (the browser opens it); a link navigation never replaces the diff.
    public func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.navigationType == .linkActivated ? .cancel : .allow)
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onEvent?(.failed("viewer navigation failed: \(error.localizedDescription)"))
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onEvent?(.failed("viewer did not load: \(error.localizedDescription)"))
    }
}

private struct BridgeFile: Encodable {
    public let id: String
    public let path: String
    public let oldPath: String?
    public let oldContents: String?
    public let newContents: String?
    /// Changes when either side's text changes; the page keeps the parsed diff of a file whose key it has.
    public let key: String
    /// An image file's two sides as `genesis-diff://viewer/_image/<token>` URLs; the page shows the pictures.
    public let image: BridgeImage?

    public struct BridgeImage: Encodable {
        public let old: String?
        public let new: String?
    }

    public init(_ file: DiffFile) {
        id = file.id
        path = file.path
        oldPath = file.oldPath
        oldContents = file.skipped == nil ? file.oldContents : nil
        newContents = file.skipped.map { "(\($0))\n" } ?? file.newContents
        // Hasher is seeded per process, and the page's cache lives no longer than the process.
        var hasher = Hasher()
        hasher.combine(file.path)
        hasher.combine(file.oldPath)
        hasher.combine(oldContents)
        hasher.combine(newContents)
        hasher.combine(file.image)
        key = String(hasher.finalize(), radix: 36)
        image = file.image.map { image in
            BridgeImage(old: image.old.map { DiffImageRegistry.url($0, revision: image.revision) },
                        new: image.new.map { DiffImageRegistry.url($0, revision: image.revision) })
        }
    }
}

private struct BridgeFilesBatch: Encodable {
    public let generation: Int
    public let fresh: Bool
    public let first: Bool
    public let last: Bool
    public let total: Int
    public let files: [BridgeFile]

    public init(generation: Int, fresh: Bool, first: Bool, last: Bool, total: Int, files: [BridgeFile]) {
        self.generation = generation
        self.fresh = fresh
        self.first = first
        self.last = last
        self.total = total
        self.files = files
    }
}

/// How a file set is cut into batches for the page: a small first batch so the first files paint
/// at once, then batches of up to `batchBytes` or `batchFiles`. A file larger than a batch goes alone.
public enum DiffBatchPlan {
    public static let firstBytes = 256 * 1024
    public static let firstFiles = 16
    public static let batchBytes = 2 * 1024 * 1024
    public static let batchFiles = 120

    /// The text a file puts on the wire (both sides; a skipped file sends a one-line note).
    public static func size(_ file: DiffFile) -> Int {
        file.skipped == nil ? (file.oldContents?.utf8.count ?? 0) + (file.newContents?.utf8.count ?? 0) : 64
    }

    /// Consecutive index ranges covering every size, in order. No files is one empty batch: the page
    /// still needs its first-and-last batch to show the empty set.
    public static func ranges(sizes: [Int]) -> [Range<Int>] {
        var ranges: [Range<Int>] = []
        var start = 0
        var bytes = 0
        for (index, size) in sizes.enumerated() {
            let first = ranges.isEmpty
            let limitBytes = first ? firstBytes : batchBytes
            let limitFiles = first ? firstFiles : batchFiles
            if index > start, bytes + size > limitBytes || index - start >= limitFiles {
                ranges.append(start..<index)
                start = index
                bytes = 0
            }
            bytes += size
        }
        ranges.append(start..<sizes.count)
        return ranges
    }
}

public struct BridgeThreadDone: Encodable {
    public let id: String
    public let ok: Bool

    public init(id: String, ok: Bool) {
        self.id = id
        self.ok = ok
    }
}

public struct BridgeBlameAt: Encodable {
    public let fileId: String
    public let line: Int

    public init(fileId: String, line: Int) {
        self.fileId = fileId
        self.line = line
    }
}

/// The page types `id` as `string | null` and clears its mark on null. The synthesized encoder
/// leaves a nil key out, so the page got `undefined` instead: `id` is always written.
public struct BridgeFocusThread: Encodable {
    public let id: String?
    public let reply: Bool

    private enum CodingKeys: String, CodingKey { case id, reply }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(reply, forKey: .reply)
    }

    public init(id: String?, reply: Bool) {
        self.id = id
        self.reply = reply
    }
}

public struct BridgeOptions: Encodable {
    public let diffStyle: String
    public let wrap: Bool
    public let fontSize: Double

    public init(diffStyle: String, wrap: Bool, fontSize: Double) {
        self.diffStyle = diffStyle
        self.wrap = wrap
        self.fontSize = fontSize
    }
}

/// WKUserContentController retains its handlers; this breaks the renderer <-> web view cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    public weak var target: WKScriptMessageHandler?

    public init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    public func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

extension PierreWebDiffRenderer {
    /// The diff page's folder: Contents/Resources/diff-viewer, or GENESIS_DIFF_VIEWER_DIR during development.
    public static let viewerRoot: URL? = {
        if let override = ProcessInfo.processInfo.environment["GENESIS_DIFF_VIEWER_DIR"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }

        return Bundle.main.resourceURL?.appendingPathComponent("diff-viewer", isDirectory: true)
    }()

    /// Whether this app bundles the diff page; without it the renderer shows an empty view.
    public static var isBundled: Bool {
        guard let root = viewerRoot else { return false }
        return FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
    }
}

/// The image sources the page may ask for, by token. A token names its source for the whole process, so a page
/// that kept an old URL still gets its picture.
enum DiffImageRegistry {
    static let prefix = "/_image/"
    private static let lock = NSLock()
    private static var sources: [String: DiffImage.Source] = [:]

    /// The page caches an image by its URL, so the URL carries the file's revision: an overwritten image loads again.
    static func url(_ source: DiffImage.Source, revision: String? = nil) -> String {
        var hasher = Hasher()
        hasher.combine(source)
        hasher.combine(revision)
        let token = String(UInt(bitPattern: hasher.finalize()), radix: 36)
        lock.withLock { sources[token] = source }
        return "\(PierreWebDiffRenderer.scheme)://viewer\(prefix)\(token)"
    }

    static func source(_ token: String) -> DiffImage.Source? {
        lock.withLock { sources[token] }
    }

    /// The largest picture a diff loads. The text diff skips files over `GitWorkingTreeSource.maxBytes`, and those
    /// are the images shown here, so the read needs a bound of its own.
    static let maxBytes = 20_000_000

    /// The bytes and the path whose extension names their type; nil for a side over `maxBytes`, and for a symlink
    /// (it would read a file outside the repository). Runs git or reads the disk, so off the main thread.
    static func load(_ source: DiffImage.Source, maxBytes: Int = maxBytes) -> (data: Data, path: String)? {
        switch source {
        case .file(let path):
            let url = URL(fileURLWithPath: path)
            guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]),
                  values.isSymbolicLink != true, values.isRegularFile == true,
                  let size = values.fileSize, size <= maxBytes else { return nil }
            return (try? Data(contentsOf: url)).map { ($0, path) }
        case .blob(let repo, let object, let path):
            let folder = URL(fileURLWithPath: repo)
            let git = { (args: [String]) in
                try? GenesisKitGT.provider.git(args, in: folder, input: nil, gitDirectory: nil, environment: nil)
            }
            guard let sized = git(["cat-file", "-s", object]), sized.status == 0,
                  let size = Int(String(decoding: sized.stdout, as: UTF8.self).trimmed), size <= maxBytes,
                  let blob = git(["cat-file", "blob", object]), blob.status == 0 else { return nil }
            return (blob.stdout, path)
        }
    }

    static func mimeType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "heif": return "image/heif"
        case "avif": return "image/avif"
        case "bmp": return "image/bmp"
        case "ico": return "image/x-icon"
        case "tif", "tiff": return "image/tiff"
        // Shown through <img>, where an SVG's scripts never run.
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}

/// Serves `PierreWebDiffRenderer.viewerRoot`, and the diff's images under `DiffImageRegistry.prefix`.
private final class DiffViewerSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root = PierreWebDiffRenderer.viewerRoot
    /// Tasks WebKit stopped (the image row scrolled away): they must get no more calls.
    private var stopped = Set<ObjectIdentifier>()

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        if let url = urlSchemeTask.request.url, url.path.hasPrefix(DiffImageRegistry.prefix) {
            serveImage(url, task: urlSchemeTask)
            return
        }
        guard let url = urlSchemeTask.request.url, let root else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let relative = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        let file = root.appendingPathComponent(relative).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": Self.mimeType(for: file.pathExtension), "Content-Length": String(data.count)]
        )!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func serveImage(_ url: URL, task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        stopped.remove(id)
        guard let source = DiffImageRegistry.source(String(url.path.dropFirst(DiffImageRegistry.prefix.count))) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        Task.detached(priority: .userInitiated) {
            let loaded = DiffImageRegistry.load(source)
            await MainActor.run {
                guard self.stopped.remove(id) == nil else { return }
                guard let loaded else {
                    task.didFailWithError(URLError(.fileDoesNotExist))
                    return
                }
                let response = HTTPURLResponse(
                    url: url,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": DiffImageRegistry.mimeType(for: loaded.path), "Content-Length": String(loaded.data.count)]
                )!
                task.didReceive(response)
                task.didReceive(loaded.data)
                task.didFinish()
            }
        }
    }

    private static func mimeType(for ext: String) -> String {
        switch ext {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        default: return "application/octet-stream"
        }
    }
}

/// How far the diff page scrolls when the web view's top edge moved: by the same amount, so the code
/// stays still on screen. Only when the diff also changed width (the header above re-wrapped at the new
/// width): a notice or banner that appears above the diff keeps the page where it is, or the first lines
/// would hide behind it. Not during a window resize, and not for a move under a point (rounding).
public enum DiffTopShift {
    public static func scrollBy(previous: CGFloat, now: CGFloat, widthChanged: Bool, windowResizing: Bool) -> CGFloat? {
        let delta = now - previous
        guard widthChanged, !windowResizing, abs(delta) >= 1 else { return nil }
        return delta
    }
}
