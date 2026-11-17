import Foundation
import XCTest
@testable import GenesisToolsHost

@MainActor
final class RequestPresentTests: XCTestCase {
    static var fixtureURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../utils/genesis-tools/service/__fixtures__/wire.json").standardizedFileURL
    }
    static func request() throws -> RequestPresentParams {
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [[String: Any]] ?? []
        let row = try XCTUnwrap(rows.first { $0["method"] as? String == "request.present" })
        return try JSONDecoder().decode(RequestPresentParams.self, from: JSONSerialization.data(withJSONObject: row["params"]!))
    }
    func testAllGeneratedWireFixturesDecode() throws {
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtureURL)) as? [[String: Any]])
        XCTAssertGreaterThan(rows.count, 20)
        for row in rows {
            let method = try XCTUnwrap(row["method"] as? String)
            let params = try JSONSerialization.data(withJSONObject: row["params"]!, options: [.fragmentsAllowed])
            let result = try JSONSerialization.data(withJSONObject: row["result"]!, options: [.fragmentsAllowed])
            XCTAssertNoThrow(try GenesisToolsRPC.validateFixture(method: method, params: params, result: result), method)
        }
    }
    func testGeneratedLiteralRejectsTheOppositeBoolean() throws {
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtureURL)) as? [[String: Any]])
        let row = try XCTUnwrap(rows.first { $0["method"] as? String == "config.set" })
        let params = try JSONSerialization.data(withJSONObject: row["params"]!)
        XCTAssertThrowsError(try GenesisToolsRPC.validateFixture(method: "config.set", params: params, result: Data("{\"changed\":false}".utf8)))
    }

    func testNoticeWordsAndAnswersUseTheSharedApprovalModel() throws {
        let request = try Self.request()
        let model = RequestWindowContent.build(request)
        XCTAssertEqual(model.title, request.title)
        XCTAssertEqual(model.purpose, request.reason)
        XCTAssertEqual(model.allowTitle, "Acknowledge")
        XCTAssertNil(model.verifier)
        XCTAssertEqual(model.deadlineLabel, "Stops waiting in ")
        var allows = 0
        model.onAllow = { _ in allows += 1 }
        model.allow(); model.allow(); model.deny()
        XCTAssertEqual(allows, 1)
    }
}
