import AppKit
import Foundation
import GenesisKit
import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsMeetings

/// P7: the Voices pane's data, the look of a name the voice model gave (transcript, rows, timeline), the Items tab's
/// empty state button (w_xow4oigk) and the ruler's end rooms (w_ehvp4b0b). The pane's calls over the service and the
/// long-call deadline are in MeetingsServiceTests (they need its fake service).
@MainActor
final class MeetingsVoicesTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    /// The text a view draws, read back from its picture (a SwiftUI view in a test has no accessibility tree).
    private func drawnText<V: View>(_ view: V, width: CGFloat) throws -> String {
        let renderer = ImageRenderer(content: view.frame(width: width).padding(12).background(Color(white: 0.12))
            .environment(\.colorScheme, .dark))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
    }

    // MARK: The service's replies

    func testTheVoicesRepliesOfTheProtocolFixtureDecode() throws {
        let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("meetings/lib/service/__fixtures__/meetings-protocol.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture)) as? [String: Any])
        let examples = try XCTUnwrap(root["examples"] as? [[String: Any]])
        func result<M: MeetingsServiceMethod>(_ method: M.Type) throws -> M.Result {
            let example = try XCTUnwrap(examples.first { $0["method"] as? String == M.name && ($0["reply"] as? [String: Any])?["result"] != nil },
                                        "an answered example of \(M.name)")
            let value = try XCTUnwrap((example["reply"] as? [String: Any])?["result"])
            return try JSONDecoder().decode(M.Result.self, from: JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
        }
        // A project with no voice samples: the people of its meetings, each with no sample.
        let listed = try result(MeetingsAPI.VoicesList.self).people
        XCTAssertFalse(listed.isEmpty)
        XCTAssertTrue(listed.allSatisfy { $0.samples.isEmpty && !$0.meetings.isEmpty })
        XCTAssertEqual(try result(MeetingsAPI.VoicesRemove.self).removed, 0)
        XCTAssertEqual(try result(MeetingsAPI.VoicesWorkers.self).auto, 2)
        // A service method this side calls has an example in the hello's method list.
        let hello = try XCTUnwrap(examples.first { $0["method"] as? String == "hello" && ($0["reply"] as? [String: Any])?["result"] != nil })
        let methods = try XCTUnwrap(((hello["reply"] as? [String: Any])?["result"] as? [String: Any])?["methods"] as? [String])
        for name in [MeetingsAPI.VoicesList.name, MeetingsAPI.VoicesPreview.name, MeetingsAPI.VoicesApply.name,
                     MeetingsAPI.VoicesRemove.name, MeetingsAPI.VoicesWorkers.name] {
            XCTAssertTrue(methods.contains(name), name)
        }
    }

    func testAPreviewCountsNamedOpenAndWaitingLinesOnceAndSaysEachReasonInWords() throws {
        let result = try decode(MeetingsAPI.VoicesPreview.Result.self, #"""
        {"meeting":"m","project":"Atlas","lines":[
          {"labeler":"voice","index":1,"seat":"call","fromSec":1,"toSec":4,"text":"One.","current":"Speaker 1","person":"Bob Example","score":0.71,"reason":"named"},
          {"labeler":"voice","index":2,"seat":"call","fromSec":5,"toSec":8,"text":"Two.","current":"Speaker 1","score":0.3,"next":{"person":"Dana Example","score":0},"reason":"unsampled-present"},
          {"labeler":"voice","index":3,"seat":"call","fromSec":9,"toSec":12,"text":"Three.","current":"Speaker 1","score":0.5,"next":{"person":"Dana Example","score":0},"reason":"unsampled-present"},
          {"labeler":"voice","index":4,"seat":"mic","fromSec":13,"toSec":13.5,"text":"Hm.","current":"Alice Example","reason":"no-voice"}]}
        """#)
        let summary = VoicesPreviewSummary(result.lines)
        XCTAssertEqual(summary.headline, "4 lines: 1 named, 3 left open")
        XCTAssertEqual(summary.waiting, ["Dana Example": 2])
        XCTAssertEqual(result.lines.map(\.outcome), ["Named Bob Example", "Waits for a sample of Dana Example",
                                                      "Waits for a sample of Dana Example", "Too short or no clear voice"])
        XCTAssertEqual(VoicesPane.waitingText("Dana Example", preview: summary),
                       "2 lines wait for one. Confirm one line of this person to add a sample.")
        XCTAssertEqual(VoicesPane.waitingText("Dana Example", preview: nil), "Preview counts the lines that wait for one.")
        XCTAssertEqual(VoiceScore.text(0.705), "0.70")
        XCTAssertEqual(VoiceModelMark.words(0.71), "by voice 0.71")
    }

    func testThePeopleOfTheMeetingComeFirstAndOthersOnlyWithSamples() throws {
        let people = try decode([VoicePerson].self, #"""
        [{"project":"Atlas","person":"Alice Example","meetings":["m"],"samples":[]},
         {"project":"Atlas","person":"Bob Example","meetings":["m","n"],"samples":[{"sample":1,"meeting":"n","seat":"call","track":"source-call","fromSec":3,"toSec":6,"confirmedAt":"2026-11-01T10:00:00Z","words":"Hello.","available":true}]},
         {"project":"Atlas","person":"Carol Example","meetings":["n"],"samples":[{"sample":1,"meeting":"n","seat":"mic","track":"source-mic","fromSec":1,"toSec":2,"confirmedAt":"2026-11-01T10:00:00Z","words":"Yes.","available":false}]},
         {"project":"Atlas","person":"Dana Example","meetings":["n"],"samples":[]}]
        """#)
        let split = VoicesPeople(people, meeting: "m")
        XCTAssertEqual(split.inMeeting.map(\.person), ["Alice Example", "Bob Example"])
        XCTAssertEqual(split.others.map(\.person), ["Carol Example"], "a person of another meeting with no sample is left out")
    }

    func testTheNamedLinesComeFromTheRecordsVoiceRangesWithTheirScoreStateAndWords() throws {
        let items = try decode([MeetingItem].self, #"""
        [{"id":"i2","kind":"speaker-range","status":"confirmed","label":"Speaker 1","fromSec":9,"toSec":9,"speaker":"Bob Example","rules":["voice-embedding"],"evidence":{"score":0.8,"transcriptLine":2,"endSec":12}},
         {"id":"i1","kind":"speaker-range","status":"suggested","label":"Speaker 1","fromSec":1,"toSec":1,"speaker":"Bob Example","confidence":0.6,"rules":["voice-embedding"],"evidence":{"score":0.71,"transcriptLine":0,"endSec":4}},
         {"id":"i3","kind":"speaker-range","status":"suggested","label":"Speaker 1","fromSec":5,"toSec":8,"speaker":"Bob Example","rules":["seat"]}]
        """#)
        let entries = [TranscriptLine(id: "a", startSec: 1, speaker: "Speaker 1", text: "First line."),
                       TranscriptLine(id: "b", startSec: 5, speaker: "Speaker 1", text: "Second line."),
                       TranscriptLine(id: "c", startSec: 9, speaker: "Speaker 1", text: "Third line.")]
        let lines = VoiceNamedLine.of(items: items, entries: entries)
        XCTAssertEqual(lines.map(\.id), ["i1", "i2"], "only the voice model's ranges, in time order")
        XCTAssertEqual(lines.first?.score, 0.71, "the evidence's cosine, not the item's confidence")
        XCTAssertEqual(lines.first?.toSec, 4, "the line's end")
        XCTAssertEqual(lines.map(\.text), ["First line.", "Third line."])
        XCTAssertEqual(lines.map(\.state), [.suggested, .confirmed])
        XCTAssertEqual(VoiceNamedLine.of(items: items, entries: nil).first?.text, nil, "no transcript read: no words, no guess")
    }

    func testTheRemovalQuestionSaysWhatItAlsoChanges() {
        let plan = MeetingsAPI.VoicesRemove.Result(project: "Atlas", person: "Bob Example", removed: 1,
                                                   affected: [.init(meeting: "m", item: "i1", fromSec: 1, toSec: 1),
                                                              .init(meeting: "m", item: "i4", fromSec: 9, toSec: 9)])
        XCTAssertEqual(VoicesModel.removalQuestion(.init(person: "Bob Example", sample: 3, plan: plan)),
                       "Remove sample 3 of Bob Example? 2 suggested lines lose the name Bob Example.")
        XCTAssertEqual(VoicesModel.removedText(plan), "Removed 1 sample of Bob Example; 2 suggested lines lost the name")
        XCTAssertEqual(VoicesModel.decidedText(count: 1, confirm: false),
                       "Marked 1 line as not this person; the voice model will not name it so again")
        XCTAssertEqual(VoicesModel.appliedText(0), "The voice model named no new lines")
    }

    // MARK: A model name looks different (ux 12a)

    func testAVoiceNameIsItsOwnStateInTheTranscriptAndAConfirmedOneIsAName() throws {
        let voiced = try decode(TranscriptLine.self, #"""
        {"id":"a","startSec":4,"speaker":"Speaker 2","text":"A line.","suggestedSpeaker":"Bob Example","band":"applied","nameSource":"voice","nameScore":0.71}
        """#)
        XCTAssertEqual(voiced.who, .voice("Bob Example"))
        XCTAssertEqual(voiced.who.title, "Bob Example")
        let confirmed = try decode(TranscriptLine.self, #"""
        {"id":"b","startSec":8,"speaker":"Speaker 2","text":"Another.","suggestedSpeaker":"Bob Example","band":"confirmed"}
        """#)
        XCTAssertEqual(confirmed.who, .name("Speaker 2"))
        let blocks = TranscriptBlock.build(from: [voiced, confirmed])
        XCTAssertEqual(blocks.count, 2, "a voice name and a plain name are two blocks")
        XCTAssertTrue(blocks[0].lines[0].marks.contains(.byVoice))
        XCTAssertEqual(blocks[0].lines[0].voiceScore, 0.71)
        XCTAssertFalse(blocks[1].lines[0].marks.contains(.byVoice))

        let text = try drawnText(VStack(alignment: .leading) {
            ForEach(blocks) { block in TranscriptBlockView(block: block, heardLineID: nil, selected: [], past: false, play: { _ in }) }
        }, width: 460)
        XCTAssertTrue(text.contains("by voice"), text)
        XCTAssertTrue(text.contains("0.71"), text)
    }

    func testAVoiceRowCarriesTheMarkAndItsPinTheWaveform() throws {
        let row = try decode(ReviewRow.self, #"""
        {"id":"i1","label":"i1","kind":"speaker-range","status":"suggested","confidence":0.71,"rules":["voice-embedding"],
         "what":"Speaker 2 → Bob Example","parts":[],"choices":[
           {"value":"Bob Example","label":"Bob Example","role":"suggested","action":{"kind":"confirm"},"confidence":0.71},
           {"value":"none of these","label":"Not this person","role":"none","action":{"kind":"reject"}}],
         "edit":"person","sources":[],"target":{"kind":"range","fromSec":4,"toSec":4}}
        """#)
        XCTAssertTrue(row.isVoiceModel)
        XCTAssertEqual(row.choices.last?.label, "Not this person")
        let pin = try XCTUnwrap(TimelinePin(row: row))
        XCTAssertTrue(pin.byVoice)
        XCTAssertEqual(pin.symbol(.hueAndGlyph), "waveform")
        XCTAssertEqual(pin.stateWords, "open, by voice 0.71")
        var decided = row
        decided.status = "confirmed"
        XCTAssertEqual(TimelinePin(row: decided)?.symbol(.hueAndGlyph), "checkmark", "a confirmed voice name is a confirmed pin")
        let text = try drawnText(VoiceModelMark(score: 0.71, size: 14), width: 120)
        XCTAssertTrue(text.contains("0.71"), text)
    }

    func testTheVoicesPaneTakesTheTrailingSlotAndTheSettingsPanelWins() {
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .transcript, width: 900, setting: .auto, sidePanelOpen: false, voicesOpen: true), .voices)
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: 2000, setting: .always, sidePanelOpen: true, voicesOpen: true), .settings)
        XCTAssertEqual(MeetingDetailView.trailingPane(tab: .items, width: 2000, setting: .always, sidePanelOpen: false), .transcript)
    }

    func testInANarrowColumnTheVoicesPaneTakesTheColumnAndAMarkedLineTakesItsScoreFromItsRange() throws {
        XCTAssertTrue(MeetingDetailView.voicesAlone(open: true, width: 600, sidePanelOpen: false))
        XCTAssertFalse(MeetingDetailView.voicesAlone(open: true, width: 1100, sidePanelOpen: false))
        XCTAssertFalse(MeetingDetailView.voicesAlone(open: true, width: 600, sidePanelOpen: true), "the settings panel goes first")
        XCTAssertFalse(MeetingDetailView.voicesAlone(open: false, width: 600, sidePanelOpen: false))
        // A line under an open question keeps "Who is this?" as its name; its mark still says the model's score.
        let entry = TranscriptLine(id: "q", startSec: 39, speaker: "Speaker 2", text: "Under a question.")
        let item = try decode(MeetingItem.self, #"""
        {"id":"i9","kind":"speaker-range","status":"suggested","label":"Speaker 2","fromSec":39,"toSec":39,"speaker":"Bob Example","rules":["voice-embedding"],"evidence":{"score":0.76}}
        """#)
        let blocks = TranscriptBlock.build(from: [entry], marks: [entry.rowID: [.byVoice]], items: [item])
        XCTAssertEqual(blocks.first?.lines.first?.voiceScore, 0.76)
    }

    func testRunningTheRulesAgainSaysWhatHappensToTheItemsThereAre() throws {
        XCTAssertEqual(RunRulesPopover.lines, [
            "Confirmed and rejected items stay as they are.",
            "A suggestion you rejected is not suggested again.",
            "New suggestions and questions are added.",
            "An open suggestion that a dictionary entry or a voice name now settles is retired.",
        ])
        let text = try drawnText(RunRulesPopover(cancel: {}, run: {}), width: 340)
        XCTAssertTrue(text.contains("Run the rules"), text)
        XCTAssertTrue(text.contains("stay as they are"), text)
        let strip = try drawnText(SuggestRunStrip(progress: .init(fraction: 0.4, label: "Voices: 120 of 300 lines")) {}, width: 560)
        XCTAssertTrue(strip.contains("Cancel"), strip)
        XCTAssertTrue(strip.contains("(40 %)"), strip)
        let empty = try drawnText(SuggestRunView(progress: nil) {}, width: 420)
        XCTAssertTrue(empty.contains("Cancel"), empty)
    }

    // MARK: w_xow4oigk: the empty state's button    // MARK: w_xow4oigk: the empty state's button

    /// With a second closure parameter after `action`, Swift 5 mode bound the trailing closure of
    /// `EmptyState(…, actionTitle: "Suggest items") { … }` to the last one, and the button was never drawn.
    func testTheItemsEmptyStateDrawsItsSuggestButtonAndATrailingClosureIsTheMainAction() throws {
        let withTranscript = try drawnText(ItemsEmptyState(hasTranscript: true) {}, width: 420)
        XCTAssertTrue(withTranscript.contains("Suggest items"), withTranscript)
        let without = try drawnText(ItemsEmptyState(hasTranscript: false) {}, width: 420)
        XCTAssertFalse(without.contains("Suggest items"), without)
        XCTAssertTrue(without.contains("has none"), without)

        let trailing = try drawnText(EmptyState(text: "Nothing here", actionTitle: "Clear filter") {}, width: 420)
        XCTAssertTrue(trailing.contains("Clear filter"), trailing)
        let both = try drawnText(EmptyState(text: "No transcript", actionTitle: "Link a meeting", action: {},
                                            secondary: .init("Show the screen recording", symbol: "display") {}), width: 520)
        XCTAssertTrue(both.contains("Link a meeting"), both)
        XCTAssertTrue(both.contains("Show the screen recording"), both)
    }

    // MARK: w_ehvp4b0b: each ruler end has the room of its own label

    func testTheRulerKeepsTheFirstMarkBesideTheShortStartLabel() {
        let duration = 2 * 3600 + 52 * 60 + 9.0
        XCTAssertEqual(SpeakerTalkTimeLanes.rulerMarks(durationSec: duration), [0, 1800, 3600, 5400, 7200, 9000, duration])
        // About the lanes' width at 900 x 600: the old shared 80 pt room dropped 0:30:00 beside "00:00".
        let narrow = SpeakerTalkTimeLanes.innerRulerMarks(durationSec: duration, width: 380)
        XCTAssertEqual(narrow.first, 1800, "0:30:00 stays beside 00:00")
        XCTAssertFalse(narrow.contains(9000), "2:30:00 would touch 2:52:09, so it leaves")
        let wide = SpeakerTalkTimeLanes.innerRulerMarks(durationSec: duration, width: 900)
        XCTAssertEqual(wide, [1800, 3600, 5400, 7200, 9000])
        // No inner mark overlaps an end label at any width.
        for width in stride(from: 120.0, through: 1200, by: 20) {
            for sec in SpeakerTalkTimeLanes.innerRulerMarks(durationSec: duration, width: width) {
                let x = sec / duration * width
                let half = Double(SpeakerTalkTimeLanes.rulerLabelWidth(MeetingsFormat.clock(sec))) / 2
                XCTAssertGreaterThan(x - half, Double(SpeakerTalkTimeLanes.rulerLabelWidth("00:00")), "width \(width)")
                XCTAssertLessThan(x + half, width - Double(SpeakerTalkTimeLanes.rulerLabelWidth(MeetingsFormat.clock(duration))), "width \(width)")
            }
        }
    }
}
