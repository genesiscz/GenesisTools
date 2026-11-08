import AppKit
import XCTest
@testable import GenesisToolsRecorder

/// check() (check.ts textBox, text-metrics.ts) lays a text out from text-metrics.json, not with AppKit.
/// text-metrics.cases.json records the plates TextPlates draws for a set of texts, and recording-editor.test.ts holds
/// check()'s estimate of each to within 2 px. These tests hold the renderer to the same file, so a change of the system
/// font or of the renderer fails here. Then write the table again with `swift scripts/recorder/text-metrics.swift`,
/// record the plates again with `RECORDER_TEXT_CASES_WRITE=1 bun run app:test -- --filter RecorderTextMetricsTests`,
/// and run the TypeScript test. A new case is a row with any plate, recorded the same way.
final class RecorderTextMetricsTests: XCTestCase {
    func testTheRendererDrawsThePlatesTheCasesRecorded() throws {
        var file = try JSONDecoder().decode(TextCases.self, from: Data(contentsOf: Self.casesURL))
        let canvas = CGSize(width: file.canvas.width, height: file.canvas.height)
        let plates = TextPlates()
        let record = ProcessInfo.processInfo.environment["RECORDER_TEXT_CASES_WRITE"] == "1"
        for (index, item) in file.cases.enumerated() {
            let note = EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: item.text, size: item.size,
                                            block: item.block)
            // As drawText sizes, wraps and aligns it.
            let style = Looks.textPlateStyle(note, size: canvas)
            let plate = try XCTUnwrap(plates.plate(note.text, fontSize: style.fontSize, maxWidth: style.wrap, weight: .semibold,
                                                   alignment: style.alignment), item.text).extent.size
            let drawn = TextCases.Size(width: plate.width, height: plate.height)
            if record {
                file.cases[index].plate = drawn
            } else {
                XCTAssertEqual(drawn, item.plate, "the plate of \(item.text.debugDescription) at size \(item.size)")
            }
        }
        if record {
            try file.json().write(to: Self.casesURL)
        }
    }

    /// TextPlates.render's font, as the table measured it.
    func testTheTableMeasuredTheRenderersFont() throws {
        let metrics = try JSONDecoder().decode(FontMetrics.self, from: Data(contentsOf: Self.metricsURL))
        let font = NSFont.systemFont(ofSize: 1000, weight: .semibold)
        XCTAssertEqual(metrics.font, font.fontName)
        XCTAssertEqual(metrics.ascender, Double(font.ascender) / 1000, accuracy: 1e-6)
        XCTAssertEqual(metrics.descender, Double(-font.descender) / 1000, accuracy: 1e-6)
    }

    private static var folder: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("utils/recording-editor")
    }

    private static var metricsURL: URL { folder.appendingPathComponent("text-metrics.json") }
    private static var casesURL: URL { folder.appendingPathComponent("text-metrics.cases.json") }
}

private struct FontMetrics: Decodable {
    let font: String
    let ascender: Double
    let descender: Double
}

/// text-metrics.cases.json: texts and the plates the renderer draws for them on `canvas`, in whole pixels.
private struct TextCases: Decodable {
    struct Size: Decodable, Equatable {
        var width: Double
        var height: Double
    }

    struct Case: Decodable {
        let text: String
        let size: Double
        let block: EditProject.TextBlock?
        var plate: Size
    }

    let about: String
    let canvas: Size
    var cases: [Case]

    /// The file as the TypeScript side reads it: one case per line.
    func json() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        let quoted = { (text: String) in String(decoding: try encoder.encode(text), as: UTF8.self) }
        let size = { (size: Size) in "{ \"width\": \(Int(size.width)), \"height\": \(Int(size.height)) }" }
        let rows = try cases.map { item -> String in
            var fields = ["\"text\": \(try quoted(item.text))", "\"size\": \(item.size)"]
            if let block = item.block {
                let parts = [block.width.map { "\"width\": \($0)" }, block.align.map { "\"align\": \"\($0.rawValue)\"" }]
                fields.append("\"block\": { \(parts.compactMap { $0 }.joined(separator: ", ")) }")
            }
            fields.append("\"plate\": \(size(item.plate))")
            return "        { \(fields.joined(separator: ", ")) }"
        }
        let about = "The plates Captions.swift TextPlates draws for these texts on the canvas, sized, wrapped and aligned "
            + "as Looks.drawText does, in whole pixels. RecorderTextMetricsTests writes each plate "
            + "(RECORDER_TEXT_CASES_WRITE=1) and holds the renderer to it; recording-editor.test.ts holds check()'s "
            + "textBox to it within 2 px. To add a case, add a row with any plate and record the file again."
        let text = "{\n    \"about\": \(try quoted(about)),\n    \"canvas\": \(size(canvas)),\n    \"cases\": [\n"
            + rows.joined(separator: ",\n") + "\n    ]\n}\n"
        return Data(text.utf8)
    }
}
