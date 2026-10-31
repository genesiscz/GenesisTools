import CoreGraphics
import Foundation

/// One on-screen window as the window server lists it (`CGWindowListCopyWindowInfo`, front to back).
public struct ListedWindow: Equatable {
    public let id: Int
    public let ownerPid: Int32
    public let ownerName: String
    public let title: String?
    public let layer: Int
    public let bounds: CGRect

    public init(id: Int, ownerPid: Int32, ownerName: String, title: String?, layer: Int, bounds: CGRect) {
        self.id = id
        self.ownerPid = ownerPid
        self.ownerName = ownerName
        self.title = title
        self.layer = layer
        self.bounds = bounds
    }
}

/// The window server's on-screen windows, front to back: for naming the owner of a refused point, and for the
/// window a scroll is addressed to.
public func listedOnScreenWindows() -> [ListedWindow] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[CFString: Any]] ?? []
    return list.compactMap { info in
        guard let id = info[kCGWindowNumber] as? Int, let owner = info[kCGWindowOwnerPID] as? Int32,
              let raw = info[kCGWindowBounds] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return ListedWindow(id: id, ownerPid: owner, ownerName: (info[kCGWindowOwnerName] as? String) ?? "pid \(owner)",
                            title: info[kCGWindowName] as? String, layer: (info[kCGWindowLayer] as? Int) ?? 0,
                            bounds: bounds)
    }
}

/// What the accessibility hit test returned at the point: the element's role and label, and its app.
public struct HitElement: Equatable {
    public let app: String?
    public let pid: Int32?
    public let role: String?
    public let label: String?

    public init(app: String?, pid: Int32?, role: String?, label: String?) {
        self.app = app
        self.pid = pid
        self.role = role
        self.label = label
    }
}

/// The window that owns a screen point: the first normal-layer window, front to back, whose bounds hold it.
/// The menu bar, the Dock and overlays sit on other layers and never receive a window-addressed click.
public func windowOwningPoint(_ point: CGPoint, in windows: [ListedWindow]) -> ListedWindow? {
    windows.first { $0.layer == 0 && $0.bounds.contains(point) }
}

private func quoted(_ text: String?) -> String {
    guard let text, !text.isEmpty else {
        return ""
    }

    return " \"\(text.count > 60 ? String(text.prefix(57)) + "..." : text)\""
}

/// The occlusion refusal of a coordinate click, naming what is really at the point (handoff h_00ddcbx1 t26:
/// "observed target is occluded" with cmux covering the window said nothing about cmux, so an agent could not
/// choose between raising the window and clicking elsewhere).
public func occlusionRefusal(
    point: CGPoint, targetPid: Int32, targetWindowId: Int, owner: ListedWindow?, hit: HitElement?
) -> String {
    var parts = ["observed target is occluded or hit testing disagrees; no event dispatched."]
    let at = "At (\(Int(point.x.rounded())), \(Int(point.y.rounded())))"

    if let owner {
        let whose = owner.id == targetWindowId
            ? "the target window itself, so an element inside it covers the target"
            : owner.ownerPid == targetPid ? "another window of the target app" : "another app"
        let title = quoted(owner.title)
        parts.append("\(at) the top window is \(owner.ownerName)\(title) (window \(owner.id), pid \(owner.ownerPid)), \(whose).")
    } else {
        parts.append("\(at) the window server lists no normal window.")
    }

    if let hit {
        let role = hit.role ?? "an element"
        let app = hit.app ?? hit.pid.map { "pid \($0)" } ?? "an unknown app"
        parts.append("The hit test returned \(role)\(quoted(hit.label)) of \(app).")
    }

    parts.append("Raise the target window explicitly, or click a point it owns.")
    return parts.joined(separator: " ")
}
