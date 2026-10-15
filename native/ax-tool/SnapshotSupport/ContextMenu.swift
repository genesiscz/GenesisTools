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

/// What was open before a dispatch, read once, so every way of seeing a menu afterwards can ask "is this new".
/// An application that could not be read counts as showing a menu: its application-level answer can then
/// prove nothing, and only a new menu window or a menu new in the window tree counts.
public struct ContextMenuBaseline: Equatable {
    public let windows: Set<Int>
    public let applicationMenu: Bool
    public let windowMenu: Bool

    public init(windows: Set<Int>, applicationMenu: Bool, windowMenu: Bool) {
        self.windows = windows
        self.applicationMenu = applicationMenu
        self.windowMenu = windowMenu
    }
}

/// Whether a menu that was NOT there before the dispatch is there now: a new menu window, or an `AXMenu` at
/// application level or in the window when there was none there before. 🛑 The two AX answers used to count
/// any menu, so with one already open a right-click that did nothing reported a menu opened, and the caller
/// went on to pick an item from the old menu (review of #530, 2026-10-15). The reads are closures, cheapest
/// first, and a later one runs only when the earlier ones saw nothing new.
public func newContextMenuSeen(baseline: ContextMenuBaseline, windows: () -> Set<Int>, applicationMenu: () -> Bool?,
                               windowMenu: () -> Bool?) -> Bool {
    if menuWindowAppeared(before: baseline.windows, after: windows()) {
        return true
    }

    if !baseline.applicationMenu, applicationMenu() == true {
        return true
    }

    return !baseline.windowMenu && windowMenu() == true
}

/// Whether an `AXMenu` is among `app`'s own children (where AppKit lists a context menu), or nil when that
/// cannot be told: the children could not be read, or the deadline passed before an answer. 🛑 The old read set
/// a timeout on the application handle only, then read every child's role with no deadline (review of #530):
/// several slow children could spend the caller's budget before a right-click was even dispatched. Here one
/// deadline covers the whole read, it is checked between children, and each read is bounded by `source`.
public func applicationChildMenuState(app: AXUIElement, source: DeadlineHierarchySource) -> Bool? {
    guard !source.expired(), let children = try? source.children(of: app) else { return nil }

    for child in children {
        if source.expired() {
            return nil
        }

        guard let role = source.attribute(child, "AXRole") as? String, !source.expired() else {
            return nil
        }

        if role == "AXMenu" {
            return true
        }
    }

    return source.expired() ? nil : false
}

/// A hierarchy source whose every read is bounded by what is left of `deadline` (at most `perRead`, at least
/// 50 ms). Once expired it makes no more AX calls, so an unresponsive row cannot accumulate timeouts.
public struct DeadlineHierarchySource: HierarchySource {
    let base: HierarchySource
    let deadline: TimeInterval
    let perRead: TimeInterval
    let now: () -> TimeInterval

    public init(_ base: HierarchySource, deadline: TimeInterval, perRead: TimeInterval = 0.5,
                now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.base = base
        self.deadline = deadline
        self.perRead = perRead
        self.now = now
    }

    /// Whether the deadline has passed: the `expired` to hand the walk that reads through this source.
    public func expired() -> Bool { now() >= deadline }

    private func bound(_ element: AXUIElement) {
        AXUIElementSetMessagingTimeout(element, Float(max(0.05, min(perRead, deadline - now()))))
    }

    public func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        guard !expired() else { return nil }
        bound(element)
        return base.attribute(element, name)
    }

    public func children(of element: AXUIElement) throws -> [AXUIElement] {
        guard !expired() else {
            throw ObservedTreeError("observation budget ran out before AX children could be read; inspect again")
        }
        bound(element)
        return try base.children(of: element)
    }

    public func actionNames(of element: AXUIElement) -> [String] {
        guard !expired() else { return [] }
        bound(element)
        return base.actionNames(of: element)
    }

    public func isValueSettable(_ element: AXUIElement) -> Bool? {
        guard !expired() else { return nil }
        bound(element)
        return base.isValueSettable(element)
    }
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

/// The background ways a right-click can open a context menu, in the order `act` tries them.
public enum ContextMenuDelivery: String, CaseIterable {
    /// An NSEvent-built right mouse down and up with a window-local location, posted to the pid.
    case windowEvent = "window-event"
    /// A plain CGEvent right mouse down and up at the global point, window number fields set, posted to the pid.
    case postToPid = "post-to-pid"
    /// AXShowMenu on the element. 🛑 Last, never first: SwiftUI answers it with the menu of an ENCLOSING view.
    /// Measured 2026-10-15 in Genesis Markdown: on a tab button whose own menu holds Show in Sidebar, it opened
    /// the tab bar's one-item menu (Wrap Tabs), while a real right mouse event at the button opens its own.
    case showMenu = "AXShowMenu"
}

/// The deliveries to try: all of them, in order, unless `AX_TOOL_CONTEXT_MENU_DELIVERIES` names a subset (a
/// comma list of raw values; unknown names are ignored, and a list that names none falls back to all). It
/// exists so a live check can make each step the one that has to work.
public func contextMenuDeliveries(_ setting: String?) -> [ContextMenuDelivery] {
    guard let setting else { return ContextMenuDelivery.allCases }

    let named = Set(setting.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    let chosen = ContextMenuDelivery.allCases.filter { named.contains($0.rawValue) }
    return chosen.isEmpty ? ContextMenuDelivery.allCases : chosen
}

/// One delivery of a right-click: `run` dispatches and answers whether a new menu was seen, or nil when the
/// delivery does not apply (AXShowMenu with a modifier or on an element without the action).
public struct ContextMenuStep {
    public let delivery: ContextMenuDelivery
    public let run: () throws -> Bool?

    public init(_ delivery: ContextMenuDelivery, run: @escaping () throws -> Bool?) {
        self.delivery = delivery
        self.run = run
    }
}

/// Which delivery opened the menu, and every delivery that was dispatched.
public struct ContextMenuRun: Equatable {
    public let openedBy: ContextMenuDelivery?
    public let tried: [ContextMenuDelivery]

    /// The `delivery` field of the act result.
    public var description: String {
        openedBy?.rawValue ?? tried.map(\.rawValue).joined(separator: ", then ")
    }
}

/// Run the deliveries in order until one opens a menu. A later delivery runs only while the app shows no menu
/// window at all (`anyMenuOpen`): a menu that is open without counting as new must not be closed by a second
/// right-click, so the run stops there instead.
public func runContextMenuDeliveries(_ steps: [ContextMenuStep], anyMenuOpen: () -> Bool) throws -> ContextMenuRun {
    var tried: [ContextMenuDelivery] = []
    for step in steps {
        if !tried.isEmpty, anyMenuOpen() {
            break
        }

        guard let opened = try step.run() else { continue }

        tried.append(step.delivery)
        if opened {
            return ContextMenuRun(openedBy: step.delivery, tried: tried)
        }
    }

    return ContextMenuRun(openedBy: nil, tried: tried)
}

/// The first `limit` titles of the items of an open menu, separators (an item without a title) left out, so a
/// caller can tell WHICH menu opened: the element's own, or an enclosing view's.
///
/// Best-effort metadata after the menu was already seen: reading stops at `limit` titles or once `expired`,
/// so a long menu or an app that stops answering returns what was read so far instead of holding the result.
public func menuItemTitles(menu: AXUIElement, source: HierarchySource, limit: Int = 5,
                           expired: () -> Bool = { false }) -> [String] {
    var titles: [String] = []
    guard !expired(), let items = try? source.children(of: menu) else { return titles }

    for item in items {
        if titles.count >= limit || expired() {
            break
        }

        guard source.attribute(item, "AXRole") as? String == "AXMenuItem",
              let title = source.attribute(item, "AXTitle") as? String, !title.isEmpty else { continue }

        titles.append(title)
    }

    return titles
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
/// 2026-10-15 on a SwiftUI fixture: window, group, then the menu). A subtree whose read fails is skipped,
/// because an open menu elsewhere still answers.
///
/// Bounded three ways, because `see --scope menu` and `act` both run it while a menu window is up and the
/// tree may be large or the app slow (review of #530): `limit` caps the elements visited AND queued (a child
/// beyond the allowance is never enqueued), `expired` stops the walk between reads (pair it with a
/// `DeadlineHierarchySource` to bound each read), and an element reached twice is visited once.
public func findOpenContextMenu(app: AXUIElement, source: HierarchySource, limit: Int = 4000,
                                expired: () -> Bool = { false }) -> AXUIElement? {
    var queue = [app]
    var seen: Set<AXUIElement> = [app]
    var head = 0
    while head < queue.count, head < limit, !expired() {
        let element = queue[head]
        head += 1
        let role = source.attribute(element, "AXRole") as? String
        if role == "AXMenu" {
            return element
        }

        if role == "AXMenuBar" || expired() {
            continue
        }

        guard let children = try? source.children(of: element) else { continue }

        for child in children where queue.count < limit && seen.insert(child).inserted {
            queue.append(child)
        }
    }

    return nil
}
