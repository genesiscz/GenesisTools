import XCTest
@testable import GenesisToolsRecorder

/// A hidden part with keyframes (hideText, hidePrivate, verifyHidden's fixOps, redact with track) moves and resizes
/// with its keys. The renderer places such a part by its keys alone, so a drag that changed only x, y, width and height
/// was saved and then ignored: the outline snapped back and the export hid the old place. The case is the one
/// recording-editor.test.ts pins for setRedaction.
final class RecorderHuntTrackedPartMoveTests: XCTestCase {
    private func tracked() -> EditProject.Redaction {
        var part = EditProject.Redaction(id: "r", startUs: 1_000_000, endUs: 3_000_000, x: 0.1, y: 0.1, width: 0.2, height: 0.05,
                                         style: .black)
        part.track = [
            EditProject.TrackKey(atUs: 1_000_000, x: 0.1, y: 0.1, width: 0.2, height: 0.05),
            EditProject.TrackKey(atUs: 3_000_000, x: 0.1, y: 0.5, width: 0.2, height: 0.05),
        ]
        return part
    }

    private func assertBox(_ box: (Double, Double, Double, Double), _ expected: (Double, Double, Double, Double),
                           _ message: String, line: UInt = #line) {
        XCTAssertEqual(box.0, expected.0, accuracy: 1e-9, "\(message): x", line: line)
        XCTAssertEqual(box.1, expected.1, accuracy: 1e-9, "\(message): y", line: line)
        XCTAssertEqual(box.2, expected.2, accuracy: 1e-9, "\(message): width", line: line)
        XCTAssertEqual(box.3, expected.3, accuracy: 1e-9, "\(message): height", line: line)
    }

    func testADragAtAPlayheadBetweenTwoKeysMovesEveryKeyByTheDragFromTheShownBox() throws {
        let part = tracked()
        let shown = RedactionTrack.shownRect(part, atSourceUs: 2_000_000)
        assertBox((shown.minX, shown.minY, shown.width, shown.height), (0.1, 0.3, 0.2, 0.05), "the box halfway between the keys")
        let moved = RedactionTrack.moved(part, to: CGRect(x: 0.2, y: 0.35, width: 0.3, height: 0.1), atSourceUs: 2_000_000)
        let keys = try XCTUnwrap(moved.track)
        XCTAssertEqual(keys.map(\.atUs), [1_000_000, 3_000_000])
        assertBox((keys[0].x, keys[0].y, keys[0].width, keys[0].height), (0.2, 0.15, 0.3, 0.1), "the first key")
        assertBox((keys[1].x, keys[1].y, keys[1].width, keys[1].height), (0.2, 0.55, 0.3, 0.1), "the last key")
        assertBox((moved.x, moved.y, moved.width, moved.height), (0.2, 0.15, 0.3, 0.1), "the stored rect moves with the keys")
        let drawn = ZoomState.placed(moved, atSourceUs: 2_000_000, track: nil, pointer: CursorTrack.Pointer())
        assertBox((drawn.x, drawn.y, drawn.width, drawn.height), (0.2, 0.35, 0.3, 0.1), "the renderer draws it where it was dropped")
    }

    func testAMovePastThePictureKeepsEveryKeyInsideIt() throws {
        let moved = RedactionTrack.moved(tracked(), to: CGRect(x: 0.75, y: 0.6, width: 0.2, height: 0.05), atSourceUs: 1_000_000)
        for key in try XCTUnwrap(moved.track) {
            XCTAssertLessThanOrEqual(key.x + key.width, 1 + 1e-9)
            XCTAssertLessThanOrEqual(key.y + key.height, 1 + 1e-9)
        }
        XCTAssertEqual(moved.track?.last?.y ?? 0, 0.95, accuracy: 1e-9, "the last key stops at the bottom edge")
    }

    func testAPartWithoutKeysTakesTheRectAsItIs() {
        var part = tracked()
        part.track = nil
        let moved = RedactionTrack.moved(part, to: CGRect(x: 0.4, y: 0.5, width: 0.25, height: 0.1), atSourceUs: 2_000_000)
        XCTAssertNil(moved.track)
        assertBox((moved.x, moved.y, moved.width, moved.height), (0.4, 0.5, 0.25, 0.1), "an untracked part")
    }

    func testTheWindowSendsTheMovedKeysAsAnOpTheServiceAccepts() throws {
        var before = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        before.redactions = [tracked()]
        var after = before
        after.redactions = [RedactionTrack.moved(tracked(), to: CGRect(x: 0.2, y: 0.35, width: 0.3, height: 0.1), atSourceUs: 2_000_000)]
        let ops = try XCTUnwrap(EditOpDiff.ops(from: before, to: after))
        let set = try XCTUnwrap(ops.compactMap { op -> EditOp.SetRedaction? in
            if case let .setRedaction(payload) = op { return payload }
            return nil
        }.first)
        let keys = try XCTUnwrap(set.track, "the op carries the keys, so the service does not keep the old ones")
        XCTAssertEqual(keys.map(\.at), [1, 3])
        XCTAssertEqual(keys[1].y, 0.55, accuracy: 1e-9)
        XCTAssertEqual(set.rect?.x ?? 0, 0.2, accuracy: 1e-9)
        let schemas = try RecorderFixtures.Schemas()
        let params: [String: Any] = ["path": "/tmp/x", "gesture": "g1", "ops": EditOp.objects(ops)]
        XCTAssertEqual(try schemas.check(params, "params", "gesture.preview"), [], "the TypeScript schema accepts the op")

        var fixed = before
        fixed.redactions?[0].track = nil
        let unkeyed = try XCTUnwrap(EditOpDiff.ops(from: before, to: fixed))
        guard case let .setRedaction(payload)? = unkeyed.first else { return XCTFail("no setRedaction in \(unkeyed)") }
        XCTAssertEqual(payload.track, [], "taking the keys away sends an empty track")
        XCTAssertTrue(EditOpDiff.ops(from: before, to: before)?.isEmpty ?? false, "an unchanged part sends nothing")
    }
}
