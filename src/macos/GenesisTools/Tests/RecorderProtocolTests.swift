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
            // A live recording's own control calls (pause, marker.add) and its register and event messages to the
            // service are the recording's protocol, checked by RecorderControl on the TypeScript side; the host never
            // sees them.
            if let direction = example["direction"] as? String, direction.contains("recording→") || direction.contains("→recording") {
                continue
            }
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

/// The golden fixture TypeScript writes (`editor-golden.json`, scripts/recorder/write-protocol-fixtures.ts): its ops and
/// edits read here and write back as TypeScript wrote them, the Swift op enum names every zod op tag, and every service
/// method the editor window calls is one the live service's `hello` lists.
final class RecorderGoldenTests: XCTestCase {
    private func golden() throws -> [String: Any] { try RecorderFixtures.object("editor-golden.json") }

    /// A JSON value as Foundation reads it, so two writers' numbers (2 and 2.0) and key orders compare equal.
    private func json(_ data: Data) throws -> NSObject {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) as? NSObject)
    }

    func testEveryGoldenOpDecodesAndWritesBackAsTheTypeScriptSideWroteIt() throws {
        let ops = try XCTUnwrap(golden()["ops"] as? [[String: Any]])
        XCTAssertGreaterThan(ops.count, 50)
        for op in ops {
            let written = try JSONSerialization.data(withJSONObject: op)
            let decoded = try JSONDecoder().decode(EditOp.self, from: written)
            XCTAssertEqual(decoded.tag, op["op"] as? String)
            XCTAssertEqual(try json(JSONEncoder().encode(decoded)), try json(written), "\(op["op"] ?? "?") reads and writes back unchanged")
        }
    }

    func testEveryGoldenEditDecodesAndWritesBackUnchanged() throws {
        let projects = try XCTUnwrap(golden()["projects"] as? [[String: Any]])
        // At least the four first edits; round 4's effects add their own.
        XCTAssertGreaterThanOrEqual(projects.count, 4)
        for entry in projects {
            let name = try XCTUnwrap(entry["name"] as? String)
            let written = try JSONSerialization.data(withJSONObject: try XCTUnwrap(entry["project"]))
            let decoded = try EditProject.decode(written)
            XCTAssertNil(Self.difference(try json(decoded.encoded()), try json(written)), name)
        }
    }

    /// The first path where two JSON values differ ("camera.hidden[1].lane: nil against \"lane4\""), or nil.
    private static func difference(_ swift: Any?, _ typescript: Any?, at path: String = "") -> String? {
        switch (swift, typescript) {
        case let (a as [String: Any], b as [String: Any]):
            for key in Set(a.keys).union(b.keys).sorted() {
                if let found = difference(a[key], b[key], at: path.isEmpty ? key : "\(path).\(key)") { return found }
            }
            return nil
        case let (a as [Any], b as [Any]):
            guard a.count == b.count else { return "\(path): \(a.count) items against \(b.count)" }
            for (index, pair) in zip(a, b).enumerated() {
                if let found = difference(pair.0, pair.1, at: "\(path)[\(index)]") { return found }
            }
            return nil
        case let (a as NSNumber, b as NSNumber):
            // A boolean is a boolean on both sides; a number may come back as a decimal of the same double.
            let boolean = CFBooleanGetTypeID()
            let flags = (CFGetTypeID(a) == boolean, CFGetTypeID(b) == boolean)
            if flags.0 || flags.1 {
                return flags.0 && flags.1 && a == b ? nil : "\(path): Swift writes \(a) where TypeScript wrote \(b)"
            }
            return abs(a.doubleValue - b.doubleValue) <= 1e-12 * max(1, abs(b.doubleValue)) ? nil : "\(path): Swift writes \(a) where TypeScript wrote \(b)"
        case let (a as NSObject, b as NSObject):
            return a == b ? nil : "\(path): Swift writes \(a) where TypeScript wrote \(b)"
        case (nil, nil):
            return nil
        default:
            return "\(path): Swift writes \(swift.map { "\($0)" } ?? "nothing") where TypeScript wrote \(typescript.map { "\($0)" } ?? "nothing")"
        }
    }

    /// The comparison the golden edits lean on finds a real difference: a key one side lacks, another number, a boolean
    /// written as a number, a list of another length; and it lets the same double printed two ways through.
    func testTheGoldenComparisonNamesTheFirstDifference() throws {
        let typescript = try json(Data(#"{"a":0.035,"b":{"c":[1,2]},"d":true}"#.utf8))
        XCTAssertNil(Self.difference(try json(Data(#"{"a":0.035000000000000003,"b":{"c":[1,2.0]},"d":true}"#.utf8)), typescript))
        XCTAssertEqual(Self.difference(try json(Data(#"{"a":0.035,"b":{"c":[1,2]}}"#.utf8)), typescript),
                       "d: Swift writes nothing where TypeScript wrote 1")
        XCTAssertNotNil(Self.difference(try json(Data(#"{"a":0.036,"b":{"c":[1,2]},"d":true}"#.utf8)), typescript))
        XCTAssertNotNil(Self.difference(try json(Data(#"{"a":0.035,"b":{"c":[1,2]},"d":1}"#.utf8)), typescript))
        XCTAssertEqual(Self.difference(try json(Data(#"{"a":0.035,"b":{"c":[1]},"d":true}"#.utf8)), typescript),
                       "b.c: 1 items against 2")
    }

    func testTheSwiftOpEnumNamesEveryZodOpTagOneForOne() throws {
        let tags = try XCTUnwrap(golden()["opTags"] as? [String])
        XCTAssertEqual(EditOp.tags.sorted(), tags.sorted())
        XCTAssertEqual(Set(EditOp.tags).count, EditOp.tags.count, "one case per tag")
    }

    /// Reads the editor's sources for the service methods it names: `movie("<name>"`, `ask("<name>"`,
    /// `commentCall("<name>"` (the REPL's `movie.<name>`), and every `"session.…"`, `"edit.…"` or `"gesture.…"` literal.
    func testEveryServiceMethodTheEditorWindowCallsIsOneThatHelloLists() throws {
        let methods = Set(try XCTUnwrap(golden()["methods"] as? [String]))
        let editor = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/Parts/Recorder/Editor")
        let files = try FileManager.default.contentsOfDirectory(at: editor, includingPropertiesForKeys: nil).filter { $0.pathExtension == "swift" }
        let repl = try NSRegularExpression(pattern: #"\b(?:movie|ask|commentCall)\((?:\w+ \? )?"(\w+)"(?: : "(\w+)")?"#)
        let own = try NSRegularExpression(pattern: #""((?:session|edit|gesture)\.[A-Za-z]+)""#)
        var called = Set<String>()
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            let range = NSRange(text.startIndex..., in: text)
            for match in repl.matches(in: text, range: range) {
                for group in 1...2 {
                    if let found = Range(match.range(at: group), in: text) { called.insert("movie.\(text[found])") }
                }
            }
            for match in own.matches(in: text, range: range) {
                if let found = Range(match.range(at: 1), in: text) { called.insert(String(text[found])) }
            }
        }
        // The reading itself works: these are calls the window certainly makes.
        for known in ["session.open", "session.close", "edit.apply", "edit.undo", "edit.redo", "gesture.begin", "gesture.preview",
                      "gesture.commit", "gesture.cancel", "movie.switchDisplay", "movie.undoDisplaySwitch", "movie.redoDisplaySwitch",
                      "movie.comment", "movie.findOnScreen"] {
            XCTAssertTrue(called.contains(known), "the source scan found no \(known)")
        }
        XCTAssertEqual(called.subtracting(methods).sorted(), [], "methods the window calls that the service does not list")
    }
}
