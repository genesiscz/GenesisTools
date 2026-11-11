import XCTest
@testable import GenesisToolsRecorder

/// The burned-in progress bar divides where the MP4 gets a chapter: a marker less than 1 s after the chapter before
/// it starts none (the earlier label stays), and a first marker under 1 s starts the first chapter at 0 with no
/// divider, as moments.ts chapterPoints folds the embedded chapters (EMBEDDED_CHAPTER_MIN_SECONDS).
final class RecorderHuntProgressBarChapterFoldTests: XCTestCase {
    private func movie(seconds: Int64 = 20) -> EditProject {
        EditProject.whole(video: "/tmp/x.mp4", durationUs: seconds * 1_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
    }

    private let settings = EditProject.ProgressBar(color: "#FF375F", chapterMs: 2000)

    func testMarkersUnderASecondApartMakeOneDividerNamedByTheFirst() throws {
        var project = movie()
        project.markers = [
            .init(id: "m1", atUs: 5_000_000, label: "Five"),
            .init(id: "m2", atUs: 5_400_000, label: "Five and a bit"),
            .init(id: "m3", atUs: 9_000_000, label: "Nine"),
        ]
        let chapters = ProgressMark.chapters(project: project, recorded: [])
        XCTAssertEqual(chapters.map(\.label), ["Five", "Nine"], "the marker 0.4 s after Five starts no chapter")
        XCTAssertEqual(chapters.map(\.outUs), [5_000_000, 9_000_000])
        let mark = try XCTUnwrap(ProgressMark.at(outUs: 5_600_000, project: project, recorded: [], settings: settings))
        XCTAssertEqual(mark.dividers, [0.25, 0.45], "dividers at 5 s and 9 s of a 20 s movie only")
        XCTAssertEqual(mark.chapter, "Five", "the earlier label stays, as the MP4 chapter names it")
    }

    func testTheGapIsMeasuredFromTheLastChapterKept() {
        var project = movie()
        project.markers = [
            .init(id: "a", atUs: 5_000_000, label: "A"),
            .init(id: "b", atUs: 5_600_000, label: "B"),
            .init(id: "c", atUs: 6_200_000, label: "C"),
            .init(id: "d", atUs: 7_200_000, label: "D"),
        ]
        XCTAssertEqual(ProgressMark.chapters(project: project, recorded: []).map(\.label), ["A", "C", "D"],
                       "B is 0.6 s after A; C is 1.2 s after A, the chapter kept before it; D is 1 s after C")
    }

    func testAFirstMarkerUnderASecondStartsTheFirstChapterAtZeroWithoutADivider() throws {
        var project = movie()
        project.markers = [
            .init(id: "m1", atUs: 10_000_000, label: "Ten"),
            .init(id: "m2", atUs: 10_500_000, label: "TenHalf"),
            .init(id: "m3", atUs: 900_000, label: "Too soon"),
        ]
        let recorded: [(us: Int64, label: String)] = [(400_000, "Start")]
        let chapters = ProgressMark.chapters(project: project, recorded: recorded)
        XCTAssertEqual(chapters.map(\.label), ["Start", "Ten"])
        XCTAssertEqual(chapters.first?.outUs, 0, "a first marker under 1 s moves to 0")
        let late = try XCTUnwrap(ProgressMark.at(outUs: 10_600_000, project: project, recorded: recorded, settings: settings))
        XCTAssertEqual(late.dividers, [0.5], "one divider at 10 s; none at 0")
        XCTAssertEqual(late.chapter, "Ten")
        XCTAssertEqual(ProgressMark.at(outUs: 100_000, project: project, recorded: recorded, settings: settings)?.chapter, "Start",
                       "the first chapter's name shows from 0")
    }

    func testAFirstMarkerAtOneSecondKeepsItsDivider() throws {
        var project = movie(seconds: 10)
        project.markers = [.init(id: "m1", atUs: 1_000_000, label: "One"), .init(id: "m2", atUs: 1_800_000, label: "Close")]
        let mark = try XCTUnwrap(ProgressMark.at(outUs: 1_900_000, project: project, recorded: [], settings: settings))
        XCTAssertEqual(mark.dividers, [0.1], "a marker at 1 s is not under 1 s, so it divides; the one 0.8 s later does not")
        XCTAssertEqual(mark.chapter, "One")
    }
}
