import CoreGraphics

/// One window as the dimming-overlay rule sees it: the facts ScreenCaptureKit and the running app give.
public struct OverlayWindowFacts: Equatable {
    public let windowID: CGWindowID
    public let ownerBundleID: String?
    public let layer: Int
    /// In global points, like `SCWindow.frame` and `SCDisplay.frame`.
    public let frame: CGRect
    /// The owner is not a regular app: an agent or accessory app with no Dock icon, which is never the active app.
    public let ownerIsAgent: Bool

    public init(windowID: CGWindowID, ownerBundleID: String?, layer: Int, frame: CGRect, ownerIsAgent: Bool) {
        self.windowID = windowID
        self.ownerBundleID = ownerBundleID
        self.layer = layer
        self.frame = frame
        self.ownerIsAgent = ownerIsAgent
    }
}

/// Finds the windows of screen dimmers (HazeOver and the like): a display or area recording leaves them out by
/// default, so the movie shows the screen without the tint (`ax-tool capture --keep-overlays` keeps them).
///
/// A dimmer draws a display-sized, semi-transparent window in the normal window layer, ordered just under the front
/// window, and its owner is an agent app. So a window is an overlay when its owner is a known dimmer, or when it
/// covers a whole display, sits in the normal layer and belongs to an agent app. A regular app's full-screen window
/// has a regular owner, the desktop picture sits far below layer 0, and the menu bar, the Dock and cursor
/// highlighters sit above it, so none of them match.
public enum DimmingOverlayRule {
    /// Dimmers whose every window below the menu bar is a tint.
    public static let knownOwners: Set<String> = ["com.pointum.hazeover", "com.pointum.hazeover-setapp"]
    /// `kCGMainMenuWindowLevel`: a known dimmer's menu bar item and the menu bar itself sit here or above.
    static let menuBarLayer = 24
    /// `kCGNormalWindowLevel`.
    static let normalLayer = 0
    /// How far a window may fall short of a display's edges and still cover it.
    static let edgeTolerance: CGFloat = 1

    public static func overlayIDs(_ windows: [OverlayWindowFacts], displays: [CGRect]) -> Set<CGWindowID> {
        Set(windows.filter { isOverlay($0, displays: displays) }.map(\.windowID))
    }

    static func isOverlay(_ window: OverlayWindowFacts, displays: [CGRect]) -> Bool {
        if let owner = window.ownerBundleID, knownOwners.contains(owner) {
            return window.layer < menuBarLayer
        }
        guard window.ownerIsAgent, window.layer == normalLayer else { return false }
        return displays.contains { covers(window.frame, $0) }
    }

    static func covers(_ frame: CGRect, _ display: CGRect) -> Bool {
        frame.insetBy(dx: -edgeTolerance, dy: -edgeTolerance).contains(display)
    }
}
