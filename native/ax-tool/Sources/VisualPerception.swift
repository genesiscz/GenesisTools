import AppKit
import CryptoKit
import Foundation
import SnapshotSupport

struct VisualPerceptionOptions {
    let ocr: Bool
    let crop: VisualRect?
    let width: Int?
    /// `--perception-reuse`: the cache file of the previous OCR read, so only changed regions are read.
    let reusePath: String?
}

func visualPerception(image: CGImage, png: Data, gray: GrayImage?, pid: pid_t, launch: Double, windowID: Int,
                      bounds: CGRect, capturedAt: Double, options: VisualPerceptionOptions?,
                      privateFrames: [CGRect]) throws -> (VisualCaptureIdentity, [String: Any]) {
    let crop = options?.crop
    let original = try VisualTransform(sourceWidth: image.width, sourceHeight: image.height, crop: crop)
    let width = options?.width ?? Int(original.crop.width)
    guard width > 0, width <= 16384 else { throw VisualCaptureError.invalid("perception width is invalid") }
    let scaledHeight = Double(width) * original.crop.height / original.crop.width
    guard scaledHeight.isFinite, scaledHeight >= 1, scaledHeight <= 16384 else {
        throw VisualCaptureError.invalid("processed image height is invalid")
    }
    let height = Int(scaledHeight.rounded())
    let transform = try VisualTransform(sourceWidth: image.width, sourceHeight: image.height, crop: crop,
                                        processedWidth: width, processedHeight: height)
    var regions: [VisualRegion] = []
    var descriptions: [[String: Any]] = []
    var reuseReport: [String: Any]?
    if options?.ocr == true {
        // Every rectangle is scaled like the whole crop, so a partial read sees text at the size a
        // full read would, and its lines map back to source pixels the same way.
        let scaleX = Double(width) / transform.crop.width
        let scaleY = Double(height) / transform.crop.height
        func read(_ rect: CGRect) throws -> [OcrText] {
            let x1 = rect.minX.rounded()
            let y1 = rect.minY.rounded()
            let source = CGRect(x: x1, y: y1, width: rect.maxX.rounded() - x1, height: rect.maxY.rounded() - y1)
            let outWidth = max(1, Int((source.width * scaleX).rounded()))
            let outHeight = max(1, Int((source.height * scaleY).rounded()))
            guard let cropped = image.cropping(to: source),
                  let context = CGContext(data: nil, width: outWidth, height: outHeight, bitsPerComponent: 8,
                    bytesPerRow: outWidth * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                throw VisualCaptureError.invalid("cannot prepare the OCR image")
            }
            context.interpolationQuality = .high
            context.draw(cropped, in: CGRect(x: 0, y: 0, width: outWidth, height: outHeight))
            guard let processed = context.makeImage() else { throw VisualCaptureError.invalid("cannot render OCR image") }
            let blocks = runOCR(on: processed)["blocks"] as? [[String: Any]] ?? []
            // Multiply before dividing, as VisualTransform.sourceRect does, so a full read maps
            // back to exactly the source rects it always produced.
            return blocks.compactMap { block in
                guard let text = block["text"] as? String, let confidence = block["confidence"] as? Double,
                      let px = block["px"] as? [String: Int],
                      let x = px["x"], let y = px["y"], let w = px["w"], let h = px["h"], w > 0, h > 0 else { return nil }
                return OcrText(text: text, confidence: confidence,
                               source: CGRect(x: source.minX + Double(x) * source.width / Double(outWidth),
                                              y: source.minY + Double(y) * source.height / Double(outHeight),
                                              width: Double(w) * source.width / Double(outWidth),
                                              height: Double(h) * source.height / Double(outHeight)))
            }
        }

        let region = transform.crop.cgRect
        let found: [OcrText]
        var cached: (path: String, key: OcrReuseKey, thumb: GrayImage, lines: [OcrLine])?
        if let path = options?.reusePath {
            guard let gray else { throw VisualCaptureError.invalid("cannot prepare the OCR reuse image") }
            let key = OcrReuseKey(pid: pid, launch: launch, windowID: windowID, bounds: VisualRect(bounds), transform: transform)
            let outcome = try readOcrLines(state: loadOcrReuseCache(path: path), key: key, image: gray, region: region, read: read)
            found = outcome.lines.map { OcrText(text: $0.text, confidence: $0.confidence, source: $0.source.cgRect) }
            cached = (path, key, outcome.thumb, outcome.lines)
            reuseReport = outcome.report.dictionary
        } else {
            found = try read(region)
        }
        // Reused lines are text found at these pixels in a capture whose pixels there are identical,
        // so they are bound to THIS capture exactly like fresh ones: same identity, same pixel hash.
        var kept: [OcrLine] = []
        for (index, line) in found.enumerated() where line.confidence >= 0.5 {
            let source = VisualRect(line.source)
            let screen = try transform.screenRect(source, window: VisualRect(bounds))
            if privateFrames.contains(where: { $0.intersects(screen.cgRect) }) { continue }
            if let cached { kept.append(cached.lines[index]) }
            let id = "v\(regions.count)"
            regions.append(VisualRegion(id: id, source: source))
            descriptions.append(["id": id, "text": String(line.text.prefix(500)), "confidence": line.confidence,
                "source": ["x": source.x, "y": source.y, "width": source.width, "height": source.height],
                "screen": ["x": screen.x, "y": screen.y, "width": screen.width, "height": screen.height]])
        }
        guard regions.count <= 200 else { throw VisualCaptureError.invalid("more than 200 OCR regions; use a smaller perception crop") }
        if let cached {
            // Only the lines this read returned are kept: text inside AX inputs never reaches the file.
            do {
                try writeOcrReuseCache(OcrReuseCache(key: cached.key, thumb: cached.thumb, lines: kept), path: cached.path)
            } catch {
                fputs("OCR reuse cache not written: \(error.localizedDescription)\n", stderr)
                reuseReport?["cacheError"] = error.localizedDescription
            }
        }
    }
    let identity = VisualCaptureIdentity(pid: pid, launch: launch, windowID: windowID, bounds: VisualRect(bounds),
        created: capturedAt, pngHash: SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined(),
        pixelHash: try visualPixelHash(image), transform: transform, regions: regions)
    let encoded = try JSONEncoder().encode(identity)
    let metadata = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] ?? [:]
    var result: [String: Any] = ["capture": metadata, "regions": descriptions, "method": options?.ocr == true ? "vision-ocr" : "screenshot",
        "coordinates": "region rects: `source` is screenshot pixels with a top-left origin, `screen` is global logical points, and `screen` is the frame act --coords takes", "expiresInSeconds": 30,
        "knownAxInputsExcluded": true]
    if let reuseReport {
        result["ocrReuse"] = reuseReport
    }

    return (identity, result)
}
