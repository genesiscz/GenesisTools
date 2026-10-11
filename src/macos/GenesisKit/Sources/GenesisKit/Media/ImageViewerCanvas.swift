import AppKit
import QuartzCore
import SwiftUI

/// The viewer's picture surface: one picture, or two compared with a slider or side by side. Core Animation draws
/// the pictures (one texture each, uploaded once), and every pinch, scroll or drag only moves layer frames in one
/// transaction with actions off, so zoom and pan cost no SwiftUI render and no redraw of the picture.
///
/// Geometry is computed top-left (`ImageZoomMath`) and flipped once when a frame is applied.
@MainActor
public final class ImageViewerCanvasView: NSView {
    public enum Slot: Sendable { case a, b }

    public enum Mode: Equatable, Sendable {
        case single
        case slider
        case sideBySide
    }

    /// A decoded picture and the source's own size in pixels (the layout never moves when a sharper decode lands).
    struct Picture {
        var image: CGImage?
        var pixelSize: CGSize
    }

    /// Room around a fitted picture.
    static let margin: CGFloat = 14
    /// The gap between the two panes side by side.
    static let paneGap: CGFloat = 2
    /// How close to the divider a click grabs it.
    static let dividerGrab: CGFloat = 9

    private(set) var pictureA: Picture?
    private(set) var pictureB: Picture?
    private(set) var mode: Mode = .single
    private(set) var divider: CGFloat = 0.5
    private(set) var zoom = ImageZoom(scale: 1, origin: .zero)
    /// False while the picture follows the fit (a window resize refits it); a zoom or pan makes it the user's.
    private(set) var userZoomed = false
    /// While the zoom transition flies a copy of the picture, the canvas shows only its background.
    var picturesHidden = false {
        didSet {
            guard picturesHidden != oldValue else { return }
            withoutActions {
                imageA.opacity = picturesHidden ? 0 : 1
                imageB.opacity = picturesHidden ? 0 : 1
            }
        }
    }

    /// Scale, origin and the "68 %" the toolbar shows; called on every change.
    var onZoom: ((ImageZoom, Int) -> Void)?
    var onDivider: ((CGFloat) -> Void)?
    /// The pixels a slot now needs on its longest side, when that is more than it has.
    var onNeedsPixels: ((Slot, CGFloat) -> Void)?
    /// A test seam and the snapshot's: the backing scale when the view is not in a window yet.
    var fallbackBackingScale: CGFloat = 2

    private let paneA = CALayer()
    private let paneB = CALayer()
    private let imageA = CALayer()
    private let imageB = CALayer()
    private let dividerLine = CALayer()
    private let knob = CALayer()
    private let paneSeparator = CALayer()
    private var drag: Drag?
    private var tracking: NSTrackingArea?

    private enum Drag {
        case pan(last: CGPoint)
        case divider
    }

    public override init(frame: NSRect) {
        super.init(frame: frame)
        let root = CALayer()
        root.masksToBounds = true
        layer = root
        wantsLayer = true
        layerContentsRedrawPolicy = .never
        for pane in [paneA, paneB] {
            pane.masksToBounds = true
            root.addSublayer(pane)
        }
        for image in [imageA, imageB] {
            image.contentsGravity = .resize
            image.minificationFilter = .trilinear
            image.magnificationFilter = .linear
            image.isOpaque = false
        }
        paneA.addSublayer(imageA)
        paneB.addSublayer(imageB)
        paneSeparator.backgroundColor = NSColor(white: 1, alpha: 0.12).cgColor
        root.addSublayer(paneSeparator)
        dividerLine.backgroundColor = NSColor.white.cgColor
        dividerLine.shadowColor = NSColor.black.cgColor
        dividerLine.shadowOpacity = 0.55
        dividerLine.shadowRadius = 2
        dividerLine.shadowOffset = .zero
        root.addSublayer(dividerLine)
        knob.backgroundColor = NSColor(white: 0.08, alpha: 0.82).cgColor
        knob.borderColor = NSColor.white.cgColor
        knob.borderWidth = 1.5
        knob.cornerRadius = 15
        knob.contentsGravity = .center
        knob.shadowColor = NSColor.black.cgColor
        knob.shadowOpacity = 0.4
        knob.shadowRadius = 4
        knob.shadowOffset = .zero
        knob.contents = Self.knobGlyph(scale: fallbackBackingScale)
        knob.contentsScale = fallbackBackingScale
        root.addSublayer(knob)
        apply(animated: false)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    public override var acceptsFirstResponder: Bool { true }
    public override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    public override var mouseDownCanMoveWindow: Bool { false }

    var backingScale: CGFloat { window?.backingScaleFactor ?? fallbackBackingScale }

    public override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        let scale = backingScale
        withoutActions {
            for item in [layer, paneA, paneB, imageA, imageB, dividerLine, knob, paneSeparator] {
                item?.contentsScale = scale
            }
            knob.contents = Self.knobGlyph(scale: scale)
        }
        refit(keepingUserZoom: true)
    }

    public override func setFrameSize(_ newSize: NSSize) {
        let old = frame.size
        super.setFrameSize(newSize)
        guard old != newSize else { return }
        refit(keepingUserZoom: true, previousViewport: viewport(for: old))
        updateTracking()
    }

    // MARK: - State from the model

    func setPicture(_ slot: Slot, image: CGImage?, pixelSize: CGSize) {
        let previous = slot == .a ? pictureA : pictureB
        let picture = Picture(image: image, pixelSize: pixelSize)
        if slot == .a { pictureA = picture } else { pictureB = picture }
        withoutActions { (slot == .a ? imageA : imageB).contents = image }
        // A sharper decode of the same picture changes nothing on screen but its pixels; another picture starts fitted.
        if previous?.pixelSize != pixelSize {
            refit(keepingUserZoom: false)
        }
        requestPixelsIfNeeded()
    }

    func clearPicture(_ slot: Slot) {
        if slot == .a { pictureA = nil } else { pictureB = nil }
        withoutActions { (slot == .a ? imageA : imageB).contents = nil }
        apply(animated: false)
    }

    func setMode(_ next: Mode) {
        guard next != mode else { return }
        mode = next
        refit(keepingUserZoom: false)
        window?.invalidateCursorRects(for: self)
    }

    func setDivider(_ value: CGFloat, notify: Bool = false) {
        let clamped = min(0.98, max(0.02, value))
        guard clamped != divider else { return }
        divider = clamped
        apply(animated: false)
        if notify { onDivider?(divider) }
    }

    // MARK: - Geometry

    /// The content in A's pixels: the picture alone, or both laid out by `CompareLayout`.
    var layout: CompareLayout? {
        guard let a = pictureA?.pixelSize, a.width > 0, a.height > 0 else { return nil }
        if mode != .single, let b = pictureB?.pixelSize, b.width > 0, b.height > 0 {
            return CompareLayout.make(a: a, b: b)
        }
        return CompareLayout(a: CGRect(origin: .zero, size: a), b: .zero, content: a, bScale: 1)
    }

    /// The area one zoom applies to: the whole canvas, or one of the two panes side by side.
    func viewport(for size: CGSize? = nil) -> CGSize {
        let size = size ?? bounds.size
        guard mode == .sideBySide else { return size }
        return CGSize(width: max(1, (size.width - Self.paneGap) / 2), height: size.height)
    }

    var fitScale: CGFloat {
        guard let content = layout?.content else { return 1 }
        return ImageZoomMath.fitScale(content: content, viewport: viewport(), backingScale: backingScale, margin: Self.margin)
    }

    var actualScale: CGFloat { ImageZoomMath.actualScale(backingScale: backingScale) }

    private var limits: ClosedRange<CGFloat> { ImageZoomMath.limits(fit: fitScale, actual: actualScale) }

    /// Picture A's frame in this view's own (bottom-left) coordinates, as shown now; nil without a picture.
    public var displayedRectA: CGRect? {
        guard let layout else { return nil }
        let rect = zoom.frame(of: layout.a)
        return flipped(rect)
    }

    /// Where picture A would sit at the fit, in this view's own coordinates.
    public var fittedRectA: CGRect? {
        guard let layout else { return nil }
        let fitted = ImageZoomMath.fitted(content: layout.content, viewport: viewport(), backingScale: backingScale,
                                          margin: Self.margin)
        return flipped(fitted.frame(of: layout.a))
    }

    /// The part of the canvas picture A is clipped to, in this view's own coordinates: its pane side by side, the
    /// whole canvas otherwise (the slider's divider is not a frame of A).
    public var clipRectA: CGRect {
        mode == .sideBySide ? flipped(paneFrame(.a)) : bounds
    }

    private func refit(keepingUserZoom: Bool, previousViewport: CGSize? = nil) {
        guard let content = layout?.content else {
            apply(animated: false)
            return
        }
        let room = viewport()
        if keepingUserZoom && userZoomed {
            // Keep the content point at the centre of the old viewport at the centre of the new one.
            let old = previousViewport ?? room
            let centre = zoom.contentPoint(CGPoint(x: old.width / 2, y: old.height / 2))
            let scale = min(limits.upperBound, max(limits.lowerBound, zoom.scale))
            let origin = CGPoint(x: room.width / 2 - centre.x * scale, y: room.height / 2 - centre.y * scale)
            zoom = ImageZoomMath.clamped(ImageZoom(scale: scale, origin: origin), content: content, viewport: room)
        } else {
            userZoomed = false
            zoom = ImageZoomMath.fitted(content: content, viewport: room, backingScale: backingScale, margin: Self.margin)
        }
        apply(animated: false)
        publishZoom()
    }

    private func paneFrame(_ slot: Slot) -> CGRect {
        let size = bounds.size
        switch mode {
        case .single:
            return slot == .a ? CGRect(origin: .zero, size: size) : .zero
        case .slider:
            let x = (divider * size.width).rounded()
            return slot == .a
                ? CGRect(x: 0, y: 0, width: x, height: size.height)
                : CGRect(x: x, y: 0, width: max(0, size.width - x), height: size.height)
        case .sideBySide:
            let pane = viewport()
            return slot == .a
                ? CGRect(origin: .zero, size: pane)
                : CGRect(x: pane.width + Self.paneGap, y: 0, width: pane.width, height: pane.height)
        }
    }

    /// The pane's own offset from the viewport origin (the slider's B pane starts at the divider but shows the
    /// same viewport; side by side each pane is its own viewport).
    private func viewportOffset(_ slot: Slot) -> CGFloat {
        switch mode {
        case .single: return 0
        case .slider: return slot == .a ? 0 : paneFrame(.b).minX
        case .sideBySide: return 0
        }
    }

    private func flipped(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: bounds.height - rect.maxY, width: rect.width, height: rect.height)
    }

    /// A rect in a pane's top-left coordinates, flipped into the pane layer's own (bottom-left) space.
    private func flipped(_ rect: CGRect, inPaneOfHeight height: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
    }

    private func apply(animated: Bool) {
        let run = {
            let layout = self.layout
            let paneA = self.paneFrame(.a)
            let paneB = self.paneFrame(.b)
            self.paneA.frame = self.flipped(paneA)
            self.paneB.frame = self.flipped(paneB)
            self.paneB.isHidden = self.mode == .single
            if let layout {
                var a = self.zoom.frame(of: layout.a)
                a.origin.x -= self.viewportOffset(.a)
                self.imageA.frame = self.flipped(a, inPaneOfHeight: paneA.height)
                var b = self.zoom.frame(of: layout.b)
                b.origin.x -= self.viewportOffset(.b)
                self.imageB.frame = self.flipped(b, inPaneOfHeight: paneB.height)
                let pixels = self.zoom.scale * self.backingScale
                // Past 300 % each image pixel is a crisp square: what pixel peeping is for.
                let filter: CALayerContentsFilter = pixels >= 3 ? .nearest : .linear
                self.imageA.magnificationFilter = filter
                self.imageB.magnificationFilter = filter
            }
            let showsDivider = self.mode == .slider && self.pictureB != nil
            self.dividerLine.isHidden = !showsDivider
            self.knob.isHidden = !showsDivider
            if showsDivider {
                let x = paneB.minX
                self.dividerLine.frame = self.flipped(CGRect(x: x - 1, y: 0, width: 2, height: self.bounds.height))
                self.knob.frame = self.flipped(CGRect(x: x - 15, y: self.bounds.height / 2 - 15, width: 30, height: 30))
            }
            self.paneSeparator.isHidden = self.mode != .sideBySide
            if self.mode == .sideBySide {
                self.paneSeparator.frame = self.flipped(CGRect(x: paneA.maxX, y: 0, width: Self.paneGap, height: self.bounds.height))
            }
        }
        if animated && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.2)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.25, 0.8, 0.25, 1))
            run()
            CATransaction.commit()
        } else {
            withoutActions(run)
        }
    }

    private func withoutActions(_ body: () -> Void) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        body()
        CATransaction.commit()
    }

    private var lastPublished: (ImageZoom, Int)?

    private func publishZoom() {
        let percent = ImageZoomMath.percent(scale: zoom.scale, backingScale: backingScale)
        if let last = lastPublished, last.0 == zoom, last.1 == percent { return }
        lastPublished = (zoom, percent)
        onZoom?(zoom, percent)
        requestPixelsIfNeeded()
    }

    /// Asks for a sharper decode once the picture is shown with more display pixels than it has.
    private func requestPixelsIfNeeded() {
        guard let onNeedsPixels else { return }
        for (slot, picture, scale) in [(Slot.a, pictureA, CGFloat(1)), (Slot.b, pictureB, 1 / max(0.0001, layout?.bScale ?? 1))] {
            guard let picture, let image = picture.image else { continue }
            let longest = max(picture.pixelSize.width, picture.pixelSize.height)
            let have = CGFloat(max(image.width, image.height))
            guard have < longest * 0.98 else { continue }
            let need = min(longest, longest * zoom.scale * backingScale / scale)
            if need > have * 1.05 { onNeedsPixels(slot, need) }
        }
    }

    // MARK: - Zoom commands

    /// `anchor` in this view's own (bottom-left) coordinates; nil zooms about the centre of the viewport.
    func zoom(to scale: CGFloat, anchor: CGPoint?, animated: Bool) {
        guard let content = layout?.content else { return }
        let room = viewport()
        let point = anchor.map(viewportPoint) ?? CGPoint(x: room.width / 2, y: room.height / 2)
        zoom = ImageZoomMath.zoomed(zoom, to: scale, anchor: point, content: content, viewport: room, limits: limits)
        userZoomed = abs(zoom.scale - fitScale) > fitScale * 0.005
        apply(animated: animated)
        publishZoom()
    }

    func zoomStep(up: Bool, anchor: CGPoint?) {
        zoom(to: ImageZoomMath.step(from: zoom.scale, up: up, fit: fitScale, actual: actualScale), anchor: anchor, animated: true)
    }

    func zoomToFit(animated: Bool) {
        guard let content = layout?.content else { return }
        userZoomed = false
        zoom = ImageZoomMath.fitted(content: content, viewport: viewport(), backingScale: backingScale, margin: Self.margin)
        apply(animated: animated)
        publishZoom()
    }

    func zoomToActual(anchor: CGPoint?) {
        zoom(to: actualScale, anchor: anchor, animated: true)
    }

    func toggleZoom(anchor: CGPoint?) {
        let target = ImageZoomMath.toggleTarget(current: zoom.scale, fit: fitScale, actual: actualScale)
        if abs(target - fitScale) <= fitScale * 0.001 {
            zoomToFit(animated: true)
        } else {
            zoom(to: target, anchor: anchor, animated: true)
        }
    }

    func pan(by delta: CGSize) {
        guard let content = layout?.content else { return }
        let next = ImageZoomMath.panned(zoom, by: delta, content: content, viewport: viewport())
        guard next != zoom else { return }
        zoom = next
        userZoomed = true
        apply(animated: false)
        publishZoom()
    }

    /// A point of this view (bottom-left) in the viewport's top-left coordinates; the right pane side by side maps
    /// onto the same viewport, so a pinch there zooms about the same picture point in both panes.
    func viewportPoint(_ point: CGPoint) -> CGPoint {
        var top = CGPoint(x: point.x, y: bounds.height - point.y)
        if mode == .sideBySide, top.x > viewport().width {
            top.x -= viewport().width + Self.paneGap
        }
        return top
    }

    /// The pointer, when it is over the canvas.
    var pointerAnchor: CGPoint? {
        guard let window else { return nil }
        let point = convert(window.mouseLocationOutsideOfEventStream, from: nil)
        return bounds.contains(point) ? point : nil
    }

    // MARK: - Events

    public override func magnify(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        zoom(to: zoom.scale * (1 + event.magnification), anchor: point, animated: false)
    }

    public override func smartMagnify(with event: NSEvent) {
        toggleZoom(anchor: convert(event.locationInWindow, from: nil))
    }

    public override func scrollWheel(with event: NSEvent) {
        let dx = event.hasPreciseScrollingDeltas ? event.scrollingDeltaX : event.scrollingDeltaX * 12
        let dy = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 12
        if event.modifierFlags.contains(.command) {
            let point = convert(event.locationInWindow, from: nil)
            zoom(to: zoom.scale * exp(dy * 0.012), anchor: point, animated: false)
        } else {
            pan(by: CGSize(width: dx, height: dy))
        }
    }

    public override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        if event.clickCount == 2 {
            drag = nil
            toggleZoom(anchor: point)
            return
        }
        if onDivider(point) {
            drag = .divider
            return
        }
        drag = .pan(last: point)
        if canPan { NSCursor.closedHand.set() }
    }

    public override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        switch drag {
        case .divider:
            setDivider(point.x / max(1, bounds.width), notify: true)
        case .pan(let last):
            pan(by: CGSize(width: point.x - last.x, height: last.y - point.y))
            drag = .pan(last: point)
        case nil:
            break
        }
    }

    public override func mouseUp(with event: NSEvent) {
        drag = nil
        updateCursor(at: convert(event.locationInWindow, from: nil))
    }

    public override func mouseMoved(with event: NSEvent) {
        updateCursor(at: convert(event.locationInWindow, from: nil))
    }

    public override func mouseExited(with event: NSEvent) {
        NSCursor.arrow.set()
    }

    private var canPan: Bool {
        guard let content = layout?.content else { return false }
        let room = viewport()
        return content.width * zoom.scale > room.width + 0.5 || content.height * zoom.scale > room.height + 0.5
    }

    private func onDivider(_ point: CGPoint) -> Bool {
        mode == .slider && pictureB != nil && abs(point.x - paneFrame(.b).minX) <= Self.dividerGrab
    }

    private func updateCursor(at point: CGPoint) {
        if onDivider(point) {
            NSCursor.resizeLeftRight.set()
        } else if canPan {
            NSCursor.openHand.set()
        } else {
            NSCursor.arrow.set()
        }
    }

    private func updateTracking() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
    }

    // MARK: - Accessibility

    public override func isAccessibilityElement() -> Bool { true }
    public override func accessibilityRole() -> NSAccessibility.Role? { mode == .slider ? .slider : .image }

    public override func accessibilityValue() -> Any? {
        mode == .slider ? NSNumber(value: Double(divider)) : nil
    }

    public override func accessibilityPerformIncrement() -> Bool {
        guard mode == .slider else { return false }
        setDivider(divider + 0.05, notify: true)
        return true
    }

    public override func accessibilityPerformDecrement() -> Bool {
        guard mode == .slider else { return false }
        setDivider(divider - 0.05, notify: true)
        return true
    }

    private static func knobGlyph(scale: CGFloat) -> CGImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 12, weight: .bold)
        guard let symbol = NSImage(systemSymbolName: "arrow.left.and.right", accessibilityDescription: nil)?
            .withSymbolConfiguration(config) else { return nil }
        let size = symbol.size
        let pixels = CGSize(width: (size.width * scale).rounded(.up), height: (size.height * scale).rounded(.up))
        guard let context = CGContext(data: nil, width: Int(pixels.width), height: Int(pixels.height), bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let graphics = NSGraphicsContext(cgContext: context, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = graphics
        let rect = CGRect(origin: .zero, size: pixels)
        symbol.draw(in: rect)
        NSColor.white.set()
        rect.fill(using: .sourceAtop)
        NSGraphicsContext.restoreGraphicsState()
        return context.makeImage()
    }
}

/// The canvas inside SwiftUI. The model owns the view, so commands reach it without a render.
struct ImageViewerCanvas: NSViewRepresentable {
    let canvas: ImageViewerCanvasView

    func makeNSView(context: Context) -> ImageViewerCanvasView { canvas }

    func updateNSView(_ view: ImageViewerCanvasView, context: Context) {}
}
