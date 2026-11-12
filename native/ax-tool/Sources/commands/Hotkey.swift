import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Hotkey

func cmdHotkey(keys: String) {
    // Optional --app: activate the target first so the combo lands there
    // instead of whatever happens to have OS keyboard focus.
    var targetPid: pid_t?
    if let appTarget = argValue("--app") {
        let pid = resolveApp(appTarget)
        if !bringFrontmost(pid) {
            errorExit("could not bring \(appTarget) frontmost — refusing to send keys to the wrong app")
        }
        targetPid = pid
    }
    let chord: NativeKeyChord
    do { chord = try NativeKeyChord.forCurrentKeyboardLayout(keys) } catch { errorExit(error.localizedDescription) }

    ActionCursor.emit("hotkey", point: nil, target: "desktop")
    let holdMs = Double(argValue("--hold") ?? "50") ?? 50

    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: chord.code, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: chord.code, keyDown: false) else {
        errorExit("failed to create CGEvent")
    }
    down.flags = chord.flags
    up.flags = chord.flags
    // The cursor feedback above can take a glide; check the front again at the moment of posting,
    // because a global-tap combo lands in whatever app holds the front by then.
    let routedToPid = argValue("--to-pid") != nil
    var held: SyntheticInputGate.Held?
    let posted = postWhileFrontmost([down], isTargetFront: { routedToPid || targetPid.map { frontmostPid() == $0 } ?? true },
                                    post: { held = $0.pressRouted(release: up) })
    guard posted == 1, let held else {
        errorExit("\(frontmostDescription()) took the front before the combo was sent; nothing was posted")
    }
    Thread.sleep(forTimeInterval: holdMs / 1000)
    inputGate.release(held)

    jsonOutput(["ok": true, "action": "hotkey", "keys": keys])
}
