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
    /// `characters` characters (the karaoke caption's words said so far). `visible` shows only the first that many
    /// characters (a typewriter's typed letters), each where the whole text sets it, on the part of the plate round
    /// them; that image's extent is the part's place on the whole plate, so it draws where the whole plate would.
    func plate(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight = .semibold, plain: Bool = false,
               highlight: (characters: Int, color: NSColor)? = nil, visible: Int? = nil,
               alignment: NSTextAlignment = .center) -> CIImage? {
        // A count that shows every character is the whole plate.
        let visible = visible.flatMap { $0 < text.count ? max(0, $0) : nil }
        let key = "\(text)|\(Int(fontSize))|\(Int(maxWidth))|\(weight.rawValue)|\(plain)|\(highlight.map { "\($0.characters)\($0.color)" } ?? "")|\(visible.map(String.init) ?? "")|\(alignment.rawValue)"
        lock.lock()
        if let cached = images.value(for: key) {
            lock.unlock()
            return cached
        }
        lock.unlock()
        guard let image = Self.render(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight, plain: plain,
                                      highlight: highlight, visible: visible, alignment: alignment) else { return nil }
        lock.lock()
        images.set(image, for: key)
        lock.unlock()
        return image
    }

    /// The size `plate` makes for this text, from the same layout it draws but without drawing, so a preview overlay
    /// knows where the plate lands (Looks.textPlateRect). The colours (`plain`, `highlight`) never change the size.
    static func measure(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight = .semibold,
                        alignment: NSTextAlignment = .center) -> CGSize? {
        layout(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight, highlight: nil, visible: nil, alignment: alignment)?.size
    }

    /// The margin between a plate's edge and its letters: 0.7 of the font size at each side, 0.38 above and below. A plain
    /// text draws no plate, so its margin is empty space round its letters (Looks.textOrigin lines up its letters).
    static func inset(fontSize: CGFloat) -> CGSize {
        CGSize(width: fontSize * 0.7, height: fontSize * 0.38)
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
                               highlight: (characters: Int, color: NSColor)?, visible: Int?, alignment: NSTextAlignment) -> Layout? {
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
        // A typewriter's letters not typed yet keep their room, so the typed ones sit where the whole text sets them.
        if let visible, visible < text.count {
            let start = text.index(text.startIndex, offsetBy: max(0, visible))
            attributed.addAttribute(.foregroundColor, value: NSColor.clear, range: NSRange(start..<text.endIndex, in: text))
        }
        let inset = Self.inset(fontSize: fontSize)
        let bounds = attributed.boundingRect(with: CGSize(width: max(fontSize * 4, maxWidth - 2 * inset.width), height: .greatestFiniteMagnitude),
                                             options: [.usesLineFragmentOrigin, .usesFontLeading])
        let size = CGSize(width: ceil(bounds.width + 2 * inset.width), height: ceil(bounds.height + 2 * inset.height))
        guard size.width > 2, size.height > 2 else { return nil }
        return Layout(attributed: attributed, inset: inset, textHeight: bounds.height, size: size)
    }

    private static func render(_ text: String, fontSize: CGFloat, maxWidth: CGFloat, weight: NSFont.Weight, plain: Bool,
                               highlight: (characters: Int, color: NSColor)?, visible: Int?, alignment: NSTextAlignment) -> CIImage? {
        guard let layout = layout(text, fontSize: fontSize, maxWidth: maxWidth, weight: weight, highlight: highlight, visible: visible,
                                  alignment: alignment) else { return nil }
        let size = layout.size
        // The part of the plate drawn: all of it, or the part round a typewriter's typed letters.
        var box = CGRect(origin: .zero, size: size)
        if let visible {
            guard let typed = typedBox(layout, visible: visible) else { return nil }
            box = typed
        }
        guard let context = CGContext(data: nil, width: Int(box.width), height: Int(box.height), bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // Drawn in the whole plate's space, so each letter lands on the pixels it has on the whole plate.
        context.translateBy(x: -box.minX, y: -box.minY)
        let plate = CGPath(roundedRect: box, cornerWidth: fontSize * 0.45, cornerHeight: fontSize * 0.45, transform: nil)
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
        guard let image = context.makeImage().map({ CIImage(cgImage: $0) }) else { return nil }
        return box.origin == .zero ? image : image.transformed(by: CGAffineTransform(translationX: box.minX, y: box.minY))
    }

    /// The part of a plate round its first `visible` characters, in the plate's pixels (lower-left origin): the typed
    /// letters of each line where the whole text sets them, with the plate's margin round them, out to whole pixels.
    /// Nil when nothing is typed.
    private static func typedBox(_ layout: Layout, visible: Int) -> CGRect? {
        let text = layout.attributed.string
        guard visible > 0 else { return nil }
        let typed = NSRange(text.startIndex..<text.index(text.startIndex, offsetBy: min(visible, text.count)), in: text)
        // The box render draws the text in, laid out as attributed.draw lays it out there.
        let container = NSTextContainer(size: CGSize(width: layout.size.width - 2 * layout.inset.width, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        let manager = NSLayoutManager()
        manager.usesFontLeading = true
        manager.addTextContainer(container)
        let storage = NSTextStorage(attributedString: layout.attributed)
        storage.addLayoutManager(manager)
        let glyphs = manager.glyphRange(forCharacterRange: typed, actualCharacterRange: nil)
        var letters = CGRect.null
        manager.enumerateLineFragments(forGlyphRange: glyphs) { line, used, _, lineGlyphs, _ in
            // Typing runs from the start, so a line's typed glyphs are its first ones; they end where the next one starts.
            let start = line.minX + manager.location(forGlyphAt: lineGlyphs.location).x
            let end = NSMaxRange(glyphs) < NSMaxRange(lineGlyphs) ? line.minX + manager.location(forGlyphAt: NSMaxRange(glyphs)).x : used.maxX
            letters = letters.union(CGRect(x: start, y: used.minY, width: max(0, end - start), height: used.height))
        }
        guard !letters.isNull else { return nil }
        // The container runs down from the text's top, which render draws at inset.height + textHeight.
        let top = layout.inset.height + layout.textHeight
        let minX = max(0, letters.minX.rounded(.down))
        let maxX = min(layout.size.width, (letters.maxX + 2 * layout.inset.width).rounded(.up))
        let minY = max(0, (top - letters.maxY - layout.inset.height).rounded(.down))
        let maxY = min(layout.size.height, (top - letters.minY + layout.inset.height).rounded(.up))
        return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

extension Looks {
    /// A text note in its block (textOrigin, kept inside the canvas), faded by `opacity`. `sinceUs` (how long it has
    /// played since its first shown frame, ZoomState.texts) drives its `animate`: a typewriter shows the letters typed so
    /// far, each where it rests in the whole text, on a plate that grows round them; a slide-up rises into place while it
    /// fades in (TextMotion in Overlays.swift). Before 2026-11-09 the typed letters were set as a text of their own, so a
    /// centred or right-aligned line slid sideways while a later line typed and then jumped into place.
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
            guard let typed = plates.plate(note.text, fontSize: style.fontSize, maxWidth: style.wrap, weight: .semibold,
                                           plain: note.style == .plain, visible: motion.characters, alignment: style.alignment)
            else { return image }
            plate = typed
        }
        let shown = opacity * motion.opacity
        if shown < 0.999 {
            plate = plate.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(shown))])
        }
        // Placed by the full text's plate at rest (textPlateRect, where the editor's grip sits). A typed plate is a part
        // of the full one and its extent keeps that part's place, and a risen one lands where it rests.
        let rest = textPlateRect(note, plate: full.extent.size, size: size)
        let top = rest.maxY - full.extent.height - motion.drop * rest.height
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

    /// The lower-left corner (Core Image space) of a text's plate of size `plate` on a canvas of `size`. `x`, `y` is the
    /// centre of the text's block: a centred text is centred on it, and a left- or right-aligned one lines up what a
    /// viewer sees of it at the block's left or right edge, so texts with the same x and block line up. A plate text
    /// lines up its plate and keeps it inside the canvas. A plain text draws no plate, only its letters, so it lines up
    /// its letters (the plate's edge less its inset) and keeps them inside the canvas; its plate reaches past the edge by
    /// the inset, which nobody sees. Before 2026-11-09 a plain text lined up its plate too, so a 0.06 title and a 0.035
    /// subtitle in one left-aligned block had their letters 20 px apart at 1080p. check.ts `textBoxes` estimates the
    /// same boxes for `check()`.
    static func textOrigin(_ note: EditProject.TextNote, plate: CGSize, size: CGSize) -> CGPoint {
        let centre = CGFloat(note.x) * size.width
        let block = textBlockWidth(note, canvasWidth: size.width)
        // How far inside the plate the edge that lines up lies: the plate's own edge, or a plain text's letters.
        let edge = note.style == .plain ? TextPlates.inset(fontSize: textPlateStyle(note, size: size).fontSize).width : 0
        let left: CGFloat = switch note.block?.align ?? .center {
        case .left: centre - block / 2 - edge
        case .center: centre - plate.width / 2
        case .right: centre + block / 2 - plate.width + edge
        }
        let x = min(max(-edge, left), max(-edge, size.width - plate.width + edge))
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
    /// picture, the height the plate takes from its edge (so the keys overlay can sit beside it) and the plate's rect.
    /// `avoid` is the camera bubble's square while it shows (Core Image space). A plate that would run under it wraps
    /// short of it, one gap (0.015 of the short side) before its near edge; when that leaves less than 0.45 of the width
    /// (a phone-portrait canvas, a custom bubble near the middle) the plate lifts above the bubble instead. check.ts
    /// `captionLiftIssue` names the lift case.
    static func drawCaption(_ line: CaptionTrack.Line, track: CaptionTrack, settings: EditProject.Captions, on image: CIImage,
                            size: CGSize, highlight: (characters: Int, color: NSColor)? = nil,
                            avoid: CGRect? = nil) -> (image: CIImage, used: CGFloat, plate: CGRect?) {
        let unit = min(size.width, size.height)
        let fontSize = max(8, (settings.size * unit).rounded())
        guard var plate = track.image(for: line, fontSize: fontSize, maxWidth: size.width * 0.86, highlight: highlight) else { return (image, 0, nil) }
        let margin = unit * 0.05
        let top = settings.position == .top
        func placed(_ plate: CIImage) -> CGRect {
            let y = top ? size.height - margin - plate.extent.height : margin
            return CGRect(x: ((size.width - plate.extent.width) / 2).rounded(), y: y.rounded(),
                          width: plate.extent.width, height: plate.extent.height)
        }
        var rect = placed(plate)
        var lifted = false
        if let avoid, rect.intersects(avoid) {
            let gap = unit * 0.015
            let half = avoid.midX >= size.width / 2 ? avoid.minX - gap - size.width / 2 : size.width / 2 - avoid.maxX - gap
            let room = (2 * half).rounded(.down)
            if room >= size.width * 0.45,
               let narrow = track.image(for: line, fontSize: fontSize, maxWidth: room, highlight: highlight),
               !placed(narrow).intersects(avoid) {
                plate = narrow
                rect = placed(narrow)
            } else {
                let y = top ? avoid.minY - gap - plate.extent.height : avoid.maxY + gap
                rect.origin.y = min(max(0, y), size.height - plate.extent.height).rounded()
                lifted = true
            }
        }
        let drawn = plate.transformed(by: CGAffineTransform(translationX: rect.minX, y: rect.minY)).composited(over: image)
        let used = lifted ? (top ? size.height - rect.minY : rect.maxY) : margin + plate.extent.height
        return (drawn, used, rect)
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
