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
        var message: String?
    }

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

    static func outcome(exitCode: Int32, stdout: String, stderr: String) -> Outcome {
        if exitCode == 0, let url = shareURL(in: stdout) {
            return Outcome(url: url, message: nil)
        }

        let detail = stderr
            .split(whereSeparator: \.isNewline)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty }

        if let detail {
            return Outcome(url: nil, message: detail)
        }

        if exitCode != 0 {
            return Outcome(url: nil, message: "dev-dashboard share exited \(exitCode)")
        }

        return Outcome(url: nil, message: "dev-dashboard share did not print a URL")
    }
}

/// Probes the local dashboard and publishes the open note when the button is used.
@MainActor
final class MarkdownShareModel: ObservableObject {
    @Published private(set) var available = false
    @Published private(set) var busy = false
    @Published var error: String?

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
        defer { busy = false }

        let bridge = ToolsBridge(binaryPath: GenesisKit.host?.toolsBinaryPath ?? ToolsBridge.resolveBinaryPath(configured: nil))

        do {
            let result = try await bridge.run(
                subcommand: "dev-dashboard",
                args: ["share", note.path],
                timeoutSeconds: 30
            )
            let outcome = MarkdownDashboardShare.outcome(
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr
            )

            guard let url = outcome.url else {
                error = outcome.message
                return
            }

            copyToClipboard(url)
            openInBrave(url)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func copyToClipboard(_ url: URL) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url.absoluteString, forType: .string)
    }

    private func openInBrave(_ url: URL) {
        let app = URL(fileURLWithPath: MarkdownDashboardShare.braveAppPath)

        guard FileManager.default.fileExists(atPath: app.path) else {
            error = "Brave Browser is not installed. The share URL is on the clipboard."
            NSWorkspace.shared.open(url)
            return
        }

        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: config) { _, openError in
            guard let openError else { return }
            Task { @MainActor in
                self.error = openError.localizedDescription
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
