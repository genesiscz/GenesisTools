import AppKit

/// One picture the image viewer can show: a readable local file the host already admitted.
public struct ImageViewerItem: Identifiable, Hashable, Sendable {
    /// Stable within its source (Genesis: the page's image number), so the source can find it again.
    public let id: String
    public let path: String
    public let name: String
    /// Items with the same group sit together in their source (one table row: a before and its after).
    public let group: String?
    /// Made from an embedded picture (a `data:` URL), so there is no file of the user's to reveal.
    public let isTemporary: Bool

    public init(id: String, path: String, name: String? = nil, group: String? = nil, isTemporary: Bool = false) {
        self.id = id
        self.path = path
        self.name = name ?? (path as NSString).lastPathComponent
        self.group = group
        self.isTemporary = isTemporary
    }
}

/// How the viewer shows the content: points per image pixel, and where the content's top-left corner sits in the
/// viewport. Viewport coordinates have their origin at the top left and y growing down.
public struct ImageZoom: Equatable, Sendable {
    public var scale: CGFloat
    public var origin: CGPoint

    public init(scale: CGFloat, origin: CGPoint) {
        self.scale = scale
        self.origin = origin
    }

    public func viewPoint(_ content: CGPoint) -> CGPoint {
        CGPoint(x: origin.x + content.x * scale, y: origin.y + content.y * scale)
    }

    public func contentPoint(_ view: CGPoint) -> CGPoint {
        CGPoint(x: (view.x - origin.x) / scale, y: (view.y - origin.y) / scale)
    }

    /// A rect in content pixels as it lies in the viewport.
    public func frame(of rect: CGRect) -> CGRect {
        CGRect(x: origin.x + rect.minX * scale, y: origin.y + rect.minY * scale,
               width: rect.width * scale, height: rect.height * scale)
    }
}

/// The viewer's zoom and pan, as pure functions of the content size (image pixels) and the viewport (points).
public enum ImageZoomMath {
    /// 100 %: one image pixel on one display pixel, so a Retina screenshot shows at its real on-screen size.
    public static func actualScale(backingScale: CGFloat) -> CGFloat {
        1 / max(1, backingScale)
    }

    /// The scale that shows the whole content inside the viewport, never above 100 %.
    public static func fitScale(content: CGSize, viewport: CGSize, backingScale: CGFloat, margin: CGFloat = 0) -> CGFloat {
        let actual = actualScale(backingScale: backingScale)
        guard content.width > 0, content.height > 0 else { return actual }
        let width = max(1, viewport.width - margin * 2)
        let height = max(1, viewport.height - margin * 2)
        return min(actual, min(width / content.width, height / content.height))
    }

    /// From the fit (or 100 % for a picture smaller than the viewport) to 32 × 100 %.
    public static func limits(fit: CGFloat, actual: CGFloat) -> ClosedRange<CGFloat> {
        min(fit, actual)...(actual * 32)
    }

    public static func fitted(content: CGSize, viewport: CGSize, backingScale: CGFloat, margin: CGFloat = 0) -> ImageZoom {
        let scale = fitScale(content: content, viewport: viewport, backingScale: backingScale, margin: margin)
        return clamped(ImageZoom(scale: scale, origin: .zero), content: content, viewport: viewport)
    }

    /// Centres an axis the content does not fill; otherwise keeps the content's edges at or past the viewport's,
    /// so a pan never opens an empty band beside the picture.
    public static func clamped(_ zoom: ImageZoom, content: CGSize, viewport: CGSize) -> ImageZoom {
        func axis(_ origin: CGFloat, _ length: CGFloat, _ room: CGFloat) -> CGFloat {
            let scaled = length * zoom.scale
            if scaled <= room { return ((room - scaled) / 2).rounded(.toNearestOrEven) }
            return min(0, max(room - scaled, origin))
        }
        return ImageZoom(
            scale: zoom.scale,
            origin: CGPoint(x: axis(zoom.origin.x, content.width, viewport.width),
                            y: axis(zoom.origin.y, content.height, viewport.height)))
    }

    /// Zooms to `scale` (clamped to `limits`) keeping the content point under `anchor` where it is: the cursor or
    /// the pinch point stays on the same pixel.
    public static func zoomed(_ zoom: ImageZoom, to scale: CGFloat, anchor: CGPoint, content: CGSize, viewport: CGSize,
                              limits: ClosedRange<CGFloat>) -> ImageZoom
    {
        let next = min(limits.upperBound, max(limits.lowerBound, scale))
        let pinned = zoom.contentPoint(anchor)
        let origin = CGPoint(x: anchor.x - pinned.x * next, y: anchor.y - pinned.y * next)
        return clamped(ImageZoom(scale: next, origin: origin), content: content, viewport: viewport)
    }

    public static func panned(_ zoom: ImageZoom, by delta: CGSize, content: CGSize, viewport: CGSize) -> ImageZoom {
        clamped(ImageZoom(scale: zoom.scale, origin: CGPoint(x: zoom.origin.x + delta.width, y: zoom.origin.y + delta.height)),
                content: content, viewport: viewport)
    }

    /// The stops ⌘+ and ⌘− move between, as multiples of 100 %.
    public static let ladder: [CGFloat] = [0.05, 0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32]

    /// The next stop up or down from `scale`: a ladder step or the fit, whichever is nearer.
    public static func step(from scale: CGFloat, up: Bool, fit: CGFloat, actual: CGFloat) -> CGFloat {
        let range = limits(fit: fit, actual: actual)
        let stops = (ladder.map { $0 * actual } + [fit]).filter { range.contains($0) }.sorted()
        if up {
            return stops.first { $0 > scale * 1.01 } ?? range.upperBound
        }
        return stops.last { $0 < scale * 0.99 } ?? range.lowerBound
    }

    /// Double-click: from the fit to 100 % (200 % for a picture that already fits at 100 %), from anywhere else
    /// back to the fit.
    public static func toggleTarget(current: CGFloat, fit: CGFloat, actual: CGFloat) -> CGFloat {
        guard abs(current - fit) <= fit * 0.01 else { return fit }
        return fit < actual * 0.99 ? actual : actual * 2
    }

    /// "68 %" as the label shows it.
    public static func percent(scale: CGFloat, backingScale: CGFloat) -> Int {
        Int((scale * max(1, backingScale) * 100).rounded())
    }
}

/// Two pictures in one frame: B is scaled to A's width, and their top edges line up (screenshots of one window
/// before and after share the top). Rects are in A's pixels.
public struct CompareLayout: Equatable, Sendable {
    public let a: CGRect
    public let b: CGRect
    public let content: CGSize
    /// B's pixels per content pixel: 1 when both are the same width.
    public let bScale: CGFloat

    public var scalesB: Bool { abs(bScale - 1) > 0.001 }

    public static func make(a: CGSize, b: CGSize) -> CompareLayout {
        let aSize = CGSize(width: max(1, a.width), height: max(1, a.height))
        let bScale = b.width > 0 ? aSize.width / b.width : 1
        let bHeight = max(1, b.height * bScale)
        let bRect = CGRect(x: 0, y: 0, width: aSize.width, height: bHeight)
        return CompareLayout(
            a: CGRect(origin: .zero, size: aSize), b: bRect,
            content: CGSize(width: aSize.width, height: max(aSize.height, bHeight)), bScale: bScale)
    }

    /// "B is scaled to A's width (1600 × 1000 → 3200 × 2000)", or nil when nothing was scaled.
    public func note(aPixels: CGSize, bPixels: CGSize) -> String? {
        guard scalesB else { return nil }
        let to = CGSize(width: b.width.rounded(), height: b.height.rounded())
        return "B is scaled to A's width (\(Self.size(bPixels)) → \(Self.size(to)))"
    }

    static func size(_ size: CGSize) -> String {
        "\(Int(size.width.rounded())) × \(Int(size.height.rounded()))"
    }
}

/// Where an image of a WKWebView page is on screen. `getBoundingClientRect()` answers in CSS pixels of the page's
/// scaled viewport: one CSS pixel is `pageZoom × magnification` points of the web view (measured 2026-10-11 with a
/// pinch magnification and a text zoom; `visualViewport` offsets stay 0, the page scrolls instead). WKWebView is
/// flipped, so the result is in its own top-left coordinates and `convert(_:to:)` takes it from there.
public enum WebImageRect {
    public static func viewRect(css: CGRect, pageZoom: CGFloat, magnification: CGFloat) -> CGRect {
        let scale = max(0.01, pageZoom) * max(0.01, magnification)
        return CGRect(x: css.minX * scale, y: css.minY * scale, width: css.width * scale, height: css.height * scale)
    }

    /// The share of `rect` that lies inside `visible`, 0 to 1.
    public static func visibleFraction(of rect: CGRect, in visible: CGRect) -> CGFloat {
        let area = rect.width * rect.height
        guard area > 0 else { return 0 }
        let shown = rect.intersection(visible)
        guard !shown.isNull else { return 0 }
        return (shown.width * shown.height) / area
    }

    /// Enough of the image is on screen to zoom from it (or back into it).
    public static func isVisible(_ rect: CGRect, in visible: CGRect) -> Bool {
        visibleFraction(of: rect, in: visible) >= 0.4
    }
}

/// Where the viewer window opens: its remembered size (or most of the screen), never larger than the screen's
/// visible area less a margin, centred on it.
public enum ImageViewerPlacement {
    public static let minSize = CGSize(width: 640, height: 420)
    public static let margin: CGFloat = 40

    public static func frame(remembered: CGSize?, visible: CGRect) -> CGRect {
        let room = CGSize(width: max(minSize.width, visible.width - margin * 2),
                          height: max(minSize.height, visible.height - margin * 2))
        let wanted = remembered.flatMap { $0.width > 0 && $0.height > 0 ? $0 : nil }
            ?? CGSize(width: (visible.width * 0.82).rounded(), height: (visible.height * 0.86).rounded())
        let size = CGSize(width: min(room.width, max(minSize.width, wanted.width)),
                          height: min(room.height, max(minSize.height, wanted.height)))
        return CGRect(x: (visible.midX - size.width / 2).rounded(), y: (visible.midY - size.height / 2).rounded(),
                      width: size.width, height: size.height)
    }
}

/// Which images "Compare with…" offers, and in what order.
public enum ImageViewerOrdering {
    /// The images that share the current one's group (its table row: for a before, its after) first, then every
    /// other image in document order. The current file and repeats of one file are left out.
    public static func compareCandidates(_ items: [ImageViewerItem], current: ImageViewerItem)
        -> (sameRow: [ImageViewerItem], others: [ImageViewerItem])
    {
        var seen: Set<String> = [current.path]
        var sameRow: [ImageViewerItem] = []
        var others: [ImageViewerItem] = []
        for item in items where item.group != nil && item.group == current.group && seen.insert(item.path).inserted {
            sameRow.append(item)
        }
        for item in items where seen.insert(item.path).inserted {
            others.append(item)
        }
        return (sameRow, others)
    }

    /// ← / → while comparing. A pair from one row moves to the next row (or the previous one) that has both of its
    /// places, keeping each picture's place in its row: before | after moves to the next before | after. Any other
    /// pair moves A by one and keeps B. Nil at either end.
    public static func stepPair(_ items: [ImageViewerItem], a: Int, b: Int, by delta: Int) -> (a: Int, b: Int)? {
        guard items.indices.contains(a), items.indices.contains(b), delta != 0 else { return nil }
        if let group = items[a].group, items[b].group == group {
            var rows: [String] = []
            var members: [String: [Int]] = [:]
            for (index, item) in items.enumerated() {
                guard let key = item.group else { continue }
                if members[key] == nil { rows.append(key) }
                members[key, default: []].append(index)
            }
            guard let row = rows.firstIndex(of: group), let current = members[group],
                  let placeA = current.firstIndex(of: a), let placeB = current.firstIndex(of: b) else { return nil }
            var next = row + (delta > 0 ? 1 : -1)
            while rows.indices.contains(next) {
                if let candidate = members[rows[next]], candidate.count > max(placeA, placeB) {
                    return (candidate[placeA], candidate[placeB])
                }
                next += delta > 0 ? 1 : -1
            }
            return nil
        }
        let next = a + (delta > 0 ? 1 : -1)
        return items.indices.contains(next) ? (next, b) : nil
    }
}

/// What a key does in the viewer. The window's key handler asks first; nil leaves the key to the app.
public enum ImageViewerAction: Equatable, Sendable {
    case dismiss, close, previous, next, zoomIn, zoomOut, fit, actualSize, copy
    case divider(CGFloat)
    case pickerMove(dx: Int, dy: Int), pickerChoose
}

/// The viewer's keys, read from `ImageViewerKeymap`. The window asks this before a control sees the press.
public enum ImageViewerKeys {
    public static func action(keyCode: UInt16, characters: String?, modifiers: NSEvent.ModifierFlags, picking: Bool,
                              comparing: Bool) -> ImageViewerAction?
    {
        let stroke = KeyStroke(keyCode: keyCode, character: characters ?? "", modifiers: KeyModifiers(modifiers))
        return MainActor.assumeIsolated {
            let keymap = ImageViewerKeymap.shared
            if picking, let id = keymap.commands(for: stroke, in: [ImageViewerKeymap.pickerScope]).first?.id {
                return pickerAction(id)
            }
            guard let id = keymap.commands(for: stroke, in: [.window]).first?.id else { return nil }
            return windowAction(id, stroke, comparing: comparing)
        }
    }

    private static func pickerAction(_ id: String) -> ImageViewerAction? {
        switch id {
        case ImageViewerKeymap.pickerLeft: return .pickerMove(dx: -1, dy: 0)
        case ImageViewerKeymap.pickerRight: return .pickerMove(dx: 1, dy: 0)
        case ImageViewerKeymap.pickerUp: return .pickerMove(dx: 0, dy: -1)
        case ImageViewerKeymap.pickerDown: return .pickerMove(dx: 0, dy: 1)
        case ImageViewerKeymap.pickerChoose: return .pickerChoose
        default: return nil
        }
    }

    private static func windowAction(_ id: String, _ stroke: KeyStroke, comparing: Bool) -> ImageViewerAction? {
        switch id {
        case ImageViewerKeymap.zoomIn: return .zoomIn
        case ImageViewerKeymap.zoomOut: return .zoomOut
        case ImageViewerKeymap.fit: return .fit
        case ImageViewerKeymap.actualSize: return .actualSize
        case ImageViewerKeymap.copy: return .copy
        case ImageViewerKeymap.close: return .close
        case ImageViewerKeymap.back: return .dismiss
        case ImageViewerKeymap.previous: return .previous
        case ImageViewerKeymap.next: return .next
        case ImageViewerKeymap.dividerLeft, ImageViewerKeymap.dividerRight:
            guard comparing else { return nil }
            let sign: CGFloat = id == ImageViewerKeymap.dividerLeft ? -1 : 1
            return .divider(sign * (stroke.modifiers.contains(.shift) ? 0.01 : 0.05))
        default: return nil
        }
    }
}
