import XCTest
@testable import GenesisKit

/// Stale-while-revalidate (Style/SWR.swift, Tools/DiskCache.swift): which rows flash, and the reads off the main thread.
final class SWRTests: XCTestCase {
    func testFirstPaintDoesNotFlash() {
        XCTAssertEqual(SWR.changed(before: [String: String](), after: [("a", "1")]), [])
    }

    func testNewAndMovedRowsFlashUnchangedDoNot() {
        let changed = SWR.changed(before: ["a": "1", "b": "1"], after: [("a", "1"), ("b", "2"), ("c", "1")])
        XCTAssertEqual(changed, ["b", "c"])
    }

    func testLoadReadsOffTheMainThread() async {
        let cache = DiskCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent("swr-\(UUID().uuidString)"), namespace: "rows")
        let missing = await cache.load([Int].self, key: "k")
        XCTAssertNil(missing)
        cache.write([1, 2], key: "k")
        let rows = await cache.load([Int].self, key: "k")
        XCTAssertEqual(rows, [1, 2])
        let data = await cache.loadData(key: "k")
        XCTAssertEqual(data.map { String(decoding: $0, as: UTF8.self) }, "[1,2]")
    }
}
