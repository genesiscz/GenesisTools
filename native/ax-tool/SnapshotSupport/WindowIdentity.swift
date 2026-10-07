import Foundation

/// Annotation may use geometry only when exactly one candidate has that frame and its ID is unavailable.
public func annotationWindowIndex(candidates: [(windowID: UInt32?, frameMatches: Bool)], capturedWindowID: UInt32) -> Int? {
    let exact = candidates.indices.filter { candidates[$0].windowID == capturedWindowID }
    if !exact.isEmpty {
        guard exact.count == 1, candidates[exact[0]].frameMatches else { return nil }
        return exact[0]
    }

    let geometry = candidates.indices.filter { candidates[$0].frameMatches }
    guard geometry.count == 1, candidates[geometry[0]].windowID == nil else { return nil }
    return geometry[0]
}

/// Native IDs distinguish overlapping windows; geometry remains required and is the strict fallback.
public func matchesNativeWindowIdentity(reportedID: UInt32?, expectedID: UInt32, frameMatches: Bool) -> Bool {
    guard frameMatches else { return false }
    return reportedID.map { $0 == expectedID } ?? true
}

/// Whether this window can never become key, making a frontmost requirement unsatisfiable.
///
/// 🛑 Reported 2026-09-21 driving a live HUD: an `NSPanel` with `canBecomeKey = false` and
/// `.nonactivatingPanel` refused every coordinate click and pointer move with
/// `wrong frontmost app/window; focus explicitly and refresh`. The precondition can NEVER be met —
/// not becoming key is the panel's entire purpose, because a timer that steals focus mid-keystroke
/// is worse than no timer. A guard whose condition cannot be satisfied is not a safety check, it
/// is a wall.
///
/// `canBecomeKey` is not observable from outside the process, so this uses the two signals that
/// are: a non-zero CoreGraphics window layer (ordinary app windows sit at layer 0; panels, HUDs
/// and floating utility windows do not), and the AX subroles AppKit gives a panel. Either one is
/// enough. A false positive costs only the frontmost check on a window whose clicks are
/// window-addressed anyway; a false negative costs the caller every click.
public func windowCannotBecomeKey(layer: Int?, subrole: String?) -> Bool {
    if let layer, layer != 0 {
        return true
    }

    return ["AXFloatingWindow", "AXSystemFloatingWindow", "AXSystemDialog"].contains(subrole ?? "")
}
