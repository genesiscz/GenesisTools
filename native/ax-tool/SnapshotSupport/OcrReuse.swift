import CoreGraphics
import CryptoKit
import Darwin
import Foundation

// Changed-region OCR reuse, ported from typesafe-computer-use's perception.py (`OcrCache`,
// `ocr_lines`, `reocr_rects`). OCR costs most of a desktop step and scales with the amount of text,
// so a repeat observation reads only the rectangles around the tiles that changed since the
// previous capture, one Vision call each, and keeps every earlier line outside them.

/// The change detector works on a 1/8 scale grayscale copy.
public let ocrThumbDivisor = 8
/// Tile side in capture pixels.
public let ocrTilePixels: Double = 256
/// Mean absolute 8-bit thumbnail difference that counts a tile as changed.
public let ocrTileDiff = 6.0
/// Added here: the largest single thumbnail pixel change still read as noise. A mean over a whole
/// tile hides a one-glyph edit (a word gaining a letter moves the mean by well under 1), and a
/// screen capture is lossless, so a real repaint shows up as a peak even where the mean stays low.
public let ocrTilePeakDiff = 16
/// Above this share of changed tiles, or of the region's area, reading the whole region is cheaper.
public let ocrReocrFraction = 0.6
/// Past this many rectangles, the per-call overhead outweighs the pixels another one saves.
public let ocrMaxReocrRects = 4

/// A 1/`divisor` copy, each pixel the rounded mean of its box. The last row and column average the
/// pixels they have, so the size rounds up.
public func ocrThumbnail(_ image: GrayImage, divisor: Int = ocrThumbDivisor) -> GrayImage {
    let width = (image.width + divisor - 1) / divisor
    let height = (image.height + divisor - 1) / divisor
    var sums = [Int](repeating: 0, count: width * height)
    sums.withUnsafeMutableBufferPointer { cells in
        image.pixels.withUnsafeBufferPointer { pixels in
            for y in 0..<image.height {
                let row = y * image.bytesPerRow
                let cellRow = (y / divisor) * width
                for x in 0..<image.width {
                    cells[cellRow + x / divisor] &+= Int(pixels[row + x])
                }
            }
        }
    }
    var thumb = [UInt8](repeating: 0, count: width * height)
    for cy in 0..<height {
        let rows = min(divisor, image.height - cy * divisor)
        for cx in 0..<width {
            let count = rows * min(divisor, image.width - cx * divisor)
            thumb[cy * width + cx] = UInt8((sums[cy * width + cx] + count / 2) / count)
        }
    }
    return GrayImage(packedWidth: width, height: height, pixels: thumb)
}

/// The region cut into tiles aligned to its own origin. The last row and column are short.
public func ocrTiles(in region: CGRect, tile: Double = ocrTilePixels) -> [CGRect] {
    var tiles: [CGRect] = []
    var y = region.minY
    while y < region.maxY {
        var x = region.minX
        while x < region.maxX {
            tiles.append(CGRect(x: x, y: y, width: min(x + tile, region.maxX) - x, height: min(y + tile, region.maxY) - y))
            x += tile
        }
        y += tile
    }
    return tiles
}

/// True when the tile's thumbnail patch changed past the mean or the peak threshold. A patch that
/// cannot be compared counts as changed, so a doubt is always paid for with a read.
public func ocrTileChanged(_ thumb: GrayImage, _ previous: GrayImage, tile: CGRect,
                           divisor: Int = ocrThumbDivisor) -> Bool {
    guard thumb.width == previous.width, thumb.height == previous.height else {
        return true
    }

    let scale = Double(divisor)
    let x1 = Int((tile.minX / scale).rounded())
    let y1 = Int((tile.minY / scale).rounded())
    let x2 = max(Int((tile.maxX / scale).rounded()), x1 + 1)
    let y2 = max(Int((tile.maxY / scale).rounded()), y1 + 1)
    guard x1 >= 0, y1 >= 0, x2 <= thumb.width, y2 <= thumb.height else {
        return true
    }

    var total = 0
    var peak = 0
    for y in y1..<y2 {
        for x in x1..<x2 {
            let difference = abs(Int(thumb[x, y]) - Int(previous[x, y]))
            total += difference
            peak = max(peak, difference)
        }
    }
    return Double(total) / Double((x2 - x1) * (y2 - y1)) > ocrTileDiff || peak > ocrTilePeakDiff
}

public func ocrChangedTiles(_ thumb: GrayImage, _ previous: GrayImage, tiles: [CGRect]) -> [CGRect] {
    tiles.filter { ocrTileChanged(thumb, previous, tile: $0) }
}

/// The changed tiles grouped into blobs that touch along a side or at a corner, in the order their
/// first tile appears. Scattered change is the ordinary case (a clock ticks while one panel
/// repaints), and one box around both would span the window and force a full read.
public func ocrTileClusters(_ changed: [CGRect], tile: Double = ocrTilePixels) -> [[CGRect]] {
    var parent = Array(changed.indices)
    func root(_ start: Int) -> Int {
        var index = start
        while parent[index] != index {
            parent[index] = parent[parent[index]]
            index = parent[index]
        }
        return index
    }

    for i in changed.indices {
        for j in changed.indices where j > i {
            if abs(changed[i].minX - changed[j].minX) <= 1.5 * tile, abs(changed[i].minY - changed[j].minY) <= 1.5 * tile {
                parent[root(i)] = root(j)
            }
        }
    }
    var order: [Int] = []
    var blobs: [Int: [CGRect]] = [:]
    for (index, box) in changed.enumerated() {
        let key = root(index)
        if blobs[key] == nil {
            order.append(key)
        }
        blobs[key, default: []].append(box)
    }
    return order.compactMap { blobs[$0] }
}

/// Overlapping, or meeting along an edge or at a corner: worth reading as one rectangle.
public func ocrBoxesTouch(_ a: CGRect, _ b: CGRect) -> Bool {
    a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

/// A real overlap; sharing an edge does not count.
public func ocrBoxesIntersect(_ a: CGRect, _ b: CGRect) -> Bool {
    a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
}

private func ocrArea(_ box: CGRect) -> Double {
    max(0, box.width) * max(0, box.height)
}

private func ocrUnion(_ a: CGRect, _ b: CGRect) -> CGRect {
    let x1 = min(a.minX, b.minX)
    let y1 = min(a.minY, b.minY)
    return CGRect(x: x1, y: y1, width: max(a.maxX, b.maxX) - x1, height: max(a.maxY, b.maxY) - y1)
}

private func ocrBox(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> CGRect {
    CGRect(x: x1, y: y1, width: x2 - x1, height: y2 - y1)
}

/// One blob's bounding box, padded by a tile so a line crossing its edge is read whole, clamped.
private func ocrBlobRect(_ blob: [CGRect], region: CGRect, tile: Double) -> CGRect {
    ocrBox(max(region.minX, blob.map(\.minX).min()! - tile), max(region.minY, blob.map(\.minY).min()! - tile),
           min(region.maxX, blob.map(\.maxX).max()! + tile), min(region.maxY, blob.map(\.maxY).max()! + tile))
}

/// The rectangle grown until no known line straddles its edge, clamped to the region. Vision reads
/// the visible half of a cut line as a line of its own, so a larger read is the cheaper mistake.
public func ocrGrownForLines(_ rect: CGRect, lines: [CGRect], region: CGRect) -> CGRect {
    var current = rect
    var growing = true
    while growing {
        growing = false
        for line in lines where ocrBoxesIntersect(line, current) {
            let grown = ocrBox(max(region.minX, min(current.minX, line.minX)), max(region.minY, min(current.minY, line.minY)),
                               min(region.maxX, max(current.maxX, line.maxX)), min(region.maxY, max(current.maxY, line.maxY)))
            if grown != current {
                current = grown
                growing = true
            }
        }
    }
    return current
}

/// Every overlapping or touching pair replaced by the box around both, until none touch.
public func ocrMergeTouching(_ rects: [CGRect]) -> [CGRect] {
    var out = rects
    var merged = true
    while merged {
        merged = false
        search: for i in out.indices {
            for j in out.indices where j > i && ocrBoxesTouch(out[i], out[j]) {
                out = [ocrUnion(out[i], out[j])] + out.enumerated().filter { $0.offset != i && $0.offset != j }.map(\.element)
                merged = true
                break search
            }
        }
    }
    return out
}

/// Grow past cut lines and merge what meets, to a fixed point: growing can push two rectangles
/// together, and a merged rectangle has edges that can cut a line neither original cut.
private func ocrSettled(_ start: [CGRect], lines: [CGRect], region: CGRect) -> [CGRect] {
    var rects = start
    while true {
        let grown = rects.map { ocrGrownForLines($0, lines: lines, region: region) }
        let merged = ocrMergeTouching(grown)
        if grown == rects && merged == grown {
            return merged
        }
        rects = merged
    }
}

private func ocrGap(_ a: CGRect, _ b: CGRect) -> Double {
    let dx = max(0, max(a.minX, b.minX) - min(a.maxX, b.maxX))
    let dy = max(0, max(a.minY, b.minY) - min(a.maxY, b.maxY))
    return (dx * dx + dy * dy).squareRoot()
}

/// The rectangles to read again, one Vision call each; empty when nothing changed. One per blob of
/// changed tiles, grown past known lines, touching ones merged, and brought down to `limit` by
/// merging the closest pair.
public func ocrReocrRects(changed: [CGRect], region: CGRect, lines: [CGRect], limit: Int = ocrMaxReocrRects,
                          tile: Double = ocrTilePixels) -> [CGRect] {
    var rects = ocrSettled(ocrTileClusters(changed, tile: tile).map { ocrBlobRect($0, region: region, tile: tile) },
                           lines: lines, region: region)
    while rects.count > limit {
        var best = (gap: Double.infinity, i: 0, j: 1)
        for i in rects.indices {
            for j in rects.indices where j > i {
                let gap = ocrGap(rects[i], rects[j])
                if gap < best.gap {
                    best = (gap, i, j)
                }
            }
        }
        let rest = rects.enumerated().filter { $0.offset != best.i && $0.offset != best.j }.map(\.element)
        rects = ocrSettled([ocrUnion(rects[best.i], rects[best.j])] + rest, lines: lines, region: region)
    }
    return rects
}

/// One line of OCR text in source (capture) pixels, as one read returns it.
public struct OcrText: Equatable {
    public let text: String
    public let confidence: Double
    public let source: CGRect

    public init(text: String, confidence: Double, source: CGRect) {
        self.text = text
        self.confidence = confidence
        self.source = source
    }
}

/// A line kept in the cache: the text, and the hash of the exact gray pixels it was read from.
public struct OcrLine: Codable, Equatable {
    public let text: String
    public let confidence: Double
    public let source: VisualRect
    public let pixelHash: String

    public init(text: String, confidence: Double, source: VisualRect, pixelHash: String) {
        self.text = text
        self.confidence = confidence
        self.source = source
        self.pixelHash = pixelHash
    }
}

/// Hash of the gray pixels under a line, its whole-pixel bounds included. A reused line must still
/// sit on byte-identical pixels, so the text it claims is text the NEW capture shows there.
public func ocrLinePixelHash(_ image: GrayImage, _ rect: CGRect) -> String {
    let x1 = max(0, Int(rect.minX.rounded(.down)))
    let y1 = max(0, Int(rect.minY.rounded(.down)))
    let x2 = min(image.width, Int(rect.maxX.rounded(.up)))
    let y2 = min(image.height, Int(rect.maxY.rounded(.up)))
    var hasher = SHA256()
    hasher.update(data: Data("\(x1),\(y1),\(x2),\(y2);".utf8))
    if x2 > x1, y2 > y1 {
        image.pixels.withUnsafeBytes { raw in
            for y in y1..<y2 {
                let start = y * image.bytesPerRow + x1
                hasher.update(bufferPointer: UnsafeRawBufferPointer(rebasing: raw[start..<(start + x2 - x1)]))
            }
        }
    }
    return hasher.finalize().prefix(12).map { String(format: "%02x", $0) }.joined()
}

/// Previous lines no re-read rectangle touches, then every line just read inside them.
public func ocrMergeReocr(previous: [OcrLine], fresh: [OcrLine], rects: [CGRect]) -> [OcrLine] {
    previous.filter { line in !rects.contains { ocrBoxesIntersect(line.source.cgRect, $0) } } + fresh
}

/// What makes a cached read reusable: the same app instance, window, geometry and read transform.
public struct OcrReuseKey: Codable, Equatable {
    public let pid: Int32
    public let launch: Double
    public let windowID: Int
    public let bounds: VisualRect
    public let crop: VisualRect
    public let sourceWidth: Int
    public let sourceHeight: Int
    public let processedWidth: Int
    public let processedHeight: Int

    public init(pid: Int32, launch: Double, windowID: Int, bounds: VisualRect, transform: VisualTransform) {
        self.pid = pid
        self.launch = launch
        self.windowID = windowID
        self.bounds = bounds
        self.crop = transform.crop
        self.sourceWidth = transform.sourceWidth
        self.sourceHeight = transform.sourceHeight
        self.processedWidth = transform.processedWidth
        self.processedHeight = transform.processedHeight
    }
}

/// The previous capture's thumbnail and OCR lines, one file per caller session.
public struct OcrReuseCache: Codable {
    public static let currentVersion = 1
    public let version: Int
    public let key: OcrReuseKey
    public let thumbWidth: Int
    public let thumbHeight: Int
    public let thumb: Data
    public let lines: [OcrLine]

    public init(key: OcrReuseKey, thumb: GrayImage, lines: [OcrLine]) {
        self.version = Self.currentVersion
        self.key = key
        self.thumbWidth = thumb.width
        self.thumbHeight = thumb.height
        self.thumb = Data(thumb.pixels)
        self.lines = lines
    }

    var thumbImage: GrayImage? {
        GrayImage(width: thumbWidth, height: thumbHeight, bytesPerRow: thumbWidth, pixels: [UInt8](thumb))
    }
}

public enum OcrCacheState {
    case missing
    case unreadable
    case loaded(OcrReuseCache)
}

public func loadOcrReuseCache(path: String) -> OcrCacheState {
    guard FileManager.default.fileExists(atPath: path) else {
        return .missing
    }

    guard let data = FileManager.default.contents(atPath: path),
          let cache = try? JSONDecoder().decode(OcrReuseCache.self, from: data) else {
        return .unreadable
    }

    return .loaded(cache)
}

/// Written to a private temporary file beside the target and renamed over it, so a reader sees the
/// old cache or the new one, never half of either. Owner-only: the file holds text from the screen.
public func writeOcrReuseCache(_ cache: OcrReuseCache, path: String) throws {
    let data = try JSONEncoder().encode(cache)
    let temporary = path + ".tmp-\(getpid())-\(UUID().uuidString)"
    guard FileManager.default.createFile(atPath: temporary, contents: data, attributes: [.posixPermissions: 0o600]) else {
        throw VisualCaptureError.invalid("cannot write the OCR reuse cache beside \(path)")
    }
    guard rename(temporary, path) == 0 else {
        let code = errno
        unlink(temporary)
        throw VisualCaptureError.invalid("cannot replace the OCR reuse cache at \(path) (errno \(code))")
    }
}

/// What one read did, reported as `ocrReuse` beside the regions.
public struct OcrReuseReport: Equatable {
    /// "full", "partial", or "unchanged" (nothing changed, nothing read).
    public let mode: String
    /// Why a read was full: no_cache, unreadable, key_changed, too_much_changed, rects_too_large.
    public let reason: String?
    public let rects: Int
    /// Share of the read region's area handed to Vision.
    public let readFraction: Double

    public var dictionary: [String: Any] {
        var out: [String: Any] = ["mode": mode, "rects": rects, "readFraction": (readFraction * 1000).rounded() / 1000]
        if let reason {
            out["reason"] = reason
        }

        return out
    }
}

/// The lines of this capture inside `region`, reading as little as the previous capture allows.
///
/// `read` OCRs one rectangle of the capture and returns lines in capture pixels. Any key mismatch
/// or unreadable cache is a full read: a partial one never crosses an app, window, geometry or
/// transform change. A previous line is kept only when no re-read rectangle touches it, and its own
/// pixels are byte-identical in this capture; a line whose pixels moved marks its tiles changed.
public func readOcrLines(state: OcrCacheState, key: OcrReuseKey, image: GrayImage, region: CGRect,
                         read: (CGRect) throws -> [OcrText]) throws
    -> (lines: [OcrLine], thumb: GrayImage, report: OcrReuseReport) {
    let thumb = ocrThumbnail(image)
    func bound(_ texts: [OcrText]) -> [OcrLine] {
        texts.map { OcrLine(text: $0.text, confidence: $0.confidence, source: VisualRect($0.source),
                            pixelHash: ocrLinePixelHash(image, $0.source)) }
    }
    func full(_ reason: String) throws -> (lines: [OcrLine], thumb: GrayImage, report: OcrReuseReport) {
        (bound(try read(region)), thumb, OcrReuseReport(mode: "full", reason: reason, rects: 0, readFraction: 1))
    }

    let cache: OcrReuseCache
    switch state {
    case .missing: return try full("no_cache")
    case .unreadable: return try full("unreadable")
    case .loaded(let loaded): cache = loaded
    }
    guard cache.version == OcrReuseCache.currentVersion, let previous = cache.thumbImage,
          previous.width == thumb.width, previous.height == thumb.height else {
        return try full("unreadable")
    }
    guard cache.key == key else {
        return try full("key_changed")
    }

    let tiles = ocrTiles(in: region)
    let moved = cache.lines.filter { ocrLinePixelHash(image, $0.source.cgRect) != $0.pixelHash }.map(\.source.cgRect)
    let changed = tiles.filter { tile in
        ocrTileChanged(thumb, previous, tile: tile) || moved.contains { ocrBoxesIntersect($0, tile) }
    }
    guard Double(changed.count) <= ocrReocrFraction * Double(tiles.count) else {
        return try full("too_much_changed")
    }

    let rects = ocrReocrRects(changed: changed, region: region, lines: cache.lines.map(\.source.cgRect))
    if rects.isEmpty {
        return (cache.lines, thumb, OcrReuseReport(mode: "unchanged", reason: nil, rects: 0, readFraction: 0))
    }

    let readArea = rects.reduce(0) { $0 + ocrArea($1) }
    guard readArea <= ocrReocrFraction * ocrArea(region) else {
        return try full("rects_too_large")
    }

    var fresh: [OcrLine] = []
    for rect in rects {
        fresh += bound(try read(rect))
    }
    return (ocrMergeReocr(previous: cache.lines, fresh: fresh, rects: rects), thumb,
            OcrReuseReport(mode: "partial", reason: nil, rects: rects.count, readFraction: readArea / ocrArea(region)))
}
