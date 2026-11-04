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
        if command == "menu-see", ["--menu-bar-only", "--extras"].contains(input[index]) {
            guard parsed[input[index]] == nil else {
                throw SnapshotError.invalid("duplicate menu argument: " + input[index])
            }
            parsed[input[index]] = "true"
            index += 1
            continue
        }
        guard values.contains(input[index]), index + 1 < input.count, parsed[input[index]] == nil else {
            throw SnapshotError.invalid("invalid or duplicate menu argument: " + input[index])
        }
        parsed[input[index]] = input[index + 1]
        index += 2
    }
    guard parsed["--app"] != nil else { throw SnapshotError.invalid("--app required") }
    if parsed["--extras"] != nil, parsed["--menu"] != nil || parsed["--menu-bar-only"] != nil {
        throw SnapshotError.invalid("--extras lists the app's status items; it takes no --menu or --menu-bar-only")
    }
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
/// `findOpenContextMenu` never enters the bar, so that case falls through to the bar. The caller's
/// 3 s deadline covers discovery and hydration, with each read at most 0.5 s, so a slow app
/// answers or refuses well inside the wrapper's 30 s timeout (review of #530).
/// One menu read's budget: discovery and hydration share it, and every read gets a fresh one, so the
/// act-time revalidation is not starved by the observation that came before it.
private func menuReadSource() -> DeadlineHierarchySource {
    DeadlineHierarchySource(LiveHierarchySource(), deadline: ProcessInfo.processInfo.systemUptime + 3)
}

private func openContextMenu(_ pid: pid_t, source: DeadlineHierarchySource) -> AXUIElement? {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    guard !menuWindowIDs(in: windows, pid: pid).isEmpty else { return nil }

    // An open status item menu hangs under its item in the extras bar, which the app's own tree never reaches.
    return findOpenContextMenu(app: AXUIElementCreateApplication(pid), source: source, expired: source.expired)
        ?? openStatusMenu(pid)
}

/// The menu a status item of this app has open: the AXMenu child of an item of its extras bar, or nil. An item
/// keeps its AXMenu child while the menu is closed too, so only an on-screen menu window of the app counts as open.
private func openStatusMenu(_ pid: pid_t) -> AXUIElement? {
    guard !menuWindowIDs(in: onScreenWindows(), pid: pid).isEmpty else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    guard let raw = axAttribute(app, extrasMenuBarAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        return nil
    }
    let source = LiveHierarchySource()
    for item in (try? source.children(of: raw as! AXUIElement)) ?? [] {
        if let menu = ((try? source.children(of: item)) ?? []).first(where: { axStringAttribute($0, "AXRole") == "AXMenu" }) {
            return menu
        }
    }
    return nil
}

/// 🛑 `see --scope menu` listed only the menu bar, so a context menu that `act --button right` had just
/// opened could not be read or pressed through the menu surface (reported 2026-10-15). While one is
/// open it is the menu this app is tracking, and the bar cannot be used anyway, so it is listed
/// instead of the bar. A context-menu token re-finds the open menu at act time and refuses when it
/// closed, rather than falling back to the bar and pressing a bar row by the same index.
private func menuTree(_ pid: pid_t, depth: Int, rootTitle: String?, contextMenu: Bool? = nil, extras: Bool = false,
                      source: DeadlineHierarchySource) throws -> (tree: ObservedTreeData, contextMenu: Bool) {
    if extras {
        let observed = try extrasTree(pid, source: source)
        return (observed.tree, observed.openMenu)
    }
    if rootTitle == nil, contextMenu != false {
        if let menu = openContextMenu(pid, source: source) {
            return (try buildObservedTree(root: menu, source: source, depth: depth, scope: "menu", expired: source.expired), true)
        }

        guard !source.expired() else {
            throw ObservedTreeError("context-menu observation budget ran out; inspect again")
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
/// The app's status items: the children of its `AXExtrasMenuBar` (there is no kAX constant for it), one level
/// deep. Pressing one opens its menu; the open menu is then read with a plain `menu-see` (an app's open status
/// menu is a menu window, which `openContextMenu` finds), or, for a SwiftUI `MenuBarExtra` with the window style,
/// with the window surface.
private func extrasTree(_ pid: pid_t, source: DeadlineHierarchySource) throws -> (tree: ObservedTreeData, openMenu: Bool) {
    // While one of its menus is open, the menu is what can be pressed (the bar is tracking it), so it is listed.
    if let menu = openStatusMenu(pid) {
        return (try buildObservedTree(root: menu, source: source, depth: 40, scope: "menu", expired: source.expired), true)
    }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1)
    guard let raw = axAttribute(app, extrasMenuBarAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        throw ObservedTreeError("application has no status items (no AXExtrasMenuBar); list every app's with `statusitems`")
    }
    let bar = raw as! AXUIElement
    return (try buildObservedTree(root: bar, source: MenuBarHierarchy(root: bar), depth: 2, scope: "menu"), false)
}

private func onScreenWindows() -> [[String: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
}

func cmdMenu(_ command: String) {
    var started = false
    var openedMenu = false
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
        let extras = token?.extras == true || input["--extras"] == "true"
        let contextMenu: Bool? = input["--menu-bar-only"] == "true" ? false : token.map { $0.contextMenu == true }
        let observed = try menuTree(pid, depth: token?.depth ?? 40, rootTitle: rootTitle,
                                    contextMenu: contextMenu, extras: extras, source: menuReadSource())
        let tree = observed.tree
        if command == "menu-see" {
            let token = MenuSnapshotToken(pid:pid,launch:launch,depth:40,digest:tree.digest,created:Date().timeIntervalSince1970,
                                          rootTitle:rootTitle,contextMenu:observed.contextMenu,extras:extras)
            let raw = try JSONEncoder().encode(token).base64EncodedString()
            var output: [String: Any] = ["ok":true,"app":appName,"pid":pid,"processLaunch":launch,"surface":"menu","snapshot":raw,
                        "elements":tree.rows.map { $0.filter { $0.key != "identity" } }]
            if extras {
                output["extras"] = true
                output["note"] = observed.contextMenu
                    ? "a status item's menu is open and listed instead of the items; press an entry with act --snapshot "
                        + "<this snapshot> --element <n> --action press, or close it with --ax-action AXCancel on row 0"
                    : "the app's status items (right side of the menu bar); press one with act --snapshot "
                        + "<this snapshot> --element <n> --action press, then read its open menu with see --scope extras again"
                if observed.contextMenu { output["statusMenu"] = true }
            } else if observed.contextMenu {
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
            let fresh = try menuTree(pid, depth: token.depth, rootTitle: rootTitle,
                                     contextMenu: token.contextMenu == true, extras: extras, source: menuReadSource()).tree
            _ = try token.validate(pid: pid, launch: observedLaunch(pid), digest: fresh.digest,
                element: index, count: fresh.elements.count, now: Date().timeIntervalSince1970)
            // Same rule as the outer guard: a press that must open a tracking menu needs the key
            // window, while AXPick and AXCancel do not, so they must not fail here either.
            guard frontmostPid() == pid || !menuActionRequiresFrontmost(action, contextMenu: token.needsNoFrontmost) else {
                throw SnapshotError.refusal(.focusMismatch, "menu lost focus while presenting cursor")
            }
            started = true
            let windowsBefore = menuWindowIDs(in: onScreenWindows(), pid: pid)
            if extras {
                // A status item's AXPress returns only when its menu closes: the owner's main thread runs the
                // menu's tracking loop. A short timeout and a look for the new menu window tell the two apart.
                AXUIElementSetMessagingTimeout(element, 0.5)
            }
            let result = AXUIElementPerformAction(element,action as CFString)
            if extras, result == .cannotComplete {
                Thread.sleep(forTimeInterval: 0.15)
                if menuWindowAppeared(before: windowsBefore, after: menuWindowIDs(in: onScreenWindows(), pid: pid)) {
                    openedMenu = true
                    return
                }
            }
            guard result == .success else { throw ObservedTreeError("menu action failed or timed out (AX \(result.rawValue)); inspect before doing anything else") }
        // Always report WHICH row was pressed, not just its index. Without the title, a caller
        // cannot tell a correct press from the stale-index press described above.
        }, axAction: action)
        var output: [String: Any] = ["ok":true,"surface":"menu","action":action,"element":index,"title":elementTitle,"pid":pid,
                    "dispatchState":"dispatched","refreshRequired":true,
                    "frontmostChanged":frontmostPid() != startingFrontmost]
        if openedMenu {
            output["opened"] = "menu"
            output["note"] = "the status item's menu is open; read it with see --scope extras (or menu-see --extras)"
        }
        jsonOutput(output)
    } catch {
        jsonOutput(["ok":false,"error":error.localizedDescription,"dispatchState":started ? "uncertain" : "not_started",
                    "refusal":(error as? SnapshotError)?.category.rawValue ?? "refused"])
        exit(1)
    }
}

/// The attribute that holds an app's status items. ApplicationServices has no kAX constant for it.
let extrasMenuBarAttribute = "AXExtrasMenuBar"

/// The window layer of menu bar status items (`kCGStatusWindowLevel`).
private let statusItemWindowLayer = 25

/// Every running app's status items, without `--app`: owner, pid, position in its extras bar (the `--element` of a
/// `menu-see --app <owner> --extras` read, where row 0 is the extras bar itself), title, description, identifier and frame. Apps are asked in parallel
/// with a short AX timeout each, so one hung app cannot stall the list; the owners of on-screen status windows come
/// first, then every other app (a status item can belong to a process with no visible window of that layer).
func cmdStatusItems() {
    let query = argValue("--query")?.lowercased()
    let appFilter = argValue("--app")?.lowercased()
    let started = ProcessInfo.processInfo.systemUptime
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    let statusOwners = Set(windows.compactMap { window -> Int32? in
        guard (window[kCGWindowLayer as String] as? NSNumber)?.intValue == statusItemWindowLayer else { return nil }
        return (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    })
    let apps = NSWorkspace.shared.runningApplications.filter { app in
        guard app.processIdentifier > 0, !app.isTerminated else { return false }
        guard let appFilter else { return true }
        return (app.localizedName?.lowercased() == appFilter) || (app.bundleIdentifier?.lowercased() == appFilter)
    }
    let lock = NSLock()
    var rows: [[String: Any]] = []
    var timedOut: [String] = []
    DispatchQueue.concurrentPerform(iterations: apps.count) { position in
        let app = apps[position]
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.4)
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, extrasMenuBarAttribute as CFString, &raw)
        if result == .cannotComplete {
            // A background helper (no Dock icon, no menu bar) that does not answer is noise, not a gap.
            if app.activationPolicy != .prohibited || statusOwners.contains(app.processIdentifier) {
                lock.lock(); timedOut.append(app.localizedName ?? String(app.processIdentifier)); lock.unlock()
            }
            return
        }
        guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else { return }
        let bar = raw as! AXUIElement
        AXUIElementSetMessagingTimeout(bar, 0.4)
        let items = (try? LiveHierarchySource().children(of: bar)) ?? []
        var found: [[String: Any]] = []
        for (index, item) in items.enumerated() {
            let title = axStringAttribute(item, "AXTitle") ?? ""
            let description = axStringAttribute(item, "AXDescription") ?? ""
            let identifier = axStringAttribute(item, "AXIdentifier") ?? ""
            let frame = axFrame(item)
            let row: [String: Any] = [
                "app": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier,
                "element": index + 1, "title": title, "description": description, "identifier": identifier,
                "role": axStringAttribute(item, "AXRole") ?? "", "actions": axActionNames(item),
                "frame": ["x": frame.origin.x, "y": frame.origin.y, "width": frame.width, "height": frame.height],
                "statusWindow": statusOwners.contains(app.processIdentifier),
            ]
            if let query, ![title, description, identifier, app.localizedName ?? "", app.bundleIdentifier ?? ""]
                .contains(where: { $0.lowercased().contains(query) }) {
                continue
            }
            found.append(row)
        }
        lock.lock(); rows.append(contentsOf: found); lock.unlock()
    }
    // Left to right, as they sit in the menu bar; an item with no frame (hidden behind the notch) last.
    rows.sort { a, b in
        let ax = ((a["frame"] as? [String: Any])?["x"] as? CGFloat) ?? .greatestFiniteMagnitude
        let bx = ((b["frame"] as? [String: Any])?["x"] as? CGFloat) ?? .greatestFiniteMagnitude
        return ax < bx
    }
    var output: [String: Any] = [
        "ok": true, "surface": "statusitems", "items": rows, "appsAsked": apps.count,
        "ms": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
        "note": "press one: menu-see --app <bundleId or pid> --extras, then menu-act with that snapshot and the row's element",
    ]
    if !timedOut.isEmpty {
        output["timedOut"] = timedOut.sorted()
    }
    jsonOutput(output)
}
