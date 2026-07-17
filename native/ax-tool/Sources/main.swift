import ApplicationServices
import AppKit
import Foundation

// MARK: - AX helpers

func findApp(_ name: String) -> pid_t? {
    let apps = NSWorkspace.shared.runningApplications
    if let app = apps.first(where: { $0.localizedName == name }) {
        return app.processIdentifier
    }
    if let app = apps.first(where: {
        $0.localizedName?.lowercased() == name.lowercased()
    }) {
        return app.processIdentifier
    }
    if let app = apps.first(where: {
        $0.bundleIdentifier?.lowercased().contains(name.lowercased()) == true
    }) {
        return app.processIdentifier
    }
    return nil
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

func findByAttributes(_ root: AXUIElement, role: String?, title: String?,
                       value: String?, desc: String?, subrole: String? = nil,
                       text: String? = nil, searchAll: Bool = false, exact: Bool = false,
                       depth: Int = 0, maxDepth: Int = 15) -> [AXUIElement] {
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
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    }
}

func errorExit(_ message: String) -> Never {
    jsonOutput(["ok": false, "error": message])
    exit(1)
}

// MARK: - Commands

func cmdSet(appName: String, value: String) {
    guard let pid = findApp(appName) else {
        errorExit("app not found: \(appName)")
    }
    let app = AXUIElementCreateApplication(pid)
    let element = resolveElement(app, appName)
    let role = axStringAttribute(element, "AXRole") ?? ""
    let textRoles = Set(["AXTextField", "AXTextArea", "AXSecureTextField", "AXComboBox", "AXSearchField"])

    var result: [String: Any] = ["ok": true, "action": "set", "value": value]
    result.merge(elementInfo(element)) { _, new in new }

    if textRoles.contains(role) {
        NSWorkspace.shared.runningApplications.first {
            $0.processIdentifier == pid
        }?.activate(options: [.activateIgnoringOtherApps])
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
                errorExit("text field outside visible window and AXFocused failed — cannot type safely")
            }
            postClick(at: point, right: false, double: false)
            Thread.sleep(forTimeInterval: 0.1)
            result["focusMethod"] = "click"
        } else {
            result["focusMethod"] = "ax"
        }
        tapKey(0, flags: .maskCommand)  // Cmd+A
        Thread.sleep(forTimeInterval: 0.15)
        tapKey(51)  // Delete
        Thread.sleep(forTimeInterval: 0.1)
        typeString(value, delayMs: 8)
        result["method"] = "type"
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
    guard let pid = findApp(appName) else {
        errorExit("app not found: \(appName)")
    }
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
    guard let pid = findApp(appName) else {
        errorExit("app not found: \(appName)")
    }
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
    guard let pid = findApp(appName) else {
        errorExit("app not found: \(appName)")
    }
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
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
    let tree = windows.map { buildTree($0, maxDepth: maxDepth) }
    jsonOutput(["ok": true, "app": appName, "pid": pid, "windows": tree])
}

func cmdAttrs(appName: String) {
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
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
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
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
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
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
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    if role == nil && title == nil && value == nil && desc == nil && text == nil && subrole == nil {
        errorExit("at least one of --q, --text, --role, --title, --value, --desc, or --subrole required")
    }
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
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
    jsonOutput(result)
}

func resolveWindow(_ app: AXUIElement, _ appName: String) -> AXUIElement {
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }
    if let ws = argValue("--window") {
        for w in windows {
            if (axStringAttribute(w, "AXTitle") ?? "").localizedCaseInsensitiveContains(ws) { return w }
        }
        errorExit("no window matching '\(ws)' in \(appName)")
    }
    return windows.first!
}

func cmdWindow(appName: String) {
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
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
        infos.append(info)
    }
    jsonOutput(["ok": true, "app": appName, "pid": pid, "count": infos.count, "windows": infos])
}

// MARK: - Input Commands (focus, click, type)

func cmdFocus(appName: String) {
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    let runningApp = NSWorkspace.shared.runningApplications.first {
        $0.processIdentifier == pid
    }
    runningApp?.activate(options: [.activateIgnoringOtherApps])

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
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    let right = args.contains("--right")
    let double = args.contains("--double")

    NSWorkspace.shared.runningApplications.first {
        $0.processIdentifier == pid
    }?.activate(options: [.activateIgnoringOtherApps])

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
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    NSWorkspace.shared.runningApplications.first {
        $0.processIdentifier == pid
    }?.activate(options: [.activateIgnoringOtherApps])

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
                errorExit("element outside visible window and AXFocused failed — cannot type safely")
            }
            postClick(at: point, right: false, double: false)
        }
    }

    let delayMs = Double(argValue("--delay") ?? "8") ?? 8
    let doClear = args.contains("--clear")
    let doReturn = args.contains("--return")

    Thread.sleep(forTimeInterval: 0.1)

    if doClear {
        tapKey(0, flags: .maskCommand)  // Cmd+A (select all, keycode 0 = 'a')
        Thread.sleep(forTimeInterval: 0.03)
        tapKey(51)  // Delete/Backspace
        Thread.sleep(forTimeInterval: 0.03)
    }

    typeString(text, delayMs: delayMs)

    if doReturn {
        Thread.sleep(forTimeInterval: 0.03)
        tapKey(36)  // Return
    }

    var result: [String: Any] = ["ok": true, "action": "type", "text": text, "length": text.count]
    if let el = targetEl { result.merge(elementInfo(el)) { _, new in new } }
    jsonOutput(result)
}

// MARK: - Screenshot

func cmdScreenshot(appName: String, path: String) {
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    let windowScope = argValue("--window")

    let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] ?? []
    let appWindows = windowList.filter { ($0[kCGWindowOwnerPID] as? Int32) == pid }

    var targetWindow: [CFString: Any]? = nil
    if let ws = windowScope {
        targetWindow = appWindows.first { w in
            let name = w[kCGWindowName] as? String ?? ""
            return name.localizedCaseInsensitiveContains(ws)
        }
    }
    targetWindow = targetWindow ?? appWindows.first { w in
        let h = w[kCGWindowBounds] as? [String: Any]
        return (h?["Height"] as? Int ?? 0) > 50
    }
    targetWindow = targetWindow ?? appWindows.first

    guard let win = targetWindow,
          let windowID = win[kCGWindowNumber] as? CGWindowID else {
        errorExit("no capturable window for \(appName)")
    }

    guard let cgImage = CGWindowListCreateImage(
        .null, .optionIncludingWindow, windowID, [.boundsIgnoreFraming, .bestResolution]
    ) else {
        errorExit("CGWindowListCreateImage failed")
    }

    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
        errorExit("cannot create image file at \(path)")
    }
    CGImageDestinationAddImage(dest, cgImage, nil)
    if !CGImageDestinationFinalize(dest) {
        errorExit("failed to write PNG to \(path)")
    }

    let title = win[kCGWindowName] as? String ?? ""
    jsonOutput(["ok": true, "action": "screenshot", "path": path,
                "width": cgImage.width, "height": cgImage.height, "window": title])
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

// MARK: - Preflight

func cmdPreflight(appName: String, maxDepth: Int) {
    guard let pid = findApp(appName) else { errorExit("app not found: \(appName)") }
    let app = AXUIElementCreateApplication(pid)
    let windows = axWindows(app)
    if windows.isEmpty { errorExit("no windows for \(appName)") }

    var windowInfos: [[String: Any]] = []
    for (i, w) in windows.enumerated() {
        var info: [String: Any] = ["title": axStringAttribute(w, "AXTitle") ?? "window-\(i)"]
        if let id = axStringAttribute(w, "AXIdentifier") { info["id"] = id }
        if let pos = axPointValue(w, "AXPosition") { info["x"] = pos.x; info["y"] = pos.y }
        if let sz = axSizeValue(w, "AXSize") { info["width"] = sz.width; info["height"] = sz.height }
        windowInfos.append(info)
    }

    var roleCounts: [String: Int] = [:]
    var addressable: [[String: String]] = []
    for window in windows {
        for info in collectElements(window, maxDepth: maxDepth) {
            let role = info.role ?? "?"
            roleCounts[role, default: 0] += 1
            if let eid = info.identifier {
                var entry: [String: String] = ["id": eid, "role": role]
                if let d = info.description { entry["desc"] = d }
                if let t = info.title { entry["title"] = t }
                entry["window"] = axStringAttribute(window, "AXTitle") ?? ""
                addressable.append(entry)
            }
        }
    }

    let uniqueButtons = addressable.filter { $0["role"] == "AXButton" }
        .reduce(into: [[String: String]]()) { result, el in
            if !result.contains(where: { $0["id"] == el["id"] }) { result.append(el) }
        }
    let fields = addressable.filter { $0["role"] == "AXTextField" }
    let checkboxes = addressable.filter { $0["role"] == "AXCheckBox" }
    let popups = addressable.filter { $0["role"] == "AXPopUpButton" }

    var planSteps: [[String: Any]] = [["do": "focus"]]
    planSteps.append(["do": "screenshot", "path": "/tmp/ax-\(appName.lowercased())-before.png"])
    for el in uniqueButtons.prefix(6) {
        let label = el["desc"] ?? el["title"] ?? el["id"] ?? "?"
        var step: [String: Any] = ["do": "press"]
        step["id"] = el["id"]!
        step["_label"] = label
        planSteps.append(step)
    }
    for el in fields.prefix(3) {
        planSteps.append(["do": "set", "id": el["id"]!, "value": "example",
                          "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"])
    }
    for el in checkboxes.prefix(2) {
        planSteps.append(["do": "press", "id": el["id"]!,
                          "_label": el["desc"] ?? el["title"] ?? el["id"] ?? "?"])
    }
    planSteps.append(["do": "screenshot", "path": "/tmp/ax-\(appName.lowercased())-after.png"])

    let plan: [String: Any] = [
        "app": appName, "restore": true, "delayMs": 300, "steps": planSteps,
        "_contract": "https://github.com/genesiscz/GenesisTools — tools ax run --help for full schema"
    ]

    var grouped: [String: [[String: String]]] = [:]
    for el in addressable {
        grouped[el["role"] ?? "?", default: []].append(el)
    }

    jsonOutput([
        "ok": true, "app": appName, "pid": pid,
        "windows": windowInfos,
        "roleCounts": roleCounts,
        "grouped": grouped,
        "addressableCount": addressable.count,
        "totalElements": roleCounts.values.reduce(0, +),
        "suggestedPlan": plan
    ])
}

// MARK: - Main

let args = CommandLine.arguments
if args.count < 2 || args[1] == "--help" || args[1] == "-h" {
    let help = """
    ax-tool — fast AX API CLI for macOS UI automation

    Usage:
      ax-tool list    --app <name> [--depth <n=10>]           List elements (flat, max 2000)
      ax-tool tree    --app <name> [--depth <n=10>]           Hierarchical tree (nested JSON)
      ax-tool get     --app <name> <target>                    Read element attributes
      ax-tool set     --app <name> <target> --value <v>       Set element value
      ax-tool press   --app <name> <target>                   Press (AXPress) an element
      ax-tool attrs   --app <name> <target>                   List ALL attributes + values
      ax-tool actions --app <name> <target>                   List available AX actions
      ax-tool perform --app <name> <target> --action <a>      Perform any AX action
      ax-tool find    --app <name> [--role R] [--title T] [--value V] [--desc D] [--text Q]
      ax-tool window  --app <name>                            Get window bounds and state
      ax-tool focus   --app <name> [<target>]                 Activate app + focus element
      ax-tool click   --app <name> <target>                   CGEvent click at element center
      ax-tool type    --app <name> --text <str> [<target>]    Type keystrokes into element
      ax-tool screenshot --app <name> --path <file.png>        Window screenshot (CGWindowList, no bridge)
      ax-tool hotkey --keys <cmd,a>                           Key combo via CGEvent
      ax-tool snapshot                                        Capture mouse + focused app/window
      ax-tool restore --snapshot <json>                       Restore mouse + focus from snapshot
      ax-tool preflight --app <name> [--depth <n>]            Discover app surface + suggested plan

    Target: --id <axId> OR any combo of --role/--title/--desc (first match).
    Elements WITHOUT AXIdentifier are fully interactable via role/title/desc.

    Output: JSON to stdout. {"ok":true,...} on success, {"ok":false,"error":"..."} on failure.
    Permission: requires Accessibility access for the calling terminal/process.

    Examples:
      ax-tool list --app Finder
      ax-tool tree --app Finder --depth 3
      ax-tool find --app "Brave Browser" --text "YouTube" --depth 10
      ax-tool click --app "Brave Browser" --desc "Venge.io" --role AXButton
      ax-tool press --app Genesis --desc "Account" --role AXButton
      ax-tool focus --app Genesis --id auth-email
      ax-tool type --app Genesis --id auth-email --text "user@test.com"
      ax-tool set --app Genesis --id auth-email --value "user@example.com"
      ax-tool attrs --app "Brave Browser" --desc "Back" --role AXButton
      ax-tool actions --app Finder --id FinderWindow
      ax-tool perform --app Finder --id FinderWindow --action AXRaise
      ax-tool window --app Finder
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
case "type":
    guard let text = argValue("--text") else { errorExit("--text required") }
    cmdTypeText(appName: appName, text: text)
case "preflight":
    cmdPreflight(appName: appName, maxDepth: maxDepth)
case "screenshot":
    guard let path = argValue("--path") else { errorExit("--path <file.png> required") }
    cmdScreenshot(appName: appName, path: path)
default:
    errorExit("unknown command: \(command). Use: list, tree, get, set, press, attrs, actions, perform, find, window, focus, click, type")
}
