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
    // The markdown viewer's "Native+" renderer: diagrams and highlighted code without a web view.
    dependencies: [
        .package(url: "https://github.com/lukilabs/beautiful-mermaid-swift", from: "1.0.4"),
        .package(url: "https://github.com/smittytone/HighlighterSwift", from: "3.1.0"),
    ],
    targets: [
        .target(
            name: "GenesisKit",
            dependencies: [
                .product(name: "BeautifulMermaid", package: "beautiful-mermaid-swift"),
                .product(name: "Highlighter", package: "HighlighterSwift"),
            ],
            path: "Sources/GenesisKit",
            // The markdown viewer's renderer (markdown-it, highlight.js, mermaid). An installed app copies it to
            // Contents/Resources/webview, which is read first; `swift test` and `swift run` read it from here.
            resources: [.copy("Markdown/Resources/webview")]
        ),
        .testTarget(name: "GenesisKitTests", dependencies: ["GenesisKit"], path: "Tests/GenesisKitTests"),
    ]
)
