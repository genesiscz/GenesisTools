import AppKit
import GenesisKit

/// Clicky in the feature settings window (Parts/Features): its section, and in a live window its status item and key
/// sounds. Added by the executable (Sources/GenesisTools/Parts.swift); it knows no other part.
@MainActor
package final class ClickyPlugin: FeatureSettingsPlugin {
    /// The model a snapshot draws. Building the live model can write (a recovery copy of undecodable preferences, the
    /// appearance keys it migrates), so a snapshot reads the user's state through defaults that drop every write.
    private var snapshotModel: ClickyModel?

    package init() {}

    package func install(in host: FeatureSettingsPluginHost) {
        // A headless run keeps the live model: its controls are driven on purpose and save like a click would.
        if host.mode == .snapshot {
            let model = ClickyModel(defaults: ReadOnlyDefaults() ?? .standard, previewOnly: true, observeSystemEvents: false)
            snapshotModel = model
            host.register(section: ClickySettingsPages.section(model: model))
            host.addAboutInfo(ClickySettingsPages.aboutInfo)
            return
        }
        let clicky = ClickyHost.shared
        host.register(section: ClickySettingsPages.section(model: clicky.model))
        host.addAboutInfo(ClickySettingsPages.aboutInfo)
        clicky.openSettings = { [weak host] pageID in host?.showSettings(pageID: pageID) }
        // A headless run draws pages only: no status item, no key monitoring.
        guard host.mode == .live else { return }
        // Not standalone: the process also holds the settings window and the other parts' services, so "Quit Clicky"
        // in the popover stops Clicky only.
        clicky.start(standalone: false)
    }

    /// Settings asked for again (a second launch): after "Quit Clicky" the process kept running without Clicky, so
    /// Clicky comes back with the window, as it did when the quit ended the whole process.
    package func settingsReopened() {
        guard snapshotModel == nil else { return }
        ClickyHost.shared.start(standalone: false)
    }

    package func stop() async {
        if let snapshotModel {
            snapshotModel.shutdown()
            return
        }
        ClickyHost.shared.stop()
    }
}

/// A defaults domain that reads like `UserDefaults(suiteName:)` and drops every write, for a run that must leave the
/// user's settings as it found them (ClickyPlugin's snapshot model).
final class ReadOnlyDefaults: UserDefaults {
    init?(reading suiteName: String? = nil) {
        super.init(suiteName: suiteName)
    }

    override func set(_ value: Any?, forKey defaultName: String) {}
    override func set(_ value: Bool, forKey defaultName: String) {}
    override func set(_ value: Int, forKey defaultName: String) {}
    override func set(_ value: Float, forKey defaultName: String) {}
    override func set(_ value: Double, forKey defaultName: String) {}
    override func set(_ url: URL?, forKey defaultName: String) {}
    override func removeObject(forKey defaultName: String) {}
}
