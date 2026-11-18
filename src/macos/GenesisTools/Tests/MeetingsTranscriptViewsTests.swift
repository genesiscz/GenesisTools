import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The transcript lane's presentational views: transcript blocks, the selection popover and staged comments, the
/// talk-time lanes, the hint chips and the screen beside the sound. Pure rules are asserted; each view also renders,
/// and with `MEETINGS_UI_SNAPSHOTS=<folder>` its PNGs are written there (light and dark, 900 and 1400 pt wide).
@MainActor
final class MeetingsTranscriptViewsTests: XCTestCase {

    /// Word timings ask for no number, model id or language code (audit M7): the range comes from the selected lines or
    /// the heard line, and the model and the language are settings with their words.
    func testWordTimingsTakeTheRangeFromTheSelectionOrTheHeardLine() {
        typealias Range = WordTimingOptions.Range
        let selected = Range.of(selected: [(start: 64, end: 70), (start: 70, end: 75.5)])
        XCTAssertEqual(selected, Range(from: 64, to: 75.5, source: "the 2 selected lines"))
        let long = Range.of(selected: [(start: 100, end: 110), (start: 110, end: 140)])
        XCTAssertEqual(long, Range(from: 100, to: 120, source: "the 2 selected lines, cut at 20 s"), "never more than 20 s")
        XCTAssertNil(Range.of(selected: [(start: nil, end: nil)]), "no timed line selected: the heard line decides")
        let lines: [(start: Double?, end: Double?)] = [(start: 0, end: 30), (start: 30, end: 40), (start: 40, end: 52)]
        XCTAssertEqual(Range.near(lines, position: 41), Range(from: 40, to: 60, source: "from the line at the heard spot"))
        XCTAssertEqual(Range.near(lines, position: 0).from, 30, "a line longer than 20 s is skipped")
        XCTAssertEqual(Range.near(lines, position: 500), Range(from: 32, to: 52, source: "the 20 s at the heard spot"),
                       "past the end: the last 20 s of the transcript, never the first short line")
        let longLast: [(start: Double?, end: Double?)] = [(start: 0, end: 10), (start: 10, end: 100)]
        XCTAssertEqual(Range.near(longLast, position: 50), Range(from: 50, to: 70, source: "the 20 s at the heard spot"),
                       "a long last line plays: the range starts at the heard spot, not at the meeting's start")

        typealias Transcript = MeetingsPreferences.Transcript
        XCTAssertEqual(Transcript.timingLanguageCode(.meeting, meeting: "cs"), "cs")
        XCTAssertNil(Transcript.timingLanguageCode(.detect, meeting: "cs"))
        XCTAssertEqual(Transcript.timingLanguageCode(.en, meeting: "cs"), "en")
        XCTAssertEqual(WordTimingOptions.languageWords(.meeting, code: "cs"), "Czech, the meeting's language")
        XCTAssertEqual(SidePanelWords.choice(Transcript.TimingModel.whisperTurbo.rawValue, key: Transcript.timingModel.key),
                       "Whisper large v3 turbo", "the model's name, never its repository id")
        let titles = SidePanelCatalog.windowSections(UserDefaults(suiteName: "timings-\(UUID())")!)
            .first { $0.id == "transcript" }?.rows.map(\.title) ?? []
        XCTAssertTrue(titles.contains("Word timings model") && titles.contains("Word timings language"), "\(titles)")
    }

    func testWordTimingHighlightsUseExactUTF16RangesAndKeepUntimedLineFallback() {
        let first = TranscriptWord(range: .init(location: 3, length: 5), startSec: 10.1, endSec: 10.5, sourceId: "asr-a")
        let second = TranscriptWord(range: .init(location: 9, length: 4), startSec: 10.8, endSec: 11.2, sourceId: "asr-a")
        let entry = TranscriptLine(id: "l1", startSec: 10, speaker: "Example", text: "😀 alpha beta", endSec: 12,
                                   words: [first, second])
        let blocks = TranscriptBlock.build(from: [entry])
        let heard = TranscriptBlock.heard(in: blocks, at: 10.2)
        XCTAssertEqual(heard?.wordRange, NSRange(location: 3, length: 5))
        XCTAssertEqual(heard, TranscriptBlock.heard(in: blocks, at: 10.3), "Ticks inside one word do not redraw the list")
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: 10.6)?.wordRange, "An untimed gap keeps the line highlight")
        XCTAssertEqual(TranscriptBlock.heard(in: blocks, at: 10.9)?.wordRange, NSRange(location: 9, length: 4))
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: 10.2, wordHighlights: false)?.wordRange)
        XCTAssertNotNil(TranscriptBlock.heard(in: blocks, at: 10.2, wordHighlights: false)?.lineID)
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: 12))
        let invalid = TranscriptWord(range: .init(location: Int.max, length: 4), startSec: 10, endSec: 11, sourceId: "bad")
        XCTAssertNil(invalid.heardRange(at: 10.5, in: entry.text))
    }

    func testWordHighlightDoesNotReplaceNativeTextSelection() {
        let view = TranscriptWordText.TextView()
        view.string = "alpha beta"
        view.setSelectedRange(NSRange(location: 6, length: 4))
        view.highlightHeardRange(NSRange(location: 0, length: 5))
        XCTAssertEqual(view.accessibilityHelp(), "Timed word: alpha")
        XCTAssertNotNil(view.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil))
        XCTAssertNil(view.textStorage?.attribute(.backgroundColor, at: 6, effectiveRange: nil))
        XCTAssertEqual(view.selectedRange(), NSRange(location: 6, length: 4))
        view.highlightHeardRange(nil)
        XCTAssertNil(view.accessibilityHelp())
        XCTAssertNil(view.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil))
        XCTAssertEqual(view.selectedRange(), NSRange(location: 6, length: 4))
        view.highlightHeardRange(NSRange(location: Int.max, length: 2))
        XCTAssertNil(view.textStorage?.attribute(.backgroundColor, at: 0, effectiveRange: nil))
    }

    func testFrameReviewSearchAndTimeNavigation() async throws {
        func frame(_ file: String, _ time: Double, _ text: String, display: Int = 1) -> TimelineFrame {
            let box = OcrBox(x: 10, y: 20, width: 100, height: 30, text: text, confidence: 1)
            return TimelineFrame(file: file, path: "/fixture/\(file)", at: "2026-11-01T10:00:00Z", meetingSec: time,
                                 displayId: display, width: 800, height: 600, lineCount: 1, changed: [box], lines: [box])
        }
        let first = frame("a.png", 10, "Café launch")
        let second = frame("b.png", 20, "Review")
        let other = frame("c.png", 30, "Cafe notes", display: 2)
        let timeline = ScreenTimeline(meeting: "m1", folder: "/fixture", displays: [], frames: [first, second, other])
        let model = FrameReviewModel(meeting: "m1", file: first.file, at: 10, player: nil, defaults: .standard, timeline: timeline)
        await model.waitForIndex()
        model.query = "cafe"
        XCTAssertEqual(model.matches.compactMap { $0.frame?.file }, ["a.png", "c.png"])
        model.nextMatch(1)
        XCTAssertEqual(model.frame?.file, "c.png")
        XCTAssertEqual(model.display, 2)
        model.query = ""
        model.display = 1
        model.selectTime(25)
        XCTAssertEqual(model.frame?.file, "b.png")
        model.step(-1, seek: false)
        XCTAssertEqual(model.time, 10)
        XCTAssertEqual(FrameReviewModel.nearest(in: [first, second], at: 0)?.file, "a.png")
    }

    func testScrubbingPreviewsFramesButSettlesTranscriptDetailsOnlyOnRelease() async {
        let frames = [0.0, 30.0].enumerated().map { index, time in
            TimelineFrame(file: "frame-\(index)", path: "/fixture/frame-\(index)", at: "", meetingSec: time,
                          displayId: 1, width: 800, height: 600, lineCount: 0, changed: [], lines: [])
        }
        let transcript = MeetingTranscript(meeting: "m", entries: (0..<5).map { index in
            TranscriptLine(id: "line-\(index)", startSec: Double(index * 10), speaker: "Alex", text: "Passage \(index)")
        })
        let model = FrameReviewModel(meeting: "m", file: frames[0].file, at: 0, player: nil, defaults: .standard,
            timeline: ScreenTimeline(meeting: "m", folder: "/fixture", displays: [], frames: frames), transcript: transcript)
        await model.waitForIndex()
        let heldContext = model.context.map(\.text)
        model.beginScrub()
        model.scrub(to: 30, seek: false)
        XCTAssertEqual(model.time, 30)
        XCTAssertEqual(model.frame?.file, frames[1].file)
        XCTAssertEqual(model.detailsFrame?.file, frames[0].file)
        XCTAssertEqual(model.context.map(\.text), heldContext)
        model.endScrub(seek: false)
        XCTAssertEqual(model.detailsFrame?.file, frames[1].file)
        XCTAssertEqual(model.context.map(\.text), ["Passage 2", "Passage 3", "Passage 4"])
        model.cancelWork()
    }

    func testAutoDisplayFollowsRecordedFocusAndManualSelectionStaysFixed() throws {
        func frame(_ file: String, _ time: Double, _ display: Int, _ focus: Int) -> TimelineFrame {
            var value = TimelineFrame(file: file, path: "/fixture/\(file)", at: "2026-11-01T10:00:00Z", meetingSec: time,
                                      displayId: display, width: 20, height: 10, lineCount: 0, changed: [], lines: [])
            value.focusedDisplayId = focus
            return value
        }
        let frames = [frame("one-a", 0, 1, 1), frame("two-a", 1, 2, 1), frame("one-b", 10, 1, 2), frame("two-b", 11, 2, 2)]
        let suite = "meetings.focus.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let timeline = ScreenTimeline(meeting: "m", folder: "/fixture", displays: [], frames: frames)
        let model = FrameReviewModel(meeting: "m", file: "one-a", at: 5, player: nil, defaults: defaults, timeline: timeline)
        XCTAssertEqual(model.displayChoice, -2)
        XCTAssertEqual(model.frame?.file, "one-a")
        model.selectTime(12)
        XCTAssertEqual(model.frame?.file, "two-b")
        model.chooseDisplay(1)
        model.selectTime(12)
        XCTAssertEqual(model.frame?.file, "one-b")
        XCTAssertFalse(MeetingsPreferences.Panes.frameAutoDisplay.value(defaults))
        model.chooseDisplay(-2)
        XCTAssertEqual(model.frame?.file, "two-b")
        XCTAssertTrue(MeetingsPreferences.Panes.frameAutoDisplay.value(defaults))
    }

    func testAutoDisplayDoesNotInventFocusForOlderPartsOfARecording() throws {
        let old = TimelineFrame(file: "old", path: "/old", at: "", meetingSec: 0, displayId: 1,
                                width: 20, height: 10, lineCount: 0, changed: [], lines: [])
        var focused = TimelineFrame(file: "new", path: "/new", at: "", meetingSec: 10, displayId: 2,
                                    width: 20, height: 10, lineCount: 0, changed: [], lines: [])
        focused.focusedDisplayId = 2
        let unknown = TimelineFrame(file: "unknown", path: "/unknown", at: "", meetingSec: 20, displayId: 1,
                                    width: 20, height: 10, lineCount: 0, changed: [], lines: [])
        let suite = "meetings.focus.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let timeline = ScreenTimeline(meeting: "m", folder: "/fixture", displays: [], frames: [old, focused, unknown])
        let model = FrameReviewModel(meeting: "m", file: "old", at: 5, player: nil, defaults: defaults, timeline: timeline)
        XCTAssertEqual(model.frame?.file, "old")
        model.selectTime(12)
        XCTAssertEqual(model.frame?.file, "new")
        model.selectTime(20)
        XCTAssertEqual(model.frame?.file, "unknown")
    }

    /// In Auto a display keeps showing its last frame after focus moved to it, though that frame was taken while
    /// another display had focus, so it is not in the Auto sequence. Previous and Next then step by time.
    func testAutoDisplayStepsFromAFrameTakenBeforeFocusMovedToItsDisplay() throws {
        func frame(_ file: String, _ time: Double, _ display: Int, _ focus: Int) -> TimelineFrame {
            var value = TimelineFrame(file: file, path: "/fixture/\(file)", at: "2026-11-01T10:00:00Z", meetingSec: time,
                                      displayId: display, width: 20, height: 10, lineCount: 0, changed: [], lines: [])
            value.focusedDisplayId = focus
            return value
        }
        let frames = [frame("one-a", 5, 1, 1), frame("two-kept", 10, 2, 1), frame("one-b", 20, 1, 2), frame("two-b", 30, 2, 2)]
        let suite = "meetings.focus.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let timeline = ScreenTimeline(meeting: "m", folder: "/fixture", displays: [], frames: frames)
        let model = FrameReviewModel(meeting: "m", file: "one-a", at: 5, player: nil, defaults: defaults, timeline: timeline)
        model.selectTime(25)
        XCTAssertEqual(model.frame?.file, "two-kept", "focus moved to display 2 at 20 s, whose last frame is from 10 s")
        XCTAssertEqual(model.stepTarget(1)?.file, "two-b", "Next is enabled")
        XCTAssertEqual(model.stepTarget(-1)?.file, "one-a", "Previous is enabled")
        model.step(1, seek: false)
        XCTAssertEqual(model.frame?.file, "two-b")
        XCTAssertNil(model.stepTarget(1), "the last frame: Next is disabled")
        model.selectTime(25)
        model.step(-1, seek: false)
        XCTAssertEqual(model.frame?.file, "one-a")
        XCTAssertNil(model.stepTarget(-1), "the first frame: Previous is disabled")
    }

    func testFrameReviewGroupsRepeatedOCRAndSearchesBothSources() async throws {
        func frame(_ file: String, _ time: Double, _ text: String, _ display: Int = 1) -> TimelineFrame {
            let box = OcrBox(x: 10, y: 20, width: 120, height: 30, text: text, confidence: 1)
            return TimelineFrame(file: file, path: "/fixture/\(file)", at: "2026-11-01T10:00:00Z", meetingSec: time,
                                 displayId: display, width: 800, height: 600, lineCount: 1, changed: [box], lines: [box])
        }
        let frames = [frame("a", 10, "The API is ready"), frame("b", 20, "The API is ready"),
                      frame("c", 30, "Other text"), frame("d", 40, "The API is ready"), frame("e", 10, "The API is ready", 2)]
        let transcript = MeetingTranscript(meeting: "m", entries: [
            TranscriptLine(id: "l1", startSec: 5, speaker: "Alex", text: "Before this"),
            TranscriptLine(id: "l2", startSec: 15, speaker: "Jordan", text: "The API changed"),
            TranscriptLine(id: "l3", startSec: 25, speaker: "Alex", text: "After this")])
        let model = FrameReviewModel(meeting: "m", file: "a", at: 10, player: nil, defaults: .standard,
            timeline: ScreenTimeline(meeting: "m", folder: "/fixture", displays: [], frames: frames), transcript: transcript)
        await model.waitForIndex()
        model.query = "api"
        XCTAssertEqual(model.matches.count, 3)
        let grouped = model.matches.first { $0.frame?.file == "a" }
        XCTAssertEqual(grouped?.occurrences, 3)
        XCTAssertEqual(grouped?.fromSec, 10)
        XCTAssertEqual(grouped?.toSec, 40)
        XCTAssertEqual(grouped?.seenAt, [10, 20, 40])
        model.chooseMatch(try XCTUnwrap(grouped))
        model.nextAppearance(1)
        XCTAssertEqual(model.time, 20)
        model.searchSource = .transcript
        XCTAssertEqual(model.matches.count, 1)
        XCTAssertEqual(model.selectedMatch?.speaker, "Jordan")
        XCTAssertEqual(model.time, 15)
        XCTAssertEqual(model.context.map(\.speaker), ["Alex", "Jordan", "Alex"])
        model.searchSource = .ocr
        XCTAssertEqual(model.matches.count, 2)
        XCTAssertTrue(model.matches.allSatisfy { $0.source == .ocr })
    }

    func testFrameReviewHoverDoesNotMoveSelectionAndFocusCentersTheBox() async throws {
        let box = OcrBox(x: 100, y: 100, width: 200, height: 40, text: "Matching text", confidence: 1)
        func frame(_ name: String, _ time: Double) -> TimelineFrame {
            TimelineFrame(file: name, path: "/fixture/\(name)", at: "2026-11-01T10:00:00Z", meetingSec: time,
                          displayId: 1, width: 1600, height: 900, lineCount: 1, changed: [box], lines: [box])
        }
        let first = frame("a", 10), second = frame("b", 20)
        let model = FrameReviewModel(meeting: "m", file: "a", at: 10, player: nil, defaults: .standard,
            timeline: ScreenTimeline(meeting: "m", folder: "/fixture", displays: [], frames: [first, second]))
        await model.waitForIndex()
        model.query = "Matching"
        let hover = FrameReviewModel.Match(id: "hover", content: .ocr(second), text: box.text, fromSec: 20, toSec: 20)
        model.hoveredMatch = hover
        XCTAssertEqual(model.previewFrame?.file, "b")
        XCTAssertEqual(model.frame?.file, "a")
        XCTAssertEqual(model.time, 10)
        model.hoveredMatch = nil
        XCTAssertEqual(model.previewFrame?.file, "a")
        let focused = FrameReviewFocus.layout(box: box, image: CGSize(width: 1600, height: 900), viewport: CGSize(width: 800, height: 600))
        XCTAssertGreaterThan(focused.scale, 0.5)
        XCTAssertEqual((box.x + box.width / 2) * focused.scale + focused.offset.width, 400, accuracy: 0.001)
        XCTAssertEqual((box.y + box.height / 2) * focused.scale + focused.offset.height, 300, accuracy: 0.001)
    }

    func testFrameReviewHighlightsEveryExactMatchIncludingAccents() {
        let text = "Café, CAFE and a longer sentence"
        let ranges = FrameReviewModel.highlightRanges(in: text, query: "cafe")
        XCTAssertEqual(ranges.map { (text as NSString).substring(with: $0) }, ["Café", "CAFE"])
        XCTAssertTrue(FrameReviewModel.highlightRanges(in: text, query: "  ").isEmpty)
    }

    // MARK: Fixtures (invented people)

    private static let entries: [TranscriptLine] = [
        TranscriptLine(id: "l0", startSec: 3262, speaker: "Mira Holt", text: "So the segment for employees, what should it be called in the DTO?"),
        TranscriptLine(id: "l1", startSec: 3266, speaker: "Mira Holt", text: "We need one code that everyone reads the same way."),
        TranscriptLine(id: "l2", startSec: 3269, speaker: "Jonas Petr", text: "I would suggest ZAME, but nobody knows that one."),
        TranscriptLine(id: "l3", startSec: 3273, speaker: "Alex Rowan", text: "Not ZAME, that is an internal code from the old system."),
        TranscriptLine(id: "l4", startSec: 3276, speaker: "Jonas Petr", text: "Then keep EMP there, it does not matter much."),
        TranscriptLine(id: "l5", startSec: 3279, speaker: "Jonas Petr", text: "The mapper handles the rest anyway."),
        TranscriptLine(id: "l6", startSec: 3281, speaker: "Mira Holt", text: "Fine, EMP. And the buttons section, is it required only there?"),
        TranscriptLine(id: "l7", startSec: 3288, speaker: "Alex Rowan", text: "Yes, required only in the buttons section, optional everywhere else."),
    ]

    private static func speakers() -> [MeetingsAPI.MeetingSpeakers.Speaker] {
        func spans(seed: Int, count: Int, density: Double) -> [MeetingsAPI.MeetingSpeakers.Span] {
            var state = seed
            func next() -> Double { state = (state * 9301 + 49297) % 233280; return Double(state) / 233280 }
            var x = 0.0, result: [MeetingsAPI.MeetingSpeakers.Span] = []
            while result.count < count && x < 8700 {
                x += next() * density
                let length = 6 + next() * 140
                result.append(.init(fromSec: x, toSec: min(8772, x + length), turns: 1 + Int(next() * 3)))
                x += length
            }
            return result
        }
        func speaker(_ label: String, _ spokenSec: Double, _ seed: Int, _ density: Double) -> MeetingsAPI.MeetingSpeakers.Speaker {
            let s = spans(seed: seed, count: 80, density: density)
            return .init(label: label, speakerId: nil, origin: "source", turns: s.count * 2, lines: s.count * 3, words: s.count * 40,
                         spokenSec: spokenSec, firstSec: s.first?.fromSec, lastSec: s.last?.toSec, spans: s)
        }
        return [speaker("Mira Holt", 3300, 3, 260), speaker("Alex Rowan", 2700, 5, 320),
                speaker("Jonas Petr", 2100, 9, 420), speaker("Speaker 4", 600, 17, 1400)]
    }

    // MARK: Transcript blocks

    func testBlocksGroupConsecutiveLinesOfOneSpeakerAndEndEachLineAtTheNextStart() {
        let blocks = TranscriptBlock.build(from: Self.entries, durationSec: 3300)
        XCTAssertEqual(blocks.map(\.speaker), ["Mira Holt", "Jonas Petr", "Alex Rowan", "Jonas Petr", "Mira Holt", "Alex Rowan"])
        XCTAssertEqual(blocks[0].lines.map(\.id), ["l0", "l1"])
        XCTAssertEqual(blocks[0].lines[0].endSec, 3266)
        XCTAssertEqual(blocks.last?.lines.last?.endSec, 3300, "the last line ends at the recording's end")
        XCTAssertEqual(blocks[3].startSec, 3276)
    }

    func testAGapLongerThanTheBreakStartsANewBlockForTheSameSpeaker() {
        let lines = [TranscriptLine(id: "a", startSec: 10, speaker: "Mira Holt", text: "One."),
                     TranscriptLine(id: "b", startSec: 200, speaker: "Mira Holt", text: "Two.")]
        XCTAssertEqual(TranscriptBlock.build(from: lines).count, 1, "the plan's pick: one block per turn")
        XCTAssertEqual(TranscriptBlock.build(from: lines, breakAfterGapSec: 30).count, 2)
    }

    func testTheHeardLineComesFromThePositionAndTheLinesEnds() {
        let blocks = TranscriptBlock.build(from: Self.entries, durationSec: 3300)
        XCTAssertEqual(TranscriptBlock.heard(in: blocks, at: 3277), TranscriptHeard(blockID: "b-l4", lineID: "l4"))
        XCTAssertEqual(TranscriptBlock.heard(in: blocks, at: 3279.5), TranscriptHeard(blockID: "b-l4", lineID: "l5"))
        XCTAssertEqual(TranscriptBlock.heard(in: blocks, at: 3267)?.lineID, "l1")
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: 100), "before the first line nothing is heard")
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: 3301), "after the recording's end nothing is heard")
        XCTAssertNil(TranscriptBlock.heard(in: blocks, at: nil))
    }

    func testTheFilterKeepsTheWholeBlockOfAHitAndMarksTheHitLine() {
        let blocks = TranscriptBlock.filter(TranscriptBlock.build(from: Self.entries), query: "mapper")
        XCTAssertEqual(blocks.count, 1)
        XCTAssertEqual(blocks[0].lines.count, 2, "the hit's block shows whole")
        XCTAssertEqual(blocks[0].lines.map { $0.marks.contains(.filterHit) }, [false, true])
    }

    func testOnlyTheHeardBlockViewChangesWhenThePositionMovesInsideALine() {
        let blocks = TranscriptBlock.build(from: Self.entries, durationSec: 3300)
        let before = TranscriptBlock.heard(in: blocks, at: 3276.1)
        let after = TranscriptBlock.heard(in: blocks, at: 3278.9)
        XCTAssertEqual(before, after, "the same heard line: no block input changes at 10 Hz")
        let other = TranscriptBlockView(block: blocks[0], heardLineID: nil, selected: [], past: true, play: { _ in })
        let otherLater = TranscriptBlockView(block: blocks[0], heardLineID: nil, selected: [], past: true, play: { _ in })
        XCTAssertTrue(other == otherLater, "a block that is not heard compares equal across ticks")
    }

    /// The list takes the end of the last block passed, not the position: the same blocks are past at it as at the
    /// position, and it holds still between block ends, so a 10 Hz tick inside a block hands the list nothing new.
    func testThePassedEndDimsWhatThePositionDimsAndHoldsBetweenBlockEnds() {
        let blocks = TranscriptBlock.build(from: Self.entries, durationSec: 3300)
        let ends = blocks.compactMap(\.endSec)
        XCTAssertGreaterThan(ends.count, 1)
        for position in stride(from: 3250.0, through: 3310.0, by: 0.1) {
            let passed = TranscriptBlock.passedEnd(in: blocks, at: position)
            for block in blocks {
                guard let end = block.endSec else { continue }
                XCTAssertEqual(end <= position, passed.map { end <= $0 } ?? false, "block \(block.id) at \(position)")
            }
        }
        let inside = ends[0] + 0.05
        XCTAssertEqual(TranscriptBlock.passedEnd(in: blocks, at: inside), TranscriptBlock.passedEnd(in: blocks, at: inside + 0.4),
                       "no block ends between the two ticks: the same value")
        XCTAssertNil(TranscriptBlock.passedEnd(in: blocks, at: nil))
        XCTAssertNil(TranscriptBlock.passedEnd(in: blocks, at: 0), "before every end nothing is past")
    }

    func testAClickPlaysAndShiftOrCommandSelects() {
        XCTAssertEqual(TranscriptLineClick(modifiers: []), .play)
        XCTAssertEqual(TranscriptLineClick(modifiers: .shift), .extendSelection)
        XCTAssertEqual(TranscriptLineClick(modifiers: .command), .toggleSelection)
    }

    func testInitialsAreNeutralAndShort() {
        XCTAssertEqual(TranscriptAvatar.initials("Mira Holt"), "MH")
        XCTAssertEqual(TranscriptAvatar.initials("Speaker 4"), "S4")
        XCTAssertEqual(TranscriptAvatar.initials(""), "?")
        XCTAssertEqual(TranscriptAvatar.initials("[unclear: \"…\"]"), "UN", "D3: a note in brackets showed [\" as its initials")
        XCTAssertEqual(TranscriptAvatar.initials("Mira Holt (QA)"), "MH")
        XCTAssertEqual(TranscriptAvatar.initials("…"), "?")
    }

    /// U8: the pointer on a line never moves the lines below it. "Play from 00:10" stood beside the text and took about
    /// 90 pt of its width, so the text wrapped again, the line grew, and every line under it jumped down.
    func testALineKeepsItsSizeWithThePointerOnIt() throws {
        let text = String(repeating: "We can rename the staging pipeline before the release, or keep the old name. ", count: 5)
        let line = TranscriptBlockLine(id: "l1", index: 0, startSec: 10, endSec: 40, text: text)
        let rest = try lineFrame(line, hovering: false)
        let hovered = try lineFrame(line, hovering: true)
        XCTAssertGreaterThan(rest.height, 60, "the line wraps over several rows at 360 pt: \(rest)")
        XCTAssertEqual(hovered.height, rest.height, accuracy: 0.5, "the pointer changed the line's height: \(rest) to \(hovered)")
        XCTAssertEqual(hovered.width, rest.width, accuracy: 0.5, "the pointer changed the line's width: \(rest) to \(hovered)")
    }

    /// One transcript line at `width` in a window that never shows and takes no pointer; its frame from `FrameProbe`.
    private func lineFrame(_ line: TranscriptBlockLine, hovering: Bool, width: CGFloat = 360) throws -> CGRect {
        FrameProbe.enabled = true
        FrameProbe.reset()
        defer { FrameProbe.enabled = false; FrameProbe.reset() }
        let root = VStack(spacing: 0) {
            TranscriptBlockLineView(line: line, speaker: "Alice Example", heard: false, wordRange: nil, selected: false,
                                    past: false, play: { _ in }, select: { _, _ in }, selectWords: { _, _ in },
                                    hovering: hovering)
                .frameProbe("transcript.line")
            Spacer(minLength: 0)
        }
        .frame(width: width, height: 400, alignment: .top)
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 400), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.contentView = NSHostingView(rootView: root)
        window.orderFrontRegardless()
        defer { window.orderOut(nil); window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))
        return try XCTUnwrap(FrameProbe.frames["transcript.line"], "the line reported its frame")
    }

    func testSnapshotTranscriptBlocks() throws {
        var blocks = TranscriptBlock.build(from: Self.entries, durationSec: 3300,
                                           marks: ["l2": [.unclearSpeaker], "l4": [.corrected], "l7": [.commented]])
        blocks = blocks.map { $0 }
        let heard = TranscriptBlock.heard(in: blocks, at: 3277)
        for width: CGFloat in [420, 560] {
            let view = TranscriptBlocksList(blocks: blocks, heard: heard, selection: ["l6", "l7"], pastBefore: 3277, play: { _ in })
            try snapshot(view, name: "transcript-blocks-\(Int(width))", width: width)
        }
    }

    // MARK: Selection popover and staged comments

    func testNativeSelectionReportsTheSelectedWord() async {
        let text = TranscriptWordText.TextView()
        text.string = "alpha beta gamma"
        let selected = expectation(description: "native selected range")
        text.selected = { range in
            XCTAssertEqual(range, NSRange(location: 6, length: 4))
            selected.fulfill()
        }
        text.setSelectedRange(NSRange(location: 6, length: 4))
        await fulfillment(of: [selected], timeout: 1)
    }

    func testWordSelectionKeepsItsQuoteAndLineFractions() throws {
        let line = TranscriptBlockLine(id: "l1", index: 4, startSec: 10, endSec: 20, text: "Hi 🌍 alpha beta")
        let range = (line.text as NSString).range(of: "alpha")
        let chosen = try XCTUnwrap(TranscriptSelection.words(line, range: range))
        XCTAssertEqual(chosen.quote, "alpha")
        XCTAssertEqual(chosen.from.line, 4)
        XCTAssertEqual(chosen.from.fraction, Double(range.location) / Double(line.text.utf16.count))
        XCTAssertEqual(chosen.to.fraction, Double(range.location + range.length) / Double(line.text.utf16.count))
        XCTAssertNil(TranscriptSelection.words(line, range: NSRange(location: 0, length: 0)))
        XCTAssertNil(TranscriptSelection.words(line, range: NSRange(location: NSNotFound, length: 1)))
        XCTAssertNil(TranscriptSelection.words(line, range: NSRange(location: 3, length: 1)), "never split a surrogate pair")
    }

    func testASelectionOfLinesRunsFromTheFirstStartToTheLastLine() throws {
        let blocks = TranscriptBlock.build(from: Self.entries)
        let lines = [blocks[5].lines[0], blocks[4].lines[0]]
        let selection = try XCTUnwrap(TranscriptSelection.lines(lines))
        XCTAssertEqual(selection.from, LinePoint(atSec: 3281, line: 6, fraction: 0))
        XCTAssertEqual(selection.to, LinePoint(atSec: 3288, line: 7, fraction: 1))
        XCTAssertEqual(selection.rangeText, "54:41 to 54:48")
        XCTAssertEqual(selection.target, .selection(from: selection.from, to: selection.to))
    }

    func testClipReportsTheSelectionTargetAndFiveSeconds() throws {
        let selection = try XCTUnwrap(TranscriptSelection.lines(TranscriptBlock.build(from: Self.entries)[1].lines))
        var clipped: (MomentTarget, Double)?
        let popover = SelectionPopover(selection: selection, stage: { _, _ in }, clip: { clipped = ($0, $1) })
        popover.clip(selection.target, popover.clipLengthSec)
        XCTAssertEqual(clipped?.0, selection.target)
        XCTAssertEqual(clipped?.1, 5)
    }

    func testTheSendResultSaysHowManyListenersGotThemOrThatNobodyListens() {
        XCTAssertEqual(CommentDelivery.sent(comments: 3, listeners: 1).text, "Sent 3 comments to 1 listener")
        XCTAssertEqual(CommentDelivery.sent(comments: 1, listeners: 0).text, "Nobody is listening. Kept 1 comment staged.")
        XCTAssertTrue(CommentDelivery.sent(comments: 1, listeners: 0).isError)
        XCTAssertNil(CommentDelivery.idle.text)
        XCTAssertEqual(StagedCommentsBar.sendTitle(count: 3, listeners: 1), "Send 3 comments")
        XCTAssertEqual(StagedCommentsBar.sendTitle(count: 3, listeners: 0), "Keep staged")
        XCTAssertEqual(StagedCommentsBar.receiverText([]), "Nobody listens on this meeting")
        let agent = CommentListener(pid: 4211, at: "2026-11-09T14:32:00Z",
                                    actor: DecisionActor(kind: "listen", harness: "claude-code", session: "7f3a92"))
        XCTAssertEqual(StagedCommentsBar.receiverText([agent]), "Claude Code agent, session 7f3a, pid 4211",
                       "the harness by its name, as every other line names it")
    }

    func testSnapshotSelectionPopoverAndStagedComments() throws {
        let selection = try XCTUnwrap(TranscriptSelection.lines(TranscriptBlock.build(from: Self.entries)[4].lines))
        try snapshot(SelectionPopover(selection: selection, stage: { _, _ in }, clip: { _, _ in }, saveClip: { _, _ in }).fixedSize(),
                     name: "selection-popover", width: nil)
        try snapshot(SelectionPopover(selection: selection, startsInComment: true, stage: { _, _ in }, clip: { _, _ in }).fixedSize(),
                     name: "selection-popover-comment", width: nil)
        let staged = [StagedCommentLine(id: "c1", rangeText: "54:29", text: "ZAME is the old internal code. Never suggest it as a value."),
                      StagedCommentLine(id: "c2", rangeText: "54:41 to 54:48", text: "Both lines are one decision: buttons is the only required section.")]
        let agent = CommentListener(pid: 4211, at: "2026-11-09T14:32:00Z", actor: DecisionActor(kind: "listen", harness: "claude-code", session: "7f3a92"))
        try snapshot(StagedCommentsBar(comments: staged, listeners: [agent], delivery: .sent(comments: 1, listeners: 1), send: {}, unstage: { _ in }),
                     name: "staged-comments", width: 420)
        try snapshot(StagedCommentsBar(comments: staged, listeners: [], send: {}, unstage: { _ in }),
                     name: "staged-comments-nobody", width: 420)
    }

    // MARK: Talk-time lanes

    func testLaneClickNeedsNoHoverAndMovingAwayDoesNotPlay() throws {
        let view = SpeakerLaneInteraction.InputView(frame: NSRect(x: 0, y: 0, width: 100, height: 30))
        let block = TalkTimeBlock(fromSec: 10, toSec: 20, x: 20, width: 30, spans: 1, ticks: [])
        view.blocks = [block]
        var played: [TalkTimeBlock] = []
        view.click = { played.append($0) }
        func event(_ type: NSEvent.EventType, x: CGFloat) throws -> NSEvent {
            try XCTUnwrap(NSEvent.mouseEvent(with: type, location: NSPoint(x: x, y: 15), modifierFlags: [],
                timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 1, pressure: 0))
        }
        view.mouseDown(with: try event(.leftMouseDown, x: 25))
        view.mouseUp(with: try event(.leftMouseUp, x: 25))
        XCTAssertEqual(played, [block])
        view.mouseDown(with: try event(.leftMouseDown, x: 25))
        view.mouseUp(with: try event(.leftMouseUp, x: 80))
        view.mouseDown(with: try event(.leftMouseDown, x: 80))
        view.mouseUp(with: try event(.leftMouseUp, x: 80))
        XCTAssertEqual(played, [block], "moving away or clicking a gap must not play a stretch")
    }

    func testSpeakerDragRoundTripsAndRejectsForeignOrStaleStretches() throws {
        let speakers = Self.speakers()
        let source = speakers[0], target = speakers[1]
        let first = try XCTUnwrap(source.talkSpans.first), last = try XCTUnwrap(source.talkSpans.last)
        let owner = UUID()
        let drag = SpeakerLaneDrag(owner: owner, label: source.label, fromSec: first.fromSec, toSec: last.toSec)
        let decoded = try JSONDecoder().decode(SpeakerLaneDrag.self, from: JSONEncoder().encode(drag))
        XCTAssertEqual(decoded, drag)
        XCTAssertEqual(drag.stretch(owner: owner, target: target.label, speakers: speakers),
                       .init(label: source.label, fromSec: first.fromSec, toSec: last.toSec))
        XCTAssertNil(drag.stretch(owner: UUID(), target: target.label, speakers: speakers))
        XCTAssertNil(drag.stretch(owner: owner, target: source.label, speakers: speakers))
        XCTAssertNil(drag.stretch(owner: owner, target: "missing", speakers: speakers))
        XCTAssertNil(drag.stretch(owner: owner, target: target.label, speakers: [target]))
        XCTAssertNil(SpeakerLaneDrag(owner: owner, label: source.label, fromSec: first.fromSec + 1, toSec: last.toSec)
            .stretch(owner: owner, target: target.label, speakers: speakers))
        XCTAssertNil(SpeakerLaneDrag(owner: owner, label: source.label, fromSec: .nan, toSec: last.toSec)
            .stretch(owner: owner, target: target.label, speakers: speakers))
    }

    func testThinSpansJoinAndKeepTheirTurnTicks() {
        let spans: [MeetingsAPI.MeetingSpeakers.Span] = [.init(fromSec: 0, toSec: 1, turns: 1), .init(fromSec: 2, toSec: 3, turns: 1),
                                                        .init(fromSec: 500, toSec: 700, turns: 2)]
        let blocks = TalkTimeLayout.blocks(spans, durationSec: 1000, width: 100)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[0].spans, 2)
        XCTAssertTrue(blocks[0].isJoined)
        XCTAssertEqual(blocks[0].ticks, [0.2])
        XCTAssertGreaterThanOrEqual(blocks[0].width, 2, "a joined thin block still shows")
        XCTAssertFalse(blocks[1].isJoined)
        XCTAssertEqual(blocks[1].x, 50)
        XCTAssertEqual(TalkTimeLayout.block(at: 51, in: blocks), blocks[1])
        XCTAssertEqual(TalkTimeLayout.block(at: 1.5, in: blocks), blocks[0], "a 2 pt block is hit with slack")
        XCTAssertNil(TalkTimeLayout.block(at: 30, in: blocks))
    }

    func testCloseQuestionsMergeIntoOneBanner() {
        let questions = [TalkTimeQuestion(id: "q1", atSec: 100, label: "Q12"), TalkTimeQuestion(id: "q2", atSec: 110),
                         TalkTimeQuestion(id: "q3", atSec: 600)]
        let banners = TalkTimeLayout.banners(questions, durationSec: 1000, width: 500)
        XCTAssertEqual(banners.map(\.text), ["? ×2", "?"])
        XCTAssertEqual(banners[0].ids, ["q1", "q2"])
        XCTAssertEqual(TalkTimeLayout.banners([questions[0]], durationSec: 1000, width: 500).map(\.text), ["? Q12"])

        // D7: two labelled banners 30 pt apart are one banner; they drew over each other ("? Q ? Q9").
        let near = [TalkTimeQuestion(id: "q7", atSec: 400, label: "Q7"), TalkTimeQuestion(id: "q9", atSec: 460, label: "Q9"),
                    TalkTimeQuestion(id: "q1", atSec: 700, label: "Q1")]
        let merged = TalkTimeLayout.banners(near, durationSec: 1000, width: 500)
        XCTAssertEqual(merged.map(\.text), ["? ×2", "? Q1"])
        for (before, after) in zip(merged, merged.dropFirst()) {
            XCTAssertGreaterThanOrEqual(after.x - before.x, TalkTimeLayout.bannerWidth)
        }
        // A merged banner lists each of its questions: a click opened only the first, and Q9 had no way to its row.
        let choices = SpeakerTalkTimeLanes.bannerChoices(merged[0], questions: near)
        XCTAssertEqual(choices.map(\.id), ["q7", "q9"])
        XCTAssertEqual(choices.map(\.title), ["Q7 at 06:40", "Q9 at 07:40"])
    }

    /// U2: a "?" banner answers its question where it stands ("the ? should be clickable so i can pick no?"). Its menu is
    /// the question's choices without Skip, a divider and "Show in Items"; a merged banner has one submenu per question.
    func testABannerMenuOffersItsQuestionsChoicesAndTheWayToItsRow() {
        let detail = MeetingDetailModel(id: "m", window: nil)
        XCTAssertEqual(Self.titles(reviewChoiceItems(for: TimelineFixture.questionRow, detail: detail)),
                       ["Mira Holt", "Jonas Petr", "—", "Show in Items"], "every choice but Skip, then the way to the row")

        let near = [TalkTimeQuestion(id: "q7", atSec: 400, label: "Q7"), TalkTimeQuestion(id: "q9", atSec: 460, label: "Q9")]
        let menu: (String) -> [MenuButtonItem] = { id in [.action("Answer \(id)") {}] }
        let merged = TalkTimeLayout.banners(near, durationSec: 1000, width: 500)
        XCTAssertEqual(merged.count, 1, "the two questions share one banner")
        XCTAssertEqual(Self.titles(SpeakerTalkTimeLanes.bannerItems(merged[0], questions: near, menu: menu)),
                       ["Q7 at 06:40 ▸ Answer q7", "Q9 at 07:40 ▸ Answer q9"])
        let single = TalkTimeLayout.banners([near[0]], durationSec: 1000, width: 500)
        XCTAssertEqual(Self.titles(SpeakerTalkTimeLanes.bannerItems(single[0], questions: near, menu: menu)), ["Answer q7"],
                       "one question opens its own menu at once")
    }

    /// U7: an open chip that no question covers offered nothing under "Who said this?", and then "Rename Jan Hora for
    /// this meeting…" for a person it had just said it does not know. It now offers the covering suggestion with its
    /// score, the meeting's people from the seats, and "Somebody else…"; a name or a guess keeps its rename.
    func testAnOpenChipWithoutAQuestionOffersTheSuggestionAndThePeopleButNoRename() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        detail.settleDecisionRecord(try JSONDecoder().decode(MeetingRecordView.self, from: Data(Self.openChipRecord.utf8)))
        var picked: [SpeakerChip.PickerMode] = []
        let open = SpeakerChip.menuItems(.open(label: "Speaker 5", candidates: []), speaker: "Speaker 5", startSec: 10,
                                         play: { _ in }, detail: detail, pick: { picked.append($0) })
        XCTAssertEqual(Self.titles(open), ["(Who said this?)", "Alice Example (suggested, 85 % sure)", "—", "Bob Example",
                                           "Carol Example", "Somebody else…", "—", "Play from 00:10"],
                       "the open suggestion first (not the rejected one), then the seats once each")
        XCTAssertFalse(Self.titles(open).contains { $0.hasPrefix("Rename") }, "a chip that asks who it is offers no rename")
        Self.run("Somebody else…", in: open)
        XCTAssertEqual(picked, [.assign], "Somebody else opens the person picker that assigns the stretch")

        let voice = SpeakerChip.menuItems(.open(label: "Speaker 5", candidates: []), speaker: "Speaker 5", startSec: 120,
                                          play: nil, detail: detail, pick: { _ in })
        XCTAssertEqual(Self.titles(voice).dropFirst().first, "Dan Example (by voice 0.61)",
                       "the cosine from the evidence, never a percent and never the rule's gate")

        detail.rows = .loaded(ReviewRows(meeting: "m", rows: [TimelineFixture.questionRow],
                                         hidden: .init(lowPriority: 0, minPriority: 0)))
        let asked = SpeakerChip.menuItems(.open(label: nil, candidates: []), speaker: "Speaker 3", startSec: 6590,
                                          play: nil, detail: detail, pick: { _ in })
        XCTAssertEqual(Self.titles(asked), ["(Who said this?)", "Mira Holt", "Jonas Petr", "Somebody else…", "—", "Show in Items"],
                       "a covering question offers its own answers")

        let guess = SpeakerChip.menuItems(.guess("Alice Example", percent: 63), speaker: "Speaker 5", startSec: 10,
                                          play: nil, detail: detail, pick: { _ in })
        XCTAssertTrue(Self.titles(guess).contains("Rename Speaker 5 for this meeting…"), "\(Self.titles(guess))")
    }

    /// Bob in the room; Carol and Alice remote. Speaker 5 has an open suggestion (Alice, 85 %) and a rejected one (Erin)
    /// over 0 to 40 s, a voice model's suggestion (Dan, cosine 0.61, the rule's gate 0.8 as its confidence) over 100 to
    /// 140 s, and a question covers 6588 to 6602 s.
    private static let openChipRecord = #"""
    {"id":"m","title":"Practice","labels":[],"start":"2026-01-01T10:00:00Z","context":[],"sources":{},
     "speakers":{"labels":{}},
     "seats":{"room":["Bob Example"],"remote":[{"name":"Carol Example","fromSec":1.4},{"name":"Alice Example","fromSec":1.4}]},
     "items":[
      {"id":"i622","kind":"speaker-range","status":"suggested","confidence":0.85,"rules":["agent"],"label":"Speaker 5",
       "fromSec":0,"toSec":40,"speaker":"Alice Example"},
      {"id":"i623","kind":"speaker-range","status":"rejected","confidence":0.95,"rules":["agent"],"label":"Speaker 5",
       "fromSec":0,"toSec":40,"speaker":"Erin Example"},
      {"id":"i700","kind":"speaker-range","status":"suggested","confidence":0.8,"rules":["voice-embedding"],
       "label":"Speaker 5","fromSec":100,"toSec":140,"speaker":"Dan Example","evidence":{"score":0.61}},
      {"id":"q12","kind":"question","status":"suggested","about":"speaker","fromSec":6588,"toSec":6602,
       "question":"Who says this?"}
     ]}
    """#

    /// A menu's entries as text: an action by its title, a note in brackets, a divider as "—", and a submenu's entries
    /// after its title and "▸".
    private static func titles(_ items: [MenuButtonItem]) -> [String] {
        items.flatMap { item -> [String] in
            switch item {
            case .action(let title, _, _, _): return [title]
            case .submenu(let title, let inner): return titles(inner).map { "\(title) ▸ \($0)" }
            case .note(let text): return ["(\(text))"]
            case .divider: return ["—"]
            }
        }
    }

    /// Runs the action entry with `title`, as a click on it does.
    private static func run(_ title: String, in items: [MenuButtonItem]) {
        for case .action(let name, _, _, let action) in items where name == title { action() }
    }

    func testRulerMarksUseARoundStep() {
        XCTAssertEqual(SpeakerTalkTimeLanes.rulerMarks(durationSec: 8772), [0, 1800, 3600, 5400, 7200, 8772])
    }

    func testSnapshotTalkTimeLanes() throws {
        let questions = [TalkTimeQuestion(id: "q1", atSec: 2280), TalkTimeQuestion(id: "q2", atSec: 4150),
                         TalkTimeQuestion(id: "q3", atSec: 4190), TalkTimeQuestion(id: "q12", atSec: 6590, label: "Q12"),
                         TalkTimeQuestion(id: "q5", atSec: 7920)]
        for width: CGFloat in [900, 1400] {
            let view = SpeakerTalkTimeLanes(speakers: Self.speakers(), durationSec: 8772, timed: true, questions: questions,
                                            activeRange: 3260...3300, selectedLabel: "Alex Rowan",
                                            playSpan: { _, _ in }, zoom: { _, _ in }).padding(16)
            try snapshot(view, name: "talk-time-lanes-\(Int(width))", width: width)
        }
        try snapshot(SpeakerTalkTimeLanes(speakers: Self.speakers(), durationSec: 8772, timed: false, playSpan: { _, _ in }, zoom: { _, _ in }).padding(16),
                     name: "talk-time-untimed", width: 900)
    }

    // MARK: Hint chips

    func testHintChipsPlayShortRangesShowLongOnesAndCountTheRest() {
        let ranges: [SpeakerHint.Range] = [
            .init(lines: 3, fromSec: 724, toSec: 751, present: ["Mira Holt"]),
            .init(lines: 9, fromSec: 900, toSec: 1010),
            .init(lines: 2, fromSec: 100, toSec: 112),
            .init(lines: 1),
        ]
        let (chips, more) = HintChip.chips(for: ranges)
        XCTAssertEqual(chips.map(\.fromSec), [100, 724, 900], "time order; a range without times has no chip")
        XCTAssertEqual(chips.map(\.action), [.play, .play, .show], "longer than 30 s shows instead of playing")
        XCTAssertEqual(more, 0)
        let many = (0..<5).map { SpeakerHint.Range(lines: 1, fromSec: Double($0) * 60, toSec: Double($0) * 60 + 10) }
        let (shown, review) = HintChip.chips(for: many)
        XCTAssertEqual(shown.count, 3)
        XCTAssertEqual(review, 5, "Review 5 walks all five")
    }

    func testSnapshotHintChips() throws {
        let ranges: [SpeakerHint.Range] = [.init(lines: 2, fromSec: 100, toSec: 112), .init(lines: 3, fromSec: 724, toSec: 751),
                                           .init(lines: 9, fromSec: 900, toSec: 1010), .init(lines: 1, fromSec: 2000, toSec: 2008)]
        try snapshot(SpeakerHintChips(ranges: ranges, play: { _, _ in }, zoom: { _, _ in }).padding(12).fixedSize(),
                     name: "hint-chips", width: nil)
    }

    // MARK: Screen beside playback

    func testTheThrottleChangesTheFrameAtMostOncePerSecondAndKeepsTheOldOneUntilDecoded() {
        var throttle = ScreenFrameThrottle()
        XCTAssertEqual(throttle.offer("f1", at: 0), "f1")
        XCTAssertNil(throttle.shown, "the old frame (none) stays until f1 is decoded")
        XCTAssertNil(throttle.offer("f1", at: 0.1), "f1 is already decoding")
        XCTAssertTrue(throttle.decoded("f1", at: 0.2))
        XCTAssertEqual(throttle.shown, "f1")
        XCTAssertNil(throttle.offer("f2", at: 0.5), "too soon after the change")
        XCTAssertEqual(throttle.pending, "f2")
        XCTAssertNil(throttle.offer("f3", at: 0.9), "still too soon; the newest wins")
        XCTAssertEqual(throttle.pending, "f3")
        XCTAssertNil(throttle.due(at: 1.0))
        XCTAssertEqual(throttle.due(at: 1.25), "f3")
        XCTAssertEqual(throttle.offer("f4", at: 1.3), "f4", "a newer frame replaces the decode")
        XCTAssertFalse(throttle.decoded("f3", at: 1.4), "the replaced decode is dropped")
        XCTAssertEqual(throttle.shown, "f1")
        throttle.failed("f4")
        XCTAssertEqual(throttle.shown, "f1", "a failed decode keeps the old frame")
        XCTAssertEqual(throttle.offer("f4", at: 1.5), "f4", "and the next offer tries again")
    }

    /// One threshold: the tab shows the service's preview nearest the pane's "Apply above", so the preview and the
    /// pane's marks agree (a second picker kept 70 % while this one said 90 %).
    func testTheTranscriptTabShowsThePreviewOfTheOneThreshold() {
        func line(_ speaker: String) -> TranscriptLine { TranscriptLine(id: "l1", startSec: 0, speaker: speaker, text: "Hello") }
        let transcript = MeetingTranscript(previews: [.init(threshold: 0.7, entries: [line("at 70")]),
                                                      .init(threshold: 0.9, entries: [line("at 90")])],
                                           meeting: "m", entries: [line("plain")])
        XCTAssertEqual(TranscriptTab.shown(transcript, applyAbove: 90).map(\.speaker), ["at 90"])
        XCTAssertEqual(TranscriptTab.shown(transcript, applyAbove: 70).map(\.speaker), ["at 70"])
        XCTAssertEqual(TranscriptTab.shown(transcript, applyAbove: 60).map(\.speaker), ["at 70"], "the nearest preview")
        XCTAssertEqual(TranscriptTab.shown(MeetingTranscript(meeting: "m", entries: [line("plain")]), applyAbove: 90).map(\.speaker),
                       ["plain"], "no previews: the entries")
    }

    func testTheFollowKeepsTheHeardLineOfALongBlockInView() {
        let first = TranscriptHeard(blockID: "b-1", lineID: "1")
        XCTAssertEqual(TranscriptFollowTarget.of(from: nil, to: first), .block("b-1"), "the first heard line")
        XCTAssertEqual(TranscriptFollowTarget.of(from: first, to: TranscriptHeard(blockID: "b-1", lineID: "2")), .line("2"),
                       "the next line of one speaker's long block: it followed only a new block before")
        XCTAssertEqual(TranscriptFollowTarget.of(from: first, to: TranscriptHeard(blockID: "b-3", lineID: "3")), .block("b-3"))
        XCTAssertNil(TranscriptFollowTarget.of(from: first, to: TranscriptHeard(blockID: "b-1", lineID: "1", wordRange: NSRange(location: 4, length: 3))),
                     "only the heard word moved")
    }

    func testAskingForTheShownFrameAgainDropsTheDecodeInFlight() {
        var throttle = ScreenFrameThrottle()
        XCTAssertEqual(throttle.offer("a", at: 0), "a")
        XCTAssertTrue(throttle.decoded("a", at: 0.1))
        XCTAssertEqual(throttle.offer("b", at: 1.5), "b", "the position moves on: b decodes")
        XCTAssertNil(throttle.offer("a", at: 1.6), "a seek back: a is on screen already")
        XCTAssertNil(throttle.decoding)
        XCTAssertFalse(throttle.decoded("b", at: 1.7), "b's late completion would replace the frame the position wants")
        XCTAssertEqual(throttle.shown, "a")
        XCTAssertEqual(throttle.offer("b", at: 2.8), "b", "b asked again decodes again")
    }

    func testNoCaptureDrawsNoPane() throws {
        let view = ScreenBesidePlayback(recorded: false, image: nil, displays: [], pickDisplay: { _ in }).frame(width: 300)
        let renderer = ImageRenderer(content: view)
        let size = renderer.nsImage?.size ?? .zero
        XCTAssertEqual(size.height, 0, "no capture, no pane")
    }

    func testSnapshotScreenBesidePlayback() throws {
        let displays = [ScreenDisplayChoice(id: 1, name: "Built-in", frames: 120), ScreenDisplayChoice(id: 2, name: "Studio Display", frames: 258)]
        let hit = MomentFrame.Hit(text: "EMP", box: .init(x: 0.045, y: 0.61, width: 0.06, height: 0.055))
        try snapshot(ScreenBesidePlayback(recorded: true, image: Self.fakeFrame(), atSec: 3277, hit: hit, displays: displays,
                                          selectedDisplay: 2, pickDisplay: { _ in }, openFrame: {}),
                     name: "screen-beside-playback", width: 340)
        try snapshot(ScreenBesidePlayback(recorded: true, image: nil, atSec: 3277, displays: displays, pickDisplay: { _ in }),
                     name: "screen-beside-playback-reading", width: 340)
    }

    /// A screen-share-like frame drawn in code (no real capture).
    private static func fakeFrame() -> NSImage {
        let size = NSSize(width: 800, height: 500)
        return NSImage(size: size, flipped: true) { rect in
            NSColor(white: 0.12, alpha: 1).setFill()
            rect.fill()
            NSColor(white: 0.2, alpha: 1).setFill()
            NSRect(x: 0, y: 0, width: rect.width, height: 34).fill()
            let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 22, weight: .regular),
                                                             .foregroundColor: NSColor(white: 0.85, alpha: 1)]
            let lines = ["EmployeeSegmentDto", "", "code    label       required", "EMP     Employee    yes",
                         "ZAME    Internal    no", "buttons section     yes", "footer  section     no"]
            for (index, line) in lines.enumerated() {
                (line as NSString).draw(at: NSPoint(x: 40, y: 60 + CGFloat(index) * 36), withAttributes: attributes)
            }
            return true
        }
    }

    // MARK: Snapshot helper

    /// Renders the view light and dark; writes `<name>-light.png` and `<name>-dark.png` when MEETINGS_UI_SNAPSHOTS
    /// names a folder.
    private func snapshot<V: View>(_ view: V, name: String, width: CGFloat?) throws {
        for scheme in [ColorScheme.light, .dark] {
            let framed = Group {
                if let width {
                    view.frame(width: width).fixedSize(horizontal: false, vertical: true)
                } else {
                    view
                }
            }
            .background(Color(nsColor: .windowBackgroundColor))
            .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: framed)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.cgImage, "\(name) did not render")
            XCTAssertGreaterThan(image.width, 0)
            guard let folder = ProcessInfo.processInfo.environment["MEETINGS_UI_SNAPSHOTS"] else { continue }
            let url = URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(scheme == .dark ? "dark" : "light").png")
            let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
            try png?.write(to: url)
        }
    }
}
