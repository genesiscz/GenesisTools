import AppKit
import XCTest
@testable import GenesisToolsMeetings

/// A sound that plays nothing, for the player's stack rules.
@MainActor
private final class SilentSound: MomentSound {
    var currentTime: TimeInterval = 0
    let duration: TimeInterval = 30
    var rate: Float = 1
    private(set) var isPlaying = false
    var onEnd: (@MainActor () -> Void)?

    func play() { isPlaying = true }
    func pause() { isPlaying = false }
    func stop() {
        isPlaying = false
        onEnd = nil
    }
}

/// The wiring of the timeline lane (F9): what the dock shows, the reads it keeps, the screen frame, the keys, a pin's
/// row, the transcript's marks and the player calls behind the breadcrumb and the 5 s buttons.
extension MeetingsTimelineTests {
    private func suite() throws -> (UserDefaults, String) {
        let name = "meetings.timeline.wiring.\(UUID().uuidString)"
        return (try XCTUnwrap(UserDefaults(suiteName: name)), name)
    }

    private static let noReads = TimelineDockModel.Reads(
        audio: { _ in throw MeetingsService.Unavailable(reason: "test") },
        waveform: { _ in throw MeetingsService.Unavailable(reason: "test") },
        screen: { _ in throw MeetingsService.Unavailable(reason: "test") },
        rows: { _ in throw MeetingsService.Unavailable(reason: "test") })

    // MARK: What the timeline shows (R1, R4, R47)

    func testTheDockShowsTheClipTheContextOrTheMeetingAndALensRangeOnlyForItsOwnLayer() {
        let span = TimelineFixture.span
        let layer = UUID()
        func view(_ zoom: DockZoom, override: TimelineDockModel.ViewOverride? = nil, span: ZoomSpan? = span) -> ClosedRange<Double> {
            TimelineDockModel.view(zoom: zoom, span: span, override: override, layer: layer, contextSec: 120, durationSec: 8772)
        }
        XCTAssertEqual(view(.clip), span.fitView)
        XCTAssertEqual(view(.context), span.contextView(contextSec: 120, durationSec: 8772))
        XCTAssertEqual(view(.meeting), 0...8772)
        XCTAssertEqual(view(.clip, span: nil), 0...8772, "a whole-meeting play has no clip: it shows the meeting")
        XCTAssertEqual(TimelineDockModel.effectiveZoom(.clip, span: nil), .meeting)
        XCTAssertEqual(view(.clip, override: .init(layer: layer, range: 100...200)), 100...200, "the lens range of this layer")
        XCTAssertEqual(view(.clip, override: .init(layer: UUID(), range: 100...200)), span.fitView,
                       "a new top shows its own clip again, not the lens range of the one before")
    }

    func testZoomStepsHoldAtTheEndsAndAZoomChangeDropsTheLensRange() throws {
        let (defaults, name) = try suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let dock = TimelineDockModel(reads: Self.noReads, defaults: defaults)
        XCTAssertEqual(dock.zoom, .clip, "meetings.playback.view moment opens on the clip")
        let layer = UUID()
        dock.setView(10...20, layer: layer)
        dock.stepZoom(out: true)
        XCTAssertEqual(dock.zoom, .context)
        XCTAssertNil(dock.viewOverride, "⌘- shows the context, not the lens range")
        dock.stepZoom(out: true)
        dock.stepZoom(out: true)
        XCTAssertEqual(dock.zoom, .meeting, "the end holds")
        dock.stepZoom(out: false)
        dock.stepZoom(out: false)
        dock.stepZoom(out: false)
        XCTAssertEqual(dock.zoom, .clip)
        defaults.set(MeetingsPreferences.Playback.View.meeting.rawValue, forKey: MeetingsPreferences.Playback.view.key)
        XCTAssertEqual(TimelineDockModel.defaultZoom(defaults), .meeting, "meetings.playback.view meeting opens on the meeting")
    }

    func testFinerPeaksCoverAViewOnlyAtAboutItsScaleAndAreAskedWiderThanTheView() {
        XCTAssertTrue(TimelineDockModel.covers(90...210, 100...200))
        XCTAssertFalse(TimelineDockModel.covers(110...210, 100...200), "a view past the held peaks asks again")
        XCTAssertFalse(TimelineDockModel.covers(0...8772, 100...200), "the whole meeting's bars are too coarse for 100 s")
        XCTAssertEqual(TimelineDockModel.widened(100...200, durationSec: 8772), 0...300)
        XCTAssertEqual(TimelineDockModel.widened(8700...8772, durationSec: 8772), 8628...8772, "never past the meeting's end")
    }

    func testTheZoomedPeaksAreTheFinerOnesWhenTheyCoverTheViewElseTheWholeMeetings() async throws {
        let (defaults, name) = try suite()
        defer { defaults.removePersistentDomain(forName: name) }
        var asked: [MeetingsAPI.MeetingWaveform.Params] = []
        let reads = TimelineDockModel.Reads(
            audio: { meeting in MeetingsAPI.MeetingAudio.Result(path: "/tmp/\(meeting).m4a", tracks: 1, channels: 1, durationSec: 8772) },
            waveform: { params in
                asked.append(params)
                let from = params.fromSec ?? 0, to = params.toSec ?? 8772
                return MeetingsAPI.MeetingWaveform.Result(meeting: params.meeting, fromSec: from, toSec: to,
                                                          peaks: Array(repeating: params.fromSec == nil ? 0.2 : 0.8, count: params.buckets),
                                                          cannot: nil)
            },
            screen: { _ in throw MeetingsService.Unavailable(reason: "test") },
            rows: { _ in throw MeetingsService.Unavailable(reason: "test") })
        let dock = TimelineDockModel(reads: reads, defaults: defaults)
        dock.prepare("m")
        dock.prepare("m")
        try await until("the whole peaks and the length land") { dock.whole["m"] != nil && dock.audio["m"] != nil }
        XCTAssertEqual(asked.count, 1, "the whole meeting's peaks are read once per meeting")
        XCTAssertEqual(dock.durationSec("m", fallback: 10), 8772, "the recording's length wins over the overview's")
        XCTAssertEqual(dock.zoomPeaks("m", view: 100...200, durationSec: 8772).range, 0...8772, "until the finer ones land")
        dock.ensureZoomPeaks("m", view: 100...200, durationSec: 8772)
        try await until("the finer peaks land") { dock.zoomed != nil }
        XCTAssertEqual(asked.last?.fromSec, 0)
        XCTAssertEqual(asked.last?.toSec, 300)
        XCTAssertEqual(dock.zoomPeaks("m", view: 100...200, durationSec: 8772).range, 0...300)
        dock.ensureZoomPeaks("m", view: 120...220, durationSec: 8772)
        XCTAssertEqual(asked.count, 2, "a view the held peaks cover asks nothing")
    }

    // MARK: The screen beside the sound (R41, G-SCR-1)

    func testTheScreenPaneShowsTheLastFrameAtOrBeforeThePlayheadOnItsDisplay() throws {
        let json = #"""
        {"meeting":"m","recorded":true,"displays":[{"id":1,"name":"Built-in","frames":2},{"id":2,"name":"Studio","frames":3}],
         "frames":[{"file":"a","path":"/f/a.png","meetingSec":10,"displayId":2,"width":10,"height":10,"lineCount":1},
                   {"file":"b","path":"/f/b.png","meetingSec":20,"displayId":1,"width":10,"height":10,"lineCount":1},
                   {"file":"c","path":"/f/c.png","meetingSec":30,"displayId":2,"width":10,"height":10,"lineCount":1},
                   {"file":"d","path":"/f/d.png","meetingSec":40,"displayId":1,"width":10,"height":10,"lineCount":1},
                   {"file":"e","path":"/f/e.png","meetingSec":50,"displayId":2,"width":10,"height":10,"lineCount":1}]}
        """#
        let screen = try JSONDecoder().decode(MeetingsAPI.MeetingScreen.Result.self, from: Data(json.utf8))
        XCTAssertEqual(TimelineDockModel.frame(in: screen, at: 35, display: nil)?.file, "c")
        XCTAssertEqual(TimelineDockModel.frame(in: screen, at: 35, display: 1)?.file, "b")
        XCTAssertEqual(TimelineDockModel.frame(in: screen, at: 5, display: nil)?.file, "a", "before the first frame: the first one")
        XCTAssertEqual(TimelineDockModel.frame(in: screen, at: 999, display: 2)?.file, "e")
        XCTAssertEqual(TimelineDockModel.autoDisplay(screen: screen, moment: nil), 2, "without a hit: the display most frames show")
    }

    // MARK: Keys (G-KEY-1, G-STACK-2)

    func testThePlayerKeysAreSpaceTheArrowsTheBracketsAndEscWithoutCommand() {
        XCTAssertEqual(MeetingsPlaybackKeys.key(keyCode: 49, characters: " ", modifiers: []), .space)
        XCTAssertEqual(MeetingsPlaybackKeys.key(keyCode: 123, characters: nil, modifiers: [.function, .numericPad]), .left)
        XCTAssertEqual(MeetingsPlaybackKeys.key(keyCode: 124, characters: nil, modifiers: []), .right)
        XCTAssertEqual(MeetingsPlaybackKeys.key(keyCode: 33, characters: "[", modifiers: []), .previousPin)
        XCTAssertEqual(MeetingsPlaybackKeys.key(keyCode: 30, characters: "]", modifiers: []), .nextPin)
        XCTAssertEqual(MeetingsPlaybackKeys.key(keyCode: 53, characters: "\u{1b}", modifiers: []), .escape)
        XCTAssertNil(MeetingsPlaybackKeys.key(keyCode: 49, characters: " ", modifiers: [.command]), "⌘Space is the system's")
        XCTAssertNil(MeetingsPlaybackKeys.key(keyCode: 0, characters: "a", modifiers: []))
    }

    func testTheBracketsStepToTheNextAndThePreviousPinAndTheEndsHold() {
        let seconds: [Double] = [10, 40, 90]
        XCTAssertEqual(MeetingsPlaybackKeys.nextPin(seconds, from: nil, forward: true), 0)
        XCTAssertEqual(MeetingsPlaybackKeys.nextPin(seconds, from: nil, forward: false), 2)
        XCTAssertEqual(MeetingsPlaybackKeys.nextPin(seconds, from: 40, forward: true), 2)
        XCTAssertEqual(MeetingsPlaybackKeys.nextPin(seconds, from: 40, forward: false), 0)
        XCTAssertNil(MeetingsPlaybackKeys.nextPin(seconds, from: 90, forward: true), "past the last pin nothing is selected")
        XCTAssertEqual(MeetingsPlaybackKeys.nextPin(seconds, from: 55, forward: false), 1, "from the playhead between pins")
    }

    // MARK: A pin's row (R3, G-PLAY-5)

    func testAPinOnADecidedRowThatTheListHidesShowsDecidedRowsAgainWithAnUndo() throws {
        let (defaults, name) = try suite()
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(MeetingsPreferences.Rows.Decided.hidden.rawValue, forKey: MeetingsPreferences.Rows.decided.key)
        let notices = NoticeStackModel(clock: ManualNoticeClock(), announces: false)
        let detail = MeetingDetailModel(id: "m", window: nil, notices: notices, service: nil)
        var decided = TimelineFixture.questionRow
        decided.status = "confirmed"
        detail.rows = .loaded(try rows([TimelineFixture.questionRow, decided], ids: ["q1", "q2"]))
        detail.tab = .transcript

        detail.reveal(row: "q1", defaults: defaults)
        XCTAssertEqual(detail.tab, .items, "a pin switches to the tab that holds its row")
        XCTAssertEqual(detail.selectedRow, "q1")
        XCTAssertTrue(notices.notices.isEmpty, "an open row is in the list: nothing to undo")

        detail.reveal(row: "q2", defaults: defaults)
        XCTAssertEqual(detail.selectedRow, "q2")
        XCTAssertEqual(MeetingsPreferences.Rows.decided.value(defaults), .inPlace, "the decided row shows again")
        let notice = try XCTUnwrap(notices.notices.last)
        XCTAssertTrue(notice.text.contains("Q12"), notice.text)
        let undo = try XCTUnwrap(notice.actions.first)
        notices.press(undo, of: notice.id)
        XCTAssertEqual(MeetingsPreferences.Rows.decided.value(defaults), .hidden, "Undo hides decided rows again")
    }

    private func rows(_ rows: [ReviewRow], ids: [String]) throws -> ReviewRows {
        let encoded = zip(rows, ids).map { row, id in
            #"{"id":"\#(id)","label":"\#(row.label)","kind":"\#(row.kind)","status":"\#(row.status)","what":"w","edit":"none","sources":[],"parts":[],"choices":[],"target":{"kind":"item","id":"\#(id)"}}"#
        }.joined(separator: ",")
        let json = #"{"meeting":"m","rows":[\#(encoded)],"hidden":{"lowPriority":0,"minPriority":0}}"#
        return try JSONDecoder().decode(ReviewRows.self, from: Data(json.utf8))
    }

    // MARK: The transcript (R42, G57, G-TR-1)

    func testTheEnginesLineEndWinsOverTheNextLinesStart() {
        let entries = [
            TranscriptLine(id: "a", startSec: 10, speaker: "Mira", text: "one", endSec: 12),
            TranscriptLine(id: "b", startSec: 20, speaker: "Mira", text: "two"),
        ]
        let blocks = TranscriptBlock.build(from: entries, durationSec: 30)
        XCTAssertEqual(blocks.first?.lines.map(\.endSec), [12, 30])
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: 15), "the silence after a line's end is no line")
        XCTAssertEqual(TranscriptBlock.heard(in: blocks, at: 21)?.lineID, "b")
    }

    func testLineMarksNameTheUnclearTheCorrectedAndTheCommentedLines() throws {
        let entries = [
            TranscriptLine(id: "a", startSec: 10, speaker: "S1", text: "one"),
            TranscriptLine(id: "b", startSec: 20, speaker: "S1", text: "two"),
            TranscriptLine(id: "c", startSec: 30, speaker: "S2", text: "three"),
            TranscriptLine(id: "d", startSec: nil, speaker: "S2", text: "untimed"),
        ]
        let hint = try JSONDecoder().decode(SpeakerHint.self, from: Data(#"{"kind":"several-people","label":"S1","ranges":[{"lines":2,"fromSec":5,"toSec":15}]}"#.utf8))
        let item = try JSONDecoder().decode(MeetingItem.self, from: Data(#"{"id":"i1","kind":"term","status":"confirmed","fromSec":19,"toSec":21}"#.utf8))
        let comment = try JSONDecoder().decode(MeetingComment.self, from: Data(#"""
        {"id":"c1","at":"2026-11-09T17:32:38.000Z","target":{"kind":"selection","from":{"atSec":28},"to":{"atSec":31}},
         "text":"x","actor":{"kind":"window"},"state":"staged"}
        """#.utf8))
        let marks = MeetingDetailModel.lineMarks(entries: entries, hints: [hint], items: [item], comments: [comment])
        XCTAssertEqual(marks["a"], [.unclearSpeaker])
        XCTAssertEqual(marks["b"], [.corrected])
        XCTAssertEqual(marks["c"], [.commented])
        XCTAssertNil(marks["d"])
    }

    // MARK: The dock's folds and pins

    func testTheDockFoldsToOneLineBelow560PointsOrWithTheTimelineOff() {
        XCTAssertFalse(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 800))
        XCTAssertTrue(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 540))
        XCTAssertTrue(MeetingsPlayerBar.collapses(timelineShown: false, windowHeight: 1200))
        XCTAssertFalse(MeetingsPlayerBar.collapses(timelineShown: true, windowHeight: 0), "before the window is known: the full dock")
    }

    func testAMergedPinOpensItsSecondsWithRoomAndAtLeastTenSeconds() {
        XCTAssertEqual(TimelineDock.widened(100...200), 90...210, "10 % of room each side")
        XCTAssertEqual(TimelineDock.widened(100...101), 94.5...106.5)
        XCTAssertEqual(TimelineDock.widened(0...2).lowerBound, 0, "never before the meeting's start")
    }

    func testTheSpeakersBannersAreTheOpenQuestionsWithATime() {
        var answered = TimelineFixture.questionRow
        answered.status = "confirmed"
        let banners = SpeakersTab.questions([TimelineFixture.questionRow, answered])
        XCTAssertEqual(banners.map(\.id), ["q12"])
        XCTAssertEqual(banners.first?.atSec, 6588)
        XCTAssertEqual(banners.first?.label, "Q12")
    }

    // MARK: The player behind the breadcrumb and the 5 s buttons

    func testTheBreadcrumbPopsEveryMomentAboveTheOneClickedInOneStep() async throws {
        let (defaults, name) = try suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let player = makePlayer(defaults)
        player.play(.time(100), in: "m", from: .row)
        try await until("the first Moment plays") { player.phase == .playing }
        player.play(.time(200), in: "m", from: .speakerChip)
        try await until("the second plays") { player.stack.count == 2 && player.phase == .playing }
        player.play(.time(300), in: "m", from: .speakerChip)
        try await until("the third plays") { player.stack.count == 3 && player.phase == .playing }
        player.pop(to: 0)
        XCTAssertEqual(player.stack.count, 1)
        XCTAssertEqual(player.top?.target, .time(100), "the bottom Moment plays again")
        player.pop(to: 0)
        XCTAssertEqual(player.stack.count, 1, "the top itself is no Moment below")
    }

    func testTheFiveSecondButtonsSeekInsideTheClipAndNeverBeforeTheMeetingsStart() async throws {
        let (defaults, name) = try suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let player = makePlayer(defaults)
        player.play(.time(100), in: "m", from: .row)
        try await until("the Moment plays") { player.phase == .playing }
        let top = try XCTUnwrap(player.top)
        player.skip(by: 5)
        XCTAssertEqual(player.top?.id, top.id, "inside the clip it seeks, the Moment stays")
        player.skip(by: -500)
        XCTAssertEqual(player.top?.target, .time(0), "outside the clip the Moment at that time takes its place, from 0")
    }

    // MARK: Snapshot of the wired dock

    /// The dock as the window draws it: the real player with a Moment on top, the dock model's peaks, the open meeting's
    /// rows as pins, at 900 pt and 1400 pt, light and dark (`MEETINGS_UI_SNAPSHOTS` keeps the PNGs).
    func testSnapshotsOfTheWiredDock() async throws {
        let (defaults, name) = try suite()
        defer { defaults.removePersistentDomain(forName: name) }
        let reads = TimelineDockModel.Reads(
            audio: { meeting in MeetingsAPI.MeetingAudio.Result(path: "/tmp/\(meeting).m4a", tracks: 1, channels: 1, durationSec: 8772) },
            waveform: { params in
                let from = params.fromSec ?? 0, to = params.toSec ?? 8772
                let peaks = params.fromSec == nil ? TimelineFixture.peaks
                    : (0..<params.buckets).map { index in abs(sin(Double(index) * 0.9)) * 0.7 + 0.2 }
                return MeetingsAPI.MeetingWaveform.Result(meeting: params.meeting, fromSec: from, toSec: to, peaks: peaks, cannot: nil)
            },
            screen: { _ in throw MeetingsService.Unavailable(reason: "test") },
            rows: { _ in throw MeetingsService.Unavailable(reason: "test") })
        let window = MeetingsWindowModel(defaults: defaults, loadDetail: { _ in })
        window.player = makePlayer(defaults, timeline: TimelineDockModel(reads: reads, defaults: defaults))
        window.select("m")
        let word = ReviewRow(
            id: "i5", label: "i5", kind: "term", status: "suggested", confidence: 0.82, priority: 0.5, what: "\"OMP\" → \"EMP\"",
            parts: [.when(from: ClockTime(sec: 3276, text: "54:36"), to: nil, target: .time(3276))],
            choices: [], edit: "spelling", needs: nil, sources: [], target: .time(3276), decision: nil)
        var shown = try rows([], ids: [])
        shown.rows = [word, TimelineFixture.questionRow]
        window.detail?.rows = .loaded(shown)
        window.player.play(.time(3276), in: "m", from: .row)
        try await until("the Moment plays") { window.player.phase == .playing }
        window.player.timeline.prepare("m")
        try await until("the peaks land") { window.player.timeline.whole["m"] != nil && window.player.timeline.audio["m"] != nil }
        let span = try XCTUnwrap(window.player.top.flatMap(TimelineDock.span(of:)))
        window.player.timeline.ensureZoomPeaks("m", view: span.fitView, durationSec: 8772)
        try await until("the finer peaks land") { window.player.timeline.zoomed != nil }
        for width in TimelineSnapshot.widths {
            for scheme in TimelineSnapshot.schemes {
                try TimelineSnapshot.write(MeetingsPlayerBar(player: window.player, title: "Backend DTO design review", window: window),
                                           name: "wired-dock", width: width, scheme: scheme)
            }
        }
    }

    private func makePlayer(_ defaults: UserDefaults, timeline: TimelineDockModel? = nil) -> MomentPlayer {
        let engine = MomentPlayer.Engine(
            cut: { params in
                let at = params.target.startSec ?? 100
                let moment = Moment(meeting: params.meeting, target: params.target, label: "at \(at)", fromSec: at, toSec: at + 5,
                                    padSec: 5, startSec: max(0, at - 5), endSec: at + 10, spotSec: at, tone: nil, delaySec: 0,
                                    repeatGapSec: nil, screen: nil)
                return MomentClip(moment: moment, path: "/tmp/moment-\(at).wav")
            },
            plan: { _ in MeetingsAPI.MomentPlan.Result(moment: nil, cannot: nil) },
            audio: { _ in throw MeetingsService.Unavailable(reason: "test") })
        return MomentPlayer(engine: engine, load: { _ in SilentSound() }, defaults: defaults,
                            timeline: timeline ?? TimelineDockModel(reads: Self.noReads, defaults: defaults))
    }

    private func until(_ what: String, timeout: TimeInterval = 3, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { return XCTFail("timed out waiting until \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
