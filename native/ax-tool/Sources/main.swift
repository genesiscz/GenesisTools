import ApplicationServices
import AppKit
import CoreText
import Foundation
import Vision

// MARK: - AX helpers

// Resolves --app: numeric pid > exact name > case-insensitive name > bundleId
// substring. Fails loud (with candidates) when 2+ processes match a tier —
// same-named instances (two Brave profiles) must be targeted by pid, never
// silently picked. Regular-activation-policy apps win over background helpers.
func resolveApp(_ name: String) -> pid_t {
    let apps = NSWorkspace.shared.runningApplications
    if let pidNum = Int32(name) {
        if apps.contains(where: { $0.processIdentifier == pidNum }) { return pidNum }
        errorExit("no running process with pid \(name)")
    }
    let tiers: [(NSRunningApplication) -> Bool] = [
        { $0.localizedName == name },
        { $0.localizedName?.lowercased() == name.lowercased() },
        { $0.bundleIdentifier?.lowercased().contains(name.lowercased()) == true },
    ]
    for tier in tiers {
        var matches = apps.filter(tier)
        if matches.count > 1 {
            let regular = matches.filter { $0.activationPolicy == .regular }
            if !regular.isEmpty { matches = regular }
        }
        if matches.count == 1 { return matches[0].processIdentifier }
        if matches.count > 1 {
            jsonOutput(["ok": false,
                "error": "ambiguous: \(matches.count) processes match '\(name)' — target one with --app <pid>",
                "candidates": matches.map { ["name": $0.localizedName ?? "?", "pid": $0.processIdentifier,
                                             "bundleId": $0.bundleIdentifier ?? ""] }])
            exit(1)
        }
    }
    errorExit("app not found: \(name)")
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    guard err == .success, let children = value as? [AXUIElement] else { return [] }
    return children
}

func axAttribute(_ element: AXUIElement, _ attr: String) -> CFTypeRef? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
    guard err == .success else { return nil }
    return value
}

func axStringAttribute(_ element: AXUIElement, _ attr: String) -> String? {
    axAttribute(element, attr) as? String
}

func axWindows(_ app: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    guard err == .success, let windows = value as? [AXUIElement] else { return [] }
    return windows
}

// Recursive search by AXIdentifier. Returns first match.
func findByIdentifier(_ root: AXUIElement, id: String) -> AXUIElement? {
    if axStringAttribute(root, "AXIdentifier") == id {
        return root
    }
    for child in axChildren(root) {
        if let found = findByIdentifier(child, id: id) {
            return found
        }
    }
    return nil
}

// Search across all windows of an app
func findInApp(_ appElement: AXUIElement, id: String) -> AXUIElement? {
    for window in axWindows(appElement) {
        if let found = findByIdentifier(window, id: id) {
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

func collectElements(_ root: AXUIElement, depth: Int = 0, maxDepth: Int = 15) -> [ElementInfo] {
    if depth > maxDepth { return [] }

    var results: [ElementInfo] = []
    let ident = axStringAttribute(root, "AXIdentifier")
    let role = axStringAttribute(root, "AXRole")
    let title = axStringAttribute(root, "AXTitle")
    let subrole = axStringAttribute(root, "AXSubrole")
    let desc = axStringAttribute(root, "AXDescription")

    var valueStr: String? = nil
    if let v = axAttribute(root, "AXValue") {
        valueStr = "\(v)"
    }

    if ident != nil || role != nil {
        results.append(ElementInfo(
            identifier: ident, role: role, title: title,
            value: valueStr, subrole: subrole, description: desc
        ))
    }

    for child in axChildren(root) {
        results.append(contentsOf: collectElements(child, depth: depth + 1, maxDepth: maxDepth))
    }
    return results
}

// MARK: - Extended AX Helpers

func axAttributeNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyAttributeNames(element, &names)
    guard err == .success, let arr = names as? [String] else { return [] }
    return arr
}

func axActionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    let err = AXUIElementCopyActionNames(element, &names)
    guard err == .success, let arr = names as? [String] else { return [] }
    return arr
}

func axPointValue(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    guard let val = axAttribute(el, attr),
          CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var pt = CGPoint.zero
    guard AXValueGetValue(val as! AXValue, .cgPoint, &pt) else { return nil }
    return pt
}

func axSizeValue(_ el: AXUIElement, _ attr: String) -> CGSize? {
    guard let val = axAttribute(el, attr),
          CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var sz = CGSize.zero
    guard AXValueGetValue(val as! AXValue, .cgSize, &sz) else { return nil }
    return sz
}

func serializeAXValue(_ val: CFTypeRef) -> Any {
    if let s = val as? String { return s }
    if CFGetTypeID(val) == CFBooleanGetTypeID() {
        return (val as! NSNumber).boolValue
    }
    if let n = val as? NSNumber { return n }
    if CFGetTypeID(val) == AXValueGetTypeID() {
        let axVal = val as! AXValue
        var p = CGPoint.zero; var s = CGSize.zero
        var r = CGRect.zero; var rng = CFRange(location: 0, length: 0)
        if AXValueGetValue(axVal, .cgPoint, &p) { return ["x": p.x, "y": p.y] }
        if AXValueGetValue(axVal, .cgSize, &s) { return ["w": s.width, "h": s.height] }
        if AXValueGetValue(axVal, .cgRect, &r) {
            return ["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height]
        }
        if AXValueGetValue(axVal, .cfRange, &rng) {
            return ["loc": rng.location, "len": rng.length]
        }
        return "<AXValue>"
    }
    if let arr = val as? [AXUIElement] { return "<\(arr.count) elements>" }
    return "\(val)"
}

func fuzzyRoleMatch(_ actual: String?, _ query: String, exact: Bool) -> Bool {
    guard let a = actual else { return false }
    if a == query { return true }
    if let re = parseRegex(query) {
        return re.firstMatch(in: a, range: NSRange(a.startIndex..., in: a)) != nil
    }
    if exact { return false }
    let al = a.lowercased()
    let ql = query.lowercased()
    if al == ql { return true }
    let stripped = al.hasPrefix("ax") ? String(al.dropFirst(2)) : al
    if stripped == ql { return true }
    if stripped.contains(ql) { return true }
    return false
}

func parseRegex(_ pattern: String) -> NSRegularExpression? {
    guard pattern.hasPrefix("/"), pattern.count > 2 else { return nil }
    let body = pattern.dropFirst()
    guard let lastSlash = body.lastIndex(of: "/"), lastSlash != body.startIndex else { return nil }
    let re = String(body[body.startIndex..<lastSlash])
    let flags = String(body[body.index(after: lastSlash)...])
    var opts: NSRegularExpression.Options = []
    if flags.contains("i") { opts.insert(.caseInsensitive) }
    if flags.contains("m") { opts.insert(.anchorsMatchLines) }
    if flags.contains("s") { opts.insert(.dotMatchesLineSeparators) }
    return try? NSRegularExpression(pattern: re, options: opts)
}

func stringMatches(_ haystack: String?, _ needle: String) -> Bool {
    guard let h = haystack, !h.isEmpty else { return false }
    if let re = parseRegex(needle) {
        return re.firstMatch(in: h, range: NSRange(h.startIndex..., in: h)) != nil
    }
    return h.localizedCaseInsensitiveContains(needle)
}

// --depth applies to EVERY element search (get/press/click/wait targeting too,
// not just find/list) — browser page content easily nests past the default 15.
func targetSearchDepth() -> Int {
    let a = CommandLine.arguments
    if let i = a.firstIndex(of: "--depth"), i + 1 < a.count, let d = Int(a[i + 1]) { return d }
    return 15
}

func findByAttributes(_ root: AXUIElement, role: String?, title: String?,
                       value: String?, desc: String?, subrole: String? = nil,
                       text: String? = nil, searchAll: Bool = false, exact: Bool = false,
                       depth: Int = 0, maxDepth: Int = targetSearchDepth()) -> [AXUIElement] {
    if depth > maxDepth { return [] }
    var results: [AXUIElement] = []
    var matches = true
    if let r = role, !fuzzyRoleMatch(axStringAttribute(root, "AXRole"), r, exact: exact) { matches = false }
    if matches, let s = subrole, !fuzzyRoleMatch(axStringAttribute(root, "AXSubrole"), s, exact: exact) { matches = false }
    if matches, let t = title {
        if !stringMatches(axStringAttribute(root, "AXTitle"), t) { matches = false }
    }
    if matches, let v = value {
        if !stringMatches(axAttribute(root, "AXValue").map({ "\($0)" }), v) { matches = false }
    }
    if matches, let d = desc {
        if !stringMatches(axStringAttribute(root, "AXDescription"), d) { matches = false }
    }
    if matches, let txt = text {
        var found = stringMatches(axStringAttribute(root, "AXIdentifier"), txt) ||
                    stringMatches(axStringAttribute(root, "AXTitle"), txt) ||
                    stringMatches(axStringAttribute(root, "AXDescription"), txt)
        if searchAll && !found {
            found = stringMatches(axAttribute(root, "AXValue").map({ "\($0)" }), txt) ||
                    fuzzyRoleMatch(axStringAttribute(root, "AXRole"), txt, exact: false) ||
                    fuzzyRoleMatch(axStringAttribute(root, "AXSubrole"), txt, exact: false)
        }
        if !found { matches = false }
    }
    if matches { results.append(root) }
    for child in axChildren(root) {
        results.append(contentsOf: findByAttributes(child, role: role, title: title,
                                                     value: value, desc: desc, subrole: subrole,
                                                     text: text, searchAll: searchAll, exact: exact,
                                                     depth: depth + 1, maxDepth: maxDepth))
    }
    return results
}

func resolveElement(_ appElement: AXUIElement, _ appName: String, ignoreTextFlag: Bool = false) -> AXUIElement {
    if let id = argValue("--id") {
        guard let el = findInApp(appElement, id: id) else {
            errorExit("element not found: \(id) in \(appName)")
        }
        return el
    }
    let role = argValue("--role")
    let title = argValue("--title")
    let desc = argValue("--desc")
    let subrole = argValue("--subrole")
    let q = argValue("--q")
    let textSearch = ignoreTextFlag ? nil : argValue("--text")
    let windowScope = argValue("--window")
    let exact = args.contains("--exact")

    if role == nil && title == nil && desc == nil && subrole == nil && q == nil && textSearch == nil {
        errorExit("--id, --q, --text, or at least one of --role/--title/--desc/--subrole required")
    }

    let scopedWindows = axWindows(appElement).filter { w in
        guard let ws = windowScope else { return true }
        return (axStringAttribute(w, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws)
    }

    let searchTerm = q ?? textSearch
    let hasFilters = role != nil || title != nil || desc != nil || subrole != nil
    if let s = searchTerm, hasFilters {
        var all: [AXUIElement] = []
        for w in scopedWindows {
            all.append(contentsOf: findByAttributes(w, role: role, title: title, value: nil,
                desc: desc, subrole: subrole, text: s, searchAll: q != nil, exact: exact))
        }
        if all.count == 1 { return all[0] }
        if all.count > 1 {
            var candidates: [[String: Any]] = []
            for el in all.prefix(10) {
                var c: [String: Any] = [:]
                if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                candidates.append(c)
            }
            jsonOutput(["ok": false,
                "error": "ambiguous: '\(s)' + filters matched \(all.count) elements — narrow further",
                "count": all.count, "candidates": candidates])
            exit(1)
        }
        errorExit("no element matching '\(s)' with given filters in \(appName)")
    }
    if let q = q, role == nil && title == nil && desc == nil && subrole == nil {
        let isRegex = parseRegex(q) != nil
        if isRegex {
            var all: [AXUIElement] = []
            for w in scopedWindows {
                all.append(contentsOf: findByAttributes(w, role: nil, title: nil, value: nil,
                                                         desc: nil, text: q, searchAll: true))
            }
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(q)' matched \(all.count) elements — narrow with --role/--desc/--window",
                    "count": all.count, "candidates": candidates])
                exit(1)
            }
            errorExit("no element matching '\(q)' in \(appName)")
        }
        let levels: [(String, (AXUIElement) -> [AXUIElement])] = [
            ("id",      { _ in findInApp(appElement, id: q).map { [$0] } ?? [] }),
            ("title",   { w in findByAttributes(w, role: nil, title: q, value: nil, desc: nil) }),
            ("desc",    { w in findByAttributes(w, role: nil, title: nil, value: nil, desc: q) }),
            ("value",   { w in findByAttributes(w, role: nil, title: nil, value: q, desc: nil) }),
            ("role",    { w in findByAttributes(w, role: q, title: nil, value: nil, desc: nil) }),
            ("subrole", { w in findByAttributes(w, role: nil, title: nil, value: nil, desc: nil, subrole: q) }),
        ]
        for (lvl, search) in levels {
            var all: [AXUIElement] = []
            if lvl == "id" { all = search(appElement) }
            else { for w in scopedWindows { all.append(contentsOf: search(w)) } }
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(q)' matched \(all.count) elements by \(lvl) — narrow with --role/--desc/--window or use --id",
                    "matchedBy": lvl, "count": all.count, "candidates": candidates])
                exit(1)
            }
        }
        errorExit("no element matching '\(q)' in \(appName)")
    }

    if let t = textSearch, role == nil && title == nil && desc == nil && subrole == nil {
        let isRegex = parseRegex(t) != nil
        if isRegex {
            var all: [AXUIElement] = []
            for w in scopedWindows {
                all.append(contentsOf: findByAttributes(w, role: nil, title: nil, value: nil,
                                                         desc: nil, text: t))
            }
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let t = axStringAttribute(el, "AXTitle") { c["title"] = t }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(t)' matched \(all.count) elements — narrow with --role/--desc/--window",
                    "count": all.count, "candidates": candidates])
                exit(1)
            }
            errorExit("no element matching --text '\(t)' in \(appName)")
        }
        let levels: [(String, (AXUIElement) -> [AXUIElement])] = [
            ("id",    { _ in findInApp(appElement, id: t).map { [$0] } ?? [] }),
            ("title", { w in findByAttributes(w, role: nil, title: t, value: nil, desc: nil) }),
            ("desc",  { w in findByAttributes(w, role: nil, title: nil, value: nil, desc: t) }),
        ]
        for (lvl, search) in levels {
            var all: [AXUIElement] = []
            if lvl == "id" { all = search(appElement) }
            else { for w in scopedWindows { all.append(contentsOf: search(w)) } }
            if all.count == 1 { return all[0] }
            if all.count > 1 {
                var candidates: [[String: Any]] = []
                for el in all.prefix(10) {
                    var c: [String: Any] = [:]
                    if let id = axStringAttribute(el, "AXIdentifier") { c["id"] = id }
                    if let r = axStringAttribute(el, "AXRole") { c["role"] = r }
                    if let tt = axStringAttribute(el, "AXTitle") { c["title"] = tt }
                    if let d = axStringAttribute(el, "AXDescription") { c["desc"] = d }
                    candidates.append(c)
                }
                jsonOutput(["ok": false,
                    "error": "ambiguous: '\(t)' matched \(all.count) elements by \(lvl) — narrow with --role/--desc/--window or use --id",
                    "matchedBy": lvl, "count": all.count, "candidates": candidates])
                exit(1)
            }
        }
        errorExit("no element matching --text '\(t)' in \(appName)")
    }

    for window in scopedWindows {
        let hits = findByAttributes(window, role: role, title: title, value: nil,
                                     desc: desc, subrole: subrole, exact: exact)
        if let first = hits.first { return first }
    }
    var msg = "no element matching"
    if let r = role { msg += " role=\(r)" }
    if let s = subrole { msg += " subrole=\(s)" }
    if let t = title { msg += " title=\(t)" }
    if let d = desc { msg += " desc=\(d)" }
    if let w = windowScope { msg += " in window '\(w)'" }
    errorExit("\(msg) in \(appName)")
}

func elementInfo(_ el: AXUIElement) -> [String: Any] {
    var info: [String: Any] = [:]
    if let id = axStringAttribute(el, "AXIdentifier") { info["axId"] = id }
    if let r = axStringAttribute(el, "AXRole") { info["role"] = r }
    if let t = axStringAttribute(el, "AXTitle") { info["title"] = t }
    if let d = axStringAttribute(el, "AXDescription") { info["desc"] = d }
    return info
}

func buildTree(_ el: AXUIElement, depth: Int = 0, maxDepth: Int = 10) -> [String: Any] {
    var node: [String: Any] = [:]
    if let id = axStringAttribute(el, "AXIdentifier") { node["id"] = id }
    if let role = axStringAttribute(el, "AXRole") { node["role"] = role }
    if let title = axStringAttribute(el, "AXTitle") { node["title"] = title }
    if let sub = axStringAttribute(el, "AXSubrole") { node["subrole"] = sub }
    if let desc = axStringAttribute(el, "AXDescription") { node["desc"] = desc }
    if let v = axAttribute(el, "AXValue") { node["value"] = "\(v)" }
    if depth < maxDepth {
        let kids = axChildren(el)
        if !kids.isEmpty {
            node["children"] = kids.map { buildTree($0, depth: depth + 1, maxDepth: maxDepth) }
        }
    }
    return node
}

// MARK: - JSON output

func jsonOutput(_ dict: [String: Any]) {
    var opts: JSONSerialization.WritingOptions = [.sortedKeys]
    if CommandLine.arguments.contains("--pretty") { opts.insert(.prettyPrinted) }
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: opts),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func errorExit(_ message: String) -> Never {
    jsonOutput(["ok": false, "error": message])
    exit(1)
}

/// Activate an app and poll until it is actually frontmost. One activate()
/// call + fixed sleep races when another activation is still in flight —
/// re-request each poll (up to ~1.5s).
func bringFrontmost(_ pid: pid_t) -> Bool {
    let runningApp = NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid }
    for _ in 0..<15 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
        runningApp?.activate(options: [.activateIgnoringOtherApps])
        Thread.sleep(forTimeInterval: 0.1)
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
}

// MARK: - Commands


// Try AXScrollToVisible on an off-screen element, then re-check that its
// center landed inside a visible window. Used by set/type before refusing.
func tryScrollIntoView(_ el: AXUIElement, app: AXUIElement) -> Bool {
    guard axActionNames(el).contains("AXScrollToVisible") else { return false }
    let err = performActionWithTimeout(el, action: "AXScrollToVisible", timeoutMs: 3000)
    guard err == .success else { return false }
    Thread.sleep(forTimeInterval: 0.2)
    guard let pos = axPointValue(el, "AXPosition"),
          let size = axSizeValue(el, "AXSize") else { return false }
    let point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
    for w in axWindows(app) {
        if let wp = axPointValue(w, "AXPosition"), let ws = axSizeValue(w, "AXSize"),
           CGRect(x: wp.x, y: wp.y, width: ws.width, height: ws.height).contains(point) {
            return true
        }
    }
    return false
}

func cmdSet(appName: String, value: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let element = resolveElement(app, appName)
    let role = axStringAttribute(element, "AXRole") ?? ""
    let textRoles = Set(["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField"])

    var result: [String: Any] = ["ok": true, "action": "set", "value": value]
    result.merge(elementInfo(element)) { _, new in new }

    if textRoles.contains(role) {
        if !bringFrontmost(pid) {
            errorExit("could not bring \(appName) frontmost — set types via CGEvents, refusing while another app has keyboard focus")
        }
        raiseElementWindow(element)

        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, true as CFTypeRef)
        Thread.sleep(forTimeInterval: 0.1)
        let gotFocus = (axAttribute(element, "AXFocused") as? NSNumber)?.boolValue == true
        if !gotFocus {
            guard let pos = axPointValue(element, "AXPosition"),
                  let size = axSizeValue(element, "AXSize") else {
                errorExit("text field has no position and AXFocused failed — cannot type safely")
            }
            let point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
            var visible = false
            for w in axWindows(app) {
                if let wp = axPointValue(w, "AXPosition"), let ws = axSizeValue(w, "AXSize") {
                    if CGRect(x: wp.x, y: wp.y, width: ws.width, height: ws.height).contains(point) {
                        visible = true; break
                    }
                }
            }
            if !visible {
                if tryScrollIntoView(element, app: app),
                   let pos2 = axPointValue(element, "AXPosition"),
                   let size2 = axSizeValue(element, "AXSize") {
                    let point2 = CGPoint(x: pos2.x + size2.width / 2, y: pos2.y + size2.height / 2)
                    postClick(at: point2, right: false, double: false)
                    Thread.sleep(forTimeInterval: 0.1)
                    result["focusMethod"] = "scroll+click"
                } else {
                    errorExit("text field outside visible window and AXFocused failed — AXScrollToVisible unavailable, cannot type safely")
                }
            } else {
                postClick(at: point, right: false, double: false)
                Thread.sleep(forTimeInterval: 0.1)
                result["focusMethod"] = "click"
            }
        } else {
            result["focusMethod"] = "ax"
        }
        // HARD GUARD: Cmd+A/Delete/type go to whatever has OS keyboard focus.
        // If the target app is not frontmost, refuse — otherwise we corrupt
        // some other app's focused field (the "smart-set-tesreplace" family).
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        if frontPid != pid {
            errorExit("target app not frontmost (front pid \(frontPid ?? -1), want \(pid)) — refusing to send Cmd+A/type")
        }
        func clearAndType() {
            tapKey(0, flags: .maskCommand)  // Cmd+A
            Thread.sleep(forTimeInterval: 0.15)
            tapKey(51)  // Delete
            Thread.sleep(forTimeInterval: 0.1)
            typeString(value, delayMs: 8)
        }
        func readBack() -> String? {
            Thread.sleep(forTimeInterval: 0.15)
            return axAttribute(element, "AXValue").map { "\($0)" }
        }
        clearAndType()
        result["method"] = "type"
        // HARD VERIFY: read the field back; one retry on mismatch, then fail loud.
        var got = readBack()
        if let g = got, g != value {
            clearAndType()
            got = readBack()
            result["retries"] = 1
        }
        if let g = got {
            if g == value {
                result["verified"] = true
            } else {
                jsonOutput(["ok": false,
                    "error": "verify failed after retry: field shows '\(g)', expected '\(value)'",
                    "fieldValue": g, "expected": value])
                exit(1)
            }
        } else {
            result["verified"] = false
            result["warning"] = "field AXValue unreadable — typed but could not verify"
        }
    } else {
        var isSettable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &isSettable)
        if !isSettable.boolValue {
            let eid = axStringAttribute(element, "AXIdentifier") ?? "?"
            errorExit("element \(eid) (\(role)) is not settable")
        }
        let err = AXUIElementSetAttributeValue(
            element, kAXValueAttribute as CFString, value as CFTypeRef
        )
        if err != .success {
            errorExit("set failed: AXError \(err.rawValue)")
        }
        result["method"] = "axvalue"
    }
    jsonOutput(result)
}

func cmdPress(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let element = resolveElement(app, appName)

    let err = performActionWithTimeout(element, action: kAXPressAction as String)
    if err != .success {
        errorExit("press failed: AXError \(err.rawValue)")
    }
    var result: [String: Any] = ["ok": true, "action": "press"]
    result.merge(elementInfo(element)) { _, new in new }
    jsonOutput(result)
}

func cmdGet(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let element = resolveElement(app, appName)

    var result: [String: Any] = ["ok": true, "action": "get"]
    result.merge(elementInfo(element)) { _, new in new }
    if let v = axAttribute(element, "AXValue") { result["value"] = "\(v)" }
    if let e = axAttribute(element, "AXEnabled") as? NSNumber { result["enabled"] = e.boolValue }
    if let f = axAttribute(element, "AXFocused") as? NSNumber { result["focused"] = f.boolValue }
    jsonOutput(result)
}

func cmdList(appName: String, maxDepth: Int) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindows(app)
    if windows.isEmpty {
        errorExit("no windows for \(appName)")
    }

    var allElements: [[String: Any]] = []
    let cap = 2000
    for (i, window) in windows.enumerated() {
        if allElements.count >= cap { break }
        let windowTitle = axStringAttribute(window, "AXTitle") ?? "window-\(i)"
        for info in collectElements(window, maxDepth: maxDepth) {
            var entry: [String: Any] = ["window": windowTitle]
            if let id = info.identifier { entry["id"] = id }
            if let r = info.role { entry["role"] = r }
            if let t = info.title { entry["title"] = t }
            if let v = info.value { entry["value"] = v }
            if let s = info.subrole { entry["subrole"] = s }
            if let d = info.description { entry["desc"] = d }
            allElements.append(entry)
            if allElements.count >= cap { break }
        }
    }

    var result: [String: Any] = ["ok": true, "app": appName, "pid": pid,
                                  "count": allElements.count, "elements": allElements]
    if allElements.count >= cap {
        result["truncated"] = true
    }
    jsonOutput(result)
}

// MARK: - Extended Commands

func cmdTree(appName: String, maxDepth: Int) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
    let tree = windows.map { buildTree($0, maxDepth: maxDepth) }
    jsonOutput(["ok": true, "app": appName, "pid": pid, "windows": tree])
}

func cmdAttrs(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let el = resolveElement(app, appName)
    let names = axAttributeNames(el)
    var attrs: [String: Any] = [:]
    for name in names {
        if let val = axAttribute(el, name) {
            attrs[name] = serializeAXValue(val)
        }
    }
    var result: [String: Any] = ["ok": true, "count": names.count, "attributes": attrs]
    result.merge(elementInfo(el)) { _, new in new }
    jsonOutput(result)
}

func cmdActions(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let el = resolveElement(app, appName)
    let actionList = axActionNames(el)
    var descs: [[String: String]] = []
    for a in actionList {
        var desc: CFString?
        AXUIElementCopyActionDescription(el, a as CFString, &desc)
        var entry: [String: String] = ["action": a]
        if let d = desc as String? { entry["description"] = d }
        descs.append(entry)
    }
    var result: [String: Any] = ["ok": true, "count": actionList.count, "actions": descs]
    result.merge(elementInfo(el)) { _, new in new }
    jsonOutput(result)
}

func cmdPerform(appName: String, action: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let el = resolveElement(app, appName)
    let available = axActionNames(el)
    if !available.contains(action) {
        errorExit("action '\(action)' not available. Available: \(available.joined(separator: ", "))")
    }
    let err = performActionWithTimeout(el, action: action)
    if err != .success {
        errorExit("perform '\(action)' failed: AXError \(err.rawValue)")
    }
    var result: [String: Any] = ["ok": true, "action": "perform", "performed": action]
    result.merge(elementInfo(el)) { _, new in new }
    jsonOutput(result)
}

func cmdFind(appName: String, role: String?, title: String?, value: String?,
             desc: String?, subrole: String?, text: String?, searchAll: Bool = false,
             exact: Bool, maxDepth: Int) {
    let pid = resolveApp(appName)
    if role == nil && title == nil && value == nil && desc == nil && text == nil && subrole == nil {
        errorExit("at least one of --q, --text, --role, --title, --value, --desc, or --subrole required")
    }
    let app = AXUIElementCreateApplication(pid)
    var windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
    if let ws = argValue("--window") {
        windows = windows.filter {
            (axStringAttribute($0, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws)
        }
        if windows.isEmpty { errorExit("no window matching '\(ws)' in \(appName)") }
    }
    var all: [[String: Any]] = []
    let cap = 200
    for (i, w) in windows.enumerated() {
        if all.count >= cap { break }
        let wt = axStringAttribute(w, "AXTitle") ?? "window-\(i)"
        let hits = findByAttributes(w, role: role, title: title, value: value,
                                     desc: desc, subrole: subrole, text: text,
                                     searchAll: searchAll, exact: exact, maxDepth: maxDepth)
        for el in hits {
            var entry: [String: Any] = ["window": wt]
            if let id = axStringAttribute(el, "AXIdentifier") { entry["id"] = id }
            if let r = axStringAttribute(el, "AXRole") { entry["role"] = r }
            if let t = axStringAttribute(el, "AXTitle") { entry["title"] = t }
            if let d = axStringAttribute(el, "AXDescription") { entry["desc"] = d }
            if let v = axAttribute(el, "AXValue") { entry["value"] = "\(v)" }
            if let s = axStringAttribute(el, "AXSubrole") { entry["subrole"] = s }
            all.append(entry)
            if all.count >= cap { break }
        }
    }
    var result: [String: Any] = ["ok": true, "app": appName, "count": all.count, "matches": all]
    if all.count >= cap { result["truncated"] = true }
    if all.isEmpty && title != nil {
        result["hint"] = "many apps (e.g. Chromium browsers, SwiftUI) expose visible text via AXDescription, not AXTitle — try --desc or --q"
    } else if all.isEmpty && maxDepth <= 15 {
        // 0 matches at the default depth is ambiguous: missing vs nested past
        // the cutoff (browser page content easily sits at depth 20-40).
        result["hint"] = "0 matches at --depth \(maxDepth) — deeply nested UIs (browser page content) can exceed it; retry with --depth 40"
    }
    jsonOutput(result)
}

func resolveWindow(_ app: AXUIElement, _ appName: String) -> AXUIElement {
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
    if let ws = argValue("--window") {
        let matches = windows.filter {
            (axStringAttribute($0, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws)
        }
        if matches.count == 1 { return matches[0] }
        let titles = windows.map { axStringAttribute($0, "AXTitle") ?? "(untitled)" }
        if matches.isEmpty {
            jsonOutput(["ok": false,
                "error": "no window matching '\(ws)' in \(appName)",
                "candidates": titles])
            exit(1)
        }
        jsonOutput(["ok": false,
            "error": "ambiguous: '\(ws)' matches \(matches.count) windows in \(appName) — use a longer substring",
            "candidates": matches.map { axStringAttribute($0, "AXTitle") ?? "(untitled)" }])
        exit(1)
    }
    return windows.first!
}

func cmdWindow(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)

    if let action = argValue("--action") {
        let w = resolveWindow(app, appName)
        let title = axStringAttribute(w, "AXTitle") ?? ""
        switch action {
        case "move":
            guard let xStr = argValue("--x"), let yStr = argValue("--y"),
                  let x = Double(xStr), let y = Double(yStr) else { errorExit("--x and --y required for move") }
            var point = CGPoint(x: x, y: y)
            guard let val = AXValueCreate(.cgPoint, &point) else { errorExit("failed to create AXValue") }
            AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, val)
            jsonOutput(["ok": true, "action": "move", "window": title, "x": x, "y": y])
        case "resize":
            guard let wStr = argValue("--width"), let hStr = argValue("--height"),
                  let width = Double(wStr), let height = Double(hStr) else { errorExit("--width and --height required") }
            var size = CGSize(width: width, height: height)
            guard let val = AXValueCreate(.cgSize, &size) else { errorExit("failed to create AXValue") }
            AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, val)
            jsonOutput(["ok": true, "action": "resize", "window": title, "width": width, "height": height])
        case "minimize":
            AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, true as CFTypeRef)
            jsonOutput(["ok": true, "action": "minimize", "window": title])
        case "maximize":
            let _ = performActionWithTimeout(w, action: "AXZoomWindow" as String, timeoutMs: 2000)
            jsonOutput(["ok": true, "action": "maximize", "window": title])
        case "close":
            let _ = performActionWithTimeout(w, action: "AXRaise" as String, timeoutMs: 1000)
            for child in axChildren(w) {
                if axStringAttribute(child, "AXSubrole") == "AXCloseButton" {
                    let _ = performActionWithTimeout(child, action: kAXPressAction as String)
                    jsonOutput(["ok": true, "action": "close", "window": title])
                    return
                }
            }
            errorExit("no close button found on window '\(title)'")
        case "focus":
            NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid }?
                .activate(options: [.activateIgnoringOtherApps])
            let _ = performActionWithTimeout(w, action: kAXRaiseAction as String, timeoutMs: 1000)
            jsonOutput(["ok": true, "action": "focus", "window": title])
        default:
            errorExit("unknown window action: \(action). Use: move, resize, minimize, maximize, close, focus")
        }
        return
    }

    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
    var infos: [[String: Any]] = []
    for (i, w) in windows.enumerated() {
        var info: [String: Any] = ["title": axStringAttribute(w, "AXTitle") ?? "window-\(i)"]
        if let id = axStringAttribute(w, "AXIdentifier") { info["id"] = id }
        if let pos = axPointValue(w, "AXPosition") { info["x"] = pos.x; info["y"] = pos.y }
        if let sz = axSizeValue(w, "AXSize") { info["width"] = sz.width; info["height"] = sz.height }
        if let role = axStringAttribute(w, "AXRole") { info["role"] = role }
        if let sub = axStringAttribute(w, "AXSubrole") { info["subrole"] = sub }
        if let val = axAttribute(w, "AXMinimized") as? NSNumber { info["minimized"] = val.boolValue }
        if let val = axAttribute(w, "AXFullScreen") as? NSNumber { info["fullscreen"] = val.boolValue }
        // Transient popups (find bars, tooltips, hover cards) pollute the list
        // and are easily mistaken for real windows.
        let sub = axStringAttribute(w, "AXSubrole")
        let height = axSizeValue(w, "AXSize")?.height ?? 0
        if sub == "AXUnknown" || sub == "AXHelpTag" || height <= 50 {
            info["transient"] = true
        }
        infos.append(info)
    }
    jsonOutput(["ok": true, "app": appName, "pid": pid, "count": infos.count, "windows": infos])
}

// MARK: - Input Commands (focus, click, type)

func cmdFocus(appName: String) {
    let pid = resolveApp(appName)
    _ = bringFrontmost(pid)

    let app = AXUIElementCreateApplication(pid)
    let hasTarget = argValue("--id") != nil || argValue("--role") != nil ||
                    argValue("--title") != nil || argValue("--desc") != nil

    if hasTarget {
        let el = resolveElement(app, appName)
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, true as CFTypeRef)
        var result: [String: Any] = ["ok": true, "action": "focus"]
        result.merge(elementInfo(el)) { _, new in new }
        jsonOutput(result)
    } else {
        if let w = axWindows(app).first {
            let _ = performActionWithTimeout(w, action: kAXRaiseAction as String, timeoutMs: 2000)
        }
        jsonOutput(["ok": true, "action": "focus", "app": appName])
    }
}

func raiseElementWindow(_ el: AXUIElement) {
    var cur = el
    while let p = axAttribute(cur, "AXWindow") ?? axAttribute(cur, "AXParent") {
        guard CFGetTypeID(p) == AXUIElementGetTypeID() else { break }
        let pEl = p as! AXUIElement
        if axStringAttribute(pEl, "AXRole") == "AXWindow" {
            let _ = performActionWithTimeout(pEl, action: kAXRaiseAction as String, timeoutMs: 1000)
            return
        }
        cur = pEl
    }
}

func postClick(at point: CGPoint, right: Bool, double: Bool) {
    let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
    let button: CGMouseButton = right ? .right : .left
    let count = double ? 2 : 1
    for i in 0..<count {
        guard let down = CGEvent(mouseEventSource: nil, mouseType: downType,
                                  mouseCursorPosition: point, mouseButton: button),
              let up = CGEvent(mouseEventSource: nil, mouseType: upType,
                                mouseCursorPosition: point, mouseButton: button) else { return }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        down.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.03)
        up.post(tap: .cghidEventTap)
        if double && i == 0 { Thread.sleep(forTimeInterval: 0.03) }
    }
}

func cmdClick(appName: String) {
    let pid = resolveApp(appName)
    let right = args.contains("--right")
    let double = args.contains("--double")

    _ = bringFrontmost(pid)

    let app = AXUIElementCreateApplication(pid)

    if let coordStr = argValue("--coords") {
        let parts = coordStr.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2 else { errorExit("--coords format: x,y") }
        let point = CGPoint(x: parts[0], y: parts[1])
        Thread.sleep(forTimeInterval: 0.1)
        postClick(at: point, right: right, double: double)
        jsonOutput(["ok": true, "action": "click", "x": parts[0], "y": parts[1],
                    "right": right, "double": double])
        return
    }

    let el = resolveElement(app, appName)
    raiseElementWindow(el)
    Thread.sleep(forTimeInterval: 0.1)

    guard let pos = axPointValue(el, "AXPosition"),
          let size = axSizeValue(el, "AXSize") else {
        errorExit("element has no AXPosition/AXSize — cannot click")
    }

    let cx = pos.x + size.width / 2
    let cy = pos.y + size.height / 2
    let point = CGPoint(x: cx, y: cy)

    var inVisibleBounds = false
    for w in axWindows(app) {
        if let wPos = axPointValue(w, "AXPosition"),
           let wSize = axSizeValue(w, "AXSize") {
            let wRect = CGRect(x: wPos.x, y: wPos.y, width: wSize.width, height: wSize.height)
            if wRect.contains(point) { inVisibleBounds = true; break }
        }
    }

    var result: [String: Any] = ["ok": true, "action": "click", "x": cx, "y": cy,
                                  "right": right, "double": double]
    result.merge(elementInfo(el)) { _, new in new }

    if !inVisibleBounds {
        let pressErr = performActionWithTimeout(el, action: right ? "AXShowMenu" : kAXPressAction as String)
        if pressErr == .success {
            result["fallback"] = right ? "AXShowMenu" : "AXPress"
            result["warning"] = "element outside visible window — used AX action instead of CGEvent"
        } else {
            errorExit("element outside visible window and AX action failed")
        }
    } else {
        postClick(at: point, right: right, double: double)
    }

    jsonOutput(result)
}

func typeString(_ text: String, delayMs: Double) {
    let src = CGEventSource(stateID: .hidSystemState)
    for char in text {
        var chars = Array(String(char).utf16)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { continue }
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: delayMs / 1000)
    }
}

func tapKey(_ code: UInt16, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return }
    d.flags = flags; u.flags = flags
    d.post(tap: .cghidEventTap); u.post(tap: .cghidEventTap)
}

func cmdTypeText(appName: String, text: String) {
    let pid = resolveApp(appName)
    _ = bringFrontmost(pid)

    let app = AXUIElementCreateApplication(pid)
    let hasTarget = argValue("--id") != nil || argValue("--role") != nil ||
                    argValue("--title") != nil || argValue("--desc") != nil ||
                    argValue("--q") != nil

    var targetEl: AXUIElement? = nil
    if hasTarget {
        targetEl = resolveElement(app, appName, ignoreTextFlag: true)
        raiseElementWindow(targetEl!)
        AXUIElementSetAttributeValue(targetEl!, kAXFocusedAttribute as CFString, true as CFTypeRef)
        Thread.sleep(forTimeInterval: 0.1)
        let gotFocus = (axAttribute(targetEl!, "AXFocused") as? NSNumber)?.boolValue == true
        if !gotFocus {
            guard let pos = axPointValue(targetEl!, "AXPosition"),
                  let size = axSizeValue(targetEl!, "AXSize") else {
                errorExit("element has no position and AXFocused failed — cannot type safely")
            }
            let point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
            var visible = false
            for w in axWindows(app) {
                if let wp = axPointValue(w, "AXPosition"), let ws = axSizeValue(w, "AXSize") {
                    if CGRect(x: wp.x, y: wp.y, width: ws.width, height: ws.height).contains(point) {
                        visible = true; break
                    }
                }
            }
            if !visible {
                if tryScrollIntoView(targetEl!, app: app),
                   let pos2 = axPointValue(targetEl!, "AXPosition"),
                   let size2 = axSizeValue(targetEl!, "AXSize") {
                    postClick(at: CGPoint(x: pos2.x + size2.width / 2, y: pos2.y + size2.height / 2),
                              right: false, double: false)
                } else {
                    errorExit("element outside visible window and AXFocused failed — AXScrollToVisible unavailable, cannot type safely")
                }
            } else {
                postClick(at: point, right: false, double: false)
            }
        }
    }

    let delayMs = Double(argValue("--delay") ?? "8") ?? 8
    let doClear = args.contains("--clear")
    let doReturn = args.contains("--return")
    let doEnd = args.contains("--end")

    // Settle: re-activate until frontmost and (when targeted) the element
    // reports focused — a fixed sleep lets the FIRST type after a window opens
    // race the window server and silently drop every keystroke.
    if !bringFrontmost(pid) {
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        errorExit("target app not frontmost (front pid \(frontPid ?? -1), want \(pid)) — could not activate, refusing to type")
    }
    for _ in 0..<8 {
        if targetEl == nil || (axAttribute(targetEl!, "AXFocused") as? NSNumber)?.boolValue == true { break }
        Thread.sleep(forTimeInterval: 0.05)
    }
    Thread.sleep(forTimeInterval: 0.08)

    // --end: move the insertion point to the end of the field first (type
    // inserts at the CURRENT cursor — fresh documents default to position 0).
    func moveCursorToEnd() {
        guard let el = targetEl else { return }
        let len = (axAttribute(el, "AXValue").map { "\($0)" } ?? "").utf16.count
        var range = CFRange(location: len, length: 0)
        if let val = AXValueCreate(.cfRange, &range),
           AXUIElementSetAttributeValue(el, "AXSelectedTextRange" as CFString, val) == .success {
            return
        }
        tapKey(125, flags: .maskCommand)  // Cmd+Down = end of document
        Thread.sleep(forTimeInterval: 0.08)
    }
    if doEnd { moveCursorToEnd() }

    func clearAndType() {
        if doClear {
            tapKey(0, flags: .maskCommand)  // Cmd+A (select all, keycode 0 = 'a')
            Thread.sleep(forTimeInterval: 0.15)
            tapKey(51)  // Delete/Backspace
            Thread.sleep(forTimeInterval: 0.1)
        }
        typeString(text, delayMs: delayMs)
    }

    let beforeValue = targetEl.flatMap { axAttribute($0, "AXValue").map { "\($0)" } }
    clearAndType()

    var result: [String: Any] = ["ok": true, "action": "type", "text": text, "length": text.count]
    if let el = targetEl { result.merge(elementInfo(el)) { _, new in new } }

    // HARD VERIFY against the targeted element when its value is readable.
    // --clear → field must equal the text (one retry). Without --clear the
    // text inserts at the cursor, so check the field CONTAINS what we typed;
    // "field unchanged" (landed nowhere — focus race) gets ONE safe retry,
    // "field changed but text missing" fails loud (re-typing would duplicate).
    if let el = targetEl {
        Thread.sleep(forTimeInterval: 0.15)
        if var got = axAttribute(el, "AXValue").map({ "\($0)" }) {
            if doClear {
                if got != text {
                    clearAndType()
                    Thread.sleep(forTimeInterval: 0.15)
                    let got2 = axAttribute(el, "AXValue").map { "\($0)" } ?? ""
                    result["retries"] = 1
                    if got2 != text {
                        jsonOutput(["ok": false,
                            "error": "verify failed after retry: field shows '\(got2)', expected '\(text)'",
                            "fieldValue": got2, "expected": text])
                        exit(1)
                    }
                }
                result["verified"] = true
            } else {
                if got == beforeValue {
                    // Landed NOWHERE — safe to retry once (nothing to duplicate).
                    // AXFocused can read true on a fresh window whose field
                    // editor is not first responder yet; a REAL click is what
                    // reliably wires the keyboard target, so retry via click.
                    if let pos = axPointValue(el, "AXPosition"), let size = axSizeValue(el, "AXSize") {
                        postClick(at: CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2),
                                  right: false, double: false)
                        Thread.sleep(forTimeInterval: 0.25)
                    } else {
                        Thread.sleep(forTimeInterval: 0.2)
                    }
                    if doEnd || !doClear { moveCursorToEnd() }
                    clearAndType()
                    Thread.sleep(forTimeInterval: 0.15)
                    got = axAttribute(el, "AXValue").map { "\($0)" } ?? got
                    result["retries"] = 1
                    if got == beforeValue {
                        jsonOutput(["ok": false,
                            "error": "keystrokes landed NOWHERE (field unchanged after click-retry) — focus race or read-only field",
                            "fieldValue": got, "expected": text])
                        exit(1)
                    }
                }
                if got.contains(text) {
                    result["verified"] = true
                    if !got.hasSuffix(text) {
                        result["warning"] = "text inserted at the cursor position, not the end — pass --end to move the cursor to the end first"
                    }
                } else {
                    jsonOutput(["ok": false,
                        "error": "verify failed: field changed but does not contain the typed text — keystrokes landed in a different element, or an input filter transformed them",
                        "fieldValue": got, "before": beforeValue ?? "", "expected": text])
                    exit(1)
                }
            }
        } else {
            result["verified"] = false
            result["warning"] = "element AXValue unreadable — typed but could not verify"
        }
    }

    if doReturn {
        Thread.sleep(forTimeInterval: 0.03)
        tapKey(36)  // Return
    }

    jsonOutput(result)
}

// MARK: - Scroll

func cmdScroll(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    let direction = argValue("--direction")
    let amount = Int(argValue("--amount") ?? "3") ?? 3

    let hasTarget = argValue("--id") != nil || argValue("--q") != nil || argValue("--role") != nil ||
                    argValue("--title") != nil || argValue("--desc") != nil || argValue("--subrole") != nil
    var point: CGPoint? = nil
    var el: AXUIElement? = nil
    if let coordStr = argValue("--coords") {
        let parts = coordStr.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2 else { errorExit("--coords format: x,y") }
        point = CGPoint(x: parts[0], y: parts[1])
    } else if hasTarget {
        el = resolveElement(app, appName)
        if let pos = axPointValue(el!, "AXPosition"), let size = axSizeValue(el!, "AXSize") {
            point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
        }
    }

    // No --direction: scroll the target element INTO VIEW (AXScrollToVisible).
    if direction == nil {
        guard let el = el else {
            errorExit("scroll without --direction needs a target element (performs AXScrollToVisible); add --direction up/down/left/right for wheel scrolling")
        }
        if axActionNames(el).contains("AXScrollToVisible") {
            let err = performActionWithTimeout(el, action: "AXScrollToVisible", timeoutMs: 3000)
            if err != .success { errorExit("AXScrollToVisible failed: AXError \(err.rawValue)") }
            var result: [String: Any] = ["ok": true, "action": "scroll", "method": "AXScrollToVisible"]
            result.merge(elementInfo(el)) { _, new in new }
            jsonOutput(result)
            return
        }
        errorExit("element does not support AXScrollToVisible — use --direction with wheel scrolling instead")
    }

    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction! {
    case "up": dy = Int32(amount)
    case "down": dy = Int32(-amount)
    case "left": dx = Int32(amount)
    case "right": dx = Int32(-amount)
    default: errorExit("--direction must be up, down, left, or right")
    }

    // No target/coords: aim at the app's main window center. A nil location
    // posts at (0,0) — the menu bar — and scrolls nothing.
    if point == nil {
        for w in axWindows(app) {
            guard let pos = axPointValue(w, "AXPosition"), let size = axSizeValue(w, "AXSize"),
                  size.height > 50 else { continue }
            point = CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
            break
        }
    }

    // Synthetic wheel events are DROPPED for background apps (verified against
    // Chromium: identical event scrolls when frontmost, no-ops when not).
    // Real mice scroll background windows; CGEvent posts do not.
    if !bringFrontmost(pid) {
        errorExit("could not bring \(appName) frontmost — synthetic wheel events are dropped for background apps, refusing to scroll")
    }
    Thread.sleep(forTimeInterval: 0.08)

    guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                           wheel1: dy, wheel2: dx, wheel3: 0) else {
        errorExit("failed to create scroll event")
    }
    if let p = point { ev.location = p }
    ev.post(tap: .cghidEventTap)
    var result: [String: Any] = ["ok": true, "action": "scroll", "method": "wheel",
                                  "direction": direction!, "amount": amount]
    if let p = point { result["x"] = p.x; result["y"] = p.y }
    if let el = el { result.merge(elementInfo(el)) { _, new in new } }
    jsonOutput(result)
}

// MARK: - Screenshot

// Shared window-capture: resolves the target window (fail-loud --window,
// largest-area default), returns (image, title, pid, bounds in CG points)
// plus other-window names for reporting.
func captureWindowCGImage(_ appName: String) -> (CGImage, String, pid_t, CGRect) {
    let (img, title, pid, bounds, _) = captureWindowCGImageFull(appName)
    return (img, title, pid, bounds)
}

func captureWindowCGImageFull(_ appName: String) -> (CGImage, String, pid_t, CGRect, [String]) {
    let pid = resolveApp(appName)
    let windowScope = argValue("--window")

    let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] ?? []
    let appWindows = windowList.filter { ($0[kCGWindowOwnerPID] as? Int32) == pid }
    let windowName = { (w: [CFString: Any]) -> String in (w[kCGWindowName] as? String) ?? "(untitled)" }
    let windowArea = { (w: [CFString: Any]) -> Double in
        let b = w[kCGWindowBounds] as? [String: Any]
        let width = (b?["Width"] as? Double) ?? 0
        let height = (b?["Height"] as? Double) ?? 0
        return width * height
    }

    var targetWindow: [CFString: Any]? = nil
    if let ws = windowScope {
        // Fail loud on 0 or >1 matches — a substring miss must never silently
        // capture a different window (the "Find in page popup as Brave-Main" bug).
        let matches = appWindows.filter { windowName($0).localizedCaseInsensitiveContains(ws) }
        if matches.isEmpty {
            jsonOutput(["ok": false,
                "error": "no window matching '\(ws)' in \(appName)",
                "candidates": appWindows.map { windowName($0) }])
            exit(1)
        }
        if matches.count > 1 {
            jsonOutput(["ok": false,
                "error": "ambiguous: '\(ws)' matches \(matches.count) windows in \(appName) — use a longer substring",
                "candidates": matches.map { windowName($0) }])
            exit(1)
        }
        targetWindow = matches[0]
    } else {
        // No scope: pick the LARGEST real window (z-order first() favors
        // transient popups/find-bars that happen to be on top).
        let real = appWindows.filter { w in
            let b = w[kCGWindowBounds] as? [String: Any]
            return ((b?["Height"] as? Double) ?? 0) > 50
        }
        targetWindow = (real.isEmpty ? appWindows : real).max { windowArea($0) < windowArea($1) }
    }

    guard let win = targetWindow,
          let windowID = win[kCGWindowNumber] as? CGWindowID else {
        errorExit("no capturable window for \(appName)")
    }
    guard let cgImage = CGWindowListCreateImage(
        .null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming, .bestResolution]
    ) else {
        errorExit("CGWindowListCreateImage failed")
    }
    let b = win[kCGWindowBounds] as? [String: Any]
    let bounds = CGRect(x: (b?["X"] as? Double) ?? 0, y: (b?["Y"] as? Double) ?? 0,
                        width: (b?["Width"] as? Double) ?? 1, height: (b?["Height"] as? Double) ?? 1)
    let others = appWindows.filter { ($0[kCGWindowNumber] as? CGWindowID) != windowID }.map { windowName($0) }
    return (cgImage, windowName(win), pid, bounds, others)
}

func cmdScreenshot(appName: String, path: String) {
    var (cgImage, title, pid, boundsPts, others) = captureWindowCGImageFull(appName)

    var result: [String: Any] = ["ok": true, "action": "screenshot", "path": path, "window": title]
    if !others.isEmpty && argValue("--window") == nil {
        result["otherWindows"] = others
        result["pickedBy"] = "largest-area (pass --window <title> to target another)"
    }

    // --annotate: draw numbered boxes around interactable AX elements
    // (--all = every element with id/desc/title) + legend in the JSON.
    if args.contains("--annotate") {
        let (annotated, legend) = annotateImage(cgImage, appName: appName, pid: pid,
                                               windowTitle: title, windowBoundsPts: boundsPts)
        cgImage = annotated
        result["annotations"] = legend
        result["annotated"] = true
    }

    // --crop x,y,w,h in PIXELS of the captured image (retina px, origin top-left)
    if let cropStr = argValue("--crop") {
        let p = cropStr.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        guard p.count == 4 else { errorExit("--crop format: x,y,w,h (pixels of the captured image)") }
        let rect = CGRect(x: p[0], y: p[1], width: p[2], height: p[3])
        guard let cropped = cgImage.cropping(to: rect) else {
            errorExit("--crop \(cropStr) outside image bounds \(cgImage.width)x\(cgImage.height)")
        }
        cgImage = cropped
        result["crop"] = ["x": p[0], "y": p[1], "w": p[2], "h": p[3]]
    }

    writePNG(cgImage, to: path)
    result["width"] = cgImage.width
    result["height"] = cgImage.height
    jsonOutput(result)
}


// MARK: - Annotate + OCR

let INTERACTABLE_ROLES: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXSecureTextField", "AXCheckBox",
    "AXRadioButton", "AXPopUpButton", "AXLink", "AXMenuButton", "AXComboBox",
    "AXSearchField", "AXSlider", "AXDisclosureTriangle", "AXIncrementor",
]

struct FramedElement {
    let el: AXUIElement
    let role: String
    let frame: CGRect  // global CG points
}

func collectFramedElements(_ root: AXUIElement, all: Bool, depth: Int = 0, maxDepth: Int = 15) -> [FramedElement] {
    if depth > maxDepth { return [] }
    var out: [FramedElement] = []
    if let role = axStringAttribute(root, "AXRole"),
       all ? true : INTERACTABLE_ROLES.contains(role),
       let pos = axPointValue(root, "AXPosition"),
       let size = axSizeValue(root, "AXSize"),
       size.width > 1, size.height > 1 {
        if all {
            if axStringAttribute(root, "AXIdentifier") != nil ||
               axStringAttribute(root, "AXDescription") != nil ||
               axStringAttribute(root, "AXTitle") != nil {
                out.append(FramedElement(el: root, role: role,
                    frame: CGRect(origin: pos, size: size)))
            }
        } else {
            out.append(FramedElement(el: root, role: role, frame: CGRect(origin: pos, size: size)))
        }
    }
    for child in axChildren(root) {
        out.append(contentsOf: collectFramedElements(child, all: all, depth: depth + 1, maxDepth: maxDepth))
    }
    return out
}

func annotateImage(_ image: CGImage, appName: String, pid: pid_t, windowTitle: String,
                    windowBoundsPts: CGRect) -> (CGImage, [[String: Any]]) {
    let app = AXUIElementCreateApplication(pid)
    // Match the AX window to the CAPTURED window by FRAME, not just title —
    // title-mismatch + .first fallback annotated a phantom translate popup's
    // elements onto a screenshot of the real window (blind-test 4D).
    var axWin: AXUIElement? = nil
    for w in axWindows(app) {
        guard let pos = axPointValue(w, "AXPosition"), let size = axSizeValue(w, "AXSize") else { continue }
        if abs(pos.x - windowBoundsPts.origin.x) < 6 && abs(pos.y - windowBoundsPts.origin.y) < 6 &&
           abs(size.width - windowBoundsPts.width) < 6 && abs(size.height - windowBoundsPts.height) < 6 {
            axWin = w
            break
        }
    }
    if axWin == nil && !windowTitle.isEmpty {
        for w in axWindows(app) {
            if (axStringAttribute(w, "AXTitle") ?? "") == windowTitle { axWin = w; break }
        }
    }
    // No frame/title match: better zero annotations than another window's boxes.
    guard let win = axWin else { return (image, []) }

    let all = args.contains("--all")
    let elements = collectFramedElements(win, all: all)
    let scale = CGFloat(image.width) / windowBoundsPts.width

    let width = image.width
    let height = image.height
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        return (image, [])
    }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    var legend: [[String: Any]] = []
    var n = 0
    for fe in elements {
        // element global pts -> window-relative pts -> image px (top-left origin)
        let rx = (fe.frame.origin.x - windowBoundsPts.origin.x) * scale
        let ryTop = (fe.frame.origin.y - windowBoundsPts.origin.y) * scale
        let rw = fe.frame.width * scale
        let rh = fe.frame.height * scale
        // Skip boxes with no meaningful visible portion — a sliver at the image
        // edge gets a legend number but no readable box (blind-test 3A, n:10).
        let visible = CGRect(x: rx, y: ryTop, width: rw, height: rh)
            .intersection(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))
        if visible.isNull || visible.width < 10 || visible.height < 10 ||
           (rw * rh > 0 && visible.width * visible.height / (rw * rh) < 0.3) { continue }
        n += 1
        // CGContext origin is bottom-left — flip Y
        let ryCG = CGFloat(height) - ryTop - rh
        let rect = CGRect(x: rx, y: ryCG, width: rw, height: rh)
        ctx.setStrokeColor(CGColor(red: 1, green: 0.1, blue: 0.5, alpha: 0.9))
        ctx.setLineWidth(2)
        ctx.stroke(rect)

        let label = "\(n)"
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 22, nil)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: CGColor(red: 1, green: 1, blue: 1, alpha: 1),
        ]
        let astr = NSAttributedString(string: label, attributes: attrs)
        let line = CTLineCreateWithAttributedString(astr)
        let tb = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
        let pad: CGFloat = 3
        let bgRect = CGRect(x: rect.minX, y: rect.maxY - tb.height - 2 * pad,
                            width: tb.width + 2 * pad, height: tb.height + 2 * pad)
        ctx.setFillColor(CGColor(red: 1, green: 0.1, blue: 0.5, alpha: 0.9))
        ctx.fill(bgRect)
        ctx.textPosition = CGPoint(x: bgRect.minX + pad, y: bgRect.minY + pad)
        CTLineDraw(line, ctx)

        var entry: [String: Any] = ["n": n, "role": fe.role,
            "px": ["x": Int(rx), "y": Int(ryTop), "w": Int(rw), "h": Int(rh)]]
        entry.merge(elementInfo(fe.el)) { _, new in new }
        legend.append(entry)
    }
    let annotated = ctx.makeImage() ?? image
    return (annotated, legend)
}

func writePNG(_ image: CGImage, to path: String) {
    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        errorExit("cannot create image file at \(path)")
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) { errorExit("failed to write PNG to \(path)") }
}

func runOCR(on image: CGImage) -> [String: Any] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([request]) } catch {
        errorExit("OCR failed: \(error.localizedDescription)")
    }
    let W = CGFloat(image.width)
    let H = CGFloat(image.height)
    var blocks: [[String: Any]] = []
    var lines: [String] = []
    for obs in request.results ?? [] {
        guard let cand = obs.topCandidates(1).first else { continue }
        let bb = obs.boundingBox  // normalized, origin bottom-left
        blocks.append([
            "text": cand.string,
            "confidence": Double(cand.confidence),
            "px": ["x": Int(bb.minX * W), "y": Int((1 - bb.maxY) * H),
                    "w": Int(bb.width * W), "h": Int(bb.height * H)],
        ])
        lines.append(cand.string)
    }
    return ["ok": true, "action": "ocr", "blocks": blocks, "count": blocks.count,
            "text": lines.joined(separator: "\n"),
            "note": "px coords are pixels of the source image, origin top-left"]
}

func loadCGImage(_ path: String) -> CGImage {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        errorExit("cannot read image: \(path)")
    }
    return img
}

func cmdOcr(appName: String?) {
    var image: CGImage
    if let imgPath = argValue("--image") {
        image = loadCGImage(imgPath)
    } else if let appName = appName {
        let (img, _, _, _) = captureWindowCGImage(appName)
        image = img
    } else {
        errorExit("ocr needs --image <path> or --app <name>")
    }
    if let cropStr = argValue("--crop") {
        let pcs = cropStr.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        guard pcs.count == 4 else { errorExit("--crop format: x,y,w,h (pixels of the image)") }
        guard let cropped = image.cropping(to: CGRect(x: pcs[0], y: pcs[1], width: pcs[2], height: pcs[3])) else {
            errorExit("--crop outside image bounds \(image.width)x\(image.height)")
        }
        image = cropped
    }
    jsonOutput(runOCR(on: image))
}

// MARK: - Hotkey

let KEY_MAP: [String: UInt16] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "arrow_up": 126, "arrow_down": 125, "arrow_left": 123, "arrow_right": 124,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39,
    ",": 43, ".": 47, "/": 44, "`": 50,
]

func cmdHotkey(keys: String) {
    // Optional --app: activate the target first so the combo lands there
    // instead of whatever happens to have OS keyboard focus.
    if let appTarget = argValue("--app") {
        let pid = resolveApp(appTarget)
        if !bringFrontmost(pid) {
            errorExit("could not bring \(appTarget) frontmost — refusing to send keys to the wrong app")
        }
    }
    let parts = keys.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    var flags: CGEventFlags = []
    var keyCode: UInt16 = 0
    var foundKey = false

    for part in parts {
        switch part {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default:
            if let code = KEY_MAP[part] {
                keyCode = code
                foundKey = true
            } else {
                errorExit("unknown key: \(part). Use: a-z, 0-9, return, tab, space, escape, delete, up/down/left/right, f1-f12, or modifiers cmd/shift/alt/ctrl/fn")
            }
        }
    }

    if !foundKey {
        errorExit("no key specified — only modifiers given. Add a key: e.g. cmd,a")
    }

    let holdMs = Double(argValue("--hold") ?? "50") ?? 50

    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false) else {
        errorExit("failed to create CGEvent")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: holdMs / 1000)
    up.post(tap: .cghidEventTap)

    jsonOutput(["ok": true, "action": "hotkey", "keys": keys])
}

// MARK: - Apps

func cmdApps() {
    let includeAll = args.contains("--all")
    var list: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications {
        if !includeAll && app.activationPolicy != .regular { continue }
        var entry: [String: Any] = ["pid": app.processIdentifier]
        if let n = app.localizedName { entry["name"] = n }
        if let b = app.bundleIdentifier { entry["bundleId"] = b }
        if app.isActive { entry["frontmost"] = true }
        if app.isHidden { entry["hidden"] = true }
        list.append(entry)
    }
    list.sort { (($0["name"] as? String) ?? "").lowercased() < (($1["name"] as? String) ?? "").lowercased() }
    jsonOutput(["ok": true, "count": list.count, "apps": list,
                "note": "these names are valid --app values (also matched case-insensitively and by bundleId substring)"])
}

// MARK: - Snapshot/Restore

func cmdSnapshot() {
    let mousePos = CGEvent(source: nil)!.location
    let frontApp = NSWorkspace.shared.frontmostApplication
    let appName = frontApp?.localizedName ?? ""
    let pid = frontApp?.processIdentifier ?? 0

    var result: [String: Any] = [
        "ok": true, "action": "snapshot",
        "mouse": ["x": mousePos.x, "y": mousePos.y],
        "app": appName, "pid": pid
    ]

    if pid != 0 {
        let app = AXUIElementCreateApplication(pid)
        let wins = axWindows(app)
        if let w = wins.first {
            if let t = axStringAttribute(w, "AXTitle") { result["windowTitle"] = t }
            if let id = axStringAttribute(w, "AXIdentifier") { result["windowId"] = id }
        }
    }
    jsonOutput(result)
}

func cmdRestore(snapshotJson: String) {
    guard let data = snapshotJson.data(using: .utf8),
          let snap = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        errorExit("invalid snapshot JSON")
    }

    if let mouse = snap["mouse"] as? [String: Double],
       let mx = mouse["x"], let my = mouse["y"] {
        let point = CGPoint(x: mx, y: my)
        CGWarpMouseCursorPosition(point)
    }

    if let appName = snap["app"] as? String, !appName.isEmpty {
        if let runningApp = NSWorkspace.shared.runningApplications.first(where: {
            $0.localizedName == appName
        }) {
            runningApp.activate(options: [.activateIgnoringOtherApps])
            Thread.sleep(forTimeInterval: 0.1)

            let app = AXUIElementCreateApplication(runningApp.processIdentifier)
            if let wTitle = snap["windowTitle"] as? String {
                for w in axWindows(app) {
                    if axStringAttribute(w, "AXTitle") == wTitle {
                        let _ = performActionWithTimeout(w, action: kAXRaiseAction as String, timeoutMs: 1000)
                        break
                    }
                }
            }
        }
    }

    jsonOutput(["ok": true, "action": "restore",
                "mouse": snap["mouse"] ?? [:], "app": snap["app"] ?? ""])
}

// MARK: - Record (activity recorder for record-plan)

// Listen-only CGEvent tap streaming NDJSON events (click/key/scroll) with the
// AX element under each click resolved to app/role/title/desc/id. The TS side
// (record-plan) converts the stream into plan steps.
final class ActivityRecorder {
    let handle: FileHandle?
    let start = CFAbsoluteTimeGetCurrent()

    init(outPath: String?) {
        if let p = outPath {
            FileManager.default.createFile(atPath: p, contents: nil)
            guard let h = FileHandle(forWritingAtPath: p) else {
                errorExit("cannot open --out for writing: \(p)")
            }
            handle = h
        } else {
            handle = nil
        }
    }

    func emit(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]) else { return }
        var line = data
        line.append(0x0A)
        if let h = handle { h.write(line) } else { FileHandle.standardOutput.write(line) }
    }

    func elementAt(_ point: CGPoint) -> [String: Any] {
        let sys = AXUIElementCreateSystemWide()
        var elRef: AXUIElement?
        guard AXUIElementCopyElementAtPosition(sys, Float(point.x), Float(point.y), &elRef) == .success,
              let el = elRef else { return [:] }
        // Climb to the nearest ancestor that is addressable (id/title/desc or
        // pressable) so the recorded step can be replayed by attribute lookup.
        var chosen = el
        var hops = 0
        while hops < 6 {
            let hasHandle = axStringAttribute(chosen, "AXIdentifier") != nil
                || (axStringAttribute(chosen, "AXTitle")?.isEmpty == false)
                || (axStringAttribute(chosen, "AXDescription")?.isEmpty == false)
            if hasHandle || axActionNames(chosen).contains("AXPress") { break }
            guard let parentRef = axAttribute(chosen, "AXParent") else { break }
            let parent = parentRef as! AXUIElement
            chosen = parent
            hops += 1
        }
        var info = elementInfo(chosen)
        if let sub = axStringAttribute(chosen, "AXSubrole") { info["subrole"] = sub }
        var pid: pid_t = 0
        if AXUIElementGetPid(chosen, &pid) == .success,
           let app = NSRunningApplication(processIdentifier: pid) {
            info["app"] = app.localizedName ?? ""
            info["pid"] = Int(pid)
        }
        return info
    }

    func handleEvent(type: CGEventType, event: CGEvent) {
        let ts = Int((CFAbsoluteTimeGetCurrent() - start) * 1000)
        switch type {
        case .leftMouseDown, .rightMouseDown:
            let loc = event.location
            var e: [String: Any] = ["type": "click", "ts": ts,
                                    "x": Int(loc.x), "y": Int(loc.y)]
            if type == .rightMouseDown { e["right"] = true }
            e["element"] = elementAt(loc)
            emit(e)
        case .keyDown:
            if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
            let keycode = event.getIntegerValueField(.keyboardEventKeycode)
            var length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &chars)
            let s = String(utf16CodeUnits: chars, count: length)
            var mods: [String] = []
            let f = event.flags
            if f.contains(.maskCommand) { mods.append("cmd") }
            if f.contains(.maskControl) { mods.append("ctrl") }
            if f.contains(.maskAlternate) { mods.append("alt") }
            if f.contains(.maskShift) { mods.append("shift") }
            var e: [String: Any] = ["type": "key", "ts": ts, "keycode": Int(keycode), "char": s]
            if !mods.isEmpty { e["mods"] = mods }
            if let front = NSWorkspace.shared.frontmostApplication?.localizedName { e["app"] = front }
            emit(e)
        case .scrollWheel:
            let dy = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
            let dx = event.getIntegerValueField(.scrollWheelEventDeltaAxis2)
            if dy == 0 && dx == 0 { return }
            var e: [String: Any] = ["type": "scroll", "ts": ts, "dy": Int(dy), "dx": Int(dx)]
            if let front = NSWorkspace.shared.frontmostApplication?.localizedName { e["app"] = front }
            emit(e)
        default:
            break
        }
    }
}

func cmdRecord() {
    let duration = Double(argValue("--duration") ?? "0") ?? 0
    let recorder = ActivityRecorder(outPath: argValue("--out"))

    let mask: CGEventMask =
        (1 << CGEventType.leftMouseDown.rawValue) |
        (1 << CGEventType.rightMouseDown.rawValue) |
        (1 << CGEventType.keyDown.rawValue) |
        (1 << CGEventType.scrollWheel.rawValue)

    let callback: CGEventTapCallBack = { _, type, event, refcon in
        if let refcon {
            Unmanaged<ActivityRecorder>.fromOpaque(refcon).takeUnretainedValue()
                .handleEvent(type: type, event: event)
        }
        return Unmanaged.passUnretained(event)
    }

    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
        eventsOfInterest: mask, callback: callback,
        userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(recorder).toOpaque())
    ) else {
        errorExit("could not create event tap — grant Accessibility + Input Monitoring to the calling terminal")
    }

    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)

    recorder.emit(["type": "meta", "ts": 0, "recording": true,
                   "frontmost": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
                   "duration": duration])
    signal(SIGINT) { _ in exit(0) }
    signal(SIGTERM) { _ in exit(0) }
    if duration > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { exit(0) }
    }
    CFRunLoopRun()
}

// MARK: - Preflight

let BROWSER_APPLESCRIPT_APPS: Set<String> = ["Brave Browser", "Google Chrome", "Arc", "Microsoft Edge", "Vivaldi", "Safari"]

func runAppleScript(_ source: String) -> String? {
    var error: NSDictionary?
    let script = NSAppleScript(source: source)
    let result = script?.executeAndReturnError(&error)
    guard error == nil else { return nil }
    return result?.stringValue
}

func screensInfo() -> [[String: Any]] {
    let screens = NSScreen.screens
    guard let primary = screens.first else { return [] }
    let primaryHeight = primary.frame.height
    var infos: [[String: Any]] = []
    for (i, s) in screens.enumerated() {
        let f = s.frame
        let scale = s.backingScaleFactor
        // NSScreen frames are AppKit space (origin bottom-left of primary);
        // originCG converts to the CG top-left global point space that click
        // coords and window bounds live in.
        let cgX = f.origin.x
        let cgY = primaryHeight - f.origin.y - f.height
        infos.append([
            "index": i,
            "isPrimary": i == 0,
            "points": ["width": f.width, "height": f.height],
            "scaleFactor": scale,
            "framePixels": ["width": f.width * scale, "height": f.height * scale],
            "originCG": ["x": cgX, "y": cgY],
        ])
    }
    return infos
}

func browserTabInfo(_ appName: String, axWindowTitles: [String]) -> [String: Any]? {
    guard BROWSER_APPLESCRIPT_APPS.contains(appName) else { return nil }
    let urlScript = appName == "Safari"
        ? "tell application \"Safari\" to get URL of front document"
        : "tell application \"\(appName)\" to get URL of active tab of front window"
    let titleScript = appName == "Safari"
        ? "tell application \"Safari\" to get name of front document"
        : "tell application \"\(appName)\" to get title of active tab of front window"
    var tab: [String: Any] = [:]
    if let u = runAppleScript(urlScript) { tab["url"] = u }
    if let t = runAppleScript(titleScript) { tab["title"] = t }
    guard !tab.isEmpty else { return nil }
    // AppleScript addresses the app by NAME — with two same-named instances it
    // may answer for the OTHER process. Cross-check the tab title against this
    // pid's AX window titles so a mismatch is visible instead of silently wrong.
    if let title = tab["title"] as? String, !title.isEmpty {
        let matches = axWindowTitles.contains { $0.localizedCaseInsensitiveContains(title) }
        tab["pidMatch"] = matches
        if !matches {
            tab["warning"] = "tab title not found in this pid's window titles — likely from ANOTHER instance of \(appName) (AppleScript resolves by name, not pid); do not trust for this process"
        }
    }
    return tab
}

func cmdPreflight(appName: String, maxDepth: Int) {
    let pid = resolveApp(appName)
    // --app may be a pid — resolve the display name for browser detection etc.
    let displayName = NSWorkspace.shared.runningApplications
        .first { $0.processIdentifier == pid }?.localizedName ?? appName
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }

    // --wanted screens,frontmost,windows,elements[,elements:<Role>],browser,plan
    // Default: all groups, element groups truncated to 15/role.
    var wantedGroups: Set<String>? = nil
    var fullElementRole: String? = nil
    if let w = argValue("--wanted") {
        var groups: Set<String> = []
        for part in w.split(separator: ",").map({ String($0).trimmingCharacters(in: .whitespaces) }) {
            if part.hasPrefix("elements:") {
                groups.insert("elements")
                fullElementRole = String(part.dropFirst("elements:".count))
            } else {
                groups.insert(part)
            }
        }
        wantedGroups = groups
    }
    func wanted(_ g: String) -> Bool { wantedGroups?.contains(g) ?? true }

    var out: [String: Any] = ["ok": true, "app": appName, "pid": pid]

    if wanted("screens") {
        out["screens"] = screensInfo()
    }

    if wanted("frontmost") {
        let front = NSWorkspace.shared.frontmostApplication
        var f: [String: Any] = [:]
        if let n = front?.localizedName { f["app"] = n }
        if let p = front?.processIdentifier { f["pid"] = p }
        if let b = front?.bundleIdentifier { f["bundleId"] = b }
        out["frontmost"] = f
    }

    if wanted("windows") {
        var windowInfos: [[String: Any]] = []
        var phantomStrips: [[String: Any]] = []
        for (i, w) in windows.enumerated() {
            var info: [String: Any] = ["title": axStringAttribute(w, "AXTitle") ?? "window-\(i)"]
            if let id = axStringAttribute(w, "AXIdentifier") { info["id"] = id }
            if let pos = axPointValue(w, "AXPosition") { info["x"] = pos.x; info["y"] = pos.y }
            if let sz = axSizeValue(w, "AXSize") { info["width"] = sz.width; info["height"] = sz.height }
            let sub = axStringAttribute(w, "AXSubrole")
            if let s = sub { info["subrole"] = s }
            let height = axSizeValue(w, "AXSize")?.height ?? 0
            if sub == "AXUnknown" || sub == "AXHelpTag" || height <= 50 {
                info["transient"] = true
                phantomStrips.append(info)
            } else {
                windowInfos.append(info)
            }
        }
        out["windows"] = windowInfos
        if !phantomStrips.isEmpty { out["phantomStrips"] = phantomStrips }
    }

    if wanted("browser"),
       let tab = browserTabInfo(displayName, axWindowTitles: windows.compactMap { axStringAttribute($0, "AXTitle") }) {
        out["browserTab"] = tab
    }

    var addressable: [[String: String]] = []
    var roleCounts: [String: Int] = [:]
    if wanted("elements") || wanted("plan") {
        for window in windows {
            for info in collectElements(window, maxDepth: maxDepth) {
                let role = info.role ?? "?"
                roleCounts[role, default: 0] += 1
                // Addressable = targetable by id OR desc OR title (browsers
                // have no AXIdentifiers but are fully targetable via desc).
                if info.identifier != nil || info.description != nil || info.title != nil {
                    var entry: [String: String] = ["role": role]
                    if let eid = info.identifier { entry["id"] = eid }
                    if let d = info.description { entry["desc"] = d }
                    if let t = info.title { entry["title"] = t }
                    entry["window"] = axStringAttribute(window, "AXTitle") ?? ""
                    addressable.append(entry)
                }
            }
        }
    }

    if wanted("elements") {
        var grouped: [String: [[String: String]]] = [:]
        for el in addressable {
            grouped[el["role"] ?? "?", default: []].append(el)
        }
        let perRoleCap = 15
        var truncatedRoles: [String: Int] = [:]
        if let fullRole = fullElementRole {
            grouped = grouped.filter { fuzzyRoleMatch($0.key, fullRole, exact: false) }
        } else {
            for (role, els) in grouped where els.count > perRoleCap {
                truncatedRoles[role] = els.count
                grouped[role] = Array(els.prefix(perRoleCap))
            }
        }
        out["grouped"] = grouped
        out["roleCounts"] = roleCounts
        out["addressableCount"] = addressable.count
        out["totalElements"] = roleCounts.values.reduce(0, +)
        if !truncatedRoles.isEmpty {
            out["truncatedRoles"] = truncatedRoles
            out["note"] = "element groups truncated to \(perRoleCap)/role — re-run with --wanted elements:<Role> for the full list of one role"
        }
    }

    if wanted("plan") {
        func targetKey(_ el: [String: String]) -> [String: Any] {
            if let id = el["id"] { return ["id": id] }
            if let d = el["desc"] { return ["q": d] }
            return ["q": el["title"] ?? "?"]
        }
        let uniqueButtons = addressable.filter { $0["role"] == "AXButton" }
            .reduce(into: [[String: String]]()) { result, el in
                let key = el["id"] ?? el["desc"] ?? el["title"] ?? ""
                if !result.contains(where: { ($0["id"] ?? $0["desc"] ?? $0["title"] ?? "") == key }) {
                    result.append(el)
                }
            }
        let fields = addressable.filter { $0["role"] == "AXTextField" }
        let checkboxes = addressable.filter { $0["role"] == "AXCheckBox" }

        var planSteps: [[String: Any]] = [["do": "focus"]]
        planSteps.append(["do": "screenshot", "path": "/tmp/ax-\(appName.lowercased())-before.png"])
        for el in uniqueButtons.prefix(6) {
            var step: [String: Any] = ["do": "press", "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"]
            step.merge(targetKey(el)) { _, new in new }
            planSteps.append(step)
        }
        for el in fields.prefix(3) {
            var step: [String: Any] = ["do": "set", "value": "example",
                                        "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"]
            step.merge(targetKey(el)) { _, new in new }
            planSteps.append(step)
        }
        for el in checkboxes.prefix(2) {
            var step: [String: Any] = ["do": "press", "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"]
            step.merge(targetKey(el)) { _, new in new }
            planSteps.append(step)
        }
        planSteps.append(["do": "screenshot", "path": "/tmp/ax-\(appName.lowercased())-after.png"])

        out["suggestedPlan"] = [
            "app": appName, "restore": true, "delayMs": 300, "steps": planSteps,
            "_contract": "tools control run --help for the full plan schema",
            "_note": "SKELETON — review before executing: press/set steps target real UI and set writes example text into real fields"
        ] as [String: Any]
    }

    out["unitsReminder"] = [
        "clickCoords": "GLOBAL CG points (window bounds space; negatives legal on multi-display)",
        "screenshotCrop": "PIXELS of the captured image (points x scaleFactor, origin top-left)",
        "captureCropRegion": "FRAME pixels of the captured screen (points x scaleFactor)",
    ]

    jsonOutput(out)
}

// MARK: - Main

let args = CommandLine.arguments
if args.count < 2 || args[1] == "--help" || args[1] == "-h" {
    let help = """
    ax-tool — fast AX API CLI for macOS UI automation

    RUN `ax-tool preflight --app <name>` FIRST — one call returns screens
    (scale/origins), frontmost app, windows (phantom strips flagged), element
    inventory grouped by role, active browser tab, units reminder, and a
    suggested plan. Kills the guess-the-coordinates/guess-the-field footguns.

    Usage:
      ax-tool preflight --app <name> [--depth <n>] [--wanted g1,g2]  Discover everything (see above)
                        --wanted groups: screens,frontmost,windows,elements,browser,plan
                        (elements truncated 15/role; --wanted elements:<Role> = full one role)
      ax-tool apps [--all]                                    List running apps (valid --app values)
      ax-tool list    --app <name> [--depth <n=10>]           List elements (flat, max 2000)
      ax-tool tree    --app <name> [--depth <n=10>]           Hierarchical tree (nested JSON)
      ax-tool get     --app <name> <target>                    Read element attributes
      ax-tool set     --app <name> <target> --value <v>       Set + HARD VERIFY (reads field back, 1 retry)
      ax-tool press   --app <name> <target>                   Press (AXPress) an element
      ax-tool attrs   --app <name> <target>                   List ALL attributes + values
      ax-tool actions --app <name> <target>                   List available AX actions
      ax-tool perform --app <name> <target> --action <a>      Perform any AX action
      ax-tool find    --app <name> [--role R] [--title T] [--value V] [--desc D] [--subrole S]
                      [--text Q] [--q Q] [--window W] [--exact]
      ax-tool window  --app <name> [--action move|resize|minimize|maximize|close|focus]
      ax-tool focus   --app <name> [<target>]                 Activate app + focus element
      ax-tool click   --app <name> <target>                   CGEvent click at element center
      ax-tool type    --app <name> --text <str> [<target>]    Type + HARD VERIFY ([--clear] [--end] [--return])
                      (inserts at the CURRENT cursor; --end jumps to end first, --clear replaces all)
      ax-tool scroll  --app <name> [<target>|--coords x,y] --direction up|down|left|right [--amount n]
                      (no --direction + target = AXScrollToVisible: bring element into view)
      ax-tool screenshot --app <name> --path <file.png> [--window W] [--crop x,y,w,h] [--annotate [--all]]
                      --crop is PIXELS of the captured image; --window fails loud on 0/2+ matches
                      --annotate draws numbered boxes on interactable elements + legend in JSON
      ax-tool ocr     --app <name> | --image <path> [--crop x,y,w,h]   Vision OCR: text blocks + pixel boxes
      ax-tool hotkey --keys <cmd,a> [--app <name>]            Key combo (--app activates target first)
      ax-tool snapshot                                        Capture mouse + focused app/window
      ax-tool restore --snapshot <json>                       Restore mouse + focus from snapshot
      ax-tool record [--out <f.jsonl>] [--duration <s>]       Stream user activity as NDJSON
                      (clicks resolved to AX elements; keys; scrolls; SIGINT to stop)

    Target: --id <axId>, --q <query> (universal cascade), or any combo of
    --role/--title/--desc/--subrole [--window W] [--exact].
    Elements WITHOUT AXIdentifier are fully interactable via desc/role/subrole.
    NOTE: many apps (Chromium browsers, SwiftUI) put visible text in
    AXDescription, not AXTitle — when --title finds nothing, try --desc or --q.

    Output: compact JSON to stdout (--pretty to indent). {"ok":true,...} on
    success, {"ok":false,"error":"..."} on failure.
    set/type refuse when the target app is not frontmost, and verify the field
    content after typing (retry once, then fail loud with fieldValue).
    Permission: requires Accessibility access for the calling terminal/process.

    Examples:
      ax-tool preflight --app Genesis
      ax-tool apps
      ax-tool find --app "Brave Browser" --q "YouTube" --depth 10
      ax-tool click --app "Brave Browser" --desc "youtube" --role AXRadioButton
      ax-tool press --app Genesis --desc "Account" --role AXButton
      ax-tool set --app Genesis --id auth-email --value "user@example.com"
      ax-tool screenshot --app Genesis --window "Genesis" --path /tmp/g.png --crop 0,0,1800,300
      ax-tool hotkey --keys cmd,w --app "Brave Browser"
      ax-tool window --app Finder --action move --x 100 --y 100
    """
    print(help)
    exit(args.count < 2 ? 2 : 0)
}

let command = args[1]

func argValue(_ flag: String) -> String? {
    guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
    return args[idx + 1]
}

if command == "snapshot" {
    cmdSnapshot()
    exit(0)
}
if command == "apps" {
    cmdApps()
    exit(0)
}
if command == "restore" {
    guard let snap = argValue("--snapshot") else { errorExit("--snapshot <json> required") }
    cmdRestore(snapshotJson: snap)
    exit(0)
}
if command == "hotkey" {
    guard let keys = argValue("--keys") else { errorExit("--keys required (e.g. cmd,a)") }
    cmdHotkey(keys: keys)
    exit(0)
}

if command == "ocr", let _ = argValue("--image") {
    cmdOcr(appName: nil)
    exit(0)
}
if command == "record" {
    cmdRecord()
    exit(0)
}

guard let appName = argValue("--app") else {
    errorExit("--app <name> required")
}

let maxDepth = Int(argValue("--depth") ?? "10") ?? 10

switch command {
case "list":
    cmdList(appName: appName, maxDepth: maxDepth)
case "tree":
    cmdTree(appName: appName, maxDepth: maxDepth)
case "get":
    cmdGet(appName: appName)
case "set":
    guard let value = argValue("--value") else { errorExit("--value required") }
    cmdSet(appName: appName, value: value)
case "press":
    cmdPress(appName: appName)
case "attrs":
    cmdAttrs(appName: appName)
case "actions":
    cmdActions(appName: appName)
case "perform":
    guard let action = argValue("--action") else { errorExit("--action required") }
    cmdPerform(appName: appName, action: action)
case "find":
    let findQ = argValue("--q")
    let findText = argValue("--text")
    cmdFind(appName: appName, role: argValue("--role"), title: argValue("--title"),
            value: argValue("--value"), desc: argValue("--desc"),
            subrole: argValue("--subrole"), text: findText ?? findQ,
            searchAll: findQ != nil, exact: args.contains("--exact"), maxDepth: maxDepth)
case "window":
    cmdWindow(appName: appName)
case "focus":
    cmdFocus(appName: appName)
case "click":
    cmdClick(appName: appName)
case "scroll":
    cmdScroll(appName: appName)
case "type":
    guard let text = argValue("--text") else { errorExit("--text required") }
    cmdTypeText(appName: appName, text: text)
case "preflight":
    cmdPreflight(appName: appName, maxDepth: maxDepth)
case "ocr":
    cmdOcr(appName: appName)
case "screenshot":
    guard let path = argValue("--path") else { errorExit("--path <file.png> required") }
    cmdScreenshot(appName: appName, path: path)
default:
    errorExit("unknown command: \(command). Use: list, tree, get, set, press, attrs, actions, perform, find, window, focus, click, type")
}
