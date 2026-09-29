import XCTest
@testable import SnapshotSupport

final class WindowChoiceTests: XCTestCase {
    private func candidate(_ index: Int, subrole: String?, height: Double = 800, minimized: Bool = false) -> WindowCandidate {
        WindowCandidate(index: index, windowID: 100 + index, title: "w\(index)", subrole: subrole, height: height,
                        minimized: minimized)
    }

    /// Brave's "Translate this page?" bubble made its single browser window ambiguous.
    func testAPopupDoesNotMakeTheOneRealWindowAmbiguous() {
        XCTAssertEqual(defaultWindowIndex([candidate(0, subrole: "AXFloatingWindow", height: 180),
                                           candidate(1, subrole: "AXStandardWindow")]), 1)
        XCTAssertEqual(defaultWindowIndex([candidate(0, subrole: "AXStandardWindow"),
                                           candidate(1, subrole: "AXUnknown", height: 300)]), 0)
        XCTAssertEqual(defaultWindowIndex([candidate(0, subrole: "AXStandardWindow"),
                                           candidate(1, subrole: "AXStandardWindow", height: 40)]), 0)
    }

    func testTwoRealWindowsStayTheCallersChoice() {
        XCTAssertNil(defaultWindowIndex([candidate(0, subrole: "AXStandardWindow"), candidate(1, subrole: "AXStandardWindow")]))
        // A dialog is real work, not a popup.
        XCTAssertNil(defaultWindowIndex([candidate(0, subrole: "AXStandardWindow"), candidate(1, subrole: "AXDialog")]))
    }

    func testAMinimizedWindowIsNotTheDefaultWhenAnotherIsOpen() {
        XCTAssertEqual(defaultWindowIndex([candidate(0, subrole: "AXStandardWindow", minimized: true),
                                           candidate(1, subrole: "AXStandardWindow")]), 1)
        XCTAssertEqual(defaultWindowIndex([candidate(0, subrole: "AXStandardWindow", minimized: true)]), 0)
    }

    func testActivationFallsBackToLaunchServicesOnceWhenActivateIsRefused() {
        var activations = 0
        var launches = 0
        var frontAfterLaunch = false
        let result = activateFrontmost(isFrontmost: { frontAfterLaunch }, activate: { activations += 1 },
                                       openViaLaunchServices: { launches += 1; frontAfterLaunch = true },
                                       pump: { _ in })
        XCTAssertEqual(result.ok, true)
        XCTAssertEqual(result.launchServices, true)
        XCTAssertEqual(launches, 1)
        XCTAssertEqual(activations, 10)
    }

    func testActivationThatWorksNeverTouchesLaunchServices() {
        var launches = 0
        var polls = 0
        let result = activateFrontmost(isFrontmost: { polls += 1; return polls > 2 }, activate: {},
                                       openViaLaunchServices: { launches += 1 }, pump: { _ in })
        XCTAssertEqual(result.ok, true)
        XCTAssertEqual(result.launchServices, false)
        XCTAssertEqual(launches, 0)
    }

    func testRefusedActivationStillEndsAndSaysSo() {
        var launches = 0
        let result = activateFrontmost(isFrontmost: { false }, activate: {}, openViaLaunchServices: { launches += 1 },
                                       pump: { _ in })
        XCTAssertEqual(result.ok, false)
        XCTAssertEqual(launches, 1)
    }
}
