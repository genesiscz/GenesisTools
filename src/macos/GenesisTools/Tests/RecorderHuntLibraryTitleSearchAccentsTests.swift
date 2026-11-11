import XCTest
@testable import GenesisToolsRecorder

/// The Recordings window's filter folds case and accents as `tools recorder search` does, and shows a card the
/// search matched by its title.
final class RecorderHuntLibraryTitleSearchAccentsTests: XCTestCase {
    func testAQueryWithoutAccentsFindsATitleWithThem() {
        XCTAssertTrue(LibraryModel.matches(title: "Ukázka přihlášení", folderName: "video-2026-11-09_10-00-00",
                                           query: "prihlaseni", spokenHit: false, titleHit: false))
        XCTAssertTrue(LibraryModel.matches(title: "Ukázka přihlášení", folderName: "video-2026-11-09_10-00-00",
                                           query: "UKÁZKA", spokenHit: false, titleHit: false))
        XCTAssertFalse(LibraryModel.matches(title: "Ukázka přihlášení", folderName: "video-2026-11-09_10-00-00",
                                            query: "odhlaseni", spokenHit: false, titleHit: false))
    }

    func testTheSearchsTitleHitAloneShowsTheCard() {
        XCTAssertTrue(LibraryModel.matches(title: "Standup", folderName: "2026-11-09_10-00-standup",
                                           query: "denni porada", spokenHit: false, titleHit: true))
    }
}
