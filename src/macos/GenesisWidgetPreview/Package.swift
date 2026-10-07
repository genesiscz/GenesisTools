// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "GenesisWidgetPreview",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../GenesisKit")],
    targets: [
        .executableTarget(name: "GenesisWidgetPreview", dependencies: ["GenesisKit"], path: "Sources")
    ]
)
