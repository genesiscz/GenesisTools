import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

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
        errorExit("could not create event tap — grant Accessibility + Input Monitoring to GenesisTools.app")
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
