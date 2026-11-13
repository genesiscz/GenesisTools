import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The protocol fixture TypeScript writes (src/meetings/lib/service/__fixtures__/meetings-protocol.json): its library
/// examples (projects, dictionary, config.edit, tone.presets) decode with the types of MeetingsAPI+Library.swift.
private enum LibraryFixture {
    static var url: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("meetings/lib/service/__fixtures__/meetings-protocol.json")
    }

    static func examples() throws -> [[String: Any]] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return try XCTUnwrap(root["examples"] as? [[String: Any]])
    }
}

final class MeetingsLibraryAPITests: XCTestCase {
    private static let review = "2026-11-03-1000-design-review"

    /// The params decode as the Swift type and encode back to the same object.
    private func roundTrip<P: Codable>(_ type: P.Type, _ params: [String: Any], _ label: String) throws {
        let typed = try MeetingsService.decode(P.self, params)
        let encoded = try MeetingsService.paramsObject(typed)
        XCTAssertTrue(NSDictionary(dictionary: encoded).isEqual(to: params), "\(label): \(encoded) is not \(params)")
    }

    private static let methods = [
        MeetingsAPI.ProjectsAdd.name, MeetingsAPI.ProjectsRename.name, MeetingsAPI.ProjectsRemove.name,
        MeetingsAPI.ProjectsLabels.name, MeetingsAPI.ProjectsUnpair.name, MeetingsAPI.ProjectsPreview.name,
        MeetingsAPI.DictionaryShowEntries.name, MeetingsAPI.DictionaryAdd.name, MeetingsAPI.DictionaryRemove.name,
        MeetingsAPI.DictionaryTest.name, MeetingsAPI.ConfigEdit.name, MeetingsAPI.TonePresets.name,
    ]

    func testEveryLibraryExampleDecodesWithTheSwiftTypes() throws {
        var decoded: [String: Int] = [:]
        var refusals: [String] = []
        for example in try LibraryFixture.examples() {
            let method = try XCTUnwrap(example["method"] as? String)
            guard Self.methods.contains(method) else { continue }
            let params = (example["request"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
            let reply = example["reply"] as? [String: Any]
            let result = reply?["result"]
            let label = "\(method) (\(example["note"] as? String ?? "plain"))"
            switch method {
            case MeetingsAPI.ProjectsAdd.name:
                try roundTrip(MeetingsAPI.ProjectsAdd.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ProjectsAdd.Result.self, result), .init(name: "Atlas", added: true)) }
            case MeetingsAPI.ProjectsRename.name:
                try roundTrip(MeetingsAPI.ProjectsRename.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ProjectsRename.Result.self, result).meetings, [Self.review]) }
            case MeetingsAPI.ProjectsRemove.name:
                try roundTrip(MeetingsAPI.ProjectsRemove.Params.self, params, label)
                if let result {
                    let removal = try MeetingsService.decode(MeetingsAPI.ProjectsRemove.Result.self, result)
                    XCTAssertEqual(removal.unassigned, [Self.review])
                    XCTAssertTrue(removal.backup.hasSuffix("-project-Harbor.json"), removal.backup)
                }
            case MeetingsAPI.ProjectsLabels.name:
                try roundTrip(MeetingsAPI.ProjectsLabels.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ProjectsLabels.Result.self, result).labels, ["Checkout"]) }
            case MeetingsAPI.ProjectsUnpair.name:
                try roundTrip(MeetingsAPI.ProjectsUnpair.Params.self, params, label)
                if let result {
                    let removed = try MeetingsService.decode(MeetingsAPI.ProjectsUnpair.Result.self, result).removed
                    if params["entry"] != nil {
                        XCTAssertEqual(removed, [.init(project: "Atlas", name: "Alex Example", email: "alex@example.com", left: true)])
                    } else {
                        XCTAssertEqual(removed, [], label)
                    }
                }
            case MeetingsAPI.ProjectsPreview.name:
                try roundTrip(MeetingsAPI.ProjectsPreview.Params.self, params, label)
                if let result {
                    let rows = try MeetingsService.decode(MeetingsAPI.ProjectsPreview.Result.self, result)
                    XCTAssertEqual(rows.map(\.id), ["2026-11-03-1400-retro", Self.review])
                    XCTAssertEqual(rows.first?.draft, ["Atlas"], "the draft's title word matches the retro")
                }
            case MeetingsAPI.DictionaryShowEntries.name:
                try roundTrip(MeetingsAPI.DictionaryShowEntries.Params.self, params, label)
                if let result {
                    let shown = try MeetingsService.decode(MeetingsAPI.DictionaryShowEntries.Result.self, result)
                    XCTAssertEqual(shown.entries.map(\.level), ["project Atlas"])
                }
            case MeetingsAPI.DictionaryAdd.name:
                try roundTrip(MeetingsAPI.DictionaryAdd.Params.self, params, label)
                if let result {
                    let added = try MeetingsService.decode(MeetingsAPI.DictionaryAdd.Result.self, result)
                    XCTAssertEqual(added.entry, SavedDictionaryEntry(type: "fix", value: "Atlass", substitution: "Atlas"))
                    XCTAssertEqual(added.level, "project Atlas")
                }
            case MeetingsAPI.DictionaryRemove.name:
                try roundTrip(MeetingsAPI.DictionaryRemove.Params.self, params, label)
                if let result { XCTAssertTrue(try MeetingsService.decode(MeetingsAPI.DictionaryRemove.Result.self, result).removed) }
            case MeetingsAPI.DictionaryTest.name:
                try roundTrip(MeetingsAPI.DictionaryTest.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.DictionaryTest.Result.self, result).text, "The Atlas page") }
            case MeetingsAPI.ConfigEdit.name:
                try roundTrip(MeetingsAPI.ConfigEdit.Params.self, params, label)
                if let result {
                    let changes = try MeetingsService.decode(MeetingsAPI.ConfigEdit.Result.self, result)
                    XCTAssertEqual(changes.map(\.path), [["sources", "wisprflow", "match", "Atlas", "folders"],
                                                         ["projects", "Atlas", "match", "title", "words"]])
                    XCTAssertEqual(changes.last?.value, .array([.string("review")]))
                }
            case MeetingsAPI.TonePresets.name:
                try roundTrip(MeetingsAPI.TonePresets.Params.self, params, label)
                if let result {
                    let presets = try MeetingsService.decode(MeetingsAPI.TonePresets.Result.self, result).presets
                    XCTAssertEqual(presets.prefix(3).map(\.name), ["beep", "soft", "click"])
                    XCTAssertEqual(presets.first, .init(name: "beep", label: "Beep", kind: "sine", volume: 0.6, hz: 880, sec: 0.15,
                                                        file: nil, available: true))
                    XCTAssertTrue(presets.contains { $0.kind == "file" && $0.file == "/System/Library/Sounds/Tink.aiff" })
                }
            default:
                continue
            }
            if let error = reply?["error"] as? [String: Any], (error["code"] as? NSNumber)?.intValue == MeetingsAPI.refusedCode {
                let data = try XCTUnwrap(error["data"], "\(label): a refusal names its code")
                refusals.append(try MeetingsService.decode(MeetingsAPI.ErrorData.self, data).code)
            }
            decoded[method, default: 0] += 1
        }
        for method in Self.methods {
            XCTAssertGreaterThan(decoded[method] ?? 0, 0, "the fixture has an example of \(method)")
        }
        // An Undo's add of an entry made again since, and a project meetings still have.
        XCTAssertEqual(Set(refusals), ["dictionary-exists", "project-in-use"])
    }

    /// The service lists every library method in its hello, so the window can call them.
    func testTheHelloListsTheLibraryMethods() throws {
        let hello = try XCTUnwrap(try LibraryFixture.examples().first {
            $0["method"] as? String == MeetingsAPI.Hello.name && ($0["reply"] as? [String: Any])?["result"] != nil
        })
        let result = try XCTUnwrap((hello["reply"] as? [String: Any])?["result"])
        let methods = Set(try MeetingsService.decode(MeetingsAPI.Hello.Result.self, result).methods)
        XCTAssertTrue(Set(Self.methods).isSubset(of: methods), "missing: \(Set(Self.methods).subtracting(methods))")
    }

    /// A tone setting writes only its own members (the schema is strict), and reads every version 5 shape.
    func testAToneSoundSettingRoundTripsEachShape() throws {
        let settings: [(MeetingsAPI.ToneSoundSetting, [String: Any])] = [
            (.sine(hz: 440, sec: 0.2, volume: 0.5), ["hz": 440, "sec": 0.2, "volume": 0.5]),
            (.preset("soft", volume: nil), ["preset": "soft"]),
            (.preset("tink", volume: 0.3), ["preset": "tink", "volume": 0.3]),
            (.file("/sounds/chime.wav", volume: nil), ["file": "/sounds/chime.wav"]),
        ]
        for (setting, object) in settings {
            let encoded = try MeetingsService.paramsObject(setting)
            XCTAssertTrue(NSDictionary(dictionary: encoded).isEqual(to: object), "\(encoded) is not \(object)")
            XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ToneSoundSetting.self, object), setting)
        }
        // A version 4 sine with a member left out reads with the engine's defaults.
        XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ToneSoundSetting.self, ["hz": 523]),
                       .sine(hz: 523, sec: 0.15, volume: 0.6))
    }

    /// `expect: null` (the page read nothing there) stays apart from no expect (no check), both ways.
    func testAConfigEditKeepsANullExpectApartFromNone() throws {
        let guarded = MeetingsAPI.ConfigEdit.Edit(path: "global.assign.ask", value: .bool(false), expect: .null)
        let plain = MeetingsAPI.ConfigEdit.Edit(path: "global.assign.ask", unset: true)
        let encoded = try MeetingsService.paramsObject(MeetingsAPI.ConfigEdit.Params(edits: [guarded, plain]))
        let edits = try XCTUnwrap(encoded["edits"] as? [[String: Any]])
        XCTAssertTrue(edits[0]["expect"] is NSNull, "a null expect is sent")
        XCTAssertNil(edits[1]["expect"], "no expect is left out")
        XCTAssertNil(edits[1]["value"], "an unset sends no value")
        let decoded = try MeetingsService.decode(MeetingsAPI.ConfigEdit.Params.self, encoded)
        XCTAssertEqual(decoded.edits, [guarded, plain])
    }
}
