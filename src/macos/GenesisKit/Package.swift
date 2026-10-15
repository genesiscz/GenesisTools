// swift-tools-version: 5.9
import PackageDescription

// The SwiftUI components GenesisTools.app and Genesis.app share: the cmux target picker, path and
// copy controls, menu buttons, badges, the hover styles and the instant tooltip. GenesisTools
// depends on it as `../GenesisKit`; Genesis (GenesisPlayground) as
// `../../../../GenesisTools/src/macos/GenesisKit`. See README.md for the rules.
//
// Code only Genesis uses lives in its own library, so GenesisTools.app, which links `GenesisKit` alone,
// never compiles it (Martin, 2026-10-14): `GenesisKitCharts` (sunburst, treemap, donut, ring, health bar),
// `GenesisKitPosture` (PostureWatcher: camera, pose, posture, screen effects) and `GenesisKitDisk` (Disk
// Manager: disk providers, alerts). They reach core helpers through `package` access, not `public`.
let package = Package(
    name: "GenesisKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "GenesisKit", targets: ["GenesisKit"]),
        .library(name: "GenesisKitCharts", targets: ["GenesisKitCharts"]),
        .library(name: "GenesisKitPosture", targets: ["GenesisKitPosture"]),
        .library(name: "GenesisKitDisk", targets: ["GenesisKitDisk"]),
        // Test targets only: the one copy of the `tools` disk fixtures (KitFixture). The GenesisTools bun tests
        // read the same files by path. An app target never links it.
        .library(name: "GenesisKitFixtures", targets: ["GenesisKitFixtures"]),
    ],
    // The markdown viewer's "Native+" renderer: diagrams and highlighted code without a web view.
    dependencies: [
        .package(url: "https://github.com/lukilabs/beautiful-mermaid-swift", from: "1.0.4"),
        .package(url: "https://github.com/smittytone/HighlighterSwift", from: "3.1.0"),
    ],
    targets: [
        .target(
            name: "GenesisKit",
            dependencies: [
                .product(name: "BeautifulMermaid", package: "beautiful-mermaid-swift"),
                .product(name: "Highlighter", package: "HighlighterSwift"),
            ],
            path: "Sources/GenesisKit",
            // The markdown viewer's renderer (markdown-it, highlight.js, mermaid). An installed app copies it to
            // Contents/Resources/webview, which is read first; `swift test` and `swift run` read it from here.
            resources: [.copy("Markdown/Resources/webview")]
        ),
        .target(name: "GenesisKitCharts", dependencies: ["GenesisKit"], path: "Sources/GenesisKitCharts"),
        .target(name: "GenesisKitPosture", dependencies: ["GenesisKit", "GenesisKitCharts"],
                path: "Sources/GenesisKitPosture"),
        .target(name: "GenesisKitDisk", dependencies: ["GenesisKit", "GenesisKitCharts"],
                path: "Sources/GenesisKitDisk"),
        // Disk/: the frozen CLI contracts and real `tools` JSON output the disk decoders are tested against.
        .target(name: "GenesisKitFixtures", path: "Sources/GenesisKitFixtures", resources: [.copy("Disk")]),
        .testTarget(name: "GenesisKitTests",
                    dependencies: ["GenesisKit", "GenesisKitCharts", "GenesisKitPosture", "GenesisKitDisk", "GenesisKitFixtures"],
                    path: "Tests/GenesisKitTests"),
    ]
)
