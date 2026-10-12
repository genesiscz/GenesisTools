import AppKit

/// Renders the real viewer window at a given state into a bitmap, off screen: alpha 0, below the desktop, never key
/// and never active, so it can run while someone works. Tests use it for pixel checks and to write PNGs of each state.
@MainActor
public enum ImageViewerSnapshot {
    public enum State: Equatable {
        case single
        /// `multiple` of 100 % (1 = 100 %) about a point given as fractions of the canvas (0.5, 0.5 is its centre).
        case zoomed(multiple: CGFloat, anchor: CGPoint)
        case picker
        case compare(bID: String, mode: ImageViewerModel.CompareMode, divider: CGFloat)
    }

    /// What a render produced: the frame view's bitmap and the model at that state, for assertions.
    public struct Result {
        public let bitmap: NSBitmapImageRep
        public let model: ImageViewerModel
        /// Picture A's frame in the bitmap's points, top-left origin.
        public let pictureA: CGRect?
        /// The canvas in the bitmap's points, top-left origin.
        public let canvas: CGRect
        /// The title bar check without the "flat band under the strip" rule: the canvas letterboxes the picture,
        /// so a flat margin under the strip is the picture's border, not a header padded down.
        public let titlebar: WindowTitlebar.Audit
    }

    private final class Owner {}

    public static func render(items: [ImageViewerItem], selectedID: String, state: State,
                              size: CGSize = CGSize(width: 1180, height: 760),
                              background: NSColor = ImageViewerRequest.defaultBackground) async -> Result?
    {
        guard let controller = await host(items: items, selectedID: selectedID, size: size, background: background)
        else { return nil }
        defer { controller.closeNow() }
        await apply(state, to: controller)
        return capture(controller)
    }

    /// The viewer window off screen, laid out, its picture decoded. The caller closes it (`closeNow()`).
    static func host(items: [ImageViewerItem], selectedID: String, size: CGSize,
                     background: NSColor = ImageViewerRequest.defaultBackground) async -> ImageViewerWindowController?
    {
        let request = ImageViewerRequest(ownerID: ObjectIdentifier(Owner()), items: items, selectedID: selectedID,
                                         background: background)
        let controller = ImageViewerWindowController(
            request: request, frame: CGRect(x: -30000, y: -30000, width: size.width, height: size.height))
        controller.remembersSize = false
        guard let window = controller.window else { return nil }
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        window.layoutIfNeeded()
        window.contentView?.layoutSubtreeIfNeeded()
        controller.model.start()
        await controller.model.waitUntilLoaded()
        return controller
    }

    static func apply(_ state: State, to controller: ImageViewerWindowController) async {
        let model = controller.model
        switch state {
        case .single:
            break
        case .zoomed(let multiple, let anchor):
            let canvas = model.canvas
            let point = CGPoint(x: canvas.bounds.width * anchor.x, y: canvas.bounds.height * (1 - anchor.y))
            canvas.zoom(to: canvas.actualScale * multiple, anchor: point, animated: false)
            await model.waitUntilLoaded()
        case .picker:
            model.openPicker()
            // The tiles ask for their pictures as they appear; decode them first so the shot shows pictures.
            let pixels = 128 * (controller.window?.backingScaleFactor ?? 2)
            for item in model.pickerItems.sameRow + model.pickerItems.others {
                _ = await MediaThumbnailCache.shared.thumbnail(path: item.path, maxPixels: pixels, kind: .image)
            }
        case .compare(let bID, let mode, let divider):
            if let b = model.items.first(where: { $0.id == bID }) {
                model.compare(with: b)
                model.setCompareMode(mode)
                model.canvas.setDivider(divider, notify: true)
                await model.waitUntilLoaded()
            }
        }
        // SwiftUI applies the state, and the picker's tiles show their decoded pictures, over the next turns.
        try? await Task.sleep(for: .milliseconds(450))
        controller.window?.contentView?.layoutSubtreeIfNeeded()
    }

    static func capture(_ controller: ImageViewerWindowController) -> Result? {
        guard let window = controller.window, let frameView = window.contentView?.superview,
              let bitmap = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) else { return nil }
        frameView.cacheDisplay(in: frameView.bounds, to: bitmap)
        let canvas = controller.model.canvas
        let height = frameView.bounds.height
        func topLeft(_ rect: CGRect) -> CGRect {
            let inFrame = frameView.convert(canvas.convert(rect, to: nil), from: nil)
            return CGRect(x: inFrame.minX, y: height - inFrame.maxY, width: inFrame.width, height: inFrame.height)
        }
        return Result(bitmap: bitmap, model: controller.model, pictureA: canvas.displayedRectA.map(topLeft),
                      canvas: topLeft(canvas.bounds), titlebar: WindowTitlebar.audit(window))
    }
}
