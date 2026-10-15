import ApplicationServices
import CoreGraphics
import Foundation

/// `kCGPopUpMenuWindowLevel`: the window-server layer every open NSMenu draws in, a context menu
/// included. A menu window on this layer is the one signal that does not depend on where an app's
/// Accessibility tree chooses to put its menu (SwiftUI nests a context menu inside the view that owns
/// it, AppKit lists it among the application's children).
public let popUpMenuWindowLayer = 101

/// The window numbers of the on-screen menu windows `pid` owns, from a `CGWindowListCopyWindowInfo` dump.
public func menuWindowIDs(in windows: [[String: Any]], pid: Int32) -> Set<Int> {
    Set(windows.compactMap { window in
        guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (window[kCGWindowLayer as String] as? NSNumber)?.intValue == popUpMenuWindowLayer,
              let id = (window[kCGWindowNumber as String] as? NSNumber)?.intValue else { return nil }

        return id
    })
}

/// Whether a menu opened between two reads of the menu windows: a window that was not there before.
/// A menu already open before the click does not count, so a stale menu cannot answer for a new one.
public func menuWindowAppeared(before: Set<Int>, after: Set<Int>) -> Bool {
    !after.subtracting(before).isEmpty
}

/// How an `AXShowMenu` went, judged by what could be observed.
public enum ShowMenuOutcome: Equatable {
    /// A menu was seen opening.
    case opened
    /// The request was made, but no menu was seen: the outcome is uncertain.
    case notSeen
    /// The AX call came back at once with this error, so nothing opened.
    case failed(Int32)
}

private final class AXResultBox {
    private let lock = NSLock()
    private var value: AXError?
    func set(_ result: AXError) { lock.lock(); value = result; lock.unlock() }
    func get() -> AXError? { lock.lock(); defer { lock.unlock() }; return value }
}

/// AXShowMenu without waiting for it to return.
///
/// 🛑 A context menu tracks modally INSIDE the AX request, so `AXUIElementPerformAction` returns only
/// when the menu closes. Performed synchronously, `act --action perform --ax-action AXShowMenu` failed
/// with "did not return within 2.0 s (AX -25204)" and `dispatchState: uncertain` while the menu was in
/// fact open (measured 2026-10-15 on a SwiftUI button). So the call runs on its own thread, the caller
/// waits at most `returnWaitMs` for an early answer, and whether a menu opened is decided only by
/// `menuAppeared`. An early error means nothing opened; `-25204` (the call outlived the AX messaging
/// timeout) is the tracking menu itself, never a failure.
public func showContextMenu(perform: @escaping () -> AXError, returnWaitMs: Int = 600,
                            menuAppeared: () -> Bool) -> ShowMenuOutcome {
    let box = AXResultBox()
    let returned = DispatchSemaphore(value: 0)
    Thread {
        box.set(perform())
        returned.signal()
    }.start()
    if returned.wait(timeout: .now() + .milliseconds(returnWaitMs)) == .success,
       let result = box.get(), result != .success, result != .cannotComplete {
        return .failed(result.rawValue)
    }

    return menuAppeared() ? .opened : .notSeen
}

/// The `act` error for a right-click that was delivered but opened no menu. 🛑 The result used to say
/// `ok: true, dispatchState: dispatched` and nothing else, so a caller went on to look for menu items
/// that were never there (reported 2026-10-15 against a SwiftUI app). The event WAS dispatched, so the
/// state stays "dispatched"; what is false is the claim that a menu opened.
public func contextMenuNotSeenMessage(delivery: String) -> String {
    "the right-click was delivered (\(delivery)) but no context menu was seen opening: the app shows no menu window "
        + "and no AXMenu in its Accessibility tree. The pointer was not moved. A menu also closes on the user's next "
        + "click or key press, so inspect with see before retrying"
}

/// Rows whose only difference between the two reads that bracket a screenshot is the width (and,
/// for a trailing or centred label, the x) of a static text. Returns the tolerated changes, or nil
/// when anything else changed.
///
/// 🛑 A status label such as "saved 3 min ago" re-lays itself out on its own, and one width change
/// between the two reads refused the whole `see` with "UI changed during observation" (reported
/// 2026-10-15). The bounded retry already exists (`recoverSnapshotRead`, three reads within one
/// second), and it does not help a label that ticks faster than a read, or a window slow enough that
/// one read spends the whole second. Text width is not a target identity: no row's role, value,
/// height or position on the other axis moved, and a static text takes no action that its width
/// could misdirect. Anything else still refuses, because the screenshot must show the tree it is
/// issued with.
public func toleratedObservationDrift(before: [[String: Any]], after: [[String: Any]]) -> [[String: Any]]? {
    guard before.count == after.count else { return nil }

    let tolerated: Set<String> = ["width", "x"]
    var changes: [[String: Any]] = []
    for index in before.indices {
        let fields = Set(before[index].keys).union(after[index].keys).filter { key in
            key != "identity" && String(describing: before[index][key]) != String(describing: after[index][key])
        }

        if fields.isEmpty {
            continue
        }

        guard fields.isSubset(of: tolerated), fields.contains("width"),
              before[index]["role"] as? String == "AXStaticText",
              after[index]["role"] as? String == "AXStaticText" else { return nil }

        changes.append(["index": index, "fields": fields.sorted()])
    }

    return changes.isEmpty ? nil : changes
}

/// The app's open context menu: the first `AXMenu` found breadth-first under `app`, never descending
/// into the menu bar (its menus belong to the bar path). AppKit lists a context menu among the
/// application's children; SwiftUI nests it inside the view that owns it, inside a window (measured
/// 2026-10-15 on a SwiftUI fixture: window, group, then the menu). `limit` bounds the walk. A subtree
/// whose read fails is skipped, because an open menu elsewhere still answers.
public func findOpenContextMenu(app: AXUIElement, source: HierarchySource, limit: Int = 4000) -> AXUIElement? {
    var queue = [app]
    var head = 0
    while head < queue.count, head < limit {
        let element = queue[head]
        head += 1
        let role = source.attribute(element, "AXRole") as? String
        if role == "AXMenu" {
            return element
        }

        if role == "AXMenuBar" {
            continue
        }

        if let children = try? source.children(of: element) {
            queue.append(contentsOf: children)
        }
    }

    return nil
}
