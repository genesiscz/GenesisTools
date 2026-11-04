import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

/// The looks an edit adds on top of the picture: click highlights (drawn on the source, so they zoom with it) and the
/// frame (the movie on a background with padding, rounded corners and a shadow, after the zoom). Pure functions of
/// an image and the project's settings, so the preview and the export draw the same thing.
enum Looks {
    /// One click to draw: where it was, 0...1 from the top left, and how far its animation has run, 0...1.
    struct ClickMark: Equatable {
        var x: Double
        var y: Double
        var progress: Double
    }

    /// The clicks whose animation runs at `sourceMs`: pressed at most `durationMs` before it.
    static func marks(atSourceMs ms: Double, clicks: [CursorTrack.Sample], durationMs: Int) -> [ClickMark] {
        let duration = Double(max(1, durationMs))
        return clicks.compactMap { click in
            let age = ms - click.ms
            guard age >= 0, age <= duration else { return nil }
            return ClickMark(x: click.x, y: click.y, progress: age / duration)
        }
    }

    /// A soft disc per mark that grows from 40 % to its full radius and fades out.
    static func drawClicks(_ marks: [ClickMark], on image: CIImage, settings: EditProject.Clicks) -> CIImage {
        guard settings.highlight, !marks.isEmpty else { return image }
        let extent = image.extent
        let color = Self.color(settings.color)
        var result = image
        for mark in marks {
            let grown = ZoomCurve.easeOut(mark.progress)
            let radius = settings.radius * extent.height * (0.4 + 0.6 * grown)
            let alpha = 0.55 * (1 - mark.progress)
            let center = CGPoint(x: extent.minX + mark.x * extent.width, y: extent.minY + (1 - mark.y) * extent.height)
            let gradient = CIFilter.radialGradient()
            gradient.center = center
            gradient.radius0 = Float(radius * 0.82)
            gradient.radius1 = Float(radius)
            gradient.color0 = CIColor(red: color.red, green: color.green, blue: color.blue, alpha: alpha)
            gradient.color1 = CIColor(red: color.red, green: color.green, blue: color.blue, alpha: 0)
            guard let disc = gradient.outputImage?.cropped(to: CGRect(x: center.x - radius, y: center.y - radius,
                                                                       width: radius * 2, height: radius * 2)) else { continue }
            result = disc.composited(over: result)
        }
        return result
    }

    /// The picture scaled in by the padding, masked to a rounded rectangle, over a shadow and the background. The
    /// output keeps `size`.
    static func applyFrame(_ frame: EditProject.Frame, to image: CIImage, size: CGSize) -> CIImage {
        let padding = frame.padding * size.height
        let scale = max(0.05, (size.height - 2 * padding) / size.height)
        let inner = CGRect(x: (size.width - size.width * scale) / 2, y: (size.height - size.height * scale) / 2,
                           width: size.width * scale, height: size.height * scale)
        let placed = image
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: inner.minX, y: inner.minY))
        let radius = frame.cornerRadius * size.height
        let mask = roundedRect(inner, radius: radius, color: .white)
        let clipped = placed.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: CIImage.empty(),
            kCIInputMaskImageKey: mask,
        ])
        var canvas = background(frame.background, size: size)
        if frame.shadow {
            let blur = size.height * 0.018
            let shadow = roundedRect(inner, radius: radius, color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.55))
                .transformed(by: CGAffineTransform(translationX: 0, y: -size.height * 0.008))
                .applyingGaussianBlur(sigma: blur)
            canvas = shadow.composited(over: canvas)
        }
        return clipped.composited(over: canvas).cropped(to: CGRect(origin: .zero, size: size))
    }

    static func background(_ background: EditProject.Background, size: CGSize) -> CIImage {
        let bounds = CGRect(origin: .zero, size: size)
        let colors = background.colors.map(Self.color)
        switch background.kind {
        case .none:
            return CIImage(color: .black).cropped(to: bounds)
        case .color:
            return CIImage(color: colors.first ?? .black).cropped(to: bounds)
        case .gradient:
            let gradient = CIFilter.linearGradient()
            // Top left to bottom right; Core Image counts y from the bottom.
            gradient.point0 = CGPoint(x: 0, y: size.height)
            gradient.point1 = CGPoint(x: size.width, y: 0)
            gradient.color0 = colors.first ?? .black
            gradient.color1 = colors.count > 1 ? colors[1] : (colors.first ?? .black)
            return (gradient.outputImage ?? CIImage(color: .black)).cropped(to: bounds)
        }
    }

    private static func roundedRect(_ rect: CGRect, radius: Double, color: CIColor) -> CIImage {
        let generator = CIFilter.roundedRectangleGenerator()
        generator.extent = rect
        generator.radius = Float(radius)
        generator.color = color
        return generator.outputImage ?? CIImage.empty()
    }

    /// `#RRGGBB`; anything else is white, so a bad value shows instead of vanishing.
    static func color(_ hex: String) -> CIColor {
        let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return .white }
        return CIColor(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                       blue: Double(value & 0xFF) / 255)
    }
}
