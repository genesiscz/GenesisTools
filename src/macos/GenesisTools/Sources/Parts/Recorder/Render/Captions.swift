import AppKit
import CoreImage
import Foundation

/// The movie's spoken lines for the captions look: `<movie stem>.transcript.json` beside the movie, the raw result of
/// `tools transcribe --format json` that the REPL's `movie.transcript()` and the Style tab's Transcribe button cache.
/// Segment times are source seconds, so a cut never moves a caption.
final class CaptionTrack: @unchecked Sendable {
    struct Line: Equatable {
        var fromUs: Int64
        var toUs: Int64
        var text: String
    }

    let lines: [Line]
    private let plates = TextPlates()

    init(lines: [Line]) {
        self.lines = lines.sorted { $0.fromUs < $1.fromUs }
    }

    static func cacheURL(video: String) -> URL {
        let movie = URL(fileURLWithPath: video)
        return movie.deletingLastPathComponent().appendingPathComponent(movie.deletingPathExtension().lastPathComponent + ".transcript.json")
    }

    static func load(video: String) -> CaptionTrack? {
        guard let data = try? Data(contentsOf: cacheURL(video: video)),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let segments = root["segments"] as? [[String: Any]] else { return nil }
        let lines = segments.compactMap { segment -> Line? in
            guard let text = (segment["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
                  let start = (segment["start"] as? NSNumber)?.doubleValue, let end = (segment["end"] as? NSNumber)?.doubleValue,
                  end > start else { return nil }
            return Line(fromUs: Int64(start * 1_000_000), toUs: Int64(end * 1_000_000), text: text)
        }
        return lines.isEmpty ? nil : CaptionTrack(lines: lines)
    }

    /// The line spoken at the source time, if any.
    func line(atSourceUs us: Int64) -> Line? {
        var low = 0, high = lines.count
        while low < high {
            let mid = (low + high) / 2
            if lines[mid].fromUs <= us { low = mid + 1 } else { high = mid }
        }
        guard low > 0, lines[low - 1].toUs > us else { return nil }
        return lines[low - 1]
    }

    /// The line as a white text block on a dark rounded plate, wrapped to `maxWidth` pixels.
    func image(for line: Line, fontSize: CGFloat, maxWidth: CGFloat) -> CIImage? {
        plates.plate(line.text, fontSize: fontSize, maxWidth: maxWidth)
    }
}

/// White text on a dark rounded plate, made once per text and size because every frame that shows it draws it.
/// Captions and the keys overlay use it; the render runs on Core Image's threads, so the cache has a lock.
final class TextPlates: @unchecked Sendable {
    private let lock = NSLock()
    private var images: [String: CIImage] = [:]

    func plate(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight = .semibold) -> CIImage? {
        let key = "\(text)|\(Int(fontSize))|\(Int(maxWidth))|\(weight.rawValue)"
        lock.lock()
        if let cached = images[key] {
            lock.unlock()
            return cached
        }
        lock.unlock()
        guard let image = Self.render(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight) else { return nil }
        lock.lock()
        images[key] = image
        lock.unlock()
        return image
    }

    private static func render(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight) -> CIImage? {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let attributed = NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ])
        let inset = CGSize(width: fontSize * 0.7, height: fontSize * 0.38)
        let bounds = attributed.boundingRect(with: CGSize(width: max(fontSize * 4, maxWidth - 2 * inset.width), height: .greatestFiniteMagnitude),
                                             options: [.usesLineFragmentOrigin, .usesFontLeading])
        let size = CGSize(width: ceil(bounds.width + 2 * inset.width), height: ceil(bounds.height + 2 * inset.height))
        guard size.width > 2, size.height > 2,
              let context = CGContext(data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let plate = CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: fontSize * 0.45, cornerHeight: fontSize * 0.45, transform: nil)
        context.addPath(plate)
        context.setFillColor(CGColor(gray: 0, alpha: 0.72))
        context.fillPath()
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        attributed.draw(with: CGRect(x: inset.width, y: inset.height, width: size.width - 2 * inset.width, height: bounds.height),
                        options: [.usesLineFragmentOrigin, .usesFontLeading])
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage().map { CIImage(cgImage: $0) }
    }
}

extension Looks {
    /// The caption plate centred near the bottom (or the top) of the output, sized from its short side. Returns the
    /// picture and the height the plate takes from its edge, so the keys overlay can sit beside it.
    static func drawCaption(_ line: CaptionTrack.Line, track: CaptionTrack, settings: EditProject.Captions, on image: CIImage,
                            size: CGSize) -> (image: CIImage, used: CGFloat) {
        let unit = min(size.width, size.height)
        let fontSize = max(8, (settings.size * unit).rounded())
        guard let plate = track.image(for: line, fontSize: fontSize, maxWidth: size.width * 0.86) else { return (image, 0) }
        let margin = unit * 0.05
        let x = ((size.width - plate.extent.width) / 2).rounded()
        let y = settings.position == .top ? size.height - margin - plate.extent.height : margin
        let drawn = plate.transformed(by: CGAffineTransform(translationX: x, y: y.rounded())).composited(over: image)
        return (drawn, margin + plate.extent.height)
    }

    /// The shortcut pressed last, centred near its edge (above a caption on the same edge), fading out at its end.
    static func drawKey(_ label: String, opacity: Double, plates: TextPlates, settings: EditProject.Keys, on image: CIImage,
                        size: CGSize, below: CGFloat) -> CIImage {
        let unit = min(size.width, size.height)
        let fontSize = max(8, (settings.size * unit).rounded())
        guard var plate = plates.plate(label, fontSize: fontSize, maxWidth: size.width * 0.6, weight: .medium) else { return image }
        if opacity < 0.999 {
            plate = plate.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(opacity))])
        }
        let margin = unit * 0.05 + below + (below > 0 ? unit * 0.015 : 0)
        let x = ((size.width - plate.extent.width) / 2).rounded()
        let y = settings.position == .top ? size.height - margin - plate.extent.height : margin
        return plate.transformed(by: CGAffineTransform(translationX: x, y: y.rounded())).composited(over: image)
    }
}
