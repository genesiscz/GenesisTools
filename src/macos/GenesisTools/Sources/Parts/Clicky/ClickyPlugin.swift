import AppKit
import GenesisKit

/// Clicky in the feature settings window (Parts/Features): its section, and in a live window its status item and key
/// sounds. Added by the executable (Sources/GenesisTools/Parts.swift); it knows no other part.
@MainActor
package final class ClickyPlugin: FeatureSettingsPlugin {
    package init() {}

    package func install(in host: FeatureSettingsPluginHost) {
        let clicky = ClickyHost.shared
        host.register(section: ClickySettingsPages.section(model: clicky.model))
        host.addAboutInfo(ClickySettingsPages.aboutInfo)
        clicky.openSettings = { [weak host] pageID in host?.showSettings(pageID: pageID) }
        // A snapshot or a headless run draws pages only: no status item, no key monitoring.
        guard host.mode == .live else { return }
        clicky.start(standalone: true)
    }

    package func stop() async {
        ClickyHost.shared.stop()
    }
}
