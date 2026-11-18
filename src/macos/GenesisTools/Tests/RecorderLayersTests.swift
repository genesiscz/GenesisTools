import GenesisKit
import XCTest
@testable import GenesisToolsRecorder

final class RecorderLayersTests: XCTestCase {
    private func oldEdit() throws -> [String: Any] {
        let data = try Data(contentsOf: SharedEditorFixture.url("edit-markers.json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(fixture["edit"] as? [String: Any])
    }

    private func bytes(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    private func project(_ json: [String: Any]) throws -> EditProject { try EditProject.decode(bytes(json)) }

    private let lane: [String: Any] = [
        "id": "mic", "source": "mic", "file": "mic.m4a", "offsetMs": -19, "volume": 1, "muted": false, "name": "Narration",
    ]
    private let logo: [String: Any] = [
        "id": "l-logo", "kind": "image", "file": "logo.png", "startUs": 20, "endUs": 900_000,
        "x": 0.25, "y": 0.75, "width": 0.35, "opacity": 1, "shape": "rounded", "name": "Logo",
        "hidden": false, "videoStartMs": 0, "videoSound": false, "loop": false,
    ]

    private func withLayers() throws -> [String: Any] {
        var json = try oldEdit()
        var audio = try XCTUnwrap(json["audio"] as? [String: Any])
        audio["lanes"] = [lane]
        json["audio"] = audio
        json["camera"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(EditProject.Camera(file: "camera.mov")))
        json["layers"] = ["media": [logo], "order": ["camera", "l-logo"]] as [String: Any]
        return json
    }

    func testUntouchedOldEditAndSavedLaneAndLayerKeysRoundTrip() throws {
        let old = try oldEdit()
        for source in [old, try withLayers()] {
            let written = try project(source).encoded()
            XCTAssertEqual(try bytes(JSONSerialization.jsonObject(with: written)), try bytes(source))
        }
    }

    func testWireOpsPreserveShapeOmissionNullAndValueAndBothMoveForms() throws {
        let rows: [[String: Any]] = [
            ["op": "audioLane", "id": "mic", "muted": true, "volume": 0.5, "name": "Narration"],
            ["op": "layerAdd", "kind": "video", "file": "overlay.mov", "startUs": 123, "endUs": 456, "width": 0.4],
            ["op": "layer", "id": "l-logo", "hidden": true],
            ["op": "layer", "id": "l-logo", "shape": NSNull()],
            ["op": "layer", "id": "l-film", "shape": "circle", "videoStartMs": 52, "loop": true, "videoSound": true],
            ["op": "layerMove", "id": "camera", "to": 0], ["op": "layerMove", "id": "camera", "to": "top"],
            ["op": "layerRemove", "id": "l-film"],
        ]
        for row in rows {
            let op = try JSONDecoder().decode(EditOp.self, from: bytes(row))
            XCTAssertEqual(try bytes(op.object), try bytes(row))
        }
    }

    /// Exercise the same edit session the window talks to. Capture its saved edit after each apply and undo,
    /// so a writer dropping a field or a second undo step cannot be hidden by its in-memory answer.
    func testSwiftOpsApplyAndUndoInTheRecorder() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-layers-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var initial = try withLayers()
        var source = try XCTUnwrap(initial["source"] as? [String: Any])
        source["video"] = folder.appendingPathComponent("screen.mp4").path
        initial["source"] = source
        try bytes(initial).write(to: folder.appendingPathComponent("edit.json"))
        let rows: [[String: Any]] = [
            ["op": "audioLane", "id": "mic", "muted": true], ["op": "audioLane", "id": "mic", "volume": 0.75],
            ["op": "layerAdd", "file": "stamp.png", "kind": "image", "startUs": 100, "endUs": 500],
            ["op": "layer", "id": "l-logo", "hidden": true, "shape": NSNull()],
            ["op": "layerMove", "id": "l-logo", "to": "bottom"], ["op": "layerRemove", "id": "l-logo"],
            ["op": "layer", "id": "camera", "x": 0.3, "y": 0.4, "width": 0.18, "hidden": true, "shape": "square"],
        ]
        let ops = try JSONDecoder().decode([EditOp].self, from: bytes(rows))
        try JSONEncoder().encode(ops).write(to: folder.appendingPathComponent("ops.json"))

        let proc = Process()
        proc.currentDirectoryURL = SharedEditorFixture.url("edit-markers.json")
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.environment = ProcessInfo.processInfo.environment.merging([
            "GENESIS_TOOLS_HOME": folder.appendingPathComponent("home").path, "RECORDER_TEST_DIR": folder.path,
        ]) { _, local in local }
        proc.arguments = ["bun", "-e", """
        import { EditSession } from "./src/recorder/lib/edit-session.ts";
        import { parseEditOps } from "./src/utils/recording-editor/project.ts";
        const dir = Bun.env.RECORDER_TEST_DIR;
        const path = dir + "/edit.json";
        const session = await EditSession.open(path, { onChange() {} });
        const writer = { by: "editor-test" };
        const steps = [];
        try {
            for (const op of parseEditOps(await Bun.file(dir + "/ops.json").json())) {
                await session.apply([op], writer);
                session.flush();
                const after = await Bun.file(path).json();
                const depth = session.undoDepth;
                const { undone } = await session.undo(writer);
                session.flush();
                steps.push({ after, depth, undone, restored: await Bun.file(path).json(), remaining: session.undoDepth });
            }
            let refused;
            try { await session.apply([{ op: "layerRemove", id: "camera" }], writer); }
            catch (error) { refused = error.message; }
            await Bun.write(dir + "/result.json", JSON.stringify({ steps, refused }));
        } finally { session.close(); }
        """]
        let run = try proc.runCapturing(timeout: 45)
        guard run.status == 0 else { return XCTFail(String(decoding: run.stderr, as: UTF8.self)) }
        let data = try Data(contentsOf: folder.appendingPathComponent("result.json"))
        let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let steps = try XCTUnwrap(result["steps"] as? [[String: Any]])
        XCTAssertEqual(steps.count, rows.count)
        XCTAssertTrue(try XCTUnwrap(result["refused"] as? String).contains(#"layer {id: "camera", hidden: true}"#))
        let names = ["Mute Narration", "Change Narration Volume", "Add stamp.png", "Hide Logo", "Move Camera above Logo",
                     "Remove Logo", "Camera Bubble"]
        let feed = ["Muted Narration", "Changed Narration volume", "Added stamp.png", "Hid Logo", "Moved Camera above Logo",
                    "Removed Logo", "Hid the camera bubble"]
        let before = try project(initial)
        for (index, step) in steps.enumerated() {
            let afterJSON = try XCTUnwrap(step["after"] as? [String: Any])
            let after = try project(afterJSON)
            XCTAssertEqual(try bytes(JSONSerialization.jsonObject(with: after.encoded())), try bytes(afterJSON),
                           "Swift must keep every key written by the TypeScript op")
            XCTAssertEqual(step["depth"] as? Int, 1)
            XCTAssertEqual(step["undone"] as? [String], [ops[index].tag])
            XCTAssertEqual(step["remaining"] as? Int, 0)
            var restored = try project(XCTUnwrap(step["restored"] as? [String: Any]))
            restored.revision = before.revision
            restored.updatedBy = before.updatedBy
            XCTAssertEqual(restored, before)
            XCTAssertEqual(EditorModel.changeName(from: before, to: after).name, names[index])
            let change = try XCTUnwrap(EditDiff.describe(old: before, new: after, by: "editor-test", at: Date()))
            XCTAssertTrue(change.lines.contains { $0.text.hasPrefix(feed[index]) }, "\(ops[index].tag): \(change.lines)")
            if index == rows.count - 1 {
                XCTAssertEqual(after.camera?.corner, .custom)
                XCTAssertEqual(after.camera?.x, 0.3)
                XCTAssertEqual(after.camera?.y, 0.4)
                XCTAssertEqual(after.camera?.show, false)
                XCTAssertEqual(after.camera?.shape, .square)
                XCTAssertEqual(try XCTUnwrap(after.camera?.size), 0.32, accuracy: 0.000_001)
                XCTAssertEqual(afterJSON["layers"] as? NSDictionary, initial["layers"] as? NSDictionary)
            }
        }
    }
}
