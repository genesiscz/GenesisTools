import CoreImage
import Foundation

/// fx B (round 4): a hidden part that follows its text (keyframes from `hideText` / `hidePrivate`, OCR on the TypeScript
/// side) and the areas it leaves visible (a toast or a tab bar that stays still over a scrolling list).
enum RedactionTrack {
    /// The rectangle at a source time: between two keyframes it moves straight from one to the next. Before the first
    /// and after the last it keeps the speed of the nearest two (the text was already scrolling in when OCR first read
    /// it whole, and still scrolling out after the last read), so the part covers the text in its first and last
    /// moments too; a single keyframe holds. A part without keyframes keeps its own rectangle.
    static func placed(_ redaction: EditProject.Redaction, atSourceUs us: Int64) -> EditProject.Redaction {
        guard let keys = redaction.track, !keys.isEmpty else { return redaction }
        var moved = redaction
        let box: EditProject.TrackKey
        if keys.count == 1 {
            box = keys[0]
        } else {
            var low = 0, high = keys.count - 1
            if us <= keys[0].atUs {
                high = 1
            } else if us >= keys[keys.count - 1].atUs {
                low = keys.count - 2
            } else {
                while high - low > 1 {
                    let mid = (low + high) / 2
                    if keys[mid].atUs <= us { low = mid } else { high = mid }
                }
            }
            let a = keys[low], b = keys[high]
            let f = b.atUs > a.atUs ? Double(us - a.atUs) / Double(b.atUs - a.atUs) : 0
            box = EditProject.TrackKey(atUs: us, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f,
                                       width: a.width + (b.width - a.width) * f, height: a.height + (b.height - a.height) * f)
        }
        moved.x = box.x
        moved.y = box.y
        moved.width = box.width
        moved.height = box.height
        return moved
    }

    /// Puts the original picture back over the parts of each hiding rectangle its `exclude` areas cover, but only where
    /// no other hiding part covers them without excluding them too (R8 9: a tracked line's excluded bar showed sharp text
    /// through a band that hid the whole screen).
    static func leaveVisible(_ redactions: [EditProject.Redaction], original: CIImage, on image: CIImage) -> CIImage {
        let extent = original.extent
        let rect = { (x: Double, y: Double, width: Double, height: Double) in
            CGRect(x: extent.minX + x * extent.width, y: extent.minY + (1 - y - height) * extent.height,
                   width: width * extent.width, height: height * extent.height)
        }
        let parts: [(hidden: CGRect, holes: [CGRect])] = redactions.filter { $0.style != .spotlight }.map { redaction in
            let hidden = rect(redaction.x, redaction.y, redaction.width, redaction.height).integral
            let holes = (redaction.exclude ?? []).compactMap { area -> CGRect? in
                // Inward to whole pixels, so an edge pixel of the text never shows.
                let r = rect(area.x, area.y, area.width, area.height)
                let hole = CGRect(x: ceil(r.minX), y: ceil(r.minY), width: floor(r.maxX) - ceil(r.minX),
                                  height: floor(r.maxY) - ceil(r.minY)).intersection(hidden)
                return hole.isNull || hole.width < 1 || hole.height < 1 ? nil : hole
            }
            return (hidden, holes)
        }
        var result = image
        for (index, part) in parts.enumerated() {
            var pieces = part.holes
            for (other, cover) in parts.enumerated() where other != index {
                pieces = pieces.flatMap { piece -> [CGRect] in
                    let inside = piece.intersection(cover.hidden)
                    guard !inside.isNull, inside.width >= 1, inside.height >= 1 else { return [piece] }
                    let open = cover.holes.map { $0.intersection(inside) }.filter { !$0.isNull && $0.width >= 1 && $0.height >= 1 }
                    return subtract(cover.hidden, from: piece) + open
                }
            }
            for piece in pieces {
                result = original.cropped(to: piece).composited(over: result)
            }
        }
        return result
    }

    /// `rect` without `cut`: up to four rectangles (below, above, left and right of their overlap).
    static func subtract(_ cut: CGRect, from rect: CGRect) -> [CGRect] {
        let overlap = rect.intersection(cut)
        guard !overlap.isNull, overlap.width > 0, overlap.height > 0 else { return [rect] }
        return [
            CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: overlap.minY - rect.minY),
            CGRect(x: rect.minX, y: overlap.maxY, width: rect.width, height: rect.maxY - overlap.maxY),
            CGRect(x: rect.minX, y: overlap.minY, width: overlap.minX - rect.minX, height: overlap.height),
            CGRect(x: overlap.maxX, y: overlap.minY, width: rect.maxX - overlap.maxX, height: overlap.height),
        ].filter { $0.width >= 1 && $0.height >= 1 }
    }
}
