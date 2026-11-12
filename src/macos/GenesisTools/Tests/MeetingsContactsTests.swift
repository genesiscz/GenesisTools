import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The people directory's mirrors, the person picker and the Contacts view (F10; R23, R24, R44).
/// Snapshots: `MEETINGS_PEOPLE_SHOTS=<folder>` renders every view there, light and dark.
@MainActor
final class MeetingsContactsTests: XCTestCase {
    // MARK: The mirrors against the protocol fixture

    private static var fixtureURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("meetings/lib/service/__fixtures__/meetings-protocol.json")
    }

    private func examples(_ prefix: String) throws -> [[String: Any]] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtureURL)) as? [String: Any])
        let all = try XCTUnwrap(root["examples"] as? [[String: Any]])
        return all.filter { ($0["method"] as? String)?.hasPrefix(prefix) == true }
    }

    private func roundTrip<P: Codable>(_ type: P.Type, _ params: [String: Any], _ label: String) throws {
        let typed = try MeetingsService.decode(P.self, params)
        let encoded = try MeetingsService.paramsObject(typed)
        XCTAssertTrue(NSDictionary(dictionary: encoded).isEqual(to: params), "\(label): \(encoded) is not \(params)")
    }

    func testEveryPeopleExampleOfTheFixtureDecodes() throws {
        var decoded: [String: Int] = [:]
        for example in try examples("people.") {
            let method = try XCTUnwrap(example["method"] as? String)
            let params = (example["request"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
            let reply = example["reply"] as? [String: Any]
            let result = reply?["result"]
            let label = "\(method) (\(example["note"] as? String ?? ""))"
            switch method {
            case MeetingsAPI.PeopleKnown.name:
                try roundTrip(MeetingsAPI.PeopleKnown.Params.self, params, label)
                if let result {
                    let known = try MeetingsService.decode(MeetingsAPI.PeopleKnown.Result.self, result)
                    XCTAssertEqual(known.people.map(\.name), ["Alex Example", "Dana Example"], label)
                    XCTAssertEqual(known.people.last?.isSelf, true, "\(label): self: true reads as isSelf")
                    XCTAssertEqual(known.people.first?.rank, .meeting)
                    XCTAssertEqual(known.sources.map(\.kind), [.meetings, .projects, .own, .contacts])
                }
            case MeetingsAPI.PeopleMeetings.name:
                try roundTrip(MeetingsAPI.PeopleMeetings.Params.self, params, label)
                if let result {
                    let history = try MeetingsService.decode(MeetingsAPI.PeopleMeetings.Result.self, result)
                    XCTAssertEqual(history.person.name, "Alex Example")
                    XCTAssertEqual(history.meetings.map(\.meeting), ["2026-11-03-1000-design-review"])
                    XCTAssertTrue(history.meetings.first?.roles.contains(.participant) == true)
                }
            case MeetingsAPI.PeopleAdd.name:
                try roundTrip(MeetingsAPI.PeopleAdd.Params.self, params, label)
                if let result {
                    let added = try MeetingsService.decode(MeetingsAPI.PeopleAdd.Result.self, result)
                    // Each example adds the person its request names (the fixture holds a second Robin since 57f8905bb4).
                    XCTAssertTrue(added.added, label)
                    XCTAssertEqual(added.person.id, "email:\(params["email"] as? String ?? "")", label)
                    XCTAssertEqual(added.entry.note, params["note"] as? String, label)
                }
            case MeetingsAPI.PeopleHide.name:
                try roundTrip(MeetingsAPI.PeopleHide.Params.self, params, label)
                if let result {
                    let hidden = try MeetingsService.decode(MeetingsAPI.PeopleHide.Result.self, result)
                    XCTAssertTrue(hidden.person.hidden, label)
                    XCTAssertTrue(hidden.changed, label)
                }
            case MeetingsAPI.PeoplePlanMerge.name:
                try roundTrip(MeetingsAPI.PeoplePlanMerge.Params.self, params, label)
                if let result {
                    let plan = try MeetingsService.decode(MeetingsAPI.PeoplePlanMerge.Result.self, result)
                    XCTAssertEqual(plan.people.count, 2)
                    XCTAssertEqual(plan.meetings.first?.as, [.participant, .speaker])
                    XCTAssertEqual(plan.labels.first?.label, "Speaker 2")
                }
            case MeetingsAPI.PeopleMerge.name:
                try roundTrip(MeetingsAPI.PeopleMerge.Params.self, params, label)
                if let result {
                    let merged = try MeetingsService.decode(MeetingsAPI.PeopleMerge.Result.self, result)
                    XCTAssertEqual(merged.merge.people.last?.email, "robin@example.com")
                    XCTAssertEqual(merged.plan.name, "Alex Example")
                }
            case MeetingsAPI.PeopleUnmerge.name:
                try roundTrip(MeetingsAPI.PeopleUnmerge.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.PeopleUnmerge.Result.self, result).merge.token.isEmpty) }
            default:
                continue
            }
            if let error = reply?["error"] as? [String: Any] {
                let data = try XCTUnwrap(error["data"], label)
                let code = try MeetingsService.decode(MeetingsAPI.ErrorData.self, data).code
                XCTAssertTrue(["unknown-person", "ambiguous-person", "unknown-merge"].contains(code), label)
            }
            decoded[method, default: 0] += 1
        }
        for method in [MeetingsAPI.PeopleKnown.name, MeetingsAPI.PeopleMeetings.name, MeetingsAPI.PeopleAdd.name, MeetingsAPI.PeopleHide.name,
                       MeetingsAPI.PeoplePlanMerge.name, MeetingsAPI.PeopleMerge.name, MeetingsAPI.PeopleUnmerge.name] {
            XCTAssertGreaterThan(decoded[method] ?? 0, 0, "the fixture has an example of \(method)")
        }
    }

    func testAPersonEncodesSelfAndHiddenOnlyWhenTrue() throws {
        let person = KnownPerson(id: "name:alex example", name: "Alex Example", sources: [.meetings], rank: .meeting)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(person)) as? [String: Any])
        XCTAssertNil(object["self"])
        XCTAssertNil(object["hidden"])
        let me = KnownPerson(id: "name:dana example", name: "Dana Example", isSelf: true, sources: [.meetings], rank: .present, hidden: true)
        let mine = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(me)) as? [String: Any])
        XCTAssertEqual(mine["self"] as? Bool, true)
        XCTAssertEqual(mine["hidden"] as? Bool, true)
    }

    // MARK: The picker's rules

    func testInitialsTakeTheFirstAndLastWordOrTheAddress() {
        XCTAssertEqual(Fixture.person("Dana Exámple").initials, "DE")
        XCTAssertEqual(Fixture.person("Robin van der Example").initials, "RE")
        XCTAssertEqual(Fixture.person("Kai").initials, "K")
        XCTAssertEqual(KnownPerson(id: "email:x", name: "", email: "x@example.com", sources: [.own], rank: .own).initials, "X")
    }

    func testAddNewSpeakerShowsOnlyForANameNobodyHas() {
        let people = [Fixture.person("Dana Exámple", aliases: ["Dana E."]), Fixture.person("Alex Example")]
        XCTAssertNil(PeopleText.newName("  ", people: people), "an empty field offers nobody new")
        XCTAssertNil(PeopleText.newName("dana example", people: people), "case and accents are folded")
        XCTAssertNil(PeopleText.newName("DANA E.", people: people), "an alias is a match")
        XCTAssertEqual(PeopleText.newName("Dana", people: people), "Dana", "a part of a name is a new name")
        XCTAssertEqual(PeopleText.newName("Jamie ", people: []), "Jamie")
        XCTAssertNil(PeopleText.newName("Dana", people: people, rule: .noResults), "noResults waits for an empty list")
    }

    func testTheRowSaysTheAddressElseWhereTheyWereSeen() {
        XCTAssertEqual(PeopleText.address(Fixture.person("Robin Example", email: "robin@example.com")), "robin@example.com")
        XCTAssertEqual(PeopleText.address(Fixture.person("Alex Example", meetings: 4)), "4 meetings")
        XCTAssertEqual(PeopleText.address(Fixture.person("Kai Example", meetings: 0, sources: [.contacts], rank: .contacts)), "Contacts")
    }

    func testARefusedSourceIsNamedNeverAnEmptyList() {
        let sources = [PersonSourceState(kind: .meetings, state: .ok),
                       PersonSourceState(kind: .contacts, state: .refused, reason: "Contacts access is off.")]
        XCTAssertEqual(PeopleText.unavailable(sources).map(\.kind), [.contacts])
        XCTAssertEqual(ContactsAccessState.from(sources), .refused("Contacts access is off."))
        XCTAssertEqual(ContactsAccessState.from([PersonSourceState(kind: .contacts, state: .off)]), .off)
        XCTAssertEqual(ContactsAccessState.from([]), .allowed)
    }

    func testTheRenameFieldIsDirtyOnlyWithANewName() {
        XCTAssertFalse(PersonNameField.isDirty(draft: "", saved: nil))
        XCTAssertFalse(PersonNameField.isDirty(draft: "Dana Example ", saved: "Dana Example"))
        XCTAssertTrue(PersonNameField.isDirty(draft: "Dana Ex", saved: "Dana Example"))
        XCTAssertTrue(PersonNameField.isDirty(draft: "Dana", saved: nil))
    }

    // MARK: The Contacts view's words

    func testWhereSeenAndTheMergeWords() throws {
        let alex = Fixture.person("Alex Example", meetings: 4, lastSeen: "2026-11-03T09:00:00.000Z", projects: ["Design"])
        XCTAssertTrue(PeopleDates.seen(alex).hasPrefix("4 meetings · last "), PeopleDates.seen(alex))
        XCTAssertTrue(PeopleDates.seen(alex).hasSuffix(" · Design"))
        // The window's own date words, whatever the Mac's region: a Czech region wrote "9. 11. 2026" here.
        XCTAssertEqual(PeopleDates.day("2026-11-09T12:00:00Z"), "9 Nov 2026")
        // "Meetings" stood on every row beside "4 meetings": a row names only the sources its line does not.
        XCTAssertEqual(PeopleDates.sourceChips(Fixture.person("Alex", meetings: 4, sources: [.meetings, .contacts])), [.contacts])
        XCTAssertEqual(PeopleDates.sourceChips(Fixture.person("Kai", meetings: 0, sources: [.meetings])), [.meetings])
        XCTAssertEqual(PeopleDates.seen(Fixture.person("Kai", meetings: 0, sources: [.contacts])), "In Contacts, no meeting yet")
        let plan = Fixture.plan
        XCTAssertEqual(ContactsMergeSheet.title(plan), "Merge Alex Example and Robin Example?")
        XCTAssertEqual(ContactsMergeSheet.meetingsHeading(plan), "2 meetings name them")
        let record = PeopleMergeRecord(token: "t1", people: [.init(name: "Alex Example"), .init(name: "Robin Example", email: "robin@example.com")],
                                       name: "Alex Example", at: "2026-11-03T10:00:00.000Z")
        XCTAssertEqual(MeetingsContactsView.mergedText(record), "Merged Alex Example and Robin Example into Alex Example.")
        XCTAssertEqual(PeopleSourceSwitches.Switch.calendar.configPath, "global.people.sources.calendar")
    }

    func testMergeWithOffersEveryoneElseMatchingTheText() {
        let people = Fixture.people
        let alex = people[1]
        let all = MeetingsContactsView.mergeCandidates(people, except: alex, query: "")
        XCTAssertFalse(all.contains(alex))
        XCTAssertEqual(all.count, people.count - 1)
        XCTAssertEqual(MeetingsContactsView.mergeCandidates(people, except: alex, query: "robin").map(\.name), ["Robin Example"])
        XCTAssertEqual(MeetingsContactsView.mergeCandidates(people, except: alex, query: "exam").count, people.count - 1)
    }

    // MARK: Snapshots

    /// F10: the command forms the window runs when no Meetings service answers, with the query after `--`.
    func testThePeopleCommandsWithoutAService() throws {
        XCTAssertEqual(PeopleCalls.knownArgs(.init(query: "-dana", meeting: "m1", atSec: 12.5, limit: 20, includeHidden: true)),
                       ["people", "list", "--json", "--meeting", "m1", "--at", "12.5", "--limit", "20", "--hidden", "--", "-dana"])
        XCTAssertEqual(PeopleCalls.knownArgs(.init(limit: 500)), ["people", "list", "--json", "--limit", "500"])
        XCTAssertEqual(PeopleCalls.addArgs(.init(name: "Robin Example", email: "robin@example.com")),
                       ["people", "add", "--json", "--email", "robin@example.com", "--", "Robin Example"])
        XCTAssertEqual(PeopleCalls.hideArgs(.init(person: "name:jo example", hidden: false)),
                       ["people", "hide", "--json", "--show", "--", "name:jo example"])
        XCTAssertEqual(PeopleCalls.mergeArgs(.init(a: "email:a@example.com", b: "name:a example", name: "Alex Example"), make: true),
                       ["people", "merge", "--json", "--name", "Alex Example", "--yes", "--", "email:a@example.com", "name:a example"])
        XCTAssertEqual(PeopleCalls.mergeArgs(.init(a: "x", b: "y"), make: false), ["people", "merge", "--json", "--", "x", "y"])
        XCTAssertEqual(PeopleCalls.unmergeArgs("t1"), ["people", "unmerge", "--json", "--", "t1"])
        let action = DecisionAction.assign("Dana Example", stretches: [.init(label: "Speaker 2", fromSec: 9, toSec: 21.5)])
        let args = try XCTUnwrap(MeetingDetailModel.commandArgs(meeting: "m1", action: action, reason: nil))
        XCTAssertEqual(Array(args.prefix(3)), ["decide", "m1", "--action"])
        XCTAssertEqual(try JSONDecoder().decode(DecisionAction.self, from: Data(args[3].utf8)), action)
        var undo = DecisionAction(kind: "revert")
        undo.token = "t1"
        let revert = try XCTUnwrap(MeetingDetailModel.journalCommand(meeting: "m1", action: undo, reason: nil))
        XCTAssertEqual(try JSONDecoder().decode(DecisionAction.self, from: Data(revert[3].utf8)), undo)
    }

    /// F10, R22: the speaker plan's mirror reads an assign's other stretches and a rename's warning.
    func testTheSpeakerPlanReadsStretchesAndWarnings() throws {
        let plan = try MeetingsService.decode(MeetingsAPI.PersonDecisionPlan.Result.self, [
            "skipped": [], "warnings": ["S2 is named Alex Example already: S3 and S2 become one person"],
            "reach": ["items": [], "dictionary": [],
                      "stretches": [["label": "Speaker 2", "fromSec": 40, "toSec": 55, "lines": 3, "why": "present-set"]]],
        ] as [String: Any])
        XCTAssertEqual(plan.warnings?.first, "S2 is named Alex Example already: S3 and S2 become one person")
        let stretch = try XCTUnwrap(plan.reach?.stretches?.first)
        XCTAssertEqual(stretch.why, .presentSet)
        XCTAssertEqual(AssignReachSheet.why(stretch), "3 lines, with the same people present")
        let fixture = try examples("decision.plan").first { ($0["note"] as? String)?.contains("given to a person") == true }
        let result = try XCTUnwrap((fixture?["reply"] as? [String: Any])?["result"])
        XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.PersonDecisionPlan.Result.self, result).reach?.stretches, [])
    }

    /// F10, G-PPL-5: the Contacts view is a place of the window; the open meeting stays open for the way back.
    func testContactsIsAPlaceThatKeepsTheOpenMeeting() throws {
        let suite = "meetings.contacts.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        model.select("m1")
        model.go(.contacts)
        XCTAssertEqual(model.place, .contacts)
        XCTAssertEqual(model.selectedMeetingID, "m1")
        XCTAssertEqual(model.detail?.id, "m1")
        XCTAssertTrue(model.visibleMeetings.isEmpty)
        XCTAssertEqual(model.people.switches, PeopleSourceSwitches(), "no config read yet: both sources on")
    }

    func testSnapshotsOfThePickerAndTheContactsView() throws {
        guard let folder = ProcessInfo.processInfo.environment["MEETINGS_PEOPLE_SHOTS"] else { return }
        let people = Fixture.people
        for dark in [false, true] {
            let look = dark ? "dark" : "light"
            try PeopleSnapshot.render(
                PersonPicker(people: Array(people.prefix(5)), query: .constant(""), sources: Fixture.sourcesRefused,
                             pick: { _ in }, addNew: { _ in }, grantContacts: {}),
                width: 300, dark: dark, to: "\(folder)/picker-empty-\(look).png")
            try PeopleSnapshot.render(
                PersonPicker(people: [], query: .constant("Jamie"), pick: { _ in }, addNew: { _ in }),
                width: 300, dark: dark, to: "\(folder)/picker-add-new-\(look).png")
            try PeopleSnapshot.render(
                PersonPicker(people: [people[0]], query: .constant("Dana"),
                             warning: "Speaker 3 is already Dana Exámple: both labels become one person.",
                             pick: { _ in }, addNew: { _ in }),
                width: 300, dark: dark, to: "\(folder)/picker-warning-\(look).png")
            for width in [900.0, 1400.0] {
                try PeopleSnapshot.render(
                    MeetingsContactsView(
                        people: people, total: 14, query: .constant(""), showHidden: .constant(false),
                        sources: Fixture.sourcesRefused, switches: PeopleSourceSwitches(contacts: true, calendar: true),
                        lastMerge: PeopleMergeRecord(token: "t1", people: [.init(name: "Alex Example"), .init(name: "A. Example")],
                                                     name: "Alex Example", at: "2026-11-03T10:00:00.000Z"),
                        add: { _, _ in }, setHidden: { _, _ in }, requestMerge: { _, _ in }, confirmMerge: { _, _ in },
                        cancelMerge: {}, unmerge: { _ in }, setSource: { _, _ in })
                        .frame(height: 560),
                    width: width, dark: dark, to: "\(folder)/contacts-\(Int(width))-\(look).png")
            }
            try PeopleSnapshot.render(
                MeetingsContactsView(
                    people: [], query: .constant("Jamie"), showHidden: .constant(false),
                    add: { _, _ in }, setHidden: { _, _ in }, requestMerge: { _, _ in }, confirmMerge: { _, _ in },
                    cancelMerge: {}, unmerge: { _ in }, setSource: { _, _ in })
                    .frame(height: 320),
                width: 900, dark: dark, to: "\(folder)/contacts-empty-\(look).png")
            try PeopleSnapshot.render(ContactsMergeSheet(plan: Fixture.plan, confirm: { _ in }, cancel: {}),
                                      width: 440, dark: dark, to: "\(folder)/merge-sheet-\(look).png")
        }
    }
}

/// Invented people of an invented team (never real names).
private enum Fixture {
    static func person(_ name: String, email: String? = nil, aliases: [String] = [], meetings: Int = 1,
                       lastSeen: String? = nil, projects: [String] = [], sources: [PersonSourceKind] = [.meetings],
                       rank: PersonRank = .meetings, isSelf: Bool = false, hidden: Bool = false, merge: String? = nil) -> KnownPerson {
        let id = email.map { "email:\($0)" } ?? "name:\(name.lowercased())"
        return KnownPerson(id: id, name: name, email: email, isSelf: isSelf, aliases: aliases, sources: sources, rank: rank,
                           meetings: meetings, lastSeen: lastSeen, projects: projects, merge: merge, hidden: hidden)
    }

    static let people: [KnownPerson] = [
        person("Dana Exámple", email: "dana@example.com", meetings: 12, lastSeen: "2026-11-08T09:00:00.000Z",
               projects: ["Design"], sources: [.meetings, .contacts], rank: .present, isSelf: true),
        person("Alex Example", aliases: ["A. Example"], meetings: 7, lastSeen: "2026-11-07T13:00:00.000Z",
               projects: ["Design", "Ops"], rank: .meeting, merge: "t1"),
        person("Robin Example", email: "robin@example.com", meetings: 3, lastSeen: "2026-10-30T10:00:00.000Z", rank: .meeting),
        person("Sam Example", email: "sam.example@example.org", meetings: 2, lastSeen: "2026-10-21T08:30:00.000Z",
               sources: [.meetings, .projects], rank: .meetings),
        person("Kai Example", email: "kai@example.net", meetings: 0, sources: [.contacts], rank: .contacts),
        person("Jo Example", meetings: 0, sources: [.own], rank: .own, hidden: true),
    ]

    static let sourcesRefused = [
        PersonSourceState(kind: .meetings, state: .ok),
        PersonSourceState(kind: .contacts, state: .refused, reason: "macOS has not allowed GenesisTools to read Contacts."),
    ]

    static let plan = PeopleMergePlan(
        people: [person("Alex Example", meetings: 7), person("Robin Example", email: "robin@example.com", meetings: 3)],
        name: "Alex Example",
        meetings: [
            .init(id: "2026-11-03-1000-design-review", title: "Design review", start: "2026-11-03T09:00:00.000Z",
                  people: [0, 1], as: [.participant, .speaker]),
            .init(id: "2026-11-05-1400-ops-sync", title: "Ops sync", start: "2026-11-05T13:00:00.000Z",
                  people: [1], as: [.calendar]),
        ],
        labels: [.init(meeting: "2026-11-03-1000-design-review", label: "Speaker 2", name: "Robin Example")])
}

/// Draws a view in an offscreen window (AppKit controls included) and writes a PNG.
@MainActor
enum PeopleSnapshot {
    static func render<V: View>(_ view: V, width: CGFloat, dark: Bool, to path: String) throws {
        let root = view
            .frame(width: width)
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, dark ? .dark : .light)
        let host = NSHostingView(rootView: root)
        host.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        let size = host.fittingSize
        host.frame = CGRect(origin: .zero, size: CGSize(width: width, height: max(size.height, 1)))
        let window = NSWindow(contentRect: CGRect(x: -4000, y: -4000, width: host.frame.width, height: host.frame.height),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = host.appearance
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.15))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
    }
}
