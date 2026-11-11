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

    /// The smallest share of the picture a moved part, or one of its keyframes, is wide or high (setRedaction's rule).
    static let minimumSide = 0.01

    /// The part put at `rect` (source fractions) where it shows at a source time. A part with keyframes moves every key
    /// by the change from the box it shows then and scales every key's size by the same ratio, each held inside the
    /// picture, and its own rectangle moves the same way, so it keeps its motion at the new place. setRedaction applies
    /// the same rule to a rect from the CLI (item-ops.ts movedKeys), measured from the stored rectangle; the window
    /// measures from the shown box, because a drag at a later key starts there. A part without keyframes takes `rect`.
    static func moved(_ redaction: EditProject.Redaction, to rect: CGRect, atSourceUs us: Int64) -> EditProject.Redaction {
        var moved = redaction
        guard let keys = redaction.track, !keys.isEmpty else {
            moved.x = rect.minX
            moved.y = rect.minY
            moved.width = rect.width
            moved.height = rect.height
            return moved
        }
        let shown = placed(redaction, atSourceUs: us)
        let dx = rect.minX - shown.x, dy = rect.minY - shown.y
        let scaleX = rect.width / max(shown.width, .ulpOfOne), scaleY = rect.height / max(shown.height, .ulpOfOne)
        let shift = { (x: Double, y: Double, width: Double, height: Double) in
            inPicture(x: x + dx, y: y + dy, width: width * scaleX, height: height * scaleY)
        }
        moved.track = keys.map { key in
            let box = shift(key.x, key.y, key.width, key.height)
            return EditProject.TrackKey(atUs: key.atUs, x: box.x, y: box.y, width: box.width, height: box.height)
        }
        let anchor = shift(redaction.x, redaction.y, redaction.width, redaction.height)
        moved.x = anchor.x
        moved.y = anchor.y
        moved.width = anchor.width
        moved.height = anchor.height
        return moved
    }

    /// Where the part shows at a source time, in source fractions: the box the window's controls show and move.
    static func shownRect(_ redaction: EditProject.Redaction, atSourceUs us: Int64) -> CGRect {
        let shown = placed(redaction, atSourceUs: us)
        return CGRect(x: shown.x, y: shown.y, width: shown.width, height: shown.height)
    }

    /// A box held inside the picture and at least 1 % wide and high, as setRedaction holds it (item-ops.ts inPicture).
    private static func inPicture(x: Double, y: Double, width: Double, height: Double) -> (x: Double, y: Double, width: Double, height: Double) {
        let width = min(1, max(minimumSide, width)), height = min(1, max(minimumSide, height))
        return (min(1 - width, max(0, x)), min(1 - height, max(0, y)), width, height)
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
