import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// The fixtures TypeScript writes for this side: `src/recorder/lib/__fixtures__/*.json`.
enum RecorderFixtures {
    static func url(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("recorder/lib/__fixtures__/\(name)")
    }

    static func object(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url(name))) as? [String: Any], name)
    }

    /// `service-protocol.json`'s examples: one real request and reply (or notification) per method.
    static func examples() throws -> [[String: Any]] {
        try XCTUnwrap(object("service-protocol.json")["examples"] as? [[String: Any]])
    }

    /// The JSON Schema of `kind` ("params", "results" or "notifications") for one method or notification.
    struct Schemas {
        let root: [String: Any]

        init() throws { root = try RecorderFixtures.object("service-protocol.schemas.json") }

        func check(_ value: Any?, _ kind: String, _ name: String) throws -> [String] {
            let document = try XCTUnwrap(root[kind] as? [String: Any], kind)
            let schema = try XCTUnwrap((document["properties"] as? [String: Any])?[name], "\(kind) of \(name)")
            return JSONSchemaCheck(root: document).problems(value, schema)
        }
    }
}

/// The two halves agree: every example the TypeScript service wrote decodes with this side's types, and the schemas
/// the zod source makes accept what the examples hold (so the checker is proven on real data before the host tests
/// lean on it).
final class RecorderProtocolTests: XCTestCase {
    func testEveryFixtureExampleDecodesWithTheSwiftTypes() throws {
        var decoded: [String: Int] = [:]
        for example in try RecorderFixtures.examples() {
            let method = try XCTUnwrap(example["method"] as? String)
            let request = example["request"] as? [String: Any]
            let params = (request?["params"] ?? (example["notification"] as? [String: Any])?["params"]) as? [String: Any]
            let result = (example["reply"] as? [String: Any])?["result"]
            if let ops = params?["ops"] as? [Any] {
                let typed = try RecorderProtocol.decode([EditOp].self, from: ops)
                XCTAssertEqual(try Self.normalized(EditOp.objects(typed)), try Self.normalized(ops), "\(method)'s ops round-trip")
                decoded["ops", default: 0] += 1
            }
            switch (method, result) {
            case let ("hello", result?):
                let hello = try RecorderProtocol.decode(RecorderProtocol.HelloAnswer.self, from: result)
                XCTAssertEqual(hello.protocolVersion, 1)
                XCTAssertTrue(hello.methods.contains("edit.apply"))
            case let ("session.open", result?):
                let opened = try RecorderProtocol.decode(RecorderProtocol.OpenedSession.self, from: result)
                XCTAssertEqual(opened.project.revision, opened.revision)
                XCTAssertFalse(opened.project.clips.isEmpty)
            case let ("edit.apply", result?), let ("edit.undo", result?), let ("edit.redo", result?), let ("gesture.commit", result?):
                let answer = try RecorderProtocol.decode(RecorderProtocol.EditAnswer.self, from: result)
                XCTAssertEqual(answer.project.revision, answer.revision, method)
            case let ("gesture.begin", result?), let ("gesture.preview", result?), let ("gesture.cancel", result?):
                _ = try RecorderProtocol.decode(RecorderProtocol.GestureAnswer.self, from: result)
            case let ("window.list", result?):
                _ = try RecorderProtocol.decode(RecorderProtocol.WindowState.self, from: result)
            case ("project.changed", _):
                let changed = try RecorderProtocol.decode(RecorderProtocol.ProjectChanged.self, from: params)
                XCTAssertTrue(changed.path.hasSuffix(".json"))
            case ("window.changed", _):
                _ = try RecorderProtocol.decode(RecorderProtocol.WindowState.self, from: params)
            default:
                continue
            }
            decoded[method, default: 0] += 1
        }
        for method in ["hello", "session.open", "edit.apply", "edit.undo", "edit.redo", "gesture.begin", "gesture.preview",
                       "gesture.commit", "gesture.cancel", "project.changed", "window.changed", "window.list", "ops"] {
            XCTAssertGreaterThan(decoded[method] ?? 0, 0, "the fixture has a \(method) this test decodes")
        }
    }

    func testTheSchemasAcceptEveryExampleTheTypeScriptServiceWrote() throws {
        let schemas = try RecorderFixtures.Schemas()
        var checked = 0
        for example in try RecorderFixtures.examples() {
            let method = try XCTUnwrap(example["method"] as? String)
            guard !method.hasPrefix("movie"), !method.hasPrefix("$/") || example["notification"] != nil else { continue }
            if let notification = example["notification"] as? [String: Any] {
                XCTAssertEqual(try schemas.check(notification["params"], "notifications", method), [], method)
                checked += 1
                continue
            }
            if let params = (example["request"] as? [String: Any])?["params"] {
                XCTAssertEqual(try schemas.check(params, "params", method), [], "\(method) params")
                checked += 1
            }
            if let result = (example["reply"] as? [String: Any])?["result"] {
                XCTAssertEqual(try schemas.check(result, "results", method), [], "\(method) result")
                checked += 1
            }
        }
        XCTAssertGreaterThan(checked, 60)
    }

    /// The checker's negative control: an answer that lost a required field, took an unknown one, or carries a wrong
    /// type or value is caught.
    func testTheSchemaCheckerRefusesAnAnswerTheTypeScriptSideWouldRefuse() throws {
        let schemas = try RecorderFixtures.Schemas()
        let still: [String: Any] = ["ok": true, "path": "/r/still.png", "width": 320, "height": 200]
        XCTAssertEqual(try schemas.check(still, "results", "render.still"), [])
        var missing = still
        missing["width"] = nil
        XCTAssertEqual(try schemas.check(missing, "results", "render.still"), ["$.width: is required"])
        var extra = still
        extra["format"] = "png"
        XCTAssertEqual(try schemas.check(extra, "results", "render.still"), ["$.format: nothing is allowed here"])
        var wrong = still
        wrong["ok"] = false
        XCTAssertFalse(try schemas.check(wrong, "results", "render.still").isEmpty)
        XCTAssertFalse(try schemas.check(["opened": true, "window": 1.5], "results", "window.open").isEmpty, "a window number is an integer")
        XCTAssertFalse(try schemas.check(["role": "viewer", "protocol": 1, "pid": 4], "params", "hello").isEmpty)
    }

    private static func normalized(_ value: Any) throws -> NSObject {
        try XCTUnwrap(JSONSerialization.jsonObject(with: JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) as? NSObject)
    }
}
