// The base library (permissions, perf, paths, tools, the host's log and lookup) is part of GenesisKit for every
// importer: an app that imports GenesisKit never imports GenesisKitBase itself.
@_exported import GenesisKitBase
import AppKit
import SwiftUI

/// What an app lends the kit: where its log lines go, how it opens a terminal, and how it renders
/// text a panel find can mark. Every member has a default, so an app implements only what it has.
///
/// The kit finds the host by class name, `GenesisKitHostAdapter` (declare it
/// `@objc(GenesisKitHostAdapter) final class …: NSObject, GenesisKitHost`), so no launch code has to
/// call anything. `GenesisKit.install(_:)` sets one explicitly (tests). The log, perf, terminal and permission
/// probe members are GenesisKitBase's `GenesisKitBaseHost`, which this protocol refines.
public protocol GenesisKitHost: GenesisKitBaseHost {
    /// Text a panel find can mark (GenesisTools: `FindText`); nil draws a plain `Text`.
    func findText(_ text: String, field: String) -> AnyView?
    /// The transcript's markdown (replies, prompt parts) in the app's own renderer; nil draws inline
    /// markdown in one `Text`.
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView?
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
    /// Where the user's keyboard shortcuts are saved, one `<library>.json` per keymap (`KeymapStore.standard`); nil
    /// keeps them in `~/Library/Application Support/GenesisKit/Keymaps`.
    var keymapDirectory: URL? { get }
}

public extension GenesisKitHost {
    func findText(_ text: String, field: String) -> AnyView? { nil }
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? { nil }
    var markdownVaultRoot: String? { nil }
    var markdownConfiguredVault: String? { nil }
    func markdownCompletions(_ request: MarkdownCompletion.Request) -> [String]? { nil }
    func markdownPropertyVocabularyJSON() -> String? { nil }
    var markdownDefaultAppBundleID: String? { nil }
    var toolsBinaryPath: String? { nil }
    @MainActor func registerNativeFind(_ view: NSView, scope: String, onFind: @escaping () -> Void) {}
    var gtProvider: GenesisKitGTProvider? { nil }
    var keymapDirectory: URL? { nil }
}

/// The app's host as a full `GenesisKitHost`. The lookup itself is GenesisKitBase's `KitHost`, so both libraries
/// see one object; an app whose adapter is only a `GenesisKitBaseHost` reads nil here.
public enum GenesisKit {
    /// Sets the host by hand instead of the class-name lookup.
    public static func install(_ host: GenesisKitHost?) {
        KitHost.install(host)
    }

    /// The app's host, found once by class name; nil in an app that declares none.
    public static var host: GenesisKitHost? {
        KitHost.host as? GenesisKitHost
    }

    /// `package`: the Genesis-only libraries (GenesisKitPosture, GenesisKitDisk) log through it too.
    package static func log(_ line: String) {
        KitHost.log(line)
    }
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
