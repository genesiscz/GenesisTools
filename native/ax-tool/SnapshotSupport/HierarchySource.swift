import ApplicationServices
import CoreGraphics
import Foundation

/// One read path for an observed AX tree. The builder below applies every rule the snapshot
/// contract depends on; a source only answers what the AX server said, so two sources that
/// answer the same questions produce byte-identical rows.
public protocol HierarchySource {
    /// nil when the attribute is unsupported, has no value, or failed to read.
    func attribute(_ element: AXUIElement, _ name: String) -> Any?
    /// [] when the element has no children; throws when the read itself failed.
    func children(of element: AXUIElement) throws -> [AXUIElement]
    func actionNames(of element: AXUIElement) -> [String]
    /// nil when settability could not be determined.
    func isValueSettable(_ element: AXUIElement) -> Bool?
}

public struct ObservedTreeError: Error, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

public struct ObservedTreeData {
    public var elements: [AXUIElement] = []
    public var frames: [CGRect] = []
    public var rows: [[String: Any]] = []
    public var digest: String = ""
    public init() {}
}

/// Attributes copied verbatim into every row, in this order.
public let observedAttributeKeys = [
    "AXIdentifier", "AXTitle", "AXDescription", "AXSubrole", "AXValue",
    "AXEnabled", "AXFocused", "AXSelected", "AXSelectedText", "AXSelectedTextRange",
]
public let observedElementLimit = 4000

/// AppKit animates anonymous glyph groups inside standard window buttons. Expose the actual
/// button as a leaf; those decorative descendants are not controls.
private let windowButtonSubroles: Set<String> = ["AXCloseButton", "AXZoomButton", "AXFullScreenButton", "AXMinimizeButton"]

/// Clamped rounding for AX geometry: detached or not-yet-laid-out elements report non-finite or
/// absurd coordinates, and a whole-tree walk hits one eventually.
public func snapshotPx(_ value: CGFloat) -> Int {
    guard value.isFinite else { return 0 }
    return Int(min(max(value.rounded(), -1_000_000), 1_000_000))
}

public func snapshotFrame(_ element: AXUIElement, source: HierarchySource) -> CGRect {
    var position = CGPoint.zero
    var size = CGSize.zero
    if let raw = source.attribute(element, kAXPositionAttribute as String) {
        let object = raw as AnyObject
        if CFGetTypeID(object) == AXValueGetTypeID() {
            AXValueGetValue(object as! AXValue, .cgPoint, &position)
        }
    }
    if let raw = source.attribute(element, kAXSizeAttribute as String) {
        let object = raw as AnyObject
        if CFGetTypeID(object) == AXValueGetTypeID() {
            AXValueGetValue(object as! AXValue, .cgSize, &size)
        }
    }
    return CGRect(origin: position, size: size)
}

/// Pre-order walk from `root`. Shared AX objects are visited once, window buttons are leaves,
/// chrome scope omits web-area descendants, and a tree deeper than `depth` or larger than
/// `observedElementLimit` is refused rather than truncated.
public func buildObservedTree(root: AXUIElement, source: HierarchySource, depth: Int, scope: String) throws -> ObservedTreeData {
    guard (1...50).contains(depth) else {
        throw ObservedTreeError("--depth must be between 1 and 50")
    }
    var tree = ObservedTreeData()
    var visited = SnapshotObjectSet()
    func walk(_ element: AXUIElement, level: Int, clip: CGRect) throws {
        let identity = CFHash(element)
        guard visited.insert(element) else {
            return
        }
        guard tree.elements.count < observedElementLimit else {
            throw ObservedTreeError("AX tree exceeds \(observedElementLimit) elements; snapshot refused rather than truncated")
        }
        let rawChildren = try source.children(of: element)
        let subrole = source.attribute(element, "AXSubrole") as? String ?? ""
        let windowButton = windowButtonSubroles.contains(subrole)
        let role = source.attribute(element, "AXRole") as? String ?? ""
        let omittedWebContent = scope == "chrome" && role == "AXWebArea"
        let children = windowButton || omittedWebContent ? [] : rawChildren
        guard level < depth || children.isEmpty else {
            throw ObservedTreeError("AX tree exceeds --depth \(depth); increase depth and run see again")
        }
        let frame = snapshotFrame(element, source: source)
        var row: [String: Any] = [
            "index": tree.elements.count, "depth": level, "role": role,
            "identity": identity,
            "x": snapshotPx(frame.minX), "y": snapshotPx(frame.minY),
            "width": snapshotPx(frame.width), "height": snapshotPx(frame.height),
            "visible": frame.width > 0 && frame.height > 0 && clip.contains(CGPoint(x: frame.midX, y: frame.midY)),
            "actions": source.actionNames(of: element).sorted(),
        ]
        if omittedWebContent {
            row["childrenOmitted"] = "chrome scope"
        }
        var hasValue = false
        for key in observedAttributeKeys {
            guard let value = source.attribute(element, key) else {
                continue
            }
            if key == "AXValue" {
                hasValue = true
            }
            let object = value as AnyObject
            if key == "AXSelectedTextRange", CFGetTypeID(object) == AXValueGetTypeID() {
                var range = CFRange(location: 0, length: 0)
                guard AXValueGetValue(object as! AXValue, .cfRange, &range) else {
                    throw ObservedTreeError("selected text range is unreadable; inspect again")
                }
                row[key] = "\(range.location):\(range.length)"
            } else if let stable = snapshotValue(value) {
                row[key] = stable
            } else {
                row["\(key)Readable"] = false
            }
        }
        // Settability is one more round trip per element, and it only means anything where an
        // AXValue exists to set.
        if hasValue, let settable = source.isValueSettable(element) {
            row["valueSettable"] = settable
        }
        tree.elements.append(element)
        tree.frames.append(frame)
        tree.rows.append(row)
        let childClip = role == "AXScrollArea" ? clip.intersection(frame) : clip
        for child in children {
            try walk(child, level: level + 1, clip: childClip)
        }
    }
    try walk(root, level: 0, clip: snapshotFrame(root, source: source))
    do {
        tree.digest = try snapshotDigest(tree.rows)
    } catch {
        throw ObservedTreeError("cannot encode observed AX tree: \(error.localizedDescription)")
    }
    return tree
}
