import AppKit
import os
import SwiftUI

/// What an app lends the kit: where its log lines go, how it opens a terminal, and how it renders
/// text a panel find can mark. Every member has a default, so an app implements only what it has.
///
/// The kit finds the host by class name, `GenesisKitHostAdapter` (declare it
/// `@objc(GenesisKitHostAdapter) final class …: NSObject, GenesisKitHost`), so no launch code has to
/// call anything. `GenesisKit.install(_:)` sets one explicitly (tests).
public protocol GenesisKitHost: AnyObject {
    /// One diagnostic line (GenesisTools: `HubPerf.log` into app-perf.log).
    func log(_ line: String)
    /// Whether "Open in a new cmux workspace" is offered for a path.
    var opensTerminal: Bool { get }
    /// Opens a shell in `folder`. Called on the main thread; the host moves slow work off it.
    func openTerminal(folder: String)
    /// Text a panel find can mark (GenesisTools: `FindText`); nil draws a plain `Text`.
    func findText(_ text: String, field: String) -> AnyView?
    /// Where PerfLog, HangWatch and MainStackSampler write, and whether they are on. Read once.
    var perf: PerfConfiguration { get }
    /// The transcript's markdown (replies, prompt parts) in the app's own renderer; nil draws inline
    /// markdown in one `Text`.
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView?
    /// What a NEW process of this app reads for `kind`. macOS caches Input Monitoring and Screen Recording per
    /// process, so a grant given while this one runs shows only in a new one. nil when the app has no probe.
    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus?
    /// The notes vault the markdown viewer resolves vault links and `[[wikilinks]]` against (Genesis: the
    /// Obsidian vault); nil when the app has none.
    var markdownVaultRoot: String? { get }
    /// The vault path the app's config names, which gives "Open in Obsidian" its vault name.
    var markdownConfiguredVault: String? { get }
    /// `[[` and `#` completion values from the app's vault index; nil when it has none.
    func markdownCompletions(_ request: MarkdownCompletion.Request) -> [String]?
    /// Property keys and their values as JSON for the Properties block; nil when there is no vault index.
    func markdownPropertyVocabularyJSON() -> String?
    /// The bundle id the viewer offers, once, as the default app for the file types it reads; nil never offers.
    var markdownDefaultAppBundleID: String? { get }
    /// The `tools` binary the viewer runs (the dev-dashboard share); nil resolves it the usual way.
    var toolsBinaryPath: String? { get }
    /// A view with its own find (the diff page): the host's panel find (⌘F in the hub) reaches it while it is on
    /// screen. The default does nothing, and the view's own find keys still work.
    @MainActor func registerNativeFind(_ view: NSView, scope: String, onFind: @escaping () -> Void)
    /// The git and `tools` data the git components read (`GenesisKitGT.provider`); nil uses the CLI provider.
    var gtProvider: GenesisKitGTProvider? { get }
}

public extension GenesisKitHost {
    func log(_ line: String) {}
    var opensTerminal: Bool { false }
    func openTerminal(folder: String) {}
    func findText(_ text: String, field: String) -> AnyView? { nil }
    var perf: PerfConfiguration { .fallback }
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? { nil }
    func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus? { nil }
    var markdownVaultRoot: String? { nil }
    var markdownConfiguredVault: String? { nil }
    func markdownCompletions(_ request: MarkdownCompletion.Request) -> [String]? { nil }
    func markdownPropertyVocabularyJSON() -> String? { nil }
    var markdownDefaultAppBundleID: String? { nil }
    var toolsBinaryPath: String? { nil }
    @MainActor func registerNativeFind(_ view: NSView, scope: String, onFind: @escaping () -> Void) {}
    var gtProvider: GenesisKitGTProvider? { nil }
}

public enum GenesisKit {
    nonisolated(unsafe) private static var installed: GenesisKitHost?
    nonisolated(unsafe) private static var looked = false
    private static let lock = NSLock()

    /// Sets the host by hand instead of the class-name lookup.
    public static func install(_ host: GenesisKitHost?) {
        lock.lock()
        defer { lock.unlock() }
        installed = host
        looked = true
    }

    /// The app's host, found once by class name; nil in an app that declares none.
    public static var host: GenesisKitHost? {
        lock.lock()
        defer { lock.unlock() }
        if !looked {
            looked = true
            if let type = NSClassFromString("GenesisKitHostAdapter") as? NSObject.Type {
                installed = type.init() as? GenesisKitHost
            }
        }
        return installed
    }


    static func log(_ line: String) {
        host?.log(line)
        unifiedLog.notice("\(line, privacy: .public)")
    }

    /// Every kit log line also goes here, so an app with no log of its own still keeps it.
    private static let unifiedLog = Logger(subsystem: "genesiskit", category: "kit")
}

/// A shown text that the host's panel find can mark, else a plain `Text`.
struct KitFindText: View {
    let text: String
    let field: String

    var body: some View {
        if let marked = GenesisKit.host?.findText(text, field: field) {
            marked
        } else {
            Text(verbatim: text)
        }
    }
}
