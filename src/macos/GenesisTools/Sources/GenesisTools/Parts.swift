import Foundation
import GenesisToolsHub

/// The kit finds its host adapter by this Objective-C name (GenesisKitBase Style/KitHost.swift): the hub library's,
/// which adds the markdown, find and git hooks to the host's.
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: HubKitAdapter {}

/// The faces outside the host, registered before `runHost` reads the arguments (Host/AppParts.swift).
func registerLinkedParts() {
    AppParts.register(part: "hub", faces: ["--hub": runHub, "--review": runReview])
    AppParts.register(part: "widget", faces: ["--widget": runAgentWidget])
    AppParts.register(part: "clicky", faces: ["--clicky": { runClicky($0) }])
    AppParts.register(part: "markdown", faces: ["--markdown": runMarkdown])
}
