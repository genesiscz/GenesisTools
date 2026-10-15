import XCTest

/// GenesisTools.app links the core `GenesisKit` library only. PostureWatcher, the Disk Manager and their charts live
/// in Genesis-only libraries of the same package, so this app never compiles them (Martin, 2026-10-14: "make sure
/// the posture watcher and disk manager are not compiled when compiling GenesisTools"). Both checks read files, so
/// they fail before a build would quietly start compiling that code again.
final class KitModuleBoundaryTests: XCTestCase {
    private static let genesisOnly = ["GenesisKitCharts", "GenesisKitPosture", "GenesisKitDisk"]
    /// One type from each Genesis-only area; any of them declared in the core means its code compiles into this app.
    private static let anchors = [
        "PostureMonitor", "CameraFrameSource", "ScreenEffectsController", "VisionBodyPoseEngine",
        "ToolsDiskProvider", "DuIndexReader", "AlertPolicy", "SunburstChart", "TreemapView", "HealthBar",
    ]

    private var package: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    func testTheAppNeitherDependsOnNorImportsAGenesisOnlyLibrary() throws {
        let manifest = try String(contentsOf: package.appendingPathComponent("Package.swift"), encoding: .utf8)
        for name in Self.genesisOnly {
            XCTAssertFalse(manifest.contains(name), "Package.swift names \(name)")
        }
        var imports: [String] = []
        let files = FileManager.default.enumerator(at: package.appendingPathComponent("Sources"), includingPropertiesForKeys: nil)
        while let file = files?.nextObject() as? URL {
            guard file.pathExtension == "swift" else { continue }
            let text = try String(contentsOf: file, encoding: .utf8)
            for name in Self.genesisOnly where text.range(of: "import \(name)\\b", options: .regularExpression) != nil {
                imports.append("\(file.lastPathComponent): \(name)")
            }
        }
        XCTAssertEqual(imports, [], "the app imports a Genesis-only library")
    }

    func testTheCoreKitDeclaresNoPostureDiskOrChartType() throws {
        let core = package.deletingLastPathComponent().appendingPathComponent("GenesisKit/Sources/GenesisKit")
        var scanned = 0
        var found: [String] = []
        let files = FileManager.default.enumerator(at: core, includingPropertiesForKeys: nil)
        while let file = files?.nextObject() as? URL {
            guard file.pathExtension == "swift" else { continue }
            scanned += 1
            let text = try String(contentsOf: file, encoding: .utf8)
            for name in Self.anchors {
                let pattern = "(class|struct|enum|protocol|actor|typealias) \(name)\\b"
                if text.range(of: pattern, options: .regularExpression) != nil {
                    found.append("\(file.lastPathComponent): \(name)")
                }
            }
        }
        XCTAssertGreaterThan(scanned, 100, "read the core kit at \(core.path)")
        XCTAssertEqual(found, [], "Genesis-only code is back in the core GenesisKit target")
    }
}
