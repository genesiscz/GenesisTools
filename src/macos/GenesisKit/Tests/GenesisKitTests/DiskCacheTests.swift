import XCTest
@testable import GenesisKit

final class DiskCacheTests: XCTestCase {
    private struct Row: Codable, Equatable {
        let id: Int
        let title: String
    }

    func testWritesAndReadsBackByKeyInItsNamespace() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("diskcache-\(UUID().uuidString)")
        let cache = DiskCache(directory: dir, namespace: "rows")
        XCTAssertNil(cache.read([Row].self, key: "/tmp/scratch/app|open"))
        XCTAssertNil(cache.modified(key: "/tmp/scratch/app|open"))

        cache.write([Row(id: 1, title: "one")], key: "/tmp/scratch/app|open")
        XCTAssertEqual(cache.read([Row].self, key: "/tmp/scratch/app|open"), [Row(id: 1, title: "one")])
        XCTAssertNotNil(cache.modified(key: "/tmp/scratch/app|open"))
        XCTAssertNil(cache.read([Row].self, key: "/tmp/scratch/app|merged"))
        XCTAssertTrue(cache.url(for: "x").lastPathComponent.hasPrefix("rows-"))
        // Another namespace never sees the entry.
        XCTAssertNil(DiskCache(directory: dir, namespace: "other").read([Row].self, key: "/tmp/scratch/app|open"))
    }

    func testAnUnreadableEntryReadsAsMissing() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("diskcache-\(UUID().uuidString)")
        let cache = DiskCache(directory: dir, namespace: "rows")
        cache.writeData(Data("not json".utf8), key: "k")
        XCTAssertNil(cache.read([Row].self, key: "k"))
        XCTAssertEqual(cache.readData(key: "k"), Data("not json".utf8))
    }
}
