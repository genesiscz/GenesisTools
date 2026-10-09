import CoreGraphics
import CoreImage
import Foundation

/// One selected window of an isolated recording. `Frame` is the last complete ScreenCaptureKit
/// surface in the recorder and a synthetic image in tests: the visibility, readiness and
/// stacking rules never look inside it.
public struct IsolatedLayer<Frame> {
    public let id: CGWindowID
    public let pid: pid_t
    public var bounds: CGRect
    public var visible = true
    /// The window's stream stopped. The layer stays out of the movie even if the window returns.
    public var ended = false
    public var frame: Frame?

    public init(id: CGWindowID, pid: pid_t, bounds: CGRect) {
        self.id = id
        self.pid = pid
        self.bounds = bounds
    }
}

/// One on-screen CG window, as the front-to-back window list reports it.
public struct IsolatedWindowRow: Equatable {
    public let id: CGWindowID
    public let pid: pid_t
    public let bounds: CGRect

    public init(id: CGWindowID, pid: pid_t, bounds: CGRect) {
        self.id = id
        self.pid = pid
        self.bounds = bounds
    }
}

public struct IsolatedLayers<Frame> {
    /// Front-to-back, in the order of the latest on-screen window list.
    public private(set) var layers: [IsolatedLayer<Frame>]
    /// Set by the first composite frame. Before it, every visible window needs a frame, so the
    /// movie does not open without a window whose stream started a moment later. After it, a
    /// window without a frame is skipped and the others keep recording.
    public private(set) var started = false
    public private(set) var warnings: [String] = []
    private var returnedAfterEnd: Set<CGWindowID> = []

    public init(_ layers: [IsolatedLayer<Frame>]) {
        self.layers = layers
    }

    /// Bounds of each layer in stacking order; `.null` while hidden. A change forces a frame.
    public var geometry: [CGRect] { layers.map { $0.visible ? $0.bounds : .null } }

    public var readyToRender: Bool {
        started || layers.filter(\.visible).allSatisfy { $0.frame != nil }
    }

    /// Visible layers that have a frame, back to front: the order to paint them in.
    public var paintOrder: [IsolatedLayer<Frame>] {
        layers.reversed().filter { $0.visible && $0.frame != nil }
    }

    public func layer(_ id: CGWindowID) -> IsolatedLayer<Frame>? {
        layers.first { $0.id == id }
    }

    public mutating func markRendered() {
        started = true
    }

    public mutating func receive(_ frame: Frame, for id: CGWindowID) {
        guard let index = layers.firstIndex(where: { $0.id == id }), !layers[index].ended else { return }
        layers[index].frame = frame
    }

    /// A stream stop is fatal while its window is still on screen; the return value says so.
    /// A window that left the screen (closed, minimized) only drops out of the movie.
    public mutating func streamEnded(id: CGWindowID, windowPresent: Bool) -> Bool {
        guard let index = layers.firstIndex(where: { $0.id == id }) else { return false }
        layers[index].ended = true
        layers[index].visible = false
        layers[index].frame = nil
        if windowPresent {
            return true
        }

        warnings.append("window \(id) left the screen and its stream ended; it is excluded from the rest of the recording")
        return false
    }

    /// Applies one front-to-back window list and returns whether the geometry changed.
    @discardableResult
    public mutating func refresh(_ rows: [IsolatedWindowRow]) -> Bool {
        let before = geometry
        for index in layers.indices {
            let layer = layers[index]
            guard let row = rows.first(where: { $0.id == layer.id && $0.pid == layer.pid }) else {
                layers[index].visible = false
                layers[index].frame = nil
                continue
            }

            if layer.ended {
                // An ended stream delivers nothing. Marking it visible would hold the window's
                // place with no frame, so it stays out and the outcome is reported once.
                if returnedAfterEnd.insert(layer.id).inserted {
                    warnings.append("window \(layer.id) returned after its stream ended; it stays out of this recording")
                }
                continue
            }

            layers[index].visible = true
            layers[index].bounds = row.bounds
        }
        let order = Dictionary(rows.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        layers = layers.enumerated()
            .sorted { (order[$0.element.id] ?? Int.max, $0.offset) < (order[$1.element.id] ?? Int.max, $1.offset) }
            .map(\.element)
        return before != geometry
    }
}

/// One window surface to paint into the fixed output.
public struct IsolatedPaint {
    public let image: CIImage
    /// Surface pixels with a top-left origin; nil means the whole surface.
    public let contentRect: CGRect?
    /// Global CG points.
    public let bounds: CGRect

    public init(image: CIImage, contentRect: CGRect?, bounds: CGRect) {
        self.image = image
        self.contentRect = contentRect
        self.bounds = bounds
    }
}

/// Paints `layers` (back to front) into the output. Padding stays transparent when asked.
public func composeIsolatedFrame(_ layers: [IsolatedPaint], geometry: CaptureCanvasGeometry, transparent: Bool) -> CIImage {
    let outputRect = CGRect(origin: .zero, size: geometry.output)
    var image = CIImage(color: transparent ? CIColor.clear : CIColor.black).cropped(to: outputRect)
    for layer in layers {
        let full = layer.image
        // SCK may letterbox a window for a frame while a resize configuration is in flight.
        // contentRect is in surface pixels with a top-left origin; CI uses bottom-left.
        let topRect = layer.contentRect ?? full.extent
        let content = CGRect(x: topRect.minX, y: full.extent.height - topRect.maxY, width: topRect.width, height: topRect.height)
            .intersection(full.extent)
        guard !content.isEmpty, !content.isNull else { continue }
        let raw = full.cropped(to: content).transformed(by: CGAffineTransform(translationX: -content.minX, y: -content.minY))
        let destination = geometry.destination(for: layer.bounds)
        let placed = raw.transformed(by: CGAffineTransform(scaleX: destination.width / raw.extent.width,
                                                           y: destination.height / raw.extent.height))
            .transformed(by: CGAffineTransform(translationX: destination.minX, y: destination.minY))
        image = placed.composited(over: image)
    }
    return image.cropped(to: outputRect)
}

/// Rate limit for composite frames that never drops the last update. A throttled request
/// schedules one trailing frame at the next permitted time instead of being discarded.
public struct RenderThrottle {
    public enum Decision: Equatable {
        case render
        case schedule(after: Double)
        case coalesced
    }

    public private(set) var lastRender = -Double.infinity
    /// Session time of the first composite frame. Kept frames measure from it, so geometry does too.
    public private(set) var firstRender: Double?
    /// Content arrived since the last composite frame.
    public private(set) var pending = false
    private var trailingScheduled = false

    public init() {}

    public mutating func request(at elapsed: Double, interval: Double, force: Bool) -> Decision {
        if force || elapsed - lastRender >= interval {
            return .render
        }

        pending = true
        if trailingScheduled {
            return .coalesced
        }

        trailingScheduled = true
        return .schedule(after: interval - (elapsed - lastRender))
    }

    /// The trailing timer fired. True when content still waits for a frame.
    public mutating func trailingFired() -> Bool {
        trailingScheduled = false
        return pending
    }

    /// Records a composite frame at session time `elapsed` and returns its movie time in seconds.
    public mutating func rendered(at elapsed: Double) -> Double {
        lastRender = elapsed
        pending = false
        let first = firstRender ?? elapsed
        firstRender = first
        return elapsed - first
    }
}
