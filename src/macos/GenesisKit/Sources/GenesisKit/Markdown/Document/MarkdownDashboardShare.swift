import AppKit
import Foundation
import SwiftUI

/// Decision logic for the markdown viewer's dev-dashboard share button.
/// The view probes localhost and runs `tools dev-dashboard share`; this type
/// only decides what those results mean.
enum MarkdownDashboardShare {
    /// The dev dashboard's fixed port (`src/utils/ui/dashboards.ts`). A 401 is
    /// the Basic-auth challenge, which still means the process answered.
    static let probeURL = URL(string: "http://127.0.0.1:3042/")!
    static let braveAppPath = "/Applications/Brave Browser.app"

    struct Outcome: Equatable {
        var url: URL?
        /// One plain sentence for the reader: what went wrong and what to do.
        var message: String?
        /// What the command itself said, for Details.
        var detail: String?
    }

    /// How long the share command may run before the viewer gives up and says so.
    static let timeoutSeconds = 30

    static func isAvailable(httpStatus: Int?) -> Bool {
        guard let httpStatus else { return false }
        return (100..<600).contains(httpStatus)
    }

    /// `tools dev-dashboard share` prints the public URL on stdout. Later lines
    /// are ignored so a second URL cannot replace the one the command printed.
    static func shareURL(in stdout: String) -> URL? {
        for raw in stdout.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: line),
                  let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  url.host != nil
            else { continue }
            return url
        }
        return nil
    }

    /// Each cause has its own sentence; the command's own output goes to `detail` (UX audit D1).
    static func outcome(exitCode: Int32, stdout: String, stderr: String) -> Outcome {
        if exitCode == 0, let url = shareURL(in: stdout) {
            return Outcome(url: url, message: nil)
        }

        let errorText = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let outputText = stdout.trimmingCharacters(in: .whitespacesAndNewlines)

        if exitCode != 0 {
            let said = errorText.isEmpty ? outputText : errorText
            return Outcome(
                url: nil,
                message: "The dev dashboard could not share this note. Details say why.",
                detail: (said.isEmpty ? "" : said + "\n") + "Exit code \(exitCode)."
            )
        }

        let said = [outputText, errorText].filter { !$0.isEmpty }.joined(separator: "\n")
        return Outcome(
            url: nil,
            message: "The dev dashboard answered without a share link. Try again in a moment.",
            detail: said.isEmpty ? nil : said
        )
    }

    /// A share that could not run at all: the sentence and the raw error.
    static func failure(_ error: Error) -> Outcome {
        switch error {
        case ToolsBridgeError.timeout:
            return Outcome(
                url: nil,
                message: "The dev dashboard did not answer within \(timeoutSeconds) seconds. Check that it is running, then share again."
            )
        case ToolsBridgeError.binaryNotFound:
            return Outcome(url: nil, message: error.localizedDescription)
        default:
            return Outcome(url: nil, message: "The share could not start.", detail: error.localizedDescription)
        }
    }
}

/// Probes the local dashboard and publishes the open note when the button is used.
@MainActor
final class MarkdownShareModel: ObservableObject {
    @Published private(set) var available = false
    @Published private(set) var busy = false
    /// The failure's sentence. Set after `errorDetail`, so a view that reacts to it reads both.
    @Published var error: String?
    /// What the command or the system said, for Details.
    @Published private(set) var errorDetail: String?
    /// The running share, for `cancel`.
    private var running: Task<Void, Never>?

    /// Starts a share that `cancel` can stop (it ends the `tools` process).
    func start(note: URL) {
        guard !busy else { return }
        running = Task { await share(note: note) }
    }

    /// Stops a running share without an error: the person chose to.
    func cancel() {
        running?.cancel()
        running = nil
    }

    func refresh() async {
        let up = await Self.probe()

        if up != available {
            available = up
        }
    }

    func share(note: URL) async {
        guard !busy else { return }
        busy = true
        error = nil
        errorDetail = nil
        defer { busy = false }

        let bridge = ToolsBridge(binaryPath: GenesisKit.host?.toolsBinaryPath ?? ToolsBridge.resolveBinaryPath(configured: nil))

        do {
            let result = try await bridge.run(
                subcommand: "dev-dashboard",
                args: ["share", note.path],
                timeoutSeconds: MarkdownDashboardShare.timeoutSeconds
            )
            let outcome = MarkdownDashboardShare.outcome(
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr
            )

            guard !Task.isCancelled else { return }
            guard let url = outcome.url else {
                fail(outcome)
                return
            }

            // The confirmation: "Copied share link" beside the pointer, whichever browser opens it.
            Clipboard.copy(url.absoluteString, what: "share link")
            open(url, in: GenesisKitMarkdownConfiguration.shared.shareOpensIn)
        } catch is CancellationError {
            GenesisKit.log("viewer: share cancelled")
        } catch {
            if Task.isCancelled { return }
            fail(MarkdownDashboardShare.failure(error))
        }
    }

    private func fail(_ outcome: MarkdownDashboardShare.Outcome) {
        errorDetail = outcome.detail
        error = outcome.message
    }

    private func open(_ url: URL, in browser: MarkdownShareBrowser) {
        switch browser {
        case .none:
            return
        case .system:
            NSWorkspace.shared.open(url)
        case .brave:
            let app = URL(fileURLWithPath: MarkdownDashboardShare.braveAppPath)
            // No Brave: the system browser opens the link, which is a working share, not an error.
            guard FileManager.default.fileExists(atPath: app.path) else {
                GenesisKit.log("viewer: share opens in the system browser, Brave is not installed")
                NSWorkspace.shared.open(url)
                return
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: config) { _, openError in
                guard let openError else { return }
                Task { @MainActor in
                    GenesisKit.log("viewer: Brave did not open the share link: \(openError)")
                    self.errorDetail = openError.localizedDescription
                    self.error = "Brave did not open the share link. It is on the clipboard."
                }
            }
        }
    }

    private static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 1.5
        config.timeoutIntervalForResource = 1.5
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private static func probe() async -> Bool {
        var request = URLRequest(url: MarkdownDashboardShare.probeURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 1.5

        do {
            let (_, response) = try await probeSession.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode
            return MarkdownDashboardShare.isAvailable(httpStatus: status)
        } catch {
            return false
        }
    }
}
