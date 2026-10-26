import AppKit
import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// The navigation engine (`NavigationHistory`): visits never replace, Back and Forward walk, a hop reaches any entry,
/// provisional places leave no stop, the cap drops the oldest, and an agent's visit keeps its note.
final class NavigationHistoryTests: XCTestCase {
    private typealias History = NavigationHistory<String>

    private func titles(_ history: History, _ ids: [String]) -> [String] {
        ids.compactMap { history.entry($0)?.title }
    }

    private func walk(_ places: [String], limit: Int = 200) -> History {
        var history = History(limit: limit)
        for place in places {
            history.visit(place, title: place)
        }
        return history
    }

    func testVisitsStackAndBackAndForwardWalkThem() {
        var history = walk(["a", "b", "c"])
        XCTAssertEqual(history.current?.target, "c")
        XCTAssertEqual(history.goBack()?.target, "b")
        XCTAssertEqual(history.goBack()?.target, "a")
        XCTAssertNil(history.goBack(), "nothing before the first place")
        XCTAssertEqual(history.goForward()?.target, "b")
        XCTAssertEqual(history.goForward()?.target, "c")
        XCTAssertNil(history.goForward())
        XCTAssertEqual(history.entries.count, 3, "walking never adds entries")
    }

    func testAVisitAfterGoingBackClearsForwardButTheLogKeepsEveryPlace() {
        var history = walk(["a", "b", "c"])
        _ = history.goBack()
        _ = history.goBack()
        history.visit("d", title: "d")
        XCTAssertFalse(history.canGoForward)
        XCTAssertEqual(titles(history, history.backIDs), ["a"])
        XCTAssertEqual(history.newestFirst.map(\.target), ["d", "c", "b", "a"], "b and c are still in the list")
        // A hop reaches a place that left the forward stack, and Back returns from it.
        let c = try! XCTUnwrap(history.entries.first { $0.target == "c" })
        XCTAssertNil(history.offset(of: c.id), "only the log holds it")
        XCTAssertEqual(history.hop(to: c.id)?.target, "c")
        XCTAssertEqual(history.goBack()?.target, "d")
    }

    func testTheSamePlaceTwiceIsOneStop() {
        var history = walk(["a"])
        XCTAssertNil(history.visit("a", title: "a"))
        XCTAssertFalse(history.canGoBack)
        XCTAssertEqual(history.entries.count, 1)
    }

    func testHopBackwardsKeepsThePassedPlacesAheadInOrder() throws {
        var history = walk(["a", "b", "c", "d"])
        let a = try XCTUnwrap(history.entries.first)
        XCTAssertEqual(history.offset(of: a.id), -3)
        XCTAssertEqual(history.hop(to: a.id)?.target, "a")
        XCTAssertFalse(history.canGoBack)
        XCTAssertEqual(history.goForward()?.target, "b")
        XCTAssertEqual(history.goForward()?.target, "c")
        XCTAssertEqual(history.goForward()?.target, "d")
    }

    func testHopForwardsKeepsThePassedPlacesBehindInOrder() throws {
        var history = walk(["a", "b", "c", "d"])
        let d = try XCTUnwrap(history.entries.last)
        _ = history.hop(to: try XCTUnwrap(history.entries.first).id)
        XCTAssertEqual(history.offset(of: d.id), 3)
        XCTAssertEqual(history.hop(to: d.id)?.target, "d")
        XCTAssertFalse(history.canGoForward)
        XCTAssertEqual(history.goBack()?.target, "c")
        XCTAssertEqual(history.goBack()?.target, "b")
        XCTAssertEqual(history.goBack()?.target, "a")
        XCTAssertNil(history.hop(to: "no-such-id"))
    }

    func testAProvisionalPlaceIsNeverAStop() {
        var history = History()
        history.visit("sessions:-", title: "Sessions", provisional: true)
        history.visit("prs:-", title: "PRs", provisional: true)
        XCTAssertFalse(history.canGoBack, "the launch's empty mode is no place to go back to")
        XCTAssertTrue(history.entries.isEmpty)

        history.visit("pr1", title: "pr1")
        history.visit("worktrees:-", title: "Worktrees", provisional: true)
        history.visit("a", title: "a")
        XCTAssertEqual(titles(history, history.backIDs), ["pr1"], "a mode left while its list loaded is not a stop")

        // Out to an empty mode and straight back: the place before it, not a copy of it.
        history.visit("worktrees:-", title: "Worktrees", provisional: true)
        history.visit("a", title: "a")
        XCTAssertEqual(titles(history, history.backIDs), ["pr1"])
        XCTAssertEqual(history.current?.target, "a")
        XCTAssertEqual(history.entries.count, 2)
    }

    func testAnAgentVisitCarriesItsWhoAndNoteAndKeepsTheCLIsID() {
        var history = walk(["a"])
        let made = history.visit("pr563", title: "PR #563", actor: .agent, agentSession: "abc", note: "the failing CI run",
                                 id: "cli-id")
        XCTAssertEqual(made?.id, "cli-id")
        XCTAssertEqual(history.current?.actor, .agent)
        XCTAssertEqual(history.current?.note, "the failing CI run")
        XCTAssertEqual(history.backEntry?.target, "a")
    }

    func testResolvingAnAdoptedCLIEntryNeverPutsItBehindItself() {
        let start = Date(timeIntervalSince1970: 100)
        for hasLaunchPlace in [false, true] {
            var history = History()
            if hasLaunchPlace { history.visit("launch", title: "launch", id: "launch", at: start.addingTimeInterval(2)) }
            history.adoptOlder([
                NavigationEntry(id: "previous", at: start, target: "previous", title: "previous"),
                NavigationEntry(id: "cli", at: start.addingTimeInterval(1), target: "raw-request", title: "requested", actor: .agent),
            ])
            history.visit("resolved", title: "resolved", actor: .agent, note: "why", id: "cli", at: start.addingTimeInterval(3))
            XCTAssertEqual(history.currentID, "cli")
            XCTAssertFalse(history.backIDs.contains("cli"))
            XCTAssertFalse(history.forwardIDs.contains("cli"))
            XCTAssertEqual(history.entries.filter { $0.id == "cli" }.count, 1)
            if hasLaunchPlace { XCTAssertEqual(history.goBack()?.target, "launch") }
            XCTAssertEqual(history.goBack()?.target, "previous")
            XCTAssertNil(history.goBack())
            if hasLaunchPlace { XCTAssertEqual(history.goForward()?.target, "launch") }
            XCTAssertEqual(history.goForward()?.target, "resolved")
            XCTAssertNil(history.goForward())
        }
    }

    func testAnnotatingWithAnAdoptedCLIIdRemovesItsOldRowAndStackReference() {
        var history = History()
        history.visit("shown", title: "shown", id: "shown")
        history.adoptOlder([
            NavigationEntry(id: "previous", at: Date(timeIntervalSince1970: 1), target: "previous", title: "previous"),
            NavigationEntry(id: "cli", at: Date(timeIntervalSince1970: 2), target: "raw-request", title: "requested"),
        ])
        history.visit("shown", title: "shown", actor: .agent, id: "cli")
        XCTAssertEqual(history.entries.filter { $0.id == "cli" }.count, 1)
        XCTAssertFalse(history.backIDs.contains("cli"))
        XCTAssertEqual(history.goBack()?.target, "previous")
        XCTAssertEqual(history.goForward()?.target, "shown")
        XCTAssertNil(history.goForward())
    }

    func testAnAgentOpeningWhatIsShownAnnotatesItInsteadOfAddingACopy() {
        var history = walk(["a", "b"])
        let annotated = history.visit("b", title: "", actor: .agent, note: "look here", id: "cli-id")
        XCTAssertEqual(annotated?.id, "cli-id")
        XCTAssertEqual(annotated?.title, "b", "an empty title keeps the one it had")
        XCTAssertEqual(history.entries.count, 2)
        XCTAssertEqual(history.current?.note, "look here")
        XCTAssertEqual(history.backEntry?.target, "a")
        // A user's repeat of the same place is nothing at all.
        XCTAssertNil(history.visit("b", title: "b"))
    }

    func testRecordAddsToTheListWithoutMovingTheCursor() throws {
        var history = walk(["a", "b"])
        let added = history.record("pr9", title: "PR #9", actor: .agent, note: "later")
        XCTAssertEqual(history.current?.target, "b")
        XCTAssertNil(history.offset(of: added.id))
        XCTAssertEqual(history.newestFirst.first?.target, "pr9")
        XCTAssertEqual(history.hop(to: added.id)?.target, "pr9")
        XCTAssertEqual(history.goBack()?.target, "b")
    }

    func testTheCapDropsTheOldestButNeverThePlaceOnScreen() {
        var history = walk((0..<30).map { "p\($0)" }, limit: 10)
        XCTAssertEqual(history.entries.count, 10)
        XCTAssertEqual(history.entries.first?.target, "p20")
        XCTAssertEqual(history.backIDs.count, 9)
        for _ in 0..<9 { _ = history.goBack() }
        history.setLimit(3)
        XCTAssertEqual(history.current?.target, "p20", "the place on screen survives a smaller cap")
        XCTAssertTrue(history.entries.contains { $0.target == "p20" })
        XCTAssertLessThanOrEqual(history.entries.count, 3)
    }

    func testALogReadBackPutsEveryEntryBehindTheNewest() {
        let now = Date()
        let entries = [
            NavigationEntry(id: "2", at: now, target: "b", title: "b"),
            NavigationEntry(id: "1", at: now.addingTimeInterval(-60), target: "a", title: "a", actor: .agent, note: "why"),
        ]
        var history = History(entries: entries)
        XCTAssertEqual(history.current?.target, "b")
        XCTAssertEqual(history.goBack()?.note, "why")
        // The launch's own place after a read-back pushes the newest entry behind it.
        var launched = History(entries: entries)
        launched.visit("c", title: "c")
        XCTAssertEqual(launched.backEntry?.target, "b")
    }

    func testRetargetMakesTheShownPlaceEqualToItsEntry() throws {
        var history = walk(["a"])
        history.visit("pr=563", title: "PR #563", actor: .agent, note: "why")
        let id = try XCTUnwrap(history.currentID)
        XCTAssertEqual(history.retarget(id, to: "prs:github.com/acme/app/pull/563", title: "#563 Fix it")?.title, "#563 Fix it")
        XCTAssertNil(history.visit("prs:github.com/acme/app/pull/563", title: "#563 Fix it"), "the shown place is the entry")
        XCTAssertEqual(history.current?.note, "why")
        XCTAssertNil(history.retarget(id, to: "prs:github.com/acme/app/pull/563"))
    }

    func testAnOlderLogGoesBehindWhatTheWindowDidSinceItOpened() {
        let now = Date()
        var history = History()
        history.visit("launch", title: "launch", at: now)
        history.adoptOlder([
            NavigationEntry(id: "o2", at: now.addingTimeInterval(-10), target: "older2", title: "older2"),
            NavigationEntry(id: "o1", at: now.addingTimeInterval(-20), target: "older1", title: "older1"),
        ])
        XCTAssertEqual(history.current?.target, "launch")
        XCTAssertEqual(history.goBack()?.target, "older2")
        XCTAssertEqual(history.goBack()?.target, "older1")
        // A relaunch on the place the log ended with: one entry, the log's, with its who and note.
        var relaunched = History()
        relaunched.visit("pr1", title: "pr1", id: "window-id", at: now)
        relaunched.visit("pr2", title: "pr2", at: now.addingTimeInterval(1))
        let merged = relaunched.adoptOlder([
            NavigationEntry(id: "log-a", at: now.addingTimeInterval(-30), target: "a", title: "a"),
            NavigationEntry(id: "log-pr1", at: now.addingTimeInterval(-20), target: "pr1", title: "pr1", actor: .agent, note: "n"),
        ])
        XCTAssertEqual(merged, ["window-id"])
        XCTAssertEqual(relaunched.entries.map(\.id).prefix(2), ["log-a", "log-pr1"])
        XCTAssertEqual(relaunched.entries.count, 3)
        XCTAssertEqual(relaunched.goBack()?.note, "n")
        XCTAssertEqual(relaunched.goBack()?.target, "a")
        // Nothing on screen yet: the newest adopted entry is the current place.
        var empty = History()
        empty.adoptOlder([NavigationEntry(id: "x", at: now, target: "x", title: "x")])
        XCTAssertEqual(empty.current?.target, "x")
        XCTAssertFalse(empty.canGoBack)
    }

    func testRetitleChangesOnlyTheNamedEntry() throws {
        var history = walk(["a", "b"])
        let a = try XCTUnwrap(history.entries.first)
        XCTAssertEqual(history.retitle(a.id, "PR #1 Fix it")?.title, "PR #1 Fix it")
        XCTAssertNil(history.retitle(a.id, "PR #1 Fix it"), "the same title again writes nothing")
        XCTAssertEqual(history.entries.last?.title, "b")
    }

    func testEntriesRoundTripThroughJSON() throws {
        let entry = NavigationEntry(id: "x", at: Date(timeIntervalSince1970: 1_700_000_000), target: ["pr": "563"],
                                    title: "PR #563", actor: .link, agentSession: nil, note: nil)
        let data = try JSONEncoder().encode(entry)
        XCTAssertEqual(try JSONDecoder().decode(NavigationEntry<[String: String]>.self, from: data), entry)
    }

    /// The store protocol the host implements: a memory store reads back what it was given, newest kept.
    func testAStoreKeepsTheNewestEntriesAndReplacesByID() throws {
        final class MemoryStore: NavigationHistoryStore {
            var rows: [NavigationEntry<String>] = []
            func load() throws -> [NavigationEntry<String>] { rows }
            func record(_ entry: NavigationEntry<String>, keep: Int) throws {
                rows.removeAll { $0.id == entry.id || entry.replacedIDs?.contains($0.id) == true }
                rows.append(entry)
                rows = Array(rows.sorted { $0.at < $1.at }.suffix(keep))
            }
        }
        let store = MemoryStore()
        var history = History(limit: 2)
        let start = Date()
        for (index, place) in ["a", "b", "c"].enumerated() {
            if let made = history.visit(place, title: place, at: start.addingTimeInterval(Double(index))) {
                try store.record(made, keep: history.limit)
            }
        }
        let originalID = try XCTUnwrap(history.currentID)
        try store.record(NavigationEntry(id: "cli-id", at: start.addingTimeInterval(8), target: "c", title: "c"), keep: 200)
        if let annotated = history.visit("c", title: "c", actor: .agent, note: "n", id: "cli-id", at: start.addingTimeInterval(9)) {
            XCTAssertEqual(annotated.replacedIDs, [originalID])
            try store.record(annotated, keep: history.limit)
        }
        XCTAssertEqual(store.rows.count, 2, "the original id and the CLI id become one persisted stop")
        let reread = History(entries: try store.load(), limit: 2)
        XCTAssertEqual(reread.entries.map(\.target), ["b", "c"])
        XCTAssertEqual(reread.current?.note, "n")
        XCTAssertEqual(reread.currentID, "cli-id")
    }
}

/// The history list as the hub's popover draws it, in the dark settings look.
@MainActor
final class NavigationHistoryListShotTests: XCTestCase {
    func testTheListDrawsEveryActorTheNoteAndTheCurrentPlace() throws {
        let rep = try KitShots.render(NavigationHistoryGallery(), size: CGSize(width: 380, height: 430), name: "navigation-history",
                                      settle: 0.6)
        // The agent badge's violet and the link badge's blue must both be on the picture.
        var violet = 0
        var blue = 0
        for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: rep.pixelsWide / 2, by: 2) {
                guard let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB), c.saturationComponent > 0.3,
                      c.brightnessComponent > 0.5 else { continue }
                let hue = c.hueComponent
                if (0.70...0.80).contains(hue) { violet += 1 }
                if (0.58...0.66).contains(hue) { blue += 1 }
            }
        }
        XCTAssertGreaterThan(violet, 8, "the Agent badge")
        XCTAssertGreaterThan(blue, 8, "the Link badge")
        XCTAssertGreaterThan(KitShots.brightness(rep, in: CGRect(x: 40, y: 30, width: 300, height: 360), viewWidth: 380), 0.08,
                             "row titles must be drawn")
    }
}

/// Five places: the person's, two an agent opened with notes, one from a link, and the place on screen.
struct NavigationHistoryGallery: View {
    static var sample: NavigationHistory<String> {
        let now = Date()
        var history = NavigationHistory<String>()
        history.visit("s1", title: "session Fix the login redirect", at: now.addingTimeInterval(-3600))
        history.visit("pr563", title: "#563 hub: navigation history", actor: .agent, agentSession: "2f320c19-ff19",
                      note: "The PR with the failing Swift suite; the second commit adds the store.",
                      at: now.addingTimeInterval(-1500))
        history.visit("c1", title: "commit 0751d8a971 in GenesisTools", actor: .agent, agentSession: "2f320c19-ff19",
                      note: "The commit that moved the cache chip focus.", at: now.addingTimeInterval(-600))
        history.visit("wt", title: "worktree GenesisTools feat/2026-10-25-hub-navigation-history", actor: .link,
                      at: now.addingTimeInterval(-240))
        history.visit("s2", title: "session Review the hub history popover", at: now.addingTimeInterval(-30))
        _ = history.goBack()
        return history
    }

    var body: some View {
        NavigationHistoryList(history: Self.sample) { _ in }
            .frame(width: 380, alignment: .top)
            .frame(maxHeight: .infinity, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
            .preferredColorScheme(.dark)
    }
}
