// swift-tools-version: 5.9
import PackageDescription

// The optional parts of the app (src/macos/lib/permissions/parts.ts is the TypeScript side of this table). The host
// (launcher, `--rpc`, permission faces, vault approval, notifications, microphone, link router, settings window) is
// always built. `GENESIS_APP_PARTS` names the parts to build ("" = the host only, unset = every part, so `swift build`,
// `swift test` and an IDE build the whole app). A part is the folders and files it already has: an unbuilt part's
// paths are excluded from the one module, so code keeps its `internal` access. `App/MissingParts.swift` stands in
// for the face of a part that is not built, and `GENESIS_PART_<ID>` is defined for each part that is.
struct AppPart {
    let id: String
    let paths: [String]
    /// Parts whose code this one calls; a build with this part builds them too.
    var requires: [String] = []
    /// Uses the flow runtime the hub, the widget and Clicky share.
    var flow = false
}

let allParts: [AppPart] = [
    AppPart(id: "hub", paths: ["Hub", "Review"], flow: true),
    AppPart(id: "widget", paths: ["WidgetWindow.swift"], flow: true),
    // Its settings pages show the hub's notification rules and read through the hub's `tools` server.
    AppPart(id: "clicky", paths: ["Clicky", "ClickyEntry.swift", "Settings"], requires: ["hub"], flow: true),
    AppPart(id: "markdown", paths: ["Markdown"]),
]
let flowPaths = ["App/NativeFlowRuntime.swift", "App/PartLaunch.swift"]

let requestedIds: [String]? = Context.environment["GENESIS_APP_PARTS"].map { value in
    value.split(separator: ",").map { String($0.filter { $0 != " " }) }.filter { !$0.isEmpty }
}
let requested: [AppPart] = allParts.filter { requestedIds?.contains($0.id) ?? true }
let linkedIds: Set<String> = Set(requested.flatMap { [$0.id] + $0.requires })
let linked: [AppPart] = allParts.filter { linkedIds.contains($0.id) }
let unlinked: [AppPart] = allParts.filter { !linkedIds.contains($0.id) }

let excluded: [String] = unlinked.flatMap(\.paths) + (linked.contains(where: \.flow) ? [] : flowPaths)
let partDefines: [SwiftSetting] = linked.map { .define("GENESIS_PART_\($0.id.uppercased())") }

let package = Package(
    name: "GenesisTools",
    // macOS 14: the session views (GenesisKit Sessions/) use onChange(of:initial:).
    platforms: [.macOS(.v14)],
    // The components shared with Genesis.app (cmux picker, path and copy controls, menu buttons). A host-only build
    // sets GENESIS_KIT_BASE_ONLY=1 as well, so ../GenesisKit compiles only what the host uses (its Package.swift).
    dependencies: [.package(path: "../GenesisKit")],
    targets: [
        .executableTarget(
            name: "GenesisTools",
            dependencies: ["GenesisKit"],
            path: "Sources",
            exclude: excluded,
            swiftSettings: partDefines
        ),
        // Pure logic (settings, pane order, request parsing, proposals); UI is checked with `--snapshot`
        // and `--bench` runs. The exceptions render into a window nobody sees (alpha 0, below the desktop,
        // never activated): LiveTimeTests and SessionTranscriptScrollTests, copied from Genesis, and
        // WindowTitlebarTests (clicks sent to the title bar strip).
        .testTarget(name: "GenesisToolsTests", dependencies: ["GenesisTools"], path: "Tests"),
    ]
)
