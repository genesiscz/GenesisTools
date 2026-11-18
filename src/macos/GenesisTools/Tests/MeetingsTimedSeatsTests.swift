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
        XCTAssertEqual(draft.roomJoins, ["", "01:00"])
        XCTAssertEqual(draft.roomLeaves, ["", "02:00"])
        XCTAssertNil(draft.problem)
        let saved = try JSONEncoder().encode(draft.parsed)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        let room = try XCTUnwrap(rows["room"] as? [Any])
        XCTAssertEqual(room[0] as? String, "Reed Example")
        let interval = try XCTUnwrap(room[1] as? [String: Any])
        XCTAssertEqual(interval["name"] as? String, "Fern Example")
        XCTAssertEqual(interval["fromSec"] as? Double, 60)
        XCTAssertEqual(interval["toSec"] as? Double, 120)
        let reopened = try JSONDecoder().decode(MeetingSeats.self, from: saved)
        XCTAssertEqual(reopened.remote.map(\.fromSec), [nil, 150, 5])
        XCTAssertEqual(reopened.remote.map(\.toSec), [60, nil, nil])
        XCTAssertEqual(reopened.remote[1].label, "Guest")
        XCTAssertEqual(reopened.microphones, [.init(id: "self", people: ["Reed Example", "Fern Example"])])
        draft.roomLeaves[1] = "2:05"
        XCTAssertEqual(draft.parsed.roomRows[1].toSec, 125)
        draft.roomJoins[1] = "0:59"
        XCTAssertNotNil(draft.problem)
        draft.roomJoins[1] = "1:00"
        draft.leaves[0] = "1:01"
        XCTAssertNotNil(draft.problem)
        draft.leaves[0] = "1:00"
        draft.removeRemote(at: 0)
        XCTAssertEqual(draft.parsed.remote.map(\.name), ["Fern Example", "Ash Example"])
        XCTAssertEqual(draft.parsed.microphones, reopened.microphones)
        draft.seatRemote("Fern Example", additionalInterval: true)
        draft.joins[2] = "0:05"
        draft.leaves[2] = "0:55"
        XCTAssertNil(draft.problem)
        XCTAssertEqual(draft.parsed.remote[2].fromSec, 5)
        XCTAssertEqual(draft.parsed.roomRows[1].toSec, 125)
    }

    func testNewEmptyRemoteIntervalCannotBeSaved() throws {
        let old = try JSONDecoder().decode(MeetingSeats.self, from: Data(#"{"remote":[{"name":"Ash Example","fromSec":20,"toSec":20}]}"#.utf8))
        XCTAssertNil(old.intervalProblem(allowEmptyRemote: true))
        var draft = MeetingSeatsDraft(MeetingSeats(remote: [.init(name: "Ash Example", fromSec: 20)]))
        draft.leaves[0] = "0:20"
        XCTAssertNotNil(draft.problem)
    }
}
