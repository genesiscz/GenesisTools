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
        ActionCursor.emit("click", point: point, target: "pixel")
        down.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(i + 1))
        down.postRouted()
        Thread.sleep(forTimeInterval: 0.03)
        up.postRouted()
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
        down.postRouted()
        up.postRouted()
        Thread.sleep(forTimeInterval: delayMs / 1000)
    }
}

func tapKey(_ code: UInt16, flags: CGEventFlags = []) {
    let src = CGEventSource(stateID: .hidSystemState)
    guard let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
          let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else { return }
    d.flags = flags; u.flags = flags
    d.postRouted(); u.postRouted()
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

    if let targetEl { ActionCursor.element("type", targetEl) }
    else { ActionCursor.emit("type", point: nil, target: "desktop") }
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
