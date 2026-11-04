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

    /// Hides each rectangle with a blur, big pixels or black. The blur reads the picture clamped at the rectangle's
    /// edges, so nothing from outside bleeds in and its edge stays sharp.
    static func redact(_ redactions: [EditProject.Redaction], on image: CIImage) -> CIImage {
        guard !redactions.isEmpty else { return image }
        let extent = image.extent
        var result = image
        for redaction in redactions {
            let rect = CGRect(x: extent.minX + redaction.x * extent.width,
                              y: extent.minY + (1 - redaction.y - redaction.height) * extent.height,
                              width: redaction.width * extent.width, height: redaction.height * extent.height).integral
                .intersection(extent)
            guard rect.width > 1, rect.height > 1 else { continue }
            let patch: CIImage
            switch redaction.style {
            case .blur:
                patch = image.cropped(to: rect).clampedToExtent().applyingGaussianBlur(sigma: max(6, extent.height * 0.012))
            case .pixelate:
                patch = image.cropped(to: rect).clampedToExtent()
                    .applyingFilter("CIPixellate", parameters: [kCIInputScaleKey: max(8, extent.height * 0.018),
                                                                kCIInputCenterKey: CIVector(x: rect.minX, y: rect.minY)])
            case .black:
                patch = CIImage(color: CIColor(red: 0.04, green: 0.04, blue: 0.05))
            }
            result = patch.cropped(to: rect).composited(over: result)
        }
        return result
    }

    /// One cursor to draw: its image, where its hotspot goes (0...1 from the top left), and its scale.
    struct CursorMark {
        var shape: CursorTrack.Shape
        var x: Double
        var y: Double
        /// Movie pixels per cursor point, times the edit's size.
        var pixelsPerPoint: Double
        /// 0 (hidden after standing still) to 1.
        var opacity = 1.0
    }

    /// The cursor's image with its hotspot on the point. The image is twice its point size.
    /// The cursor alone, placed on a picture of `extent` (clear around it), so the renderer can zoom and frame it like
    /// the picture and lay it over the captions and the shortcut plates.
    static func cursorSprite(_ mark: CursorMark, extent: CGRect) -> CIImage {
        let scale = mark.pixelsPerPoint / 2
        let hotX = extent.minX + mark.x * extent.width
        let hotY = extent.minY + (1 - mark.y) * extent.height
        let originX = hotX - mark.shape.hotX * mark.pixelsPerPoint
        let originY = hotY + mark.shape.hotY * mark.pixelsPerPoint - mark.shape.height * mark.pixelsPerPoint
        var cursor = mark.shape.image
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: originX, y: originY))
        if mark.opacity < 0.999 {
            cursor = cursor.applyingFilter("CIColorMatrix", parameters: [
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(mark.opacity)),
            ])
        }
        return cursor
    }

    /// Where a point of the source picture (0...1 from the top left) lands on the canvas (0...1 from the top left) in
    /// one frame: through the zoom's view, then the frame's placement. Per axis it is a scale and an offset, so the
    /// preview can draw a source rectangle where it shows and turn a drag on the canvas back into source fractions.
    struct SourceToCanvas: Equatable {
        var scaleX = 1.0, offsetX = 0.0, scaleY = 1.0, offsetY = 0.0
        /// The part of the canvas the picture shows in (0...1): a hidden part is drawn only inside it.
        var shown = CGRect(x: 0, y: 0, width: 1, height: 1)

        func point(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * scaleX + offsetX, y: p.y * scaleY + offsetY) }
        func rect(_ r: CGRect) -> CGRect {
            CGRect(x: r.minX * scaleX + offsetX, y: r.minY * scaleY + offsetY, width: r.width * scaleX, height: r.height * scaleY)
        }
        func sourcePoint(ofCanvas p: CGPoint) -> CGPoint {
            CGPoint(x: (p.x - offsetX) / max(1e-9, scaleX), y: (p.y - offsetY) / max(1e-9, scaleY))
        }
        func sourceRect(ofCanvas r: CGRect) -> CGRect {
            let origin = sourcePoint(ofCanvas: r.origin)
            return CGRect(x: origin.x, y: origin.y, width: r.width / max(1e-9, scaleX), height: r.height / max(1e-9, scaleY))
        }
    }

    static func sourceToCanvas(view: ZoomCurve.View, frame: EditProject.Frame?, picture: CGSize, canvas: CGSize,
                               coverFocus: CGPoint = CGPoint(x: 0.5, y: 0.5)) -> SourceToCanvas {
        let shown = view.rect
        var map = SourceToCanvas(scaleX: 1 / shown.width, offsetX: -shown.minX / shown.width,
                                 scaleY: 1 / shown.height, offsetY: -shown.minY / shown.height)
        guard let frame else { return map }

        let placement = framePlacement(frame, picture: picture, canvas: canvas, focus: coverFocus)
        let crop = placement.crop ?? .zero
        let s = placement.scale
        // Core Image counts y from the bottom: the picture's top (y 0) is at height H before the crop.
        let ax = picture.width * s / canvas.width, bx = (placement.inner.minX - crop.minX * s) / canvas.width
        let ay = picture.height * s / canvas.height
        let by = 1 - (picture.height * s - crop.minY * s + placement.inner.minY) / canvas.height
        let inner = placement.inner
        map = SourceToCanvas(scaleX: map.scaleX * ax, offsetX: map.offsetX * ax + bx,
                             scaleY: map.scaleY * ay, offsetY: map.offsetY * ay + by,
                             shown: CGRect(x: inner.minX / canvas.width, y: 1 - inner.maxY / canvas.height,
                                           width: inner.width / canvas.width, height: inner.height / canvas.height))
        return map
    }

    /// Where the frame puts the picture: an optional cover crop (Core Image coordinates of the picture), then a scale
    /// and the rectangle it lands in on the canvas.
    struct FramePlacement {
        var crop: CGRect?
        var scale: CGFloat
        var inner: CGRect

        func place(_ image: CIImage) -> CIImage {
            var source = image
            if let crop {
                source = image.cropped(to: crop).transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
            }
            return source
                .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
                .transformed(by: CGAffineTransform(translationX: inner.minX, y: inner.minY))
        }
    }

    static func framePlacement(_ frame: EditProject.Frame, picture: CGSize, canvas size: CGSize,
                               focus: CGPoint = CGPoint(x: 0.5, y: 0.5)) -> FramePlacement {
        let unit = min(size.width, size.height)
        let padding = frame.padding * unit
        let room = CGSize(width: max(2, size.width - 2 * padding), height: max(2, size.height - 2 * padding))
        let crop = frame.fit == .cover ? coverCrop(picture: picture, room: room, focus: focus) : nil
        let shown = crop?.size ?? picture
        let scale = max(0.05, min(room.width / shown.width, room.height / shown.height))
        let inner = CGRect(x: (size.width - shown.width * scale) / 2, y: (size.height - shown.height * scale) / 2,
                           width: shown.width * scale, height: shown.height * scale)
        return FramePlacement(crop: crop, scale: scale, inner: inner)
    }

    /// The picture fitted inside the canvas less the padding, centred, masked to a rounded rectangle, over a shadow
    /// and the background. Sizes are fractions of the canvas's short side; the output is `canvas`.
    /// With `fit: .cover` the picture is first cropped to the shape of the room inside the padding, centred on
    /// `focus` (0...1 from the top left) as far as the picture's edges allow.
    static func applyFrame(_ frame: EditProject.Frame, to image: CIImage, picture: CGSize, canvas size: CGSize,
                           focus: CGPoint = CGPoint(x: 0.5, y: 0.5)) -> CIImage {
        applyFrame(frame, to: image, canvas: size, placement: framePlacement(frame, picture: picture, canvas: size, focus: focus))
    }

    static func applyFrame(_ frame: EditProject.Frame, to image: CIImage, canvas size: CGSize, placement: FramePlacement) -> CIImage {
        let unit = min(size.width, size.height)
        let inner = placement.inner
        let placed = placement.place(image)
        let radius = frame.cornerRadius * unit
        let mask = roundedRect(inner, radius: radius, color: .white)
        let clipped = placed.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: CIImage.empty(),
            kCIInputMaskImageKey: mask,
        ])
        var canvas = background(frame.background, size: size)
        if frame.shadow {
            let blur = unit * 0.018
            let shadow = roundedRect(inner, radius: radius, color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.55))
                .transformed(by: CGAffineTransform(translationX: 0, y: -unit * 0.008))
                .applyingGaussianBlur(sigma: blur)
            canvas = shadow.composited(over: canvas)
        }
        return clipped.composited(over: canvas).cropped(to: CGRect(origin: .zero, size: size))
    }

    /// The part of the picture (Core Image coordinates, y up) with the room's shape, as large as fits, centred on
    /// `focus` (y from the top) and kept inside the picture.
    static func coverCrop(picture: CGSize, room: CGSize, focus: CGPoint) -> CGRect {
        let aspect = room.width / room.height
        let size = picture.width / picture.height > aspect
            ? CGSize(width: picture.height * aspect, height: picture.height)
            : CGSize(width: picture.width, height: picture.width / aspect)
        let centerX = min(max(focus.x * picture.width, size.width / 2), picture.width - size.width / 2)
        let centerY = min(max((1 - focus.y) * picture.height, size.height / 2), picture.height - size.height / 2)
        return CGRect(x: centerX - size.width / 2, y: centerY - size.height / 2, width: size.width, height: size.height)
    }

    static func background(_ background: EditProject.Background, size: CGSize) -> CIImage {
        let bounds = CGRect(origin: .zero, size: size)
        let colors = background.colors.map(Self.color)
        switch background.kind {
        case .none:
            return CIImage(color: .black).cropped(to: bounds)
        case .color:
            return CIImage(color: colors.first ?? .black).cropped(to: bounds)
        case .image:
            guard let path = background.image, let picture = BackgroundPictures.shared.image(path) else {
                return CIImage(color: colors.first ?? .black).cropped(to: bounds)
            }
            // Scaled to cover the canvas and centred; a blur reads the picture clamped, so its edges stay full.
            let scale = max(size.width / picture.extent.width, size.height / picture.extent.height)
            var placed = picture.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            placed = placed.transformed(by: CGAffineTransform(translationX: (size.width - placed.extent.width) / 2 - placed.extent.minX,
                                                              y: (size.height - placed.extent.height) / 2 - placed.extent.minY))
            if let blur = background.blur, blur > 0.001 {
                placed = placed.clampedToExtent().applyingGaussianBlur(sigma: blur * min(size.width, size.height) * 0.03)
            }
            return placed.cropped(to: bounds)
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

    /// Every background picture, decoded once per path: each frame draws it.
    final class BackgroundPictures: @unchecked Sendable {
        static let shared = BackgroundPictures()
        private let lock = NSLock()
        private var images: [String: CIImage] = [:]

        func image(_ path: String) -> CIImage? {
            lock.lock()
            defer { lock.unlock() }
            if let cached = images[path] { return cached }
            guard let image = CIImage(contentsOf: URL(fileURLWithPath: path), options: [.applyOrientationProperty: true]) else { return nil }
            images[path] = image
            return image
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
