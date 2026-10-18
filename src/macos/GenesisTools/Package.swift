// swift-tools-version: 5.9
import Foundation
import PackageDescription

// GenesisTools.app is a small host plus optional parts (Martin, 2026-10-18: "make it a bit generic so we can pick
// more parts of the native app to not build"). The host (Sources/Host) is the launcher, `--rpc`, the permission
// faces, vault approval, notifications, the microphone, the link router and the settings window. Each part is one
// library under Sources/Parts; the executable (Sources/GenesisTools) links the host plus the parts this build asks for.
//
// `GENESIS_APP_PARTS` names the parts, comma-separated ("" = the host only). Unset = every part, so a plain
// `swift build`, `swift test` and the IDE see the whole app. `src/macos/lib/permissions/parts.ts` is the one table
// of parts on the TypeScript side; its build passes this variable and a scratch path of its own per parts set.
struct AppPart {
    let id: String
    let target: String
    let path: String
    /// Other parts whose code this one calls; a build with this part links them too (parts.ts `requires`).
    var requires: [String] = []
    var shared: [String] = []
}

/// Code two parts share: not a part of its own, linked by the parts that need it.
let flowTarget = "GenesisToolsFlow"

let allParts: [AppPart] = [
    // The hub starts the widget and Clicky in their own processes (Parts/Flow/WidgetLaunch.swift, ClickyLaunch.swift).
    AppPart(id: "hub", target: "GenesisToolsHub", path: "Sources/Parts/Hub", shared: [flowTarget]),
    AppPart(id: "widget", target: "GenesisToolsWidget", path: "Sources/Parts/Widget", shared: [flowTarget]),
    // Clicky's settings pages show the hub's notification rules and read through its `tools` server.
    AppPart(id: "clicky", target: "GenesisToolsClicky", path: "Sources/Parts/Clicky", requires: ["hub"], shared: [flowTarget]),
    AppPart(id: "markdown", target: "GenesisToolsMarkdown", path: "Sources/Parts/Markdown"),
]

func part(_ id: String) -> AppPart? {
    allParts.first { $0.id == id }
}

let requestedIds: [String]? = ProcessInfo.processInfo.environment["GENESIS_APP_PARTS"].map { value in
    value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}
let unknownIds = (requestedIds ?? []).filter { part($0) == nil }
if !unknownIds.isEmpty {
    fatalError("GENESIS_APP_PARTS names unknown parts: \(unknownIds.joined(separator: ", ")); known: \(allParts.map(\.id).joined(separator: ", "))")
}
let linkedIds = Set((requestedIds ?? allParts.map(\.id)).flatMap { id in [id] + (part(id)?.requires ?? []) })
let linkedParts = allParts.filter { linkedIds.contains($0.id) }

// Typed pieces, joined below: one array expression of all of them is too much for the type checker.
let hostTarget: Target = .target(
    name: "GenesisToolsHost",
    // Only the small base: a host-only build compiles none of the full kit or its external packages (12 s cold).
    dependencies: [.product(name: "GenesisKitBase", package: "GenesisKit")],
    path: "Sources/Host"
)
let fullKit: Target.Dependency = .product(name: "GenesisKit", package: "GenesisKit")
let flowTargetDecl: Target = .target(name: flowTarget, dependencies: ["GenesisToolsHost", fullKit], path: "Sources/Parts/Flow")

let partTargets: [Target] = allParts.map { appPart in
    // Every part links the full kit; the host links only GenesisKitBase.
    var dependencies: [Target.Dependency] = [.target(name: "GenesisToolsHost"), fullKit]
    dependencies += appPart.shared.map { Target.Dependency.target(name: $0) }
    dependencies += appPart.requires.compactMap { id in part(id).map { Target.Dependency.target(name: $0.target) } }
    return .target(name: appPart.target, dependencies: dependencies, path: appPart.path)
}

let executableDependencies: [Target.Dependency] =
    [.target(name: "GenesisToolsHost")] + linkedParts.map { Target.Dependency.target(name: $0.target) }
// One define per linked part, read by Sources/GenesisTools/Parts.swift.
let partDefines: [SwiftSetting] = linkedParts.map { SwiftSetting.define("GENESIS_PART_\($0.id.uppercased())") }
let executable: Target = .executableTarget(
    name: "GenesisTools",
    dependencies: executableDependencies,
    path: "Sources/GenesisTools",
    swiftSettings: partDefines
)

// Pure logic (settings, pane order, request parsing, proposals); UI is checked with `--snapshot`
// and `--bench` runs. The exceptions render into a window nobody sees (alpha 0, below the desktop,
// never activated): LiveTimeTests and SessionTranscriptScrollTests, copied from Genesis, and
// WindowTitlebarTests (clicks sent to the title bar strip). It always tests every part.
let testDependencies: [Target.Dependency] = [.target(name: "GenesisToolsHost"), .target(name: flowTarget)]
    + allParts.map { Target.Dependency.target(name: $0.target) }
let tests: Target = .testTarget(name: "GenesisToolsTests", dependencies: testDependencies, path: "Tests")

// `GENESIS_KIT_BASE_ONLY=1` (set with `GENESIS_APP_PARTS=` by the host-only build in app.ts) makes ../GenesisKit
// declare only GenesisKitBase, so no external package is resolved; the parts and the tests need the full kit, so
// they are not declared then.
let kitBaseOnly = ProcessInfo.processInfo.environment["GENESIS_KIT_BASE_ONLY"] == "1"
if kitBaseOnly && !linkedParts.isEmpty {
    fatalError("GENESIS_KIT_BASE_ONLY=1 builds the host alone; it needs GENESIS_APP_PARTS= (no part)")
}

let package = Package(
    name: "GenesisTools",
    // macOS 14: the session views (GenesisKit Sessions/) use onChange(of:initial:).
    platforms: [.macOS(.v14)],
    // The components shared with Genesis.app (cmux picker, path and copy controls, menu buttons).
    dependencies: [.package(path: "../GenesisKit")],
    targets: kitBaseOnly ? [hostTarget, executable] : [hostTarget, flowTargetDecl] + partTargets + [executable, tests]
)
