import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsTimedSeatsTests: XCTestCase {
    func testEditingAnotherSeatPreservesLegacyRoomGroupAndDisjointStays() throws {
        let data = Data(#"""
        {"room":["Reed Example",{"name":"Fern Example","fromSec":60,"toSec":120}],
         "remote":[{"name":"Fern Example","toSec":60},{"name":"Fern Example","fromSec":150,"label":"Guest"},"Ash Example"],
         "microphones":[{"id":"self","people":["Reed Example","Fern Example"]}]}
        """#.utf8)
        var draft = MeetingSeatsDraft(try JSONDecoder().decode(MeetingSeats.self, from: data))
        draft.joins[2] = "0:05"
        XCTAssertNil(draft.problem)
        let saved = try JSONEncoder().encode(draft.parsed)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        let room = try XCTUnwrap(rows["room"] as? [Any])
        XCTAssertEqual(room[0] as? String, "Reed Example")
        XCTAssertEqual(room[1] as? NSDictionary, ["name": "Fern Example", "fromSec": 60, "toSec": 120])
        let reopened = try JSONDecoder().decode(MeetingSeats.self, from: saved)
        XCTAssertEqual(reopened.remote.map(\.fromSec), [nil, 150, 5])
        XCTAssertEqual(reopened.remote.map(\.toSec), [60, nil, nil])
        XCTAssertEqual(reopened.remote[1].label, "Guest")
        XCTAssertEqual(reopened.microphones, [.init(id: "self", people: ["Reed Example", "Fern Example"])])
        draft.leaves[0] = "1:01"
        XCTAssertNotNil(draft.problem)
        draft.leaves[0] = "1:00"
        draft.removeRemote(at: 0)
        XCTAssertEqual(draft.parsed.remote.map(\.name), ["Fern Example", "Ash Example"])
        XCTAssertEqual(draft.parsed.microphones, reopened.microphones)
    }

    func testNewEmptyRemoteIntervalCannotBeSaved() {
        var draft = MeetingSeatsDraft(MeetingSeats(remote: [.init(name: "Ash Example", fromSec: 20)]))
        draft.leaves[0] = "0:20"
        XCTAssertNotNil(draft.problem)
    }
}
