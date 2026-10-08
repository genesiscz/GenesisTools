// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Companion/Shared/ConstraintSafeWindow.swift at 2026-10-08T05:07:50+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
// Copied from /Users/Martin/Tresors/Projects/Rewind/apps/timetravel-app/TimeTravel/TimeTravel/Shared/ConstraintSafeWindow.swift at 2026-07-20T00:25:25+02:00 at commit hash 39b6b2f1865aed017e1ea1a0f6a4c0434df36311
//
//  ConstraintSafeWindow.swift
//  TimeTravel
//
//  An NSWindow subclass with built-in constraint loop protection.
//  Use this for any window hosting SwiftUI content via NSHostingController.
//

import AppKit

/// NSWindow subclass that prevents constraint update loops caused by
/// SwiftUI's NSHostingView size negotiation with AppKit.
///
/// Provides:
/// - ConstraintLoopDetector integration (breaks loops instead of crashing)
/// - Re-entrancy guard on setFrame (prevents recursive calls during layout)
class ConstraintSafeWindow: NSWindow {

    /// Re-entrancy guard: prevents recursive setFrame during super.setFrame.
    private var isSettingFrame = false

    override func updateConstraintsIfNeeded() {
        guard ConstraintLoopDetector.shared.beginUpdate(for: self) else { return }
        super.updateConstraintsIfNeeded()
    }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        guard !isSettingFrame else { return }
        guard frameRect != self.frame else { return }
        isSettingFrame = true
        super.setFrame(frameRect, display: flag)
        isSettingFrame = false
    }

    /// No re-entrancy flag here: AppKit sets the frame from inside this call (each step of an animated
    /// change goes through `setFrame(_:display:)`), and with the flag set every step was dropped, so
    /// `zoom` left the window at its size (Genesis markdown viewer, 2026-10-02). The inner call keeps its guard.
    override func setFrame(_ frameRect: NSRect, display displayFlag: Bool, animate animateFlag: Bool) {
        guard !isSettingFrame else { return }
        guard frameRect != self.frame else { return }
        super.setFrame(frameRect, display: displayFlag, animate: animateFlag)
    }
}

/// NSPanel subclass with the same constraint loop protection.
/// Use for floating panels, overlays, and non-activating windows.
class ConstraintSafePanel: NSPanel {

    /// Re-entrancy guard: prevents recursive setFrame during super.setFrame.
    private var isSettingFrame = false

    override func updateConstraintsIfNeeded() {
        guard ConstraintLoopDetector.shared.beginUpdate(for: self) else { return }
        super.updateConstraintsIfNeeded()
    }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        guard !isSettingFrame else { return }
        guard frameRect != self.frame else { return }
        isSettingFrame = true
        super.setFrame(frameRect, display: flag)
        isSettingFrame = false
    }

    /// No re-entrancy flag here: AppKit sets the frame from inside this call (each step of an animated
    /// change goes through `setFrame(_:display:)`), and with the flag set every step was dropped, so
    /// `zoom` left the window at its size (Genesis markdown viewer, 2026-10-02). The inner call keeps its guard.
    override func setFrame(_ frameRect: NSRect, display displayFlag: Bool, animate animateFlag: Bool) {
        guard !isSettingFrame else { return }
        guard frameRect != self.frame else { return }
        super.setFrame(frameRect, display: displayFlag, animate: animateFlag)
    }
}
