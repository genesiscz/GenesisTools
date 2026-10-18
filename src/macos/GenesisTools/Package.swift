// swift-tools-version: 5.9
import PackageDescription

// GenesisTools.app is a small host plus the rest of the app (Martin, 2026-10-18: a fast permissions build). The host
// (Sources/Host, library GenesisToolsHost) is the launcher, `--rpc`, the permission faces, vault approval,
// notifications, the microphone, the link router and the settings window, and it links only GenesisKitBase. The rest
// (library GenesisToolsHub: the hub, review, widget, Clicky and the markdown face) stays in Sources and links the full
// GenesisKit. The executable (Sources/GenesisTools) registers its faces and runs the host.
let package = Package(
    name: "GenesisTools",
    // macOS 14: the session views (GenesisKit Sessions/) use onChange(of:initial:).
    platforms: [.macOS(.v14)],
    // The components shared with Genesis.app (cmux picker, path and copy controls, menu buttons).
    dependencies: [.package(path: "../GenesisKit")],
    targets: [
        .target(
            name: "GenesisToolsHost",
            dependencies: [.product(name: "GenesisKitBase", package: "GenesisKit")],
            path: "Sources/Host"
        ),
        .target(
            name: "GenesisToolsHub",
            dependencies: ["GenesisToolsHost", .product(name: "GenesisKit", package: "GenesisKit")],
            path: "Sources",
            exclude: ["Host", "GenesisTools"]
        ),
        .executableTarget(name: "GenesisTools", dependencies: ["GenesisToolsHost", "GenesisToolsHub"], path: "Sources/GenesisTools"),
        // Pure logic (settings, pane order, request parsing, proposals); UI is checked with `--snapshot`
        // and `--bench` runs. The exceptions render into a window nobody sees (alpha 0, below the desktop,
        // never activated): LiveTimeTests and SessionTranscriptScrollTests, copied from Genesis, and
        // WindowTitlebarTests (clicks sent to the title bar strip).
        .testTarget(name: "GenesisToolsTests", dependencies: ["GenesisToolsHost", "GenesisToolsHub"], path: "Tests"),
    ]
)
