import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsVoiceLibraryTests: XCTestCase {
    func testProjectVoicesOpensWithoutSelectingAMeeting() {
        let request = MeetingsRequest.parse(["--place", "voices:Orchard"])
        XCTAssertNotNil(request.place)
        XCTAssertNil(request.meeting)
        XCTAssertNotEqual(request.place, .project("Orchard"))
    }

    func testSameNamedOwnersAndTheirSampleIDsSurviveListing() throws {
        let json = #"""
        {"people":[
          {"project":"Orchard","person":"Aster","owner":{"name":"Aster","email":"one@example.test"},"meetings":["one"],
           "samples":[{"id":"vs_unchanged","sample":1,"meeting":"one","seat":"mic","track":"source-mic","fromSec":4,"toSec":7,
                       "confirmedAt":"2026-01-01T00:00:00Z","words":"First clip","available":false}]},
          {"project":"Orchard","person":"Aster","owner":{"name":"Aster","email":"two@example.test"},"meetings":["two"],"samples":[]}]}
        """#
        let result = try JSONDecoder().decode(MeetingsAPI.VoicesList.Result.self, from: Data(json.utf8))
        XCTAssertNotEqual(result.people[0].id, result.people[1].id)
        let clip = try XCTUnwrap(result.people[0].samples.first)
        XCTAssertEqual(String(describing: clip.id), "vs_unchanged")
        XCTAssertFalse(clip.available)
    }
}
