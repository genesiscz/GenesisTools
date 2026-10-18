import Foundation
import GenesisToolsHost

// One block per optional part. Package.swift links a part's target and sets its `GENESIS_PART_<ID>` define only
// when the build asks for that part (`GENESIS_APP_PARTS`), so a block compiles only in a build that links it.
// A new part adds one block here, one target in Package.swift and one row in src/macos/lib/permissions/parts.ts.

// The kit finds its host adapter by the Objective-C name `GenesisKitHostAdapter` (GenesisKitBase Style/KitHost.swift):
// the hub's adapter when the hub is linked; the host's, as a full `GenesisKitHost`, when another part links the full
// kit; the host's alone in a host-only build, which links only GenesisKitBase.
#if GENESIS_PART_HUB
import GenesisToolsHub

@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HubKitAdapter {}
#elseif GENESIS_PART_WIDGET || GENESIS_PART_CLICKY || GENESIS_PART_MARKDOWN
import GenesisKit

@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HostKitAdapter, GenesisKitHost {}
#else
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HostKitAdapter {}
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
    #if GENESIS_PART_HUB
    AppParts.register(part: "hub", faces: ["--hub": runHub, "--review": runReview])
    #endif
    #if GENESIS_PART_WIDGET
    AppParts.register(part: "widget", faces: ["--widget": runAgentWidget])
    #endif
    #if GENESIS_PART_CLICKY
    AppParts.register(part: "clicky", faces: ["--clicky": { runClicky($0) }])
    #endif
    #if GENESIS_PART_MARKDOWN
    AppParts.register(part: "markdown", faces: ["--markdown": runMarkdown])
    #endif
}
