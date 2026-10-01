//
//  PerfContext.swift
//
//  What the app was showing and doing when a stall or a dropped frame happened. A `main-stall
//  recovered after 742ms` line alone named no screen and no cause: on 2026-10-01 the hub logged 163 of
//  them in one afternoon, and their samples showed only SwiftUI measuring text. Every stall and
//  frame-drop line now ends with the host's current area ("agents › col-309257 › transcript,changes")
//  and the last spans and marks before it, newest first, with how long ago each one ended.
//

import Foundation

public enum PerfContext {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var currentArea = ""
    private nonisolated(unsafe) static var recent: [(label: String, at: CFAbsoluteTime)] = []
    /// Enough to see the step that led into a stall without making the line unreadable.
    public static let keep = 6

    /// The screen the user is looking at, set by the host when its mode, selection or panes change.
    public static var area: String {
        get {
            lock.lock()
            defer { lock.unlock() }
            return currentArea
        }
        set {
            lock.lock()
            let changed = currentArea != newValue
            currentArea = newValue
            lock.unlock()
            if changed {
                note("area \(newValue)")
            }
        }
    }

    /// One step the app took (a span that ended, a mark). PerfLog feeds it; a host may add its own.
    public static func note(_ label: String) {
        let now = CFAbsoluteTimeGetCurrent()
        lock.lock()
        recent.append((String(label.prefix(90)), now))
        if recent.count > keep {
            recent.removeFirst(recent.count - keep)
        }
        lock.unlock()
    }

    /// ` area=<area> recent=[a -0.1s; b -0.9s]`, newest first; empty when nothing is known.
    public static func describe(now: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> String {
        lock.lock()
        let area = currentArea
        let steps = recent
        lock.unlock()
        var line = ""
        if !area.isEmpty {
            line += " area=\(area)"
        }
        if !steps.isEmpty {
            let shown = steps.reversed().map { String(format: "%@ -%.1fs", $0.label, max(0, now - $0.at)) }
            line += " recent=[\(shown.joined(separator: "; "))]"
        }
        return line
    }

    /// Tests start from a clean state.
    public static func resetForTesting() {
        lock.lock()
        currentArea = ""
        recent = []
        lock.unlock()
    }
}
