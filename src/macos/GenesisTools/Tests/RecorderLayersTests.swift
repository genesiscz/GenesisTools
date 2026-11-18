import GenesisKit
import XCTest
@testable import GenesisToolsRecorder

final class RecorderLayersTests: XCTestCase {
    private struct Cases<Row: Decodable>: Decodable {
        let cases: [Row]
    }

    private func cases<Row: Decodable>(_ file: String, of type: Row.Type) throws -> [Row] {
        let url = SharedEditorFixture.url("../\(file)").standardizedFileURL
        let rows = try JSONDecoder().decode(Cases<Row>.self, from: Data(contentsOf: url)).cases
        XCTAssertFalse(rows.isEmpty, file)
        return rows
    }

    func testSoundLanesAndMovieTracksMatchEverySharedCase() throws {
        struct Row: Decodable {
            let name: String
            let audio: EditProject.AudioSettings
            let facts: EditProject.AudioFacts
            let lanes: [EditProject.AudioLane]
            let movieTracksPlayed: [Int]
        }
        var edit = try project(oldEdit())
        for row in try cases("audio-lanes.cases.json", of: Row.self) {
            edit.audio = row.audio
            let lanes = edit.audioLanes(facts: row.facts)
            XCTAssertEqual(lanes, row.lanes, row.name)
            XCTAssertEqual(edit.movieTracksPlayed(lanes, facts: row.facts), row.movieTracksPlayed, row.name)
            XCTAssertEqual(edit.audio.lanes, row.audio.lanes, row.name)
        }
    }

    func testStackOrderAndMovesMatchEverySharedCase() throws {
        struct Row: Decodable {
            struct Ref: Decodable { let id: String; let kind: String }
            let name: String
            let camera: Bool
            let layers: EditProject.LayerStack?
            let moves: [EditOp.LayerMove]
            let order: [Ref]
        }
        for row in try cases("layers.cases.json", of: Row.self) {
            var edit = try project(oldEdit())
            edit.layers = row.layers
            edit.camera = row.camera ? .init(file: "camera.mov") : nil
            for move in row.moves { edit = try edit.movingLayer(move.id, to: move.to) }
            let stack = edit.layerOrder()
            XCTAssertEqual(stack.map(\.id), row.order.map(\.id), row.name)
            XCTAssertEqual(stack.map { item -> String in
                switch item {
                case .camera: "camera"
                case let .media(layer): layer.kind.rawValue
                }
            }, row.order.map(\.kind), row.name)
        }
    }

    func testCameraWidthUsesTheCanvasShortSide() throws {
        let old = try project(oldEdit())
        XCTAssertNil(old.layers)
        XCTAssertNil(old.audio.lanes)
        for canvas in [CGSize(width: 1920, height: 1080), CGSize(width: 600, height: 600), CGSize(width: 900, height: 1600)] {
            let width = EditProject.layerWidth(forCameraSize: 0.32, canvas: canvas)
            XCTAssertEqual(width * Double(canvas.width), 0.32 * Double(min(canvas.width, canvas.height)), accuracy: 0.000_001)
            XCTAssertEqual(EditProject.cameraSize(forWidth: width, canvas: canvas), 0.32, accuracy: 0.000_001)
        }
        let mark = try project(withLayers())
        var changed = mark
        changed.camera?.size = 0.32
        let ops = try XCTUnwrap(EditOpDiff.ops(from: mark, to: changed))
        guard case let .layer(op)? = ops.first else { return XCTFail("Expected a camera layer resize") }
        XCTAssertEqual(op.id, "camera")
        XCTAssertEqual(try XCTUnwrap(op.width), 0.18, accuracy: 0.000_001)
    }

    func testGestureOpsIdentifyTheChangedLaneAndLayer() throws {
        var mark = try project(oldEdit())
        mark.audio.mutedTracks = [0]
        let facts = EditProject.AudioFacts(movieTracks: 1, mixedFrom: [
            .init(source: .mic, file: "mic.m4a", offsetMs: 70), .init(source: .system, file: "system.m4a", offsetMs: 0),
        ])
        var draft = mark
        draft.audio.lanes = mark.audioLanes(facts: facts)
        draft.audio.lanes?[1].muted = false
        XCTAssertEqual(EditOpDiff.ops(from: mark, to: draft), [.audioLane(.init(id: "system", muted: false))])
        XCTAssertEqual(EditorModel.changeName(from: mark, to: draft).name, "Unmute System sound")
        mark = try project(withLayers())
        draft = mark
        draft.layers?.media[0].shape = nil
        draft.layers?.media[0].opacity = 0.5
        let ops = try XCTUnwrap(EditOpDiff.ops(from: mark, to: draft))
        XCTAssertEqual(try bytes(EditOp.objects(ops)), try bytes([["op": "layer", "id": "l-logo", "opacity": 0.5, "shape": NSNull()]]))
        XCTAssertThrowsError(try draft.movingLayer("gone", to: .top)) { XCTAssertEqual($0.localizedDescription, "no layer gone") }
        let moved = try mark.movingLayer("l-logo", to: .bottom)
        let reorder = try XCTUnwrap(EditOpDiff.ops(from: mark, to: moved))
        XCTAssertEqual(reorder.count, 1)
        guard case let .layerMove(move)? = reorder.first else { return XCTFail("Expected layerMove") }
        XCTAssertEqual(try mark.movingLayer(move.id, to: move.to).layerOrder(), moved.layerOrder())
        draft = mark
        draft.camera?.show = false
        XCTAssertEqual(EditorModel.changeName(from: mark, to: draft).name, "Hide Camera")
    }

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
        let sorted = JSONEncoder()
        sorted.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try sorted.encode(project(old)), try bytes(old))
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
        guard steps.count == rows.count else { return XCTFail("Expected \(rows.count) apply/undo pairs, got \(steps.count)") }
        XCTAssertTrue(try XCTUnwrap(result["refused"] as? String).contains(#"layer {id: "camera", hidden: true}"#))
        let names = ["Mute Narration", "Change Narration Volume", "Add stamp.png", "Hide Logo", "Reorder Camera and Logo",
                     "Remove Logo", "Camera Bubble"]
        let feed = ["Muted Narration", "Changed Narration volume", "Added stamp.png", "Hid Logo", "Camera is now above Logo",
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
            if index == 3 {
                let media = try XCTUnwrap(after.layers?.media.first)
                XCTAssertTrue(media.hidden)
                XCTAssertNil(media.shape)
            }
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
