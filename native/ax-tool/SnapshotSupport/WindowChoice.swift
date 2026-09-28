import Foundation

/// One AX window of an app, as far as choosing a default needs to know it.
public struct WindowCandidate: Equatable {
    public let index: Int
    public let windowID: Int?
    public let title: String
    public let subrole: String?
    public let height: Double
    public let minimized: Bool

    public init(index: Int, windowID: Int?, title: String, subrole: String?, height: Double, minimized: Bool) {
        self.index = index
        self.windowID = windowID
        self.title = title
        self.subrole = subrole
        self.height = height
        self.minimized = minimized
    }

    /// Popups that are not where a caller's work is: hover cards, tooltips, find bars, a
    /// "Translate this page?" bubble. The same rule `window` uses for its `transient` flag.
    public var secondary: Bool {
        ["AXUnknown", "AXHelpTag", "AXFloatingWindow", "AXSystemFloatingWindow"].contains(subrole ?? "") || height <= 50
    }
}

/// The window `see` may choose without being told: the only candidate, or the only one that is
/// neither minimized nor secondary. nil means the choice is the caller's, and the refusal must
/// name every candidate by window ID. Brave's translate bubble made its one browser window
/// "ambiguous" and the refusal named indexes the computer API does not take.
public func defaultWindowIndex(_ candidates: [WindowCandidate]) -> Int? {
    if candidates.count == 1 {
        return candidates[0].index
    }

    let primary = candidates.filter { !$0.secondary && !$0.minimized }
    return primary.count == 1 ? primary[0].index : nil
}

/// Activation with a LaunchServices fallback. macOS 14+ lets the active app refuse an
/// `activate()` request from a background process, and Brave did ("app activation failed"),
/// while `open -a` activated it at once. After `fallbackAfter` refused polls the request goes
/// through LaunchServices once, the path `open -a` takes, and polling continues.
public func activateFrontmost(isFrontmost: () -> Bool, activate: () -> Void, openViaLaunchServices: () -> Void,
                              pump: (TimeInterval) -> Void, attempts: Int = 30,
                              fallbackAfter: Int = 10) -> (ok: Bool, launchServices: Bool) {
    var launchServices = false
    for attempt in 0..<attempts {
        if isFrontmost() { return (true, launchServices) }
        if attempt == fallbackAfter {
            launchServices = true
            openViaLaunchServices()
        } else {
            activate()
        }
        pump(0.1)
    }
    return (isFrontmost(), launchServices)
}
