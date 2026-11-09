import XCTest
@testable import GenesisToolsRecorder

/// check() lays texts out and counts frames on the export's canvas and rate from exportPlanOf (project.ts), a mirror
/// of EditRenderer.plannedOutput. export-size.cases.json pins the rule: recording-editor.test.ts holds exportPlanOf to
/// it, and this test holds plannedOutput to the same rows, so a change on one side fails until the other follows.
final class RecorderHuntR2CheckExportCanvasTests: XCTestCase {
    func testPlannedOutputGivesTheCanvasAndRateTheCasesRecord() throws {
        let file = try JSONDecoder().decode(ExportSizeCases.self, from: Data(contentsOf: Self.casesURL))
        XCTAssertFalse(file.cases.isEmpty)
        for row in file.cases {
            var settings = EditProject.ExportSettings()
            settings.codec = row.export.codec == "hevc" ? .hevc : .h264
            settings.maxHeight = row.export.maxHeight
            settings.size = row.export.size.map { EditProject.OutputSize(width: $0.width, height: $0.height) }
            let aspect = row.aspect.flatMap { EditProject.CanvasAspect(rawValue: $0) }
            let plan = EditRenderer.plannedOutput(export: settings,
                                                  source: CGSize(width: row.source.width, height: row.source.height),
                                                  aspect: aspect, nominalFps: row.nominalFps)
            XCTAssertEqual(plan.fps, row.fps, row.name)
            XCTAssertEqual(plan.canvas, CGSize(width: row.canvas.width, height: row.canvas.height), row.name)
        }
    }

    private static var casesURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("utils/recording-editor/export-size.cases.json")
    }
}

/// export-size.cases.json: a source, export settings, a frame aspect and a movie rate, with the canvas and the rate.
private struct ExportSizeCases: Decodable {
    struct Size: Decodable {
        var width: Double
        var height: Double
    }

    struct Side: Decodable {
        var width: Int?
        var height: Int?
    }

    struct Export: Decodable {
        var codec: String
        var maxHeight: Int
        var size: Side?
    }

    struct Row: Decodable {
        var name: String
        var source: Size
        var export: Export
        var aspect: String?
        var nominalFps: Double
        var fps: Double
        var canvas: Size
    }

    var cases: [Row]
}
