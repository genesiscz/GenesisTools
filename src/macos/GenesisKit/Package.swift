// swift-tools-version: 5.9
import PackageDescription

// The SwiftUI components GenesisTools.app and Genesis.app share: the cmux target picker, path and
// copy controls, menu buttons, badges, the hover styles and the instant tooltip. GenesisTools
// depends on it as `../GenesisKit`; Genesis (GenesisPlayground) as
// `../../../../GenesisTools/src/macos/GenesisKit`. See README.md for the rules.
let package = Package(
    name: "GenesisKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "GenesisKit", targets: ["GenesisKit"]),
    ],
    targets: [
        .target(name: "GenesisKit", path: "Sources/GenesisKit"),
        .testTarget(name: "GenesisKitTests", dependencies: ["GenesisKit"], path: "Tests/GenesisKitTests"),
    ]
)
