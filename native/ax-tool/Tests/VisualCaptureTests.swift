import AppKit
import XCTest
@testable import SnapshotSupport

final class VisualCaptureTests: XCTestCase {
    func capture() throws -> VisualCaptureIdentity {
        VisualCaptureIdentity(pid: 42, launch: 123, windowID: 7,
            bounds: VisualRect(x: -800, y: 100, width: 400, height: 300), created: 1000,
            pngHash: "png", pixelHash: "pixels",
            transform: try VisualTransform(sourceWidth: 800, sourceHeight: 600),
            regions: [VisualRegion(id: "v0", source: VisualRect(x: 200, y: 100, width: 80, height: 40))])
    }

    func testExpiredClaimsArePrunedOnlyAfterTheirActionLifetimeAndOnlyForOwnedRegularMarkers() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("visual-prune-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions:0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let old = try capture()
        try consumeVisualCapture(old, directory: root)
        let oldFile = root.appendingPathComponent(old.id + ".used")
        try FileManager.default.setAttributes([.modificationDate:Date(timeIntervalSinceNow:-700)], ofItemAtPath:oldFile.path)
        let fresh = try capture()
        try consumeVisualCapture(fresh, directory:root)
        XCTAssertFalse(FileManager.default.fileExists(atPath:oldFile.path))
        XCTAssertTrue(try visualCaptureWasUsed(fresh,directory:root))
        let other = root.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to:other)
        let link = root.appendingPathComponent(UUID().uuidString + ".used")
        try FileManager.default.createSymbolicLink(at:link,withDestinationURL:other)
        try pruneExpiredVisualClaims(in:root,now:Date(timeIntervalSinceNow:700))
        XCTAssertTrue(FileManager.default.fileExists(atPath:other.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath:link.path))
    }

    func testRetinaAndNegativeOrigin() throws {
        let point = try capture().center(of: "v0")
        XCTAssertEqual(point.x, -680, accuracy: 0.001)
        XCTAssertEqual(point.y, 160, accuracy: 0.001)
    }
    func testCropResizeChainMapsBackToSourcePixels() throws {
        let transform = try VisualTransform(sourceWidth: 1600, sourceHeight: 1200,
            crop: VisualRect(x: 200, y: 100, width: 800, height: 600), processedWidth: 400, processedHeight: 300)
        let source = try transform.sourceRect(VisualRect(x: 10, y: 20, width: 50, height: 30))
        XCTAssertEqual(source, VisualRect(x: 220, y: 140, width: 100, height: 60))
        let screen = try transform.screenRect(source, window: VisualRect(x: -1000, y: -500, width: 800, height: 600))
        XCTAssertEqual(screen, VisualRect(x: -890, y: -430, width: 50, height: 30))
        XCTAssertThrowsError(try transform.sourceRect(VisualRect(x: 399, y: 0, width: 2, height: 1)))
    }
    func testInvalidGeometryFailsWithoutAllocation() {
        XCTAssertThrowsError(try VisualTransform(sourceWidth: 0, sourceHeight: 1))
        XCTAssertThrowsError(try VisualTransform(sourceWidth: 16384, sourceHeight: 16384))
        XCTAssertThrowsError(try VisualTransform(sourceWidth: 800, sourceHeight: 600,
            crop: VisualRect(x: 0, y: 0, width: 0, height: 10)))
        XCTAssertThrowsError(try VisualTransform(sourceWidth: 800, sourceHeight: 600,
            crop: VisualRect(x: 0, y: 0, width: Double.infinity, height: 10)))
    }
    func testGuardRejectsChangedPixelsGeometryProcessSizeAndAgeBeforeConsume() throws {
        let record = try capture()
        var consumed = 0
        func check(pid: Int32 = 42, launch: Double = 123, window: Int = 7,
                   bounds: VisualRect? = nil, hash: String = "pixels", width: Int = 800,
                   height: Int = 600, now: Double = 1001) throws {
            try admitVisualCapture(capture: record, pid: pid, launch: launch, windowID: window,
                bounds: bounds ?? record.bounds, pixelHash: hash, width: width, height: height, now: now,
                consume: { consumed += 1; throw VisualCaptureError.invalid("consume must remain unreachable") })
        }
        XCTAssertThrowsError(try check(pid: 43))
        XCTAssertThrowsError(try check(launch: 124))
        XCTAssertThrowsError(try check(window: 8))
        XCTAssertThrowsError(try check(hash: "changed"))
        XCTAssertThrowsError(try check(width: 799))
        XCTAssertThrowsError(try check(height: 599))
        XCTAssertThrowsError(try check(now: 1031))
        XCTAssertThrowsError(try check(now: 999))
        XCTAssertThrowsError(try check(now: Double.nan))
        XCTAssertThrowsError(try check(bounds: VisualRect(x: -799, y: 100, width: 400, height: 300)))
        XCTAssertEqual(consumed, 0)
        var admitted = 0
        try admitVisualCapture(capture: record, pid: 42, launch: 123, windowID: 7, bounds: record.bounds,
            pixelHash: "pixels", width: 800, height: 600, now: 1001, consume: { admitted += 1 })
        XCTAssertEqual(admitted, 1)
    }
    func testCaptureIsOneUseEvenAcrossCallers() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { XCTAssertNoThrow(try FileManager.default.removeItem(at: directory)) }
        let record = try capture()
        XCTAssertFalse(try visualCaptureWasUsed(record, directory: directory))
        try consumeVisualCapture(record, directory: directory)
        XCTAssertTrue(try visualCaptureWasUsed(record, directory: directory))
        XCTAssertThrowsError(try consumeVisualCapture(record, directory: directory)) { error in
            XCTAssertTrue(error.localizedDescription.contains("already used"))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
    }
    func testPixelHashIsStableAndDetectsCanvasOnlyChanges() throws {
        func image(_ value: CGFloat) -> CGImage {
            let context = CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(CGColor(red: value, green: 0, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
            return context.makeImage()!
        }
        XCTAssertEqual(try visualPixelHash(image(0)), try visualPixelHash(image(0)))
        XCTAssertNotEqual(try visualPixelHash(image(0)), try visualPixelHash(image(1)))
    }
}
