import AppKit
import ApplicationServices

/// The view tree beside a `--snapshot` PNG: `<shot>.tree.json` lists every accessibility element of the window with its
/// role, identifier, whether it has a label (never the text), its frame in window points (top-left origin) and its style
/// flags. `tools control compare-tree` matches two trees by identifier and role path and tells a moved, resized, added,
/// removed or restyled control from a screen that only shows other data (titles, counts).
///
/// It reads the window's own accessibility tree through the AX API on this process (the path `tools control` takes),
/// which needs the Accessibility grant; without it the file says `"source": "none"` and holds no nodes.
package enum SnapshotViewTree {
    /// `shot.png` -> `shot.tree.json`.
    package static func sidecarPath(for png: String) -> String {
        let base = (png as NSString).pathExtension.lowercased() == "png" ? (png as NSString).deletingPathExtension : png
        return base + ".tree.json"
    }

    private static let maxNodes = 20_000
    private static let maxDepth = 60

    @MainActor
    package static func write(png: String, face: String, window: NSWindow) {
        let started = Date()
        var nodes: [[String: Any]] = []
        var source = "none"
        if AXIsProcessTrusted(), let root = windowElement(window) {
            source = "ax"
            walk(root, path: "AXWindow", depth: 0, origin: topLeft(of: window), into: &nodes)
        }
        let record: [String: Any] = [
            "version": 1,
            "face": face,
            "source": source,
            "window": ["width": Double(window.frame.width.rounded()), "height": Double(window.frame.height.rounded())],
            "truncated": nodes.count >= maxNodes,
            "nodes": nodes,
        ]
        let path = sidecarPath(for: png)
        do {
            let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            try data.write(to: URL(fileURLWithPath: path))
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            FileHandle.standardError.write(Data("snapshot tree: \(nodes.count) nodes (\(source)) in \(ms) ms -> \(path)\n".utf8))
        } catch {
            FileHandle.standardError.write(Data("snapshot tree: \(error.localizedDescription)\n".utf8))
        }
    }

    /// The top-left corner of the window in the AX coordinate space (global, y down from the primary screen's top).
    private static func topLeft(of window: NSWindow) -> CGPoint {
        let primaryHeight = NSScreen.screens.first?.frame.height ?? window.frame.maxY
        return CGPoint(x: window.frame.minX, y: primaryHeight - window.frame.maxY)
    }

    private static func windowElement(_ window: NSWindow) -> AXUIElement? {
        let app = AXUIElementCreateApplication(getpid())
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return nil }
        let origin = topLeft(of: window)
        let wanted = CGRect(origin: origin, size: window.frame.size)
        return windows.first { candidate in
            guard let frame = frame(candidate) else { return false }
            return abs(frame.minX - wanted.minX) < 2 && abs(frame.minY - wanted.minY) < 2 && abs(frame.width - wanted.width) < 2
        } ?? windows.first
    }

    private static func walk(_ element: AXUIElement, path: String, depth: Int, origin: CGPoint, into nodes: inout [[String: Any]]) {
        guard depth < maxDepth, nodes.count < maxNodes else { return }
        let role = string(element, kAXRoleAttribute) ?? "AXUnknown"
        var node: [String: Any] = ["path": path, "role": role, "depth": depth]
        if let subrole = string(element, kAXSubroleAttribute) { node["subrole"] = subrole }
        if let identifier = string(element, kAXIdentifierAttribute), !identifier.isEmpty { node["identifier"] = identifier }
        let label = [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"].contains { !(string(element, $0) ?? "").isEmpty }
        node["hasLabel"] = label
        if let frame = frame(element) {
            node["frame"] = [
                "x": Double((frame.minX - origin.x).rounded()),
                "y": Double((frame.minY - origin.y).rounded()),
                "w": Double(frame.width.rounded()),
                "h": Double(frame.height.rounded()),
            ]
        }
        for (key, attribute) in [("enabled", kAXEnabledAttribute), ("selected", kAXSelectedAttribute), ("focused", kAXFocusedAttribute)] {
            if let flag = bool(element, attribute) { node[key] = flag }
        }
        nodes.append(node)

        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let children = value as? [AXUIElement] else { return }
        var seen: [String: Int] = [:]
        for child in children {
            let childRole = string(child, kAXRoleAttribute) ?? "AXUnknown"
            let index = seen[childRole, default: 0]
            seen[childRole] = index + 1
            walk(child, path: "\(path)/\(childRole)[\(index)]", depth: depth + 1, origin: origin, into: &nodes)
        }
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private static func bool(_ element: AXUIElement, _ attribute: String) -> Bool? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return (value as? NSNumber)?.boolValue
    }

    private static func frame(_ element: AXUIElement) -> CGRect? {
        var position: CFTypeRef?
        var size: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
              let positionValue = position, let sizeValue = size,
              CFGetTypeID(positionValue) == AXValueGetTypeID(), CFGetTypeID(sizeValue) == AXValueGetTypeID()
        else { return nil }
        var point = CGPoint.zero
        var extent = CGSize.zero
        // The type ids were checked above, so these casts cannot fail.
        AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &extent)
        return CGRect(origin: point, size: extent)
    }
}
