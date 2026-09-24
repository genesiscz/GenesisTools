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
    /// kept reloading.
    private var latest: [(method: String, script: String)] = []
    /// When the web content process last died, for the reload limit in `webViewWebContentProcessDidTerminate`.
    private var recentTerminations: [Date] = []

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(DiffViewerSchemeHandler(), forURLScheme: Self.scheme)
        let controller = WKUserContentController()
        configuration.userContentController = controller
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        controller.add(WeakMessageHandler(self), name: "genesisDiff")
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.load(URLRequest(url: URL(string: "\(Self.scheme)://viewer/index.html")!))
    }

    func show(_ files: [DiffFile]) {
        let payload = files.map { file in
            BridgeFile(
                id: file.id,
                path: file.path,
                oldPath: file.oldPath,
                oldContents: file.skipped == nil ? file.oldContents : nil,
                newContents: file.skipped == nil ? file.newContents : "(\(file.skipped!))\n"
            )
        }
        call("setFiles", payload)
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
            onEvent?(.ready)
        case "rendered":
            onEvent?(.rendered(count: body["count"] as? Int ?? 0))
        case "error":
            onEvent?(.failed(body["message"] as? String ?? "unknown page error"))
        case "comment.add", "comment.edit":
            guard let fileID = body["fileId"] as? String,
                  let start = body["startLine"] as? Int,
                  let end = body["endLine"] as? Int,
                  let text = body["body"] as? String
            else { return }
            onEvent?(.commentSubmitted(CommentInput(
                editingID: type == "comment.edit" ? body["id"] as? String : nil,
                fileID: fileID,
                side: DiffSide(rawValue: body["side"] as? String ?? "") ?? .additions,
                startLine: start,
                endLine: end,
                body: text
            )))
        case "open":
            if let fileID = body["fileId"] as? String, let line = body["line"] as? Int {
                onEvent?(.openLine(fileID: fileID, line: line, side: DiffSide(rawValue: body["side"] as? String ?? "") ?? .additions))
            }
        case "comment.delete":
            if let id = body["id"] as? String {
                onEvent?(.commentDeleted(id: id))
            }
        case "comment.action":
            if let id = body["id"] as? String, let action = body["action"] as? String {
                onEvent?(.commentAction(id: id, action: action))
            }
        default:
            break
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
}

private struct BridgeOptions: Encodable {
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
