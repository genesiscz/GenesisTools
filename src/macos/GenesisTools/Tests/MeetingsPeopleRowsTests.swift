import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsPeopleRowsTests: XCTestCase {
    func testT9SeatGroupsAndUnknownIndicatorCoverage() throws {
        let record = try JSONDecoder().decode(MeetingRecordView.self, from: Data(#"{"id":"copy","title":"Practice","labels":[],"start":"2026-01-01T00:00:00Z","items":[],"context":[],"speakers":{"labels":{}},"sources":{},"participants":[{"name":"Alice Example"},{"name":"Bob Example"},{"name":"Dana Example"}],"seats":{"room":["Alice Example"],"remote":[{"name":"Dana Example"}],"microphones":[{"id":"self","people":["Alice Example"]},{"id":"desk","label":"Desk microphone","people":["Bob Example"]}]},"evidence":{"indicator":[{"tSec":1,"speaking":["Dana Example"],"speakingUnknown":true},{"tSec":2,"speaking":["Bob Example"],"muted":["Dana Example"]}]}}"#.utf8))
        let groups = PresenceGroup.make(record)
        XCTAssertEqual(groups.map(\.title), ["Room", "Via Desk microphone", "Remote"])
        XCTAssertEqual(groups.flatMap { $0.people.map(\.id) }, ["Alice Example", "Bob Example", "Dana Example"])
        XCTAssertEqual(groups[2].people[0].reads.map(\.tSec), [2])
        XCTAssertTrue(PresenceGroup.make(nil).isEmpty)
        var unseated = record; unseated.seats = nil; XCTAssertEqual(PresenceGroup.make(unseated).map(\.title), ["Unknown seat"])
        try picture(VStack(alignment: .leading) { ForEach(groups) { group in
            Text(group.title)
            ForEach(group.people) { row in PresencePersonRow(row: row, duration: 90, edit: { _ in }) }
        } }, "T9-X2-X3-X22")
    }
    func testX2X22IndependentJoinAndLeaveSourcesAndOldRecords() throws {
        let stay = try JSONDecoder().decode(MeetingRecordView.Person.Stay.self, from: Data(#"{"fromSec":1,"toSec":4,"source":"attendance","leaveSource":"voice"}"#.utf8))
        XCTAssertEqual(stay.source, "attendance"); XCTAssertEqual(stay.leaveSource, "voice")
        XCTAssertNotEqual(ListenPresenceStrip.sourceSymbol(stay.source), ListenPresenceStrip.sourceSymbol(stay.leaveSource))
        XCTAssertNil(try JSONDecoder().decode(MeetingRecordView.Person.Stay.self, from: Data(#"{"fromSec":1,"source":"hand"}"#.utf8)).leaveSource)
        XCTAssertEqual(ListenPresenceStrip.sourceSymbol(nil), "questionmark.circle")
        let person = MeetingRecordView.Person(name: "Alice Example", stays: [stay, .init(fromSec: 9, toSec: 12, source: "hand", leaveSource: "indicator")])
        XCTAssertEqual(ListenPresenceStrip.spans(person, duration: 20), [1...4, 9...12])
        try picture(PresencePersonRow(row: .init(person: person), duration: 20, edit: { _ in }), "X2-X22-stays")
    }
    func testX3BothHandlesClampAndClockInputValidates() {
        XCTAssertEqual(PresencePersonRow.dragged(10...30, join: true, delta: -50, duration: 60), 0...30)
        XCTAssertEqual(PresencePersonRow.dragged(10...30, join: false, delta: 80, duration: 60), 10...60)
        XCTAssertEqual(PresencePersonRow.dragged(10...30, join: true, delta: 40, duration: 60), 30...30)
        XCTAssertEqual(ListenPresenceStrip.window(from: "01:02", to: "1:02:03", duration: 4000), 62...3723)
        XCTAssertEqual(ListenPresenceStrip.window(from: ListenPresenceStrip.clock(1.5), to: "4", duration: 10), 1.5...4)
        for value in ["1:90", "nan", "-1", "1::2", "inf"] { XCTAssertNil(ListenPresenceStrip.window(from: value, to: "90", duration: 100)) }
        XCTAssertNil(ListenPresenceStrip.window(from: "20", to: "10", duration: 100))
    }
    func testC11WarningSurvivesWithoutWindowSuggestAndC13KeepsEngineSentence() {
        XCTAssertEqual(MeetingPeopleChip.peopleWarnings(attendance: "Attendance not found", suggested: []), ["Attendance not found"])
        XCTAssertEqual(MeetingPeopleChip.peopleWarnings(attendance: "Attendance not found", suggested: ["Attendance not found"]), ["Attendance not found"])
        XCTAssertEqual(asFailure(MeetingsCLI.Failure(sentence: "Join must precede leave", detail: "engine")).sentence, "Join must precede leave")
    }
    func testC22OnlyExceptionalServiceStateHasANotice() {
        XCTAssertNil(MeetingsRootView.serviceFailure(.socket("fixture"), readFailure: nil))
        XCTAssertNil(MeetingsRootView.serviceFailure(.some(.none), readFailure: nil))
        XCTAssertTrue(MeetingsRootView.serviceFailure(.otherCheckout("/fixture/other"), readFailure: nil)?.detail.contains("/fixture/other") == true)
        XCTAssertNotNil(MeetingsRootView.serviceFailure(.some(.none), readFailure: .init(sentence: "Read failed", detail: "engine")))
    }
    func testL2X15PartStartsHaveACutSeparateFromTheirPin() throws {
        let row = try JSONDecoder().decode(ReviewRow.self, from: Data(#"{"id":"q","label":"Q1","kind":"question","status":"suggested","what":"Who says \"Practice\"?","parts":[{"kind":"when","from":{"sec":12,"text":"00:12"},"target":{"kind":"range","fromSec":12,"toSec":16}}],"choices":[],"edit":"answer","sources":[],"target":{"kind":"item","id":"q"}}"#.utf8))
        let pin = try XCTUnwrap(TimelinePin(row: row))
        XCTAssertTrue(pin.isCut); XCTAssertEqual(pin.sec, 12)
        XCTAssertFalse(TimelinePin(id: "term", sec: 12, text: "Word", state: .open).isCut)
        let state = TimelineDockState(meetingTitle: "Practice", moments: [], isPlaying: false, span: nil, zoom: .meeting, view: 0...30, durationSec: 30, wholePeaks: [], zoomPeaks: [0.2, 0.5, 0.8], zoomPeaksRange: 0...30, pins: [pin], offerMore: false)
        try picture(TimelineDockBody(state: state, position: { nil }), "L2-X15-cuts")
    }
    private func picture<V: View>(_ view: V, _ name: String) throws {
        guard let folder = ProcessInfo.processInfo.environment["MEETINGS_P11_SHOTS"] else { return }
        let host = NSHostingView(rootView: view.padding(12).frame(width: 600).background(Color(white: 0.12)).environment(\.colorScheme, .dark))
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 600, height: 220), styleMask: [.borderless], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false; panel.contentView = host; panel.orderInForSnapshot()
        defer { panel.orderOut(nil); panel.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.2)); host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds)); host.cacheDisplay(in: host.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + ".png"))
    }
}
