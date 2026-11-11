import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The timeline's pure rules (the flag's seek target, the pin merge, the lens moves, the ruler) and snapshots of the
/// dock's views with an invented meeting, light and dark, at 900 pt and 1400 pt wide.
@MainActor
final class MeetingsTimelineTests: XCTestCase {
    // MARK: - Pure rules

    /// G-PLAY-3: a flag click plays from 0.3 s before the tone, so the tone is heard whole; from the spot without a
    /// tone; never before the clip starts.
    func testAFlagClickPlaysFromThreeTenthsOfASecondBeforeTheTone() {
        XCTAssertEqual(TimelineGeometry.flagSeekTarget(toneSec: 3276, spotSec: 3276.4, clipStartSec: 3266), 3275.7, accuracy: 0.0001)
        XCTAssertEqual(TimelineGeometry.flagSeekTarget(toneSec: nil, spotSec: 3276.4, clipStartSec: 3266), 3276.1, accuracy: 0.0001)
        XCTAssertEqual(TimelineGeometry.flagSeekTarget(toneSec: 3266.1, spotSec: 3266.1, clipStartSec: 3266), 3266)
        XCTAssertEqual(TimelineFixture.span.flagSeekTarget, 3275.7, accuracy: 0.0001)
    }

    /// G-PLAY-8: pins within one mark's width merge into one mark with a count, and no two marks overlap.
    func testPinsWithinAMarksWidthMergeIntoOneCountAndMarksNeverOverlap() {
        let pins = [10, 14, 17, 40, 46, 70, 300, 900].enumerated().map { index, sec in
            TimelinePin(id: "i\(index)", sec: Double(sec), text: "item \(index)", state: .open)
        }
        // 600 s over 600 pt: one second is one point; the pin at 900 s is outside the view.
        let clusters = PinCluster.clusters(pins, in: 0...600, width: 600)
        XCTAssertEqual(clusters.map { $0.pins.map(\.id) }, [["i0", "i1", "i2"], ["i3", "i4"], ["i5"], ["i6"]],
                       "40 and 46 are 6 pt apart: two 16 pt marks there drew over each other")
        XCTAssertEqual(clusters[0].x, 13.5)
        XCTAssertEqual(clusters[0].range, 10...17)
        XCTAssertEqual(clusters[1].x, 43)
        XCTAssertEqual(clusters[1].room, 27)
        XCTAssertEqual(clusters[3].room, 300)

        // A dense stretch (a pin every 8 pt) is a row of counts, never one count for all of it, and never an overlap.
        let dense = stride(from: 100.0, through: 300, by: 8).enumerated().map { index, sec in
            TimelinePin(id: "d\(index)", sec: sec, text: "d", state: .done)
        }
        let marks = PinCluster.clusters(dense, in: 0...600, width: 600)
        XCTAssertGreaterThan(marks.count, 5)
        for (before, after) in zip(marks, marks.dropFirst()) {
            XCTAssertGreaterThanOrEqual(after.x - before.x, PinMark.markWidth, "\(before.id) and \(after.id) overlap")
        }
        for mark in marks {
            XCTAssertLessThanOrEqual(abs(mark.x - (mark.range.lowerBound + mark.range.upperBound) / 2), PinMark.markWidth,
                                     "a mark stays at its pins")
        }

        // A pin just past a mark's reach is pushed clear of it, not drawn into it.
        let edge = PinCluster.clusters([100, 119, 120].enumerated().map { TimelinePin(id: "e\($0)", sec: Double($1), text: "e", state: .open) },
                                       in: 0...600, width: 600)
        XCTAssertEqual(edge.map(\.x), [109.5, 129.5])
    }

    /// D8: outside the capture the screen pane says that its picture is from another time.
    func testTheScreenPaneSaysWhenItsFrameIsFromAnotherTime() throws {
        let json = Data("""
        {"meeting":"m","recorded":true,"displays":[],"frames":[
         {"file":"a.png","path":"/x/a.png","meetingSec":60,"width":10,"height":10,"lineCount":0},
         {"file":"b.png","path":"/x/b.png","meetingSec":600,"width":10,"height":10,"lineCount":0},
         {"file":"c.png","path":"/x/c.png","meetingSec":1048,"width":10,"height":10,"lineCount":0}]}
        """.utf8)
        let screen = try JSONDecoder().decode(MeetingsAPI.MeetingScreen.Result.self, from: json)
        let last = try XCTUnwrap(TimelineDockModel.frame(in: screen, at: 3275, display: nil))
        XCTAssertEqual(last.file, "c.png")
        XCTAssertEqual(TimelineDockModel.apart(last, in: screen, at: 3275, display: nil), 2227, "the capture ended 37 min before the Moment")
        XCTAssertNil(TimelineDockModel.apart(last, in: screen, at: 1060, display: nil), "12 s after the last frame is still that screen")
        let middle = try XCTUnwrap(TimelineDockModel.frame(in: screen, at: 500, display: nil))
        XCTAssertNil(TimelineDockModel.apart(middle, in: screen, at: 500, display: nil), "inside the capture an older frame is an unchanged screen")
        let first = try XCTUnwrap(TimelineDockModel.frame(in: screen, at: 5, display: nil))
        XCTAssertEqual(TimelineDockModel.apart(first, in: screen, at: 5, display: nil), -55)
        XCTAssertEqual(ScreenBesidePlayback.caption(atSec: 1048, apartSec: 2227), "Last frame, 37 min earlier")
        XCTAssertEqual(ScreenBesidePlayback.sentence(atSec: 1048, apartSec: 2227),
                       "The screen capture ended at 17:28, 37 min before this spot. This is its last frame.")
        XCTAssertEqual(ScreenBesidePlayback.caption(atSec: 60, apartSec: -55), "First frame, 55 s later")
        XCTAssertNil(ScreenBesidePlayback.sentence(atSec: 3275, apartSec: nil))
        XCTAssertEqual(ScreenBesidePlayback.caption(atSec: 3275, apartSec: nil), "Screen at 54:35")
    }

    /// G-PLAY-5: a mark is dimmed only when every pin in it is filtered out; its state is the strongest of its pins.
    func testAMergedMarkIsDimmedOnlyWhenEveryPinIsAndTakesItsStrongestState() {
        let pins = [
            TimelinePin(id: "a", sec: 10, text: "a", state: .done, dimmed: true),
            TimelinePin(id: "b", sec: 12, text: "b", state: .question, dimmed: false),
        ]
        let mark = PinCluster.clusters(pins, in: 0...600, width: 600)[0]
        XCTAssertFalse(mark.dimmed)
        XCTAssertEqual(mark.state, .question)
        let hidden = PinCluster.clusters(pins.map { TimelinePin(id: $0.id, sec: $0.sec, text: $0.text, state: $0.state, dimmed: true) }, in: 0...600, width: 600)[0]
        XCTAssertTrue(hidden.dimmed)
    }

    /// A pin's short text is cut at a word with an ellipsis.
    func testAPinsShortTextIsCutAtAWord() {
        XCTAssertEqual(TimelinePin.shortText("\"OMP\" → \"EMP\""), "\"OMP\" → \"EMP\"")
        XCTAssertEqual(TimelinePin.shortText("Is \"DTO v2\" the same as \"the new contract\"?"), "Is \"DTO v2\" the same as…")
    }

    /// R47: the lens moves and centres inside the meeting and keeps its length.
    func testTheLensMovesAndCentresInsideTheMeetingWithItsLength() {
        let whole = 0.0...8772
        XCTAssertEqual(ConversationStrip.moved(3266...3291, by: 100, within: whole), 3366...3391)
        XCTAssertEqual(ConversationStrip.moved(3266...3291, by: -5000, within: whole), 0...25)
        XCTAssertEqual(ConversationStrip.moved(3266...3291, by: 9000, within: whole), 8747...8772)
        XCTAssertEqual(ConversationStrip.centred(0...60, at: 1000, within: whole), 970...1030)
    }

    /// The Clip view leaves a third of the clip free on each side; the Context view centres on the spot inside the meeting.
    func testTheClipViewHasAThirdFreeOnEachSideAndTheContextViewCentresOnTheSpot() {
        XCTAssertEqual(ZoomSpan(startSec: 3271, endSec: 3286, fromSec: 3276, toSec: 3281, spotSec: 3276, label: "x").fitView, 3266...3291)
        XCTAssertEqual(TimelineFixture.span.contextView(contextSec: 120, durationSec: 8772), 3216...3336)
        XCTAssertEqual(ZoomSpan(startSec: 0, endSec: 10, fromSec: 5, toSec: 6, spotSec: 5, label: "x").contextView(contextSec: 120, durationSec: 8772), 0...120)
    }

    /// 2026-11-10: two items a second apart were a "2" that no zoom took apart. On two rows they stand under each
    /// other with their texts; a third at the same place joins the first row's mark.
    func testPinsCloseInTimeStandOnRowsAndOnlyTheOverflowBecomesACount() {
        func pin(_ id: String, _ sec: Double, _ text: String = "Robertem → Róbertem") -> TimelinePin {
            TimelinePin(id: id, sec: sec, text: text, state: .done)
        }
        // 4 s over 1200 pt: a second is 300 pt.
        let two = PinCluster.laid([pin("a", 3059.0), pin("b", 3059.02)], in: 3056...3060, width: 1200, lanes: 2)
        XCTAssertEqual(two.map(\.pins.count), [1, 1], "two rows hold both, each with its text")
        XCTAssertEqual(two.map(\.lane), [0, 1])
        let three = PinCluster.laid([pin("a", 3059.0), pin("b", 3059.02), pin("c", 3059.04)], in: 3056...3060, width: 1200, lanes: 2)
        XCTAssertEqual(three.map(\.pins.count).sorted(), [1, 2], "no row has room for the third: it joins the first row's mark")
        XCTAssertEqual(three.first { $0.lane == 0 }?.pins.map(\.id), ["a", "c"])
        // Far apart: one row, the texts whole.
        let apart = PinCluster.laid([pin("a", 3056.5, "one"), pin("b", 3058.5, "two")], in: 3056...3060, width: 1200, lanes: 2)
        XCTAssertEqual(apart.map(\.lane), [0, 0])
        XCTAssertEqual(apart[0].room, 600, "the room to the next mark on the same row")
        // The first mark's text does not fit before the second pin: the second goes one row down, the text stays whole.
        let near = PinCluster.laid([pin("a", 3057.0), pin("b", 3057.2)], in: 3056...3060, width: 1200, lanes: 2)
        XCTAssertEqual(near.map(\.lane), [0, 1])
        XCTAssertEqual(PinCluster.laid([pin("a", 10), pin("b", 9000)], in: 0...100, width: 500, lanes: 2).count, 1, "a pin outside the view is left out")
    }

    func testAMarkThatNoZoomTakesApartOpensAListInsteadOfAZoom() {
        let same = PinCluster(pins: [TimelinePin(id: "a", sec: 3059, text: "a", state: .done), TimelinePin(id: "b", sec: 3059, text: "b", state: .done)],
                              x: 0, room: 0)
        XCTAssertTrue(same.expands(in: 2926...5220), "from a wide view a zoom to its 12 s shows less")
        XCTAssertFalse(same.expands(in: 3053...3065), "the view is its 12 s already: a click lists its rows")
        let wide = PinCluster(pins: [TimelinePin(id: "a", sec: 100, text: "a", state: .open), TimelinePin(id: "b", sec: 700, text: "b", state: .open)],
                              x: 0, room: 0)
        XCTAssertTrue(wide.expands(in: 0...8772))
        XCTAssertEqual(PinCluster.expanded(100...200), 90...210)
    }

    /// 2026-11-10: a view from 48:46 showed "50:00" as its first time. The ruler names the view's two ends, and a
    /// round mark that would stand in an end's label is left out.
    func testTheRulerNamesTheViewsEndsAndKeepsTheMarksOffThem() {
        let labels = TimelineGeometry.rulerLabels(in: 2926...5220, width: 1500)
        XCTAssertEqual(labels.first, RulerLabel(sec: 2926, x: 0, kind: .start))
        XCTAssertEqual(labels.last, RulerLabel(sec: 5220, x: 1500, kind: .end))
        let marks = labels.filter { $0.kind == .mark }
        XCTAssertEqual(marks.first?.sec, 3120, "52:00: the mark at 50:00 is 48 pt from the start label and is left out")
        XCTAssertTrue(marks.allSatisfy { $0.x >= 62 && $0.x <= 1500 - 62 })
        XCTAssertEqual(TimelineGeometry.rulerLabels(in: 0...600, width: 600).filter { $0.kind == .mark }.first?.sec, 120,
                       "a view from 00:00 names it once, as its start")
        XCTAssertTrue(TimelineGeometry.rulerLabels(in: 5...5, width: 600).isEmpty)
    }

    /// The waveform's colour per bar is the voice that talks longest in it; a bar nobody talks in has none.
    func testABarHasTheColourOfTheVoiceThatTalksLongestInIt() {
        let voices = [VoiceSpan(fromSec: 0, toSec: 5, color: .purple), VoiceSpan(fromSec: 4, toSec: 12, color: .green),
                      VoiceSpan(fromSec: 30, toSec: 31, color: .purple)]
        XCTAssertEqual(TimelineGeometry.barVoices(voices, view: 0...40, count: 4), [.green, .green, nil, .purple])
        XCTAssertEqual(TimelineGeometry.barVoices(voices, view: 0...10, count: 2), [.purple, .green])
        XCTAssertEqual(TimelineGeometry.barVoices([], view: 0...10, count: 2), [nil, nil])
    }

    func testTheWaveformHasEachSpeakersOwnColourAndTheLegendTheMostSpokenFirst() {
        func speaker(_ label: String, _ spoken: Double, _ turns: [(Double, Double)]) -> MeetingsAPI.MeetingSpeakers.Speaker {
            let spans = turns.map { MeetingsAPI.MeetingSpeakers.Span(fromSec: $0.0, toSec: $0.1, turns: 1) }
            return MeetingsAPI.MeetingSpeakers.Speaker(label: label, speakerId: nil, origin: "call", turns: turns.count, lines: 1, words: 1,
                                                       spokenSec: spoken, firstSec: turns.first?.0, lastSec: turns.last?.1, spans: spans, talk: spans)
        }
        let voices = TimelineDock.voices([speaker("Speaker 1", 10, [(20, 30)]), speaker("Speaker 2", 60, [(0, 20), (30, 70)])],
                                         names: ["Speaker 1": "Alice Novak"])
        XCTAssertEqual(voices.legend.map(\.name), ["Speaker 2", "Alice Novak"], "the most spoken first, by the shown name")
        XCTAssertEqual(voices.spans.map(\.fromSec), [0, 20, 30], "in the order of their start")
        XCTAssertEqual(voices.spans[1].color, KitPersonColor.color(for: "Alice Novak", among: ["Alice Novak", "Speaker 2"]),
                       "the avatar's colour: the shown name among the meeting's shown names")
        XCTAssertNotEqual(voices.spans[0].color, voices.spans[1].color)
        XCTAssertTrue(TimelineDock.coloursVoices("speakers", look: .aurora))
        XCTAssertFalse(TimelineDock.coloursVoices("plain", look: .aurora))
        XCTAssertFalse(TimelineDock.coloursVoices("speakers", look: .classic), "the classic look keeps its one colour")
    }

    /// The ruler marks fall on round seconds at least 70 pt apart; a second maps to x and back.
    func testTheRulerMarksRoundSecondsAndASecondMapsToXAndBack() {
        XCTAssertEqual(TimelineGeometry.ticks(in: 3266...3291, width: 500), [3270, 3275, 3280, 3285, 3290])
        XCTAssertEqual(TimelineGeometry.ticks(in: 0...8772, width: 900).first, 0)
        XCTAssertEqual(TimelineGeometry.x(3276, in: 3266...3291, width: 500), 200)
        XCTAssertEqual(TimelineGeometry.sec(atX: 200, in: 3266...3291, width: 500), 3276)
        XCTAssertEqual(TimelineGeometry.bars([0.1, 0.9, 0.2, 0.4], peaksRange: 0...4, view: 0...4, count: 2), [0.9, 0.4])
    }


    /// G-CARD-1: the card opens after the hover delay, stays while the pointer travels into it, closes 300 ms after
    /// both are left, and moves to another pin at once while it is open.
    func testTheCardOpensAfterTheDelayStaysWhileThePointerIsInItAndClosesAfterBothAreLeft() {
        var timing = PinCardTiming(openDelayMs: 450, closeDelayMs: 300)
        XCTAssertEqual(timing.pinChanged("i5"), 450)
        XCTAssertNil(timing.shown)
        timing.settle()
        XCTAssertEqual(timing.shown, "i5")
        XCTAssertEqual(timing.pinChanged(nil), 300)
        XCTAssertEqual(timing.cardHover(true), 0)
        timing.settle()
        XCTAssertEqual(timing.shown, "i5", "the pointer reached the card within the close delay")
        XCTAssertEqual(timing.pinChanged("q12"), 0, "another pin while the card is open moves it at once")
        timing.settle()
        XCTAssertEqual(timing.shown, "q12")
        _ = timing.pinChanged(nil)
        XCTAssertEqual(timing.cardHover(false), 300)
        timing.settle()
        XCTAssertNil(timing.shown)
        _ = timing.pinChanged("i3")
        timing.close()
        timing.settle()
        XCTAssertNil(timing.shown, "Esc closes at once")
    }

    /// A pin of a review row stands at its first `when` part, with its state from the row.
    func testAPinOfAReviewRowStandsAtItsTimeWithItsState() throws {
        let pin = try XCTUnwrap(TimelinePin(row: TimelineFixture.questionRow))
        XCTAssertEqual(pin.sec, 6588)
        XCTAssertEqual(pin.state, .question)
        XCTAssertEqual(TimelinePin(row: TimelineFixture.questionRow, playing: true)?.state, .playing)
    }

    /// The pins follow `meetings.rows.stateLook`: hue and glyph by default, the older flags and tints under Shade.
    func testThePinsFollowTheStateLookSetting() {
        let rejected = TimelinePin(id: "r", sec: 1, text: "x", state: .rejected)
        XCTAssertEqual(rejected.symbol(.hueAndGlyph), "xmark")
        XCTAssertEqual(rejected.symbol(.shade), "checkmark", "the shade look has no rejected pin of its own")
        XCTAssertEqual(TimelinePin.State.rejected.hue(.shade), .done)
        let open = TimelinePin(id: "o", sec: 1, text: "x", state: .open)
        XCTAssertEqual(open.symbol(.hueAndGlyph), "sparkles")
        XCTAssertEqual(open.symbol(.shade), "flag.fill")
        XCTAssertEqual(TimelinePin.State.open.hue(.hueAndGlyph), .play)
        XCTAssertEqual(TimelinePin.State.open.hue(.shade), .care)
        XCTAssertEqual(TimelinePin(id: "p", sec: 1, text: "x", state: .playing).symbol(.shade), "flag.fill")
    }

    // MARK: - Snapshots

    func testSnapshotsOfTheZoomedTimeline() throws {
        for width in TimelineSnapshot.widths {
            for scheme in TimelineSnapshot.schemes {
                try TimelineSnapshot.write(
                    MomentTimeline(span: TimelineFixture.span, view: TimelineFixture.span.fitView, peaks: TimelineFixture.zoomPeaks, peaksRange: TimelineFixture.zoomRange,
                                   position: { 3277.2 }, offerMore: false)
                        .padding(12),
                    name: "moment-timeline", width: width, scheme: scheme)
            }
        }
        try TimelineSnapshot.write(
            MomentTimeline(span: TimelineFixture.rangeSpan, view: TimelineFixture.rangeSpan.contextView(contextSec: 60, durationSec: 8772), peaks: TimelineFixture.zoomPeaks, peaksRange: TimelineFixture.zoomRange,
                           position: { 6590 }, offerMore: true, zoomedOut: true)
                .padding(12),
            name: "moment-timeline-range-ended", width: 900, scheme: .dark)
        try TimelineSnapshot.write(
            MomentTimeline(span: nil, view: TimelineFixture.whole, peaks: TimelineFixture.peaks, peaksRange: TimelineFixture.whole,
                           position: { 6590 }, pins: TimelineFixture.pins)
                .padding(12),
            name: "moment-timeline-meeting", width: 1400, scheme: .dark)
    }

    func testSnapshotsOfTheConversationStrip() throws {
        for width in TimelineSnapshot.widths {
            for scheme in TimelineSnapshot.schemes {
                try TimelineSnapshot.write(
                    VStack(spacing: 0) {
                        ConversationStrip(durationSec: TimelineFixture.whole.upperBound, peaks: TimelineFixture.peaks, zoom: 3266...3291,
                                          position: { 3277.2 }, pins: TimelineFixture.pins)
                        ZoomConnector(zoom: 3266...3291, durationSec: TimelineFixture.whole.upperBound)
                    }
                    .padding(12),
                    name: "conversation-strip", width: width, scheme: scheme)
            }
        }
    }

    func testSnapshotsOfThePinCard() throws {
        for scheme in TimelineSnapshot.schemes {
            try TimelineSnapshot.write(PinCard(row: TimelineFixture.questionRow).background(.regularMaterial).padding(12),
                                       name: "pin-card", width: 420, scheme: scheme)
        }
    }

    func testSnapshotsOfThePlayingRowBarAndTheBreadcrumb() throws {
        for scheme in TimelineSnapshot.schemes {
            try TimelineSnapshot.write(
                VStack(alignment: .leading, spacing: 14) {
                    Text(verbatim: "\"OMP\" → \"EMP\"").font(.system(size: 13, weight: .semibold))
                    PlayingRowBar(span: TimelineFixture.span, position: { 3277.2 })
                    Text(verbatim: "Jonas Petr names the employee segment value after rejecting ZAME.").font(.system(size: 12)).foregroundStyle(.secondary)
                    StackBreadcrumb(meeting: "Backend DTO design review", moments: [
                        .init(id: "a", title: "Q12"), .init(id: "b", title: "1:49:48"),
                    ])
                    StackBreadcrumb(meeting: "Backend DTO design review", moments: [.init(id: "a", title: "\"OMP\" → \"EMP\" · 54:36")], isPlaying: false)
                }
                .padding(16),
                name: "row-bar-breadcrumb", width: 520, scheme: scheme)
        }
    }

    func testSnapshotsOfTheDock() throws {
        for width in TimelineSnapshot.widths {
            for scheme in TimelineSnapshot.schemes {
                try TimelineSnapshot.write(TimelineDockBody(state: TimelineFixture.dock, position: { 3277.2 }),
                                           name: "dock", width: width, scheme: scheme)
            }
        }
        var meeting = TimelineFixture.dock
        meeting.zoom = .meeting
        meeting.view = TimelineFixture.whole
        meeting.zoomPeaks = TimelineFixture.peaks
        meeting.zoomPeaksRange = TimelineFixture.whole
        try TimelineSnapshot.write(TimelineDockBody(state: meeting, position: { 3277.2 }), name: "dock-meeting", width: 1400, scheme: .dark)
        try TimelineSnapshot.write(TimelineDockBody(state: TimelineFixture.dock, position: { 3277.2 }) {
            RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.6)).frame(height: 190)
                .overlay(Text(verbatim: "Screen pane (transcript lane)").foregroundStyle(.secondary))
        }, name: "dock-with-screen", width: 1400, scheme: .dark)
        for scheme in TimelineSnapshot.schemes {
            try TimelineSnapshot.write(TimelineDockBody(state: TimelineFixture.dock, position: { 3277.2 }, collapsed: true),
                                       name: "dock-collapsed", width: 900, scheme: scheme)
        }
    }
}

// MARK: - TimelineFixture: an invented two-and-a-half hour design review

enum TimelineFixture {
    static let whole: ClosedRange<Double> = 0...8772

    /// Deterministic speech-like peaks, one per 10 s.
    static let peaks: [Double] = (0..<878).map { index in
        let wave = (sin(Double(index) * 0.37) + sin(Double(index) * 1.91) * 0.6 + 1.6) / 3.2
        return index % 47 < 3 ? 0.05 : min(1, max(0.08, wave))
    }

    /// Finer peaks around the two Moments (what the wiring asks `meeting.waveform` for the zoomed view), 5 per second.
    static let zoomRange: ClosedRange<Double> = 3200...6700
    static let zoomPeaks: [Double] = (0..<17_500).map { index in
        let syllable = abs(sin(Double(index) * 0.9)) * 0.7 + abs(sin(Double(index) * 0.23)) * 0.3
        return index % 37 < 4 ? 0.06 : min(1, max(0.1, syllable))
    }

    static let span = ZoomSpan(startSec: 3266, endSec: 3291, fromSec: 3276, toSec: 3281, spotSec: 3276, toneSec: 3276,
                               label: "\"OMP\" → \"EMP\"")

    static let rangeSpan = ZoomSpan(startSec: 6583, endSec: 6607, fromSec: 6588, toSec: 6602, spotSec: 6588, toneSec: 6588,
                                    isRange: true, label: "Who says this?")

    static let questionRow = ReviewRow(
        id: "q12", label: "Q12", kind: "question", status: "suggested", confidence: 0.82, priority: 0.9,
        what: "Who says this between 1:49:48 and 1:50:02?",
        parts: [
            .when(from: ClockTime(sec: 6588, text: "1:49:48"), to: ClockTime(sec: 6602, text: "1:50:02"), target: .range(from: 6588, to: 6602)),
            .said(text: "Can we rename working to staging before the release, or does the pipeline still read the old name?",
                  speaker: "Speaker 3", context: nil),
            .asks([TextPiece(text: "Which speaker says the line between 1:49:48 and 1:50:02?")]),
            .settles(text: "This answers \"Can we rename working to staging?\" at 1:51:10, and 2 speaker items.", items: ["i8", "i9"]),
            .reason([TextPiece(text: "The diarization split one voice into Speaker 3 and Speaker 5 around 1:49.")]),
        ],
        choices: [
            RowChoice(value: "Mira Holt", label: "Mira Holt", role: "candidate", action: ChoiceAction(kind: "answer", answer: "Mira Holt"), confidence: 0.34, hint: nil),
            RowChoice(value: "Jonas Petr", label: "Jonas Petr", role: "candidate", action: ChoiceAction(kind: "answer", answer: "Jonas Petr"), confidence: 0.58, hint: nil),
            RowChoice(value: "skip", label: "Skip", role: "skip", action: ChoiceAction(kind: "skip"), confidence: nil, hint: nil),
        ],
        edit: "person", needs: "speaker",
        sources: [
            .line(at: ClockTime(sec: 6588, text: "1:49:48"), line: 1412, text: "Can we rename working to staging before the release?"),
            .document(path: "/Users/example/notes/pipeline-naming.md", line: 14),
        ],
        target: .range(from: 6588, to: 6602), decision: nil)

    static var dock: TimelineDockState {
        TimelineDockState(
            meetingTitle: "Backend DTO design review",
            moments: [.init(id: "m1", title: "\"OMP\" → \"EMP\" · 54:36")],
            isPlaying: true, span: span, zoom: .clip, view: span.fitView, durationSec: whole.upperBound,
            wholePeaks: peaks, zoomPeaks: zoomPeaks, zoomPeaksRange: zoomRange, pins: pins, offerMore: false)
    }

    static let pins: [TimelinePin] = [
        TimelinePin(id: "i1", sec: 760, text: "\"basket sladovat\"", state: .done),
        TimelinePin(id: "i2", sec: 1860, text: "\"Kafka topik\"", state: .done),
        TimelinePin(id: "i3", sec: 2480, text: "\"mapstrakt\"", state: .open),
        TimelinePin(id: "i4", sec: 3160, text: "\"null safety chek\"", state: .done, dimmed: true),
        TimelinePin(id: "i5", sec: 3276, text: "\"OMP\" → \"EMP\"", state: .playing),
        TimelinePin(id: "i6", sec: 4860, text: "\"Speaker 3\" is Jonas Petr", state: .done),
        TimelinePin(id: "q12", sec: 6588, text: "Q12 Who says this?", state: .question),
        TimelinePin(id: "q13", sec: 6600, text: "Q13", state: .question),
        TimelinePin(id: "q14", sec: 6610, text: "Q14", state: .question),
        TimelinePin(id: "i7", sec: 7410, text: "\"provenance\"", state: .open),
        TimelinePin(id: "q15", sec: 7920, text: "Q15 Is \"DTO v2\" the new contract?", state: .question),
    ]
}

// MARK: - TimelineSnapshot writer

enum TimelineSnapshot {
    static let widths: [CGFloat] = [900, 1400]
    static let schemes: [ColorScheme] = [.light, .dark]
    /// `MEETINGS_UI_SNAPSHOTS=<folder>` keeps the pictures; without it they go to the temporary folder, so a test run
    /// never writes into a notes folder.
    static var folder: URL {
        if let path = ProcessInfo.processInfo.environment["MEETINGS_UI_SNAPSHOTS"], !path.isEmpty {
            return URL(fileURLWithPath: path)
        }
        return FileManager.default.temporaryDirectory
    }

    /// Renders `view` at `width` on the window background of `scheme` and writes `<name>-<width>-<scheme>.png` into
    /// `folder`.
    @MainActor
    static func write<V: View>(_ view: V, name: String, width: CGFloat, scheme: ColorScheme) throws {
        let content = view
            .frame(width: width)
            .background(scheme == .dark ? Color(white: 0.15) : Color(white: 0.97))
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage, "\(name) did not render")
        let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try png.write(to: folder.appendingPathComponent("\(name)-\(Int(width))-\(scheme == .dark ? "dark" : "light").png"))
    }
}
