import XCTest
@testable import GenesisTools

/// Which launcher markers an app face hands its children (Sources/App/FaceMarker.swift).
final class FaceMarkerTests: XCTestCase {
    private let own = "com.example.tools"

    func testFaceResponsibleForItselfMarksItsChildrenWithItsInode() {
        let updates = FaceMarker.updates(ownBundleId: own, responsible: .init(bundleId: own, inode: 4242))

        XCTAssertEqual(updates[bundleIdVariable], .some(own))
        XCTAssertEqual(updates[inodeVariable], .some("4242"))
    }

    func testFaceStartedFromATerminalClearsTheMarkers() {
        let updates = FaceMarker.updates(ownBundleId: own, responsible: .init(bundleId: "com.example.terminal", inode: 7))

        XCTAssertEqual(updates[bundleIdVariable], .some(nil))
        XCTAssertEqual(updates[inodeVariable], .some(nil))
    }

    func testBareBinaryOrUnknownResponsibleClearsTheMarkers() {
        for responsible in [FaceMarker.Responsible(bundleId: nil, inode: 7), nil] {
            let updates = FaceMarker.updates(ownBundleId: own, responsible: responsible)

            XCTAssertEqual(updates[bundleIdVariable], .some(nil))
            XCTAssertEqual(updates[inodeVariable], .some(nil))
        }
    }

    func testResponsibleBinaryThatIsGoneClearsTheMarkers() {
        let updates = FaceMarker.updates(ownBundleId: own, responsible: .init(bundleId: own, inode: nil))

        XCTAssertEqual(updates[bundleIdVariable], .some(nil))
        XCTAssertEqual(updates[inodeVariable], .some(nil))
    }

    /// The test runner itself runs under some responsible process; reading it must not fail.
    func testReadsTheRealResponsibleProcess() {
        XCTAssertNotNil(FaceMarker.responsibleProcess()?.inode)
    }

    /// Staged faces (main.swift): only a Clicky Settings snapshot runs while staging is off.
    func testStagingRefusesEveryStagedFaceExceptAClickySnapshot() {
        XCTAssertTrue(NativeStaging.refuses(["--widget"], facesEnabled: false))
        XCTAssertTrue(NativeStaging.refuses(["--widget", "--snapshot", "/tmp/fixture.png"], facesEnabled: false),
                      "the widget has no snapshot mode, so the flag must not start it")
        XCTAssertTrue(NativeStaging.refuses(["--clicky", "--page", "general"], facesEnabled: false))
        XCTAssertFalse(NativeStaging.refuses(["--clicky", "--page", "general", "--snapshot", "/tmp/fixture.png"],
                                             facesEnabled: false))
        XCTAssertFalse(NativeStaging.refuses(["--widget"], facesEnabled: true))
        XCTAssertFalse(NativeStaging.refuses(["--hub", "--snapshot", "/tmp/fixture.png"], facesEnabled: false))
        XCTAssertFalse(NativeStaging.refuses([], facesEnabled: false))
    }
}
