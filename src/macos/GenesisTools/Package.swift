// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GenesisTools",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "GenesisTools", path: "Sources"),
    ]
)
