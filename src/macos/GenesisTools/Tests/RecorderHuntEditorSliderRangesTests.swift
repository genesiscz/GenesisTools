import XCTest
@testable import GenesisToolsRecorder

/// The editor's sliders reach the ranges the edit ops take (service-protocol.schemas.json, written from the zod
/// source), so an agent's value never pins the thumb at an end and the first touch never lowers it silently.
final class RecorderHuntEditorSliderRangesTests: XCTestCase {
    /// The properties of the edit op `name` in the params schemas.
    private func op(_ name: String) throws -> [String: Any] {
        let root = try RecorderFixtures.object("service-protocol.schemas.json")
        func find(_ value: Any) -> [String: Any]? {
            if let object = value as? [String: Any] {
                if let properties = object["properties"] as? [String: Any],
                   (properties["op"] as? [String: Any])?["const"] as? String == name {
                    return properties
                }
                for child in object.values {
                    if let found = find(child) { return found }
                }
            } else if let list = value as? [Any] {
                for child in list {
                    if let found = find(child) { return found }
                }
            }
            return nil
        }
        return try XCTUnwrap(find(try XCTUnwrap(root["params"])), "the \(name) op in the params schemas")
    }

    private func range(_ op: String, _ field: String) throws -> ClosedRange<Double> {
        let schema = try XCTUnwrap(try self.op(op)[field] as? [String: Any], "\(op).\(field)")
        let low = try XCTUnwrap((schema["minimum"] as? NSNumber)?.doubleValue, "\(op).\(field).minimum")
        let high = try XCTUnwrap((schema["maximum"] as? NSNumber)?.doubleValue, "\(op).\(field).maximum")
        return low...high
    }

    func testEverySliderRangeIsTheOneTheOpSchemasHold() throws {
        let pairs: [(ClosedRange<Double>, String, String)] = [
            (EditLimits.duckingDb, "ducking", "db"),
            (EditLimits.duckingFadeMs, "ducking", "fadeMs"),
            (EditLimits.clicksRadius, "clicks", "radius"),
            (EditLimits.keysSize, "keys", "size"),
            (EditLimits.captionsSize, "captions", "size"),
            (EditLimits.cursorHideAfterMs, "cursor", "hideAfterMs"),
            (EditLimits.smoothJitterPx, "cursorSmooth", "jitterPx"),
            (EditLimits.smoothIdleFadeSeconds, "cursorSmooth", "idleFadeSeconds"),
            (EditLimits.framePadding, "frame", "padding"),
            (EditLimits.frameCornerRadius, "frame", "cornerRadius"),
            (EditLimits.progressChapterMs, "progress", "chapterMs"),
        ]
        for (limit, op, field) in pairs {
            XCTAssertEqual(limit, try range(op, field), "\(op).\(field)")
        }
    }

    func testTheDipTimeTabsShowAStoredValueThatIsNoPreset() {
        XCTAssertEqual(DuckingSection.fadeValues(300), [0, 150, 300, 600, 1000])
        XCTAssertEqual(DuckingSection.fadeValues(3000), [0, 150, 300, 600, 1000, 3000], "an agent's 3 s is shown as it is")
        XCTAssertEqual(DuckingSection.fadeValues(450), [0, 150, 300, 450, 600, 1000])
    }
}
