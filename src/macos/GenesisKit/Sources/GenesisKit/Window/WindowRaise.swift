//
//  WindowRaise.swift
//  GenesisKit
//
//  Bring ONE of our windows to the user without dragging the main window
//  along. `NSApp.activate(ignoringOtherApps:)` orders every visible window of
//  the app above other apps, so `genesis open`, Session Details and Settings
//  all used to surface the main window too. `NSRunningApplication.activate`
//  without `.activateAllWindows` brings only the key and main windows forward,
//  and once `makeKeyAndOrderFront` ran on the target, both are the target.
//

import AppKit

@MainActor
public enum WindowRaise {
    /// Make `window` key and frontmost, activating the app if another app is
    /// active. The app's other windows keep their place in the stack.
    public static func raise(_ window: NSWindow) {
        window.makeKeyAndOrderFront(nil)
        if !NSApp.isActive {
            NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps])
        }
    }
}
