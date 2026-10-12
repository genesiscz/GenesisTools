import AppKit
import QuartzCore

/// The picture flying between its place on the page and the viewer. A borderless, click-through panel above the
/// viewer holds a clip layer (the page's visible area at one end, the canvas at the other) and the picture inside
/// it; Core Animation moves both, so the motion runs in the render server at the display's rate whatever the main
/// thread does. The viewer window is already built and laid out underneath, and fades in while the picture flies.
@MainActor
final class ImageViewerTransition: NSObject {
    /// One end of the flight, in screen coordinates.
    struct Frame: Equatable {
        var clip: CGRect
        var image: CGRect
        var cornerRadius: CGFloat
    }

    private let panel: NSPanel
    private let clipLayer = CALayer()
    private let imageLayer = CALayer()
    private var link: CADisplayLink?
    private var timing: AnimationTiming
    private let label: String
    private var completion: (() -> Void)?
    private(set) var isRunning = false

    /// `startedAt` is when the user asked (the double-click reached the app), so the logged `first=` is the time
    /// from the request to the first frame.
    init(level: NSWindow.Level, covering frames: [Frame], label: String, startedAt: CFTimeInterval) {
        let union = frames.reduce(CGRect.null) { $0.union($1.clip) }.integral
        panel = NSPanel(contentRect: union.isNull ? .zero : union, styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.isReleasedWhenClosed = false
        panel.level = NSWindow.Level(rawValue: level.rawValue + 1)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        panel.animationBehavior = .none
        timing = AnimationTiming(at: startedAt)
        self.label = label
        super.init()
        let host = NSView(frame: CGRect(origin: .zero, size: panel.frame.size))
        let root = CALayer()
        host.layer = root
        host.wantsLayer = true
        clipLayer.masksToBounds = true
        imageLayer.masksToBounds = true
        imageLayer.contentsGravity = .resize
        imageLayer.minificationFilter = .trilinear
        clipLayer.addSublayer(imageLayer)
        root.addSublayer(clipLayer)
        panel.contentView = host
    }

    /// Flies the picture (or a placeholder of its shape) from `from` to `to`.
    func run(image: CGImage?, placeholder: NSColor, from: Frame, to: Frame, duration: CFTimeInterval,
             curve: CAMediaTimingFunction, completion: @escaping () -> Void)
    {
        self.completion = completion
        isRunning = true
        let scale = NSScreen.screens.first { $0.frame.intersects(to.clip) }?.backingScaleFactor ?? 2
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for layer in [clipLayer, imageLayer] { layer.contentsScale = scale }
        imageLayer.contents = image
        imageLayer.backgroundColor = image == nil ? placeholder.cgColor : nil
        place(to)
        CATransaction.commit()
        panel.orderFrontRegardless()

        let start = local(from)
        let end = local(to)
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated { self?.finished() }
        }
        for (layer, a, b) in [(clipLayer, start.clip, end.clip), (imageLayer, start.image, end.image)] {
            add("bounds", NSValue(rect: CGRect(origin: .zero, size: a.size)), NSValue(rect: CGRect(origin: .zero, size: b.size)),
                to: layer, duration: duration, curve: curve)
            add("position", NSValue(point: CGPoint(x: a.midX, y: a.midY)), NSValue(point: CGPoint(x: b.midX, y: b.midY)),
                to: layer, duration: duration, curve: curve)
        }
        add("cornerRadius", NSNumber(value: Double(from.cornerRadius)), NSNumber(value: Double(to.cornerRadius)),
            to: imageLayer, duration: duration, curve: curve)
        CATransaction.commit()

        let host = panel.contentView
        link = host?.displayLink(target: self, selector: #selector(frame(_:)))
        link?.add(to: .main, forMode: .common)
    }

    /// The picture when it is the new image in a window already shown (no flight): the swap is instant.
    func setImage(_ image: CGImage?) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.contents = image
        imageLayer.backgroundColor = nil
        CATransaction.commit()
    }

    /// Fades the landed picture out (it now sits exactly on its twin) and closes the panel.
    func fadeOut(duration: CFTimeInterval, then: (() -> Void)? = nil) {
        guard panel.isVisible else {
            then?()
            return
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            panel.animator().alphaValue = 0
        }, completionHandler: { [self] in
            MainActor.assumeIsolated {
                close()
                then?()
            }
        })
    }

    /// Ends at once: the picture is removed and the completion runs (an interrupted open).
    func cancel() {
        guard isRunning else {
            close()
            return
        }
        clipLayer.removeAllAnimations()
        imageLayer.removeAllAnimations()
        finished()
        close()
    }

    func close() {
        link?.invalidate()
        link = nil
        panel.orderOut(nil)
        panel.close()
    }

    private func finished() {
        guard isRunning else { return }
        isRunning = false
        link?.invalidate()
        link = nil
        PerfLog.mark("imageviewer.transition \(label) \(timing.summary(outcome: "done").description)")
        let done = completion
        completion = nil
        done?()
    }

    @objc private func frame(_ link: CADisplayLink) {
        let now = CACurrentMediaTime()
        timing.record(startedAt: now, finishedAt: now)
    }

    private func place(_ frame: Frame) {
        let local = local(frame)
        clipLayer.frame = local.clip
        imageLayer.frame = local.image
        imageLayer.cornerRadius = frame.cornerRadius
    }

    /// Screen rects into the panel's own coordinates: the clip relative to the panel, the image relative to the clip.
    private func local(_ frame: Frame) -> Frame {
        let origin = panel.frame.origin
        let clip = frame.clip.offsetBy(dx: -origin.x, dy: -origin.y)
        let image = frame.image.offsetBy(dx: -frame.clip.minX, dy: -frame.clip.minY)
        return Frame(clip: clip, image: image, cornerRadius: frame.cornerRadius)
    }

    private func add(_ keyPath: String, _ from: Any, _ to: Any, to layer: CALayer, duration: CFTimeInterval,
                     curve: CAMediaTimingFunction)
    {
        let animation = CABasicAnimation(keyPath: keyPath)
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.timingFunction = curve
        layer.add(animation, forKey: keyPath)
    }
}
