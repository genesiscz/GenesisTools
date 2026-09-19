import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

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

    ActionCursor.element("set", element, background: frontmostPid() != pid)
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

    ActionCursor.element("press", element, background: frontmostPid() != pid)
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
    let windows = axWindowsOrExit(app, appName)

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
