// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GenesisTools",
    // macOS 14: the session views (GenesisKit Sessions/) use onChange(of:initial:).
    platforms: [.macOS(.v14)],
    // The components shared with Genesis.app (cmux picker, path and copy controls, menu buttons).
    dependencies: [.package(path: "../GenesisKit")],
    targets: [
        .executableTarget(name: "GenesisTools", dependencies: ["GenesisKit"], path: "Sources"),
        // Pure logic (settings, pane order, request parsing, proposals); UI is checked with `--snapshot`
        // and `--bench` runs. The exceptions render into a window nobody sees (alpha 0, below the desktop,
        // never activated): LiveTimeTests and SessionTranscriptScrollTests, copied from Genesis, and
        // WindowTitlebarTests (clicks sent to the title bar strip).
        .testTarget(name: "GenesisToolsTests", dependencies: ["GenesisTools"], path: "Tests"),
    ]
)
