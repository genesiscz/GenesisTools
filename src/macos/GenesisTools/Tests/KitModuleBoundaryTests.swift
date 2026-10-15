import XCTest

/// GenesisTools.app links the core `GenesisKit` library and compiles another GenesisKit library only when it imports
/// it (Martin, 2026-10-14: "make sure the posture watcher and disk manager are not compiled when compiling
/// GenesisTools"; 2026-10-15: GenesisTools may import the charts and the screen effects). PostureWatcher and the Disk
/// Manager are Genesis's and never imported here. Both checks read files, so they fail before a build would quietly
/// start compiling that code again.
enum KitManifest {
    /// True when `manifest` depends on `name`. A comment that only mentions the name does not count: the
    /// dependency is the quoted product token.
    static func depends(on name: String, in manifest: String) -> Bool {
        manifest.contains("\"\(name)\"")
    }
}

final class KitModuleBoundaryTests: XCTestCase {
    private static let genesisOnly = ["GenesisKitPosture", "GenesisKitDisk"]
    /// One type from each optional library; any of them declared in the core means it compiles into this app whether
    /// it is used or not.
    private static let anchors = [
        "PostureMonitor", "CameraFrameSource", "VisionBodyPoseEngine", "ToolsDiskProvider", "DuIndexReader",
        "ScreenEffectsController", "SunburstChart", "TreemapView", "HealthBar",
    ]

    private var package: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    func testTheAppNeitherDependsOnNorImportsAGenesisOnlyLibrary() throws {
        let manifest = try String(contentsOf: package.appendingPathComponent("Package.swift"), encoding: .utf8)
        for name in Self.genesisOnly {
            XCTAssertFalse(KitManifest.depends(on: name, in: manifest), "Package.swift depends on \(name)")
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

    func testTheCoreKitDeclaresNoTypeOfAnOptionalLibrary() throws {
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
        XCTAssertEqual(found, [], "an optional library's code is back in the core GenesisKit target")
    }

    func testACommentThatNamesAGenesisOnlyLibraryIsNotADependency() {
        let comment = "// GenesisKitDisk and GenesisKitPosture stay out of this app."
        XCTAssertFalse(KitManifest.depends(on: "GenesisKitDisk", in: comment))
        XCTAssertFalse(KitManifest.depends(on: "GenesisKitPosture", in: comment))
        let dependency = ".product(name: \"GenesisKitDisk\", package: \"GenesisKit\")"
        XCTAssertTrue(KitManifest.depends(on: "GenesisKitDisk", in: dependency))
        XCTAssertFalse(KitManifest.depends(on: "GenesisKitPosture", in: dependency))
    }
}
