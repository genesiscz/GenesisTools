import AppKit
import CryptoKit
import Foundation
import SnapshotSupport

struct VisualPerceptionOptions {
    let ocr: Bool
    let crop: VisualRect?
    let width: Int?
}

func visualPerception(image: CGImage, png: Data, pid: pid_t, launch: Double, windowID: Int,
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
    if options?.ocr == true {
        guard let cropped = image.cropping(to: transform.crop.cgRect),
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw VisualCaptureError.invalid("cannot prepare the OCR image")
        }
        context.interpolationQuality = .high
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let processed = context.makeImage() else { throw VisualCaptureError.invalid("cannot render OCR image") }
        let blocks = runOCR(on: processed)["blocks"] as? [[String: Any]] ?? []
        for block in blocks {
            guard let text = block["text"] as? String, let confidence = block["confidence"] as? Double,
                  confidence >= 0.5, let px = block["px"] as? [String: Int],
                  let x = px["x"], let y = px["y"], let w = px["w"], let h = px["h"], w > 0, h > 0 else { continue }
            let source = try transform.sourceRect(VisualRect(x: Double(x), y: Double(y), width: Double(w), height: Double(h)))
            let screen = try transform.screenRect(source, window: VisualRect(bounds))
            if privateFrames.contains(where: { $0.intersects(screen.cgRect) }) { continue }
            let id = "v\(regions.count)"
            regions.append(VisualRegion(id: id, source: source))
            descriptions.append(["id": id, "text": String(text.prefix(500)), "confidence": confidence,
                "source": ["x": source.x, "y": source.y, "width": source.width, "height": source.height],
                "screen": ["x": screen.x, "y": screen.y, "width": screen.width, "height": screen.height]])
        }
        guard regions.count <= 200 else { throw VisualCaptureError.invalid("more than 200 OCR regions; use a smaller perception crop") }
    }
    let identity = VisualCaptureIdentity(pid: pid, launch: launch, windowID: windowID, bounds: VisualRect(bounds),
        created: capturedAt, pngHash: SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined(),
        pixelHash: try visualPixelHash(image), transform: transform, regions: regions)
    let encoded = try JSONEncoder().encode(identity)
    let metadata = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] ?? [:]
    return (identity, ["capture": metadata, "regions": descriptions, "method": options?.ocr == true ? "vision-ocr" : "screenshot",
        "coordinates": "region rects: `source` is screenshot pixels with a top-left origin, `screen` is global logical points, and `screen` is the frame act --coords takes", "expiresInSeconds": 30,
        "knownAxInputsExcluded": true])
}
