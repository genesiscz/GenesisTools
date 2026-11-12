import AppKit
import AVFoundation
import Foundation
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The Wave B Swift review's fixes (WaveB-b-review-fix-swift.md): each test names the finding it pins.
@MainActor
final class MeetingsReviewFixTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() async throws {
        suite = "meetings.reviewfix.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    func testTranscriptVisibilityIncludesEachMountedSidePane() {
        let detail = MeetingDetailModel(id: "m", window: nil)
        detail.tab = .items
        let first = UUID(), replacement = UUID()
        XCTAssertFalse(detail.transcriptIsShowing)
        detail.setTranscriptPane(first, visible: true)
        detail.setTranscriptPane(replacement, visible: true)
        detail.setTranscriptPane(first, visible: false)
        XCTAssertTrue(detail.transcriptIsShowing, "a disappearing old pane cannot hide its replacement")
        XCTAssertEqual(MeetingDetailModel.transcriptRefresh(read: true, showing: detail.transcriptIsShowing), .readQuietly)
        detail.setTranscriptPane(replacement, visible: false)
        XCTAssertFalse(detail.transcriptIsShowing)
        detail.tab = .transcript
        XCTAssertTrue(detail.transcriptIsShowing)
    }

    // MARK: Finding 1: the row's controls are pressable at rest

    /// Whether each `LiveButton` in a view's body is pressable at rest. A hosted SwiftUI view shows no accessibility
    /// children without an accessibility client, so the test reads the body's structure: a resting row (`.liveRow`)
    /// draws a LiveButton's label alone unless it is `pressable` (GenesisKit `Style/LiveControls.swift`).
    private func liveButtonsPressable(_ value: Any, depth: Int = 0) -> [Bool] {
        guard depth < 24 else { return [] }
        let mirror = Mirror(reflecting: value)
        if String(describing: type(of: value)).hasPrefix("LiveButton<") {
            return [mirror.children.first { $0.label == "pressable" }?.value as? Bool ?? false]
        }
        return mirror.children.flatMap { liveButtonsPressable($0.value, depth: depth + 1) }
    }

    func testARowsPlayControlIsPressableWhileItsRowRests() {
        let player = MomentPlayer(engine: .init(cut: { _ in throw CancellationError() }, plan: { _ in .init(moment: nil, cannot: nil) },
                                                audio: { _ in throw CancellationError() }),
                                  load: { _ in throw CancellationError() }, defaults: defaults)
        let found = liveButtonsPressable(MomentButton(player: player, meeting: "m1", target: .time(309), label: "05:09").body)
        XCTAssertEqual(found, [true], "the one play control presses in a resting row")
    }

    func testASpeakerChipsTimeIsPressableWhileItsBlockRests() {
        let found = liveButtonsPressable(SpeakerChip(speaker: "Speaker 1", startSec: 3, play: { _ in }).body)
        XCTAssertEqual(found, [true], "the block's time plays from a resting block")
    }

    // MARK: Finding 5: every opinionated pick of a view is a window setting with a row

    func testEveryHardCodedPickIsAWindowSettingWithARow() {
        let rows = Dictionary(uniqueKeysWithValues: SidePanelCatalog.windowSections(defaults).flatMap(\.rows).map { ($0.id, $0) })
        let picks: [(String, SidePanelValue)] = [
            ("meetings.transcript.dimPast", .flag(true)), ("meetings.transcript.avatars", .flag(true)),
            ("meetings.transcript.blockBreakSec", .number(0)), ("meetings.selection.clipSec", .number(5)),
            ("meetings.speakers.showQuestions", .flag(true)), ("meetings.speakers.hintChips", .number(3)),
            ("meetings.screen.height", .number(150)), ("meetings.timeline.collapseHeight", .number(700)),
            ("meetings.rows.openPersonPicker", .flag(true)), ("meetings.playback.keys", .flag(true)),
        ]
        for (key, value) in picks {
            XCTAssertEqual(rows[key]?.value, value, "\(key) has a row with the view's old pick")
            XCTAssertEqual(rows[key]?.defaultValue, value, "\(key)'s default is the view's old pick")
        }
        XCTAssertEqual(rows["meetings.transcript.blockBreakSec"]?.valueTitle, "Off")
        XCTAssertEqual(rows["meetings.timeline.collapseHeight"]?.choices.first?.title, "Never")
        XCTAssertEqual(rows["meetings.screen.height"]?.valueTitle, "150 pt")
        XCTAssertNil(MeetingsPreferences.Transcript.breakAfterGapSec(0), "Off keeps one block per turn")
        XCTAssertEqual(MeetingsPreferences.Transcript.breakAfterGapSec(10), 10)
        XCTAssertTrue(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 500, collapseHeight: 560))
        XCTAssertFalse(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 500, collapseHeight: 0), "Never folds")
        XCTAssertTrue(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 600),
                      "D13: at the smallest window the full dock left about 90 pt of rows, so the default folds it")
        SidePanelCatalog.write(.number(0), key: MeetingsPreferences.Panes.collapseHeight.key, to: defaults)
        XCTAssertEqual(MeetingsPreferences.Panes.collapseHeight.value(defaults), 0, "Never is stored as a whole number and read back")
    }

    func testThePlayerKeysCanBeTurnedOff() {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        window.player.timeline.hoveredPin = "i1"
        defaults.set(false, forKey: MeetingsPreferences.Playback.keys.key)
        XCTAssertFalse(MeetingsPlaybackKeys.perform(.escape, model: window), "off: Esc goes on to the views")
        XCTAssertEqual(window.player.timeline.hoveredPin, "i1")
        defaults.removeObject(forKey: MeetingsPreferences.Playback.keys.key)
        XCTAssertTrue(MeetingsPlaybackKeys.perform(.escape, model: window), "on by default: Esc closes the pin card")
        XCTAssertNil(window.player.timeline.hoveredPin)
    }

    // MARK: Finding 6: a sub-option is off while its parent is off, and says why

    func testASubOptionIsOffWhileItsParentIsOff() throws {
        let toneOff = SidePanelCatalog.engineSection(listen: .object(["tone": .object(["enabled": .bool(false)])]))
        let lead = try XCTUnwrap(toneOff.rows.first { $0.id.hasSuffix(".tone.leadSec") })
        let sound = try XCTUnwrap(toneOff.rows.first { $0.id.hasSuffix(".tone.sound") })
        XCTAssertFalse(toneOff.isEnabled(lead))
        XCTAssertFalse(toneOff.isEnabled(sound))
        XCTAssertTrue(toneOff.detail(lead).hasSuffix("Off while Tone is off."))
        let toneOn = SidePanelCatalog.engineSection(listen: .object([:]))
        XCTAssertTrue(toneOn.rows.allSatisfy { toneOn.isEnabled($0) }, "Tone is on by default")
        XCTAssertEqual(toneOn.detail(lead), lead.detail)

        XCTAssertTrue(SidePanelCatalog.windowSections(defaults).allSatisfy { section in section.rows.allSatisfy(section.isEnabled) },
                      "fresh defaults: every row takes a change")
        defaults.set("off", forKey: MeetingsPreferences.Rows.autoplayNext.key)
        defaults.set("stop", forKey: MeetingsPreferences.Playback.afterClip.key)
        defaults.set(false, forKey: MeetingsPreferences.Panes.timelineShown.key)
        defaults.set(false, forKey: MeetingsPreferences.Panes.screenBesidePlayback.key)
        let sections = SidePanelCatalog.windowSections(defaults)
        func off(_ key: String) -> Bool {
            guard let section = sections.first(where: { $0.rows.contains { $0.id == key } }),
                  let row = section.rows.first(where: { $0.id == key }) else { return false }
            return !section.isEnabled(row)
        }
        for key in [MeetingsPreferences.Rows.autoplayDelaySec.key, MeetingsPreferences.Playback.moreSec.key,
                    MeetingsPreferences.Panes.hoverDelayMs.key, MeetingsPreferences.Panes.collapseHeight.key,
                    MeetingsPreferences.Panes.screenHeight.key] {
            XCTAssertTrue(off(key), "\(key) is off while its parent is off")
        }
        XCTAssertFalse(off(MeetingsPreferences.Panes.followPlayback.key), "a row with no parent stays on")
    }

    // MARK: Finding 11: the detail model reads the window's defaults

    func testTheDetailModelReadsTheWindowsDefaults() {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        XCTAssertTrue(detail.defaults === defaults, "a test's suite reaches the rows' settings and \"Do not ask again\"")
        XCTAssertTrue(MeetingDetailModel(id: "m", window: nil).defaults === UserDefaults.standard)
    }

    // MARK: Finding 8: Esc closes the History sheet and the Speakers "Review N" sheet

    /// The sheet hosted in an off-screen window, laid out, so its key equivalents are registered.
    private func hosted<V: View>(_ view: V) -> NSWindow {
        let window = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 600, height: 500), styleMask: [.titled],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: view)
        window.contentView?.layoutSubtreeIfNeeded()
        return window
    }

    private func escape(in window: NSWindow) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                       windowNumber: window.windowNumber, context: nil, characters: "\u{1b}",
                                       charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
    }

    func testEscClosesTheHistorySheet() throws {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        let sheet = MeetingDetailModel.HistorySheet(item: nil, entries: .loaded([]))
        detail.history = sheet
        let host = hosted(HistorySheetView(detail: detail, history: sheet))
        defer { host.close() }
        XCTAssertTrue(host.performKeyEquivalent(with: try escape(in: host)), "the sheet takes Esc")
        XCTAssertNil(detail.history, "Esc closes the History sheet")
    }

    func testEscClosesTheSpeakersReviewSheet() throws {
        var closed = 0
        let sheet = HintRangesSheet(label: "Speaker 1", names: [:], ranges: [], longestClipSec: 30,
                                    play: { _, _ in }, zoom: { _, _ in }, close: { closed += 1 })
        let host = hosted(sheet)
        defer { host.close() }
        XCTAssertTrue(host.performKeyEquivalent(with: try escape(in: host)), "the sheet takes Esc")
        XCTAssertEqual(closed, 1, "Esc closes the Review sheet")
    }

    // MARK: Finding 10 (G33): an answer does not move the next row

    /// Five open term rows, each tall enough that its fold frees room: the rows under a folding row would move up.
    private func termRows() throws -> ReviewRows {
        let rows = (1...5).map { index in
            #"""
            {"id":"r\#(index)","label":"r\#(index)","kind":"term","status":"suggested","confidence":0.8,"what":"OMP\#(index) → EMP\#(index)",
             "edit":"spelling","sources":[],
             "parts":[{"kind":"when","from":{"sec":\#(index * 60),"text":"0\#(index):00"},"target":{"kind":"item","id":"r\#(index)"}},
                      {"kind":"asks","pieces":[{"text":"Is this the word the team uses for the service in this part of the meeting?"}]},
                      {"kind":"asks","pieces":[{"text":"The transcript heard it twice in this stretch."}]}],
             "choices":[{"value":"EMP\#(index)","label":"EMP\#(index)","role":"suggested","action":{"kind":"confirm"},"confidence":0.8},
                        {"value":"OMP\#(index)","label":"OMP\#(index)","role":"heard","action":{"kind":"reject"}}],
             "target":{"kind":"item","id":"r\#(index)"}}
            """#
        }.joined(separator: ",")
        let json = #"{"meeting":"m","hidden":{"lowPriority":0,"minPriority":0.5},"rows":[\#(rows)]}"#
        return try JSONDecoder().decode(ReviewRows.self, from: Data(json.utf8))
    }

    /// `count` term rows, every `decidedEvery`-th one confirmed (it folds), the rest open; `flip` confirms the first.
    private func manyRows(count: Int, decidedEvery: Int, flip: Bool = false) throws -> ReviewRows {
        let rows = (1...count).map { index in
            let status = index % decidedEvery == 0 || (flip && index == 1) ? "confirmed" : "suggested"
            return #"""
            {"id":"r\#(index)","label":"r\#(index)","kind":"term","status":"\#(status)","confidence":0.8,"what":"OMP\#(index) → EMP\#(index)",
             "edit":"spelling","sources":[],
             "parts":[{"kind":"when","from":{"sec":\#(index * 60),"text":"\#(index):00"},"target":{"kind":"item","id":"r\#(index)"}},
                      {"kind":"asks","pieces":[{"text":"Is this the word the team uses for the service in this part of the meeting?"}]}],
             "choices":[{"value":"EMP\#(index)","label":"EMP\#(index)","role":"suggested","action":{"kind":"confirm"},"confidence":0.8},
                        {"value":"OMP\#(index)","label":"OMP\#(index)","role":"heard","action":{"kind":"reject"}}],
             "target":{"kind":"item","id":"r\#(index)"}}
            """#
        }.joined(separator: ",")
        let json = #"{"meeting":"m","hidden":{"lowPriority":0,"minPriority":0.5},"rows":[\#(rows)]}"#
        return try JSONDecoder().decode(ReviewRows.self, from: Data(json.utf8))
    }

    private static func cpuMs() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        func ms(_ t: timeval) -> Double { Double(t.tv_sec) * 1000 + Double(t.tv_usec) / 1000 }
        return ms(usage.ru_utime) + ms(usage.ru_stime)
    }

    /// The main-thread CPU one change of the Items list costs (lag report 2026-11-11, cause 6): a click that selects a
    /// row, and a new rows list after a decision. Prints `rows-cost …` lines; run with MEETINGS_ROWS_COST=1.
    func testRowsCost() throws {
        guard ProcessInfo.processInfo.environment["MEETINGS_ROWS_COST"] == "1" else { throw XCTSkip("set MEETINGS_ROWS_COST=1") }
        defaults.set(MeetingsPreferences.Rows.AutoplayNext.off.rawValue, forKey: MeetingsPreferences.Rows.autoplayNext.key)
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        let rows = try manyRows(count: 40, decidedEvery: 2)
        let flipped = try manyRows(count: 40, decidedEvery: 2, flip: true)
        detail.rows = .loaded(rows)
        let host = hostedItems(detail, height: 900)
        defer { host.orderOut(nil); host.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))
        let changes = 40
        func measure(_ name: String, _ change: (Int) -> Void) {
            let start = Self.cpuMs()
            for index in 0..<changes {
                change(index)
                RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            }
            print(String(format: "rows-cost %@ cpu/change=%.2f ms", name, (Self.cpuMs() - start) / Double(changes)))
        }
        measure("idle") { _ in }
        measure("select") { index in detail.selectedRow = rows.rows[index % 12].id }
        measure("rows") { index in detail.rows = .loaded(index % 2 == 0 ? flipped : rows) }
    }

    private func confirmed(_ id: String) throws -> JournalEntry {
        let json = #"{"token":"t-\#(id)","at":"2026-11-09T17:32:38.000Z","meeting":"m","actor":{"kind":"window"},"action":{"kind":"confirm","items":["\#(id)"]},"decided":["\#(id)"],"changes":[{"id":"\#(id)","before":{"id":"\#(id)","kind":"term","status":"suggested"},"after":{"id":"\#(id)","kind":"term","status":"confirmed"}}]}"#
        return try JSONDecoder().decode(JournalEntry.self, from: Data(json.utf8))
    }

    /// The Items tab in an off-screen window that the screen does not show, with the row probes on.
    private func hostedItems(_ detail: MeetingDetailModel, height: CGFloat) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: height), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.contentView = NSHostingView(rootView: ItemsTab(detail: detail).defaultAppStorage(defaults).frame(width: 640, height: height))
        window.orderFrontRegardless()
        return window
    }

    private func settle() { RunLoop.main.run(until: Date().addingTimeInterval(0.4)) }

    func testSingleClickOnTitleSelectsWithoutWaitingForDoubleClick() throws {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let model = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: model)
        detail.rows = .loaded(try termRows())
        let host = hostedItems(detail, height: 500)
        defer { host.orderOut(nil); host.close() }
        settle()
        let title = try XCTUnwrap(FrameProbe.frames["meetings.row.r1.title"])
        let point = NSPoint(x: title.midX, y: host.frame.height - title.midY)
        func click(_ count: Int) throws {
            for type in [NSEvent.EventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
                let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                                                           timestamp: ProcessInfo.processInfo.systemUptime,
                                                           windowNumber: host.windowNumber, context: nil,
                                                           eventNumber: 0, clickCount: count, pressure: 1))
                host.sendEvent(event)
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }
        }
        try click(1)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let selectedImmediately = detail.selectedRow
        RunLoop.main.run(until: Date().addingTimeInterval(0.75))
        XCTAssertEqual(detail.selectedRow, "r1", "the event reached the row")
        XCTAssertEqual(selectedImmediately, "r1", "a title click must not wait for the double-click interval")
        XCTAssertNil(detail.editingRow, "one click selects without opening the editor")
        try click(1)
        try click(2)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(detail.editingRow, "r1", "a double click still opens the editor")
    }

    func testTimelineRetriesOnlyMissingResourcesAndRows() throws {
        let rows = try termRows()
        let screen = try JSONDecoder().decode(MeetingsAPI.MeetingScreen.Result.self,
            from: Data(#"{"meeting":"m","recorded":false,"displays":[],"frames":[]}"#.utf8))
        var audioCalls = 0, waveCalls = 0, screenCalls = 0, rowCalls = 0
        let model = TimelineDockModel(reads: .init(audio: { _ in
            audioCalls += 1
            return .init(path: "/test.wav", tracks: 1, channels: 1, durationSec: 60)
        }, waveform: { _ in
            waveCalls += 1
            if waveCalls == 1 { throw CocoaError(.fileReadUnknown) }
            return .init(meeting: "m", fromSec: 0, toSec: 60, peaks: [0.2], cannot: nil)
        }, screen: { _ in
            screenCalls += 1
            return screen
        }, rows: { _ in
            rowCalls += 1
            if rowCalls == 1 { throw CocoaError(.fileReadUnknown) }
            return rows
        }), defaults: defaults)
        model.prepare("m")
        model.prepareRows("m")
        settle()
        XCTAssertEqual([audioCalls, waveCalls, screenCalls, rowCalls], [1, 1, 1, 1])
        XCTAssertNil(model.whole["m"])
        XCTAssertNil(model.otherRows["m"])

        model.prepare("m")
        model.prepare("m")
        model.prepareRows("m")
        model.prepareRows("m")
        settle()
        XCTAssertEqual([audioCalls, waveCalls, screenCalls, rowCalls], [1, 2, 1, 2])
        XCTAssertEqual(model.whole["m"]?.peaks, [0.2])
        XCTAssertEqual(model.otherRows["m"], rows.rows)

        model.prepare("m")
        model.prepareRows("m")
        settle()
        XCTAssertEqual([audioCalls, waveCalls, screenCalls, rowCalls], [1, 2, 1, 2])
    }

    private func autoplayFixture() throws -> (MeetingsWindowModel, MeetingDetailModel, MomentPlayer, ReviewRows) {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let player = MomentPlayer(engine: .init(cut: { _ in throw CancellationError() },
                                                plan: { _ in .init(moment: nil, cannot: nil) },
                                                audio: { _ in throw CancellationError() }),
                                  load: { _ in throw CancellationError() }, defaults: defaults)
        window.player = player
        window.select("m", tab: .items)
        let detail = try XCTUnwrap(window.detail)
        let rows = try termRows()
        detail.rows = .loaded(rows)
        defaults.set(MeetingsPreferences.Rows.AutoplayNext.afterAnswer.rawValue, forKey: MeetingsPreferences.Rows.autoplayNext.key)
        defaults.set(0.0, forKey: MeetingsPreferences.Rows.autoplayDelaySec.key)
        return (window, detail, player, rows)
    }

    func testForwardedMuteStopsAndReplacesExistingPlayback() throws {
        let (window, _, player, rows) = try autoplayFixture()
        player.play(rows.rows[0].target, in: "m", from: .row)
        XCTAssertNotNil(player.top)
        MeetingsWindow(primary: false).apply(MeetingsRequest.parse(["--muted"]), to: window)
        XCTAssertNil(player.top, "forwarded mute must stop the previous player")
        XCTAssertFalse(window.player === player)
    }

    func testDelayedAutoplayCannotLeaveItsMeeting() async throws {
        let (window, detail, player, rows) = try autoplayFixture()
        defer { withExtendedLifetime(window) {} }
        detail.autoplayNext(after: rows.rows[0])
        let pending = try XCTUnwrap(detail.autoplayTask)
        window.select("other", tab: .items)
        await pending.value
        XCTAssertTrue(pending.isCancelled)
        XCTAssertNil(player.top, "a dropped meeting must not resume its queued audio")
    }

    func testDelayedAutoplayCannotUseAReplacedPlayer() async throws {
        let (window, detail, player, rows) = try autoplayFixture()
        defer { withExtendedLifetime(window) {} }
        detail.autoplayNext(after: rows.rows[0])
        let pending = try XCTUnwrap(detail.autoplayTask)
        window.player = MomentPlayer(engine: .init(cut: { _ in throw CancellationError() },
                                                   plan: { _ in .init(moment: nil, cannot: nil) },
                                                   audio: { _ in throw CancellationError() }),
                                     load: { _ in throw CancellationError() }, defaults: defaults)
        await pending.value
        XCTAssertNil(player.top, "the old player must not start after replacement")
    }

    func testDelayedAutoplayCannotReplaceAnotherStoppedOrFailedMoment() async throws {
        let (window, detail, player, rows) = try autoplayFixture()
        defer { withExtendedLifetime(window) {} }
        detail.autoplayNext(after: rows.rows[0])
        let pending = try XCTUnwrap(detail.autoplayTask)
        player.play(.time(500), in: "m", from: .row)
        let selected = try XCTUnwrap(player.top?.id)
        await pending.value
        XCTAssertEqual(player.top?.id, selected, "another selection owns playback even when it is not playing")
        player.stop()
    }

    func testDelayedAutoplayStillPlaysForTheCurrentUnchangedMeeting() async throws {
        let (window, detail, player, rows) = try autoplayFixture()
        defer { withExtendedLifetime(window) {} }
        detail.autoplayNext(after: rows.rows[0])
        try await XCTUnwrap(detail.autoplayTask).value
        XCTAssertEqual(player.top?.target, rows.rows[1].target)
        player.stop()
    }

    func testPinRevealMakesFilteredRowsVisibleEvenWhenAlreadySelected() throws {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        detail.tab = .items
        let rows = try termRows()
        detail.rows = .loaded(rows)
        detail.selectedRow = "r1"
        detail.itemsFilter = .questions
        detail.reveal(row: "r1", defaults: defaults)
        XCTAssertEqual(detail.tab, .items)
        XCTAssertEqual(detail.itemsFilter, .all)
        XCTAssertTrue(detail.itemsFilter.rows(rows.rows).contains { $0.id == "r1" })

        detail.itemsFilter = .questions
        detail.reveal(row: "r1", defaults: defaults)
        XCTAssertEqual(detail.itemsFilter, .all, "the same selected id must still clear a newly incompatible filter")
        detail.itemsFilter = .suggestions
        detail.reveal(row: "r1", defaults: defaults)
        XCTAssertEqual(detail.itemsFilter, .suggestions, "a compatible filter stays in place")
    }

    func testPinRevealClearsTheFilterBeforeAnotherMeetingsRowsArrive() {
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        detail.tab = .items
        detail.itemsFilter = .questions
        detail.reveal(row: "loading-row", defaults: defaults)
        XCTAssertEqual(detail.itemsFilter, .all)
        XCTAssertEqual(detail.selectedRow, "loading-row")
    }

    func testAnOversizedSelectedRowShowsItsHeadingAtTheTop() throws {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "long", "label": "L1", "kind": "term", "status": "suggested",
            "what": String(repeating: "The heading and every answer must remain reachable in a long selected row. ", count: 120),
            "edit": "spelling", "sources": [], "parts": [], "choices": [],
            "target": ["kind": "item", "id": "long"]
        ])
        let row = try JSONDecoder().decode(ReviewRow.self, from: data)
        let ordinary = try termRows()
        detail.rows = .loaded(ReviewRows(meeting: "m", rows: Array(ordinary.rows.prefix(2)) + [row] + ordinary.rows.dropFirst(2), hidden: ordinary.hidden))
        detail.selectedRow = "long"
        let host = hostedItems(detail, height: 300)
        defer { host.orderOut(nil); host.close() }
        settle()
        let initialFrame = try XCTUnwrap(FrameProbe.frames["meetings.row.long"])
        XCTAssertGreaterThanOrEqual(initialFrame.minY, -1, "a row selected before layout must show its heading")
        detail.selectedRow = "r2"
        settle()
        detail.selectedRow = "long"
        settle()
        let frame = try XCTUnwrap(FrameProbe.frames["meetings.row.long"])
        let scroll = try XCTUnwrap(Self.scrollView(in: host.contentView))
        let viewport = scroll.contentView.convert(scroll.contentView.bounds, to: nil)
        let top = try XCTUnwrap(host.contentView).bounds.height - viewport.maxY
        XCTAssertGreaterThan(frame.height, viewport.height, "the regression needs an oversized row")
        XCTAssertGreaterThanOrEqual(frame.minY, top - 1, "the selected row's heading must not scroll above the viewport")
        XCTAssertLessThanOrEqual(frame.minY, top + 16, "the selected row starts at the viewport's top")
    }

    func testAnAnswerKeepsTheNextRowWhereItWasUntilTheReaderScrolls() throws {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        defaults.set(MeetingsPreferences.Rows.AutoplayNext.off.rawValue, forKey: MeetingsPreferences.Rows.autoplayNext.key)
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        let rows = try termRows()
        detail.rows = .loaded(rows)
        detail.selectedRow = "r1"
        let host = hostedItems(detail, height: 420)
        defer { host.orderOut(nil); host.close() }
        settle()
        let before = try XCTUnwrap(FrameProbe.frames["meetings.row.r2"], "the next row is on screen")
        let firstBefore = try XCTUnwrap(FrameProbe.frames["meetings.row.r1"])

        // What `decided` does after the service saved the answer: the row folds and the next open row is selected.
        detail.foldAnswered(rows.rows[0], entry: try confirmed("r1"))
        detail.autoplayNext(after: rows.rows[0])
        settle()
        XCTAssertEqual(detail.selectedRow, "r2")
        XCTAssertEqual(detail.rows.value?.rows.first?.status, "confirmed", "the answered row folds at once (R16)")
        let after = try XCTUnwrap(FrameProbe.frames["meetings.row.r2"])
        XCTAssertEqual(after.minY, before.minY, accuracy: 0.5, "G33: the next row keeps its screen position across the fold")

        // The reader scrolls: the held row gives its room back.
        let scroll = try XCTUnwrap(Self.scrollView(in: host.contentView), "the list scrolls")
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 40))
        scroll.reflectScrolledClipView(scroll.contentView)
        settle()
        XCTAssertTrue(detail.heldFolds.isEmpty, "a scroll releases the held height")
        let released = try XCTUnwrap(FrameProbe.frames["meetings.row.r1"])
        XCTAssertLessThan(released.height, firstBefore.height - 20, "the folded row is one line again")
    }

    func testAnAnsweredRowFoldsAtOnceWithKeepPlaceOff() throws {
        defaults.set(false, forKey: MeetingsPreferences.Rows.keepPlace.key)
        let window = MeetingsWindowModel(defaults: defaults, noticeClock: ManualNoticeClock(), service: nil, loadDetail: { _ in })
        let detail = MeetingDetailModel(id: "m", window: window)
        let rows = try termRows()
        detail.rows = .loaded(rows)
        detail.foldAnswered(rows.rows[0], entry: try confirmed("r1"))
        XCTAssertTrue(detail.heldFolds.isEmpty, "off: the row folds to one line at once")
        defaults.removeObject(forKey: MeetingsPreferences.Rows.keepPlace.key)
        detail.foldAnswered(rows.rows[1], entry: try confirmed("r2"))
        XCTAssertEqual(detail.heldFolds, ["r2"], "on by default")
        XCTAssertEqual(MeetingDetailModel.visibleRows(detail.rows.value?.rows ?? [], order: .priority, decided: .hidden,
                                                      keeping: detail.heldFolds).map(\.id),
                       ["r2", "r3", "r4", "r5"], "a hidden-when-decided row stays while it is held")
    }

    private static func scrollView(in view: NSView?) -> NSScrollView? {
        guard let view else { return nil }
        if let scroll = view as? NSScrollView { return scroll }
        for child in view.subviews { if let found = scrollView(in: child) { return found } }
        return nil
    }

    // MARK: Finding 12: a snapshot can show a playing Moment

    func testASnapshotRequestCarriesTheMomentToPlay() {
        let request = MeetingsRequest.parse(["--meeting", "m1", "--play", #"{"kind":"time","atSec":309}"#, "--snapshot", "/tmp/x.png"])
        XCTAssertEqual(request.play, .time(309))
        XCTAssertEqual(request.meeting, "m1")
        XCTAssertEqual(request.snapshot, "/tmp/x.png", "the flag after --play still reads")
        XCTAssertEqual(MeetingsRequest.parse(["--play", #"{"kind":"item","id":"i2"}"#]).play, .item("i2"))
        XCTAssertNil(MeetingsRequest.parse(["--play", "309"]).play, "a target is the engine's JSON")
        XCTAssertNil(MeetingsRequest.parse([]).play)
    }

    func testASnapshotsMomentPlaysSilently() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("meetings-silent-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1))
        do {
            let file = try AVAudioFile(forWriting: url, settings: format.settings)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1_600))
            buffer.frameLength = 1_600
            try file.write(from: buffer)
        }
        XCTAssertEqual(try AVMomentSound(url: url, muted: true).volume, 0, "the picture's Moment makes no sound")
        XCTAssertEqual(try AVMomentSound(url: url).volume, 1, "the window's Moments keep their sound")
    }

    // MARK: Finding 3: a stored 0 is a value when the setting offers it

    func testAStoredZeroIsTheValueWhenTheChoicesOfferIt() {
        let hover = MeetingsPreferences.Panes.hoverDelayMs
        XCTAssertEqual(hover.value(defaults), 300, "unset reads the default")
        defaults.set(0, forKey: hover.key)
        XCTAssertEqual(hover.value(defaults), 0, "0 ms is one of the hover delay's choices")
        defaults.set(150, forKey: hover.key)
        XCTAssertEqual(hover.value(defaults), 150)
        let depth = MeetingsPreferences.Playback.stackDepth
        defaults.set(0, forKey: depth.key)
        XCTAssertEqual(depth.value(defaults), depth.defaultValue, "0 is no choice of the stack depth: the default")
        defaults.set(-2, forKey: depth.key)
        XCTAssertEqual(depth.value(defaults), depth.defaultValue)
        let delay = MeetingsWindowSetting(key: "meetings.test.delaySec", defaultValue: 1.0, choices: [0, 0.5, 1], title: "", detail: "")
        defaults.set(0.0, forKey: delay.key)
        XCTAssertEqual(delay.value(defaults), 0, "a Double choice of 0 reads as 0")
        let speed = MeetingsPreferences.Playback.speed
        defaults.set(0.0, forKey: speed.key)
        XCTAssertEqual(speed.value(defaults), 1, "0 is no speed: the default")
    }
}
