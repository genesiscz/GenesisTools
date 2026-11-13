import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// The four frame rules that TypeScript (check, info, items-at, the agents) and this renderer both compute, replayed from
/// frame-rules.json: scripts/recorder/write-protocol-fixtures.ts writes each case with the value the TypeScript function
/// returns, and recording-editor.test.ts keeps the file current. A failure names the rule, the case, the TypeScript value
/// and the Swift value; which side is right is a product question, so neither side is changed to make it pass.
final class RecorderFrameRulesTests: XCTestCase {
    private func section(_ name: String) throws -> [[String: Any]] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: SharedEditorFixture.url("frame-rules.json"))) as? [String: Any])
        let section = try XCTUnwrap(root[name] as? [String: Any], "frame-rules.json has no \(name)")
        let cases = try XCTUnwrap(section["cases"] as? [[String: Any]], "frame-rules.json \(name) has no cases")
        XCTAssertFalse(cases.isEmpty, "frame-rules.json \(name) has no cases")
        return cases
    }

    private func edit(_ item: [String: Any]) throws -> EditProject {
        let input = try XCTUnwrap(item["input"] as? [String: Any])
        return try JSONDecoder().decode(EditProject.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(input["edit"])))
    }

    private func int(_ value: Any?) -> Int64? { (value as? NSNumber)?.int64Value }

    /// TimelineMap.outputTime(ofSource:) and sourceTime(atOutput:), twins of outputTimeOf and sourceTimeOf (project.ts).
    func testOutputAndSourceTimeMatchTheTypeScriptCases() throws {
        for item in try section("time") {
            let name = item["name"] as? String ?? "?"
            let project = try edit(item)
            let input = try XCTUnwrap(item["input"] as? [String: Any])
            let value = try XCTUnwrap(item["value"] as? [String: Any])
            let sources = try XCTUnwrap(input["sourceUs"] as? [NSNumber]).map(\.int64Value)
            let outs = try XCTUnwrap(input["outUs"] as? [NSNumber]).map(\.int64Value)
            let expectedOutput = try XCTUnwrap(value["outputUs"] as? [Any]).map { int($0) }
            let expectedSource = try XCTUnwrap(value["sourceUs"] as? [NSNumber]).map(\.int64Value)
            XCTAssertEqual(sources.map { TimelineMap.outputTime(ofSource: $0, in: project) }, expectedOutput,
                           "time, \(name): outputTime(ofSource:) of \(sources)")
            XCTAssertEqual(outs.map { TimelineMap.sourceTime(atOutput: $0, in: project) }, expectedSource,
                           "time, \(name): sourceTime(atOutput:) of \(outs)")
        }
    }

    /// TransitionLook.joins (RenderFx.swift), twin of transitionJoins (fx.ts). TypeScript also lists the joins where
    /// nothing plays (kind none, halfUs 0) for info; the renderer leaves those out, as fx.ts's doc says.
    func testJoinsMatchTheTypeScriptCasesThatPlay() throws {
        for item in try section("joins") {
            let name = item["name"] as? String ?? "?"
            let project = try edit(item)
            let expected = try XCTUnwrap(item["value"] as? [[String: Any]])
                .filter { (int($0["halfUs"]) ?? 0) > 0 }
                .map { "\($0["clip"] ?? "") \($0["atUs"] ?? "") \($0["kind"] ?? "") \($0["ms"] ?? "") \($0["halfUs"] ?? "")" }
            let joins = TransitionLook.joins(in: project)
                .map { "\($0.clip) \($0.atUs) \($0.transition.kind.rawValue) \($0.transition.ms) \($0.halfUs)" }
            XCTAssertEqual(joins, expected, "joins, \(name)")
        }
    }

    /// ZoomCurve.view (TimelineMap.swift) in the middle of a manual picture zoom, where it is fully in: its rect is the
    /// twin of zoomView (check.ts).
    func testTheZoomClampMatchesTheTypeScriptCases() throws {
        for item in try section("zoomClamp") {
            let name = item["name"] as? String ?? "?"
            let input = try XCTUnwrap(item["input"] as? [String: Double])
            let value = try XCTUnwrap(item["value"] as? [String: Double])
            var project = EditProject.whole(video: "/rec/screen.mp4", durationUs: 10_000_000, width: 1920, height: 1080,
                                            cursor: nil, recording: nil)
            project.zooms = [EditProject.Zoom(id: "z", startUs: 0, endUs: 10_000_000, scale: try XCTUnwrap(input["scale"]),
                                              focusX: try XCTUnwrap(input["focusX"]), focusY: try XCTUnwrap(input["focusY"]),
                                              easeInMs: 500, easeOutMs: 500)]
            let rect = ZoomCurve.view(atSource: 5_000_000, project: project, cursor: nil).rect
            let swift = [rect.minX, rect.minY, rect.width, rect.height]
            let typescript = ["x", "y", "width", "height"].map { value[$0] ?? .nan }
            for (got, want) in zip(swift, typescript) {
                XCTAssertEqual(got, want, accuracy: 1e-9, "zoomClamp, \(name): Swift \(swift), TypeScript \(typescript)")
            }
        }
    }

    /// RedactionEdges.effective without the movie's frame times, twin of snappedRedactionSpans (project.ts).
    func testTheHiddenPartSnapMatchesTheTypeScriptCases() throws {
        for item in try section("hiddenSnap") {
            let name = item["name"] as? String ?? "?"
            let project = try edit(item)
            let expected = try XCTUnwrap(item["value"] as? [[String: Any]])
                .map { "\($0["id"] ?? "") \($0["style"] ?? "") \($0["startUs"] ?? "") \($0["endUs"] ?? "")" }
            let drawn = RedactionEdges.effective(project, frames: nil)
                .map { "\($0.id) \($0.style.rawValue) \($0.startUs) \($0.endUs)" }
            XCTAssertEqual(drawn, expected, "hiddenSnap, \(name)")
        }
    }
}
