import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import GenesisKit

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

    /// The clicks whose disc shows at the source moment `ms`: each runs `durationMs` of the movie as it plays from its
    /// click, so a sped-up part does not shorten it, and ends at a cut, where the picture it sits on is gone.
    static func marks(atSourceMs ms: Double, clicks: [CursorTrack.Sample], durationMs: Int, project: EditProject) -> [ClickMark] {
        let placed = TimelineMap.placed(project)
        guard !clicks.isEmpty, let outUs = TimelineMap.outputTime(ofSource: Int64((ms * 1000).rounded()), placed: placed) else { return [] }
        let durationUs = Int64(max(1, durationMs)) * 1000
        // Within one unbroken stretch output time runs with source time, so the clicks of the last `durationMs` are
        // the ones from the source time that played then.
        let fromOut = max(TimelineMap.unbrokenStart(atOutput: outUs, placed: placed), outUs - durationUs)
        let fromMs = Double(TimelineMap.sourceTime(atOutput: fromOut, in: project)) / 1000
        return clicks.compactMap { click in
            guard click.ms >= fromMs, click.ms <= ms,
                  let clickOut = TimelineMap.outputTime(ofSource: Int64((click.ms * 1000).rounded()), placed: placed) else { return nil }
            let age = outUs - clickOut
            guard age >= 0, age <= durationUs else { return nil }
            return ClickMark(x: click.x, y: click.y, progress: Double(age) / Double(durationUs))
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

    /// The fully drawn shapes, kept so a still part of a shape costs one composite a frame instead of a new drawing.
    private static let shapeCache = NSCache<NSString, CGImage>()

    /// An arrow, box or circle in its colour with a soft shadow, drawn into its own small picture and laid over the
    /// source. `drawn` (0...1) grows an arrow from its tail and strokes a box or circle around; `opacity` fades it.
    static func drawShape(_ shape: EditProject.Shape, drawn: Double, opacity: Double, on image: CIImage) -> CIImage {
        let extent = image.extent
        let line = max(2, shape.width * min(extent.width, extent.height))
        // Core Graphics counts y from the bottom; the shape counts it from the top.
        let tail = CGPoint(x: shape.x1 * extent.width, y: (1 - shape.y1) * extent.height)
        let head = CGPoint(x: shape.x2 * extent.width, y: (1 - shape.y2) * extent.height)
        let pad = line * 6
        let box = CGRect(x: min(tail.x, head.x), y: min(tail.y, head.y), width: abs(head.x - tail.x), height: abs(head.y - tail.y))
            .insetBy(dx: -pad, dy: -pad).integral
            .intersection(CGRect(origin: .zero, size: extent.size))
        guard box.width >= 2, box.height >= 2, opacity > 0.001 else { return image }
        let key = "\(shape.id) \(shape.kind) \(shape.x1) \(shape.y1) \(shape.x2) \(shape.y2) \(shape.color) \(shape.width) \(extent.size)" as NSString
        let complete = drawn >= 0.999
        var picture = complete ? shapeCache.object(forKey: key) : nil
        if picture == nil {
            picture = renderShape(shape, drawn: drawn, line: line, tail: tail, head: head, box: box)
            if complete, let picture { shapeCache.setObject(picture, forKey: key) }
        }
        guard let picture else { return image }
        var layer = CIImage(cgImage: picture).transformed(by: CGAffineTransform(translationX: extent.minX + box.minX, y: extent.minY + box.minY))
        if opacity < 0.999 {
            layer = layer.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: CGFloat(opacity))])
        }
        return layer.composited(over: image)
    }

    private static func renderShape(_ shape: EditProject.Shape, drawn: Double, line: CGFloat, tail: CGPoint, head: CGPoint, box: CGRect) -> CGImage? {
        guard let context = CGContext(data: nil, width: Int(box.width), height: Int(box.height), bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.translateBy(x: -box.minX, y: -box.minY)
        let rgb = color(shape.color)
        let color = CGColor(red: rgb.red, green: rgb.green, blue: rgb.blue, alpha: 1)
        context.setShadow(offset: CGSize(width: 0, height: -line * 0.35), blur: line * 1.6, color: CGColor(gray: 0, alpha: 0.4))
        context.setStrokeColor(color)
        context.setFillColor(color)
        context.setLineWidth(line)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        switch shape.kind {
        case .arrow:
            let length = hypot(head.x - tail.x, head.y - tail.y)
            guard length > 1 else { return nil }
            let direction = CGPoint(x: (head.x - tail.x) / length, y: (head.y - tail.y) / length)
            let tip = CGPoint(x: tail.x + direction.x * length * drawn, y: tail.y + direction.y * length * drawn)
            let headLength = min(line * 4.2, length * 0.45)
            let base = CGPoint(x: tip.x - direction.x * headLength * 0.8, y: tip.y - direction.y * headLength * 0.8)
            context.move(to: tail)
            context.addLine(to: base)
            context.strokePath()
            let side = CGPoint(x: -direction.y, y: direction.x)
            let back = CGPoint(x: tip.x - direction.x * headLength, y: tip.y - direction.y * headLength)
            context.move(to: tip)
            context.addLine(to: CGPoint(x: back.x + side.x * headLength * 0.55, y: back.y + side.y * headLength * 0.55))
            context.addLine(to: CGPoint(x: back.x - side.x * headLength * 0.55, y: back.y - side.y * headLength * 0.55))
            context.closePath()
            context.fillPath()
        case .box, .circle:
            let rect = CGRect(x: min(tail.x, head.x), y: min(tail.y, head.y), width: abs(head.x - tail.x), height: abs(head.y - tail.y))
            let path = shape.kind == .box
                ? CGPath(roundedRect: rect, cornerWidth: min(line * 2, rect.width / 2), cornerHeight: min(line * 2, rect.height / 2), transform: nil)
                : CGPath(ellipseIn: rect, transform: nil)
            // Stroked around from the start: a dash as long as the drawn share of the outline.
            let outline = shape.kind == .box ? 2 * (rect.width + rect.height) : .pi * (rect.width + rect.height) / 2
            if drawn < 0.999 { context.setLineDash(phase: 0, lengths: [outline * drawn, outline * 2]) }
            context.addPath(path)
            context.strokePath()
        }
        return context.makeImage()
    }

    /// The longest smear a motion blur draws, in output pixels; a faster move is clamped, so a jump stays readable.
    /// The longest smear a motion blur draws, in output pixels; a faster move is clamped, so a jump stays readable.
    static let maxMotionBlur = 24.0

    /// Smears the zoomed picture along the move from `previous` to `view` over one frame: a directional blur for a
    /// pan, a radial one for a change of scale. `amount` is the shutter (0.5: half the move). A move under a pixel
    /// draws nothing, so a still zoom costs no filter.
    static func motionBlur(from previous: ZoomCurve.View, to view: ZoomCurve.View, amount: Double, on image: CIImage) -> CIImage {
        let extent = image.extent
        let width = view.rect.width
        guard amount > 0, width > 0, extent.width > 1 else { return image }
        // The picture moves opposite to the shown rectangle; in output pixels, y up as Core Image counts it.
        let dx = -(view.centerX - previous.centerX) / width * extent.width
        let dy = (view.centerY - previous.centerY) / width * extent.height
        var result = image
        // Each smear is a length in pixels; the filters' own units were measured against a lit 2 px dot (2026-11-04):
        // CIMotionBlur spreads about 5.6 px per unit of radius, CIZoomBlur about 0.0226 px per unit of amount and pixel
        // of distance from its centre.
        let pan = min(maxMotionBlur, (dx * dx + dy * dy).squareRoot() * amount)
        if pan >= 1 {
            result = result.clampedToExtent()
                .applyingFilter("CIMotionBlur", parameters: [kCIInputRadiusKey: pan / 5.6, kCIInputAngleKey: atan2(dy, dx)])
                .cropped(to: extent)
        }
        let halfWidth = extent.width / 2
        let grow = min(maxMotionBlur, abs(view.scale / max(1, previous.scale) - 1) * halfWidth * amount)
        if grow >= 1 {
            result = result.clampedToExtent()
                .applyingFilter("CIZoomBlur", parameters: [kCIInputCenterKey: CIVector(x: extent.midX, y: extent.midY),
                                                           "inputAmount": grow / (0.0226 * halfWidth)])
                .cropped(to: extent)
        }
        return result
    }

    /// How much black a spotlight lays over the picture around its rectangle. R8 11: 0.5 (0.7 before greyed the whole
    /// screen until nothing around the rectangle could be read); a part's `dim` sets its own.
    static let spotlightDim = 0.5

    /// Hides each rectangle with a blur, big pixels or black, or dims everything around a spotlight's rectangle. The
    /// blur reads the picture clamped at the rectangle's edges, so nothing from outside bleeds in and its edge stays sharp.
    static func redact(_ redactions: [EditProject.Redaction], on image: CIImage, spotlightFade: Double = 1) -> CIImage {
        guard !redactions.isEmpty else { return image }
        let extent = image.extent
        var result = image
        let rectOf = { (redaction: EditProject.Redaction) in
            CGRect(x: extent.minX + redaction.x * extent.width,
                   y: extent.minY + (1 - redaction.y - redaction.height) * extent.height,
                   width: redaction.width * extent.width, height: redaction.height * extent.height).integral
                .intersection(extent)
        }
        // The hiding styles first: a spotlight never lights up a hidden token.
        for redaction in redactions where redaction.style != .spotlight {
            let rect = rectOf(redaction)
            guard rect.width > 1, rect.height > 1 else { continue }
            let patch: CIImage
            switch redaction.style {
            case .spotlight:
                continue
            case .blur:
                patch = image.cropped(to: rect).clampedToExtent().applyingGaussianBlur(sigma: max(6, extent.height * 0.012))
            case .pixelate:
                patch = image.cropped(to: rect).clampedToExtent()
                    .applyingFilter("CIPixellate", parameters: [kCIInputScaleKey: pixelCell(redaction, pictureHeight: extent.height),
                                                                kCIInputCenterKey: CIVector(x: rect.minX, y: rect.minY)])
            case .black:
                patch = CIImage(color: CIColor(red: 0.04, green: 0.04, blue: 0.05))
            }
            result = patch.cropped(to: rect).composited(over: result)
        }
        // Every spotlight showing together: one dim over the picture, then each lit rectangle put back from the
        // picture before the dim, so two spotlights both stay lit and the rest is dimmed once.
        // The darkest dim asked for wins; the lit shapes are one mask, so overlapping ones never dim each other.
        let lit = redactions.filter { $0.style == .spotlight }.map { ($0, rectOf($0)) }.filter { $0.1.width > 1 && $0.1.height > 1 }
        if !lit.isEmpty, spotlightFade > 0 {
            let level = lit.map { $0.0.dim ?? spotlightDim }.max() ?? spotlightDim
            let dim = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: level * min(1, spotlightFade))).cropped(to: extent)
            let dimmed = dim.composited(over: result)
            var mask = CIImage(color: .clear).cropped(to: extent)
            for (spot, rect) in lit {
                mask = spotlightMask(spot.cutout ?? .rounded, in: rect).composited(over: mask)
                // R8 11: a soft edge lights a ring around the shape that fades out over dimAround.
                if let around = spot.dimAround, around > 0 {
                    let reach = around * min(extent.width, extent.height)
                    let soft = spotlightMask(spot.cutout ?? .rounded, in: rect.insetBy(dx: -reach / 2, dy: -reach / 2))
                        .applyingGaussianBlur(sigma: reach / 4).cropped(to: extent)
                    mask = soft.applyingFilter("CIMaximumCompositing", parameters: [kCIInputBackgroundImageKey: mask])
                }
            }
            result = result.applyingFilter("CIBlendWithAlphaMask", parameters: [kCIInputBackgroundImageKey: dimmed, kCIInputMaskImageKey: mask])
                .cropped(to: extent)
        }
        return result
    }

    // R5 4 canvas zoom
    /// The part of the canvas `view` shows (0...1 from the top left), scaled up to the whole canvas.
    static func zoomCanvas(_ image: CIImage, view: ZoomCurve.View, size: CGSize) -> CIImage {
        let rect = view.rect
        let crop = CGRect(x: rect.minX * size.width, y: (1 - rect.maxY) * size.height, width: rect.width * size.width,
                          height: rect.height * size.height)
        return image.cropped(to: crop)
            .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
            .transformed(by: CGAffineTransform(scaleX: size.width / crop.width, y: size.height / crop.height))
            .cropped(to: CGRect(origin: .zero, size: size))
    }

    /// Where `zoomCanvas` moves a point of the canvas, both 0...1 from the top left: the twin of `zoomCanvasRect`
    /// (Core Image coordinates) for the preview's source-to-canvas map.
    static func zoomCanvasMap(_ view: ZoomCurve.View) -> Homography {
        let rect = view.rect
        return .affine(scaleX: 1 / rect.width, offsetX: -rect.minX / rect.width, scaleY: 1 / rect.height, offsetY: -rect.minY / rect.height)
    }

    // R5 5 redaction edges
    /// A pixelate block's side in source pixels: the part's `cell` (2 to 256), else 1.8 % of the picture's height and at
    /// least 8 (about 19 px on a 1080 p movie, 39 px on a 2160 p one).
    static func pixelCell(_ redaction: EditProject.Redaction, pictureHeight: CGFloat) -> CGFloat {
        if let cell = redaction.cell { return CGFloat(min(256, max(2, cell))) }
        return max(8, pictureHeight * 0.018)
    }

    /// The lit shape of one spotlight, white where it lights: a rectangle, a rectangle with corners of 12 % of its
    /// short side, or the ellipse in it with a 2 px soft edge.
    static func spotlightMask(_ cutout: EditProject.SpotlightCutout, in rect: CGRect) -> CIImage {
        switch cutout {
        case .rect:
            return CIImage(color: .white).cropped(to: rect)
        case .rounded:
            let generator = CIFilter.roundedRectangleGenerator()
            generator.extent = rect
            generator.radius = Float(min(rect.width, rect.height) * 0.12)
            generator.color = .white
            return generator.outputImage?.cropped(to: rect) ?? CIImage(color: .white).cropped(to: rect)
        case .circle:
            let gradient = CIFilter.radialGradient()
            gradient.center = .zero
            gradient.radius0 = 98
            gradient.radius1 = 100
            gradient.color0 = .white
            gradient.color1 = .clear
            let scale = CGAffineTransform(scaleX: rect.width / 200, y: rect.height / 200)
            return (gradient.outputImage ?? CIImage(color: .white)).transformed(by: scale)
                .transformed(by: CGAffineTransform(translationX: rect.midX, y: rect.midY)).cropped(to: rect)
        }
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
    /// one frame, in the renderer's order: the picture zoom's view, the frame's placement, the tilt, then the canvas
    /// zoom (EditRenderer's composition). Without a tilt it is a scale and an offset per axis; a tilt adds one
    /// projective map of the canvas after them. The preview draws a source rectangle where it shows with it, and turns
    /// a drag on the canvas back into source fractions.
    struct SourceToCanvas: Equatable {
        /// The picture zoom and the frame, and the canvas zoom too when no tilt comes between them.
        var scaleX = 1.0, offsetX = 0.0, scaleY = 1.0, offsetY = 0.0
        /// The part of the canvas the picture shows in (0...1): a hidden part is drawn only inside it. Under a tilt it
        /// is the box around the turned picture; null when the turn cannot be undone, so no outline is drawn.
        var shown = CGRect(x: 0, y: 0, width: 1, height: 1)
        /// The tilt and the canvas zoom after it, as one map of the canvas (0...1 from the top left); nil without a tilt.
        var perspective: Perspective?

        /// A projective map of the canvas and its inverse.
        struct Perspective: Equatable {
            let forward: Homography
            let backward: Homography

            /// Nil when the map folds the canvas onto a line, so no point could be turned back.
            init?(_ forward: Homography) {
                guard let backward = forward.inverted() else { return nil }
                self.forward = forward
                self.backward = backward
            }
        }

        private func placed(_ p: CGPoint) -> CGPoint { CGPoint(x: p.x * scaleX + offsetX, y: p.y * scaleY + offsetY) }

        private func unplaced(_ p: CGPoint) -> CGPoint {
            CGPoint(x: (p.x - offsetX) / max(1e-9, scaleX), y: (p.y - offsetY) / max(1e-9, scaleY))
        }

        func point(_ p: CGPoint) -> CGPoint {
            let at = placed(p)
            return perspective?.forward.apply(at) ?? at
        }

        func sourcePoint(ofCanvas p: CGPoint) -> CGPoint { unplaced(perspective?.backward.apply(p) ?? p) }

        /// A source rectangle on the canvas. A tilt lands it slightly slanted: the rectangle is centred where its centre
        /// lands and stretched as the tilt stretches the canvas there, so `sourceRect(ofCanvas:)` gives the same part
        /// back, and a click on a hidden part, or a drag there and back, never resizes it (HiddenPartDrag).
        func rect(_ r: CGRect) -> CGRect {
            guard let perspective else {
                return CGRect(x: r.minX * scaleX + offsetX, y: r.minY * scaleY + offsetY, width: r.width * scaleX, height: r.height * scaleY)
            }
            let middle = placed(CGPoint(x: r.midX, y: r.midY))
            let centre = perspective.forward.apply(middle), stretch = perspective.forward.stretch(at: middle)
            let width = r.width * scaleX * stretch.x, height = r.height * scaleY * stretch.y
            return CGRect(x: centre.x - width / 2, y: centre.y - height / 2, width: width, height: height)
        }

        func sourceRect(ofCanvas r: CGRect) -> CGRect {
            guard let perspective else {
                let origin = sourcePoint(ofCanvas: r.origin)
                return CGRect(x: origin.x, y: origin.y, width: r.width / max(1e-9, scaleX), height: r.height / max(1e-9, scaleY))
            }
            let middle = perspective.backward.apply(CGPoint(x: r.midX, y: r.midY))
            let centre = unplaced(middle), stretch = perspective.forward.stretch(at: middle)
            let width = r.width / max(1e-9, scaleX * stretch.x), height = r.height / max(1e-9, scaleY * stretch.y)
            return CGRect(x: centre.x - width / 2, y: centre.y - height / 2, width: width, height: height)
        }

        /// This map, then `turn` (a projective map of the canvas, 0...1 from the top left).
        fileprivate func followed(by turn: Homography) -> SourceToCanvas {
            var map = self
            map.perspective = Perspective(perspective.map { $0.forward.then(turn) } ?? turn)
            map.shown = map.perspective == nil ? .null : turn.bounds(of: shown).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
            return map
        }

        /// This map, then the canvas zoom `view` (Looks.zoomCanvas): folded into the scale and the offset, or after the tilt.
        fileprivate func zoomedCanvas(_ view: ZoomCurve.View) -> SourceToCanvas {
            let zoom = Looks.zoomCanvasMap(view)
            guard perspective == nil else { return followed(by: zoom) }
            var map = self
            map.scaleX = scaleX * zoom.a
            map.offsetX = offsetX * zoom.a + zoom.c
            map.scaleY = scaleY * zoom.e
            map.offsetY = offsetY * zoom.e + zoom.f
            map.shown = zoom.bounds(of: shown).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
            return map
        }
    }

    /// The map at an output moment of `project`, from the same inputs EditRenderer's look takes there (ZoomState.look):
    /// the picture zoom's view and the cover focus, the frame, the tilt's pose and the canvas zoom's view. The editor's
    /// preview draws and drags its hidden-part, spotlight, shape and screen-find handles through it.
    static func sourceToCanvas(project: EditProject, cursor: CursorTrack?, atOutput outUs: Int64) -> SourceToCanvas {
        let sourceUs = TimelineMap.sourceTime(atOutput: outUs, in: project)
        let view = ZoomCurve.view(atSource: sourceUs, project: project, cursor: cursor)
        let sizes = EditRenderer.outputSizes(source: CGSize(width: project.source.width, height: project.source.height),
                                             maxHeight: 0, aspect: project.frame?.aspect)
        let focus = ZoomState.coverFocus(atSourceUs: sourceUs, project: project, track: cursor, view: view)
        return sourceToCanvas(view: view, frame: project.frame, picture: sizes.picture, canvas: sizes.canvas, coverFocus: focus,
                              tilt: project.tilt.flatMap { TiltLook.pose(atOutputUs: outUs, lengthUs: project.outputDurationUs, tilt: $0) },
                              canvasView: ZoomCurve.canvasView(atSource: sourceUs, project: project))
    }

    static func sourceToCanvas(view: ZoomCurve.View, frame: EditProject.Frame?, picture: CGSize, canvas: CGSize,
                               coverFocus: CGPoint = CGPoint(x: 0.5, y: 0.5), tilt: TiltLook.Pose? = nil,
                               canvasView: ZoomCurve.View = .whole) -> SourceToCanvas {
        let shown = view.rect
        var map = SourceToCanvas(scaleX: 1 / shown.width, offsetX: -shown.minX / shown.width,
                                 scaleY: 1 / shown.height, offsetY: -shown.minY / shown.height)
        if let frame {
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
        }
        if let tilt {
            // The tilt turns Core Image pixels (y up); the map counts fractions of the canvas from the top left.
            let toPixels = Homography.affine(scaleX: canvas.width, offsetX: 0, scaleY: -canvas.height, offsetY: canvas.height)
            let toFractions = Homography.affine(scaleX: 1 / canvas.width, offsetX: 0, scaleY: -1 / canvas.height, offsetY: 1)
            if let turn = TiltLook.homography(pose: tilt, canvas: canvas) {
                map = map.followed(by: toPixels.then(turn).then(toFractions))
            } else {
                map.shown = .null
            }
        }
        // The renderer zooms the canvas only past 1.0005, as here.
        if canvasView.scale > 1.0005 {
            map = map.zoomedCanvas(canvasView)
        }
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
        var crop = frame.fit == .cover ? coverCrop(picture: picture, room: room, focus: focus) : nil
        let shown = crop?.size ?? picture
        // R5 4 frame layouts: the fitted size times the layout's scale, against the edge it names (Core Image y up).
        let layout = frame.layout ?? .init()
        let scale = max(0.05, min(room.width / shown.width, room.height / shown.height)) * CGFloat(min(3, max(0.5, layout.scale)))
        var width = shown.width * scale, height = shown.height * scale
        // R7 9: a picture grown past the room stays inside it, cropped around the layout's focus (its centre by
        // default), so a phone gets wider while the free side shrinks; before, the canvas cut its top and bottom.
        if width > room.width + 0.5 || height > room.height + 0.5 {
            let boxWidth = min(width, room.width), boxHeight = min(height, room.height)
            let base = crop ?? CGRect(origin: .zero, size: picture)
            let visible = CGSize(width: boxWidth / scale, height: boxHeight / scale)
            let keep = layout.focus ?? .init()
            let centerX = min(max(base.minX + CGFloat(keep.x) * base.width, base.minX + visible.width / 2), base.maxX - visible.width / 2)
            // Core Image counts y from the bottom; the focus counts it from the top.
            let centerY = min(max(base.maxY - CGFloat(keep.y) * base.height, base.minY + visible.height / 2), base.maxY - visible.height / 2)
            crop = CGRect(x: centerX - visible.width / 2, y: centerY - visible.height / 2, width: visible.width, height: visible.height)
            width = boxWidth
            height = boxHeight
        }
        var x = (size.width - width) / 2, y = (size.height - height) / 2
        switch layout.align {
        case .center: break
        case .left: x = padding
        case .right: x = size.width - padding - width
        case .top: y = size.height - padding - height
        case .bottom: y = padding
        }
        return FramePlacement(crop: crop, scale: scale, inner: CGRect(x: x, y: y, width: width, height: height))
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
        let layers = frameLayers(frame, to: image, canvas: size, placement: placement)
        return layers.picture.composited(over: layers.background).cropped(to: CGRect(origin: .zero, size: size))
    }

    /// The frame in two layers: the rounded picture over its shadow (on clear, exactly `rect` large, so the tilt can
    /// turn it as one), and the background. Round 4 fx-render split it out of applyFrame for the tilt.
    static func frameLayers(_ frame: EditProject.Frame, to image: CIImage, canvas size: CGSize, placement: FramePlacement)
        -> (picture: CIImage, background: CIImage, rect: CGRect) {
        let unit = min(size.width, size.height)
        let inner = placement.inner
        let placed = placement.place(image)
        let radius = frame.cornerRadius * unit
        let mask = roundedRect(inner, radius: radius, color: .white)
        var picture = placed.applyingFilter("CIBlendWithMask", parameters: [
            kCIInputBackgroundImageKey: CIImage.empty(),
            kCIInputMaskImageKey: mask,
        ])
        let blur = unit * 0.018
        if frame.shadow {
            let shadow = roundedRect(inner, radius: radius, color: CIColor(red: 0, green: 0, blue: 0, alpha: 0.55))
                .transformed(by: CGAffineTransform(translationX: 0, y: -unit * 0.008))
                .applyingGaussianBlur(sigma: blur)
            picture = picture.composited(over: shadow)
        }
        // Whole pixels: Core Image rounds a crop's extent out, and the tilt maps the layer's own extent.
        let rect = inner.insetBy(dx: -blur * 3, dy: -blur * 3 - unit * 0.008).intersection(CGRect(origin: .zero, size: size)).integral
        let layer = picture.composited(over: CIImage(color: .clear).cropped(to: rect)).cropped(to: rect)
        return (layer, background(frame.background, size: size), rect)
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

    /// Every background picture and intro logo, decoded once while its file stays the same: each frame draws it. The
    /// recorder host runs for hours, so a file written over in place or replaced by a rename (a new modification time,
    /// size or inode) is decoded again, and only the pictures used last are kept.
    final class BackgroundPictures: @unchecked Sendable {
        static let kept = 8
        static let shared = BackgroundPictures()
        private let lock = NSLock()
        private var images: RecentCache<String, (identity: MediaFileIdentity, image: CIImage)>

        init(limit: Int = BackgroundPictures.kept) {
            images = RecentCache(limit: limit)
        }

        /// The picture as its file is now; nil when the file is gone or holds no picture, so the colour draws.
        func image(_ path: String) -> CIImage? {
            // The stat comes before the read: a file that changes between them is read again on the next frame.
            guard let identity = MediaFileIdentity.current(path) else { return nil }
            lock.lock()
            defer { lock.unlock() }
            if let cached = images.value(for: path), cached.identity == identity { return cached.image }
            guard let image = CIImage(contentsOf: URL(fileURLWithPath: path), options: [.applyOrientationProperty: true]) else { return nil }
            images.set((identity, image), for: path)
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

/// A projective map of the plane, as Core Image's perspective transform draws one: (x, y) goes to
/// ((a x + b y + c) / w, (d x + e y + f) / w) with w = g x + h y + i. The preview's source-to-canvas map turns with the
/// tilt through it (Looks.SourceToCanvas).
struct Homography: Equatable {
    var a, b, c, d, e, f, g, h, i: Double

    /// A scale and an offset per axis.
    static func affine(scaleX: Double, offsetX: Double, scaleY: Double, offsetY: Double) -> Homography {
        Homography(a: scaleX, b: 0, c: offsetX, d: 0, e: scaleY, f: offsetY, g: 0, h: 0, i: 1)
    }

    /// The map that takes each corner of `rect` where `corner` takes it, as the perspective transform does with a layer's
    /// corners; nil for a rectangle with no area or corners that land on one line.
    init?(rect: CGRect, corner: (CGPoint) -> CGPoint) {
        guard rect.width > 0, rect.height > 0 else { return nil }
        // Heckbert's square to quadrilateral: (0, 0), (1, 0), (1, 1), (0, 1) to p0, p1, p2, p3.
        let p0 = corner(CGPoint(x: rect.minX, y: rect.minY)), p1 = corner(CGPoint(x: rect.maxX, y: rect.minY))
        let p2 = corner(CGPoint(x: rect.maxX, y: rect.maxY)), p3 = corner(CGPoint(x: rect.minX, y: rect.maxY))
        let x0 = Double(p0.x), y0 = Double(p0.y), x1 = Double(p1.x), y1 = Double(p1.y)
        let x2 = Double(p2.x), y2 = Double(p2.y), x3 = Double(p3.x), y3 = Double(p3.y)
        let dx1 = x1 - x2, dx2 = x3 - x2, sumX = x0 - x1 + x2 - x3
        let dy1 = y1 - y2, dy2 = y3 - y2, sumY = y0 - y1 + y2 - y3
        let det = dx1 * dy2 - dx2 * dy1
        guard det != 0, det.isFinite else { return nil }
        let g = (sumX * dy2 - dx2 * sumY) / det
        let h = (dx1 * sumY - sumX * dy1) / det
        let square = Homography(a: x1 - x0 + g * x1, b: x3 - x0 + h * x3, c: x0, d: y1 - y0 + g * y1, e: y3 - y0 + h * y3, f: y0,
                                g: g, h: h, i: 1)
        let toSquare = Homography.affine(scaleX: 1 / Double(rect.width), offsetX: -Double(rect.minX / rect.width),
                                         scaleY: 1 / Double(rect.height), offsetY: -Double(rect.minY / rect.height))
        self = toSquare.then(square)
    }

    init(a: Double, b: Double, c: Double, d: Double, e: Double, f: Double, g: Double, h: Double, i: Double) {
        (self.a, self.b, self.c, self.d, self.e, self.f, self.g, self.h, self.i) = (a, b, c, d, e, f, g, h, i)
    }

    func apply(_ p: CGPoint) -> CGPoint {
        let x = Double(p.x), y = Double(p.y)
        let w = g * x + h * y + i
        return CGPoint(x: (a * x + b * y + c) / w, y: (d * x + e * y + f) / w)
    }

    /// This map, then `next`.
    func then(_ next: Homography) -> Homography {
        let n = next
        return Homography(a: n.a * a + n.b * d + n.c * g, b: n.a * b + n.b * e + n.c * h, c: n.a * c + n.b * f + n.c * i,
                          d: n.d * a + n.e * d + n.f * g, e: n.d * b + n.e * e + n.f * h, f: n.d * c + n.e * f + n.f * i,
                          g: n.g * a + n.h * d + n.i * g, h: n.g * b + n.h * e + n.i * h, i: n.g * c + n.h * f + n.i * i)
    }

    /// The map back; nil when this one folds the plane onto a line (an extreme tilt), so nothing can be turned back.
    func inverted() -> Homography? {
        let ca = e * i - f * h, cb = f * g - d * i, cc = d * h - e * g
        let det = a * ca + b * cb + c * cc
        let size = [a, b, c, d, e, f, g, h, i].map(abs).max() ?? 0
        guard det.isFinite, size > 0, abs(det) > 1e-12 * size * size * size else { return nil }
        return Homography(a: ca / det, b: (c * h - b * i) / det, c: (b * f - c * e) / det,
                          d: cb / det, e: (a * i - c * g) / det, f: (c * d - a * f) / det,
                          g: cc / det, h: (b * g - a * h) / det, i: (a * e - b * d) / det)
    }

    /// How much the map stretches a short move along x, and one along y, at `p` (its derivative's diagonal there).
    func stretch(at p: CGPoint) -> CGPoint {
        let w = g * Double(p.x) + h * Double(p.y) + i
        let mapped = apply(p)
        return CGPoint(x: abs((a - g * Double(mapped.x)) / w), y: abs((e - h * Double(mapped.y)) / w))
    }

    /// The box around the four corners of `rect` where the map takes them.
    func bounds(of rect: CGRect) -> CGRect {
        guard !rect.isNull else { return .null }
        let corners = [CGPoint(x: rect.minX, y: rect.minY), CGPoint(x: rect.maxX, y: rect.minY),
                       CGPoint(x: rect.maxX, y: rect.maxY), CGPoint(x: rect.minX, y: rect.maxY)].map(apply)
        let xs = corners.map(\.x), ys = corners.map(\.y)
        let minX = xs.min() ?? 0, minY = ys.min() ?? 0
        return CGRect(x: minX, y: minY, width: (xs.max() ?? 0) - minX, height: (ys.max() ?? 0) - minY)
    }
}
