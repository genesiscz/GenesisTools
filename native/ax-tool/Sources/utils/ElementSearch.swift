import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// Recursive search by AXIdentifier. Returns first match.
//
// Capped like every other walker here (collectElements 15, buildTree 10, the ancestor climbs 50).
// One nested NSBox is one accessibility level and Electron trees go past 15, so the cap is the
// climbs' 50: deep enough for anything real, and a pathological tree ends instead of walking
// every node for the whole 10 s the caller allows.
func findByIdentifier(_ root: AXUIElement, id: String, maxDepth: Int = 50, depth: Int = 0) -> AXUIElement? {
    if axStringAttribute(root, "AXIdentifier") == id {
        return root
    }
    if depth >= maxDepth {
        return nil
    }
    for child in axChildren(root) {
        if let found = findByIdentifier(child, id: id, maxDepth: maxDepth, depth: depth + 1) {
            return found
        }
    }
    return nil
}

// Search across all windows of an app
func findInApp(_ appElement: AXUIElement, id: String, maxDepth: Int = 50) -> AXUIElement? {
    for window in axWindows(appElement) {
        if let found = findByIdentifier(window, id: id, maxDepth: maxDepth) {
            return found
        }
    }
    return nil
}

// Detached-thread runner (Peekaboo pattern): AXUIElementPerformAction can
// block forever if the action opens a nested run loop (context menus, sheets).
// Run on a detached thread, race against a timeout.
func performActionWithTimeout(
    _ element: AXUIElement,
    action: String,
    timeoutMs: Int = 5000
) -> AXError {
    let sem = DispatchSemaphore(value: 0)
    var result: AXError = .failure

    let thread = Thread {
        result = AXUIElementPerformAction(element, action as CFString)
        sem.signal()
    }
    thread.start()

    let timeout = DispatchTime.now() + .milliseconds(timeoutMs)
    let waitResult = sem.wait(timeout: timeout)

    if waitResult == .timedOut {
        // For menu/dialog-opening actions, timeout means the action DID fire
        // and is blocking in a nested run loop — that's success, not failure.
        return .success
    }
    return result
}

// Collect all elements with their identifiers (for list/debug)
struct ElementInfo {
    let identifier: String?
    let role: String?
    let title: String?
    let value: String?
    let subrole: String?
    let description: String?
}

/// A wall-clock limit for an element walk: an app with a huge tree (Finder's desktop and a big
/// Downloads list) otherwise ran past the runner's 10 s timeout and returned nothing at all.
final class WalkBudget {
    let deadline: Date
    private(set) var exhausted = false

    init(seconds: TimeInterval) {
        deadline = Date().addingTimeInterval(seconds)
    }

    func spent() -> Bool {
        if !exhausted && Date() >= deadline {
            exhausted = true
        }
        return exhausted
    }
}

func collectElements(_ root: AXUIElement, depth: Int = 0, maxDepth: Int = 15, budget: WalkBudget? = nil) -> [ElementInfo] {
    if depth > maxDepth { return [] }
    if let budget, budget.spent() { return [] }

    var results: [ElementInfo] = []

    // One element costs several reads and each may block for the per-read timeout, so the budget is checked
    // between the reads as well: once it is spent the element keeps what it has and skips the rest.
    let outOfTime = { budget?.spent() ?? false }
    let ident = axStringAttribute(root, "AXIdentifier")
    let role = axStringAttribute(root, "AXRole")
    let title = outOfTime() ? nil : axStringAttribute(root, "AXTitle")
    let subrole = outOfTime() ? nil : axStringAttribute(root, "AXSubrole")
    let desc = outOfTime() ? nil : axStringAttribute(root, "AXDescription")

    var valueStr: String? = nil
    if !outOfTime(), let v = axAttribute(root, "AXValue") {
        valueStr = "\(v)"
    }

    if ident != nil || role != nil {
        results.append(ElementInfo(
            identifier: ident, role: role, title: title,
            value: valueStr, subrole: subrole, description: desc
        ))
    }

    if outOfTime() { return results }

    for child in axChildren(root) {
        if let budget, budget.spent() { break }
        results.append(contentsOf: collectElements(child, depth: depth + 1, maxDepth: maxDepth, budget: budget))
    }
    return results
}
