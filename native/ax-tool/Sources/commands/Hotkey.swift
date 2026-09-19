import ApplicationServices
import AppKit
import CoreText
import Foundation
import SnapshotSupport
import Vision

// MARK: - Hotkey

let KEY_MAP: [String: UInt16] = [
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4,
    "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35,
    "q": 12, "r": 15, "s": 1, "t": 17, "u": 32, "v": 9, "w": 13, "x": 7,
    "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26,
    "8": 28, "9": 25,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "escape": 53, "esc": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "arrow_up": 126, "arrow_down": 125, "arrow_left": 123, "arrow_right": 124,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "-": 27, "=": 24, "[": 33, "]": 30, "\\": 42, ";": 41, "'": 39,
    ",": 43, ".": 47, "/": 44, "`": 50,
]

func cmdHotkey(keys: String) {
    // Optional --app: activate the target first so the combo lands there
    // instead of whatever happens to have OS keyboard focus.
    if let appTarget = argValue("--app") {
        let pid = resolveApp(appTarget)
        if !bringFrontmost(pid) {
            errorExit("could not bring \(appTarget) frontmost — refusing to send keys to the wrong app")
        }
    }
    let parts = keys.lowercased().split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
    var flags: CGEventFlags = []
    var keyCode: UInt16 = 0
    var foundKey = false

    for part in parts {
        switch part {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default:
            if let code = KEY_MAP[part] {
                keyCode = code
                foundKey = true
            } else {
                errorExit("unknown key: \(part). Use: a-z, 0-9, return, tab, space, escape, delete, up/down/left/right, f1-f12, or modifiers cmd/shift/alt/ctrl/fn")
            }
        }
    }

    if !foundKey {
        errorExit("no key specified — only modifiers given. Add a key: e.g. cmd,a")
    }

    ActionCursor.emit("hotkey", point: nil, target: "desktop")
    let holdMs = Double(argValue("--hold") ?? "50") ?? 50

    let src = CGEventSource(stateID: .hidSystemState)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false) else {
        errorExit("failed to create CGEvent")
    }
    down.flags = flags
    up.flags = flags
    down.postRouted()
    Thread.sleep(forTimeInterval: holdMs / 1000)
    up.postRouted()

    jsonOutput(["ok": true, "action": "hotkey", "keys": keys])
}
