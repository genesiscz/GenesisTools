import GenesisKit

/// The hub in the feature settings window (Parts/Features): the hub window's preferences, and the PR activity banners
/// the daemon's `hub-pr-notify` task sends. Added by the executable (Sources/GenesisTools/Parts.swift); it knows no
/// other part.
@MainActor
package final class HubSettingsPlugin: FeatureSettingsPlugin {
    package init() {}

    package func install(in host: FeatureSettingsPluginHost) {
        // A running hub follows a change at once.
        host.register(section: HubSettingsPages.section())
        host.register(section: PRActivitySettingsPages.section())
    }
}
