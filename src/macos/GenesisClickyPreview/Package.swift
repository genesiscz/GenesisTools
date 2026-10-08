// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GenesisClickyPreview",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../GenesisKit")],
    targets: [.executableTarget(name: "GenesisClickyPreview", dependencies: ["GenesisKit"], path: "Sources")]
)
