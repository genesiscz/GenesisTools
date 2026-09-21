import ApplicationServices
import AppKit
import Darwin
import Foundation
import SnapshotSupport

/// The per-attribute walk: one AX round trip per attribute per element. It is the ground truth
/// the bulk read is measured against, and the fallback when the bulk read has a gap.
struct LiveHierarchySource: HierarchySource {
    func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        axAttribute(element, name)
    }

    func children(of element: AXUIElement) throws -> [AXUIElement] {
        var raw: CFTypeRef?
        let read = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw)
        guard read == .success || read == .attributeUnsupported || read == .noValue else {
            throw ObservedTreeError("AX tree read failed (\(read.rawValue)); refresh instead of assuming an empty subtree")
        }
        return raw as? [AXUIElement] ?? []
    }

    func actionNames(of element: AXUIElement) -> [String] {
        axActionNames(element)
    }

    func isValueSettable(_ element: AXUIElement) -> Bool? {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success else {
            return nil
        }
        return settable.boolValue
    }
}

private let bulkAttributeList = ["AXRole", "AXSubrole", "AXInvalid", kAXPositionAttribute as String, kAXSizeAttribute as String, kAXChildrenAttribute as String] + observedAttributeKeys

/// True when the last tree came from the bulk read; reported by `see` so a slow snapshot can be
/// attributed instead of guessed.
private var workflowBulkUsed = false

private struct ObservedWindow {
    let ax: AXUIElement
    let id: CGWindowID
    let bounds: CGRect
}

private var workflowDispatchState: String?

private func workflowFailure(_ message: String, category: SnapshotRefusal = .refused) -> Never {
    if let state = workflowDispatchState {
        jsonOutput(["ok": false, "error": message, "dispatchState": state, "refusal": category.rawValue])
        exit(1)
    }
    errorExit(message)
}

private func workflowFailure(_ error: Error) -> Never {
    let category = (error as? SnapshotError)?.category ?? (error as? SnapshotDispatchError)?.category ?? (error as? VisualCaptureError)?.category ?? .refused
    workflowFailure(error.localizedDescription, category: category)
}

/// A refusal that omits the rectangle it was compared against sends the caller hunting: a window
/// that repositioned itself between `see` and `act` is indistinguishable from a coordinate that was
/// always wrong. Name the received point, the window and its bounds, so one read settles which.
private func describeOutsideWindow(point: CGPoint, window: ObservedWindow) -> String {
    func whole(_ value: Double) -> Int {
        return Int(value.rounded())
    }

    let bounds = window.bounds
    let received = "\(whole(point.x)),\(whole(point.y))"
    let rectangle = "\(whole(bounds.origin.x)),\(whole(bounds.origin.y)) \(whole(bounds.width))x\(whole(bounds.height))"
    return "coordinate \(received) is outside snapshot window \(window.id), whose bounds are \(rectangle); "
        + "both are global logical points, and a window that moved since see needs a fresh see"
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
        workflowFailure(error)
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

/// Launch identity as a RECOVERABLE error. `workflowSnapshot` runs inside the catch that
/// `act --refresh` uses to fold a refresh failure into `after`, so an app that quit between the
/// dispatch and the refresh — which the action itself may have caused, by closing or quitting
/// it — must throw here. Exiting the process instead reports a dispatched action as failed, and
/// the caller can then retry desktop input that already happened.
func observedLaunch(_ pid: pid_t) throws -> Double {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.stride)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_start_tvsec > 0 else {
        throw ObservedTreeError("app launch identity unavailable; cannot create or use a snapshot")
    }
    return Double(info.pbi_start_tvsec) + Double(info.pbi_start_tvusec) / 1_000_000
}

/// The same read where there is nothing to recover into: creating a snapshot in the first place.
private func workflowLaunch(_ pid: pid_t) -> Double {
    do {
        return try observedLaunch(pid)
    } catch {
        workflowFailure("app launch identity unavailable; cannot create or use a snapshot")
    }
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


func nativeAXWindowID(_ element: AXUIElement) -> CGWindowID? {
    typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
    guard let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY) else { return nil }
    defer { dlclose(handle) }
    guard let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
    let getWindow = unsafeBitCast(symbol, to: GetWindow.self)
    var id: CGWindowID = 0
    return getWindow(element, &id) == .success && id > 0 ? id : nil
}

private func observedWindow(_ ax: AXUIElement, pid: pid_t) throws -> ObservedWindow {
    let frame = axFrame(ax)
    guard frame.origin.x.isFinite, frame.origin.y.isFinite,
          frame.width.isFinite, frame.height.isFinite, frame.width > 0, frame.height > 0,
          (axAttribute(ax, "AXMinimized") as? Bool) != true else {
        throw ObservedTreeError("selected window is minimized or has no usable geometry; inspect again")
    }
    let nativeID = nativeAXWindowID(ax)
    let matches = workflowWindows(pid).filter { info in
        guard let expectedID = info[kCGWindowNumber] as? CGWindowID else { return false }
        guard let raw = info[kCGWindowBounds] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else {
            return false
        }
        return matchesNativeWindowIdentity(reportedID: nativeID, expectedID: expectedID,
            frameMatches: workflowSameFrame(bounds, frame))
    }
    guard matches.count == 1, let id = matches[0][kCGWindowNumber] as? CGWindowID else {
        throw ObservedTreeError("selected AX window has \(matches.count) matching on-screen CG windows; refusing an ambiguous or offscreen screenshot")
    }
    // Matching a frame is safe only when exactly one AX window owns it too.
    let sameFrame = axWindows(AXUIElementCreateApplication(pid)).filter { workflowSameFrame(axFrame($0), frame) }
    guard nativeID != nil || sameFrame.count == 1 else {
        throw ObservedTreeError("multiple AX windows share the selected frame; cannot prove screenshot ownership")
    }
    return ObservedWindow(ax: ax, id: id, bounds: frame)
}

private func workflowWindow(_ ax: AXUIElement, pid: pid_t) -> ObservedWindow {
    do {
        return try observedWindow(ax, pid: pid)
    } catch {
        workflowFailure(error)
    }
}

private func observedTree(_ window: AXUIElement, depth: Int, scope: String) throws -> ObservedTreeData {
    workflowBulkUsed = false
    // The bulk read cannot stop at a web area, so under chrome scope it would fetch the whole
    // page only for the builder to discard it; the walk never descends into it. Measured on
    // Brave 2026-09-11: walk 342-461 ms, bulk 544-911 ms for the same 125 rows.
    if scope != "chrome", ProcessInfo.processInfo.environment["AX_TOOL_NO_BULK"] == nil, let reader = BulkHierarchyReader() {
        do {
            let source = try reader.read(root: window, attributes: bulkAttributeList, maxDepth: depth + 2, maxArrayCount: observedElementLimit)
            let tree = try buildObservedTree(root: window, source: source, depth: depth, scope: scope)
            workflowBulkUsed = true
            return tree
        } catch is BulkHierarchyError {
            // A structural gap in the bulk result (an element it did not return, a truncated
            // children list) is answered by the per-attribute walk, which is the ground truth.
        }
    }
    return try buildObservedTree(root: window, source: LiveHierarchySource(), depth: depth, scope: scope)
}

private func workflowTree(_ window: AXUIElement, depth: Int, scope: String) -> ObservedTreeData {
    do {
        return try observedTree(window, depth: depth, scope: scope)
    } catch {
        workflowFailure(error)
    }
}

private struct SnapshotUnstable: Error {
    let message = "UI changed during observation; run see again"
    let changes: [[String: Any]]
}

/// Image snapshots bracket the capture with matching AX reads. AX-only inspection uses one
/// traversal; execution still validates the observed target immediately before input.
/// `settled` reuses a tree that the post-action settle phase already read.
private func workflowSnapshot(appName: String, pid: pid_t, launch: Double, window: ObservedWindow, index: Int,
                              depth: Int, scope: String, path requestedPath: String?,
                              settled: ObservedTreeData?, captureImage: Bool = true, perception: VisualPerceptionOptions? = nil) throws -> [String: Any] {
    var firstRead = true
    let recovered = try recoverSnapshotRead(isTransient: { $0 is SnapshotUnstable }) {
        let initialTree = firstRead ? settled : nil
        firstRead = false
        let currentWindow = try observedWindow(window.ax, pid: pid)
        guard currentWindow.id == window.id, try observedLaunch(pid) == launch else {
            throw SnapshotError.refusal(.scopeChanged, "window or app instance changed during observation recovery")
        }
        return try workflowSnapshotOnce(appName: appName, pid: pid, launch: launch, window: currentWindow, index: index,
            depth: depth, scope: scope, path: requestedPath, settled: initialTree, captureImage: captureImage, perception: perception)
    }
    var result = recovered.value
    if recovered.retries > 0 { result["observationRecovery"] = ["retries": recovered.retries] }
    return result
}

private func workflowSnapshotOnce(appName: String, pid: pid_t, launch: Double, window: ObservedWindow, index: Int,
                                  depth: Int, scope: String, path requestedPath: String?,
                                  settled: ObservedTreeData?, captureImage: Bool, perception: VisualPerceptionOptions?) throws -> [String: Any] {
    let tree = try settled ?? observedTree(window.ax, depth: depth, scope: scope)
    let image = captureImage ? CGWindowListCreateImage(.null, .optionIncludingWindow, window.id, [.boundsIgnoreFraming, .bestResolution]) : nil
    if captureImage && image == nil {
        throw ObservedTreeError("screenshot failed for the selected window; no snapshot issued")
    }
    let capturedAt = Date().timeIntervalSince1970
    let refreshed = try observedWindow(window.ax, pid: pid)
    let after = try captureImage ? observedTree(window.ax, depth: depth, scope: scope) : tree
    guard refreshed.id == window.id, refreshed.bounds == window.bounds,
          try observedLaunch(pid) == launch, after.digest == tree.digest else {
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
        throw SnapshotUnstable(changes: changes)
    }
    var screenshot: [String: Any] = [:]
    var visual: VisualCaptureIdentity?
    var perceptionResult: [String: Any] = [:]
    if let image {
        let path = requestedPath ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("control-see-\(UUID().uuidString).png").path
        guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            throw ObservedTreeError("PNG encoding failed")
        }
        do { try png.write(to: URL(fileURLWithPath: path), options: .atomic) }
        catch { throw ObservedTreeError("cannot save snapshot: \(error.localizedDescription)") }
        screenshot = ["path": URL(fileURLWithPath: path).path, "width": image.width, "height": image.height]
        let privateFrames = tree.rows.enumerated().compactMap { index, row -> CGRect? in
            guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(row["role"] as? String ?? "") ||
                  row["AXSubrole"] as? String == "AXSecureTextField" ||
                  (scope == "chrome" && row["role"] as? String == "AXWebArea") else { return nil }
            return tree.frames[index]
        }
        let result = try visualPerception(image: image, png: png, pid: pid, launch: launch, windowID: Int(window.id),
            bounds: window.bounds, capturedAt: capturedAt, options: perception, privateFrames: privateFrames)
        visual = result.0
        perceptionResult = result.1
    }
    let token = SnapshotToken(pid: pid, launch: launch, window: Int(window.id), depth: depth,
                              digest: tree.digest, created: capturedAt, scope: scope, visual: visual)
    let encoded: String
    do {
        encoded = try JSONEncoder().encode(token).base64EncodedString()
    } catch {
        throw ObservedTreeError("cannot encode snapshot token: \(error.localizedDescription)")
    }
    let publicRows = tree.rows.map { row in row.filter { $0.key != "identity" } }
    return ["ok": true, "app": appName, "pid": pid, "processLaunch": launch,
            "window": ["id": window.id, "index": index, "title": axStringAttribute(window.ax, "AXTitle") ?? "",
                       "x": window.bounds.minX, "y": window.bounds.minY,
                       "width": window.bounds.width, "height": window.bounds.height],
            "screenshot": screenshot, "imageCaptured": captureImage, "perception": perceptionResult,
            "snapshot": encoded, "scope": scope, "expiresInSeconds": 120, "bulk": workflowBulkUsed,
            "elements": publicRows]
}

/// Wait until two consecutive reads agree, so a post-action snapshot describes a UI that has
/// finished moving. Sky settles on AXObserver notifications; polling the digest needs no run
/// loop subscription. Capped at one second.
private func workflowSettle(_ window: AXUIElement, depth: Int, scope: String) throws -> ObservedTreeData {
    var previous = try observedTree(window, depth: depth, scope: scope)
    let deadline = Date().addingTimeInterval(1)
    while Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
        let next = try observedTree(window, depth: depth, scope: scope)
        if next.digest == previous.digest {
            return next
        }
        previous = next
    }
    return previous
}

/// The post-action snapshot for `act --refresh`. A failure here lands inside `after`, never as
/// the action failing: the action was dispatched, and the caller must not retry it just because
/// the UI was still moving.
private func workflowAfterState(appName: String, pid: pid_t, launch: Double, window: ObservedWindow,
                                token: SnapshotToken) -> [String: Any] {
    do {
        let current = try observedWindow(window.ax, pid: pid)
        let settled = try workflowSettle(current.ax, depth: token.depth, scope: token.effectiveScope)
        guard let index = axWindows(AXUIElementCreateApplication(pid)).firstIndex(where: { CFEqual($0, current.ax) }) else {
            return ["ok": false, "error": "window list changed after the action; run see again"]
        }
        return try workflowSnapshot(appName: appName, pid: pid, launch: launch, window: current, index: index,
                                    depth: token.depth, scope: token.effectiveScope,
                                    path: workflowArgument("--path"), settled: settled, captureImage: !workflowFlag("--no-image"))
    } catch let unstable as SnapshotUnstable {
        return ["ok": false, "error": unstable.message, "changedElements": unstable.changes]
    } catch {
        return ["ok": false, "error": error.localizedDescription]
    }
}

private func workflowSelectOption(_ element: AXUIElement, value: String) throws {
    if axStringAttribute(element, "AXValue") == value { return }
    guard axActionNames(element).contains("AXPress") else {
        throw SnapshotError.refusal(.refused, "dropdown cannot open its observed options")
    }
    let opened = performActionWithTimeout(element, action: "AXPress", timeoutMs: 1500)
    guard opened == .success else {
        throw SnapshotError.refusal(.refused, "dropdown opening did not complete; inspect before retrying")
    }
    var selected = false
    var menu: AXUIElement?
    defer {
        if !selected, let menu, axActionNames(menu).contains("AXCancel") {
            let cancelled = performActionWithTimeout(menu, action: "AXCancel", timeoutMs: 500)
            if cancelled != .success {
                fputs("Could not dismiss the unselected dropdown (AX \(cancelled.rawValue))\n", stderr)
            }
        }
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 1
    var tree = try buildObservedTree(root: element, source: LiveHierarchySource(), depth: 8, scope: "window")
    while !tree.rows.contains(where: { $0["role"] as? String == "AXMenuItem" }), ProcessInfo.processInfo.systemUptime < deadline {
        Thread.sleep(forTimeInterval: 0.1)
        tree = try buildObservedTree(root: element, source: LiveHierarchySource(), depth: 8, scope: "window")
    }
    if let index = tree.rows.firstIndex(where: { $0["role"] as? String == "AXMenu" }) { menu = tree.elements[index] }
    let index = try exactMenuOptionIndex(rows: tree.rows, value: value)
    let result = performActionWithTimeout(tree.elements[index], action: "AXPress", timeoutMs: 1500)
    guard result == .success else {
        throw SnapshotError.refusal(.refused, "dropdown selection did not complete; inspect before retrying")
    }
    selected = true
    let readbackDeadline = ProcessInfo.processInfo.systemUptime + 1
    while axStringAttribute(element, "AXValue") != value, ProcessInfo.processInfo.systemUptime < readbackDeadline {
        Thread.sleep(forTimeInterval: 0.1)
    }
    guard axStringAttribute(element, "AXValue") == value else {
        throw SnapshotError.refusal(.refused, "dropdown selection read-back differs; inspect before retrying")
    }
}

private func workflowPermissions() {
    guard AXIsProcessTrusted() else {
        if workflowDispatchState != nil {
            workflowFailure("Accessibility permission is required.", category: .permission)
        }
        axUntrustedExit()
    }
}

private func workflowWindowByID(_ id: Int, pid: pid_t) -> ObservedWindow {
    let cgWindows = workflowWindows(pid).filter { ($0[kCGWindowNumber] as? Int) == id }
    guard cgWindows.count == 1, let bounds = cgWindows[0][kCGWindowBounds] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds) else {
        workflowFailure("selected window is closed or offscreen; run see again", category: .scopeChanged)
    }
    let matches = axWindows(AXUIElementCreateApplication(pid)).filter {
        return matchesNativeWindowIdentity(reportedID: nativeAXWindowID($0), expectedID: CGWindowID(id),
            frameMatches: workflowSameFrame(axFrame($0), frame))
    }
    guard matches.count == 1 else {
        workflowFailure("selected window identity is missing or ambiguous; run see again", category: .scopeChanged)
    }
    let window = workflowWindow(matches[0], pid: pid)
    guard Int(window.id) == id else {
        workflowFailure("selected window identity changed; run see again", category: .scopeChanged)
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
    do {
        var perception: VisualPerceptionOptions?
        if workflowArgument("--perception") == "ocr" {
            var crop: VisualRect?
            if let rawCrop = workflowArgument("--perception-crop") {
                let parts = rawCrop.split(separator: ",", omittingEmptySubsequences: false)
                let numbers = parts.compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
                guard parts.count == 4, numbers.count == 4 else { throw VisualCaptureError.invalid("perception crop requires x,y,width,height in source pixels") }
                crop = VisualRect(x: Double(numbers[0]), y: Double(numbers[1]), width: Double(numbers[2]), height: Double(numbers[3]))
            }
            var width: Int?
            if let rawWidth = workflowArgument("--perception-width") {
                guard let number = Int(rawWidth), number >= 64, number <= 8192 else {
                    throw VisualCaptureError.invalid("perception width must be 64–8192 pixels")
                }
                width = number
            }
            perception = VisualPerceptionOptions(ocr: true, crop: crop, width: width)
        }
        jsonOutput(try workflowSnapshot(appName: appName, pid: pid, launch: launch, window: window, index: index,
                                        depth: depth, scope: scope, path: workflowArgument("--path"), settled: nil, captureImage: !workflowFlag("--no-image"), perception: perception))
    } catch let unstable as SnapshotUnstable {
        jsonOutput(["ok": false, "error": unstable.message, "changedElements": unstable.changes])
        exit(1)
    } catch {
        workflowFailure(error)
    }
}

private func workflowFrontWindow(_ window: ObservedWindow, pid: pid_t, element: AXUIElement? = nil) {
    // Root gate rather than one guard per call site: this function is reached from nine places on
    // the input paths, and patching the two I happened to test would have left the rest stealing
    // focus. --no-activate is only accepted for key/type/paste/select/set, so an early return here
    // cannot loosen a pointer action.
    if workflowFlag("--no-activate") {
        return
    }

    let currentFrontmost = frontmostPid()
    guard currentFrontmost == pid,
          let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedWindow"),
          CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window.ax) else {
        workflowFailure("wrong frontmost app/window (expected PID \(pid), frontmost PID \(currentFrontmost ?? -1)); use an explicit focus action, then run see again", category: .focusMismatch)
    }
    if let element {
        guard let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement"),
              CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, element) else {
            workflowFailure("snapshot element is not the focused input; focus it explicitly and refresh", category: .focusMismatch)
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

/// Raise the window for a prepared action. Some apps (Calculator on macOS 26 answers AXRaise with
/// AX -25205) refuse the action although activation already made the window frontmost and main.
/// That state is accepted only when it is observable on the window itself; anything else stays an
/// uncertain outcome, never a synthetic success.
private func workflowRaise(_ window: ObservedWindow) {
    guard axActionNames(window.ax).contains("AXRaise") else {
        workflowFailure("element does not expose AXRaise; inspect actions in a fresh see result")
    }
    AXUIElementSetMessagingTimeout(window.ax, 3)
    let result = AXUIElementPerformAction(window.ax, "AXRaise" as CFString)
    if result == .success {
        return
    }
    let isMain = (axAttribute(window.ax, "AXMain") as? NSNumber)?.boolValue == true
    let isFocused = (axAttribute(window.ax, "AXFocused") as? NSNumber)?.boolValue == true
    guard isMain || isFocused else {
        workflowFailure("AXRaise failed or timed out (AX \(result.rawValue)) and the window is not main; outcome may be uncertain, inspect before retrying")
    }
}

private func workflowFocus(_ window: ObservedWindow, pid: pid_t, element: AXUIElement) {
        guard bringFrontmost(pid) else {
            workflowFailure("app activation failed")
        }
        let focusedWindow = axAttribute(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute as String)
        let alreadyFocused = frontmostPid() == pid && focusedWindow.map {
            CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window.ax)
        } == true
        if !alreadyFocused {
            workflowRaise(window)
        }
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
            if frontmostPid() == pid,
               let focused, CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window.ax) {
                break
            }
            CFRunLoopRunInMode(.defaultMode, 0.02, false)
        }
        workflowFrontWindow(window, pid: pid, element: CFEqual(element, window.ax) ? nil : element)
}

func cmdAct(appName _: String) {
    workflowDispatchState = "not_started"
    let appName = workflowParse("act")
    // Martin's requirement, made testable: a caller must be able to tell whether driving the app
    // disturbed the user. Reported on EVERY act result, not only the ones that tried not to.
    let startingFrontmost = frontmostPid()
    guard let raw = workflowArgument("--snapshot"), raw.count < 65536,
          let data = Data(base64Encoded: raw),
          let token = try? JSONDecoder().decode(SnapshotToken.self, from: data) else {
        workflowFailure("invalid --snapshot token; run see again")
    }
    var rawCoords = workflowArgument("--coords")
    if let region = workflowArgument("--region") {
        do {
            guard let visual = token.visual else { throw VisualCaptureError.invalid("snapshot has no visual regions") }
            let point = try visual.center(of: region)
            rawCoords = "\(point.x),\(point.y)"
        } catch { workflowFailure(error) }
    }

    var elementIndex = rawCoords == nil ? workflowInteger("--element") : 0
    let action = workflowArgument("--action")!
    workflowPermissions()
    let pid = resolveApp(appName)
    let launch = workflowLaunch(pid)
    do {
        // Validate the token before walking a tree or converting an untrusted window ID.
        _ = try token.validate(pid: pid, launch: launch, window: token.window, digest: token.digest,
                               element: elementIndex, count: 4000, now: Date().timeIntervalSince1970)
    } catch {
        workflowFailure(error)
    }
    var window = workflowWindowByID(token.window, pid: pid)
    var tree = workflowTree(window.ax, depth: token.depth, scope: token.effectiveScope)
    var dispatchToken = token
    // The prepared path already re-resolved the target by identity and reissued the token against
    // the FRESH tree, which is exactly what a ticking window needs. It was reachable only through
    // --prepare, which forces a foreground element action, so a background caller had no way to
    // survive a clock: Flow's HUD refused every see→act pair with "UI changed; run see again".
    // --revalidate-scope element opens the same door without the focus requirement.
    let revalidateScope = workflowArgument("--revalidate-scope") ?? "window"
    if let key = workflowArgument("--target-key"), workflowFlag("--prepare") || revalidateScope == "element" {
        do {
            elementIndex = revalidateScope == "element"
                ? try resolvedTargetIndex(key:key,rows:tree.rows)
                : try preparedTargetIndex(key:key,rows:tree.rows)
            dispatchToken = SnapshotToken(pid:pid,launch:launch,window:Int(window.id),depth:token.depth,
                digest:tree.digest,created:token.created,scope:token.effectiveScope)
        } catch { workflowFailure(error) }
    }
    do {
        _ = try dispatchToken.validate(pid: pid, launch: launch, window: Int(window.id), digest: tree.digest,
                               element: elementIndex, count: tree.elements.count, now: Date().timeIntervalSince1970)
    } catch {
        workflowFailure(error)
    }
    let element = tree.elements[elementIndex]
    if action != "get", !(action == "focus" && elementIndex == 0) {
        let coordinates = rawCoords?.split(separator: ",").compactMap { Double($0) }
        let point = coordinates?.count == 2 ? CGPoint(x: coordinates![0], y: coordinates![1]) : nil
        do { try validateModalTarget(rows: tree.rows, target: elementIndex, point: point) }
        catch { workflowFailure(error) }
    }
    var prepared = false
    if workflowFlag("--prepare") {
        guard (axAttribute(element,"AXEnabled") as? NSNumber)?.boolValue != false else {
            workflowFailure("selected target is disabled")
        }
        let before = tree.rows[elementIndex]
        workflowFocus(window, pid:pid, element:window.ax)
        if axActionNames(element).contains("AXScrollToVisible") || tree.rows[elementIndex]["visible"] as? Bool != true {
            guard tryScrollIntoView(element,app:AXUIElementCreateApplication(pid)) else {
                workflowFailure("selected element could not scroll into view")
            }
        }
        if action != "click", !CFEqual(element,window.ax) {
            let focused = AXUIElementSetAttributeValue(element,kAXFocusedAttribute as CFString,kCFBooleanTrue)
            guard focused == .success else { workflowFailure("selected input could not be focused during preparation") }
        }
        let refreshedWindow = workflowWindowByID(token.window,pid:pid)
        guard (try? observedLaunch(pid)) == launch else { workflowFailure("app instance changed during preparation") }
        let refreshed = workflowTree(refreshedWindow.ax,depth:token.depth,scope:token.effectiveScope)
        guard let nextIndex = refreshed.elements.firstIndex(where: { CFEqual($0,element) }) else {
            workflowFailure("selected element disappeared during preparation")
        }
        do {
            try validatePreparedTarget(before:before,after:refreshed.rows[nextIndex],sameElement:true)
        } catch { workflowFailure(error) }
        window = refreshedWindow
        tree = refreshed
        elementIndex = nextIndex
        do { try validateModalTarget(rows: tree.rows, target: elementIndex) }
        catch { workflowFailure(error) }
        dispatchToken = SnapshotToken(pid:pid,launch:launch,window:Int(window.id),depth:token.depth,
            digest:tree.digest,created:token.created,scope:token.effectiveScope)
        workflowFrontWindow(window,pid:pid)
        prepared = true
    }
    if token.effectiveScope == "chrome", action != "get",
       axStringAttribute(element, "AXRole") == "AXWebArea" || (action == "key" && CFEqual(element, window.ax)) {
        workflowFailure("this action requires window scope or an inspected browser-chrome input")
    }
    // dispatchSnapshotAction owns the enabled-state boundary: "get" is the only .read
    // operation, and it applies the same unknown-as-enabled rule to every other one.
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
    let windowFocused = frontmostPid() == pid
        && focusedWindow.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window.ax) } == true
    let inputFocused = (action == "key" && CFEqual(element, window.ax))
        || focusedInput.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, element) } == true
    // A panel that can never be key cannot satisfy a frontmost precondition, so asking it to is a
    // wall rather than a guard. The CG layer is read from the live window list; AppKit also gives
    // such windows a floating/dialog subrole, and either signal is enough.
    let windowLayer = (CGWindowListCopyWindowInfo(.optionIncludingWindow, window.id) as? [[CFString: Any]])?
        .first(where: { ($0[kCGWindowNumber] as? CGWindowID) == window.id })?[kCGWindowLayer] as? Int
    let nonActivatingPanel = windowCannotBecomeKey(layer: windowLayer,
                                                   subrole: axStringAttribute(window.ax, "AXSubrole"))
    if nonActivatingPanel {
        ActionCursor.suppressedForNonActivatingPanel = true
    }
    let context = SnapshotDispatchContext(token: dispatchToken, observedPID: pid, observedProcessLaunch: launch,
        observedWindowID: Int(window.id), observedTreeDigest: tree.digest, observedElementIndex: elementIndex,
        observedElementCount: tree.elements.count, observedAt: Date().timeIntervalSince1970,
        targetEnabled: (axAttribute(element, "AXEnabled") as? Bool) != false,
        windowFocused: windowFocused, inputFocused: inputFocused,
        allowUnfocusedInput: workflowFlag("--no-activate") || nonActivatingPanel,
        windowCanBecomeKey: !nonActivatingPanel, operation: operation)
    func validateAfterFeedback() throws {
        let freshWindow = workflowWindowByID(token.window, pid: pid)
        let fresh = workflowTree(freshWindow.ax, depth: token.depth, scope: token.effectiveScope)
        // 🛑 The else branch below compares the WHOLE fresh tree digest, so a window with a running
        // clock fails here even after the target was pinned by identity: the second read is a
        // second later. Any caller that pinned an identity gets re-resolved against the fresh tree
        // instead. Element scope pins the stable identity, because targetKey folds in sibling text
        // and a clock beside a button is a sibling.
        let identityField = prepared ? "targetKey" : "stableKey"
        let identityPinned = prepared || (revalidateScope == "element" && workflowArgument("--target-key") != nil)
        if identityPinned, let key = tree.rows[elementIndex][identityField] as? String {
            let currentIndex = try preparedTargetIndex(key: key, rows: fresh.rows, field: identityField)

            if prepared {
                try validatePreparedTarget(before: tree.rows[elementIndex], after: fresh.rows[currentIndex],
                    sameElement: CFEqual(element, fresh.elements[currentIndex]))
            }

            try validateModalTarget(rows: fresh.rows, target: currentIndex)
            _ = try dispatchToken.validate(pid: pid, launch: observedLaunch(pid), window: Int(freshWindow.id),
                digest: dispatchToken.digest, element: currentIndex, count: fresh.elements.count,
                now: Date().timeIntervalSince1970)
        } else {
            _ = try dispatchToken.validate(pid: pid, launch: observedLaunch(pid), window: Int(freshWindow.id),
                digest: fresh.digest, element: elementIndex, count: fresh.elements.count,
                now: Date().timeIntervalSince1970)
        }
        if operation == .input {
            if action == "key", CFEqual(element, window.ax), !workflowFlag("--no-activate") {
                workflowFrontWindow(freshWindow, pid: pid)
            }
            else { workflowFrontWindow(freshWindow, pid: pid, element: element) }
        }
    }
    do {
    try dispatchSnapshotAction(context: context) {
    workflowDispatchState = "not_started"
    if !["get", "click", "move", "drag", "scroll"].contains(action) {
        let frame = tree.frames[elementIndex]
        let center = CGPoint(x: frame.midX, y: frame.midY)
        if frame.width > 0, frame.height > 0, window.bounds.contains(center) {
            ActionCursor.emit(action, point: center, background: frontmostPid() != pid)
            // Presentation can span a cold helper launch or glide. Revalidate after that wait.
            try validateAfterFeedback()
        } else {
            ActionCursor.emit(action, point: nil, background: frontmostPid() != pid)
        }
    }
    var actionExtras: [String: Any] = prepared ? ["prepared":true] : [:]
    var actionOK = true
    workflowDispatchState = "uncertain"
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
        if axStringAttribute(element, "AXRole") == "AXPopUpButton" {
            try workflowSelectOption(element, value: value)
            break
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
            workflowFailure(error)
        }
    case "focus":
        workflowFocus(window, pid:pid, element:element)
    case "scroll", "click", "move", "drag", "hover":
        let background = workflowFlag("--background")
        let frame = tree.frames[elementIndex]
        // 🛑 The default stays `screen`, NOT `window` as the spec asked. Flipping it would silently
        // reinterpret every coordinate an existing caller already passes: a global point read as
        // window-relative usually still lands INSIDE the window, so there is no refusal and no
        // error — just a click in the wrong place. A caller who wants a point that survives the
        // window moving opts in with --frame window, and that is the one this documents.
        let coordinateFrame = workflowArgument("--frame") ?? "screen"
        func parsePoint(_ raw: String) throws -> CGPoint {
            let parts = raw.split(separator: ",", omittingEmptySubsequences: false)
            let numbers = parts.compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard parts.count == 2, numbers.count == 2, numbers.allSatisfy({ $0.isFinite }) else {
                throw WindowEventError.unavailable("coordinates require two finite numbers x,y")
            }
            let given = CGPoint(x: numbers[0], y: numbers[1])
            // A window-relative point is resolved against the window's CURRENT origin, which is
            // the whole point: the HUD that moved from -459,-1057 to -64,-922 between two calls
            // keeps the same window-relative coordinates.
            let point = coordinateFrame == "window"
                ? CGPoint(x: window.bounds.origin.x + given.x, y: window.bounds.origin.y + given.y)
                : given
            guard window.bounds.contains(point) else {
                throw WindowEventError.unavailable(describeOutsideWindow(point: point, window: window))
            }

            return point
        }
        var visualAdmitted = false
        func admitVisualAction() throws {
            guard rawCoords != nil || action == "drag", !visualAdmitted else { return }
            workflowDispatchState = "not_started"
            guard let visual = token.visual else {
                throw VisualCaptureError.invalid("coordinate actions require a fresh screenshot-backed observation")
            }
            guard try !visualCaptureWasUsed(visual) else { throw VisualCaptureError.invalid("visual capture already used; observe again") }
            guard let currentImage = CGWindowListCreateImage(.null, .optionIncludingWindow, window.id, [.boundsIgnoreFraming, .bestResolution]) else {
                throw VisualCaptureError.invalid("coordinate actions require a fresh screenshot-backed observation")
            }
            let liveWindow = try observedWindow(window.ax, pid: pid)
            try admitVisualCapture(capture: visual, pid: pid, launch: try observedLaunch(pid), windowID: Int(liveWindow.id),
                bounds: VisualRect(liveWindow.bounds), pixelHash: try visualPixelHash(currentImage),
                width: currentImage.width, height: currentImage.height, now: Date().timeIntervalSince1970,
                requirePixelMatch: revalidateScope != "element",
                consume: { try consumeVisualCapture(visual) })
            visualAdmitted = true
            workflowDispatchState = "uncertain"
        }
        func verifyPoint(_ point: CGPoint, pin: SnapshotVerifyTarget) throws -> AXUIElement {
            // Pin whatever the CALLER named. The parameter existed but was ignored: the
            // guard asserted the captured `element` frame every time, so a drag — which
            // names the window for every step after mouse-down precisely because the
            // dragged element is meant to move — aborted the moment its target moved,
            // posted the release and reported a half-completed drag.
            //
            // `--coords` made it worse: it forces elementIndex 0, which IS the window, so
            // the window frame was asserted twice, once tolerantly against the CG bounds
            // and once exactly against the AX frame.
            //
            // The pin arrives as the enum the caller already computed, rather than as an
            // element this function has to compare back into the same choice.
            let target = pin == .window ? window.ax : element
            let expectedTargetFrame = WindowEventFactory.expectedVerifyFrame(
                target: pin, windowBounds: window.bounds, elementFrame: frame)
            /// Geometry and focus as they are RIGHT NOW. The retry loop below sleeps, and this
            /// is what says the window has not moved and focus has not wandered in the meantime.
            func assertUnmoved() throws {
                let listed = CGWindowListCopyWindowInfo(.optionIncludingWindow, window.id) as? [[CFString: Any]] ?? []
                guard listed.contains(where: { info in
                    guard (info[kCGWindowNumber] as? CGWindowID) == window.id,
                          (info[kCGWindowOwnerPID] as? Int32) == pid,
                          (info[kCGWindowIsOnscreen] as? Bool) == true,
                          let raw = info[kCGWindowBounds] as? NSDictionary,
                          let current = CGRect(dictionaryRepresentation: raw) else { return false }
                    return workflowSameFrame(current, window.bounds)
                }), axFrame(window.ax) == window.bounds, axFrame(target) == expectedTargetFrame else {
                    throw WindowEventError.unavailable("window or element geometry changed; inspect before retrying")
                }
                // The frontmost guard exists so a CLICK or a KEY lands in the window the caller
                // named. A hover sends neither: it moves the pointer, and the pointer's position
                // alone decides which window receives the mouse-moved. Requiring the key window
                // here would make hover steal focus to do its job, which is the opposite of what
                // it is for.
                if !background && action != "hover" && !nonActivatingPanel {
                    guard frontmostPid() == pid,
                          let focused = axAttribute(AXUIElementCreateApplication(pid), "AXFocusedWindow"),
                          CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, window.ax) else {
                        throw WindowEventError.unavailable("wrong frontmost app/window; focus explicitly and refresh")
                    }
                }
            }
            let root = background ? AXUIElementCreateApplication(pid) : AXUIElementCreateSystemWide()
            // Chromium answers a hit test coarsely the first time (a container group) and
            // refines it once the renderer has resolved the point, so inside web content the
            // first answer disagrees with the target and a later one agrees. Ask up to five
            // times, 50 ms apart, before calling the target occluded. Native apps answer the
            // same way every time and pay nothing here.
            //
            // The checks run at the START OF EVERY attempt, not once before the loop: the four
            // sleeps span 200 ms, and a window that moves or loses focus inside that window
            // would otherwise have a later hit accepted against geometry nobody re-read, which
            // is a synthetic click dispatched at a stale coordinate.
            for attempt in 0..<5 {
                if attempt > 0 {
                    Thread.sleep(forTimeInterval: 0.05)
                }
                try assertUnmoved()
                var hit: AXUIElement?
                guard AXUIElementCopyElementAtPosition(root, Float(point.x), Float(point.y), &hit) == .success, let hit else {
                    throw WindowEventError.unavailable("cannot verify event hit target")
                }
                var ancestor: AXUIElement? = hit
                var enabledStates: [Bool?] = []
                for _ in 0..<50 {
                    guard let current = ancestor else { break }
                    enabledStates.append((axAttribute(current, "AXEnabled") as? NSNumber)?.boolValue)
                    if token.effectiveScope == "chrome", axStringAttribute(current, "AXRole") == "AXWebArea" {
                        throw WindowEventError.unavailable("web-content coordinates require window scope; no event dispatched")
                    }
                    if CFEqual(current, target) {
                        try validatePointerHitEnabled(enabledStates)
                        return hit
                    }
                    guard let parent = axAttribute(current, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
                    ancestor = (parent as! AXUIElement)
                }
            }
            throw WindowEventError.unavailable("observed target is occluded or hit testing disagrees; no event dispatched")
        }
        func pageViewport(_ point: CGPoint, pin: SnapshotVerifyTarget) throws -> (element: AXUIElement, observed: ScrollViewportAncestor) {
            let hit = try verifyPoint(point, pin: pin)
            var elements: [AXUIElement] = []
            var ancestors: [ScrollViewportAncestor] = []
            var current: AXUIElement? = hit
            for _ in 0..<50 {
                guard let candidate = current else {
                    break
                }
                let reference = elements.count
                elements.append(candidate)
                ancestors.append(ScrollViewportAncestor(
                    identity: reference,
                    role: axStringAttribute(candidate, "AXRole") ?? "",
                    frame: axFrame(candidate)
                ))
                if CFEqual(candidate, window.ax) {
                    let viewport = try resolveScrollViewport(
                        ancestors: ancestors,
                        selectedWindowIdentity: reference,
                        selectedWindowFrame: window.bounds,
                        point: point
                    )
                    return (elements[viewport.identity], viewport)
                }
                guard let parent = axAttribute(candidate, "AXParent"), CFGetTypeID(parent) == AXUIElementGetTypeID() else {
                    break
                }
                current = (parent as! AXUIElement)
            }
            throw ScrollViewportError.unavailable
        }
        do {
            guard rawCoords != nil || tree.rows[elementIndex]["visible"] as? Bool == true else {
                throw WindowEventError.unavailable("element center is outside its window/scroll clip")
            }
            let point = try rawCoords.map(parsePoint) ?? CGPoint(x: frame.midX, y: frame.midY)
            // A caller that passed a window-relative point cannot otherwise tell WHERE it landed,
            // and that is the number to compare against a screenshot or a later observation.
            if let raw = rawCoords {
                actionExtras["coordinateFrame"] = coordinateFrame
                actionExtras["requestedPoint"] = raw
                actionExtras["resolvedPoint"] = ["x": snapshotPx(point.x), "y": snapshotPx(point.y)]
            }

            _ = try verifyPoint(point, pin: .element)
            let factory = try WindowEventFactory(windowID: Int(window.id), bounds: window.bounds)
            if action == "hover" {
                // 🛑 `move` posts a window-addressed mouseMoved to the pid. That never moves the
                // hardware pointer, so a SwiftUI .onHover tracking area never fires and a toolbar
                // revealed by hover stays invisible: measured on Flow 2026-09-21, the tree was
                // byte-identical before and after a dispatched move. Hover therefore warps the real
                // cursor, holds it, READS THE TREE WHILE IT IS STILL THERE, and puts the pointer
                // back. Observing after the restore would always miss the thing hover revealed.
                let dwellMs = workflowArgument("--dwell") == nil ? 400 : workflowInteger("--dwell")
                guard (1...10000).contains(dwellMs) else {
                    throw WindowEventError.unavailable("--dwell must be 1–10000 milliseconds")
                }
                let origin = CGEvent(source: nil)?.location
                let before = Set(tree.rows.compactMap { $0["AXTitle"] as? String }).union(
                    tree.rows.compactMap { $0["AXDescription"] as? String })
                ActionCursor.emit("move", point: point, background: false, target: rawCoords == nil ? "ax" : "pixel")
                CGWarpMouseCursorPosition(point)
                if let moved = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                                       mouseCursorPosition: point, mouseButton: .left) {
                    moved.post(tap: .cghidEventTap)
                }
                Thread.sleep(forTimeInterval: Double(dwellMs) / 1000.0)
                let during = workflowAfterState(appName: appName, pid: pid, launch: launch, window: window, token: token)
                // --hold leaves the pointer on the target. A control revealed by hover exists only
                // while the pointer is over it, so restoring here would delete the thing the next
                // act wants to press. The caller owns putting it back, with `control restore`.
                let hold = workflowFlag("--hold")
                if let origin, !hold {
                    CGWarpMouseCursorPosition(origin)
                }
                let rows = (during["elements"] as? [[String: Any]]) ?? []
                let after = Set(rows.compactMap { $0["AXTitle"] as? String }).union(
                    rows.compactMap { $0["AXDescription"] as? String })
                actionExtras["dwellMs"] = dwellMs
                actionExtras["during"] = during
                // What the hover REVEALED. Without this a caller has to diff two trees itself to
                // learn whether the hover did anything at all.
                actionExtras["revealed"] = after.subtracting(before).sorted()
                actionExtras["pointerRestored"] = origin != nil && !hold
                actionExtras["pointerHeld"] = hold
                workflowDispatchState = "dispatched"
            } else if action == "move" {
                let event = try factory.mouse(type: .mouseMoved, point: point, clickCount: 0)
                try dispatchAfterPresentation(present: {
                    ActionCursor.emit("move", point: point, background: background, target: rawCoords == nil ? "ax" : "pixel")
                }, validate: {
                    try validateAfterFeedback()
                    _ = try verifyPoint(point, pin: .element)
                    try admitVisualAction()
                }, dispatch: { event.postToPid(pid) })
                Thread.sleep(forTimeInterval: 0.05)
            } else if action == "scroll" {
                guard let direction = workflowArgument("--direction"), ["up", "down", "left", "right"].contains(direction) else {
                    throw WindowEventError.unavailable("scroll requires --direction up, down, left or right")
                }
                let pixels: Int
                let pageViewportObservation: (element: AXUIElement, observed: ScrollViewportAncestor)?
                if workflowArgument("--pixels") != nil {
                    guard workflowArgument("--pages") == nil else {
                        throw WindowEventError.unavailable("choose --pixels or --pages, not both")
                    }
                    pixels = workflowInteger("--pixels")
                    guard (1...10000).contains(pixels) else {
                        throw WindowEventError.unavailable("--pixels must be 1–10000")
                    }
                    pageViewportObservation = nil
                } else {
                    let pages = workflowInteger("--pages", defaultValue: 1)
                    guard (1...20).contains(pages) else {
                        throw WindowEventError.unavailable("--pages must be 1–20")
                    }
                    let viewport = try pageViewport(point, pin: .element)
                    let axis: PageScrollAxis = ["left", "right"].contains(direction) ? .horizontal : .vertical
                    pixels = try pageScrollDistance(viewport: viewport.observed, axis: axis, pages: pages)
                    pageViewportObservation = viewport
                }
                let delta = Int32(pixels)
                let event = try factory.scroll(point: point, deltaX: direction == "left" ? delta : direction == "right" ? -delta : 0,
                                               deltaY: direction == "up" ? delta : direction == "down" ? -delta : 0)
                try dispatchAfterPresentation(present: {
                    ActionCursor.emit("scroll", point: point, background: background, target: rawCoords == nil ? "ax" : "pixel")
                }, validate: {
                try validateAfterFeedback()
                if let viewport = pageViewportObservation {
                    let refreshed = try pageViewport(point, pin: .element)
                    guard CFEqual(refreshed.element, viewport.element) else {
                        throw ScrollViewportError.changed
                    }
                    try validateScrollViewportUnchanged(expected: viewport.observed, current: refreshed.observed)
                }
                _ = try verifyPoint(point, pin: .element)
                try admitVisualAction()
                }, dispatch: { event.postToPid(pid) })
                Thread.sleep(forTimeInterval: 0.1)
            } else if action == "drag" {
                guard let destination = workflowArgument("--to") else {
                    throw WindowEventError.unavailable("drag requires --to x,y in the snapshot window")
                }
                let end = try parsePoint(destination)
                _ = try verifyPoint(end, pin: .window)
                let duration = Double(workflowArgument("--duration") ?? "0.3") ?? 0
                guard duration.isFinite, (0.1...5).contains(duration) else {
                    throw WindowEventError.unavailable("--duration must be 0.1–5 seconds")
                }
                let steps = max(10, Int(duration * 60))
                let points = (1...steps).map { step in
                    CGPoint(x: point.x + (end.x - point.x) * Double(step) / Double(steps),
                            y: point.y + (end.y - point.y) * Double(step) / Double(steps))
                }
                ActionCursor.emit("drag", point: point, background: background, target: rawCoords == nil ? "ax" : "pixel")
                try validateAfterFeedback()
                try factory.drag(start: point, points: points, stepDelay: duration / Double(steps),
                                 verify: {
                                     _ = try verifyPoint($0, pin: WindowEventFactory.dragVerifyTarget(point: $0, start: point))
                                     try admitVisualAction()
                                 }, post: {
                                     ActionCursor.emit("drag", point: $0.location, background: background, target: rawCoords == nil ? "ax" : "pixel", waitForPresentation: false)
                                     $0.postToPid(pid)
                                 })
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
                    _ = try verifyPoint(point, pin: .element)
                    let down = try factory.mouse(type: downType, point: point, clickCount: click)
                    let up = try factory.mouse(type: upType, point: point, clickCount: click)
                    if button == "middle" {
                        down.setIntegerValueField(.mouseEventButtonNumber, value: 2)
                        up.setIntegerValueField(.mouseEventButtonNumber, value: 2)
                    }
                    try dispatchAfterPresentation(present: {
                        ActionCursor.emit("click", point: point, background: background, target: rawCoords == nil ? "ax" : "pixel")
                    }, validate: {
                        if click == 1 { try validateAfterFeedback() }
                        _ = try verifyPoint(point, pin: .element)
                        try admitVisualAction()
                    }, dispatch: { down.postToPid(pid) })
                    Thread.sleep(forTimeInterval: 0.03)
                    up.postToPid(pid)
                    Thread.sleep(forTimeInterval: 0.03)
                }
            }
        } catch {
            workflowFailure(error)
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
                guard frontmostPid() == pid,
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
                try transaction.dispatchPaste {
                    if workflowFlag("--replace") {
                        guard let selectDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                              let selectUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                            throw WindowEventError.unavailable("could not allocate select-all keys")
                        }
                        selectDown.flags = .maskCommand
                        selectUp.flags = .maskCommand
                        selectDown.postToPid(pid)
                        Thread.sleep(forTimeInterval: 0.05)
                        selectUp.postToPid(pid)
                        Thread.sleep(forTimeInterval: 0.05)
                    }
                    down.postToPid(pid)
                    Thread.sleep(forTimeInterval: 0.05)
                    up.postToPid(pid)
                }
                // Keep the pasteboard available while the receiver consumes its queued shortcut.
                let replacement = workflowFlag("--replace")
                let readback = waitForPasteReadback(before: before, expected: replacement ? text : nil) {
                    axStringAttribute(element, "AXValue")
                }
                if replacement, readback != text {
                    throw WindowEventError.unavailable("paste replacement read-back differs; inspect before retrying")
                }
            }
            actionExtras["clipboardRestore"] = restoration
            actionOK = restoration != "restore-failed"
            if !actionOK {
                actionExtras["error"] = "paste dispatched but clipboard restoration failed; do not repeat the paste"
            }
        } catch {
            workflowFailure(error)
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
        let chord: NativeKeyChord
        do { chord = try NativeKeyChord(keys) } catch { workflowFailure(error) }
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: chord.code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: chord.code, keyDown: false) else {
            workflowFailure("could not allocate key events")
        }
        down.flags = chord.flags
        up.flags = chord.flags
        down.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.05)
        up.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.05)
    default:
        workflowFailure("unsupported action")
    }
    var payload: [String: Any] = ["ok": actionOK, "action": action, "element": elementIndex, "pid": pid, "windowId": window.id, "dispatchState": "dispatched", "frontmostChanged": frontmostPid() != startingFrontmost]
    if nonActivatingPanel {
        // Report it, so a caller reading the result knows the frontmost guard did not apply and
        // why, rather than wondering whether it was silently skipped.
        payload["nonActivatingPanel"] = true
    }

    payload.merge(actionExtras) { _, new in new }
    if workflowFlag("--refresh") {
        // Derive it from the result. workflowAfterState has three failure returns — the
        // window list changed, the tree never settled, or any other throw — and each one
        // yields `{ok: false}` with no new token. Hard-coding `false` told the agent its
        // token was still good, and SKILL.md teaches agents to key on exactly this field,
        // so the agent went on to reuse a token that no longer matched the tree.
        let after = workflowAfterState(appName: appName, pid: pid, launch: launch, window: window, token: token)
        let refreshed = (after["ok"] as? Bool) ?? false
        payload["refreshRequired"] = !refreshed
        payload["after"] = after

        if !refreshed {
            payload["note"] = "the refresh did not produce a new snapshot; run see again before acting"
        }
    } else {
        payload["refreshRequired"] = true
        payload["note"] = "action dispatched; use see to verify the resulting UI"
    }
    jsonOutput(payload)
    if !actionOK { exit(1) }
    }
    } catch {
        workflowFailure(error)
    }
}

private final class ControlNativeSession {
    let pid: pid_t
    let launch: Double
    var window: ObservedWindow?
    var root: AXUIElement?
    var role = ""
    var rootRole = ""
    var chrome = true
    var generation = 0
    var targets: [String: AXUIElement] = [:]
    let started = ProcessInfo.processInfo.systemUptime
    var actions = 0
    var lastTraversal: [String: Int] = [:]

    init(appName: String) {
        pid = resolveApp(appName)
        launch = workflowLaunch(pid)
    }

    func find(_ node: AXUIElement, role: String) throws -> [AXUIElement] {
        var count = 0
        var visited = SnapshotObjectSet()
        var matches: [AXUIElement] = []
        var roles: [String: Int] = [:]
        func walk(_ element: AXUIElement, depth: Int) throws {
            guard visited.insert(element) else { return }
            count += 1
            guard count <= 4000, depth <= 50 else { throw ObservedTreeError("scope exceeds traversal budget") }
            let actualRole = axStringAttribute(element, "AXRole") ?? ""
            roles[actualRole, default: 0] += 1
            if actualRole == role { matches.append(element) }
            if chrome && actualRole == "AXWebArea" { return }
            for child in axChildren(element) { try walk(child, depth: depth + 1) }
        }
        try walk(node, depth: 0)
        lastTraversal = roles
        return matches
    }

    func observe(_ input: [String: Any]) throws -> [String: Any] {
        guard let requestedRole = input["role"] as? String, requestedRole.hasPrefix("AX"),
              let requestedRoot = input["rootRole"] as? String, requestedRoot.hasPrefix("AX") else {
            throw ObservedTreeError("role and rootRole required")
        }
        chrome = (input["scope"] as? String ?? "chrome") == "chrome"
        let windows = axWindows(AXUIElementCreateApplication(pid))
        if let id = input["windowId"] as? Int {
            window = workflowWindowByID(id, pid: pid)
        } else {
            let index = input["windowIndex"] as? Int ?? 0
            guard windows.indices.contains(index) else { throw ObservedTreeError("window index unavailable") }
            window = workflowWindow(windows[index], pid: pid)
        }
        guard let window else { throw ObservedTreeError("window unavailable") }
        if input["focus"] as? Bool == true {
            guard bringFrontmost(pid), performActionWithTimeout(window.ax, action: "AXRaise", timeoutMs: 1000) == .success else {
                throw ObservedTreeError("could not focus requested window before observation")
            }
        }
        var liveWindow = workflowWindowByID(Int(window.id), pid: pid)
        var roots = try find(liveWindow.ax, role: requestedRoot)
        let readyDeadline = ProcessInfo.processInfo.systemUptime + 1
        while roots.isEmpty && ProcessInfo.processInfo.systemUptime < readyDeadline {
            Thread.sleep(forTimeInterval: 0.1)
            liveWindow = workflowWindowByID(Int(window.id), pid: pid)
            roots = try find(liveWindow.ax, role: requestedRoot)
        }
        self.window = liveWindow
        let rootIndex = input["rootIndex"] as? Int
        guard rootIndex != nil || roots.count == 1, roots.indices.contains(rootIndex ?? 0) else {
            throw ObservedTreeError("root role has \(roots.count) matches; observed roles: \(lastTraversal)")
        }
        let selectedRoot = roots[rootIndex ?? 0]
        root = selectedRoot; role = requestedRole; rootRole = requestedRoot
        let observed = try find(selectedRoot, role: requestedRole)
        guard observed.count <= 200 else { throw ObservedTreeError("more than 200 targets") }
        generation += 1
        targets.removeAll()
        var rows: [[String: Any]] = []
        for element in observed {
            guard axActionNames(element).contains("AXPress"), (axAttribute(element, "AXEnabled") as? Bool) != false else { continue }
            let id = "\(generation):\(rows.count)"
            targets[id] = element
            var row: [String: Any] = ["id": id, "role": requestedRole,
                "roleDescription": axStringAttribute(element, "AXRoleDescription") ?? "",
                "subrole": axStringAttribute(element, "AXSubrole") ?? "",
                "label": axStringAttribute(element, "AXTitle") ?? axStringAttribute(element, "AXDescription") ?? "",
                "selected": (axAttribute(element, "AXSelected") as? Bool) == true,
                "actions": ["press"]]
            if axAttributeNames(element).contains("AXExpanded") {
                row["expanded"] = axAttribute(element, "AXExpanded")
            }
            rows.append(row)
        }
        return ["ok": true, "pid": pid, "windowId": window.id, "scope": chrome ? "chrome" : "window",
                "rootRole": rootRole, "targets": rows]
    }

    func act(_ input: [String: Any]) throws -> [String: Any] {
        guard actions < 200, ProcessInfo.processInfo.systemUptime - started < 120,
              workflowLaunch(pid) == launch, let window, let root,
              let id = input["target"] as? String, let target = targets[id] else {
            throw ObservedTreeError("target reference, process lifetime or session budget invalid")
        }
        let liveWindow = workflowWindowByID(Int(window.id), pid: pid)
        let roots = try find(liveWindow.ax, role: rootRole)
        let retainedRoot = roots.first(where: { CFEqual($0, root) })
        let containingRoots = try roots.filter { try find($0, role: role).contains(where: { CFEqual($0, target) }) }
        guard let liveRoot = retainedRoot ?? (containingRoots.count == 1 ? containingRoots[0] : nil),
              try find(liveRoot, role: role).contains(where: { CFEqual($0, target) }) else {
            throw ObservedTreeError("observed target was replaced or left its window scope")
        }
        self.root = liveRoot
        guard (axAttribute(target, "AXEnabled") as? Bool) != false, axActionNames(target).contains("AXPress") else {
            throw ObservedTreeError("target became disabled or lost AXPress")
        }
        let attribute = input["verifyAttribute"] as? String
        let expected = input["verifyValue"] as? Bool
        if let attribute {
            guard ["AXSelected", "AXExpanded", "AXValue"].contains(attribute), expected != nil else {
                throw ObservedTreeError("verification requires AXSelected, AXExpanded or boolean AXValue")
            }
        }
        if input["focus"] as? Bool == true {
            guard bringFrontmost(pid), performActionWithTimeout(window.ax, action: "AXRaise", timeoutMs: 1000) == .success else {
                throw ObservedTreeError("could not focus requested window")
            }
        }
        actions += 1
        ActionCursor.element("press", target, background: frontmostPid() != pid)
        let code = performActionWithTimeout(target, action: "AXPress")
        guard code == .success else {
            return ["ok": false, "target": id, "dispatchState": "uncertain", "error": "AXPress failed or timed out; no retry"]
        }
        let deadline = ProcessInfo.processInfo.systemUptime + 0.6
        while let attribute, let expected, (axAttribute(target, attribute) as? Bool) != expected {
            guard ProcessInfo.processInfo.systemUptime < deadline else {
                return ["ok": false, "target": id, "dispatchState": "dispatched",
                        "error": "postcondition not observed; no retry"]
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return ["ok": true, "target": id, "dispatchState": "dispatched", "verified": attribute != nil]
    }

    func handle(_ input: [String: Any]) throws -> [String: Any] {
        switch input["op"] as? String {
        case "observe": return try observe(input)
        case "act": return try act(input)
        case "batch":
            guard let steps = input["steps"] as? [[String: Any]], !steps.isEmpty, steps.count <= 200 else {
                throw ObservedTreeError("batch requires 1–200 locally supplied actions")
            }
            let interval = input["intervalMs"] as? Int ?? 0
            guard interval >= 0, interval <= 5000 else { throw ObservedTreeError("interval outside 0–5000") }
            for step in steps {
                guard let target = step["target"] as? String, targets[target] != nil else {
                    throw ObservedTreeError("batch includes an unobserved target")
                }
            }
            var results: [[String: Any]] = []
            let start = ProcessInfo.processInfo.systemUptime
            for (index, step) in steps.enumerated() {
                let delay = start + Double(index * interval) / 1000 - ProcessInfo.processInfo.systemUptime
                if delay > 0 { Thread.sleep(forTimeInterval: delay) }
                var result: [String: Any]
                do { result = try act(step) }
                catch { result = ["ok": false, "dispatchState": "not_started", "error": error.localizedDescription] }
                result["atMs"] = (ProcessInfo.processInfo.systemUptime - start) * 1000
                results.append(result)
                if result["ok"] as? Bool != true { break }
            }
            return ["ok": results.count == steps.count && results.allSatisfy { $0["ok"] as? Bool == true },
                    "results": results, "elapsedMs": (ProcessInfo.processInfo.systemUptime - start) * 1000]
        default: throw ObservedTreeError("unknown session operation")
        }
    }
}

func cmdControlSession(appName: String) {
    workflowPermissions()
    let session = ControlNativeSession(appName: appName)
    DispatchQueue.global().asyncAfter(deadline: .now() + 125) { exit(0) }
    while let line = readLine() {
        guard line.utf8.count <= 65536, let data = line.data(using: .utf8),
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            jsonOutput(["ok": false, "dispatchState": "not_started", "error": "invalid session request"])
            continue
        }
        do { jsonOutput(try session.handle(input)) }
        catch { jsonOutput(["ok": false, "dispatchState": "not_started", "error": error.localizedDescription]) }
        fflush(stdout)
    }
}

private final class ObservationWake {
    var count = 0
}

func cmdWaitChange(appName: String) {
    workflowPermissions()
    guard let windowRaw = argValue("--window-id"), let windowID = Int(windowRaw), windowID > 0,
          windowID <= Int(UInt32.max), let timeoutRaw = argValue("--timeout-ms"), let timeout = Int(timeoutRaw),
          timeout >= 1, timeout <= 1000 else {
        workflowFailure("--window-id and --timeout-ms 1..1000 required")
    }
    let pid = resolveApp(appName)
    let window = workflowWindowByID(windowID, pid: pid)
    if let raw = argValue("--launch"), let expected = Double(raw), expected != workflowLaunch(pid) {
        workflowFailure("app instance changed before waiting")
    }
    let wake = ObservationWake()
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, _, _, pointer in
        guard let pointer else { return }
        let state = Unmanaged<ObservationWake>.fromOpaque(pointer).takeUnretainedValue()
        state.count += 1
        CFRunLoopStop(CFRunLoopGetCurrent())
    }
    guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
        jsonOutput(["ok": true, "supported": false, "events": 0])
        return
    }
    let context = Unmanaged.passUnretained(wake).toOpaque()
    let app = AXUIElementCreateApplication(pid)
    let notifications: [(AXUIElement, String)] = [
        (window.ax, "AXLayoutChanged"), (window.ax, "AXValueChanged"),
        (window.ax, "AXSelectedChildrenChanged"), (window.ax, "AXTitleChanged"),
        (window.ax, "AXUIElementDestroyed"), (app, "AXFocusedUIElementChanged")
    ]
    var registered: [(AXUIElement, String)] = []
    for (element, notification) in notifications {
        if AXObserverAddNotification(observer, element, notification as CFString, context) == .success {
            registered.append((element, notification))
        }
    }
    guard !registered.isEmpty else {
        jsonOutput(["ok": true, "supported": false, "events": 0])
        return
    }
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    defer {
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
        for (element, notification) in registered {
            _ = AXObserverRemoveNotification(observer, element, notification as CFString)
        }
    }
    _ = CFRunLoopRunInMode(.defaultMode, Double(timeout) / 1000, true)
    jsonOutput(["ok": true, "supported": true, "events": wake.count, "registrations": registered.count])
}
