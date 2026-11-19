import AppKit

/// Which on-screen windows a recording picker offers: the list's rows, the window a click picks, the window a hover
/// outlines and the window "bring to front" compares against. The twin of `unrecordableReason` in
/// src/utils/screen-recorder/recordable-window.ts (the CLI's `tools control capture targets`); both pass every case in
/// GenesisKitFixtures/Recording/contract-recordable-windows.json.
///
/// A dimming app (HazeOver) keeps one window per display at the normal level, the display's whole frame, alpha 0.63,
/// untitled, owned by a menu bar app. The level, size and alpha > 0 checks other recorders use let it through, so a
/// click anywhere on a dimmed window picked the dimmer (2026-11-19).
public enum RecordableWindow {
    /// How the window's app runs: a Dock app, a menu bar or helper app, a background-only process, or no app at all.
    public enum OwnerKind: String, Codable, Sendable {
        case regular, accessory, background, none

        init(_ policy: NSApplication.ActivationPolicy?) {
            switch policy {
            case .regular: self = .regular
            case .accessory: self = .accessory
            case .prohibited: self = .background
            default: self = .none
            }
        }
    }

    /// Why a window is left out of the pickers.
    public enum Reason: String, Codable, Sendable {
        /// Above or below the normal level: the menu bar, its extras, the Dock, floating palettes, shields.
        case level
        /// Fully or almost fully transparent.
        case invisible
        /// Marked unreadable by screen capture: the recorder's own panels, protected windows.
        case notShareable = "not-shareable"
        /// System chrome a person does not record.
        case system
        /// No app owns it, or a background-only process does.
        case noApp = "no-app"
        /// A strip, a badge or a helper window.
        case tiny
        /// Laid over a whole display: a dimmer, a tint or an annotation layer, not an app window.
        case overlay
    }

    /// What the WindowServer says about one window; absent fields read as the normal level, opaque and readable.
    public struct Facts: Codable, Equatable, Sendable {
        public var app: String
        public var title: String?
        /// Global CoreGraphics points, top-left origin.
        public var bounds: RecordingWindow.Bounds
        public var layer: Int?
        public var alpha: Double?
        public var sharingState: Int?
        public var ownerKind: OwnerKind?

        public init(app: String, title: String? = nil, bounds: RecordingWindow.Bounds, layer: Int? = nil,
                    alpha: Double? = nil, sharingState: Int? = nil, ownerKind: OwnerKind? = nil) {
            self.app = app
            self.title = title
            self.bounds = bounds
            self.layer = layer
            self.alpha = alpha
            self.sharingState = sharingState
            self.ownerKind = ownerKind
        }
    }

    /// Window owners that are system chrome. GenesisTools stays: the hub and the review window are worth recording.
    public static let systemOwners: Set<String> = [
        "Dock", "WindowServer", "Window Server", "Control Center", "Notification Center", "NotificationCenter",
        "Spotlight", "SystemUIServer", "loginwindow", "Screenshot", "TextInputMenuAgent", "Wallpaper",
    ]

    /// Smaller than this on either side is a strip, a badge or a helper window.
    public static let minimumSide = 60.0
    private static let minimumAlpha = 0.1
    /// The menu bar keeps a zoomed window at about 97 % of its display; only an overlay, or an app in native full
    /// screen, covers the whole frame.
    private static let overlayCoverage = 0.99

    /// Why `window` is not offered, nil when it is a real app window. `displays` are the displays' frames in global
    /// CoreGraphics points; without them no window can be told apart as an overlay.
    public static func reason(_ window: Facts, displays: [CGRect]) -> Reason? {
        if (window.layer ?? 0) != 0 { return .level }
        let alpha = window.alpha ?? 1
        if alpha < minimumAlpha { return .invisible }
        if window.sharingState == 0 { return .notShareable }
        if window.app.isEmpty || systemOwners.contains(window.app) { return .system }
        if window.ownerKind == OwnerKind.none || window.ownerKind == .background { return .noApp }
        if window.bounds.width < minimumSide || window.bounds.height < minimumSide { return .tiny }
        let frame = CGRect(x: window.bounds.x, y: window.bounds.y, width: window.bounds.width, height: window.bounds.height)
        let covers = displays.contains { display in
            guard display.width > 0, display.height > 0 else { return false }
            let overlap = frame.intersection(display)
            return !overlap.isNull && overlap.width * overlap.height >= overlayCoverage * display.width * display.height
        }
        if covers {
            let untitled = (window.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let dockApp = window.ownerKind == nil || window.ownerKind == .regular
            if alpha < 1 || (untitled && !dockApp) { return .overlay }
        }
        return nil
    }

    /// The facts of one `CGWindowListCopyWindowInfo` row; nil when it has no owner or bounds.
    static func facts(row: [String: Any], ownerKind: (Int32) -> OwnerKind) -> Facts? {
        guard let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let raw = row[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: raw) else { return nil }
        return Facts(app: row[kCGWindowOwnerName as String] as? String ?? "",
                     title: row[kCGWindowName as String] as? String,
                     bounds: .init(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height),
                     layer: row[kCGWindowLayer as String] as? Int,
                     alpha: row[kCGWindowAlpha as String] as? Double,
                     sharingState: row[kCGWindowSharingState as String] as? Int,
                     ownerKind: ownerKind(pid))
    }

    /// The displays' frames in global CoreGraphics points (top-left origin of the first screen).
    @MainActor public static func displayFrames(_ screens: [CGRect] = NSScreen.screens.map(\.frame)) -> [CGRect] {
        guard let primary = screens.first else { return [] }
        return screens.map { CGRect(x: $0.minX, y: primary.maxY - $0.maxY, width: $0.width, height: $0.height) }
    }

    /// The windows on screen a picker offers, front to back.
    @MainActor public static func onScreen() -> [RecordingWindow] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        var kinds: [Int32: OwnerKind] = [:]
        return offered(rows: rows, displays: displayFrames()) { pid in
            if let known = kinds[pid] { return known }
            let found = OwnerKind(NSRunningApplication(processIdentifier: pid)?.activationPolicy)
            kinds[pid] = found
            return found
        }
    }

    /// The rows of a window list that a picker offers, in their order (front to back).
    static func offered(rows: [[String: Any]], displays: [CGRect], ownerKind: (Int32) -> OwnerKind) -> [RecordingWindow] {
        rows.compactMap { row in
            guard let id = row[kCGWindowNumber as String] as? UInt32, let pid = row[kCGWindowOwnerPID as String] as? Int32,
                  let facts = facts(row: row, ownerKind: ownerKind), reason(facts, displays: displays) == nil else { return nil }
            return RecordingWindow(id: id, pid: pid, app: facts.app, title: facts.title ?? "", bounds: facts.bounds)
        }
    }
}
