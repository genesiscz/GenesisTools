// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The SwiftUI components GenesisTools.app and Genesis.app share: the cmux target picker, path and
// copy controls, menu buttons, badges, the hover styles and the instant tooltip. GenesisTools
// depends on it as `../GenesisKit`; Genesis (GenesisPlayground) as
// `../../../../GenesisTools/src/macos/GenesisKit`. See README.md for the rules.
//
// Optional parts live in libraries of their own, so an app compiles only what it imports (Martin, 2026-10-14/15):
// `GenesisKitCharts` (sunburst, treemap, donut, ring, health bar) and `GenesisKitOverlay` (screen effects) may be
// imported by any app; `GenesisKitPosture` (PostureWatcher: camera, pose, posture rules) and `GenesisKitDisk` (Disk
// Manager: disk providers) are Genesis's. GenesisTools.app links `GenesisKit` and imports the others only where it
// uses them. They reach core helpers through `package` access, not `public`.
//
// `GENESIS_KIT_BASE_ONLY=1` declares GenesisKitBase alone, with no external package: GenesisTools' host-only build
// (src/macos/lib/permissions/app.ts) sets it, because SwiftPM resolves every package a manifest names, linked or
// not, and the three markdown packages cost about 6 s of a cold build that compiles none of them. Setting it for a
// build that imports GenesisKit removes the product that build needs. Unset (Genesis.app, `swift test`, a full
// GenesisTools build) declares everything.
let baseOnly = ProcessInfo.processInfo.environment["GENESIS_KIT_BASE_ONLY"] == "1"

// The small base every app links: permissions, perf, path opening and copying, `tools` access, motion and the host
// lookup, with no external package (Martin, 2026-10-18: a 5-10 s cold permissions build). GenesisKit re-exports it,
// so an app that imports GenesisKit sees it too. GenesisTools' permissions host links only this.
let baseProduct: Product = .library(name: "GenesisKitBase", targets: ["GenesisKitBase"])
let baseTarget: Target = .target(name: "GenesisKitBase", path: "Sources/GenesisKitBase")

let kitProducts: [Product] = [
    .library(name: "GenesisKit", targets: ["GenesisKit"]),
    .library(name: "GenesisKitCharts", targets: ["GenesisKitCharts"]),
    .library(name: "GenesisKitOverlay", targets: ["GenesisKitOverlay"]),
    .library(name: "GenesisKitPosture", targets: ["GenesisKitPosture"]),
    .library(name: "GenesisKitDisk", targets: ["GenesisKitDisk"]),
    // Test targets only: the one copy of the `tools` disk fixtures (KitFixture). The GenesisTools bun tests
    // read the same files by path. An app target never links it.
    .library(name: "GenesisKitFixtures", targets: ["GenesisKitFixtures"]),
    .library(name: "GenesisKitTestHooks", targets: ["GenesisKitTestHooks"]),
]

// The markdown viewer's "Native+" renderer: diagrams and highlighted code without a web view.
let kitDependencies: [Package.Dependency] = [
    .package(url: "https://github.com/lukilabs/beautiful-mermaid-swift", from: "1.0.4"),
    .package(url: "https://github.com/smittytone/HighlighterSwift", from: "3.1.0"),
]

let kitTargets: [Target] = [
    .target(
        name: "GenesisKit",
        dependencies: [
            "GenesisKitBase",
            .product(name: "BeautifulMermaid", package: "beautiful-mermaid-swift"),
            .product(name: "Highlighter", package: "HighlighterSwift"),
        ],
        path: "Sources/GenesisKit",
        // The markdown viewer's renderer (markdown-it, highlight.js, mermaid). An installed app copies it to
        // Contents/Resources/webview, which is read first; `swift test` and `swift run` read it from here.
        resources: [.copy("Markdown/Resources/webview")]
    ),
    .target(name: "GenesisKitCharts", dependencies: ["GenesisKit"], path: "Sources/GenesisKitCharts"),
    .target(name: "GenesisKitOverlay", dependencies: ["GenesisKit"], path: "Sources/GenesisKitOverlay"),
    .target(name: "GenesisKitPosture", dependencies: ["GenesisKit"], path: "Sources/GenesisKitPosture"),
    .target(name: "GenesisKitDisk", dependencies: ["GenesisKit"], path: "Sources/GenesisKitDisk"),
    // Disk/: the frozen CLI contracts and real `tools` JSON output the disk decoders are tested against.
    .target(name: "GenesisKitFixtures", path: "Sources/GenesisKitFixtures", resources: [.copy("Disk"), .copy("Git")]),
    // Tests only: a window asked to become key is only ordered front, and the app never activates, so a test run
    // never takes the user's keyboard focus.
    .target(name: "GenesisKitTestHooks", path: "Sources/GenesisKitTestHooks", linkerSettings: [.linkedFramework("AppKit")]),
    .testTarget(
        name: "GenesisKitTests",
        dependencies: [
            "GenesisKitBase", "GenesisKit", "GenesisKitCharts", "GenesisKitOverlay", "GenesisKitPosture", "GenesisKitDisk",
            "GenesisKitFixtures", "GenesisKitTestHooks",
        ],
        path: "Tests/GenesisKitTests"
    ),
]

let package = Package(
    name: "GenesisKit",
    platforms: [.macOS(.v14)],
    products: [baseProduct] + (baseOnly ? [] : kitProducts),
    dependencies: baseOnly ? [] : kitDependencies,
    targets: [baseTarget] + (baseOnly ? [] : kitTargets)
)
