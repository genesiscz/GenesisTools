import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsRecorder

/// The editor's text and card fields, its card-length slider and its way-in slider take the limits the edit ops take
/// (service-protocol.schemas.json, written from the zod source), and a field refuses a value past its limit aloud
/// instead of cutting it. The editor cut every text and card field to 200 characters, so a 300-character text or a
/// 250-character link lost its end on one keystroke, and its sliders could not reach 0.5 s, 15 s or 5 s.
final class RecorderHuntEditorFieldLimitsTests: XCTestCase {
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

    private func number(_ properties: [String: Any], _ field: String, _ key: String) throws -> Double {
        let schema = try XCTUnwrap(properties[field] as? [String: Any], field)
        return try XCTUnwrap((schema[key] as? NSNumber)?.doubleValue, "\(field).\(key)")
    }

    func testEveryLimitIsTheOneTheOpSchemasHold() throws {
        let text = try op("text")
        XCTAssertEqual(EditLimits.text.limit, Int(try number(text, "text", "maxLength")), "a text's words")
        for name in ["text", "setText"] {
            let animate = try XCTUnwrap((try op(name)["animate"] as? [String: Any])?["properties"] as? [String: Any])
            XCTAssertEqual(EditLimits.textAnimateMs.lowerBound, try number(animate, "ms", "minimum"), "\(name) animate ms")
            XCTAssertEqual(EditLimits.textAnimateMs.upperBound, try number(animate, "ms", "maximum"), "\(name) animate ms")
        }

        let intro = try op("introCard")
        XCTAssertEqual(EditLimits.introTitle.limit, Int(try number(intro, "title", "maxLength")), "intro title")
        XCTAssertEqual(EditLimits.introSubtitle.limit, Int(try number(intro, "subtitle", "maxLength")), "intro subtitle")
        XCTAssertEqual(EditLimits.introDate.limit, Int(try number(intro, "date", "maxLength")), "intro date")

        let end = try op("endCard")
        XCTAssertEqual(EditLimits.endText.limit, Int(try number(end, "text", "maxLength")), "end card text")
        XCTAssertEqual(EditLimits.endLink.limit, Int(try number(end, "link", "maxLength")), "end card link")

        for (name, card) in [("introCard", intro), ("endCard", end)] {
            XCTAssertEqual(EditLimits.cardSeconds.lowerBound, try number(card, "seconds", "minimum"), "\(name) seconds")
            XCTAssertEqual(EditLimits.cardSeconds.upperBound, try number(card, "seconds", "maximum"), "\(name) seconds")
        }
    }

    func testATextTakesALongCalloutWholeAndRefusesOnePastTheLimitAloud() {
        XCTAssertNil(EditLimits.text.refusal(String(repeating: "x", count: 300)), "300 characters fit")
        XCTAssertNil(EditLimits.text.refusal(String(repeating: "x", count: 500)), "500 characters fit")
        XCTAssertNil(EditLimits.text.refusal(String(repeating: "x", count: 500) + "  "), "the op trims before it counts")
        XCTAssertEqual(EditLimits.text.refusal(String(repeating: "x", count: 501)),
                       "A text holds at most 500 characters (this one has 501); split it into two texts.")
        XCTAssertEqual(EditLimits.introTitle.refusal(String(repeating: "t", count: 121)),
                       "An intro title holds at most 120 characters (this one has 121).")
        XCTAssertNil(EditLimits.introDate.refusal(String(repeating: "d", count: 60)))
        XCTAssertNotNil(EditLimits.introDate.refusal(String(repeating: "d", count: 61)))
        XCTAssertEqual(EditLimits.text.refusal(String(repeating: "é", count: 250) + String(repeating: "😀", count: 1)),
                       nil, "a character the service counts as two UTF-16 units still fits under 500")
        XCTAssertNotNil(EditLimits.endText.refusal(String(repeating: "😀", count: 101)),
                        "the service counts UTF-16 units, so 101 emoji are 202 of 200")
    }

    func testAFieldSendsAValueThatFitsUncutAndRefusesALongerOneWithoutChangingIt() {
        var sent: [String] = []
        var said: [String] = []
        let link = String(repeating: "a", count: 250)
        let field = EditLimits.endLink.binding(link, set: { sent.append($0) }, refuse: { said.append($0) })

        field.wrappedValue = link + "b"
        XCTAssertEqual(sent, [link + "b"], "a 250-character link plus one typed character is sent whole")
        XCTAssertEqual(said, [])

        field.wrappedValue = String(repeating: "a", count: 301)
        XCTAssertEqual(sent.count, 1, "a value past the limit is never sent, cut or whole")
        XCTAssertEqual(said, ["An end card link holds at most 300 characters (this one has 301)."])
        XCTAssertEqual(field.wrappedValue, link, "the field keeps the value it had")
    }
}
