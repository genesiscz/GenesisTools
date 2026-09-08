import ApplicationServices
import AppKit
import Darwin
import Foundation
import SnapshotSupport

private struct ObservedTree {
    var elements: [AXUIElement] = []
    var frames: [CGRect] = []
    var rows: [[String: Any]] = []
    var digest: String
}

private struct ObservedWindow {
    let ax: AXUIElement
    let id: CGWindowID
    let bounds: CGRect
}

private func workflowFailure(_ message: String) -> Never {
    errorExit(message)
}

private var workflowInput: WorkflowArguments?

private func workflowArgument(_ flag: String) -> String? {
    workflowInput?.values[flag]
}

private func workflowFlag(_ flag: String) -> Bool {
    workflowInput?.flags.contains(flag) == true
}

private func workflowParse(_ command: String) -> String {
    do {
        let parsed = try WorkflowArguments(Array(args.dropFirst(2)), command: command)
        workflowInput = parsed
        return parsed.values["--app"]!
    } catch {
        workflowFailure(error.localizedDescription)
    }
}

private func workflowInteger(_ flag: String, defaultValue: Int? = nil) -> Int {
    guard let raw = workflowArgument(flag) else {
        if let fallback = defaultValue {
            return fallback
        }
        workflowFailure("\(flag) required")
    }
    guard let value = Int(raw), String(value) == raw else {
        workflowFailure("\(flag) must be an integer")
    }
    return value
}

private func workflowLaunch(_ pid: pid_t) -> Double {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_start_tvsec > 0 else {
        workflowFailure("app launch identity unavailable; cannot create or use a snapshot")
    }
    return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
}

private func workflowWindows(_ pid: pid_t) -> [[CFString: Any]] {
    guard CGPreflightScreenCaptureAccess() else {
        workflowFailure("Screen Recording permission is required for see/act; grant access to the responsible app/process")
    }
    return (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[CFString: Any]] ?? []).filter { ($0[kCGWindowOwnerPID] as? Int32) == pid }
}

private func workflowSameFrame(_ first: CGRect, _ second: CGRect) -> Bool {
    abs(first.minX - second.minX) < 1 && abs(first.minY - second.minY) < 1
        && abs(first.width - second.width) < 1 && abs(first.height - second.height) < 1
}

private func workflowWindow(_ ax: AXUIElement, pid: pid_t) -> ObservedWindow {
    let frame = axFrame(ax)
    guard frame.origin.x.isFinite, frame.origin.y.isFinite,
          frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0,
          (axAttribute(ax, "AXMinimized") as? Bool) != true else {
        workflowFailure("selected window is minimized or has no usable geometry; inspect again")
    }
    let matches = workflowWindows(pid).filter { info in
        guard let raw = info[kCGWindowBounds] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else {
            return false
        }
        return workflowSameFrame(bounds, frame)
    }
    guard matches.count == 1, let id = matches[0][kCGWindowNumber] as? CGWindowID else {
        workflowFailure("selected AX window has \(matches.count) matching on-screen CG windows; refusing an ambiguous or offscreen screenshot")
    }
    // Matching a frame is safe only when exactly one AX window owns it too.
    let sameFrame = axWindows(AXUIElementCreateApplication(pid)).filter { workflowSameFrame(axFrame($0), frame) }
    guard sameFrame.count == 1 else {
        workflowFailure("multiple AX windows share the selected frame; cannot prove screenshot ownership")
    }
    return ObservedWindow(ax: ax, id: id, bounds: frame)
}

private func workflowTree(_ window: AXUIElement, depth: Int, scope: String) -> ObservedTree {
    guard (1...50).contains(depth) else {
        workflowFailure("--depth must be between 1 and 50")
    }
    var tree = ObservedTree(digest: "")
    var visited = SnapshotObjectSet()
    func walk(_ element: AXUIElement, level: Int, clip: CGRect) {
        let identity = CFHash(element)
        guard visited.insert(element) else {
            return
        }
        guard tree.elements.count < 4000 else {
            workflowFailure("AX tree exceeds 4000 elements; snapshot refused rather than truncated")
        }
        var rawChildren: CFTypeRef?
        let read = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &rawChildren)
        guard read == .success || read == .attributeUnsupported || read == .noValue else {
            workflowFailure("AX tree read failed (\(read.rawValue)); refresh instead of assuming an empty subtree")
        }
        // AppKit animates anonymous glyph groups inside standard window buttons.
        // Expose the actual button as a leaf; those decorative descendants are not controls.
        let subrole = axStringAttribute(element, "AXSubrole") ?? ""
        let windowButton = ["AXCloseButton", "AXZoomButton", "AXFullScreenButton", "AXMinimizeButton"].contains(subrole)
        let role = axStringAttribute(element, "AXRole") ?? ""
        let omittedWebContent = scope == "chrome" && role == "AXWebArea"
        let children = windowButton || omittedWebContent ? [] : (rawChildren as? [AXUIElement] ?? [])
        guard level < depth || children.isEmpty else {
            workflowFailure("AX tree exceeds --depth \(depth); increase depth and run see again")
        }
        let frame = axFrame(element)
        var row: [String: Any] = [
            "index": tree.elements.count, "depth": level, "role": role,
            "identity": identity,
            "x": axPx(frame.minX), "y": axPx(frame.minY), "width": axPx(frame.width), "height": axPx(frame.height),
            "visible": frame.width > 0 && frame.height > 0 && clip.contains(CGPoint(x: frame.midX, y: frame.midY)),
            "actions": axActionNames(element).sorted(),
        ]
        if omittedWebContent { row["childrenOmitted"] = "chrome scope" }
        for key in ["AXIdentifier", "AXTitle", "AXDescription", "AXSubrole", "AXValue", "AXEnabled", "AXFocused", "AXSelected", "AXSelectedText", "AXSelectedTextRange"] {
            if let value = axAttribute(element, key) {
                if key == "AXSelectedTextRange", CFGetTypeID(value) == AXValueGetTypeID() {
                    var range = CFRange(location: 0, length: 0)
                    if AXValueGetValue(value as! AXValue, .cfRange, &range) {
                        row[key] = "\(range.location):\(range.length)"
                    } else {
                        workflowFailure("selected text range is unreadable; inspect again")
                    }
                } else if let stable = snapshotValue(value) {
                    row[key] = stable
                } else {
                    row["\(key)Readable"] = false
                }
            }
        }
        var settable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success {
            row["valueSettable"] = settable.boolValue
        }
        tree.elements.append(element)
        tree.frames.append(frame)
        tree.rows.append(row)
        let childClip = role == "AXScrollArea" ? clip.intersection(frame) : clip
        for child in children {
            walk(child, level: level + 1, clip: childClip)
        }
    }
    walk(window, level: 0, clip: axFrame(window))
    do {
        tree.digest = try snapshotDigest(tree.rows)
    } catch {
        workflowFailure("cannot encode observed AX tree: \(error.localizedDescription)")
    }
    return tree
}

private func workflowPermissions() {
    guard AXIsProcessTrusted() else {
        workflowFailure("Accessibility permission is required; grant access to the responsible app/process")
    }
}

private func workflowWindowByID(_ id: Int, pid: pid_t) -> ObservedWindow {
    let cgWindows = workflowWindows(pid).filter { ($0[kCGWindowNumber] as? Int) == id }
    guard cgWindows.count == 1, let bounds = cgWindows[0][kCGWindowBounds] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds) else {
        workflowFailure("selected window is closed or offscreen; run see again")
    }
    let matches = axWindows(AXUIElementCreateApplication(pid)).filter { workflowSameFrame(axFrame($0), frame) }
    guard matches.count == 1 else {
        workflowFailure("selected window identity is missing or ambiguous; run see again")
    }
    let window = workflowWindow(matches[0], pid: pid)
    guard Int(window.id) == id else {
        workflowFailure("selected window identity changed; run see again")
    }
    return window
}

func cmdSee(appName _: String) {
    let appName = workflowParse("see")
    workflowPermissions()
    let pid = resolveApp(appName)
    let launch = workflowLaunch(pid)
    let windows = axWindows(AXUIElementCreateApplication(pid))
    let requested = workflowArgument("--window-index")
    guard !windows.isEmpty else {
        workflowFailure("no AX windows for \(appName); verify permissions and app state")
    }
    if requested != nil && workflowArgument("--window-id") != nil {
        workflowFailure("choose --window-index or --window-id, not both")
    }
    if windows.count > 1 && requested == nil && workflowArgument("--window-id") == nil {
        jsonOutput(["ok": false, "error": "multiple windows; select --window-index from these current candidates",
                    "pid": pid, "windows": windows.enumerated().map { index, window in
                        ["index": index, "title": axStringAttribute(window, "AXTitle") ?? "",
                         "width": axPx(axFrame(window).width), "height": axPx(axFrame(window).height)]
                    }])
        exit(1)
    }
    let index: Int
    let window: ObservedWindow
    if workflowArgument("--window-id") != nil {
        window = workflowWindowByID(workflowInteger("--window-id"), pid: pid)
        guard let found = windows.firstIndex(where: { CFEqual($0, window.ax) }) else {
            workflowFailure("window list changed during selection; inspect again")
        }
        index = found
    } else {
        index = workflowInteger("--window-index", defaultValue: 0)
        guard windows.indices.contains(index) else {
            workflowFailure("--window-index outside current window list")
        }
        window = workflowWindow(windows[index], pid: pid)
    }
    let depth = workflowInteger("--depth", defaultValue: 20)
    let scope = workflowArgument("--scope") ?? "window"
    guard ["window", "chrome"].contains(scope) else { workflowFailure("--scope must be window or chrome") }
    let tree = workflowTree(window.ax, depth: depth, scope: scope)
    guard let image = CGWindowListCreateImage(.null, .optionIncludingWindow, window.id, [.boundsIgnoreFraming, .bestResolution]) else {
        workflowFailure("screenshot failed for the selected window; no snapshot issued")
    }
    let refreshed = workflowWindow(window.ax, pid: pid)
    let after = workflowTree(window.ax, depth: depth, scope: scope)
    guard refreshed.id == window.id, workflowLaunch(pid) == launch, after.digest == tree.digest else {
        var changes: [[String: Any]] = []
        for index in 0..<max(tree.rows.count, after.rows.count) {
            let beforeRow = index < tree.rows.count ? tree.rows[index] : [:]
            let afterRow = index < after.rows.count ? after.rows[index] : [:]
            let fields = Set(beforeRow.keys).union(afterRow.keys).filter { key in
                String(describing: beforeRow[key]) != String(describing: afterRow[key])
            }.sorted()
            if !fields.isEmpty {
                changes.append(["index": index, "fields": fields])
            }
        }
        jsonOutput(["ok": false, "error": "UI changed during screenshot capture; run see again", "changedElements": changes])
        exit(1)
    }
    let path = workflowArgument("--path") ?? FileManager.default.temporaryDirectory
        .appendingPathComponent("control-see-\(UUID().uuidString).png").path
    do {
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            workflowFailure("PNG encoding failed")
        }
        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        let token = SnapshotToken(pid: pid, launch: launch, window: Int(window.id), depth: depth,
                                  digest: tree.digest, created: Date().timeIntervalSince1970, scope: scope)
        let encoded = try JSONEncoder().encode(token).base64EncodedString()
        let publicRows = tree.rows.map { row in row.filter { $0.key != "identity" } }
        jsonOutput(["ok": true, "app": appName, "pid": pid,
                    "window": ["id": window.id, "index": index, "title": axStringAttribute(window.ax, "AXTitle") ?? "",
                               "x": window.bounds.minX, "y": window.bounds.minY,
                               "width": window.bounds.width, "height": window.bounds.height],
                    "screenshot": ["path": URL(fileURLWithPath: path).path, "width": image.width, "height": image.height],
                    "snapshot": encoded, "scope": scope, "expiresInSeconds": 120, "elements": publicRows])
    } catch {
        workflowFailure("cannot save snapshot: \(error.localizedDescription)")
    }
}

private func workflowFrontWindow(_ window: ObservedWindow, pid: pid_t, element: AXUIElement? = nil) {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedWindow"),
          CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window.ax) else {
        workflowFailure("wrong frontmost app/window (expected PID \(pid), frontmost PID \(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1)); use an explicit focus action, then run see again")
    }
    if let element {
        guard let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement"),
              CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, element) else {
            workflowFailure("snapshot element is not the focused input; focus it explicitly and refresh")
        }
    }
}

private func workflowAXAction(_ element: AXUIElement, action: String) {
    guard axActionNames(element).contains(action) else {
        workflowFailure("element does not expose \(action); inspect actions in a fresh see result")
    }
    // AX messaging timeout is an uncertain outcome, never a synthetic success.
    AXUIElementSetMessagingTimeout(element, 3)
    let result = AXUIElementPerformAction(element, action as CFString)
    guard result == .success else {
        workflowFailure("\(action) failed or timed out (AX \(result.rawValue)); outcome may be uncertain, inspect before retrying")
    }
}

func cmdAct(appName _: String) {
    let appName = workflowParse("act")
    guard let raw = workflowArgument("--snapshot"), raw.count < 8192,
          let data = Data(base64Encoded: raw),
          let token = try? JSONDecoder().decode(SnapshotToken.self, from: data) else {
        workflowFailure("invalid --snapshot token; run see again")
    }
    let rawCoords = workflowArgument("--coords")
    if rawCoords != nil && workflowArgument("--element") != nil {
        workflowFailure("choose --coords or --element, not both")
    }
    let elementIndex = rawCoords == nil ? workflowInteger("--element") : 0
    guard let action = workflowArgument("--action"), ["get", "press", "click", "move", "drag", "set", "perform", "focus", "scroll", "type", "key", "select", "paste"].contains(action) else {
        workflowFailure("--action must be get, press, click, drag, set, perform, focus, scroll, type, key, select or paste")
    }
    if !["click", "move", "drag", "scroll"].contains(action) && (rawCoords != nil || workflowFlag("--background")) {
        workflowFailure("--coords and --background apply only to click, drag or pixel scroll")
    }
    if action != "click" && (workflowFlag("--double") || workflowArgument("--button") != nil) {
        workflowFailure("--double and --button apply only to click")
    }
    workflowPermissions()
    let pid = resolveApp(appName)
    let launch = workflowLaunch(pid)
    do {
        // Validate the token before walking a tree or converting an untrusted window ID.
        _ = try token.validate(pid: pid, launch: launch, window: token.window, digest: token.digest,
                               element: elementIndex, count: 4000, now: Date().timeIntervalSince1970)
    } catch {
        workflowFailure(error.localizedDescription)
    }
    let window = workflowWindowByID(token.window, pid: pid)
    let tree = workflowTree(window.ax, depth: token.depth, scope: token.effectiveScope)
    do {
        _ = try token.validate(pid: pid, launch: launch, window: Int(window.id), digest: tree.digest,
                               element: elementIndex, count: tree.elements.count, now: Date().timeIntervalSince1970)
    } catch {
        workflowFailure(error.localizedDescription)
    }
    let element = tree.elements[elementIndex]
    if token.effectiveScope == "chrome", action != "get",
       axStringAttribute(element, "AXRole") == "AXWebArea" || (action == "key" && CFEqual(element, window.ax)) {
        workflowFailure("this action requires window scope or an inspected browser-chrome input")
    }
    if action != "get", (axAttribute(element, "AXEnabled") as? Bool) == false {
        workflowFailure("element is disabled; no action dispatched")
    }
    let operation: SnapshotDispatchOperation
    switch action {
    case "get": operation = .read
    case "focus": operation = .focus
    case "click", "move", "drag", "scroll": operation = .pointer(background: workflowFlag("--background"))
    case "type", "key", "paste": operation = .input
    default: operation = .mutation
    }
    let app = AXUIElementCreateApplication(pid)
    let focusedWindow = axAttribute(app, "AXFocusedWindow")
    let focusedInput = axAttribute(app, "AXFocusedUIElement")
    let windowFocused = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
        && focusedWindow.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window.ax) } == true
    let inputFocused = (action == "key" && CFEqual(element, window.ax))
        || focusedInput.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, element) } == true
    let context = SnapshotDispatchContext(token: token, observedPID: pid, observedProcessLaunch: launch,
        observedWindowID: Int(window.id), observedTreeDigest: tree.digest, observedElementIndex: elementIndex,
        observedElementCount: tree.elements.count, observedAt: Date().timeIntervalSince1970,
        targetEnabled: (axAttribute(element, "AXEnabled") as? Bool) != false,
        windowFocused: windowFocused, inputFocused: inputFocused, operation: operation)
    do {
    try dispatchSnapshotAction(context: context) {
    switch action {
    case "get":
        jsonOutput(["ok": true, "element": tree.rows[elementIndex].filter { $0.key != "identity" }, "windowId": window.id])
        return
    case "press":
        workflowAXAction(element, action: "AXPress")
    case "perform":
        guard let name = workflowArgument("--ax-action") else {
            workflowFailure("perform requires --ax-action from the observed actions list")
        }
        workflowAXAction(element, action: name)
    case "set":
        guard let value = workflowArgument("--value") else {
            workflowFailure("set requires --value")
        }
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue else {
            workflowFailure("AXValue is not settable; no typing fallback is performed")
        }
        let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
        guard result == .success else {
            workflowFailure("AXValue write failed (\(result.rawValue)); inspect before retrying")
        }
        guard axStringAttribute(element, "AXValue") == value else {
            workflowFailure("AXValue read-back differs; inspect actual state before retrying")
        }
    case "select":
        guard let value = axStringAttribute(element, "AXValue") else {
            workflowFailure("select requires readable text in AXValue")
        }
        do {
            let range = try snapshotSelection(in: value, text: workflowArgument("--text"), range: workflowArgument("--range"),
                                               prefix: workflowArgument("--prefix"), suffix: workflowArgument("--suffix"),
                                               mode: workflowArgument("--selection") ?? "text")
            var settable = DarwinBoolean(false)
            guard AXUIElementIsAttributeSettable(element, kAXSelectedTextRangeAttribute as CFString, &settable) == .success,
                  settable.boolValue else {
                workflowFailure("selected text range is not settable; no keyboard fallback")
            }
            var axRange = CFRange(location: range.location, length: range.length)
            guard let encoded = AXValueCreate(.cfRange, &axRange),
                  AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, encoded) == .success,
                  let read = axAttribute(element, "AXSelectedTextRange"), CFGetTypeID(read) == AXValueGetTypeID() else {
                workflowFailure("text selection failed; inspect before retrying")
            }
            var actual = CFRange(location: 0, length: 0)
            guard AXValueGetValue(read as! AXValue, .cfRange, &actual),
                  actual.location == range.location, actual.length == range.length else {
                workflowFailure("selection read-back differs; inspect actual state")
            }
        } catch {
            workflowFailure(error.localizedDescription)
        }
    case "focus":
        guard let app = NSRunningApplication(processIdentifier: pid), app.activate(options: [.activateIgnoringOtherApps]) else {
            workflowFailure("app activation failed")
        }
        workflowAXAction(window.ax, action: "AXRaise")
        var mainSettable = DarwinBoolean(false)
        if AXUIElementIsAttributeSettable(window.ax, kAXMainAttribute as CFString, &mainSettable) == .success,
           mainSettable.boolValue {
            let mainResult = AXUIElementSetAttributeValue(window.ax, kAXMainAttribute as CFString, kCFBooleanTrue)
            guard mainResult == .success else {
                workflowFailure("selected window could not become main (AX \(mainResult.rawValue)); inspect current state")
            }
        }
        if !CFEqual(element, window.ax) {
            let result = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard result == .success else {
                workflowFailure("element focus failed (\(result.rawValue)); refresh")
            }
        }
        let deadline = Date().addingTimeInterval(1)
        while Date() < deadline {
            let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedWindow")
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
               let focused, CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window.ax) {
                break
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        workflowFrontWindow(window, pid: pid, element: CFEqual(element, window.ax) ? nil : element)
    case "scroll", "click", "move", "drag":
        let background = workflowFlag("--background")
        let frame = tree.frames[elementIndex]
        func parsePoint(_ raw: String) throws -> CGPoint {
            let parts = raw.split(separator: ",", omittingEmptySubsequences: false)
            let numbers = parts.compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count == 2, numbers.count == 2, numbers.allSatisfy({ $0.isFinite }) else {
                throw WindowEventError.unavailable("coordinates require finite global screen points x,y")
            }
            let point = CGPoint(x: numbers[0], y: numbers[1])
            guard window.bounds.contains(point) else {
                throw WindowEventError.unavailable("coordinate is outside the snapshot window")
            }
            return point
        }
        func verifyPoint(_ point: CGPoint, target: AXUIElement) throws {
            let listed = CGWindowListCopyWindowInfo(.optionIncludingWindow, window.id) as? [[CFString: Any]] ?? []
            guard listed.contains(where: { info in
                guard (info[kCGWindowNumber] as? CGWindowID) == window.id,
                      (info[kCGWindowOwnerPID] as? Int32) == pid,
                      (info[kCGWindowIsOnscreen] as? Bool) == true,
                      let raw = info[kCGWindowBounds] as? NSDictionary,
                      let current = CGRect(dictionaryRepresentation: raw) else { return false }
                return workflowSameFrame(current, window.bounds)
            }), axFrame(window.ax) == window.bounds, axFrame(element) == frame else {
                throw WindowEventError.unavailable("window or element geometry changed; inspect before retrying")
            }
            if !background {
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                      let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedWindow"),
                      CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window.ax) else {
                    throw WindowEventError.unavailable("wrong frontmost app/window; focus explicitly and refresh")
                }
            }
            var hit: AXUIElement?
            let root = background ? AXUIElementCreateApplication(pid) : AXUIElementCreateSystemWide()
            guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit) == .success else {
                throw WindowEventError.unavailable("cannot verify event hit target")
            }
            var ancestor = hit
            for _ in 0..<50 {
                guard let current = ancestor else { break }
                if token.effectiveScope == "chrome", axStringAttribute(current, "AXRole") == "AXWebArea" {
                    throw WindowEventError.unavailable("web-content coordinates require window scope; no event dispatched")
                }
                if CFEqual(current, target) { return }
                guard let parent = axAttribute(current, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
                ancestor = (parent as! AXUIElement)
            }
            throw WindowEventError.unavailable("observed target is occluded or hit testing disagrees; no event dispatched")
        }
        do {
            guard rawCoords != nil || tree.rows[elementIndex]["visible"] as? Bool == true else {
                throw WindowEventError.unavailable("element center is outside its window/scroll clip")
            }
            let point = try rawCoords.map(parsePoint) ?? CGPoint(x: frame.midX, y: frame.midY)
            try verifyPoint(point, target: element)
            let factory = try WindowEventFactory(windowID: Int(window.id), bounds: window.bounds)
            if action == "move" {
                let event = try factory.mouse(type: .mouseMoved, point: point, clickCount: 0)
                event.postToPid(pid)
                Thread.sleep(forTimeInterval: 0.05)
            } else if action == "scroll" {
                guard let direction = workflowArgument("--direction"), ["up", "down", "left", "right"].contains(direction) else {
                    throw WindowEventError.unavailable("scroll requires --direction up, down, left or right")
                }
                let pixels: Int
                if workflowArgument("--pixels") != nil {
                    guard workflowArgument("--pages") == nil else {
                        throw WindowEventError.unavailable("choose --pixels or --pages, not both")
                    }
                    pixels = workflowInteger("--pixels")
                    guard (1...10000).contains(pixels) else {
                        throw WindowEventError.unavailable("--pixels must be 1–10000")
                    }
                } else {
                    let pages = workflowInteger("--pages", defaultValue: 1)
                    guard (1...20).contains(pages) else {
                        throw WindowEventError.unavailable("--pages must be 1–20")
                    }
                    let distance = (["left", "right"].contains(direction) ? frame.width : frame.height) * Double(pages)
                    guard distance.isFinite, distance >= 1, distance <= 1_000_000 else {
                        throw WindowEventError.unavailable("viewport has no usable page distance")
                    }
                    pixels = Int(distance.rounded())
                }
                let delta = Int32(pixels)
                let event = try factory.scroll(point: point, deltaX: direction == "left" ? delta : direction == "right" ? -delta : 0,
                                               deltaY: direction == "up" ? delta : direction == "down" ? -delta : 0)
                event.postToPid(pid)
                Thread.sleep(forTimeInterval: 0.1)
            } else if action == "drag" {
                guard let destination = workflowArgument("--to") else {
                    throw WindowEventError.unavailable("drag requires --to x,y in the snapshot window")
                }
                let end = try parsePoint(destination)
                try verifyPoint(end, target: window.ax)
                let duration = Double(workflowArgument("--duration") ?? "0.3") ?? 0
                guard duration.isFinite, (0.1...5).contains(duration) else {
                    throw WindowEventError.unavailable("--duration must be 0.1–5 seconds")
                }
                let steps = max(10, Int(duration * 60))
                let points = (1...steps).map { step in
                    CGPoint(x: point.x + (end.x - point.x) * Double(step) / Double(steps),
                            y: point.y + (end.y - point.y) * Double(step) / Double(steps))
                }
                try factory.drag(start: point, points: points, stepDelay: duration / Double(steps),
                                 verify: { try verifyPoint($0, target: $0 == point ? element : window.ax) }, post: { $0.postToPid(pid) })
                Thread.sleep(forTimeInterval: 0.05)
            } else {
                let button = workflowArgument("--button") ?? "left"
                let types: [String: (NSEvent.EventType, NSEvent.EventType)] = [
                    "left": (.leftMouseDown, .leftMouseUp), "right": (.rightMouseDown, .rightMouseUp),
                    "middle": (.otherMouseDown, .otherMouseUp)]
                guard let (downType, upType) = types[button] else {
                    throw WindowEventError.unavailable("--button must be left, right or middle")
                }
                for click in 1...(workflowFlag("--double") ? 2 : 1) {
                    try verifyPoint(point, target: element)
                    let down = try factory.mouse(type: downType, point: point, clickCount: click)
                    let up = try factory.mouse(type: upType, point: point, clickCount: click)
                    if button == "middle" {
                        down.setIntegerValueField(.mouseEventButtonNumber, value: 2)
                        up.setIntegerValueField(.mouseEventButtonNumber, value: 2)
                    }
                    down.postToPid(pid)
                    Thread.sleep(forTimeInterval: 0.03)
                    up.postToPid(pid)
                    Thread.sleep(forTimeInterval: 0.03)
                }
            }
        } catch {
            workflowFailure(error.localizedDescription)
        }
    case "paste":
        workflowFrontWindow(window, pid: pid, element: element)
        guard let text = workflowArgument("--text") else { workflowFailure("paste requires --text") }
        do {
            let transaction = try ClipboardTransaction(board: .general)
            var restoration = "unchanged"
            do {
                defer { restoration = transaction.restore() }
                try transaction.write(text: text, format: workflowArgument("--format") ?? "text")
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
                      let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement"),
                      CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, element) else {
                    throw WindowEventError.unavailable("focus changed before paste; clipboard restored without dispatch")
                }
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false) else {
                    throw WindowEventError.unavailable("could not allocate paste keys")
                }
                down.flags = .maskCommand
                up.flags = .maskCommand
                let before = axStringAttribute(element, "AXValue")
                down.postToPid(pid)
                Thread.sleep(forTimeInterval: 0.05)
                up.postToPid(pid)
                // Keep the pasteboard available while the receiver consumes its queued shortcut.
                let deadline = Date().addingTimeInterval(1)
                repeat {
                    Thread.sleep(forTimeInterval: 0.05)
                    if axStringAttribute(element, "AXValue") != before { break }
                } while Date() < deadline
            }
            jsonOutput(["ok": restoration != "restore-failed", "action": action, "element": elementIndex,
                        "pid": pid, "windowId": window.id, "clipboardRestore": restoration,
                        "refreshRequired": true, "note": "paste dispatched; use see to verify the resulting UI"])
            if restoration == "restore-failed" { exit(1) }
            return
        } catch {
            workflowFailure(error.localizedDescription)
        }
    case "type":
        guard let text = workflowArgument("--text"), !text.contains("\n"), !text.contains("\r") else {
            workflowFailure("type requires single-line --text; use an explicit key action to submit")
        }
        workflowFrontWindow(window, pid: pid, element: element)
        for character in text {
            workflowFrontWindow(window, pid: pid, element: element)
            var units = Array(String(character).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                workflowFailure("could not allocate keyboard events")
            }
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
            down.postToPid(pid)
            up.postToPid(pid)
            Thread.sleep(forTimeInterval: 0.01)
        }
    case "key":
        workflowFrontWindow(window, pid: pid, element: CFEqual(element, window.ax) ? nil : element)
        guard let keys = workflowArgument("--keys") else { workflowFailure("key requires --keys") }
        let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,
            "q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,
            "7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,
            "return":36,"tab":48,"space":49,"backspace":51,"escape":53,"left":123,"right":124,"down":125,"up":126]
        var flags: CGEventFlags = []
        var code: CGKeyCode?
        for key in keys.lowercased().split(separator: ",", omittingEmptySubsequences: false).map(String.init) {
            switch key {
            case "cmd": flags.insert(.maskCommand)
            case "ctrl": flags.insert(.maskControl)
            case "alt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default:
                guard code == nil, let resolved = codes[key] else { workflowFailure("unsupported key combination") }
                code = resolved
            }
        }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let code, let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            workflowFailure("key requires exactly one supported key with optional modifiers")
        }
        down.flags = flags
        up.flags = flags
        down.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.05)
        up.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.05)
    default:
        workflowFailure("unsupported action")
    }
    jsonOutput(["ok": true, "action": action, "element": elementIndex, "pid": pid, "windowId": window.id,
                "refreshRequired": true, "note": "action dispatched; use see to verify the resulting UI"])
    }
    } catch {
        workflowFailure(error.localizedDescription)
    }
}
