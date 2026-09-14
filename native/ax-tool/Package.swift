// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ax-tool",
    // 🛑 Keep this below 15. CGWindowListCreateImage, which every screenshot in Sources uses, is
    // declared SCREEN_CAPTURE_OBSOLETE(10.5,14.0,15.0) in CGWindow.h: deprecated at 14, gone from
    // the SDK once the deployment target reaches 15. Raise this only together with a
    // ScreenCaptureKit capture path. src/control/lib/native-platform.test.ts pins it.
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "ax-tool", dependencies: ["SnapshotSupport"], path: "Sources"),
        .target(name: "SnapshotSupport", path: "SnapshotSupport"),
        .testTarget(name: "SnapshotSupportTests", dependencies: ["SnapshotSupport"], path: "Tests"),
    ]
)
