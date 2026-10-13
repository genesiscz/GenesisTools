import AppKit
import QuartzCore
import CoreText

/// Whether the animated cursor overlay may be shown for this invocation.
///
/// `--no-activate` keeps it. It used to switch it off: on 2026-09-21 showing the overlay made the
/// helper the active app (cmux -> ax-tool), which undid the one thing the caller asked for. The
/// helper now runs with the .prohibited activation policy (`runCursorFeedbackCommand`), so it can
/// never be activated, and a background fill shows who writes what like every other act.
public func cursorFeedbackEnabled(arguments: [String], environment: [String: String]) -> Bool {
    return !arguments.contains("--no-cursor")
        && environment["GENESIS_CONTROL_CURSOR"] != "off"
}

public struct CursorFeedbackEvent: Codable {
    public var action: String
    public var x: Double?
    public var y: Double?
    public var background: Bool
    public var target: String
    public var displayID: UInt32?
    public var displayX: Double?
    public var displayY: Double?
    public var receiptID: String?
    /// "right" or "middle" for a secondary click. Nil is the primary button.
    public var button: String?
    /// 2 for a double click. Nil is a single one.
    public var clickCount: Int?
    /// What and where, for the label beside the cursor: "Right-click · TextEdit › text area".
    public var label: String?
    /// Why, in the caller's own words (`--note` on the CLI, `note` in the API).
    public var note: String?
    /// Who drives it: "Claude · 1b4001ba", plus an agent name when one is known.
    public var session: String?
    /// What a text act writes or a key act sends: "“zzqx”", "•••• (12 characters, hidden)", "keys cmd+a".
    public var detail: String?
    public var displayPoint: CGPoint? {
        guard displayID != nil, let x=displayX, let y=displayY, x.isFinite, y.isFinite, x >= 0, y >= 0, x < 100000, y < 100000 else { return nil }
        return CGPoint(x:x,y:y)
    }
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
        Self.actions.contains(action) && (x == nil && y == nil || point != nil) && ["ax", "pixel", "desktop"].contains(target) &&
            (displayID == nil && displayX == nil && displayY == nil || displayPoint != nil) &&
            (receiptID == nil || UUID(uuidString: receiptID!) != nil) &&
            (button == nil || ["left", "right", "middle"].contains(button!)) &&
            (clickCount == nil || (1...3).contains(clickCount!)) &&
            (label?.count ?? 0) <= CursorFeedbackText.labelLimit &&
            (note?.count ?? 0) <= CursorFeedbackText.noteLimit &&
            (session?.count ?? 0) <= CursorFeedbackText.sessionLimit &&
            (detail?.count ?? 0) <= CursorFeedbackText.detailLimit
    }
    public static let actions: Set<String> = ["idle", "click", "drag", "scroll", "text", "key", "navigate", "app", "transfer", "system", "hide"]
    public static func semantic(_ verb: String) -> String? {
        switch verb {
        case "press", "click", "perform", "showmenu": return "click"
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

/// How a click is marked at the cursor, so a watcher tells a context menu from a press at a glance.
public enum CursorClickKind: Equatable {
    case primary
    case double
    case secondary
    case middle

    public init(button: String?, clickCount: Int?) {
        switch button {
        case "right": self = .secondary
        case "middle": self = .middle
        default: self = (clickCount ?? 1) > 1 ? .double : .primary
        }
    }

    /// sRGB accent: the overlay's cyan for a press, amber for a context menu, violet for the middle button.
    public var accent: (red: Double, green: Double, blue: Double) {
        switch self {
        case .primary, .double: return (94.0 / 255, 192.0 / 255, 232.0 / 255)
        case .secondary: return (245.0 / 255, 166.0 / 255, 35.0 / 255)
        case .middle: return (176.0 / 255, 140.0 / 255, 1)
        }
    }

    /// Expanding rings at the hotspot: two for a double click, one otherwise.
    public var rings: Int { self == .double ? 2 : 1 }

    /// A context menu also gets a small menu glyph beside the ring.
    public var showsMenuGlyph: Bool { self == .secondary }
}

/// The words on the label beside the cursor. Pure, so the text is tested without a display.
public enum CursorFeedbackText {
    public static let labelLimit = 72
    public static let noteLimit = 120
    public static let sessionLimit = 48
    public static let detailLimit = 64
    /// An element name longer than this is cut, so the app and the verb stay on the line.
    static let nameLimit = 32

    /// The verb a person would say for this act.
    public static func verb(_ verb: String, button: String?, clickCount: Int) -> String {
        if verb == "showmenu" {
            return "Context menu"
        }

        switch button {
        case "right": return clickCount > 1 ? "Double right-click" : "Right-click"
        case "middle": return "Middle-click"
        default: break
        }

        switch verb {
        case "click": return clickCount > 1 ? "Double-click" : "Click"
        case "press": return "Press"
        case "perform": return "Perform"
        case "move", "hover": return "Move"
        case "drag": return "Drag"
        case "scroll": return "Scroll"
        case "set": return "Set value"
        case "type": return "Type"
        case "select": return "Select text"
        case "paste": return "Paste"
        case "key", "hotkey": return "Key"
        case "focus": return "Focus"
        case "window", "resize", "minimize", "maximize", "close": return "Window"
        default: return verb.prefix(1).uppercased() + verb.dropFirst()
        }
    }

    /// "text area" from AXTextArea, "pop up button" from AXPopUpButton.
    public static func role(_ role: String?) -> String? {
        guard var raw = role, !raw.isEmpty else {
            return nil
        }

        if raw.hasPrefix("AX") {
            raw.removeFirst(2)
        }

        var words: [String] = []
        var current = ""
        for character in raw {
            if character.isUppercase, !current.isEmpty {
                words.append(current)
                current = ""
            }
            current.append(character)
        }
        if !current.isEmpty {
            words.append(current)
        }
        let text = words.joined(separator: " ").lowercased()
        return text.isEmpty ? nil : text
    }

    /// "TextEdit › “Save” button". The element's value is never used: it can be a password.
    public static func target(app: String?, role: String?, name: String?) -> String? {
        let roleText = Self.role(role)
        let trimmedName = truncate(name ?? "", to: nameLimit)
        let element = trimmedName.isEmpty ? roleText : "“\(trimmedName)”" + (roleText.map { " \($0)" } ?? "")
        let appName = truncate(app ?? "", to: nameLimit)
        let parts = [appName.isEmpty ? nil : appName, element].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " › ")
    }

    /// "Right-click · TextEdit › text area", cut to fit the label.
    public static func label(verb: String, target: String?) -> String {
        truncate(target.map { "\(verb) · \($0)" } ?? verb, to: labelLimit)
    }

    /// One line, at most `limit` characters, ending in an ellipsis when cut. Counts characters as a
    /// person sees them, so an emoji or an accented letter is never split.
    public static func truncate(_ text: String, to limit: Int) -> String {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        guard flat.count > limit else {
            return flat
        }

        return String(flat.prefix(max(1, limit - 1))).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The line under the label for an act that writes text or sends keys, or nil for any other act.
    /// A secure field shows bullets and a count, never the text: the label is on screen for anyone
    /// watching, and in every screen recording.
    public static func detail(action: String, text: String?, secure: Bool) -> String? {
        guard let text else {
            return nil
        }

        switch action {
        case "set", "paste", "type":
            if secure {
                return "\(String(repeating: "•", count: min(text.count, 8))) (\(text.count) characters, hidden)"
            }

            if text.isEmpty {
                return "(empty: clears the field)"
            }

            let flat = text.replacingOccurrences(of: "\r\n", with: " ⏎ ")
                .split(omittingEmptySubsequences: false, whereSeparator: \.isNewline).joined(separator: " ⏎ ")
            return "“" + truncate(flat, to: detailLimit - 2) + "”"
        case "key", "hotkey":
            let keys = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: "+")
            return keys.isEmpty ? nil : truncate("keys \(keys)", to: detailLimit)
        default:
            return nil
        }
    }

    /// The caller's note or session from the environment, trimmed and cut, or nil when empty.
    public static func fromEnvironment(_ value: String?, limit: Int) -> String? {
        let text = truncate(value ?? "", to: limit)
        return text.isEmpty ? nil : text
    }
}

public enum CursorMotion {
    public static func appKitPoint(_ point: CGPoint, primaryTop: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: primaryTop - point.y)
    }
    public static func viewPoint(_ point: CGPoint, desktop: CGRect, primaryTop: CGFloat) -> CGPoint {
        let cocoa = appKitPoint(point, primaryTop: primaryTop)
        return CGPoint(x: cocoa.x - desktop.minX, y: desktop.maxY - cocoa.y)
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
