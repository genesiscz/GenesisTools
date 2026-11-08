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
        // R4 6 karaoke captions
        /// The start of each word in source time, when the transcription timed its words (`segments[].words`).
        var wordStartsUs: [Int64] = []
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
            // R4 6 karaoke captions: the words' own times, as cut-words reads them.
            let words = (segment["words"] as? [[String: Any]] ?? []).compactMap { ($0["start"] as? NSNumber)?.doubleValue }
            return Line(fromUs: Int64(start * 1_000_000), toUs: Int64(end * 1_000_000), text: text,
                        wordStartsUs: words.map { Int64($0 * 1_000_000) })
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
    func image(for line: Line, fontSize: CGFloat, maxWidth: CGFloat, highlight: (characters: Int, color: NSColor)? = nil) -> CIImage? {
        plates.plate(line.text, fontSize: fontSize, maxWidth: maxWidth, highlight: highlight)
    }
}

/// White text on a dark rounded plate, made once per text and size because every frame that shows it draws it.
/// Captions and the keys overlay use it; the render runs on Core Image's threads, so the cache has a lock.
/// Karaoke makes one plate per word said and a typewriter one per letter, so only the plates used last are kept.
final class TextPlates: @unchecked Sendable {
    static let kept = 64
    private let lock = NSLock()
    private var images = RecentCache<String, CIImage>(limit: TextPlates.kept)

    /// How many plates the cache holds now.
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return images.count
    }

    /// `plain`: no plate, the text with a soft shadow, for a title over a busy picture. `highlight` colours the first
    /// `characters` characters (the karaoke caption's words said so far).
    func plate(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight = .semibold, plain: Bool = false,
               highlight: (characters: Int, color: NSColor)? = nil, alignment: NSTextAlignment = .center) -> CIImage? {
        let key = "\(text)|\(Int(fontSize))|\(Int(maxWidth))|\(weight.rawValue)|\(plain)|\(highlight.map { "\($0.characters)\($0.color)" } ?? "")|\(alignment.rawValue)"
        lock.lock()
        if let cached = images.value(for: key) {
            lock.unlock()
            return cached
        }
        lock.unlock()
        guard let image = Self.render(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight, plain: plain,
                                      highlight: highlight, alignment: alignment) else { return nil }
        lock.lock()
        images.set(image, for: key)
        lock.unlock()
        return image
    }

    /// The size `plate` makes for this text, from the same layout it draws but without drawing, so a preview overlay
    /// knows where the plate lands (Looks.textPlateRect). The colours (`plain`, `highlight`) never change the size.
    static func measure(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight = .semibold,
                        alignment: NSTextAlignment = .center) -> CGSize? {
        layout(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight, highlight: nil, alignment: alignment)?.size
    }

    /// A text set on its plate: the styled string, its margin on the plate, the text's own height and the plate's size
    /// in whole pixels. `render` draws it and `measure` reads its size, so the two cannot disagree.
    private struct Layout {
        let attributed: NSAttributedString
        let inset: CGSize
        let textHeight: CGFloat
        let size: CGSize
    }

    /// Nil for a plate too small to draw.
    private static func layout(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight,
                               highlight: (characters: Int, color: NSColor)?, alignment: NSTextAlignment) -> Layout? {
        let paragraph = NSMutableParagraphStyle()
        // R5 10 multi-line texts: "\n" starts a line, a long line wraps at maxWidth, and the lines align as asked.
        paragraph.alignment = alignment
        let attributed = NSMutableAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
            .foregroundColor: NSColor.white,
            .paragraphStyle: paragraph,
        ])
        // R4 6 karaoke captions
        if let highlight, highlight.characters > 0 {
            let end = text.index(text.startIndex, offsetBy: min(highlight.characters, text.count))
            attributed.addAttribute(.foregroundColor, value: highlight.color, range: NSRange(text.startIndex..<end, in: text))
        }
        let inset = CGSize(width: fontSize * 0.7, height: fontSize * 0.38)
        let bounds = attributed.boundingRect(with: CGSize(width: max(fontSize * 4, maxWidth - 2 * inset.width), height: .greatestFiniteMagnitude),
                                             options: [.usesLineFragmentOrigin, .usesFontLeading])
        let size = CGSize(width: ceil(bounds.width + 2 * inset.width), height: ceil(bounds.height + 2 * inset.height))
        guard size.width > 2, size.height > 2 else { return nil }
        return Layout(attributed: attributed, inset: inset, textHeight: bounds.height, size: size)
    }

    private static func render(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight, plain: Bool,
                               highlight: (characters: Int, color: NSColor)?, alignment: NSTextAlignment) -> CIImage? {
        guard let layout = layout(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight, highlight: highlight, alignment: alignment),
              let context = CGContext(data: nil, width: Int(layout.size.width), height: Int(layout.size.height), bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let size = layout.size
        let plate = CGPath(roundedRect: CGRect(origin: .zero, size: size), cornerWidth: fontSize * 0.45, cornerHeight: fontSize * 0.45, transform: nil)
        if plain {
            context.setShadow(offset: CGSize(width: 0, height: -fontSize * 0.04), blur: fontSize * 0.25, color: CGColor(gray: 0, alpha: 0.85))
        } else {
            context.addPath(plate)
            context.setFillColor(CGColor(gray: 0, alpha: 0.72))
            context.fillPath()
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
        layout.attributed.draw(with: CGRect(x: layout.inset.width, y: layout.inset.height, width: size.width - 2 * layout.inset.width,
                                            height: layout.textHeight),
                               options: [.usesLineFragmentOrigin, .usesFontLeading])
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage().map { CIImage(cgImage: $0) }
    }
}

extension Looks {
    /// A text note in its block (textOrigin, kept inside the canvas), faded by `opacity`. `sinceUs` (source time since
    /// its start) drives its `animate`: a typewriter shows the letters typed so far from the full text's left edge, a
    /// slide-up rises into place while it fades in (TextMotion in Overlays.swift).
    static func drawText(_ note: EditProject.TextNote, opacity: Double, plates: TextPlates, on image: CIImage, size: CGSize,
                         sinceUs: Int64? = nil) -> CIImage {
        // R4 6 animated texts
        let motion = TextMotion.at(sinceUs: sinceUs, note: note)
        let style = textPlateStyle(note, size: size)
        guard let full = plates.plate(note.text, fontSize: style.fontSize, maxWidth: style.wrap, weight: .semibold,
                                      plain: note.style == .plain, alignment: style.alignment) else { return image }
        var plate = full
        if motion.characters < note.text.count {
            guard motion.characters > 0 else { return image }
            guard let typed = plates.plate(String(note.text.prefix(motion.characters)), fontSize: style.fontSize, maxWidth: style.wrap,
                                           weight: .semibold, plain: note.style == .plain, alignment: style.alignment) else { return image }
            plate = typed
        }
        let shown = opacity * motion.opacity
        if shown < 0.999 {
            plate = plate.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(shown))])
        }
        // Placed by the full text's plate at rest (textPlateRect, where the editor's grip sits), so a typed line grows
        // to the right and a risen one lands where it rests.
        let rest = textPlateRect(note, plate: full.extent.size, size: size)
        let top = rest.maxY - plate.extent.height - motion.drop * rest.height
        return plate.transformed(by: CGAffineTransform(translationX: rest.minX, y: top.rounded())).composited(over: image)
    }

    /// The font size, wrap width and line alignment a text's plate is made with on a canvas of `size`.
    static func textPlateStyle(_ note: EditProject.TextNote, size: CGSize) -> (fontSize: CGFloat, wrap: CGFloat, alignment: NSTextAlignment) {
        let unit = min(size.width, size.height)
        // R5 10 multi-line texts: the block's wrap width and line alignment.
        return (max(8, (note.size * unit).rounded()), textBlockWidth(note, canvasWidth: size.width), textAlignment(note.block?.align))
    }

    /// Where drawText puts a text's plate at rest on a canvas of `size`, in Core Image pixels (lower-left origin): its
    /// size from the plate's own layout (TextPlates.measure), placed by textOrigin and rounded to whole pixels as drawn.
    /// A typewriter's typed part and a slide-up still rising are drawn from this rest box. Nil when the text makes no
    /// plate (drawText then draws nothing). The editor's text grip sits on it (TextGrip).
    static func textPlateRect(_ note: EditProject.TextNote, size: CGSize) -> CGRect? {
        let style = textPlateStyle(note, size: size)
        guard let plate = TextPlates.measure(note.text, fontSize: style.fontSize, maxWidth: style.wrap, weight: .semibold,
                                             alignment: style.alignment) else { return nil }
        return textPlateRect(note, plate: plate, size: size)
    }

    /// The same for a plate of a known size.
    static func textPlateRect(_ note: EditProject.TextNote, plate: CGSize, size: CGSize) -> CGRect {
        let origin = textOrigin(note, plate: plate, size: size)
        return CGRect(origin: CGPoint(x: origin.x.rounded(), y: origin.y.rounded()), size: plate)
    }

    /// textPlateRect as a share of the canvas from its top left (y down), the space the editor's preview overlays draw in.
    static func textPlateUnitRect(_ note: EditProject.TextNote, canvas: CGSize) -> CGRect? {
        guard canvas.width >= 1, canvas.height >= 1, let rect = textPlateRect(note, size: canvas) else { return nil }
        return CGRect(x: rect.minX / canvas.width, y: (canvas.height - rect.maxY) / canvas.height,
                      width: rect.width / canvas.width, height: rect.height / canvas.height)
    }

    // R5 10 multi-line texts
    /// The block's width in pixels: `block.width` of the canvas's width (0.15 to 0.95, 0.8 when absent).
    static func textBlockWidth(_ note: EditProject.TextNote, canvasWidth: CGFloat) -> CGFloat {
        canvasWidth * CGFloat(min(0.95, max(0.15, note.block?.width ?? 0.8)))
    }

    /// The lower-left corner (Core Image space) of a text's plate of size `plate` on a canvas of `size`, kept inside it.
    /// `x`, `y` is the centre of the text's block: a centred plate is centred on it, a left-aligned plate starts at the
    /// block's left edge and a right-aligned one ends at its right edge, so texts with the same x and block line up.
    /// check.ts `textBox` estimates the same box for `check()`.
    static func textOrigin(_ note: EditProject.TextNote, plate: CGSize, size: CGSize) -> CGPoint {
        let centre = CGFloat(note.x) * size.width
        let block = textBlockWidth(note, canvasWidth: size.width)
        let left: CGFloat = switch note.block?.align ?? .center {
        case .left: centre - block / 2
        case .center: centre - plate.width / 2
        case .right: centre + block / 2 - plate.width
        }
        let x = min(max(0, left), max(0, size.width - plate.width))
        // The project counts y from the top; Core Image from the bottom.
        let y = min(max(0, (1 - note.y) * size.height - plate.height / 2), max(0, size.height - plate.height))
        return CGPoint(x: x, y: y)
    }

    static func textAlignment(_ align: EditProject.TextAlign?) -> NSTextAlignment {
        switch align ?? .center {
        case .left: .left
        case .center: .center
        case .right: .right
        }
    }

    /// The caption plate centred near the bottom (or the top) of the output, sized from its short side. Returns the
    /// picture and the height the plate takes from its edge, so the keys overlay can sit beside it.
    static func drawCaption(_ line: CaptionTrack.Line, track: CaptionTrack, settings: EditProject.Captions, on image: CIImage,
                            size: CGSize, highlight: (characters: Int, color: NSColor)? = nil) -> (image: CIImage, used: CGFloat) {
        let unit = min(size.width, size.height)
        let fontSize = max(8, (settings.size * unit).rounded())
        guard let plate = track.image(for: line, fontSize: fontSize, maxWidth: size.width * 0.86, highlight: highlight) else { return (image, 0) }
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
