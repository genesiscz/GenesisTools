// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GenesisTools",
    // macOS 14: the session views stolen from Genesis (Hub/Stolen/Sessions) use onChange(of:initial:).
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "GenesisTools", path: "Sources"),
        // Pure logic (settings, pane order, request parsing, proposals); UI is checked with `--snapshot`
        // and `--bench` runs. The exceptions render into a window nobody sees (alpha 0, below the desktop,
        // never activated): LiveTimeTests and SessionTranscriptScrollTests, copied from Genesis.
        .testTarget(name: "GenesisToolsTests", dependencies: ["GenesisTools"], path: "Tests"),
    ]
)
