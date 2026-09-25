import AppKit
import Foundation
import WebKit

/// DiffRenderer backed by @pierre/diffs (the renderer behind t3code / diffs.com) in a WKWebView.
/// The page is bundled into Contents/Resources/diff-viewer by `tools macos permissions build`
/// (web/diff-viewer/main.ts) and served through the `genesis-diff://` scheme, because its ES
/// module chunks (one per Shiki grammar) do not load from file://.
final class PierreWebDiffRenderer: NSObject, DiffRenderer, WKScriptMessageHandler, WKNavigationDelegate {
    static let scheme = "genesis-diff"

    let webView: WKWebView
    var view: NSView { webView }
    var onEvent: ((DiffRendererEvent) -> Void)?

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

    override init() {
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
            PanelFindRouter.shared.registerNative(webView, scope: "diff") { [weak self] in self?.find() }
        }
    }

    func show(_ files: [DiffFile], fresh: Bool) {
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
        let span = HubPerf.begin("review.send", "\(files.count) files, \(batches.count) batches", awaits: true)
        sendBatch(0, batches, files: files, fresh: fresh, generation: generation, span: span)
    }

    private func sendBatch(_ index: Int, _ batches: [Range<Int>], files: [DiffFile], fresh: Bool, generation: Int, span: HubPerf.Span) {
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
    func find() {
        guard ready else { return }
        if let window = webView.window, window.firstResponder !== webView {
            window.makeFirstResponder(webView)
        }
        webView.evaluateJavaScript("window.genesisDiff.find();", completionHandler: nil)
    }

    func apply(_ options: DiffViewOptions) {
        call("setOptions", BridgeOptions(diffStyle: options.diffStyle.rawValue, wrap: options.wrap, fontSize: options.fontSize))
    }

    func reveal(fileID: String) {
        call("reveal", fileID)
    }

    func showComments(_ comments: [RenderedComment]) {
        call("setComments", comments)
    }

    func threadActionFinished(id: String, ok: Bool) {
        call("threadDone", BridgeThreadDone(id: id, ok: ok))
    }

    func setThreadSelection(_ ids: [String]) {
        call("setSelection", ids)
    }

    /// Not replayed after a page reload: the reloaded page would jump to a thread on its own.
    func focusThread(cardID: String?, reply: Bool) {
        evaluateOnce("focusThread", BridgeFocusThread(id: cardID, reply: reply))
    }

    func showKeys(_ show: Bool) {
        evaluateOnce("showKeys", show)
    }

    func setBlame(_ payload: AgentBlamePayload) {
        call("setBlame", payload)
    }

    func showBlame(fileID: String, line: Int) {
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

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
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
                HubPerf.log("review.page message dropped: \(type) lacks a field its receiver needs")
            }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
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
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.navigationType == .linkActivated ? .cancel : .allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onEvent?(.failed("viewer navigation failed: \(error.localizedDescription)"))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onEvent?(.failed("viewer did not load: \(error.localizedDescription)"))
    }
}

private struct BridgeFile: Encodable {
    let id: String
    let path: String
    let oldPath: String?
    let oldContents: String?
    let newContents: String?
    /// Changes when either side's text changes; the page keeps the parsed diff of a file whose key it has.
    let key: String

    init(_ file: DiffFile) {
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
        key = String(hasher.finalize(), radix: 36)
    }
}

private struct BridgeFilesBatch: Encodable {
    let generation: Int
    let fresh: Bool
    let first: Bool
    let last: Bool
    let total: Int
    let files: [BridgeFile]
}

/// How a file set is cut into batches for the page: a small first batch so the first files paint
/// at once, then batches of up to `batchBytes` or `batchFiles`. A file larger than a batch goes alone.
enum DiffBatchPlan {
    static let firstBytes = 256 * 1024
    static let firstFiles = 16
    static let batchBytes = 2 * 1024 * 1024
    static let batchFiles = 120

    /// The text a file puts on the wire (both sides; a skipped file sends a one-line note).
    static func size(_ file: DiffFile) -> Int {
        file.skipped == nil ? (file.oldContents?.utf8.count ?? 0) + (file.newContents?.utf8.count ?? 0) : 64
    }

    /// Consecutive index ranges covering every size, in order. No files is one empty batch: the page
    /// still needs its first-and-last batch to show the empty set.
    static func ranges(sizes: [Int]) -> [Range<Int>] {
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

struct BridgeThreadDone: Encodable {
    let id: String
    let ok: Bool
}

struct BridgeBlameAt: Encodable {
    let fileId: String
    let line: Int
}

/// The page types `id` as `string | null` and clears its mark on null. The synthesized encoder
/// leaves a nil key out, so the page got `undefined` instead: `id` is always written.
struct BridgeFocusThread: Encodable {
    let id: String?
    let reply: Bool

    private enum CodingKeys: String, CodingKey { case id, reply }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(reply, forKey: .reply)
    }
}

struct BridgeOptions: Encodable {
    let diffStyle: String
    let wrap: Bool
    let fontSize: Double
}

/// WKUserContentController retains its handlers; this breaks the renderer <-> web view cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Serves Contents/Resources/diff-viewer (or GENESIS_DIFF_VIEWER_DIR during development).
private final class DiffViewerSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL? = {
        if let override = ProcessInfo.processInfo.environment["GENESIS_DIFF_VIEWER_DIR"] {
            return URL(fileURLWithPath: override, isDirectory: true)
        }

        return Bundle.main.resourceURL?.appendingPathComponent("diff-viewer", isDirectory: true)
    }()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
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

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

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
