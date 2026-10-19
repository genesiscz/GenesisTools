import GenesisKit

/// The hub in the feature settings window (Parts/Features): the hub window's preferences, and the PR activity banners
/// the daemon's `hub-pr-notify` task sends. Added by the executable (Sources/GenesisTools/Parts.swift); it knows no
/// other part.
@MainActor
package final class HubSettingsPlugin: FeatureSettingsPlugin {
    /// The PR activity page's data; a test passes its own.
    private let notify: HubNotifyStore

    package init() { notify = .shared }

    init(notify: HubNotifyStore) { self.notify = notify }

    package func install(in host: FeatureSettingsPluginHost) {
        // A running hub follows a change at once.
        host.register(section: HubSettingsPages.section())
        host.register(section: PRActivitySettingsPages.section(store: notify))
    }

    /// The PR activity page reads `tools hub notify status` when it appears; a snapshot of it waits for that.
    package func settingsReady(page: String?) -> Bool {
        page != PRActivitySettingsPages.pageID || notify.settled
    }
}
