import CoreGraphics
import Foundation

public struct NativeKeyChord {
    public let code: CGKeyCode
    public let flags: CGEventFlags

    public init(_ raw: String) throws {
        var flags: CGEventFlags = []
        var resolved: CGKeyCode?
        for key in Self.parts(raw) {
            switch key {
            case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            case "fn": flags.insert(.maskSecondaryFn)
            default:
                guard resolved == nil, let code = Self.codes[key] else {
                    throw WorkflowArgumentError.invalid("key requires exactly one supported key with optional modifiers; use named punctuation keys")
                }
                resolved = code
            }
        }
        guard let code = resolved else {
            throw WorkflowArgumentError.invalid("key requires a non-modifier key")
        }
        self.code = code
        self.flags = flags
    }

    /// Modifiers alone, for a click: `cmd,alt` or `shift+ctrl`. A key name is refused, so a typo
    /// cannot turn a click into a keystroke.
    public static func modifiers(_ raw: String) throws -> CGEventFlags {
        var flags: CGEventFlags = []
        for part in Self.parts(raw) {
            switch part {
            case "cmd", "command", "super", "meta": flags.insert(.maskCommand)
            case "ctrl", "control": flags.insert(.maskControl)
            case "alt", "option", "opt": flags.insert(.maskAlternate)
            case "shift": flags.insert(.maskShift)
            default:
                throw WorkflowArgumentError.invalid("--modifiers takes cmd, ctrl, alt and shift only")
            }
        }
        return flags
    }

    /// The parts of a chord as `init` reads them: split at commas and plus signs, trimmed, lowercased.
    public static func parts(_ raw: String) -> [String] {
        raw.lowercased().components(separatedBy: CharacterSet(charactersIn: ",+"))
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// True for a modifier or a key that types no character (tab, return, an arrow, F1). Every other
    /// supported key types one, so the cursor label for a password field hides it.
    public static func typesNoCharacter(_ part: String) -> Bool {
        ["cmd", "command", "super", "meta", "ctrl", "control", "alt", "option", "opt", "shift", "fn"].contains(part)
            || nonPrintingKeys.contains(part)
    }

    static let nonPrintingKeys: Set<String> = [
        "return", "enter", "tab", "backspace", "delete", "escape", "esc",
        "left", "right", "down", "up", "arrow_left", "arrow_right", "arrow_down", "arrow_up",
        "home", "end", "pageup", "page_up", "prior", "pagedown", "page_down", "next",
        "forwarddelete", "delete_forward", "help", "insert", "kp_enter", "kp_clear", "clear",
        "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10",
        "f11", "f12", "f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20",
    ]

    private static let codes: [String: CGKeyCode] = [
        "a":0, "s":1, "d":2, "f":3, "h":4, "g":5, "z":6, "x":7, "c":8, "v":9, "b":11,
        "q":12, "w":13, "e":14, "r":15, "y":16, "t":17, "1":18, "2":19, "3":20, "4":21, "6":22,
        "5":23, "9":25, "7":26, "8":28, "0":29, "o":31, "u":32, "i":34, "p":35, "l":37, "j":38,
        "k":40, "n":45, "m":46,
        "return":36, "enter":36, "tab":48, "space":49, "backspace":51, "delete":51, "escape":53, "esc":53,
        "left":123, "right":124, "down":125, "up":126,
        "arrow_left":123, "arrow_right":124, "arrow_down":125, "arrow_up":126,
        "home":115, "end":119, "pageup":116, "page_up":116, "prior":116,
        "pagedown":121, "page_down":121, "next":121, "forwarddelete":117, "delete_forward":117,
        "help":114, "insert":114,
        "f1":122, "f2":120, "f3":99, "f4":118, "f5":96, "f6":97, "f7":98, "f8":100, "f9":101,
        "f10":109, "f11":103, "f12":111, "f13":105, "f14":107, "f15":113, "f16":106,
        "f17":64, "f18":79, "f19":80, "f20":90,
        "minus":27, "-":27, "equal":24, "=":24, "bracketleft":33, "[":33, "bracketright":30, "]":30,
        "backslash":42, "\\":42, "semicolon":41, ";":41, "apostrophe":39, "'":39,
        "comma":43, "period":47, ".":47, "slash":44, "/":44, "grave":50, "`":50,
        "kp_0":82, "kp_1":83, "kp_2":84, "kp_3":85, "kp_4":86, "kp_5":87, "kp_6":88,
        "kp_7":89, "kp_8":91, "kp_9":92, "kp_decimal":65, "kp_multiply":67, "kp_add":69,
        "kp_clear":71, "clear":71, "kp_divide":75, "kp_enter":76, "kp_subtract":78, "kp_equal":81,
    ]
}
