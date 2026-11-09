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

    /// G-PLAY-8: pins closer than 6 pt merge into one mark with a count; a chain merges whole; 6 pt apart stay two.
    func testPinsCloserThanSixPointsMergeIntoOneCountAndAChainMergesWhole() {
        let pins = [10, 14, 17, 40, 46, 300, 900].enumerated().map { index, sec in
            TimelinePin(id: "i\(index)", sec: Double(sec), text: "item \(index)", state: .open)
        }
        // 600 s over 600 pt: one second is one point; the pin at 900 s is outside the view.
        let clusters = PinCluster.clusters(pins, in: 0...600, width: 600)
        XCTAssertEqual(clusters.map { $0.pins.map(\.id) }, [["i0", "i1", "i2"], ["i3"], ["i4"], ["i5"]])
        XCTAssertEqual(clusters[0].x, 13.5)
        XCTAssertEqual(clusters[0].range, 10...17)
        XCTAssertEqual(clusters[1].room, 6)
        XCTAssertEqual(clusters[3].room, 300)
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
    static let folder = URL(fileURLWithPath: "/Users/Martin/Tresors/Projects/GenesisBrain/GenesisTools/GenesisTools.native/Meetings/UxRefinements/2026-11-09/UIPrep/timeline")

    /// Renders `view` at `width` on the window background of `scheme` and writes `<name>-<width>-<scheme>.png`. The
    /// folder is the notes folder of the maintainer's Mac; elsewhere the PNG goes to the temporary folder.
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
        let base = FileManager.default.fileExists(atPath: folder.path) ? folder : FileManager.default.temporaryDirectory
        try png.write(to: base.appendingPathComponent("\(name)-\(Int(width))-\(scheme == .dark ? "dark" : "light").png"))
    }
}
