import AppKit
import CoreImage

/// fx B (round 4): the "⏩ 6x" badge drawn while a sped-up part plays (EditProject.AutoSpeed, the `speedUpWaits` and
/// `autoSpeed` ops in src/utils/recording-editor/project.ts). It shows over every clip at 1.5x or faster, in a corner
/// of the output, and fades in and out over 0.15 s at the clip's edges.
enum SpeedBadge {
    /// Slower parts get no badge: a 1.25x trim is not a speed-up a viewer needs told about.
    static let minimumSpeed = 1.5
    static let fadeUs: Int64 = 150_000

    struct Mark: Equatable {
        var speed: Double
        var position: EditProject.SpeedBadgePosition
        var opacity: Double
    }

    /// The badge at an output time: the clip playing then, when the badge is on and the clip is fast enough.
    static func badge(atOutput outUs: Int64, project: EditProject) -> Mark? {
        guard let auto = project.autoSpeed, auto.badge else { return nil }
        var start: Int64 = 0
        for clip in project.clips {
            let end = start + clip.outputDurationUs
            if outUs < end {
                guard clip.speed >= minimumSpeed else { return nil }
                let edge = Double(min(outUs - start, end - outUs))
                return Mark(speed: clip.speed, position: auto.position, opacity: max(0, min(1, edge / Double(fadeUs))))
            }
            start = end
        }
        return nil
    }

    /// "⏩ 6x", or "⏩ 2.5x" for a speed with a fraction.
    static func label(_ speed: Double) -> String {
        let rounded = (speed * 10).rounded() / 10
        let number = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
        return "⏩ \(number)x"
    }

    /// The badge's plate in its corner of the output, sized from the output's short side.
    static func draw(_ mark: Mark, plates: TextPlates, on image: CIImage, size: CGSize) -> CIImage {
        let unit = min(size.width, size.height)
        let fontSize = max(10, (unit * 0.042).rounded())
        guard var plate = plates.plate(label(mark.speed), fontSize: fontSize, maxWidth: size.width * 0.4, weight: .bold) else { return image }
        if mark.opacity < 0.999 {
            plate = plate.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(mark.opacity))])
        }
        let margin = (unit * 0.04).rounded()
        let right = mark.position == .topRight || mark.position == .bottomRight
        let top = mark.position == .topRight || mark.position == .topLeft
        // Core Image counts y from the bottom.
        let x = right ? size.width - margin - plate.extent.width : margin
        let y = top ? size.height - margin - plate.extent.height : margin
        return plate.transformed(by: CGAffineTransform(translationX: x.rounded(), y: y.rounded())).composited(over: image)
    }
}
