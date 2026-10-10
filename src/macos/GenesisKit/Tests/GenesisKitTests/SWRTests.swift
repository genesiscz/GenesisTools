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

    func testOnlyASmallRefreshAnimates() {
        let shown = Dictionary(uniqueKeysWithValues: (0..<20).map { ("r\($0)", "1") })
        // A first paint never animates: there is nothing to slide against.
        XCTAssertFalse(SWR.animates(before: [String: String](), after: [("a", "1")]))
        // Two new rows on a page of twenty slide in.
        XCTAssertTrue(SWR.animates(before: shown, after: shown.map { ($0.key, $0.value) } + [("n1", "1"), ("n2", "1")]))
        // A page from disk that is days old: every row differs, so it swaps without the fade that left ghosts.
        XCTAssertFalse(SWR.animates(before: shown, after: (0..<20).map { ("fresh\($0)", "1") }))
        // Removals count too.
        XCTAssertFalse(SWR.animates(before: shown, after: [("r0", "1")], limit: 12))
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
