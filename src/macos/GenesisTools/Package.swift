// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GenesisTools",
    // macOS 14: the session views stolen from Genesis (Hub/Stolen/Sessions) use onChange(of:initial:).
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "GenesisTools", path: "Sources"),
    ]
)
