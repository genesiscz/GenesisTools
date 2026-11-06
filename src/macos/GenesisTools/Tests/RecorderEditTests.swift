import AppKit
import AVFoundation
import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsRecorder

/// A case file in src/utils/recording-editor/__fixtures__/ that the TypeScript tests run too, so the two copies of a
/// rule fail together when one of them changes.
enum SharedEditorFixture {
    static func url(_ name: String) -> URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("utils/recording-editor/__fixtures__/\(name)")
    }

    static func cases(_ name: String) throws -> [[String: Any]] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url(name))) as? [String: Any])
        return try XCTUnwrap(root["cases"] as? [[String: Any]], "\(name) has no cases")
    }

    /// What `tools recorder words` printed for transcript-cuts.json's segments (toolsets.test.ts keeps it current).
    static func transcriptWords() throws -> [TranscriptLineWords] {
        struct File: Decodable { let lines: [TranscriptLineWords] }
        return try JSONDecoder().decode(File.self, from: Data(contentsOf: url("transcript-words.json"))).lines
    }
}

/// Pictures of editor views for review, written into `RECORDER_EDITOR_SHOTS` (or the temporary folder) from an
/// off-screen borderless window that is never shown, never key: `cacheDisplay` draws AppKit-backed controls too.
@MainActor
enum EditorShots {
    @discardableResult
    static func write<V: View>(_ view: V, name: String, width: CGFloat) throws -> CGImage {
        let host = NSHostingView(rootView: view.frame(width: width, alignment: .topLeading)
            .background(RecorderPalette.window)
            .environment(\.colorScheme, .dark))
        host.frame = CGRect(origin: .zero, size: CGSize(width: width, height: max(40, host.fittingSize.height)))
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        let dir = ProcessInfo.processInfo.environment["RECORDER_EDITOR_SHOTS"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: dir.appendingPathComponent("\(name).png"))
        return try XCTUnwrap(rep.cgImage)
    }

    /// The words Vision reads in a picture, joined, for asserting what a view shows.
    static func text(_ image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        // Vision reads curly quotes as straight ones, so both compare as straight.
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " | ")
            .replacingOccurrences(of: "“", with: "\"").replacingOccurrences(of: "”", with: "\"")
    }
}

/// The Captions tab's cut by transcript, rendered with a transcript and the words the door printed.
@MainActor
final class RecorderTranscriptCutViewTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("transcript-cut-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// The shared transcript, cached beside the movie as the window finds it.
    private func writeTranscript() throws {
        let cuts = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: SharedEditorFixture.url("transcript-cuts.json"))) as? [String: Any])
        let segments = try JSONSerialization.data(withJSONObject: ["segments": try XCTUnwrap(cuts["segments"])])
        try segments.write(to: folder.appendingPathComponent("talk.transcript.json"))
    }

    /// A model of a movie with the shared transcript cached beside it, and its words read.
    private func model() throws -> EditorModel {
        try writeTranscript()
        let project = EditProject.whole(video: folder.appendingPathComponent("talk.mp4").path, durationUs: 60_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
        model.lineWords = try SharedEditorFixture.transcriptWords()
        return model
    }

    func testTheCaptionLinesOfferTheFillerCutAndAScissorsPerLine() throws {
        let model = try model()
        XCTAssertTrue(model.hasTranscript)
        let image = try EditorShots.write(CaptionLinesList(model: model).padding(18), name: "captions-cut-by-transcript", width: 300)
        let text = try EditorShots.text(image).lowercased()
        for word in ["cut filler words", "sounds", "sounds and words", "cut fillers", "lines", "hello, ehm"] {
            XCTAssertTrue(text.contains(word), "\(word) missing from: \(text)")
        }
    }

    // Regression test: 2026-11-05 review of the editor gaps, R1.2. The words were read once, and a transcript that
    // changed before the cut moved the place count, so the cut took other words. The pick now sends its times, the
    // service refuses a pick whose words moved (recording-editor.test.ts), and the refusal reads the words again.
    func testAWordPickRefusedForAChangedTranscriptReadsTheWordsAgain() throws {
        try writeTranscript()
        let stale = try SharedEditorFixture.transcriptWords()
        let line = try XCTUnwrap(stale.first { $0.start == 20 })
        let refusal = #"the transcript changed since the words were picked: the line at 20 s no longer says "jako" from 22.9 s to 23.3 s; pick them again"#
        let project = EditProject.whole(video: folder.appendingPathComponent("talk.mp4").path, durationUs: 60_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let service = FakeServiceLink(project: project) { _, _ in
            throw LiveRecordingRPCClient.Failure.remote(code: 1010, message: refusal)
        }
        service.serviceMethods.append("movie.lineWords")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: SharedEditorFixture.url("transcript-words.json"))) as? [String: Any])
        var lines = try XCTUnwrap(file["lines"] as? [[String: Any]])
        let at = try XCTUnwrap(lines.firstIndex { ($0["start"] as? Double) == 20 })
        var words = try XCTUnwrap(lines[at]["words"] as? [[String: Any]])
        words.remove(at: 4)
        lines[at]["words"] = words
        service.movieAnswer = { name, _ in name == "lineWords" ? lines : nil }
        let model = EditorModel.on(service, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
        XCTAssertTrue(model.hasTranscript)
        model.lineWords = stale

        model.cutWords(line, picked: 6...6)

        XCTAssertEqual(service.sentOps.first?["from"] as? Double, 22.9, "the pick names its place by the word's times")
        XCTAssertEqual(service.count("movie.lineWords"), 1, "the refusal reads the words again")
        XCTAssertEqual(model.lineWords?.first { $0.start == 20 }?.words.map(\.fold), ["hmm", "hmm", "we", "start", "now", "jako", "always"])
        XCTAssertEqual(model.notice, "“jako” was not cut: \(refusal)")
        XCTAssertTrue(model.noticeIsError)
    }

    // Regression test: 2026-11-05 review of the editor gaps, R1.2. The scissors read the words only while none were
    // read, so a transcript written again (another transcription) or a line fix left the picker on the old words.
    func testTheScissorsReadTheWordsAgainOnlyWhenTheTranscriptOrItsFixesChanged() throws {
        try writeTranscript()
        let project = EditProject.whole(video: folder.appendingPathComponent("talk.mp4").path, durationUs: 60_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let service = FakeServiceLink(project: project) { project, op in
            var next = project
            next.transcript = EditProject.TranscriptSettings(fixes: [String(Int(((op["from"] as? Double) ?? 0) * 1000)): op["text"] as? String ?? ""])
            return next
        }
        service.serviceMethods.append("movie.lineWords")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: SharedEditorFixture.url("transcript-words.json"))) as? [String: Any])
        let lines = try XCTUnwrap(file["lines"] as? [[String: Any]])
        service.movieAnswer = { name, _ in name == "lineWords" ? lines : nil }
        let model = EditorModel.on(service, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))

        model.readLineWordsIfChanged()
        model.readLineWordsIfChanged()
        XCTAssertEqual(service.count("movie.lineWords"), 1, "nothing changed: the words are read once")

        let transcript = folder.appendingPathComponent("talk.transcript.json")
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(60)], ofItemAtPath: transcript.path)
        model.readLineWordsIfChanged()
        XCTAssertEqual(service.count("movie.lineWords"), 2, "another transcription wrote the file")

        let line = try XCTUnwrap(model.zoom.captionLines.first { $0.fromUs == 20_000_000 })
        model.fixCaption(line, text: "We start now, always.")
        XCTAssertNotNil(model.project.transcript)
        model.readLineWordsIfChanged()
        XCTAssertEqual(service.count("movie.lineWords"), 3, "a line fix changes the line's words")
    }

    func testTheWordPickerShowsTheLinesWordsAndNamesThePickedOnes() throws {
        let model = try model()
        let line = try XCTUnwrap(model.zoom.captionLines.first { $0.fromUs == 20_000_000 })
        let picker = TranscriptWordPicker(model: model, line: line, picked: 6...6) {}
        let image = try EditorShots.write(picker, name: "captions-word-picker", width: 320)
        let text = try EditorShots.text(image).lowercased()
        for word in ["cut words of this line", "hmm,", "start", "always", "cut \"jako\"", "estimated"] {
            XCTAssertTrue(text.contains(word), "\(word) missing from: \(text)")
        }
    }
}

/// The Find tab with the moments find-screen printed for the shared meeting fixture.
@MainActor
final class RecorderScreenFindViewTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("screen-find-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func model() -> EditorModel {
        let project = EditProject.whole(video: folder.appendingPathComponent("proxy.mp4").path, durationUs: 15_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        return EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
    }

    func testAContinuousChangeKeepsItsOriginalMark() throws {
        let model = model()
        let original = model.project
        model.change { $0.audio.volume = 0.4 }
        XCTAssertEqual(model.gesture?.mark, original)
        model.change { $0.audio.volume = 0.7 }
        XCTAssertEqual(model.gesture?.mark, original)
        XCTAssertEqual(model.project.audio.volume, 0.7)
        model.gesture?.commit?.cancel()
    }

    func testTheFindTabListsEachMomentWithItsDisplayAndAClickGoesThere() throws {
        let model = model()
        let hits = try Self.hits()
        model.displayPlan = DisplayPlan(policy: "most-change", windowSec: 10,
                                        ranges: [.init(fromUs: 0, toUs: 10_000_000, displayId: 1), .init(fromUs: 10_000_000, toUs: 15_000_000, displayId: 4)],
                                        displays: [(1, "Built-in Retina Display"), (4, "Studio")])
        model.screenQuery = "token"
        model.screenHits = hits
        XCTAssertEqual(hits.map(\.shown), [true, false, true])
        XCTAssertEqual(hits.map(\.sourceUs), [0, 4_000_000, 12_500_000])

        let image = try EditorShots.write(ScreenFindInspector(model: model).padding(18), name: "find-on-screen", width: 300)
        let text = try EditorShots.text(image).lowercased()
        for word in ["find on screen", "3 moments", "api token: sk-123", "studio, not shown then", "00:12.5", "tokén list"] {
            XCTAssertTrue(text.contains(word), "\(word) missing from: \(text)")
        }

        model.goToScreenHit(2)
        XCTAssertEqual(model.selectedScreenHit, 2)
        XCTAssertEqual(model.clock.outUs, 12_500_000, "the playhead goes to the moment")

        // The selected moment offers to hide its text, and the preview outlines the line where the movie shows it.
        let selected = try EditorShots.write(ScreenFindInspector(model: model).padding(18), name: "find-on-screen-selected", width: 300)
        let offers = try EditorShots.text(selected).lowercased()
        for word in ["hide this text", "mark it", "cut this moment"] {
            XCTAssertTrue(offers.contains(word), "\(word) missing from: \(offers)")
        }
        let preview = ZStack {
            LinearGradient(colors: [Color(white: 0.25), Color(white: 0.1)], startPoint: .top, endPoint: .bottom)
            Text("Tokén list").font(.system(size: 13)).foregroundStyle(.white)
                .position(x: 640 * (0.2 + 0.125), y: 360 * (0.725 + 0.0225))
            ScreenBoxOverlay(model: model, clock: model.clock)
        }
        .frame(width: 640, height: 360)
        try EditorShots.write(preview, name: "find-on-screen-box-on-preview", width: 640)
    }

    /// The hits as find-screen --json and the REPL's findOnScreen answer them: with the ops that hide, mark or cut each.
    private static func hits() throws -> [ScreenHit] {
        let fixture = try RecorderFixtures.object("screen-hit-ops.json")
        return try JSONDecoder().decode([ScreenHit].self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(fixture["hits"])))
    }

    // The plan's B2 (2026-11-04): a found box becomes a hidden part, a box annotation or a cut. The window sends the ops
    // the answer names (src/recorder/lib/screen-ops.ts), as they are, one `tools recorder apply` each: one undo step.
    func testAScreenBoxBecomesAHiddenPartAMarkOrACutThroughTheOpsTheAnswerNames() throws {
        let model = model()
        let hits = try Self.hits()
        let hit = hits[2]
        XCTAssertEqual(hit.untilSec, 14.5)
        XCTAssertEqual(hit.boxes.first?.y ?? 0, 0.725, accuracy: 1e-9, "the 16:9 display sits between bars in the 16:10 movie")
        XCTAssertTrue(hits[1].ops.cut.isEmpty && hits[1].boxes.isEmpty, "a display the movie does not show has nothing to change")
        let fixture = try XCTUnwrap(try RecorderFixtures.object("screen-hit-ops.json")["hits"] as? [[String: Any]])
        let named = try XCTUnwrap(fixture[2]["ops"] as? [String: [Any]])

        var sent: [[String]] = []
        model.runTools = { argv, done in
            sent.append(argv)
            done(1, "", "no edit to change\n")
        }
        model.hideScreenText(hit)
        model.markScreenText(hit, box: 0)
        model.cutScreenMoment(hit)
        XCTAssertEqual(sent.map { Array($0.prefix(3)) }, Array(repeating: ["recorder", "apply", model.project.source.video], count: 3))
        let ops = try sent.map { try XCTUnwrap(JSONSerialization.jsonObject(with: Data($0[3].utf8)) as? [Any]) }
        XCTAssertEqual(try normalized(ops[0]), try normalized(try XCTUnwrap(named["hide"])), "the blur the answer names")
        XCTAssertEqual(try normalized(ops[1]), try normalized(try XCTUnwrap(named["mark"])), "the box round the line")
        XCTAssertEqual(try normalized(ops[2]), try normalized(try XCTUnwrap(named["cut"])), "the frame's time")
        XCTAssertTrue(model.noticeIsError, "a refused op says so")
    }

    private func normalized(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }

    func testAMovieWithoutARecordingSaysWhyItHasNoScreenText() throws {
        let model = model()
        model.screenQuery = "token"
        model.screenSearchFailure = EditorModel.screenSearchProblem(stderr: "/x has no recording.json; make the proxy first\n", status: 1)
        XCTAssertTrue(model.screenSearchFailure?.hasPrefix("This movie has no screen text.") == true)
        XCTAssertEqual(EditorModel.screenSearchProblem(stderr: "boom\nthe last line\n", status: 2), "The search did not run: the last line")
        let image = try EditorShots.write(ScreenFindInspector(model: model).padding(18), name: "find-on-screen-no-text", width: 300)
        XCTAssertTrue(try EditorShots.text(image).lowercased().contains("no screen text"))
    }
}

final class RecorderEditTests: XCTestCase {
    /// The word pick reads what `tools recorder words` prints and sends the place of the picked words, as the
    /// `cutWords` op numbers them (it cuts every run of the same folded words).
    func testTheWordPickSendsThePlaceOfThePickedWordsAsCutWordsNumbersThem() throws {
        let lines = try SharedEditorFixture.transcriptWords()
        XCTAssertEqual(lines.count, 5)
        let start = try XCTUnwrap(lines.first { $0.start == 20 })
        XCTAssertEqual(start.words.map(\.fold), ["hmm", "hmm", "we", "start", "jako", "now", "jako", "always"])
        XCTAssertEqual(EditorModel.occurrence(of: 6...6, in: start.words), 2)
        XCTAssertEqual(EditorModel.occurrence(of: 4...4, in: start.words), 1)
        XCTAssertEqual(EditorModel.occurrence(of: 1...1, in: start.words), 2, "the second hmm, though its word is \"hmm.\"")
        let you = try XCTUnwrap(lines.first { $0.start == 30 })
        XCTAssertEqual(EditorModel.occurrence(of: 3...4, in: you.words), 2, "the second \"you know\"")
        XCTAssertEqual(EditorModel.occurrence(of: 0...1, in: you.words), 1)
        let op = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(EditorModel.cutWordsOp(start, picked: 6...6).utf8)) as? NSDictionary)
        XCTAssertEqual(op, ["op": "cutWords", "at": 20, "words": "jako", "occurrence": 2, "from": 22.9, "to": 23.3] as NSDictionary,
                       "the place by its count and by the picked word's times")
        let run = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(EditorModel.cutWordsOp(you, picked: 3...4).utf8)) as? NSDictionary)
        XCTAssertEqual(run["words"] as? String, "you know")
        XCTAssertEqual(run["from"] as? Double, 32, "where \"you\" starts")
        XCTAssertEqual(run["to"] as? Double, 32.6, "where \"know\" ends")
    }

    /// A recording folder with files, each `[name, seconds after a fixed time]`, as recording-movies.json lists them.
    private func recordingFolder(_ files: [[Any]]) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("movie-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let base = Date(timeIntervalSince1970: 1_793_000_000)
        for file in files {
            let url = folder.appendingPathComponent(try XCTUnwrap(file.first as? String))
            try Data("x".utf8).write(to: url)
            let offset = try XCTUnwrap(file.last as? NSNumber).doubleValue
            try FileManager.default.setAttributes([.modificationDate: base.addingTimeInterval(offset)], ofItemAtPath: url.path)
        }
        return folder
    }

    /// The movie cases as the TypeScript test runs them (library.test.ts): the menu, the library and the editor pick
    /// the same file as `tools recorder copy` and `movieOf`.
    func testTheMovieOfARecordingFolderMatchesTheSharedCases() throws {
        let cases = try SharedEditorFixture.cases("recording-movies.json")
        XCTAssertGreaterThanOrEqual(cases.count, 7)
        for item in cases {
            let name = try XCTUnwrap(item["name"] as? String)
            let folder = try recordingFolder(try XCTUnwrap(item["files"] as? [[Any]]))
            defer { try? FileManager.default.removeItem(at: folder) }
            XCTAssertEqual(RecordingMovie.own(in: folder)?.lastPathComponent, item["movie"] as? String, name)
            XCTAssertEqual(RecordingMovie.shareable(in: folder)?.lastPathComponent, item["shareable"] as? String, name)
        }
    }

    /// The defect: a search hit showed "00:17 marker one" under the card, but VoiceOver read only "title, 00:31, not
    /// edited", so it never said why the card matched (review 2026-11-06).
    func testALibraryCardSaysItsSearchHitToVoiceOver() {
        let folder = URL(fileURLWithPath: "/tmp/library/video-1")
        var item = RecorderMenu.Recent(folder: folder, title: "Demo", started: .distantPast, thumbnail: nil, hasMovie: true)
        item.durationMs = 31_000
        let hit = LibraryModel.SpokenHit(at: 17, text: "marker one", marker: true, more: [21, 25])
        XCTAssertEqual(LibraryCard.accessibilityLabel(item, spoken: nil), "Demo, 00:31, not edited")
        XCTAssertEqual(LibraryCard.accessibilityLabel(item, spoken: hit),
                       "Demo, 00:31, not edited, marker at 00:17: marker one, 2 more matches")
        item.failure = "cannot record the window"
        XCTAssertEqual(LibraryCard.accessibilityLabel(item, spoken: nil), "Demo, did not record: cannot record the window")
    }

    /// The defect: a start that failed left a card with a "Frames" badge and no reason; it now says it failed and why.
    func testAFailedRecordingWithNoMovieReadsAsFailedWithItsFirstWarning() throws {
        let library = FileManager.default.temporaryDirectory.appendingPathComponent("library-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: library) }
        let failed = library.appendingPathComponent("video-2026-11-06_20-55-16-57cdab2d")
        let frames = library.appendingPathComponent("frames-2026-11-06_20-56-00-1a2b3c4d")
        for folder in [failed, frames] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        try Data(#"{"title":"Window","startedAt":"2026-11-06T19:55:16.000Z","frames":[],"settings":{"kind":"video","outcome":"failed"},"warnings":["cannot record the window"]}"#.utf8)
            .write(to: failed.appendingPathComponent("recording.json"))
        try Data(#"{"title":"Frames","startedAt":"2026-11-06T19:56:00.000Z","frames":[],"settings":{"kind":"frames"},"warnings":[]}"#.utf8)
            .write(to: frames.appendingPathComponent("recording.json"))

        let items = RecorderMenu.readRecents(library)
        XCTAssertEqual(items.first { $0.title == "Window" }?.failure, "cannot record the window")
        XCTAssertNil(items.first { $0.title == "Frames" }?.failure)
    }

    /// The defect: a meeting recording with only proxy.mp4 was offered Copy Movie and the click found no movie.
    @MainActor
    func testAProxyOnlyMeetingRecordingOffersCopyMovieAndTheCopyFindsTheProxy() throws {
        let meetings = FileManager.default.temporaryDirectory.appendingPathComponent("meetings-\(UUID().uuidString)")
        let folder = meetings.appendingPathComponent("2026-11-04_10-00-standup")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: meetings) }
        try Data(#"{"title":"Standup","startedAt":"2026-11-04T10:00:00.000Z","frames":[]}"#.utf8).write(to: folder.appendingPathComponent("recording.json"))
        try Data("{}".utf8).write(to: folder.appendingPathComponent("meeting.json"))
        try Data("movie".utf8).write(to: folder.appendingPathComponent("proxy.mp4"))

        let item = try XCTUnwrap(RecorderMenu.readRecents(meetings, isMeeting: true).first)
        XCTAssertTrue(item.hasMovie)
        XCTAssertEqual(item.thumbnail?.lastPathComponent, "proxy.mp4")
        XCTAssertTrue(RecordingAction.offered(for: item).contains(.copyMovie))
        let pasteboard = NSPasteboard(name: .init("genesistools-tests-\(UUID().uuidString)"))
        RecordingActions.pasteboard = pasteboard
        defer {
            pasteboard.releaseGlobally()
            RecordingActions.pasteboard = .general
        }
        var outcome: RecordingActions.Outcome?
        RecordingActions.run(.copyMovie, item) { outcome = $0 }
        XCTAssertEqual((pasteboard.readObjects(forClasses: [NSURL.self]) as? [URL])?.first?.lastPathComponent, "proxy.mp4")
        guard case let .notice(text) = outcome else { return XCTFail("Copy Movie did not copy: \(String(describing: outcome))") }
        XCTAssertEqual(text, "Copied proxy.mp4 to the clipboard.")
    }

    private func project(_ clips: [EditProject.Clip], zooms: [EditProject.Zoom] = []) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        project.zooms = zooms
        return project
    }

    /// Only `tools recorder export` cleans the sound, so an MP4 with noise reduction goes there; a plain MP4 stays in
    /// the window's own renderer (progress and Cancel), and a GIF or WebM always goes to the CLI.
    func testAnMP4WithNoiseReductionExportsThroughTheCLIAndAPlainOneInTheWindow() {
        var edit = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 10_000_000)])
        XCTAssertEqual(EditorModel.exportRoute(edit), .window)
        edit.export.format = .mp4
        XCTAssertEqual(EditorModel.exportRoute(edit), .window)
        edit.audio.denoise = EditProject.Denoise(method: "afftdn", reductionDb: 12, tracks: nil)
        XCTAssertEqual(EditorModel.exportRoute(edit), .tools(.mp4))
        edit.export.format = .gif
        XCTAssertEqual(EditorModel.exportRoute(edit), .tools(.gif))
        edit.audio.denoise = nil
        XCTAssertEqual(EditorModel.exportRoute(edit), .tools(.gif))
        edit.export.format = nil
        edit.audio.denoise = EditProject.Denoise(method: "afftdn", reductionDb: 12, tracks: nil)
        XCTAssertEqual(EditorModel.exportRoute(edit), .tools(.mp4), "no format is an MP4")
    }

    func testTheExportsNoiseReductionSurvivesADecodeAndEncode() throws {
        let json = #"{"include":true,"volume":1,"mutedTracks":[],"denoise":{"method":"afftdn","reductionDb":20,"tracks":[1]}}"#
        let audio = try JSONDecoder().decode(EditProject.AudioSettings.self, from: Data(json.utf8))
        XCTAssertEqual(audio.denoise, EditProject.Denoise(method: "afftdn", reductionDb: 20, tracks: [1]))
        let again = try JSONDecoder().decode(EditProject.AudioSettings.self, from: JSONEncoder().encode(audio))
        XCTAssertEqual(again, audio, "a save from the editor keeps the setting")
        let older = try JSONDecoder().decode(EditProject.AudioSettings.self, from: Data(#"{"include":true,"volume":1,"mutedTracks":[]}"#.utf8))
        XCTAssertNil(older.denoise)
    }

    func testEffectMovesAndTrimsUseSourceTimeAtClipSpeeds() {
        var project = EditProject.whole(video: "/fixture.mp4", durationUs: 10_000_000, width: 640, height: 480, cursor: nil, recording: nil)
        project.clips[0].speed = 2
        XCTAssertEqual(TimelineMap.sourceShift(outputDeltaUs: 1_000_000, atSource: 1_000_000, in: project), 2_000_000)
        project.clips[0].speed = 0.5
        XCTAssertEqual(TimelineMap.sourceShift(outputDeltaUs: 1_000_000, atSource: 1_000_000, in: project), 500_000)
        var first = project.clips[0]
        first.fromUs = 2_000_000; first.toUs = 4_000_000; first.speed = 2
        var second = first
        second.id = "second"; second.fromUs = 7_000_000; second.toUs = 9_000_000; second.speed = 0.5
        project.clips = [first, second]
        XCTAssertEqual(TimelineMap.sourceShift(outputDeltaUs: 1_000_000, atSource: 3_000_000, in: project), 4_250_000)
    }

    func testOutputAndSourceTimesMapThroughACutAndASpeedUp() {
        let edit = project([
            .init(id: "a", fromUs: 0, toUs: 3_000_000),
            .init(id: "b", fromUs: 5_000_000, toUs: 9_000_000, speed: 2),
        ])

        XCTAssertEqual(edit.outputDurationUs, 5_000_000)
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: 1_000_000, in: edit), 1_000_000)
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: 4_000_000, in: edit), 7_000_000)
        XCTAssertEqual(TimelineMap.outputTime(ofSource: 7_000_000, in: edit), 4_000_000)
        XCTAssertNil(TimelineMap.outputTime(ofSource: 4_000_000, in: edit), "a cut moment has no output time")
        XCTAssertEqual(TimelineMap.sourceTime(atOutput: 99_000_000, in: edit), 9_000_000, "past the end is the last frame")
    }

    /// The scissors button and S offer a split only inside a clip; the split itself is the service's `split` op.
    func testASplitIsOfferedOnlyInsideAClip() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 4_000_000, speed: 2), .init(id: "b", fromUs: 6_000_000, toUs: 8_000_000)])
        XCTAssertTrue(TimelineMap.canSplit(edit, atOutput: 1_000_000))
        XCTAssertFalse(TimelineMap.canSplit(edit, atOutput: 0), "the start of the movie")
        XCTAssertFalse(TimelineMap.canSplit(edit, atOutput: 2_000_000), "the edge between two clips")
        XCTAssertFalse(TimelineMap.canSplit(edit, atOutput: 99_000_000), "past the end")
    }

    func testAFollowingPartCentresOnTheCursorInsideThePicture() {
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5),
            CursorTrack.Sample(ms: 1000, x: 0.5, y: 0.5),
            CursorTrack.Sample(ms: 2000, x: 0.98, y: 0.02),
            CursorTrack.Sample(ms: 3000, x: 0.98, y: 0.02),
        ])
        var part = EditProject.Redaction(id: "s", startUs: 0, endUs: 3_000_000, x: 0, y: 0, width: 0.2, height: 0.2, style: .spotlight)
        XCTAssertEqual(ZoomState.placed(part, atSourceUs: 500_000, track: track).x, 0, "not following: it stays")
        part.follow = true
        let centred = ZoomState.placed(part, atSourceUs: 500_000, track: track)
        XCTAssertEqual(centred.x, 0.4, accuracy: 0.001)
        XCTAssertEqual(centred.y, 0.4, accuracy: 0.001)
        let corner = ZoomState.placed(part, atSourceUs: 2_800_000, track: track)
        XCTAssertEqual(corner.x, 0.8, accuracy: 0.001, "kept inside the picture")
        XCTAssertEqual(corner.y, 0, accuracy: 0.001)
    }

    func testChangedPartsTellADragFromAnAdd() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 4_000_000)])
        var louder = edit
        louder.audio.volume = 0.8
        XCTAssertEqual(EditorModel.changedParts(edit, louder), ["audio"])
        var titled = edit
        titled.texts = [EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: "A")]
        XCTAssertEqual(EditorModel.changedParts(edit, titled), ["texts", "count"], "an add is its own undo step")
        var moved = titled
        moved.texts?[0].x = 0.3
        XCTAssertEqual(EditorModel.changedParts(titled, moved), ["texts"], "a move continues a drag")
    }

    func testCutsDipTheSoundButASplitDoesNot() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 2_000_000, toUs: 3_000_000),
                            .init(id: "c", fromUs: 5_000_000, toUs: 6_000_000), .init(id: "d", fromUs: 6_000_000, toUs: 8_000_000, speed: 2)])
        XCTAssertEqual(Declick.cuts(in: edit), [3_000_000, 4_000_000], "a split joins nothing; a cut and a speed change do")
        let ramps = Declick.ramps(at: [3_000_000], lengthUs: 5_000_000)
        XCTAssertEqual(ramps.map(\.startUs), [2_975_000, 3_000_000])
        XCTAssertEqual(ramps.map(\.endUs), [3_000_000, 3_025_000])
        XCTAssertEqual(ramps.map(\.from), [1, 0])
        XCTAssertEqual(ramps.map(\.to), [0, 1])
    }

    func testMusicFadesAtBothEndsAndDucksUnderSpeech() {
        let music = EditProject.Music(file: "/m.mp3", volume: 0.5, duck: 0.6, fadeMs: 1000)
        let speech: [(fromUs: Int64, toUs: Int64)] = [(4_000_000, 6_000_000)]
        let length: Int64 = 10_000_000
        XCTAssertEqual(MusicMix.gain(atUs: 0, music: music, speech: speech, lengthUs: length), 0, accuracy: 0.001)
        XCTAssertEqual(MusicMix.gain(atUs: 500_000, music: music, speech: speech, lengthUs: length), 0.25, accuracy: 0.001, "half way into the fade")
        XCTAssertEqual(MusicMix.gain(atUs: 2_000_000, music: music, speech: speech, lengthUs: length), 0.5, accuracy: 0.001)
        XCTAssertEqual(MusicMix.gain(atUs: 5_000_000, music: music, speech: speech, lengthUs: length), 0.2, accuracy: 0.001, "40 % under speech")
        XCTAssertEqual(MusicMix.gain(atUs: 6_150_000, music: music, speech: speech, lengthUs: length), 0.35, accuracy: 0.001, "half way back up")
        XCTAssertEqual(MusicMix.gain(atUs: length, music: music, speech: speech, lengthUs: length), 0, accuracy: 0.001)
        let frames = MusicMix.keyframes(music: music, speech: speech, lengthUs: length)
        XCTAssertEqual(frames.map(\.us), [0, 1_000_000, 3_700_000, 4_000_000, 6_000_000, 6_300_000, 9_000_000, 10_000_000])
    }

    func testSpokenPartsFollowCutsAndMergeWhenClose() {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        let lines = [CaptionTrack.Line(fromUs: 1_000_000, toUs: 2_000_000, text: "one"),
                     CaptionTrack.Line(fromUs: 2_100_000, toUs: 2_900_000, text: "two"),
                     CaptionTrack.Line(fromUs: 3_500_000, toUs: 4_500_000, text: "cut"),
                     CaptionTrack.Line(fromUs: 6_000_000, toUs: 7_000_000, text: "after")]
        let speech = MusicMix.speech(lines: lines, project: edit)
        XCTAssertEqual(speech.map(\.fromUs), [1_000_000, 4_000_000])
        XCTAssertEqual(speech.map(\.toUs), [2_900_000, 5_000_000])
    }

    func testSnapPicksTheNearestTargetInsideTheTolerance() {
        XCTAssertEqual(TimelineMap.snap(1_040_000, to: [0, 1_000_000, 1_100_000], toleranceUs: 70_000), 1_000_000)
        XCTAssertEqual(TimelineMap.snap(1_060_000, to: [1_000_000, 1_100_000], toleranceUs: 70_000), 1_100_000)
        XCTAssertNil(TimelineMap.snap(1_500_000, to: [1_000_000], toleranceUs: 70_000), "too far: the drag stays under the pointer")
        XCTAssertNil(TimelineMap.snap(0, to: [], toleranceUs: 70_000))
    }

    func testEffectLanesPlaceItemsKeepThemThroughLaneChangesAndReadTheCLIShape() throws {
        var edit = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000), EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000, speed: 2)],
                           zooms: [EditProject.Zoom(id: "z1", startUs: 0, endUs: 1_000_000)])
        edit.redactions = [EditProject.Redaction(id: "r1", startUs: 1_000_000, endUs: 2_000_000, x: 0.1, y: 0.1, width: 0.2, height: 0.2)]
        edit.texts = [EditProject.TextNote(id: "t1", startUs: 2_000_000, endUs: 3_000_000, text: "Hi")]
        // Never saved: the zoom lane, then an automatic lane per family; the 2× clip has no lane that holds speed.
        XCTAssertEqual(EffectLanes.resolve(edit).map { "\($0.id):\($0.items.map(\.id))" }, ["zooms:[\"z1\"]", "auto-hide:[\"r1\"]", "auto-text:[\"t1\"]"])

        // A lane that holds speed (the lane ops are the service's, lanes.ts) shows the clip played at 2×, and an item
        // pinned to a lane shows there.
        edit.lanes = [EffectLane(id: "lane4", kinds: [.zoom, .speed])] + EffectLanes.resolve(edit).map(\.lane)
        XCTAssertEqual(EffectLanes.resolve(edit).first?.items.map(\.id), ["z1", "b"], "the first lane that holds zooms takes z1")
        edit.zooms[0].lane = "zooms"
        XCTAssertEqual(EffectLanes.resolve(edit).map { "\($0.id):\($0.items.map(\.id))" },
                       ["lane4:[\"b\"]", "zooms:[\"z1\"]", "auto-hide:[\"r1\"]", "auto-text:[\"t1\"]"])

        // The CLI writes kinds and lane ids as lanes.ts does; the window reads them and writes the same keys back.
        let json = #"{"version":1,"source":{"video":"/tmp/x.mp4","durationUs":10000000,"width":1920,"height":1080},"clips":[{"id":"a","fromUs":0,"toUs":10000000,"speed":1}],"audio":{"include":true,"volume":1,"mutedTracks":[]},"export":{"codec":"h264","maxHeight":0,"output":""},"zooms":[{"id":"z1","startUs":0,"endUs":1000000,"scale":1.5,"mode":"manual","focusX":0.5,"focusY":0.5,"easeInMs":450,"easeOutMs":450,"lane":"top"}],"lanes":[{"id":"top","kinds":["zoom","text"],"name":"Intro"}],"revision":3}"#
        let decoded = try EditProject.decode(Data(json.utf8))
        XCTAssertEqual(decoded.lanes, [EffectLane(id: "top", kinds: [.zoom, .text], name: "Intro")])
        XCTAssertEqual(EffectLanes.resolve(decoded).map(\.lane.title), ["Intro"])
        let written = try XCTUnwrap(JSONSerialization.jsonObject(with: decoded.encoded()) as? [String: Any])
        XCTAssertEqual((written["zooms"] as? [[String: Any]])?.first?["lane"] as? String, "top")
    }

    func testARecordingOffersItsQuickActionsAndAMeetingNeverOffersTheTrash() {
        let folder = URL(fileURLWithPath: "/tmp/recordings/one")
        let library = RecorderMenu.Recent(folder: folder, title: "One", started: .distantPast, thumbnail: nil, hasMovie: true)
        XCTAssertEqual(RecordingAction.offered(for: library), [.open, .copyMovie, .copyGIF, .reveal, .rename, .trash])
        var meeting = library
        meeting.isMeeting = true
        XCTAssertEqual(RecordingAction.offered(for: meeting), [.open, .copyMovie, .copyGIF, .reveal, .rename, .openMeeting])
        let framesOnly = RecorderMenu.Recent(folder: folder, title: "Frames", started: .distantPast, thumbnail: nil, hasMovie: false)
        XCTAssertFalse(RecordingAction.offered(for: framesOnly).contains(.copyMovie), "nothing to copy before a proxy exists")
        var commented = library
        commented.openComments = 2
        XCTAssertEqual(RecordingAction.offered(for: commented).prefix(2), [.open, .firstComment])
    }

    func testReviewCommentsReadTheCLIsLinesLastOneWinsAndARemovalHidesIt() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("comments-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try Data("{}".utf8).write(to: folder.appendingPathComponent("recording.json"))
        let url = ReviewComments.url(forVideo: folder.appendingPathComponent("screen.mp4").path)
        XCTAssertEqual(url.lastPathComponent, "comments.jsonl")
        XCTAssertEqual(ReviewComments.url(forVideo: "/movies/talk.mov").path, "/movies/talk.comments.jsonl")
        // Lines as src/utils/recording-editor/comments.ts writes them (the window's comments go through it too), one
        // that does not parse, then a removal.
        let cli = """
        {"id":"m1","atUs":5000000,"text":"Too fast","author":"alice","at":"2026-11-04T10:00:00.000Z"}
        {"id":"m2","atUs":1000000,"toUs":2000000,"text":"Cut this","at":"2026-11-04T10:00:01.000Z"}
        not json
        {"id":"m1","atUs":5000000,"text":"Too fast","author":"alice","resolved":true,"at":"2026-11-04T10:00:02.000Z"}

        """
        try Data(cli.utf8).write(to: url)
        XCTAssertEqual(ReviewComments.read(url).map(\.id), ["m2", "m1"])
        XCTAssertEqual(ReviewComments.read(url).last?.isResolved, true)
        let removal = #"{"id":"m2","atUs":1000000,"toUs":2000000,"text":"Cut this","deleted":true,"at":"2026-11-04T10:00:03.000Z"}"#
        try Data((cli + removal + "\n").utf8).write(to: url)
        XCTAssertEqual(ReviewComments.read(url).map(\.id), ["m1"], "a removal line hides the comment")
    }

    /// The rules of the Audio tab's noise reduction are the `denoise` op's (recording-editor.test.ts); the window keeps
    /// the CLI's per-track map as it reads it.
    func testTheDenoiseSettingsTheCLIWritesReadAndWriteBackUnchanged() throws {
        // The CLI's per-track map reads and writes back unchanged.
        let json = #"{"include":true,"volume":1,"mutedTracks":[],"denoise":{"method":"afftdn","reductionDb":10,"trackReductionDb":{"1":20}}}"#
        let decoded = try JSONDecoder().decode(EditProject.AudioSettings.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.denoise?.trackReductionDb, ["1": 20])
        let written = try XCTUnwrap(String(data: JSONEncoder().encode(decoded), encoding: .utf8))
        XCTAssertTrue(written.contains(#""trackReductionDb":{"1":20}"#), written)
    }

    func testTheZoomEasesInHoldsAndKeepsItsViewInsideTheFrame() {
        let zoom = EditProject.Zoom(id: "z", startUs: 1_000_000, endUs: 3_000_000, scale: 2, focusX: 0.95, focusY: 0.05,
                                    easeInMs: 500, easeOutMs: 500)
        XCTAssertEqual(ZoomCurve.view(atSource: 500_000, zooms: [zoom], cursor: nil), .whole)
        let start = ZoomCurve.view(atSource: 1_000_000, zooms: [zoom], cursor: nil)
        XCTAssertEqual(start.scale, 1, accuracy: 0.001)
        let middle = ZoomCurve.view(atSource: 1_250_000, zooms: [zoom], cursor: nil)
        XCTAssertGreaterThan(middle.scale, 1.5, "the ease-out curve passes half its way early")
        let held = ZoomCurve.view(atSource: 2_000_000, zooms: [zoom], cursor: nil)
        XCTAssertEqual(held.scale, 2, accuracy: 0.0001)
        XCTAssertEqual(held.rect.maxX, 1, accuracy: 0.0001, "a focus at the edge is held so the view stays in the frame")
        XCTAssertEqual(held.rect.minY, 0, accuracy: 0.0001)
        XCTAssertEqual(ZoomCurve.easeOut(0), 0, accuracy: 0.0001)
        XCTAssertEqual(ZoomCurve.easeOut(1), 1, accuracy: 0.0001)
    }

    func testAFollowZoomTracksTheSmoothedCursor() {
        let track = CursorTrack(samples: (0...40).map { CursorTrack.Sample(ms: Double($0) * 50, x: 0.3, y: 0.6, click: nil) })
        let zoom = EditProject.Zoom(id: "z", startUs: 0, endUs: 2_000_000, scale: 2, mode: .follow, easeInMs: 0, easeOutMs: 0)
        let view = ZoomCurve.view(atSource: 1_000_000, zooms: [zoom], cursor: track)

        XCTAssertEqual(view.centerX, 0.3, accuracy: 0.0001)
        XCTAssertEqual(view.centerY, 0.6, accuracy: 0.0001)
    }

    func testAFollowZoomGlidesOverAMoveInsteadOfJumping() {
        // The pointer stands at 0.2 for 2 s, moves to 0.8 in one sample, then stands again: rows only on a change.
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.2, y: 0.5), CursorTrack.Sample(ms: 500, x: 0.2, y: 0.5),
            CursorTrack.Sample(ms: 2000, x: 0.8, y: 0.5), CursorTrack.Sample(ms: 2500, x: 0.8, y: 0.5),
            CursorTrack.Sample(ms: 4000, x: 0.8, y: 0.5),
        ])
        let zoom = EditProject.Zoom(id: "z", startUs: 0, endUs: 4_000_000, scale: 1.5, mode: .follow, easeInMs: 0, easeOutMs: 0)
        let centers = stride(from: 1_600_000, through: 2_400_000, by: 100_000).map {
            ZoomCurve.view(atSource: Int64($0), zooms: [zoom], cursor: track).centerX
        }
        // It moves a little every step, never more than a fifth of the way at once.
        for (a, b) in zip(centers, centers.dropFirst()) {
            XCTAssertGreaterThanOrEqual(b, a - 0.0001)
            XCTAssertLessThan(b - a, 0.12)
        }
        XCTAssertGreaterThan(centers.last! - centers.first!, 0.2)
    }

    func testTheDrawnCursorHoldsStillThenMovesAndSitsOnAClick() {
        // Rows only on a change: still at 0.2 until one sample before 1000 ms, then at 0.8; a click at 1000 ms.
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.2, y: 0.2),
            CursorTrack.Sample(ms: 1000, x: 0.8, y: 0.8, click: "left"),
            CursorTrack.Sample(ms: 1500, x: 0.8, y: 0.8),
        ])
        XCTAssertEqual(track.point(atMs: 500)?.x ?? 0, 0.2, accuracy: 0.0001)
        XCTAssertEqual(track.point(atMs: 991.65)?.x ?? 0, 0.5, accuracy: 0.001)
        XCTAssertEqual(track.drawnPoint(atMs: 1000, smoothing: 1)?.x ?? 0, 0.8, accuracy: 0.0001)
        // Far from the click the path is averaged: the step is softened, not jumped.
        let far = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.2, y: 0.2), CursorTrack.Sample(ms: 1000, x: 0.8, y: 0.8)])
        let softened = far.drawnPoint(atMs: 1000, smoothing: 1)?.x ?? 0
        XCTAssertGreaterThan(softened, 0.3)
        XCTAssertLessThan(softened, 0.7)
        XCTAssertFalse(far.drawsCursor)
    }

    func testAnIdleCursorFadesOutAndComesBackWhenItMoves() {
        // Still from 0 to 3000 ms (the 500 ms keep-alive rows do not count as moves), then it moves.
        let track = CursorTrack(samples: [0, 500, 1000, 1500, 2000, 2500, 3000].map { CursorTrack.Sample(ms: $0, x: 0.5, y: 0.5) }
            + [CursorTrack.Sample(ms: 3200, x: 0.6, y: 0.5)])
        XCTAssertEqual(track.visibility(atMs: 900, hideAfterMs: 1000), 1)
        XCTAssertEqual(track.visibility(atMs: 1150, hideAfterMs: 1000), 0.5, accuracy: 0.001)
        XCTAssertEqual(track.visibility(atMs: 2000, hideAfterMs: 1000), 0)
        XCTAssertEqual(track.visibility(atMs: 3190, hideAfterMs: 1000), 1)
        XCTAssertEqual(track.visibility(atMs: 2000, hideAfterMs: 0), 1)
    }

    func testTheLoaderRoundTripsAndRefusesANewerVersion() throws {
        let edit = project([.init(id: "a", fromUs: 0, toUs: 10_000_000)])
        XCTAssertEqual(try EditProject.decode(edit.encoded()), edit)
        let newer = Data(#"{"version": 9, "source": {}, "clips": []}"#.utf8)
        XCTAssertThrowsError(try EditProject.decode(newer)) { error in
            XCTAssertTrue(error.localizedDescription.contains("version 9"))
        }
    }

    func testLooksAreOptionalAndRoundTripTheShapeTheCliWrites() throws {
        // The shape TypeScript's project.ts writes; a file from before the looks has neither key.
        let old = #"{"version":1,"source":{"video":"/m.mp4","durationUs":10000000,"width":1920,"height":1080},"clips":[{"id":"c1","fromUs":0,"toUs":10000000,"speed":1}],"zooms":[],"audio":{"include":true,"volume":1,"mutedTracks":[]},"export":{"codec":"h264","maxHeight":0,"output":""},"revision":3}"#
        let decoded = try EditProject.decode(Data(old.utf8))
        XCTAssertNil(decoded.clicks)
        XCTAssertNil(decoded.frame)

        var styled = decoded
        styled.clicks = EditProject.Clicks(highlight: true, color: "#FF453A", radius: 0.05, durationMs: 600)
        styled.frame = EditProject.Frame(background: .init(kind: .color, colors: ["#101010"]), padding: 0.1, cornerRadius: 0.02, shadow: false)
        XCTAssertEqual(try EditProject.decode(styled.encoded()), styled)
        XCTAssertEqual(Looks.color("#FF8000").red, 1)
        XCTAssertEqual(Looks.color("nonsense"), .white)
        XCTAssertEqual(Looks.marks(atSourceMs: 1200, clicks: [.init(ms: 1000, x: 0.2, y: 0.3, click: "left")], durationMs: 400),
                       [.init(x: 0.2, y: 0.3, progress: 0.5)])
    }

    func testExportFpsKeepsFilmRatesAndLiftsScreenRecordings() {
        XCTAssertEqual(EditRenderer.exportFps(nominal: 45.26), 60)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 120), 60)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 29.97), 30)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 23.976), 24)
        XCTAssertEqual(EditRenderer.exportFps(nominal: 0), 30)
    }

    func testH264SizeFitsLevelLimitsAtTheExportRate() {
        let size = EditRenderer.renderSize(source: CGSize(width: 4112, height: 2570), maxHeight: 0, h264Fps: 60)
        XCTAssertLessThanOrEqual(size.width * size.height * 60, EditRenderer.h264PixelRate)
        XCTAssertGreaterThan(size.width, 2500)
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1920, height: 1080), maxHeight: 0, h264Fps: 60), CGSize(width: 1920, height: 1080))
    }

    func testACanvasAspectKeepsThePictureHeightAsItsShortSideAndFitsTheH264Budget() {
        let source = CGSize(width: 1728, height: 1080)
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .wide).canvas, CGSize(width: 1920, height: 1080))
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .square).canvas, CGSize(width: 1080, height: 1080))
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .portrait).canvas, CGSize(width: 1080, height: 1920))
        XCTAssertEqual(EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .portrait).picture, source)
        // A 4K portrait canvas would be 2570 × 4568: H.264 at 60 fps fits it into 2560 × 1600 worth of pixels.
        let fitted = EditRenderer.outputSizes(source: CGSize(width: 4112, height: 2570), maxHeight: 0, aspect: .portrait, h264Fps: 60)
        XCTAssertLessThanOrEqual(fitted.canvas.width * fitted.canvas.height, 2560 * 1600)
        XCTAssertEqual(fitted.canvas.height / fitted.canvas.width, 16.0 / 9, accuracy: 0.01)
        XCTAssertEqual(fitted.picture.height, fitted.canvas.width, accuracy: 2)
    }

    func testACoverCropHasTheRoomsShapeFollowsTheFocusAndStaysInsideThePicture() {
        let picture = CGSize(width: 1728, height: 1080)
        let room = CGSize(width: 900, height: 1600)
        let centred = Looks.coverCrop(picture: picture, room: room, focus: CGPoint(x: 0.5, y: 0.5))
        XCTAssertEqual(centred.height, 1080)
        XCTAssertEqual(centred.width / centred.height, 900.0 / 1600, accuracy: 0.001)
        XCTAssertEqual(centred.midX, 864, accuracy: 0.5)
        let right = Looks.coverCrop(picture: picture, room: room, focus: CGPoint(x: 0.99, y: 0.2))
        XCTAssertEqual(right.maxX, 1728, accuracy: 0.5)
        XCTAssertEqual(right.minY, 0, accuracy: 0.5)
    }

    func testTheSourceToCanvasMapFollowsTheZoomAndTheFrameAndMatchesWhatTheFrameDraws() throws {
        let picture = CGSize(width: 160, height: 100), square = CGSize(width: 100, height: 100)
        let whole = Looks.sourceToCanvas(view: .whole, frame: nil, picture: picture, canvas: picture)
        XCTAssertEqual(whole, Looks.SourceToCanvas())
        let zoomed = Looks.sourceToCanvas(view: ZoomCurve.View(scale: 2, centerX: 0.5, centerY: 0.5), frame: nil, picture: picture, canvas: picture)
        XCTAssertEqual(zoomed.point(CGPoint(x: 0.25, y: 0.25)).x, 0, accuracy: 1e-9)
        XCTAssertEqual(zoomed.point(CGPoint(x: 0.75, y: 0.75)).y, 1, accuracy: 1e-9)

        var frame = EditProject.Frame()
        frame.padding = 0.1
        frame.cornerRadius = 0
        frame.shadow = false
        let map = Looks.sourceToCanvas(view: .whole, frame: frame, picture: picture, canvas: square)
        let rect = CGRect(x: 0.2, y: 0.3, width: 0.4, height: 0.5)
        let back = map.sourceRect(ofCanvas: map.rect(rect))
        XCTAssertEqual(back.minX, rect.minX, accuracy: 1e-9)
        XCTAssertEqual(back.height, rect.height, accuracy: 1e-9)

        // A white picture framed on a black background: the map's edges are where the white starts and stops.
        let white = CIImage(color: .white).cropped(to: CGRect(origin: .zero, size: picture))
        frame.background = EditProject.Background(kind: .color, colors: ["#000000"])
        let drawn = Looks.applyFrame(frame, to: white, picture: picture, canvas: square)
        let shown = map.rect(CGRect(x: 0, y: 0, width: 1, height: 1))
        XCTAssertEqual(map.shown.minX, shown.minX, accuracy: 1e-9)
        XCTAssertEqual(map.shown.maxY, shown.maxY, accuracy: 1e-9)
        var pixels = [UInt8](repeating: 0, count: 100 * 100 * 4)
        CIContext().render(drawn, toBitmap: &pixels, rowBytes: 400, bounds: CGRect(origin: .zero, size: square), format: .RGBA8, colorSpace: nil)
        // The bitmap's first row is the canvas's top; probe just inside and just outside each edge of the map.
        func lum(_ x: Double, _ y: Double) -> UInt8 { pixels[(Int(y * 100) * 100 + Int(x * 100)) * 4] }
        XCTAssertGreaterThan(lum(shown.minX + 0.02, shown.midY), 200)
        XCTAssertLessThan(lum(shown.minX - 0.02, shown.midY), 50)
        XCTAssertGreaterThan(lum(shown.midX, shown.minY + 0.02), 200)
        XCTAssertLessThan(lum(shown.midX, shown.minY - 0.02), 50)
        XCTAssertGreaterThan(lum(shown.midX, shown.maxY - 0.02), 200)
        XCTAssertLessThan(lum(shown.midX, shown.maxY + 0.02), 50)

        // A cover crop off centre: the picture's left half is white, so x 0.5 of the source must land where it turns.
        frame.fit = .cover
        let focus = CGPoint(x: 0.35, y: 0.5)
        let cover = Looks.sourceToCanvas(view: .whole, frame: frame, picture: picture, canvas: square, coverFocus: focus)
        let half = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 80, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: picture)))
        let covered = Looks.applyFrame(frame, to: half, picture: picture, canvas: square, focus: focus)
        CIContext().render(covered, toBitmap: &pixels, rowBytes: 400, bounds: CGRect(origin: .zero, size: square), format: .RGBA8, colorSpace: nil)
        let turn = cover.point(CGPoint(x: 0.5, y: 0.5))
        XCTAssertGreaterThan(lum(turn.x - 0.03, turn.y), 200)
        XCTAssertLessThan(lum(turn.x + 0.03, turn.y), 50)
    }

    func testATranscriptFixUsesTheSameMillisecondKeyAsTheCLIAndHidesALineWithNoWords() throws {
        // The CLI keys a fix by Math.round(start * 1000); a line read from 1.8 s holds 1799999 µs after the cast.
        let settings = try JSONDecoder().decode(EditProject.TranscriptSettings.self,
                                                from: Data(#"{"fixes":{"1800":"Fixed words","3000":""}}"#.utf8))
        let line = CaptionTrack.Line(fromUs: Int64(1.8 * 1_000_000), toUs: 2_500_000, text: "Raw words")
        XCTAssertEqual(EditProject.TranscriptSettings.key(line), "1800")
        XCTAssertEqual(settings.apply(line)?.text, "Fixed words")
        XCTAssertNil(settings.apply(CaptionTrack.Line(fromUs: 3_000_000, toUs: 4_000_000, text: "gone")))
        XCTAssertEqual(settings.apply(CaptionTrack.Line(fromUs: 5_000_000, toUs: 6_000_000, text: "kept"))?.text, "kept")
    }

    func testCaptionsReadTheTranscriptCacheAndFindTheLineSpokenAtASourceTime() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("captions-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let video = folder.appendingPathComponent("screen.mp4").path
        let json = #"{"text":"","segments":[{"text":" Hello there. ","start":0.5,"end":1.5},{"text":"  ","start":2,"end":3},{"text":"Second line","start":3,"end":4.25}]}"#
        try Data(json.utf8).write(to: CaptionTrack.cacheURL(video: video))
        let track = try XCTUnwrap(CaptionTrack.load(video: video))

        XCTAssertEqual(track.lines.count, 2)
        XCTAssertEqual(track.line(atSourceUs: 1_000_000)?.text, "Hello there.")
        XCTAssertNil(track.line(atSourceUs: 2_000_000))
        XCTAssertEqual(track.line(atSourceUs: 4_000_000)?.text, "Second line")
        XCTAssertNil(track.line(atSourceUs: 4_300_000))
        let plate = try XCTUnwrap(track.image(for: track.lines[0], fontSize: 40, maxWidth: 800))
        XCTAssertGreaterThan(plate.extent.width, 100)
        XCTAssertLessThan(plate.extent.width, 800)
    }

    func testAShortcutShowsForItsDurationFadesAndGivesWayToTheNextPress() {
        let track = CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5),
            CursorTrack.Sample(ms: 1000, x: 0.5, y: 0.5, key: "⌘C"),
            CursorTrack.Sample(ms: 1500, x: 0.5, y: 0.5, key: "⌘V"),
        ])
        XCTAssertNil(track.key(atMs: 900, durationMs: 1200))
        XCTAssertEqual(track.key(atMs: 1200, durationMs: 1200)?.label, "⌘C")
        XCTAssertEqual(track.key(atMs: 1600, durationMs: 1200)?.label, "⌘V")
        XCTAssertEqual(track.key(atMs: 2575, durationMs: 1200)?.opacity ?? 0, 0.5, accuracy: 0.001)
        XCTAssertNil(track.key(atMs: 2700, durationMs: 1200))
    }

    func testMotionBlurSmearsOnlyAMovingZoom() {
        // A sharp edge: black left half, white right half.
        let size = CGRect(x: 0, y: 0, width: 200, height: 100)
        let image = CIImage(color: .white).cropped(to: CGRect(x: 100, y: 0, width: 100, height: 100))
            .composited(over: CIImage(color: .black).cropped(to: size))
        let context = CIContext()
        func gray(_ result: CIImage, _ x: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(result, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 50, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        let still = ZoomCurve.View(scale: 2, centerX: 0.5, centerY: 0.5)
        XCTAssertEqual(gray(Looks.motionBlur(from: still, to: still, amount: 0.5, on: image), 96), 0, "a still zoom stays sharp")
        let panned = ZoomCurve.View(scale: 2, centerX: 0.55, centerY: 0.5)
        let blurred = Looks.motionBlur(from: still, to: panned, amount: 0.5, on: image)
        XCTAssertGreaterThan(gray(blurred, 96), 20, "a pan smears the edge sideways")
        XCTAssertEqual(blurred.extent, size, "the picture keeps its size")
        XCTAssertEqual(gray(Looks.motionBlur(from: still, to: panned, amount: 0, on: image), 96), 0, "0 is off")
    }

    func testASpotlightDimsEverythingButItsRectangle() {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let spot = EditProject.Redaction(id: "s", startUs: 0, endUs: 1, x: 0.25, y: 0, width: 0.5, height: 0.5, style: .spotlight)
        let output = Looks.redact([spot], on: white)
        let context = CIContext()
        func gray(_ x: Int, _ yFromTop: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(output, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        XCTAssertGreaterThan(gray(100, 10), 240, "inside the spotlight stays as it was")
        XCTAssertLessThan(gray(20, 10), 160, "outside it is dimmed")
        XCTAssertGreaterThan(gray(20, 10), 60, "dimmed, not black")
        XCTAssertLessThan(gray(100, 80), 160)
    }

    func testTwoSpotlightsBothStayLitAndTheRestDimsOnce() {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let left = EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0, y: 0, width: 0.2, height: 0.5, style: .spotlight)
        let right = EditProject.Redaction(id: "b", startUs: 0, endUs: 1, x: 0.8, y: 0, width: 0.2, height: 0.5, style: .spotlight)
        let context = CIContext()
        func gray(_ image: CIImage, _ x: Int, _ yFromTop: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        let both = Looks.redact([left, right], on: white)
        let one = Looks.redact([left], on: white)
        XCTAssertGreaterThan(gray(both, 20, 10), 240, "the first stays lit")
        XCTAssertGreaterThan(gray(both, 180, 10), 240, "the second is lit too")
        XCTAssertEqual(Int(gray(both, 100, 80)), Int(gray(one, 100, 80)), accuracy: 1, "the rest is dimmed once, not twice")
        let fading = Looks.redact([left], on: white, spotlightFade: 0.5)
        XCTAssertGreaterThan(gray(fading, 100, 80), gray(one, 100, 80), "half way into its fade it dims less")
    }

    /// A 2 s, 320 × 200 movie of grey frames, for an export to chew on.
    private func makeMovie(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                          AVVideoWidthKey: 320, AVVideoHeightKey: 200])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<60 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 320, 200, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), Int32(60 + frame), CVPixelBufferGetDataSize(buffer))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    func testACancelledExportStopsAndLeavesNoFile() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cancel-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        let project = EditProject.whole(video: movie.path, durationUs: 2_000_000, width: 320, height: 200, cursor: nil, recording: nil)
        let out = folder.appendingPathComponent("out.mp4")
        do {
            _ = try await EditExporter.export(project: project, to: out, isCancelled: { true }) { _ in }
            XCTFail("a cancelled export finished")
        } catch is CancellationError {
            XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "a cancelled export writes no file")
            XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("out.partial.mp4").path), "nor a partial one")
        }
        let whole = try await EditExporter.export(project: project, to: folder.appendingPathComponent("whole.mp4")) { _ in }
        XCTAssertGreaterThan(whole.bytes, 0, "the same export, not cancelled, writes the movie")
    }

    func testAChangeIsNamedForTheUndoMenuAndOpensItsTab() {
        let base = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 10_000_000)])
        var withText = base
        withText.texts = [EditProject.TextNote(id: "t1", startUs: 0, endUs: 1_000_000, text: "Hello")]
        XCTAssertEqual(EditorModel.changeName(from: base, to: withText).name, "Add Text")
        XCTAssertEqual(EditorModel.changeName(from: withText, to: base).name, "Delete Text")
        var moved = withText
        moved.texts?[0].x = 0.3
        XCTAssertEqual(EditorModel.changeName(from: withText, to: moved).name, "Text Change")
        XCTAssertEqual(EditorModel.changeName(from: withText, to: moved).tab, .text)
        var louder = base
        louder.audio.volume = 1.5
        XCTAssertEqual(EditorModel.changeName(from: base, to: louder).tab, .audio)
        var both = louder
        both.texts = withText.texts
        XCTAssertEqual(EditorModel.changeName(from: base, to: both).name, "Changes")
    }

    func testTheSizeEstimateMatchesAMeasuredExport() {
        let bytes = EditExporter.estimatedBytes(size: CGSize(width: 1152, height: 720), lengthUs: 20_000_000, codec: .h264)
        XCTAssertEqual(Double(bytes), 10_300_000, accuracy: 600_000, "the export measured at 10.3 MB")
        XCTAssertLessThan(EditExporter.estimatedBytes(size: CGSize(width: 1152, height: 720), lengthUs: 20_000_000, codec: .hevc), bytes)
    }

    /// The tag over a dragged segment names its start in the movie (after the cut) and its length.
    @MainActor
    func testTheDragTagShowsTheOutputStartAndTheLength() throws {
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 2_000_000), EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000)])
        let view = DragTimeTag(project: cut, startUs: 5_000_000, endUs: 6_500_000)
            .padding(.top, 24).padding(8)
            .background(Color.gray)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        XCTAssertTrue(text.contains("00:03.0"), text)
        // OCR reads a small "s" as "S" at this size.
        XCTAssertTrue(text.lowercased().contains("1.5 s"), text)
    }

    func testACheckIssueKeepsItsFixOpsForApply() throws {
        let answer = #"{"ok":false,"issues":[{"severity":"check","item":"text t2","message":"overlap","fix":"movie.retime({ id: \"t2\", at: 5 })","at":4,"target":{"list":"texts","id":"t2"},"action":{"label":"Move After","ops":[{"op":"retime","id":"t2","at":5}]}},{"severity":"fix","item":"music","message":"missing"}]}"#
        let issues = try XCTUnwrap(EditorModel.issues(fromCheck: Data(answer.utf8)))
        XCTAssertEqual(issues.count, 2)
        XCTAssertEqual(issues[0].action?.label, "Move After")
        XCTAssertEqual(issues[0].actionOps, #"[{"at":5,"id":"t2","op":"retime"}]"#)
        XCTAssertEqual(issues[0].selection, .text("t2"))
        XCTAssertNil(issues[1].actionOps)
        XCTAssertNil(EditorModel.issues(fromCheck: Data("not json".utf8)))
    }

    // Regression test: deep test 2026-11-06 RE5 — Fix All said "Fixed" and Lengthen said "done" for edits that changed nothing.
    func testFixAndLengthenSayNothingChangedWhenTheEditStayedTheSame() {
        XCTAssertEqual(EditorModel.fixAllNotice(fixed: 0), "Nothing to fix: no fix the check offers changes the edit.")
        XCTAssertEqual(EditorModel.fixAllNotice(fixed: 2), "Fixed 2 things. ⌘Z undoes them all.")
        XCTAssertEqual(EditorModel.fixAllNotice(fixed: nil), "Fixed. ⌘Z undoes it.")
        XCTAssertEqual(EditorModel.actionNotice(label: "Lengthen", changed: false), "Lengthen changed nothing.")
        XCTAssertEqual(EditorModel.actionNotice(label: "Lengthen", changed: true), "Lengthen: done. ⌘Z undoes it.")
    }

    func testAnOutsideEditIsSaidInWordsWithWhatToFlashAndWhere() throws {
        let before = project([.init(id: "c", fromUs: 0, toUs: 10_000_000)])
        var after = before
        after.texts = [EditProject.TextNote(id: "t1", startUs: 200_000, endUs: 3_200_000, text: "Hello")]
        after.frame = EditProject.Frame()
        after.revision = 7
        after.updatedBy = "agent"

        let added = try XCTUnwrap(EditDiff.describe(old: before, new: after, by: "agent", at: Date()))
        XCTAssertEqual(added.lines.map(\.text), ["Added the text “Hello”, 00:00.2 to 00:03.2", "Turned the frame on (gradient)"])
        XCTAssertEqual(added.itemIDs, ["t1"])
        XCTAssertEqual(added.startUs, 200_000)
        XCTAssertTrue(added.touchesPicture)

        var moved = after
        moved.texts = [EditProject.TextNote(id: "t1", startUs: 1_200_000, endUs: 4_200_000, text: "Hello")]
        let move = try XCTUnwrap(EditDiff.describe(old: after, new: moved, by: "agent", at: Date()))
        // Regression test: deep test 2026-11-06 RE14 (live re-check) — "Trimmed a circle to 00:19.9 to 00:20.0" read as
        // two targets once a range said "to".
        XCTAssertEqual(move.lines.map(\.text), ["Moved the text “Hello”, now 00:01.2 to 00:04.2"])
        XCTAssertFalse(move.touchesPicture)
        var trimmed = moved
        trimmed.texts = [EditProject.TextNote(id: "t1", startUs: 1_200_000, endUs: 2_000_000, text: "Hello")]
        XCTAssertEqual(EditDiff.describe(old: moved, new: trimmed, by: "agent", at: Date())?.lines.map(\.text),
                       ["Trimmed the text “Hello”, now 00:01.2 to 00:02.0"])

        var removed = moved
        removed.texts = []
        XCTAssertEqual(EditDiff.describe(old: moved, new: removed, by: "agent", at: Date())?.lines.map(\.text), ["Removed the text “Hello”"])
        XCTAssertNil(EditDiff.describe(old: removed, new: removed, by: "agent", at: Date()))
    }

    // Regression test: deep test 2026-11-06 RE10 — an outside undo read "Added a spotlight" twice, the captions and the
    // cursor shown again read "Changed", an agent's marker read "Changed the edit", and nothing said it was an undo.
    func testAnOutsideChangeNamesMarkersRepeatsWhatItShowedAndAnUndo() throws {
        var before = project([.init(id: "c", fromUs: 0, toUs: 10_000_000)])
        before.captions = EditProject.Captions()
        before.captions?.show = false
        before.cursor = EditProject.Cursor()
        before.cursor?.show = false
        var after = before
        after.redactions = ["r1", "r2"].map {
            EditProject.Redaction(id: $0, startUs: 1_000_000, endUs: 2_000_000, x: 0.4, y: 0.4, width: 0.2, height: 0.2,
                                  style: .spotlight, lane: nil)
        }
        after.markers = [EditProject.Marker(id: "m1", atUs: 5_000_000, label: "Intro")]
        after.captions?.show = true
        after.cursor?.show = true

        let undone = try XCTUnwrap(EditDiff.describe(old: before, new: after, by: "agent", at: Date(), action: "undo"))
        XCTAssertEqual(undone.lines.map(\.text),
                       ["Added 2 spotlights", "Added the marker “Intro” at 00:05.0", "Showed the captions", "Showed the cursor"])
        XCTAssertEqual(undone.title, "Undo by agent")
        XCTAssertEqual(undone.hint, "⇧⌘Z in this window does it again")

        let edited = try XCTUnwrap(EditDiff.describe(old: after, new: before, by: "agent", at: Date()))
        XCTAssertEqual(edited.lines.map(\.text),
                       ["Removed 2 spotlights", "Removed the marker “Intro”", "Hid the captions", "Hid the cursor"])
        XCTAssertEqual(edited.title, "agent")
        XCTAssertEqual(edited.hint, "⌘Z puts it back")
    }

    // Regression test: deep test 2026-11-06 RE13 — the subtitle segments' identifiers read
    // "recorder.export.subtitles.optional(GenesisToolsRecorder-EditProject-SubtitleFormat-srt)".
    func testAnOptionalSegmentIdIsSpelledAsItsValueAndNilAsNone() {
        XCTAssertEqual(GenAccessibilityID.suffix(Optional(EditProject.SubtitleFormat.srt)), "srt")
        XCTAssertEqual(GenAccessibilityID.suffix(Optional<EditProject.SubtitleFormat>.none), "none")
    }

    // Regression test: deep test 2026-11-06 RE14 — "WEBM" beside "WebVTT", and en dashes in the time ranges.
    func testFormatNamesAndTimeRangesReadAsWords() {
        XCTAssertEqual(EditProject.ExportFormat.allCases.map(\.title), ["MP4", "GIF", "WebM"])
        XCTAssertEqual(formatClockRange(3_000_000, 8_000_000), "00:03.0 to 00:08.0")
    }

    func testSelectNextAndPreviousWalkTheItemsInTimeOrder() {
        let items: [EditorModel.TimelineItem] = [
            .init(selection: .zoom("z1"), startUs: 1_000_000),
            .init(selection: .text("t1"), startUs: 2_000_000),
            .init(selection: .shape("s1"), startUs: 5_000_000),
        ]
        // With nothing selected, forward takes the first item at or after the playhead, back the last one before it.
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .none, playheadUs: 2_000_000, forward: true)?.selection, .text("t1"))
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .none, playheadUs: 2_000_000, forward: false)?.selection, .zoom("z1"))
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .clip("c1"), playheadUs: 6_000_000, forward: true)?.selection, nil)
        // With an item selected, the keys step through the list and stop at both ends.
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .text("t1"), playheadUs: 0, forward: true)?.selection, .shape("s1"))
        XCTAssertEqual(EditorModel.adjacent(in: items, current: .text("t1"), playheadUs: 0, forward: false)?.selection, .zoom("z1"))
        XCTAssertNil(EditorModel.adjacent(in: items, current: .shape("s1"), playheadUs: 0, forward: true))
        XCTAssertNil(EditorModel.adjacent(in: items, current: .zoom("z1"), playheadUs: 0, forward: false))
    }


    // Regression test: deep test 2026-11-06 RE9 — with "Include audio" off the export still carried the click ticks.
    func testNoClickTicksWhileTheMoviesAudioIsLeftOut() {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 100, height: 100, cursor: nil, recording: nil)
        project.audio.include = false
        XCTAssertEqual(ClickSound.times(clicks: [1_000_000, 5_000_000], project: project), [])
    }

    func testClickTicksPlayAtTheirOutputTimesOneTickApart() {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 100, height: 100, cursor: nil, recording: nil)
        project.clips = [EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000), EditProject.Clip(id: "b", fromUs: 6_000_000, toUs: 10_000_000)]
        let times = ClickSound.times(clicks: [1_000_000, 1_020_000, 5_000_000, 7_000_000], project: project)
        XCTAssertEqual(times, [1_000_000, 5_000_000], "a click 20 ms after another, and one in the cut, play no tick")
        XCTAssertEqual(ClickSound.tick().count, 2160, "45 ms at 48 kHz")
    }

    func testACopiedRecordingFolderReadsItsOwnMovie() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("copied-\(UUID().uuidString)")
        let original = root.appendingPathComponent("original"), copy = root.appendingPathComponent("copy")
        for folder in [original, copy] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("movie bytes".utf8).write(to: folder.appendingPathComponent("screen.mp4"))
            try Data("{}\n".utf8).write(to: folder.appendingPathComponent("cursor.jsonl"))
        }
        defer { try? FileManager.default.removeItem(at: root) }
        let project = EditProject.whole(video: original.appendingPathComponent("screen.mp4").path, durationUs: 1_000_000, width: 100, height: 100,
                                         cursor: original.appendingPathComponent("cursor.jsonl").path, recording: nil)
        let moved = project.inItsFolder(copy)
        XCTAssertEqual(moved.source.video, copy.appendingPathComponent("screen.mp4").path)
        XCTAssertEqual(moved.source.cursor, copy.appendingPathComponent("cursor.jsonl").path)
        XCTAssertEqual(project.inItsFolder(original), project, "the original stays as it is")
        try Data("another, longer movie".utf8).write(to: copy.appendingPathComponent("screen.mp4"))
        XCTAssertEqual(project.inItsFolder(copy).source.video, project.source.video, "a different movie is not taken for the copy")
    }

    func testEveryCutoutLeavesItsInsideExactlyAsItWas() {
        let dark = CIImage(color: CIColor(red: 0.1, green: 0.1, blue: 0.1)).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let context = CIContext()
        func gray(_ image: CIImage, _ x: Int, _ yFromTop: Int) -> Int {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(image, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return Int(pixel[0])
        }
        let original = gray(dark, 100, 50)
        for cutout in EditProject.SpotlightCutout.allCases {
            let spot = EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0.25, y: 0.2, width: 0.5, height: 0.6, style: .spotlight,
                                             cutout: cutout)
            let lit = Looks.redact([spot], on: dark)
            XCTAssertEqual(gray(lit, 100, 50), original, accuracy: 1, "\(cutout): the middle is untouched")
            XCTAssertLessThan(gray(lit, 5, 5), original, "\(cutout): outside is dimmed")
        }
        let rounded = Looks.redact([EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0.25, y: 0.2, width: 0.5, height: 0.6,
                                                          style: .spotlight)], on: dark)
        XCTAssertLessThan(gray(rounded, 51, 21), original, "a rounded cutout's corner is dimmed")
        let deeper = Looks.redact([EditProject.Redaction(id: "a", startUs: 0, endUs: 1, x: 0.25, y: 0.2, width: 0.5, height: 0.6,
                                                         style: .spotlight, dim: 0.9)], on: dark)
        XCTAssertLessThan(gray(deeper, 5, 5), gray(rounded, 5, 5), "a higher dim is darker")
    }

    func testARedactionCoversOnlyItsRectangleOfTheSource() throws {
        let white = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 100))
        let redaction = EditProject.Redaction(id: "r", startUs: 0, endUs: 1, x: 0.25, y: 0, width: 0.5, height: 0.5, style: .black)
        let output = Looks.redact([redaction], on: white)
        let context = CIContext()
        func gray(_ x: Int, _ yFromTop: Int) -> UInt8 {
            var pixel = [UInt8](repeating: 0, count: 4)
            context.render(output, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: x, y: 100 - 1 - yFromTop, width: 1, height: 1),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            return pixel[0]
        }
        XCTAssertLessThan(gray(100, 10), 30)
        XCTAssertGreaterThan(gray(20, 10), 240)
        XCTAssertGreaterThan(gray(100, 80), 240)
        var project = EditProject(source: .init(video: "/m.mp4", durationUs: 1_000_000, width: 200, height: 100),
                                  clips: [.init(id: "c", fromUs: 0, toUs: 1_000_000)])
        project.redactions = [EditProject.Redaction(id: "r1", startUs: 0, endUs: 500_000, x: 0.1, y: 0.1, width: 0.2, height: 0.2, style: .pixelate)]
        let decoded = try EditProject.decode(JSONEncoder().encode(project))
        XCTAssertEqual(decoded.redactions, project.redactions)
    }

    func testAPartKeepsWhatPlaysBetweenTwoOutputTimesAtEachClipsSpeed() throws {
        // Output 0–2 plays source 0–2, 2–5 plays 3–6, 5–6 plays 6–8 at 2×.
        let project = EditProject(source: .init(video: "/m.mp4", durationUs: 8_000_000, width: 100, height: 100),
                                  clips: [.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 3_000_000, toUs: 6_000_000),
                                          .init(id: "c", fromUs: 6_000_000, toUs: 8_000_000, speed: 2)])
        let part = try XCTUnwrap(TimelineMap.part(project, fromOut: 1_000_000, toOut: 5_500_000))
        XCTAssertEqual(part.clips.map { [$0.fromUs, $0.toUs] }, [[1_000_000, 2_000_000], [3_000_000, 6_000_000], [6_000_000, 7_000_000]])
        XCTAssertEqual(part.outputDurationUs, 4_500_000)
        XCTAssertNil(TimelineMap.part(project, fromOut: 7_000_000, toOut: 9_000_000))
    }

    func testRenderSizeIsEvenAndCapped() {
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 4112, height: 2570), maxHeight: 1080), CGSize(width: 1728, height: 1080))
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1919, height: 1200), maxHeight: 720), CGSize(width: 1150, height: 720))
        XCTAssertEqual(EditRenderer.renderSize(source: CGSize(width: 1921, height: 1081), maxHeight: 0), CGSize(width: 1920, height: 1080))
    }
}
