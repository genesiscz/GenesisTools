import Foundation

/// How the process that owns a feature settings window runs.
public enum FeatureSettingsMode: Sendable, Equatable {
    /// The real window, with the services of every plug-in running.
    case live
    /// The real window, drawn but never on screen or key, so a script can drive its controls. Plug-ins join a running
    /// owner as settings-only clients: their writes land, and they start no capture, hotkeys or sounds.
    case headless
    /// One page drawn into a PNG, then exit: no service starts.
    case snapshot
}

/// What a plug-in can ask of the window that hosts it.
@MainActor
public protocol FeatureSettingsPluginHost: AnyObject {
    var mode: FeatureSettingsMode { get }
    /// The appearance the window draws with; a plug-in model that edits the same keys shares this instance.
    var appearance: NativeSettingsAppearance { get }
    /// The defaults the window and its plug-in models read and write: `.standard`, and in a snapshot a view of it that
    /// drops every write (ReadOnlyDefaults), so drawing a page never changes the user's settings.
    var defaults: UserDefaults { get }
    /// Adds a section to the sidebar, or replaces the section with the same id (ids are not reserved per plug-in, so
    /// give each section an id of your part). False when the sections would no longer be valid, such as two pages with
    /// one id: the window then keeps the sections it had.
    @discardableResult
    func register(section: NativeSettingsSection) -> Bool
    /// Shows the window on `pageID` (the selected page when nil).
    func showSettings(pageID: String?)
    /// A line for the About page (what the part bundles, its licences).
    func addAboutInfo(_ line: String)
}

/// One part of an app that adds pages to a shared settings window, and may run its services in the process that owns
/// the window. A part implements this with kit types only, so the window and the other parts never import it.
@MainActor
public protocol FeatureSettingsPlugin: AnyObject {
    /// Called once, before the window is first shown: register the sections, and in `.live` mode start the services.
    func install(in host: FeatureSettingsPluginHost)
    /// True once the pages have the data they draw. A snapshot waits for every plug-in.
    var settingsReady: Bool { get }
    /// The window was asked for again while it runs (a second launch, a click in another window): reload what may be
    /// stale.
    func settingsReopened()
    /// The app is quitting: stop the services. The host replies to the quit after every plug-in returned, or 5 s.
    func stop() async
}

extension FeatureSettingsPlugin {
    public var settingsReady: Bool { true }
    public func settingsReopened() {}
    public func stop() async {}
}
