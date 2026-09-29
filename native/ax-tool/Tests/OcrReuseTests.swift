import AppKit
import XCTest
@testable import SnapshotSupport

/// Ported from typesafe-computer-use's tests/test_ocr_cache.py, plus the two checks added here: the
/// thumbnail peak and the exact pixels under a reused line.
final class OcrReuseTests: XCTestCase {
    private func box(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> CGRect {
        CGRect(x: x1, y: y1, width: x2 - x1, height: y2 - y1)
    }

    /// A dark capture with white boxes, like tscu's `painted`.
    private func painted(width: Int = 2048, height: Int = 1024, boxes: [CGRect] = [], fill: UInt8 = 30) -> GrayImage {
        var pixels = [UInt8](repeating: fill, count: width * height)
        for rect in boxes {
            for y in Int(rect.minY)..<Int(rect.maxY) {
                for x in Int(rect.minX)..<Int(rect.maxX) { pixels[y * width + x] = 255 }
            }
        }
        return GrayImage(width: width, height: height, bytesPerRow: width, pixels: pixels)!
    }

    /// Tiles at the given (column, row) positions on one 256-pixel grid.
    private func grid(_ cells: (Int, Int)...) -> [CGRect] {
        cells.map { CGRect(x: Double($0.0) * 256, y: Double($0.1) * 256, width: 256, height: 256) }
    }

    // MARK: tiles and change detection

    func testTilesCoverTheRegionAlignedToItsOrigin() {
        let tiles = ocrTiles(in: box(100, 100, 700, 400))
        XCTAssertEqual(tiles.count, 6)
        XCTAssertEqual(tiles.first, box(100, 100, 356, 356))
        XCTAssertEqual(tiles.last, box(612, 356, 700, 400))
    }

    func testNoTileChangesBetweenIdenticalCaptures() {
        let thumb = ocrThumbnail(painted(width: 1024, height: 512))
        XCTAssertEqual(ocrChangedTiles(thumb, thumb, tiles: ocrTiles(in: box(0, 0, 1024, 512))), [])
    }

    func testOnlyThePaintedTileChanges() {
        let before = ocrThumbnail(painted(width: 1024, height: 512))
        let after = ocrThumbnail(painted(width: 1024, height: 512, boxes: [box(300, 300, 400, 400)]))
        XCTAssertEqual(ocrChangedTiles(after, before, tiles: ocrTiles(in: box(0, 0, 1024, 512))), [box(256, 256, 512, 512)])
    }

    func testAWholeNewScreenChangesEveryTile() {
        let before = ocrThumbnail(painted(width: 1024, height: 512))
        let after = ocrThumbnail(painted(width: 1024, height: 512, boxes: [box(0, 0, 1024, 512)]))
        let tiles = ocrTiles(in: box(0, 0, 1024, 512))
        XCTAssertEqual(ocrChangedTiles(after, before, tiles: tiles).count, tiles.count)
    }

    func testFaintNoiseDoesNotCountAsAChange() {
        let before = ocrThumbnail(painted(width: 1024, height: 512))
        let after = ocrThumbnail(painted(width: 1024, height: 512, fill: 33))
        XCTAssertEqual(ocrChangedTiles(after, before, tiles: ocrTiles(in: box(0, 0, 1024, 512))), [])
    }

    func testAOneGlyphEditChangesItsTileThroughThePeak() {
        // A 6x10 glyph moves a 256-pixel tile's thumbnail mean by far less than 6, but not its peak.
        let before = ocrThumbnail(painted(width: 1024, height: 512))
        let after = ocrThumbnail(painted(width: 1024, height: 512, boxes: [box(300, 300, 306, 310)]))
        XCTAssertEqual(ocrChangedTiles(after, before, tiles: ocrTiles(in: box(0, 0, 1024, 512))), [box(256, 256, 512, 512)])
    }

    func testARectPadsByOneTileAndClampsToTheRegion() {
        let region = box(0, 0, 1024, 512)
        XCTAssertEqual(ocrReocrRects(changed: [box(256, 256, 512, 512)], region: region, lines: []), [box(0, 0, 768, 512)])
        XCTAssertEqual(ocrReocrRects(changed: [], region: region, lines: []), [])
    }

    // MARK: clustering

    func testTouchingTilesAreOneBlob() {
        XCTAssertEqual(ocrTileClusters(grid((0, 0), (1, 0), (1, 1))).count, 1)
    }

    func testTilesTouchingOnlyAtACornerAreOneBlob() {
        XCTAssertEqual(ocrTileClusters(grid((0, 0), (1, 1))).count, 1)
    }

    func testFarApartTilesAreSeparateBlobs() {
        XCTAssertEqual(ocrTileClusters(grid((0, 0), (8, 6))).count, 2)
    }

    func testTwoFarChangesBecomeTwoRectangles() {
        let rects = ocrReocrRects(changed: grid((0, 0), (12, 7)), region: box(0, 0, 4096, 2304), lines: [])
        XCTAssertEqual(rects, [box(0, 0, 512, 512), box(2816, 1536, 3584, 2304)])
    }

    func testBlobsThatTouchOnceGrownBecomeOneRectangle() {
        XCTAssertEqual(ocrReocrRects(changed: grid((0, 0), (3, 0)), region: box(0, 0, 4096, 2304), lines: []).count, 1)
    }

    func testALineStraddlingAnEdgeCanMergeTwoRectangles() {
        let region = box(0, 0, 4096, 2304)
        let apart = grid((0, 0), (8, 0))
        XCTAssertEqual(ocrReocrRects(changed: apart, region: region, lines: []).count, 2)
        XCTAssertEqual(ocrReocrRects(changed: apart, region: region, lines: [box(400, 100, 2000, 140)]).count, 1)
    }

    func testMoreBlobsThanTheCapMergeDownToItClosestPairFirst() {
        let five = grid((0, 0), (6, 0), (12, 0), (16, 0), (21, 0))
        let wide = box(0, 0, 8192, 2304)
        XCTAssertEqual(ocrTileClusters(five).count, 5)
        let rects = ocrReocrRects(changed: five, region: wide, lines: [])
        XCTAssertEqual(rects.count, ocrMaxReocrRects)
        XCTAssertTrue(rects.contains(box(2816, 0, 4608, 512)))
        XCTAssertTrue(rects.contains(box(0, 0, 512, 512)))
    }

    // MARK: lines

    private func line(_ text: String, _ rect: CGRect, hash: String = "") -> OcrLine {
        OcrLine(text: text, confidence: 1, source: VisualRect(rect), pixelHash: hash)
    }

    func testBoxesIntersectOnlyOnRealOverlap() {
        XCTAssertTrue(ocrBoxesIntersect(box(0, 0, 10, 10), box(5, 5, 20, 20)))
        XCTAssertFalse(ocrBoxesIntersect(box(0, 0, 10, 10), box(10, 0, 20, 10)))
    }

    func testReReadReplacesEveryLineTheRectangleTouches() {
        let previous = [line("stale", box(100, 100, 200, 130)), line("kept", box(900, 900, 1000, 930)),
                        line("straddles", box(90, 40, 110, 70))]
        let merged = ocrMergeReocr(previous: previous, fresh: [line("fresh", box(100, 100, 260, 130))],
                                   rects: [box(50, 50, 400, 400)])
        XCTAssertEqual(merged.map(\.text), ["kept", "fresh"])
    }

    func testReReadKeepsALineThatOnlyTouchesTheRectangleEdge() {
        let previous = [line("outside", box(10, 10, 50, 40))]
        XCTAssertEqual(ocrMergeReocr(previous: previous, fresh: [], rects: [box(50, 10, 400, 400)]), previous)
    }

    // MARK: the reuse decision

    /// Records every rectangle handed to Vision and answers with one line naming it, like tscu's
    /// `reads` fixture, and carries the cache from one capture to the next.
    private final class Reader {
        var reads: [CGRect] = []
        var state: OcrCacheState = .missing

        func run(_ image: GrayImage, key: OcrReuseKey) throws -> (lines: [String], report: OcrReuseReport) {
            let outcome = try readOcrLines(state: state, key: key, image: image, region: CGRect(x: 0, y: 0, width: image.width, height: image.height)) { rect in
                reads.append(rect)
                return [OcrText(text: "read \(reads.count)", confidence: 1,
                                source: CGRect(x: rect.minX, y: rect.minY, width: 10, height: 10))]
            }
            state = .loaded(OcrReuseCache(key: key, thumb: outcome.thumb, lines: outcome.lines))
            return (outcome.lines.map(\.text), outcome.report)
        }
    }

    private func key(pid: Int32 = 42, x: Double = 0) throws -> OcrReuseKey {
        OcrReuseKey(pid: pid, launch: 1000, windowID: 7, bounds: VisualRect(x: x, y: 0, width: 1024, height: 512),
                    transform: try VisualTransform(sourceWidth: 2048, sourceHeight: 1024))
    }

    func testTheFirstCaptureReadsTheWholeRegion() throws {
        let reader = Reader()
        let first = try reader.run(painted(), key: key())
        XCTAssertEqual(reader.reads, [box(0, 0, 2048, 1024)])
        XCTAssertEqual(first.report, OcrReuseReport(mode: "full", reason: "no_cache", rects: 0, readFraction: 1))
        XCTAssertEqual(first.lines, ["read 1"])
    }

    func testAnUnchangedCaptureIsNotReadAgain() throws {
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        let second = try reader.run(painted(), key: key())
        XCTAssertEqual(reader.reads.count, 1)
        XCTAssertEqual(second.report, OcrReuseReport(mode: "unchanged", reason: nil, rects: 0, readFraction: 0))
        XCTAssertEqual(second.lines, ["read 1"])
    }

    func testASmallChangeReadsOnlyTheRectangleAroundIt() throws {
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        let second = try reader.run(painted(boxes: [box(300, 300, 400, 400)]), key: key())
        XCTAssertEqual(reader.reads[1], box(0, 0, 768, 768))
        XCTAssertEqual(second.report.mode, "partial")
        XCTAssertEqual(second.report.rects, 1)
        XCTAssertLessThan(second.report.readFraction, 0.5)
        XCTAssertEqual(second.lines, ["read 2"])
    }

    func testAChangeOverTheThresholdReadsTheWholeRegion() throws {
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        let second = try reader.run(painted(boxes: [box(0, 0, 2048, 1024)]), key: key())
        XCTAssertEqual(reader.reads[1], box(0, 0, 2048, 1024))
        XCTAssertEqual(second.report, OcrReuseReport(mode: "full", reason: "too_much_changed", rects: 0, readFraction: 1))
    }

    func testADifferentAppOrAMovedWindowIsNeverReused() throws {
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        XCTAssertEqual(try reader.run(painted(), key: key(pid: 43)).report.reason, "key_changed")
        _ = try reader.run(painted(), key: key())
        XCTAssertEqual(try reader.run(painted(), key: key(x: 20)).report.reason, "key_changed")
        XCTAssertEqual(reader.reads, Array(repeating: box(0, 0, 2048, 1024), count: 4))
    }

    func testTheRectangleGrowsPastALineItWouldHaveCutInHalf() throws {
        let reader = Reader()
        let first = painted()
        _ = try reader.run(first, key: key())
        let headline = box(700, 300, 1400, 340)
        reader.state = .loaded(OcrReuseCache(key: try key(), thumb: ocrThumbnail(first),
                                             lines: [line("headline", headline, hash: ocrLinePixelHash(first, headline))]))
        _ = try reader.run(painted(boxes: [box(300, 300, 400, 400)]), key: key())
        XCTAssertEqual(reader.reads[1], box(0, 0, 1400, 768))
    }

    func testARectangleThatGrowsPastTheThresholdReadsTheWholeRegion() throws {
        let reader = Reader()
        let first = painted()
        _ = try reader.run(first, key: key())
        let wide = box(0, 600, 2048, 700)
        reader.state = .loaded(OcrReuseCache(key: try key(), thumb: ocrThumbnail(first),
                                             lines: [line("edge to edge", wide, hash: ocrLinePixelHash(first, wide))]))
        let second = try reader.run(painted(boxes: [box(300, 300, 400, 400)]), key: key())
        XCTAssertEqual(reader.reads[1], box(0, 0, 2048, 1024))
        XCTAssertEqual(second.report.reason, "rects_too_large")
    }

    func testTwoFarApartChangesAreReadAsTwoCrops() throws {
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        let second = try reader.run(painted(boxes: [box(100, 100, 180, 180), box(1900, 900, 1980, 980)]), key: key())
        XCTAssertEqual(Array(reader.reads.dropFirst()), [box(0, 0, 512, 512), box(1536, 512, 2048, 1024)])
        XCTAssertEqual(second.report, OcrReuseReport(mode: "partial", reason: nil, rects: 2, readFraction: 0.25))
        XCTAssertEqual(second.lines, ["read 2", "read 3"])
    }

    func testRectanglesWhoseAreasAddPastTheThresholdReadTheWholeRegion() throws {
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        let second = try reader.run(painted(boxes: [box(0, 0, 768, 1024), box(1792, 0, 2048, 1024)]), key: key())
        XCTAssertEqual(reader.reads[1], box(0, 0, 2048, 1024))
        XCTAssertEqual(second.report.reason, "rects_too_large")
    }

    func testALineWhosePixelsChangedIsReadAgainThoughItsTileLooksQuiet() throws {
        // One pixel under the cached line brightens by 40: 40/64 in the thumbnail, far under both
        // thresholds. The reused text must still describe this capture, so the line is read again.
        let reader = Reader()
        _ = try reader.run(painted(), key: key())
        var pixels = painted().pixels
        pixels[5 * 2048 + 5] = 70
        let second = try reader.run(GrayImage(width: 2048, height: 1024, bytesPerRow: 2048, pixels: pixels)!, key: key())
        XCTAssertEqual(reader.reads[1], box(0, 0, 512, 512))
        XCTAssertEqual(second.report.mode, "partial")
        XCTAssertEqual(second.lines, ["read 2"])
    }

    // MARK: the cache file

    func testTheCacheFileRoundTripsPrivatelyAndAGarbledOneIsAFullRead() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ocr-reuse-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let path = directory.appendingPathComponent("cache.json").path
        guard case .missing = loadOcrReuseCache(path: path) else { return XCTFail("a missing file must read as missing") }

        let image = painted(width: 64, height: 32)
        let cache = OcrReuseCache(key: try key(), thumb: ocrThumbnail(image), lines: [line("hello", box(1, 2, 30, 12), hash: "abc")])
        try writeOcrReuseCache(cache, path: path)
        let mode = try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(mode?.intValue, 0o600)
        guard case .loaded(let loaded) = loadOcrReuseCache(path: path) else { return XCTFail("the cache must load back") }
        XCTAssertEqual(loaded.key, cache.key)
        XCTAssertEqual(loaded.lines, cache.lines)
        XCTAssertEqual(loaded.thumbImage?.pixels, ocrThumbnail(image).pixels)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["cache.json"])

        try Data("not json".utf8).write(to: URL(fileURLWithPath: path))
        let state = loadOcrReuseCache(path: path)
        guard case .unreadable = state else { return XCTFail("a garbled file must read as unreadable") }
        var reads = 0
        let outcome = try readOcrLines(state: state, key: key(), image: image, region: box(0, 0, 64, 32)) { _ in
            reads += 1
            return []
        }
        XCTAssertEqual(reads, 1)
        XCTAssertEqual(outcome.report.reason, "unreadable")
    }
}
