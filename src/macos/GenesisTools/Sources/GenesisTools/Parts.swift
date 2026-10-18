import Foundation
import GenesisToolsHost

// One block per optional part. Package.swift links a part's target and sets its `GENESIS_PART_<ID>` define only
// when the build asks for that part (`GENESIS_APP_PARTS`), so a block compiles only in a build that links it.
// A new part adds one block here, one target in Package.swift and one row in src/macos/lib/permissions/parts.ts.
// This file is the only code that knows every part: the parts never import each other.

// The kit finds its host adapter by the Objective-C name `GenesisKitHostAdapter` (GenesisKitBase Style/KitHost.swift):
// the hub's adapter when the hub is linked; the host's, as a full `GenesisKitHost`, when another part links the full
// kit; the host's alone in a host-only build, which links only GenesisKitBase.
#if GENESIS_PART_HUB
import GenesisToolsHub

@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HubKitAdapter {}
#elseif GENESIS_PART_FEATURES || GENESIS_PART_WIDGET || GENESIS_PART_CLICKY || GENESIS_PART_MARKDOWN
import GenesisKit

@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HostKitAdapter, GenesisKitHost {}
#else
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HostKitAdapter {}
#endif

#if GENESIS_PART_FEATURES
import GenesisToolsFeatures
#endif

#if GENESIS_PART_WIDGET
import GenesisToolsWidget
#endif

#if GENESIS_PART_CLICKY
import GenesisToolsClicky
#endif

#if GENESIS_PART_MARKDOWN
import GenesisToolsMarkdown
#endif

func registerLinkedParts() {
    #if GENESIS_PART_FEATURES
    // `--clicky` is the face's old name (relaunch records, scripts).
    AppParts.register(part: "features", faces: ["--features": { runFeatures($0) }, "--clicky": { runFeatures($0) }])
    #endif
    #if GENESIS_PART_HUB
    AppParts.register(part: "hub", faces: ["--hub": runHub, "--review": runReview])
    #endif
    #if GENESIS_PART_WIDGET
    AppParts.register(part: "widget", faces: ["--widget": runAgentWidget])
    #endif
    #if GENESIS_PART_CLICKY
    AppParts.register(part: "clicky", faces: [:])
    #endif
    #if GENESIS_PART_MARKDOWN
    AppParts.register(part: "markdown", faces: ["--markdown": runMarkdown])
    #endif
    registerSettingsPlugins()
}

/// Each linked part's pages in the feature settings window (Parts/Features), in sidebar order by their `order`.
private func registerSettingsPlugins() {
    #if GENESIS_PART_FEATURES
    MainActor.assumeIsolated {
        #if GENESIS_PART_CLICKY
        FeatureSettingsPlugins.add { ClickyPlugin() }
        #endif
        #if GENESIS_PART_WIDGET
        FeatureSettingsPlugins.add { WidgetSettingsPlugin() }
        #endif
        #if GENESIS_PART_HUB
        FeatureSettingsPlugins.add { HubSettingsPlugin() }
        #endif
    }
    #endif
}
