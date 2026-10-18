// swift-tools-version: 5.9
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
// GENESIS_KIT_BASE_ONLY=1 (a GenesisTools.app build with no optional part, src/macos/lib/permissions/app.ts): the
// GenesisKit module compiles only the files the app's host uses, with no external package and no other library, so a
// cold host build takes about 10 s instead of compiling all of the kit. The same module name keeps every import and
// access level as it is; `#if GENESIS_KIT_BASE_ONLY` hides the few host members that name excluded types.
let baseOnly = Context.environment["GENESIS_KIT_BASE_ONLY"] == "1"
let baseSources: [String] = [
    "Controls/IconButton.swift",
    "Files/FileActions.swift",
    "Flow/Support/ConstraintLoopDetector.swift",
    "Paths/DefaultApp.swift",
    "Paths/PathAction.swift",
    "Paths/PathActions.swift",
    "Paths/PathLabel.swift",
    "Paths/PathMenu.swift",
    "Perf/HangWatch.swift",
    "Perf/MainBusy.swift",
    "Perf/MainStackSampler.swift",
    "Perf/MonitorPerf.swift",
    "Perf/PerfConfiguration.swift",
    "Perf/PerfContext.swift",
    "Perf/PerfLog.swift",
    "Perf/PerfSpans.swift",
    "Perf/RenderProbe.swift",
    "Permissions/ApprovalDialog.swift",
    "Permissions/GateAudit.swift",
    "Permissions/LocalNetworkPrivacy.swift",
    "Permissions/PermissionCenter.swift",
    "Permissions/PermissionDialog.swift",
    "Permissions/PermissionKind.swift",
    "Permissions/PermissionSimulation.swift",
    "Permissions/SystemPermissions.swift",
    "Style/GenDisclosure.swift",
    "Style/GenHoverButton.swift",
    "Style/GenMotion.swift",
    "Style/GenesisKitHost.swift",
    "Style/InstantTooltip.swift",
    "Style/KitTheme.swift",
    "Style/MotionEnvironment.swift",
    "Style/Plural.swift",
    "Style/PointerCursor.swift",
    "Style/RowButton.swift",
    "Style/TooltipGuard.swift",
    "Tools/ProcessCapture.swift",
    "Tools/ToolsBridge.swift",
    "Tools/ToolsCallTrace.swift",
    "Tools/ToolsServerClient.swift",
    "Widgets/WidgetAccessibility.swift",
    "Window/SingleInstance.swift",
    "Window/WindowTitlebar.swift",
]
/// One `Package` per evaluation: PackageDescription keeps the last one created, so the unused one is never built.
func basePackage() -> Package {
    Package(
        name: "GenesisKit",
        platforms: [.macOS(.v14)],
        products: [.library(name: "GenesisKit", targets: ["GenesisKit"])],
        targets: [
            .target(
                name: "GenesisKit",
                path: "Sources/GenesisKit",
                sources: baseSources,
                swiftSettings: [.define("GENESIS_KIT_BASE_ONLY")]
            ),
        ]
    )
}

func fullPackage() -> Package {
    Package(
        name: "GenesisKit",
        platforms: [.macOS(.v14)],
        products: [
            .library(name: "GenesisKit", targets: ["GenesisKit"]),
            .library(name: "GenesisKitCharts", targets: ["GenesisKitCharts"]),
            .library(name: "GenesisKitOverlay", targets: ["GenesisKitOverlay"]),
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
            .target(name: "GenesisKitOverlay", dependencies: ["GenesisKit"], path: "Sources/GenesisKitOverlay"),
            .target(name: "GenesisKitPosture", dependencies: ["GenesisKit"], path: "Sources/GenesisKitPosture"),
            .target(name: "GenesisKitDisk", dependencies: ["GenesisKit"], path: "Sources/GenesisKitDisk"),
            // Disk/: the frozen CLI contracts and real `tools` JSON output the disk decoders are tested against.
            .target(name: "GenesisKitFixtures", path: "Sources/GenesisKitFixtures", resources: [.copy("Disk")]),
            .testTarget(name: "GenesisKitTests",
                        dependencies: [
                            "GenesisKit", "GenesisKitCharts", "GenesisKitOverlay", "GenesisKitPosture", "GenesisKitDisk",
                            "GenesisKitFixtures",
                        ],
                        path: "Tests/GenesisKitTests"),
        ]
    )
}

let package = baseOnly ? basePackage() : fullPackage()
