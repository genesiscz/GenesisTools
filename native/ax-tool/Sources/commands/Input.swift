import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Input Commands (focus, click, type)

func cmdFocus(appName: String) {
    let pid = resolveApp(appName)
    // `--no-activate`: set AXFocused WITHOUT raising the app.
    //
    // Activating is right for an operator tool — you asked it to focus
    // something and you are watching. It is wrong for anything running while
    // the user works: this call was the single largest source of stolen
    // windows in an automated run, because focusing an element does not
    // actually require owning the keyboard.
    let noActivate = args.contains("--no-activate")
    if !noActivate {
        _ = bringFrontmost(pid)
    }

    let app = AXUIElementCreateApplication(pid)
    let hasTarget = argValue("--id") != nil || argValue("--role") != nil ||
                    argValue("--title") != nil || argValue("--desc") != nil

    if hasTarget {
        let el = resolveElement(app, appName)
        AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, true as CFTypeRef)
        ActionCursor.element("focus", el, background: noActivate)
        var result: [String: Any] = ["ok": true, "action": "focus"]
        result.merge(elementInfo(el)) { _, new in new }
        jsonOutput(result)
    } else {
        // AXRaise pulls the window forward just as surely as activating does, so the
        // no-target form has to honour --no-activate too or the flag's promise is empty.
        if !noActivate, let w = axWindows(app).first {
            ActionCursor.element("focus", w)
            let _ = performActionWithTimeout(w, action: kAXRaiseAction as String, timeoutMs: 2000)
        }
        jsonOutput(["ok": true, "action": "focus", "app": appName, "raised": !noActivate])
    }
}

func raiseElementWindow(_ el: AXUIElement) {
    var cur = el
    // Capped at 50 hops like the other ancestor climbs. Without a cap an element whose AXWindow
    // answers with something that is not a window and names itself as its own parent spins this
    // loop at 100% of a core, with no syscall to yield on, until the caller's 10 s kill lands.
    for _ in 0..<50 {
        guard let p = axAttribute(cur, "AXWindow") ?? axAttribute(cur, "AXParent") else { return }
        guard CFGetTypeID(p) == AXUIElementGetTypeID() else { return }
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
        ActionCursor.emit("click", point: point, target: "pixel", button: right ? "right" : nil, clickCount: count)
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        let held = down.pressRouted(release: up)
        Thread.sleep(forTimeInterval: 0.03)
        inputGate.release(held)
        if double && i == 0 { Thread.sleep(forTimeInterval: 0.03) }
    }
}

func cmdClick(appName: String) {
    let pid = resolveApp(appName)
    let right = args.contains("--right")
    let double = args.contains("--double")

    // 🛑 A right-click opens a context menu, which needs neither the app in front nor the real
    // pointer. This path used to activate the app, raise its window and post at the global HID tap,
    // which moves the user's pointer: every agent that opened a menu took the user's focus.
    if right {
        backgroundRightClick(appName: appName, pid: pid, double: double)
        return
    }

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

/// The front-most on-screen window of `pid` that contains `point`, in CG global coordinates.
func windowOwning(pid: pid_t, point: CGPoint) -> (id: Int, bounds: CGRect)? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[CFString: Any]] ?? []
    for window in list {
        guard (window[kCGWindowOwnerPID] as? Int32) == pid, (window[kCGWindowLayer] as? Int) == 0,
              let id = window[kCGWindowNumber] as? Int,
              let raw = window[kCGWindowBounds] as? [String: Any],
              let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary),
              bounds.contains(point) else { continue }
        return (id, bounds)
    }
    return nil
}

/// Right mouse down and up, addressed to one window of `pid`. The events never pass the global HID
/// tap, so the pointer stays where the user left it and no app is activated by us.
func postBackgroundRightClick(pid: pid_t, window: (id: Int, bounds: CGRect), point: CGPoint, double: Bool) {
    let factory: WindowEventFactory
    do { factory = try WindowEventFactory(windowID: window.id, bounds: window.bounds) } catch { errorExit(error.localizedDescription) }
    for click in 1...(double ? 2 : 1) {
        let down: CGEvent
        let up: CGEvent
        do {
            down = try factory.mouse(type: .rightMouseDown, point: point, clickCount: click)
            up = try factory.mouse(type: .rightMouseUp, point: point, clickCount: click)
        } catch { errorExit(error.localizedDescription) }
        let held = gatedOrExit { try inputGate.press({ down.postToPid(pid) }, release: { up.postToPid(pid) }) }
        Thread.sleep(forTimeInterval: 0.03)
        inputGate.release(held)
        Thread.sleep(forTimeInterval: 0.03)
    }
}

/// The app macOS shows as active (its menu bar), after letting NSWorkspace take in pending changes.
///
/// Not `frontmostPid()`: that asks Accessibility for the FOCUSED application, and an open context
/// menu holds keyboard focus for its own app while it shows, although that app is not activated.
/// Read that way, every right-click that opened a menu looked like an activation (measured
/// 2026-10-13), and handing the front back closed the menu the click had just opened.
func activeApplicationPid() -> pid_t? {
    CFRunLoopRunInMode(.defaultMode, 0.05, false)
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

/// A right-click must leave the user's app in front. Nothing here activates the target, but an app
/// may still bring itself forward from its own menu handler; then the front goes back to the app
/// the user had, and the result says so. `before` is the active pid read before the click.
///
/// While the menu is open it takes the keyboard (that is what a context menu is), so the result
/// reports `menuHoldsKeyboard` when the target holds focus without being active.
func secondaryClickFrontGuard(before: pid_t?, target: pid_t) -> [String: Any] {
    guard let before, before != target else {
        return [:]
    }

    guard activeApplicationPid() == target else {
        return ["frontmostRestored": false, "menuHoldsKeyboard": frontmostPid() == target]
    }

    let restored = bringFrontmost(before)
    let name = NSRunningApplication(processIdentifier: before)?.localizedName ?? "pid \(before)"
    return ["frontmostRestored": restored,
            "focusNote": restored
                ? "the target brought itself to the front after the right-click; \(name) was put back in front"
                : "the target brought itself to the front after the right-click and \(name) could not be put back"]
}

/// `click --right`: AXShowMenu on the element when it offers one, else a right click addressed to the
/// element's window. Never activates, never raises, never moves the pointer.
func backgroundRightClick(appName: String, pid: pid_t, double: Bool) {
    let frontBefore = activeApplicationPid()
    let pointerBefore = CGEvent(source: nil)?.location
    var result: [String: Any] = ["ok": true, "action": "click", "right": true, "double": double, "activated": false]

    if let coordStr = argValue("--coords") {
        let parts = coordStr.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 2 else { errorExit("--coords format: x,y") }
        let point = CGPoint(x: parts[0], y: parts[1])
        guard let window = windowOwning(pid: pid, point: point) else {
            errorExit("no on-screen window of \(appName) contains \(parts[0]),\(parts[1]); a right-click is delivered to one of the app's own windows, never to whatever is on top")
        }
        ActionCursor.describe(pid: pid)
        ActionCursor.emit("click", point: point, background: true, target: "pixel", button: "right",
                          clickCount: double ? 2 : 1)
        postBackgroundRightClick(pid: pid, window: window, point: point, double: double)
        result["x"] = parts[0]
        result["y"] = parts[1]
        result["delivery"] = "window-event"
    } else {
        let el = resolveElement(AXUIElementCreateApplication(pid), appName)
        result.merge(elementInfo(el)) { _, new in new }
        ActionCursor.describe(el)
        let center: CGPoint? = {
            guard let pos = axPointValue(el, "AXPosition"), let size = axSizeValue(el, "AXSize"),
                  size.width > 0, size.height > 0 else { return nil }
            return CGPoint(x: pos.x + size.width / 2, y: pos.y + size.height / 2)
        }()
        if let center {
            result["x"] = center.x
            result["y"] = center.y
        }
        if !double, axActionNames(el).contains("AXShowMenu") {
            // The semantic form: the element opens its own context menu, no event and no pointer.
            ActionCursor.emit("showmenu", point: center, background: true, button: "right")
            // A context menu holds the AX call until it closes; a timeout means the menu is open.
            let error = performActionWithTimeout(el, action: "AXShowMenu", timeoutMs: 600)
            guard error == .success else {
                // The target may have activated itself before the AX error came back, so the front goes
                // back first, as it does after a successful right-click.
                var failure: [String: Any] = ["ok": false, "error": "AXShowMenu failed (AX \(error.rawValue)); a menu may or may not be open, inspect before retrying"]
                failure.merge(secondaryClickFrontGuard(before: frontBefore, target: pid)) { _, new in new }
                jsonOutput(failure)
                exit(1)
            }
            result["delivery"] = "AXShowMenu"
        } else {
            guard let center, let window = windowOwning(pid: pid, point: center) else {
                errorExit("the element offers no AXShowMenu and is not inside an on-screen window of \(appName); scroll it into view, or use act with a fresh see")
            }
            ActionCursor.emit("click", point: center, background: true, button: "right", clickCount: double ? 2 : 1)
            postBackgroundRightClick(pid: pid, window: window, point: center, double: double)
            result["delivery"] = "window-event"
        }
    }

    // Long enough for an app that activates itself from its menu handler to have done it.
    Thread.sleep(forTimeInterval: 0.12)
    result.merge(secondaryClickFrontGuard(before: frontBefore, target: pid)) { _, new in new }
    if let pointerBefore, let pointerAfter = CGEvent(source: nil)?.location {
        result["pointerMoved"] = hypot(pointerAfter.x - pointerBefore.x, pointerAfter.y - pointerBefore.y) > 0.5
    }
    jsonOutput(result)
}

/// Types while `pid` holds the front (always, when the keys are routed with --to-pid) and stops
/// the moment another app takes it, so the rest of the text cannot land there. Returns how many
/// characters were posted.
@discardableResult
func typeString(_ text: String, delayMs: Double, pid: pid_t? = nil) -> Int {
    let src = CGEventSource(stateID: .hidSystemState)
    let routedToPid = argValue("--to-pid") != nil
    return postWhileFrontmost(Array(text), isTargetFront: { routedToPid || pid.map { frontmostPid() == $0 } ?? true }) { char in
        var chars = Array(String(char).utf16)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { return }
        down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
        // Checked before every character, so a takeover mid-text stops at the next one.
        inputGate.release(down.pressRouted(release: up))
        Thread.sleep(forTimeInterval: delayMs / 1000)
    }
}

func tapKey(_ code: UInt16, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return }
    d.flags = flags; u.flags = flags
    inputGate.release(d.pressRouted(release: u))
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
        let posted = typeString(text, delayMs: delayMs, pid: pid)
        if posted < text.count {
            jsonOutput(["ok": false, "dispatched": posted > 0, "posted": posted, "length": text.count,
                        "error": "\(frontmostDescription()) took the front after \(posted) of \(text.count) characters; typing stopped so the rest could not land there. Inspect both apps before typing again"])
            exit(1)
        }
    }

    if let targetEl { ActionCursor.element("type", targetEl) }
    else { ActionCursor.emit("type", point: nil, target: "desktop") }
    let beforeValue = targetEl.flatMap { axAttribute($0, "AXValue").map { "\($0)" } }
    // Without a target the keys go to whatever holds focus, so that element is what gets read back.
    let focusedBefore: AXUIElement? = targetEl == nil
        ? axAttribute(app, "AXFocusedUIElement").flatMap { CFGetTypeID($0) == AXUIElementGetTypeID() ? ($0 as! AXUIElement) : nil }
        : nil
    let focusedBeforeValue = focusedBefore.flatMap { axAttribute($0, "AXValue").map { "\($0)" } }
    let frontmostAtPost = frontmostPid()
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
    } else {
        Thread.sleep(forTimeInterval: 0.25)
        let posted = args.contains("--to-pid") ? "posted to pid \(argValue("--to-pid") ?? "?")"
            : "posted to the global keyboard tap while pid \(frontmostAtPost ?? -1) was frontmost"
        let focusDescription = focusedBefore.map { element -> String in
            let role = axStringAttribute(element, "AXRole") ?? "element"
            let label = [axStringAttribute(element, "AXTitle"), axStringAttribute(element, "AXDescription")]
                .compactMap { $0 }.first { !$0.isEmpty }
            return label.map { "\(role) \"\(String($0.prefix(60)))\"" } ?? role
        }
        let after = focusedBefore.flatMap { axAttribute($0, "AXValue").map { "\($0)" } }
        if let focusDescription { result["focused"] = focusDescription }
        switch typedTextVerdict(element: focusDescription, before: focusedBeforeValue, after: after, text: text, replace: doClear) {
        case .verified:
            result["verified"] = true
        case .unverifiable(let reason):
            result["verified"] = false
            result["warning"] = "\(reason), so nothing verified where the keystrokes went (\(posted)). Target the field with --id/--role/--q so it can be read back"
        case .notLanded:
            jsonOutput(["ok": false, "dispatched": true, "verified": false, "focused": focusDescription ?? "",
                "error": "the keystrokes did not land in the focused \(focusDescription ?? "element") (its value is unchanged); where they went is unknown (\(posted)). "
                    + "An open or save panel runs out of process and can drop typed text: put the text on the clipboard and send hotkey cmd,v instead"])
            exit(1)
        case .different(let value):
            jsonOutput(["ok": false, "dispatched": true, "verified": false, "focused": focusDescription ?? "",
                "fieldValue": value, "expected": text,
                "error": "the focused \(focusDescription ?? "element") changed but does not hold the typed text; inspect it before typing again"])
            exit(1)
        }
    }

    // Keys that were sent but not read back are not a success: the status says UNVERIFIED (exit 2),
    // and a --return after text nobody saw land is not sent at all.
    if result["verified"] as? Bool != true {
        result["ok"] = false
        result["unverified"] = true
        result["dispatched"] = true
        let reason = result["warning"] as? String ?? "nothing read the text back"
        result["error"] = "UNVERIFIED: \(reason)" + (doReturn ? "; --return was not sent" : "")
        jsonOutput(result)
        exit(2)
    }

    if doReturn {
        Thread.sleep(forTimeInterval: 0.03)
        tapKey(36)  // Return
    }

    jsonOutput(result)
}
