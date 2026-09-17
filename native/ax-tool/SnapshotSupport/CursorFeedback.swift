import AppKit
import QuartzCore
import CoreText

public struct CursorFeedbackEvent: Codable {
    public var action: String
    public var x: Double?
    public var y: Double?
    public var background: Bool
    public var target: String
    public init(action: String, point: CGPoint?, background: Bool = false, target: String = "ax") {
        self.action = action
        self.x = point.map { Double($0.x) }
        self.y = point.map { Double($0.y) }
        self.background = background
        self.target = target
    }
    public var point: CGPoint? {
        guard let x, let y, x.isFinite, y.isFinite, abs(x) < 100_000, abs(y) < 100_000 else { return nil }
        return CGPoint(x: x, y: y)
    }
    public var valid: Bool {
        Self.actions.contains(action) && (x == nil && y == nil || point != nil) && ["ax", "pixel", "desktop"].contains(target)
    }
    public static let actions: Set<String> = ["idle", "click", "drag", "scroll", "text", "key", "navigate", "app", "transfer", "system", "hide"]
    public static func semantic(_ verb: String) -> String? {
        switch verb {
        case "press", "click", "perform": return "click"
        case "move": return "idle"
        case "drag": return "drag"
        case "scroll": return "scroll"
        case "set", "type", "select": return "text"
        case "paste": return "transfer"
        case "key", "hotkey": return "key"
        case "focus": return "navigate"
        case "window", "resize", "minimize", "maximize", "close": return "app"
        default: return nil
        }
    }
}

public enum CursorMotion {
    public static func viewPoint(_ point: CGPoint, desktop: CGRect, primaryTop: CGFloat) -> CGPoint {
        CGPoint(x: point.x - desktop.minX, y: point.y + desktop.maxY - primaryTop)
    }
    public static func duration(from: CGPoint, to: CGPoint) -> Double {
        min(0.65, max(0.08, hypot(to.x-from.x, to.y-from.y)/900))
    }
    public static func points(from: CGPoint, to: CGPoint, reduced: Bool = false) -> [CGPoint] {
        if reduced { return [to] }
        let dx = to.x-from.x, dy = to.y-from.y
        let arc: CGFloat = hypot(dx, dy) > 80 ? 0.12 : 0
        let c1 = CGPoint(x: from.x + dx*0.3 - dy*arc, y: from.y + dy*0.3 + dx*arc)
        let c2 = CGPoint(x: to.x - dx*0.3 - dy*arc, y: to.y - dy*0.3 + dx*arc)
        return (0...30).map { index in
            let raw = CGFloat(index)/30, t = raw*raw*(3-2*raw), u = 1-t
            return CGPoint(x: u*u*u*from.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*to.x,
                           y: u*u*u*from.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*to.y)
        }
    }
}

private struct ThemeShape: Decodable {
    var kind: String
    var vertices: [[CGFloat]]?
    var incoming: [[CGFloat]]?
    var outgoing: [[CGFloat]]?
    var closed: Bool?
    var position: [CGFloat]?
    var size: [CGFloat]?
    var radius: CGFloat?
    func path() -> CGPath {
        let path = CGMutablePath()
        if kind == "path", let vertices, let incoming, let outgoing, !vertices.isEmpty {
            path.move(to: CGPoint(x: vertices[0][0], y: vertices[0][1]))
            let count = closed == true ? vertices.count + 1 : vertices.count
            for index in 1..<count {
                let previous = (index-1)%vertices.count, next = index%vertices.count
                path.addCurve(to: CGPoint(x: vertices[next][0], y: vertices[next][1]),
                              control1: CGPoint(x: vertices[previous][0]+outgoing[previous][0], y: vertices[previous][1]+outgoing[previous][1]),
                              control2: CGPoint(x: vertices[next][0]+incoming[next][0], y: vertices[next][1]+incoming[next][1]))
            }
            if closed == true { path.closeSubpath() }
        } else if let position, let size {
            let rect = CGRect(x: position[0]-size[0]/2, y: position[1]-size[1]/2, width: size[0], height: size[1])
            if kind == "el" { path.addEllipse(in: rect) }
            else { path.addRoundedRect(in: rect, cornerWidth: radius ?? 0, cornerHeight: radius ?? 0) }
        }
        return path
    }
}
private struct ThemePaint: Decodable {
    var color: [[CGFloat]]
    var opacity: [[CGFloat]]
    var width: [[CGFloat]]?
}
private struct ThemeLayer: Decodable {
    var shapes: [ThemeShape]
    var fill: ThemePaint?
    var stroke: ThemePaint?
    var tracks: [String: [[CGFloat]]]
}
private struct ThemeAnimation: Decodable {
    var frames: Int
    var still: Int
    var layers: [ThemeLayer]
}
private struct ThemeArchive: Decodable { var animations: [String: ThemeAnimation] }

public final class CuaCursorArtwork {
    private let theme: ThemeArchive
    public init() throws {
        guard let url = Bundle.module.url(forResource: "CuaCursor", withExtension: "json", subdirectory: "Resources") else {
            throw CocoaError(.fileNoSuchFile)
        }
        theme = try JSONDecoder().decode(ThemeArchive.self, from: Data(contentsOf: url))
        if let font = Bundle.module.url(forResource: "Inter", withExtension: "ttf", subdirectory: "Resources") {
            CTFontManagerRegisterFontsForURL(font as CFURL, .process, nil)
        }
    }
    public var actionNames: [String] { theme.animations.keys.sorted() }
    private func sample(_ values: [[CGFloat]], _ frame: Int) -> [CGFloat] {
        values[min(frame, values.count-1)]
    }
    private func animate(_ layer: CALayer, key: String, values: [Any], duration: Double, reduced: Bool, still: Int, loops: Bool) {
        layer.setValue(values[min(still, values.count-1)], forKeyPath: key)
        guard !reduced, values.count > 1 else { return }
        let animation = CAKeyframeAnimation(keyPath: key)
        animation.values = values
        animation.duration = duration
        animation.calculationMode = .linear
        animation.repeatCount = loops ? .infinity : 1
        animation.isRemovedOnCompletion = false
        animation.fillMode = .forwards
        layer.add(animation, forKey: key)
    }
    public func layer(action: String, reduced: Bool) -> CALayer {
        let root = CALayer()
        root.anchorPoint = .zero
        root.bounds = CGRect(x: 0, y: 0, width: 128, height: 128)
        guard let animation = theme.animations[action] ?? theme.animations["idle"] else { return root }
        let duration = Double(animation.frames)/30
        let loops = ["idle","drag","scroll","text","transfer","observe","record"].contains(action)
        for item in animation.layers {
            let group = CALayer()
            group.anchorPoint = .zero
            let transforms: [Any] = (0..<animation.frames).map { frame in
                let p = sample(item.tracks["p"]!, frame), a = sample(item.tracks["a"]!, frame)
                let s = sample(item.tracks["s"]!, frame), r = sample(item.tracks["r"]!, frame)[0]
                var transform = CATransform3DMakeTranslation(p[0], p[1], 0)
                transform = CATransform3DRotate(transform, r * .pi/180, 0, 0, 1)
                transform = CATransform3DScale(transform, s[0]/100, s[1]/100, 1)
                transform = CATransform3DTranslate(transform, -a[0], -a[1], 0)
                return NSValue(caTransform3D: transform)
            }
            animate(group, key: "transform", values: transforms, duration: duration, reduced: reduced, still: animation.still, loops: loops)
            animate(group, key: "opacity", values: item.tracks["o"]!.map { NSNumber(value: Double($0[0]/100)) },
                    duration: duration, reduced: reduced, still: animation.still, loops: loops)
            let geometry = CGMutablePath()
            item.shapes.forEach { geometry.addPath($0.path()) }
            let shape = CAShapeLayer()
            shape.path = geometry
            shape.lineCap = .round
            shape.lineJoin = .round
            shape.fillColor = nil
            for (paint, key) in [(item.fill, "fillColor"), (item.stroke, "strokeColor")] {
                guard let paint else { continue }
                let colors: [Any] = (0..<animation.frames).map { frame in
                    let color = sample(paint.color, frame)
                    return NSColor(srgbRed: color[0], green: color[1], blue: color[2],
                                   alpha: color[3]*sample(paint.opacity, frame)[0]/100).cgColor
                }
                animate(shape, key: key, values: colors, duration: duration, reduced: reduced, still: animation.still, loops: loops)
                if let widths = paint.width {
                    animate(shape, key: "lineWidth", values: widths.map { NSNumber(value: Double($0[0])) },
                            duration: duration, reduced: reduced, still: animation.still, loops: loops)
                }
            }
            group.addSublayer(shape)
            root.addSublayer(group)
        }
        return root
    }
}
