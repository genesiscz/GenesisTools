import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsMeetings

/// The transcript lane's presentational views: transcript blocks, the selection popover and staged comments, the
/// talk-time lanes, the hint chips and the screen beside the sound. Pure rules are asserted; each view also renders,
/// and with `MEETINGS_UI_SNAPSHOTS=<folder>` its PNGs are written there (light and dark, 900 and 1400 pt wide).
@MainActor
final class MeetingsTranscriptViewsTests: XCTestCase {

    func testFrameReviewSearchAndTimeNavigation() throws {
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

    func testFrameReviewGroupsRepeatedOCRAndSearchesBothSources() throws {
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
        XCTAssertEqual(CommentDelivery.sent(comments: 1, listeners: 0).text, "Nobody listens: 1 comment stay staged")
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
        try snapshot(SelectionPopover(selection: selection, stage: { _, _ in }, clip: { _, _ in }).fixedSize(),
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
