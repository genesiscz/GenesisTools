import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Harness primitives (ported from Genesis scripts/ui/lib/axquery.swift)
//
// These four exist because a TEST needs different things from an operator tool.
// `tree` answers "what is there"; a sweep needs "where is it, is it enabled,
// which window owns it, is it actually on screen, and what does it look like".
// All are generic macOS AX capabilities with no Genesis knowledge in them.

/// Route a synthetic event to a specific PROCESS when `--to-pid` is given.
///
/// The default `.cghidEventTap` is the global HID tap: it goes to whatever app
/// owns the keyboard, which for an unattended agent means it can type into the
/// user's editor. `postToPid` cannot leave the target process. This is the
/// single most valuable thing to have available here.
extension CGEvent {
    func postRouted() {
        guard let raw = argValue("--to-pid") else {
            self.post(tap: .cghidEventTap)
            return
        }

        // A malformed --to-pid must NOT silently fall back to the global tap: the caller
        // asked for a contained delivery, and the fallback types into the frontmost app.
        guard let pid = pid_t(raw), pid > 0 else {
            errorExit("--to-pid must be a positive process id (got \"\(raw)\")")
        }

        self.postToPid(pid)
    }
}

/// `Int(someCGFloat)` TRAPS on NaN/infinite input, and AX hands out both for
/// detached or not-yet-laid-out elements. A whole-tree walk hits one eventually
/// — this crashed the original with SIGTRAP (exit 133) on its first real run.
func axPx(_ v: CGFloat) -> Int {
    guard v.isFinite else { return 0 }
    return Int(min(max(v.rounded(), -1_000_000), 1_000_000))
}

func axFrame(_ el: AXUIElement) -> CGRect {
    var pos = CGPoint.zero
    var size = CGSize.zero
    if let pv = axAttribute(el, kAXPositionAttribute as String), CFGetTypeID(pv) == AXValueGetTypeID() {
        AXValueGetValue(pv as! AXValue, .cgPoint, &pos)
    }
    if let sv = axAttribute(el, kAXSizeAttribute as String), CFGetTypeID(sv) == AXValueGetTypeID() {
        AXValueGetValue(sv as! AXValue, .cgSize, &size)
    }
    return CGRect(origin: pos, size: size)
}

func printJSON(_ object: Any, fallback: String) {
    if let data = try? JSONSerialization.data(withJSONObject: object),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    } else {
        print(fallback)
    }
}

/// Whole addressable surface in ONE process: flat elements with geometry,
/// enabled state, owning window and scroll-clip visibility.
///
/// `tree` returns nested id/role/title/value and no geometry at all, so no
/// geometric assertion can be written against it: do two controls overlap, is
/// a control outside its own window, did a container identifier swallow its
/// children (detectable by frame containment), is a labelled control actually
/// on screen. Flat + `win` index is what lets one call answer those.
func cmdDump(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    var windowDicts: [[String: Any]] = []
    var elementDicts: [[String: Any]] = []

    for (index, w) in axWindows(app).enumerated() {
        let wf = axFrame(w)
        windowDicts.append([
            "title": axStringAttribute(w, kAXTitleAttribute as String) ?? "",
            "x": axPx(wf.origin.x), "y": axPx(wf.origin.y),
            "w": axPx(wf.width), "h": axPx(wf.height),
        ])
        // Track the nearest AXScrollArea ancestor so a caller can tell a
        // genuinely visible element from one the scroll view is CLIPPING. AX
        // reports a row's full frame even when it is scrolled out of sight,
        // which made a geometry sweep report a footer "overlapping" the last
        // row's buttons — the row is not on screen there at all.
        func walkClipped(_ el: AXUIElement, clip: CGRect?, depth: Int = 0) {
            guard depth < 80 else { return }
            let role = axStringAttribute(el, kAXRoleAttribute as String) ?? ""
            let f = axFrame(el)
            var childClip = clip
            if role == "AXScrollArea" {
                childClip = clip.map { $0.intersection(f) } ?? f
            }
            let id = axStringAttribute(el, "AXIdentifier") ?? ""
            let title = axStringAttribute(el, kAXTitleAttribute as String) ?? ""
            let desc = axStringAttribute(el, kAXDescriptionAttribute as String) ?? ""
            let value = axStringAttribute(el, kAXValueAttribute as String) ?? ""
            if !(id.isEmpty && title.isEmpty && desc.isEmpty && value.isEmpty) {
                var enabled = true
                if let e = axAttribute(el, kAXEnabledAttribute as String) as? NSNumber { enabled = e.boolValue }
                // Visible = the element's centre lies inside every scroll clip
                // above it. Centre, not full containment, so a row straddling
                // the edge counts as visible while a fully scrolled-off one
                // does not.
                var visible = true
                if let c = clip, f.width > 0, f.height > 0 {
                    visible = c.contains(CGPoint(x: f.midX, y: f.midY))
                }
                elementDicts.append([
                    "id": id, "role": role,
                    "title": title, "desc": desc, "value": value,
                    "enabled": enabled, "visible": visible,
                    "x": axPx(f.origin.x), "y": axPx(f.origin.y),
                    "w": axPx(f.width), "h": axPx(f.height),
                    "win": index,
                ])
            }
            for c in axChildren(el) { walkClipped(c, clip: childClip, depth: depth + 1) }
        }
        walkClipped(w, clip: nil)
    }
    // Every response carries `ok` — src/control/lib/runner.ts parses stdout as AxResult
    // and reads a missing `ok` as a failure, so a bare payload here is unconsumable.
    printJSON(["ok": true, "windows": windowDicts, "elements": elementDicts],
              fallback: "{\"ok\":false,\"error\":\"dump serialization failed\"}")
}

/// Rendered font and colour for every static text, from
/// AXAttributedStringForRange. No screenshots, no OCR, no golden images.
///
/// This is how "is any label too small to read" and "is any text nearly
/// invisible" become assertable at all: the values are what the app ACTUALLY
/// rendered, theme and Dynamic Type included.
func cmdTypography(appName: String) {
    let pid = resolveApp(appName)
    let app = AXUIElementCreateApplication(pid)
    var out: [[String: Any]] = []

    func walk(_ el: AXUIElement, depth: Int = 0) {
        guard depth < 80 else { return }
        if axStringAttribute(el, kAXRoleAttribute as String) == "AXStaticText",
           let value = axStringAttribute(el, kAXValueAttribute as String), !value.isEmpty {
            // Do NOT gate on kAXNumberOfCharacters: SwiftUI text elements often
            // omit it while still answering the parameterized attribute, and
            // gating on it returned zero labels for an entire app.
            var range = CFRange(location: 0, length: 1)
            if let axRange = AXValueCreate(.cfRange, &range) {
                var attributed: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(
                    el, kAXAttributedStringForRangeParameterizedAttribute as CFString,
                    axRange, &attributed) == .success,
                    let text = attributed as? NSAttributedString, text.length > 0 {
                    let attrs = text.attributes(at: 0, effectiveRange: nil)
                    var fontName = ""
                    var fontSize = 0.0
                    if let fontInfo = attrs[NSAttributedString.Key("AXFont")] as? [String: Any] {
                        fontName = (fontInfo["AXFontName"] as? String) ?? ""
                        fontSize = (fontInfo["AXFontSize"] as? Double) ?? 0
                    }
                    // AX attributes arrive as CFTypeRef: `as!` here crashed the whole sweep
                    // whenever one app answered with something that was not a CGColor. And
                    // `components` is colour-space dependent (grayscale gives two), so the
                    // documented RGBA contract needs an explicit conversion, not raw values.
                    var rgba: [Double] = []
                    if let colorRef = attrs[NSAttributedString.Key("AXForegroundColor")],
                       CFGetTypeID(colorRef as CFTypeRef) == CGColor.typeID {
                        let cg = colorRef as! CGColor
                        if let srgb = CGColorSpace(name: CGColorSpace.sRGB),
                           let converted = cg.converted(to: srgb, intent: .defaultIntent, options: nil),
                           let comps = converted.components, comps.count == 4 {
                            rgba = comps.map { Double($0) }
                        }
                    }
                    out.append([
                        "value": String(value.prefix(80)),
                        "font": fontName, "size": fontSize, "rgba": rgba,
                    ])
                }
            }
        }
        for c in axChildren(el) { walk(c, depth: depth + 1) }
    }
    for w in axWindows(app) { walk(w) }
    printJSON(["ok": true, "typography": out],
              fallback: "{\"ok\":false,\"error\":\"typography serialization failed\"}")
}

/// Which element does the system actually deliver a click at this point to?
///
/// An id existing in the tree does NOT mean a user can reach it: a sheet, an
/// overlay or a sibling drawn on top swallows the click while every id
/// assertion still passes. Walks up to the nearest identified ancestor,
/// because SwiftUI leaves the id on the control while the click lands on an
/// inner text or image child.
func cmdHitTest(x: Double, y: Double) {
    let systemWide = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &hit) == .success,
          let hitEl = hit else { errorExit("no element at \(x),\(y)") }

    var cursor: AXUIElement? = hitEl
    var found = ""
    var role = ""
    var hops = 0
    while let c = cursor, hops < 8 {
        if role.isEmpty { role = axStringAttribute(c, kAXRoleAttribute as String) ?? "" }
        if let id = axStringAttribute(c, "AXIdentifier"), !id.isEmpty { found = id; break }
        cursor = axAttribute(c, kAXParentAttribute as String).map { $0 as! AXUIElement }
        hops += 1
    }
    jsonOutput(["ok": true, "x": x, "y": y, "axId": found, "role": role, "hops": hops])
}

/// On-screen windows front to back with their owners, so a caller can pick "the app the user is
/// looking at" while skipping its own terminal. Layer 0 only: the menu bar, the Dock and overlays
/// live on other layers. No AX tree is read; `frontmostPid()` is the WindowServer-truth front.
/// Bring an already-running app forward and report the pid that actually ended up frontmost, so a
/// caller can verify the switch instead of trusting the request. Never launches anything.
func cmdActivate() {
    guard let raw = argValue("--pid"), let pid = pid_t(raw) else {
        errorExit("--pid <n> required; read one from `ax-tool front` or `ax-tool apps`")
    }
    guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.processIdentifier == pid }) else {
        errorExit("no running application has pid \(pid)")
    }
    let name = app.localizedName ?? ""
    let ok = bringFrontmost(pid)
    var result: [String: Any] = ["ok": ok, "pid": Int(pid), "app": name]
    if let front = frontmostPid() { result["frontmostPid"] = Int(front) }
    if !ok {
        result["error"] = "activation did not take; \(name) is not frontmost"
    }
    jsonOutput(result)
}

func cmdFront() {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] ?? []
    var windows: [[String: Any]] = []
    for window in list {
        guard (window[kCGWindowLayer] as? Int) == 0, let pid = window[kCGWindowOwnerPID] as? Int32 else { continue }
        var entry: [String: Any] = ["pid": Int(pid), "app": (window[kCGWindowOwnerName] as? String) ?? ""]
        if let id = window[kCGWindowNumber] as? Int { entry["windowId"] = id }
        if let title = window[kCGWindowName] as? String, !title.isEmpty { entry["title"] = title }
        if let bounds = window[kCGWindowBounds] as? [String: Any] {
            entry["bounds"] = ["x": bounds["X"] ?? 0, "y": bounds["Y"] ?? 0, "width": bounds["Width"] ?? 0, "height": bounds["Height"] ?? 0]
        }
        windows.append(entry)
    }
    var result: [String: Any] = ["ok": true, "count": windows.count, "windows": windows]
    if let front = frontmostPid() { result["frontmostPid"] = Int(front) }
    jsonOutput(result)
}
