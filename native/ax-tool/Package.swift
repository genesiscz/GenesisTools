// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ax-tool",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "ax-tool", path: "Sources"),
    ]
)
