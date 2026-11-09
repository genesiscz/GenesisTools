import XCTest
@testable import GenesisToolsRecorder

/// An editor save keeps autoZoom's mark on its zooms, so a later autoZoom still replaces only those and keeps the
/// user's own follow and canvas zooms.
final class RecorderHuntAutozoomProvenanceTests: XCTestCase {
    func testASaveKeepsTheAutoMark() throws {
        let json = Data(#"{"id":"z1","startUs":1000000,"endUs":3000000,"scale":1.6,"mode":"follow","origin":"auto"}"#.utf8)
        let zoom = try JSONDecoder().decode(EditProject.Zoom.self, from: json)
        XCTAssertEqual(zoom.origin, "auto")
        let saved = try JSONDecoder().decode(EditProject.Zoom.self, from: JSONEncoder().encode(zoom))
        XCTAssertEqual(saved.origin, "auto")
    }

    func testAUserZoomHasNoMark() throws {
        let json = Data(#"{"id":"z2","startUs":1000000,"endUs":3000000,"mode":"follow"}"#.utf8)
        let zoom = try JSONDecoder().decode(EditProject.Zoom.self, from: json)
        XCTAssertNil(zoom.origin)
        let encoded = String(decoding: try JSONEncoder().encode(zoom), as: UTF8.self)
        XCTAssertFalse(encoded.contains("origin"))
    }
}
