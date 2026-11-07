import AppKit
import AVFoundation
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// Round 4, agent fx-overlay: voiceover clips, music ducking, animated captions and texts, cards, the progress bar.
final class RecorderOverlayTests: XCTestCase {
    private func edit(_ clips: [EditProject.Clip] = [.init(id: "c", fromUs: 0, toUs: 10_000_000)]) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        return project
    }

    // R4 voiceover clips
    func testVoiceoversPlayAtTheirOutputTimeAndStopAtTheMoviesEnd() {
        var project = edit([.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        project.audio.voiceovers = [
            .init(id: "v1", atUs: 1_000_000, file: "/v/one.mp3", durationUs: 1_500_000),
            .init(id: "v2", atUs: 4_000_000, file: "/v/cut.mp3", durationUs: 1_000_000),
            .init(id: "v3", atUs: 9_000_000, file: "/v/late.mp3", durationUs: 5_000_000),
        ]
        let placed = VoiceoverMix.placements(project)
        XCTAssertEqual(placed.map(\.clip.id), ["v1", "v3"], "a clip whose start is cut does not play")
        XCTAssertEqual(placed.map(\.outUs), [1_000_000, 7_000_000], "the cut of 2 s moves the late clip 2 s earlier")
        XCTAssertEqual(placed.map(\.playUs), [1_500_000, 1_000_000], "the late clip stops at the movie's end (8 s)")
    }

    // R4 8 music ducking
    func testDuckingInDecibelsDipsUnderVoiceoversWithItsOwnFade() {
        var project = edit()
        project.audio.music = EditProject.Music(file: "/m.mp3", volume: 0.5, duck: 0.6, fadeMs: 0)
        project.audio.voiceovers = [.init(id: "v1", atUs: 4_000_000, file: "/v.mp3", durationUs: 2_000_000)]
        guard let music = project.audio.music else { return XCTFail("no music") }

        // Without the object: the older share (to 40 %) over 0.3 s, now under the voiceover too.
        let older = MusicMix.speech(lines: [], project: project)
        XCTAssertEqual(older.map(\.fromUs), [4_000_000])
        XCTAssertEqual(MusicMix.gain(atUs: 5_000_000, music: music, speech: older, lengthUs: 10_000_000, duck: .of(project)), 0.2, accuracy: 0.001)

        project.audio.ducking = EditProject.Ducking(db: 12, fadeMs: 500, transcript: true, voiceovers: true)
        let duck = MusicMix.Duck.of(project)
        XCTAssertEqual(duck.rampUs, 500_000)
        XCTAssertEqual(duck.drop, 1 - pow(10, -12.0 / 20), accuracy: 0.0001)
        let speech = MusicMix.speech(lines: [], project: project)
        XCTAssertEqual(MusicMix.gain(atUs: 5_000_000, music: music, speech: speech, lengthUs: 10_000_000, duck: duck),
                       0.5 * pow(10, -12.0 / 20), accuracy: 0.001, "12 dB under the voiceover")
        XCTAssertEqual(MusicMix.gain(atUs: 3_750_000, music: music, speech: speech, lengthUs: 10_000_000, duck: duck),
                       0.5 * (1 - duck.drop * 0.5), accuracy: 0.001, "half way down 0.25 s before it")
        XCTAssertEqual(MusicMix.gain(atUs: 2_000_000, music: music, speech: speech, lengthUs: 10_000_000, duck: duck), 0.5, accuracy: 0.001)
        let frames = MusicMix.keyframes(music: music, speech: speech, lengthUs: 10_000_000, duck: duck)
        XCTAssertEqual(frames.map(\.us), [0, 3_500_000, 4_000_000, 6_000_000, 6_500_000, 10_000_000])

        // Off under the voiceovers: nothing left to dip under.
        project.audio.ducking?.voiceovers = false
        XCTAssertTrue(MusicMix.speech(lines: [], project: project).isEmpty)
        // The transcript's lines still duck unless that is off too.
        let lines = [CaptionTrack.Line(fromUs: 1_000_000, toUs: 2_000_000, text: "hello")]
        XCTAssertEqual(MusicMix.speech(lines: lines, project: project).count, 1)
        project.audio.ducking?.transcript = false
        XCTAssertTrue(MusicMix.speech(lines: lines, project: project).isEmpty)
    }

    // R4 6 animated captions and texts
    func testKaraokeColoursTheWordsSaidSoFar() {
        let timed = CaptionTrack.Line(fromUs: 1_000_000, toUs: 3_000_000, text: "one two three",
                                      wordStartsUs: [1_000_000, 1_800_000, 2_400_000])
        XCTAssertEqual(Karaoke.spokenCharacters(line: timed, atSourceUs: 900_000), 0)
        XCTAssertEqual(Karaoke.spokenCharacters(line: timed, atSourceUs: 1_000_000), 3, "\"one\" from its own start")
        XCTAssertEqual(Karaoke.spokenCharacters(line: timed, atSourceUs: 2_000_000), 7)
        XCTAssertEqual(Karaoke.spokenCharacters(line: timed, atSourceUs: 2_999_000), 13)
        // A fixed line has other words than the times: estimated from where the letters sit.
        let estimated = CaptionTrack.Line(fromUs: 0, toUs: 1_000_000, text: "aaaa bbbb", wordStartsUs: [0])
        XCTAssertEqual(Karaoke.spokenCharacters(line: estimated, atSourceUs: 500_000), 4, "b starts at 5/9 of the line")
        XCTAssertEqual(Karaoke.spokenCharacters(line: estimated, atSourceUs: 560_000), 9)
    }

    func testATypewriterTypesAndASlideUpRises() {
        var note = EditProject.TextNote(id: "t", startUs: 0, endUs: 3_000_000, text: "Hello world")
        XCTAssertEqual(TextMotion.at(sinceUs: 0, note: note), .init(characters: 11, opacity: 1, drop: 0), "no animate: the fade alone")
        note.animate = EditProject.TextAnimate(kind: .typewriter, ms: 1000)
        XCTAssertEqual(TextMotion.at(sinceUs: 0, note: note).characters, 0)
        XCTAssertEqual(TextMotion.at(sinceUs: 500_000, note: note).characters, 6)
        XCTAssertEqual(TextMotion.at(sinceUs: 2_000_000, note: note).characters, 11)
        note.animate = EditProject.TextAnimate(kind: .slideUp, ms: 1000)
        let half = TextMotion.at(sinceUs: 500_000, note: note)
        XCTAssertEqual(half.opacity, 0.875, accuracy: 0.001)
        XCTAssertEqual(half.drop, 0.075, accuracy: 0.001)
        XCTAssertEqual(TextMotion.at(sinceUs: 1_000_000, note: note).drop, 0)
    }

    func testAKaraokeCaptionDrawsTheSaidWordsInItsColour() throws {
        let size = CGSize(width: 640, height: 360)
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        let line = CaptionTrack.Line(fromUs: 0, toUs: 2_000_000, text: "WWWW MMMM")
        let track = CaptionTrack(lines: [line])
        let settings = EditProject.Captions(show: true, size: 0.08, position: .bottom)
        let yellow = NSColor(ciColor: Looks.color("#FFD60A"))
        let plain = Looks.drawCaption(line, track: track, settings: settings, on: black, size: size).image
        let half = Looks.drawCaption(line, track: track, settings: settings, on: black, size: size, highlight: (4, yellow)).image
        XCTAssertEqual(try yellowPixels(plain, size: size), 0)
        let said = try yellowPixels(half, size: size)
        XCTAssertGreaterThan(said, 200, "the first word is yellow")
        let all = try yellowPixels(Looks.drawCaption(line, track: track, settings: settings, on: black, size: size,
                                                     highlight: (9, yellow)).image, size: size)
        XCTAssertGreaterThan(Double(all), Double(said) * 1.6, "both words are yellow once both are said")
    }

    // R4 10 progress bar and chapter strip
    func testTheProgressBarFollowsThePlayheadAndNamesEachChapterAsItStarts() throws {
        var project = edit([.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        project.markers = [.init(id: "m1", atUs: 6_000_000, label: "Export"), .init(id: "m2", atUs: 4_000_000, label: "Cut away")]
        let recorded: [(us: Int64, label: String)] = [(1_000_000, "Open")]
        let settings = EditProject.ProgressBar(color: "#FF375F", chapterMs: 2000)
        XCTAssertEqual(ProgressMark.chapters(project: project, recorded: recorded).map(\.label), ["Open", "Export"], "a marker in a cut has no chapter")
        let early = try XCTUnwrap(ProgressMark.at(outUs: 2_000_000, project: project, recorded: recorded, settings: settings))
        XCTAssertEqual(early.share, 0.25, accuracy: 0.0001)
        XCTAssertEqual(early.dividers, [0.125, 0.5], "Open at 1 s and Export at 4 s of an 8 s movie")
        XCTAssertEqual(early.chapter, "Open")
        XCTAssertEqual(early.chapterOpacity, 1, accuracy: 0.001)
        XCTAssertNil(ProgressMark.at(outUs: 3_500_000, project: project, recorded: recorded, settings: settings)?.chapter, "after 2 s it goes")
        XCTAssertEqual(ProgressMark.at(outUs: 4_100_000, project: project, recorded: recorded, settings: settings)?.chapterOpacity ?? 0, 0.5, accuracy: 0.001)
        var hidden = settings
        hidden.show = false
        XCTAssertNil(ProgressMark.at(outUs: 0, project: project, recorded: recorded, settings: hidden))

        let size = CGSize(width: 400, height: 200)
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        let drawn = Looks.drawProgress(ProgressMark(share: 0.5, dividers: [0.25], color: "#FF375F", height: 0.02), plates: TextPlates(),
                                       on: black, size: size)
        var bytes = [UInt8](repeating: 0, count: 400 * 200 * 4)
        CIContext().render(drawn, toBitmap: &bytes, rowBytes: 400 * 4, bounds: CGRect(origin: .zero, size: size), format: .RGBA8,
                           colorSpace: CGColorSpaceCreateDeviceRGB())
        // Row 0 of the bitmap is the top of the picture; the bar is the bottom 4 rows.
        let pixel = { (x: Int, y: Int) -> (Int, Int, Int) in
            let at = ((199 - y) * 400 + x) * 4
            return (Int(bytes[at]), Int(bytes[at + 1]), Int(bytes[at + 2]))
        }
        XCTAssertGreaterThan(pixel(50, 1).0, 200, "the played part is in its colour")
        XCTAssertLessThan(pixel(300, 1).0, 120, "the rest is the dim track")
        XCTAssertGreaterThan(pixel(300, 1).0, 30)
        XCTAssertLessThan(pixel(100, 1).0, 120, "a dark gap at the chapter")
        XCTAssertEqual(pixel(50, 10).0, 0, "nothing above the bar")
    }

    // R6 8 chapter label place
    func testTheChapterNameGoesInTheFramesFreeAreaNeverOverTheMovie() throws {
        let plates = TextPlates()
        var mark = ProgressMark(share: 0.1, dividers: [], color: "#FFFFFF", height: 0.008, chapter: "Sign in")
        let bar: CGFloat = 9
        // phone-portrait: a 9:16 canvas, the phone from the top, the bottom 0.135 free (Core Image y up).
        let portrait = CGSize(width: 1080, height: 1920)
        let phone = CGRect(x: 120, y: 1920 * 0.135, width: 840, height: 1920 * 0.865 - 43)
        let low = try XCTUnwrap(Looks.chapterPlate("Sign in", mark: mark, plates: plates, canvas: portrait, movie: phone, barHeight: bar))
        let lowRect = CGRect(origin: low.origin, size: low.plate.extent.size)
        XCTAssertFalse(lowRect.intersects(phone), "the name is not over the phone: \(lowRect)")
        XCTAssertLessThan(lowRect.maxY, phone.minY + 1, "it sits in the free band under the phone")
        XCTAssertGreaterThan(lowRect.minY, bar, "and above the bar")
        // phone-left: a 16:9 canvas, the phone against the left edge, three quarters free.
        let wide = CGSize(width: 1920, height: 1080)
        let left = CGRect(x: 43, y: 43, width: 560, height: 994)
        let side = try XCTUnwrap(Looks.chapterPlate("Sign in", mark: mark, plates: plates, canvas: wide, movie: left, barHeight: bar))
        let sideRect = CGRect(origin: side.origin, size: side.plate.extent.size)
        XCTAssertFalse(sideRect.intersects(left), "the name is not over the phone: \(sideRect)")
        XCTAssertGreaterThan(sideRect.minX, left.maxX, "it sits on the free side")
        // A centred 16:9 movie with the default padding: the thin top band still holds it.
        let centred = CGRect(x: 65, y: 65, width: 1790, height: 950)
        let thin = try XCTUnwrap(Looks.chapterPlate("Sign in", mark: mark, plates: plates, canvas: wide, movie: centred, barHeight: bar))
        XCTAssertFalse(CGRect(origin: thin.origin, size: thin.plate.extent.size).intersects(centred), "a smaller name fits the padding")
        // No frame: the bottom left above the bar, not over the status bar at the top.
        let bare = try XCTUnwrap(Looks.chapterPlate("Sign in", mark: mark, plates: plates, canvas: wide, movie: nil, barHeight: bar))
        XCTAssertLessThan(bare.origin.y, 200, "without a frame it sits low")
        // A corner pins it: topLeft is the old place.
        mark.chapterPlace = .topLeft
        let pinned = try XCTUnwrap(Looks.chapterPlate("Sign in", mark: mark, plates: plates, canvas: portrait, movie: phone, barHeight: bar))
        XCTAssertGreaterThan(pinned.origin.y + pinned.plate.extent.height, 1850, "topLeft is the canvas's top left")
        XCTAssertEqual(ProgressMark.at(outUs: 0, project: edit(), recorded: [(0, "A")],
                                       settings: .init(chapterPlace: .bottomRight))?.chapterPlace, .bottomRight)

        // Drawn: white text pixels land in the free band, none inside the phone.
        mark.chapterPlace = .auto
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: portrait))
        let drawn = Looks.drawProgress(mark, plates: plates, on: black, size: portrait, movie: phone)
        var bytes = [UInt8](repeating: 0, count: 1080 * 1920 * 4)
        CIContext().render(drawn, toBitmap: &bytes, rowBytes: 1080 * 4, bounds: CGRect(origin: .zero, size: portrait), format: .RGBA8,
                           colorSpace: CGColorSpaceCreateDeviceRGB())
        var inPhone = 0, inBand = 0
        for y in Int(bar) + 2..<1920 {
            for x in stride(from: 0, to: 1080, by: 2) where bytes[((1919 - y) * 1080 + x) * 4] > 180 {
                if phone.contains(CGPoint(x: x, y: y)) { inPhone += 1 } else { inBand += 1 }
            }
        }
        XCTAssertEqual(inPhone, 0, "no bright pixel of the name over the phone")
        XCTAssertGreaterThan(inBand, 50, "the name is drawn")
        // RECORDER_PROOF_DIR=<folder> keeps the picture (a grey phone on black) as the rendered proof of the place.
        if let folder = ProcessInfo.processInfo.environment["RECORDER_PROOF_DIR"] {
            let phoneLayer = CIImage(color: CIColor(red: 0.35, green: 0.35, blue: 0.4)).cropped(to: phone)
            let proof = Looks.drawProgress(mark, plates: plates, on: phoneLayer.composited(over: black), size: portrait, movie: phone)
            let context = CIContext()
            try context.writePNGRepresentation(of: proof, to: URL(fileURLWithPath: folder).appendingPathComponent("r6-8-chapter-portrait.png"),
                                               format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            let wideProof = Looks.drawProgress(mark, plates: plates,
                                               on: CIImage(color: CIColor(red: 0.35, green: 0.35, blue: 0.4)).cropped(to: left)
                                                   .composited(over: CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: wide))),
                                               size: wide, movie: left)
            try context.writePNGRepresentation(of: wideProof, to: URL(fileURLWithPath: folder).appendingPathComponent("r6-8-chapter-phone-left.png"),
                                               format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        }
    }

    // R4 9 intro and end cards
    func testCardsSitBeforeAndAfterTheMovieOnlyInTheExport() {
        var project = edit()
        project.cards = EditProject.Cards(intro: .init(title: "Demo", seconds: 2), end: .init(text: "Bye", link: "https://example.com", qr: true, seconds: 3))
        let off = CardSpans(project: project, enabled: false)
        XCTAssertEqual(off.leadUs, 0)
        XCTAssertNil(off.card(atOutput: -1, movieUs: 10_000_000), "the preview has no cards")
        let on = CardSpans(project: project, enabled: true)
        XCTAssertEqual(on.leadUs, 2_000_000)
        XCTAssertEqual(on.tailUs, 3_000_000)
        XCTAssertEqual(on.card(atOutput: -1_500_000, movieUs: 10_000_000)?.sinceUs, 500_000)
        XCTAssertNil(on.card(atOutput: 0, movieUs: 10_000_000))
        XCTAssertEqual(on.card(atOutput: 11_000_000, movieUs: 10_000_000)?.sinceUs, 1_000_000)
        guard case .end = on.card(atOutput: 10_000_000, movieUs: 10_000_000)?.kind else { return XCTFail("the end card starts at the movie's end") }
    }

    func testTheEndCardDrawsItsQRCodeOnTheBackground() throws {
        var project = edit()
        project.frame = EditProject.Frame(background: .init(kind: .color, colors: ["#202040"]))
        let size = CGSize(width: 640, height: 360)
        let end = EditProject.EndCard(text: "Bye", link: "https://example.com/demo", qr: true)
        let drawn = Looks.drawCard(.init(kind: .end(end), sinceUs: 1_000_000, lengthUs: 3_000_000), project: project, plates: TextPlates(), size: size)
        var bytes = [UInt8](repeating: 0, count: 640 * 360 * 4)
        CIContext().render(drawn, toBitmap: &bytes, rowBytes: 640 * 4, bounds: CGRect(origin: .zero, size: size), format: .RGBA8,
                           colorSpace: CGColorSpaceCreateDeviceRGB())
        let pixels = stride(from: 0, to: bytes.count, by: 4).map { (bytes[$0], bytes[$0 + 1], bytes[$0 + 2]) }
        let white = pixels.filter { $0.0 > 240 && $0.1 > 240 && $0.2 > 240 }.count
        let black = pixels.filter { $0.0 < 15 && $0.1 < 15 && $0.2 < 15 }.count
        XCTAssertGreaterThan(white, 3000, "the QR code's white board and the text")
        XCTAssertGreaterThan(black, 800, "the QR code's modules (about 1400 at this size)")
        XCTAssertGreaterThan(pixels.filter { $0.2 > 50 && $0.0 < 50 }.count, 100_000, "the rest is the frame's colour")
        XCTAssertNotNil(CardCodes.shared.qr("https://example.com/demo", side: 100))
    }

    /// Pixels that are clearly yellow (red and green high, blue low).
    private func yellowPixels(_ image: CIImage, size: CGSize) throws -> Int {
        let width = Int(size.width), height = Int(size.height)
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        CIContext().render(image, toBitmap: &bytes, rowBytes: width * 4, bounds: CGRect(origin: .zero, size: size),
                           format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return stride(from: 0, to: bytes.count, by: 4).filter { bytes[$0] > 180 && bytes[$0 + 1] > 150 && bytes[$0 + 2] < 90 }.count
    }

    func testAVoiceoverAndDuckingRoundTripThroughTheEditFile() throws {
        var project = edit()
        project.audio.voiceovers = [.init(id: "v1", atUs: 1_000_000, file: "/v.mp3", durationUs: 2_000_000, volume: 1.4, label: "Intro")]
        project.audio.ducking = EditProject.Ducking(db: 18, fadeMs: 200, transcript: false, voiceovers: true)
        let back = try EditProject.decode(project.encoded())
        XCTAssertEqual(back.audio, project.audio)
        var louder = project
        louder.audio.voiceovers?[0].volume = 0.5
        louder.audio.ducking = nil
        XCTAssertEqual(EditOpDiff.ops(from: project, to: louder),
                       [.voiceover(EditOp.Voiceover(id: "v1", volume: 0.5)), .ducking(EditOp.Ducking(enabled: false))])
    }
}
