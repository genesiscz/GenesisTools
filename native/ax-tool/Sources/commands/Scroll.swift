import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

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
            ActionCursor.element("scroll", el, background: frontmostPid() != pid)
            let err = performActionWithTimeout(el, action: "AXScrollToVisible", timeoutMs: 3000)
            if err != .success { errorExit("AXScrollToVisible failed: AXError \(err.rawValue)") }
            var result: [String: Any] = ["ok": true, "action": "scroll", "method": "AXScrollToVisible"]
            result.merge(elementInfo(el)) { _, new in new }
            jsonOutput(result)
            return
        }
        errorExit("element does not support AXScrollToVisible — use --direction with wheel scrolling instead")
    }

    guard ["up", "down", "left", "right"].contains(direction!) else {
        errorExit("--direction must be up, down, left, or right")
    }
    let vertical = direction == "up" || direction == "down"
    // Up and left are positive wheel deltas.
    let towardStart = direction == "up" || direction == "left"

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
    guard let point else { errorExit("no window of \(appName) to scroll in; pass --coords or a target") }

    // Distance: --pixels, else --amount wheel lines at 40 px each (what a wheel click scrolls in WebKit).
    let pixels = argValue("--pixels").flatMap { Int($0) } ?? amount * 40
    guard (1...100_000).contains(pixels) else { errorExit("--pixels must be 1–100000") }
    let seconds = argValue("--time").flatMap { Double($0) }
    if let seconds, !(0.05...30).contains(seconds) { errorExit("--time must be 0.05–30 seconds") }
    let ease = ScrollEase(rawValue: argValue("--ease") ?? "flick") ?? {
        errorExit("--ease must be \(ScrollEase.allCases.map(\.rawValue).joined(separator: " or "))")
    }()
    let repeats = argValue("--repeat").flatMap { Int($0) } ?? 1
    guard (1...200).contains(repeats) else { errorExit("--repeat must be 1–200") }
    let pause = argValue("--pause").flatMap { Double($0) } ?? 0.3
    guard (0...30).contains(pause) else { errorExit("--pause must be 0–30 seconds") }
    let alternate = args.contains("--alternate")
    let foreground = args.contains("--foreground")

    // Window-addressed events go to the process and need no focus: the old path brought the app
    // frontmost first and took the user's keyboard away mid-work (Martin, 2026-10-08). `--foreground`
    // keeps that path for an app that ignores events addressed to a background window.
    var factory: WindowEventFactory? = nil
    if foreground {
        if !bringFrontmost(pid) {
            errorExit("could not bring \(appName) frontmost for --foreground")
        }
        Thread.sleep(forTimeInterval: 0.08)
    } else {
        guard let (windowID, bounds) = windowAt(point, pid: pid) else {
            errorExit("no on-screen window of \(appName) contains \(Int(point.x)),\(Int(point.y)); pass --coords inside it, or --foreground")
        }
        factory = gatedOrExit { try WindowEventFactory(windowID: windowID, bounds: bounds) }
    }

    ActionCursor.emit("scroll", point: point, background: !foreground, target: hasTarget ? "ax" : "pixel")
    let count = ScrollMotion.eventCount(seconds: seconds)
    let interval = (seconds ?? 0) / Double(count)
    var sent = 0
    for round in 0..<repeats {
        if round > 0 {
            Thread.sleep(forTimeInterval: pause)
        }
        let flipped = alternate && round % 2 == 1
        let sign = (towardStart != flipped) ? 1 : -1
        let deltas = ScrollMotion.deltas(total: sign * pixels, count: count, ease: ease)
        for (index, delta) in deltas.enumerated() {
            if index > 0, interval > 0 {
                Thread.sleep(forTimeInterval: interval)
            }
            let dy = vertical ? delta : 0
            let dx = vertical ? 0 : delta
            let event: CGEvent
            if let factory {
                event = gatedOrExit { try factory.scroll(point: point, deltaX: dx, deltaY: dy) }
            } else {
                guard let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                                       wheel1: dy, wheel2: dx, wheel3: 0) else {
                    errorExit("failed to create scroll event")
                }
                ev.location = point
                event = ev
            }
            // Trackpad-like: continuous pixel deltas with began / changed / ended phases, so a page treats
            // the run as one gesture the way it treats a real flick.
            event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
            event.setIntegerValueField(.scrollWheelEventScrollPhase, value: ScrollMotion.phase(index: index, count: deltas.count))
            if factory != nil {
                gatedOrExit { try inputGate.post { event.postToPid(pid) } }
            } else {
                event.postRouted()
            }
            sent += 1
        }
    }

    var result: [String: Any] = ["ok": true, "action": "scroll", "method": foreground ? "wheel-foreground" : "wheel-window",
                                  "direction": direction!, "amount": amount, "pixels": pixels, "events": sent,
                                  "repeat": repeats, "ease": ease.rawValue, "x": point.x, "y": point.y]
    if let seconds { result["time"] = seconds }
    if alternate { result["alternate"] = true }
    if let el = el { result.merge(elementInfo(el)) { _, new in new } }
    jsonOutput(result)
}

/// The front-most normal window of `pid` that contains `point`, with its CG window id and bounds.
private func windowAt(_ point: CGPoint, pid: pid_t) -> (Int, CGRect)? {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for info in list {
        guard (info[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid,
              (info[kCGWindowLayer as String] as? Int) == 0,
              let id = info[kCGWindowNumber as String] as? Int,
              let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw),
              bounds.contains(point) else { continue }
        return (id, bounds)
    }
    return nil
}
