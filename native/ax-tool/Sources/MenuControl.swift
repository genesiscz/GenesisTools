import AppKit
import ApplicationServices
import Foundation
import SnapshotSupport

private func menuArguments(_ command: String) throws -> [String:String] {
    let values: Set<String> = command == "menu-see" ? ["--app","--menu"] : ["--app","--snapshot","--element","--action","--expect-title"]
    var parsed: [String:String] = [:]
    let input = Array(args.dropFirst(2))
    var index = 0
    while index < input.count {
        if input[index] == "--no-cursor" { index += 1; continue }
        guard values.contains(input[index]), index + 1 < input.count, parsed[input[index]] == nil else {
            throw SnapshotError.invalid("invalid or duplicate menu argument: " + input[index])
        }
        parsed[input[index]] = input[index + 1]
        index += 2
    }
    guard parsed["--app"] != nil else { throw SnapshotError.invalid("--app required") }
    return parsed
}
private struct MenuBarHierarchy: HierarchySource {
    let root: AXUIElement
    let base = LiveHierarchySource()
    func attribute(_ element: AXUIElement, _ name: String) -> Any? { base.attribute(element,name) }
    func actionNames(of element: AXUIElement) -> [String] { base.actionNames(of:element) }
    func isValueSettable(_ element: AXUIElement) -> Bool? { base.isValueSettable(element) }
    func children(of element: AXUIElement) throws -> [AXUIElement] {
        return CFEqual(element,root) ? try base.children(of:element) : []
    }
}
/// The app's open context menu, looked for only while the window server shows a menu window for the
/// app, so a plain menu-bar read stays one cheap call. A menu-bar menu is a menu window too, but
/// `findOpenContextMenu` never enters the bar, so that case falls through to the bar.
private func openContextMenu(_ pid: pid_t) -> AXUIElement? {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    guard !menuWindowIDs(in: windows, pid: pid).isEmpty else { return nil }

    return findOpenContextMenu(app: AXUIElementCreateApplication(pid), source: LiveHierarchySource())
}

/// 🛑 `see --scope menu` listed only the menu bar, so a context menu that `act --button right` had just
/// opened could not be read or pressed through the menu surface (reported 2026-10-15). While one is
/// open it is the menu this app is tracking, and the bar cannot be used anyway, so it is listed
/// instead of the bar. A context-menu token re-finds the open menu at act time and refuses when it
/// closed, rather than falling back to the bar and pressing a bar row by the same index.
private func menuTree(_ pid: pid_t, depth: Int, rootTitle: String?,
                      contextMenu: Bool? = nil) throws -> (tree: ObservedTreeData, contextMenu: Bool) {
    if rootTitle == nil, contextMenu != false {
        if let menu = openContextMenu(pid) {
            return (try buildObservedTree(root: menu, source: LiveHierarchySource(), depth: depth, scope: "menu"), true)
        }

        if contextMenu == true {
            throw SnapshotError.refusal(.staleObservation,
                "the context menu is no longer open (a click or key press anywhere closes it); open it again, then see --scope menu")
        }
    }

    return (try menuBarTree(pid, depth: depth, rootTitle: rootTitle), false)
}

private func menuBarTree(_ pid: pid_t, depth: Int, rootTitle: String?) throws -> ObservedTreeData {
    let app = AXUIElementCreateApplication(pid)
    guard let raw = axAttribute(app, kAXMenuBarAttribute as String),
          CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        throw ObservedTreeError("application does not expose a menu bar")
    }
    let bar = raw as! AXUIElement
    if let title = rootTitle {
        let matches = try LiveHierarchySource().children(of:bar).filter { axStringAttribute($0,"AXTitle") == title }
        guard matches.count == 1 else { throw ObservedTreeError("top-level menu title is missing or ambiguous") }
        return try buildObservedTree(root:matches[0],source:LiveHierarchySource(),depth:depth,scope:"menu")
    }
    return try buildObservedTree(root:bar,source:MenuBarHierarchy(root:bar),depth:depth,scope:"menu")
}
func cmdMenu(_ command: String) {
    var started = false
    do {
        let input = try menuArguments(command)
        let appName = input["--app"]!
        var token: MenuSnapshotToken?
        var index = 0
        if command == "menu-act" {
            guard let raw = input["--snapshot"], raw.count < 65536, let data = Data(base64Encoded:raw),
                  let decoded = try? JSONDecoder().decode(MenuSnapshotToken.self,from:data),
                  let rawIndex = input["--element"], let selected = Int(rawIndex), selected >= 0 else {
                throw SnapshotError.invalid("menu-act requires a menu snapshot and current element index")
            }
            token = decoded
            index = selected
        }
        let pid = resolveApp(appName)
        let startingFrontmost = frontmostPid()
        let launch = try observedLaunch(pid)
        if let token {
            try token.validate(pid:pid,launch:launch,digest:token.digest,element:index,count:4000,now:Date().timeIntervalSince1970)
        }
        let rootTitle = token?.rootTitle ?? input["--menu"]
        let observed = try menuTree(pid, depth: token?.depth ?? 40, rootTitle: rootTitle,
                                    contextMenu: token.map { $0.contextMenu == true })
        let tree = observed.tree
        if command == "menu-see" {
            let token = MenuSnapshotToken(pid:pid,launch:launch,depth:40,digest:tree.digest,created:Date().timeIntervalSince1970,
                                          rootTitle:rootTitle,contextMenu:observed.contextMenu)
            let raw = try JSONEncoder().encode(token).base64EncodedString()
            var output: [String: Any] = ["ok":true,"app":appName,"pid":pid,"processLaunch":launch,"surface":"menu","snapshot":raw,
                        "elements":tree.rows.map { $0.filter { $0.key != "identity" } }]
            if observed.contextMenu {
                output["contextMenu"] = true
                output["note"] = "an open context menu is listed instead of the menu bar; press an item with act --snapshot "
                    + "<this snapshot> --element <n> --action press. It closes on the user's next click or key press"
            }
            jsonOutput(output)
            return
        }
        guard let token, tree.elements.indices.contains(index) else {
            throw SnapshotError.refusal(.missingTarget,"menu index outside current observation")
        }
        let element = tree.elements[index]
        // Menu indexes are positions in a live tree, not identities: the same menu observed with
        // the app focused can carry MORE rows than the same menu observed unfocused, so an index
        // carried over from an earlier read presses a different item and reports success. Measured
        // on Flow 2026-09-21: row 45 was "Statistics" in one read and "Fullscreen" in the next, and
        // pressing the stale index silently fullscreened the app. The snapshot digest cannot catch
        // this, because the caller correctly passed the FRESH token and only the index was stale.
        let elementTitle = axStringAttribute(element, "AXTitle") ?? ""
        if let expected = input["--expect-title"], expected != elementTitle {
            throw SnapshotError.refusal(.missingTarget,
                "menu row \(index) is titled \"\(elementTitle)\", not \"\(expected)\"; read the menu again and take the index from that same result")
        }
        let action = input["--action"] ?? "AXPress"
        guard axActionNames(element).contains(action) else { throw SnapshotError.invalid("menu item does not expose the requested AX action") }
        try dispatchMenuAction(token:token,pid:pid,launch:launch,digest:tree.digest,element:index,count:tree.elements.count,
            now:Date().timeIntervalSince1970,frontmost:frontmostPid() == pid,
            enabled:(axAttribute(element,"AXEnabled") as? NSNumber)?.boolValue != false, action: {
            AXUIElementSetMessagingTimeout(element,3)
            let frame = axFrame(element)
            if frame.width > 0, frame.height > 0 {
                ActionCursor.emit("press",point:CGPoint(x:frame.midX,y:frame.midY),background:false,target:"ax")
            } else {
                ActionCursor.emit("press", point: nil)
            }
            let fresh = try menuTree(pid, depth: token.depth, rootTitle: rootTitle, contextMenu: token.contextMenu == true).tree
            _ = try token.validate(pid: pid, launch: observedLaunch(pid), digest: fresh.digest,
                element: index, count: fresh.elements.count, now: Date().timeIntervalSince1970)
            // Same rule as the outer guard: a press that must open a tracking menu needs the key
            // window, while AXPick and AXCancel do not, so they must not fail here either.
            guard frontmostPid() == pid || !menuActionRequiresFrontmost(action, contextMenu: token.contextMenu == true) else {
                throw SnapshotError.refusal(.focusMismatch, "menu lost focus while presenting cursor")
            }
            started = true
            let result = AXUIElementPerformAction(element,action as CFString)
            guard result == .success else { throw ObservedTreeError("menu action failed or timed out (AX \(result.rawValue)); inspect before doing anything else") }
        // Always report WHICH row was pressed, not just its index. Without the title, a caller
        // cannot tell a correct press from the stale-index press described above.
        }, axAction: action)
        jsonOutput(["ok":true,"surface":"menu","action":action,"element":index,"title":elementTitle,"pid":pid,
                    "dispatchState":"dispatched","refreshRequired":true,
                    "frontmostChanged":frontmostPid() != startingFrontmost])
    } catch {
        jsonOutput(["ok":false,"error":error.localizedDescription,"dispatchState":started ? "uncertain" : "not_started",
                    "refusal":(error as? SnapshotError)?.category.rawValue ?? "refused"])
        exit(1)
    }
}
