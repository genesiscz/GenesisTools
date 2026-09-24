import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

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
    let windowIDScope: CGWindowID? = argValue("--window-id").map {
        guard let parsed = CGWindowID($0), parsed > 0 else {
            errorExit("--window-id must be a positive integer")
        }

        return parsed
    }
    if windowScope != nil && windowIDScope != nil {
        errorExit("choose --window or --window-id, not both")
    }

    let windowList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] ?? []
    let appWindows = windowList.filter { ($0[kCGWindowOwnerPID] as? Int32) == pid }
    let windowName = { (w: [CFString: Any]) -> String in (w[kCGWindowName] as? String) ?? "(untitled)" }
    let windowArea = { (w: [CFString: Any]) -> Double in
        let b = w[kCGWindowBounds] as? [String: Any]
        let width = (b?["Width"] as? Double) ?? 0
        let height = (b?["Height"] as? Double) ?? 0
        return width * height
    }

    // AX window titles keyed by frame — CG titles can be shorter than AX
    // titles (Brave drops the " - Brave - Main" suffix in CGWindowName), so a
    // substring copied from `window` output must still match here.
    let axApp = AXUIElementCreateApplication(pid)
    let axTitlesByFrame: [(frame: CGRect, title: String)] = axWindows(axApp).compactMap { w in
        guard let pos = axPointValue(w, "AXPosition"), let size = axSizeValue(w, "AXSize"),
              let t = axStringAttribute(w, "AXTitle"), !t.isEmpty else { return nil }
        return (CGRect(x: pos.x, y: pos.y, width: size.width, height: size.height), t)
    }
    let axTitleFor = { (w: [CFString: Any]) -> String? in
        guard let b = w[kCGWindowBounds] as? [String: Any],
              let x = b["X"] as? Double, let y = b["Y"] as? Double,
              let width = b["Width"] as? Double, let height = b["Height"] as? Double else { return nil }
        return axTitlesByFrame.first {
            abs($0.frame.origin.x - x) < 6 && abs($0.frame.origin.y - y) < 6 &&
            abs($0.frame.width - width) < 6 && abs($0.frame.height - height) < 6
        }?.title
    }

    var targetWindow: [CFString: Any]? = nil
    if let idScope = windowIDScope {
        // `see` reports kCGWindowNumber as its windowId, so the same number addresses a window
        // here. Two windows sharing a title are unreachable by --window and reachable by this.
        let matches = appWindows.filter { ($0[kCGWindowNumber] as? CGWindowID) == idScope }
        guard matches.count == 1 else {
            jsonOutput(["ok": false,
                "error": "no window with id \(idScope) in \(appName)",
                "candidates": appWindows.map { axTitleFor($0) ?? windowName($0) },
                "windowIds": appWindows.compactMap { $0[kCGWindowNumber] as? CGWindowID }])
            exit(1)
        }
        targetWindow = matches[0]
    } else if let ws = windowScope {
        // Fail loud on 0 or >1 matches — a substring miss must never silently
        // capture a different window (the "Find in page popup as Brave-Main" bug).
        let matches = appWindows.filter { w in
            windowName(w).localizedCaseInsensitiveContains(ws) ||
            (axTitleFor(w)?.localizedCaseInsensitiveContains(ws) ?? false)
        }
        if matches.isEmpty {
            jsonOutput(["ok": false,
                "error": "no window matching '\(ws)' in \(appName)",
                "candidates": appWindows.map { axTitleFor($0) ?? windowName($0) }])
            exit(1)
        }
        if matches.count > 1 {
            jsonOutput(["ok": false,
                "error": "ambiguous: '\(ws)' matches \(matches.count) windows in \(appName) — use a longer substring, or --window-id <id> when the titles are identical",
                "candidates": matches.map { windowName($0) },
                "windowIds": matches.compactMap { $0[kCGWindowNumber] as? CGWindowID }])
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
    // Only an UNSCOPED capture is picked by area. Saying "largest-area" after the caller named
    // a title or an id reports a guess where there was an exact choice.
    if !others.isEmpty && argValue("--window") == nil && argValue("--window-id") == nil {
        result["otherWindows"] = others
        result["pickedBy"] = "largest-area (pass --window <title> or --window-id <id> to target another)"
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
