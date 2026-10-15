import AppKit
import Carbon

/// The modifier keys a shortcut holds. Caps Lock, Fn and the keypad flag are never part of one: macOS sets Fn and the
/// keypad flag by itself on the arrows and the function keys.
public struct KeyModifiers: OptionSet, Hashable, Sendable {
    public let rawValue: UInt8
    public init(rawValue: UInt8) { self.rawValue = rawValue }

    public static let control = KeyModifiers(rawValue: 1 << 0)
    public static let option = KeyModifiers(rawValue: 1 << 1)
    public static let shift = KeyModifiers(rawValue: 1 << 2)
    public static let command = KeyModifiers(rawValue: 1 << 3)

    public init(_ flags: NSEvent.ModifierFlags) {
        var value: KeyModifiers = []
        if flags.contains(.control) { value.insert(.control) }
        if flags.contains(.option) { value.insert(.option) }
        if flags.contains(.shift) { value.insert(.shift) }
        if flags.contains(.command) { value.insert(.command) }
        self = value
    }

    public var eventFlags: NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if contains(.control) { flags.insert(.control) }
        if contains(.option) { flags.insert(.option) }
        if contains(.shift) { flags.insert(.shift) }
        if contains(.command) { flags.insert(.command) }
        return flags
    }

    /// "⌃⌥⇧⌘", in Apple's order.
    public var symbols: String {
        (contains(.control) ? "⌃" : "") + (contains(.option) ? "⌥" : "") + (contains(.shift) ? "⇧" : "")
            + (contains(.command) ? "⌘" : "")
    }

    /// The Carbon mask `RegisterEventHotKey` takes (`cmdKey` 0x0100, `shiftKey` 0x0200, `optionKey` 0x0800,
    /// `controlKey` 0x1000).
    public var carbonMask: UInt32 {
        (contains(.command) ? 0x0100 : 0) | (contains(.shift) ? 0x0200 : 0) | (contains(.option) ? 0x0800 : 0)
            | (contains(.control) ? 0x1000 : 0)
    }

    public init(carbonMask mask: UInt32) {
        var value: KeyModifiers = []
        if mask & 0x0100 != 0 { value.insert(.command) }
        if mask & 0x0200 != 0 { value.insert(.shift) }
        if mask & 0x0800 != 0 { value.insert(.option) }
        if mask & 0x1000 != 0 { value.insert(.control) }
        self = value
    }

    fileprivate static let names: [(KeyModifiers, String)] = [
        (.control, "ctrl"), (.option, "opt"), (.shift, "shift"), (.command, "cmd"),
    ]
}

/// One key press as a shortcut matcher sees it. Built from a key-down `NSEvent`, or by hand in tests.
public struct KeyStroke: Hashable, Sendable {
    /// The key's position (a virtual key code, the same on every layout).
    public var keyCode: UInt16
    /// What the key types with Shift applied but ⌘ ⌥ ⌃ ignored (`charactersIgnoringModifiers`), lowercased. Empty for
    /// a dead key.
    public var character: String
    public var modifiers: KeyModifiers

    public init(keyCode: UInt16, character: String, modifiers: KeyModifiers) {
        self.keyCode = keyCode
        self.character = character.lowercased()
        self.modifiers = modifiers
    }

    /// nil for anything but a key down.
    public init?(_ event: NSEvent) {
        guard event.type == .keyDown else { return nil }
        self.init(
            keyCode: event.keyCode, character: event.charactersIgnoringModifiers ?? "",
            modifiers: KeyModifiers(event.modifierFlags))
    }
}

/// A shortcut: one key and the modifiers held with it.
///
/// A key is named one of two ways. `.code` is a position, whatever the layout types there: the two keys right of P
/// (⌘ú and ⌘) on a Czech keyboard, ⌘[ and ⌘] on a US one), the arrows, Return. `.character` is what the key types:
/// letters, so ⌘Z follows the Z of a German or Czech layout wherever it sits, and symbols whose meaning is the symbol,
/// so ⌘+ zooms in on the key that types +.
public struct KeyChord: Hashable, Sendable {
    public enum Key: Hashable, Sendable {
        case code(UInt16)
        /// Lowercased.
        case character(String)
    }

    public var key: Key
    public var modifiers: KeyModifiers

    public init(_ key: Key, _ modifiers: KeyModifiers = []) {
        if case .character(let text) = key {
            self.key = .character(text.lowercased())
        } else {
            self.key = key
        }
        self.modifiers = modifiers
    }

    public static func code(_ code: UInt16, _ modifiers: KeyModifiers = []) -> KeyChord {
        KeyChord(.code(code), modifiers)
    }

    public static func character(_ text: String, _ modifiers: KeyModifiers = []) -> KeyChord {
        KeyChord(.character(text), modifiers)
    }

    /// Whether the press is this chord.
    ///
    /// `.code` compares the key and all four modifiers. `.character` compares the typed character. Shift counts there
    /// only for a letter, or when the chord itself holds Shift: the layout decides whether a symbol needs Shift (+ is
    /// Shift and = on a US keyboard, one key without Shift on a Czech one), so ⌘+ is the same chord on both.
    public func matches(_ press: KeyStroke) -> Bool {
        switch key {
        case .code(let code):
            return press.keyCode == code && press.modifiers == modifiers
        case .character(let text):
            guard press.character == text else { return false }
            if Self.isCased(text) || modifiers.contains(.shift) { return press.modifiers == modifiers }
            return press.modifiers.subtracting(.shift) == modifiers
        }
    }

    /// The fallback for a key that types no ASCII character: what a US keyboard types at the same place. A Czech
    /// number row types ě š č with ⌘ held, so ⌘ with ě reaches a shortcut written as ⌘2. A key that does type ASCII
    /// keeps its own meaning (the Czech = key is not the US - key), and letters never fall back (⌘Y on a Czech
    /// keyboard must not reach ⌘Z). `Keymap` tries this only when no chord matched exactly.
    public func matchesByUSPosition(_ press: KeyStroke) -> Bool {
        guard case .character(let text) = key, !Self.isCased(text),
              !press.character.unicodeScalars.allSatisfy(\.isASCII) || press.character.isEmpty,
              let usCharacter = TableKeyLayout.us.character(for: press.keyCode)
        else { return false }
        return usCharacter == text && press.modifiers == modifiers
    }

    /// Whether the chord could fire while the user types into a text field: no ⌘ and no ⌃. A dispatcher keeps such
    /// chords away from text input.
    public var typesText: Bool { modifiers.isDisjoint(with: [.command, .control]) && !isFunctionKey }

    var isFunctionKey: Bool {
        if case .code(let code) = key { return KeyNames.functionKeys.contains(code) }
        return false
    }

    /// The chord a recorder stores for a press: an ASCII letter by its character (so it follows the letter on another
    /// layout), every other key by its position (so ⌘ú stays the key right of P even when the layout changes).
    public static func recorded(_ press: KeyStroke) -> KeyChord {
        let letter = press.character
        if letter.count == 1, let scalar = letter.unicodeScalars.first, scalar.isASCII,
           CharacterSet.lowercaseLetters.contains(scalar)
        {
            return .character(letter, press.modifiers)
        }
        return .code(press.keyCode, press.modifiers)
    }

    static func isCased(_ text: String) -> Bool { text.lowercased() != text.uppercased() }
}

// MARK: - Labels

public extension KeyChord {
    /// "⇧⌘Ú" on a Czech layout, "⇧⌘[" on a US one: the modifiers in Apple's order, then the key as its cap shows it.
    @MainActor var label: String { label(layout: SystemKeyLayout.shared) }

    func label(layout: KeyLayout) -> String { modifiers.symbols + keyName(layout: layout) }

    /// The key alone: "Ú", "↩", "F6", "Space".
    func keyName(layout: KeyLayout) -> String {
        switch key {
        case .code(let code):
            if let name = KeyNames.special[code] { return name }
            if let typed = layout.character(for: code), !typed.isEmpty { return Self.capName(typed) }
            if let typed = TableKeyLayout.us.character(for: code) { return Self.capName(typed) }
            return "Key \(code)"
        case .character(let text):
            return text == " " ? "Space" : Self.capName(text)
        }
    }

    /// What an `NSMenuItem` takes as its key equivalent, lowercased; empty when the key has none (a dead key).
    @MainActor var menuKeyEquivalent: String {
        switch key {
        case .character(let text): return text
        case .code(let code):
            if let special = KeyNames.menuEquivalents[code] { return special }
            return SystemKeyLayout.shared.character(for: code) ?? TableKeyLayout.us.character(for: code) ?? ""
        }
    }

    private static func capName(_ typed: String) -> String { typed.uppercased() }
}

// MARK: - Saved form

/// The saved form: modifier names joined by "+", then `code:<n>` or `char:<text>`. "cmd+shift+code:33", "cmd+char:+".
extension KeyChord: Codable, LosslessStringConvertible {
    public var description: String {
        let names = KeyModifiers.names.filter { modifiers.contains($0.0) }.map(\.1)
        let keyPart: String
        switch key {
        case .code(let code): keyPart = "code:\(code)"
        case .character(let text): keyPart = "char:\(text)"
        }
        return (names + [keyPart]).joined(separator: "+")
    }

    public init?(_ description: String) {
        let markers = ["code:", "char:"].compactMap { description.range(of: $0, options: .backwards) }
        guard let marker = markers.max(by: { $0.lowerBound < $1.lowerBound }) else { return nil }
        let value = String(description[marker.upperBound...])
        var modifiers: KeyModifiers = []
        for name in description[..<marker.lowerBound].split(separator: "+") {
            guard let modifier = KeyModifiers.names.first(where: { $0.1 == name })?.0 else { return nil }
            modifiers.insert(modifier)
        }
        if description[marker] == "code:" {
            guard let code = UInt16(value) else { return nil }
            self.init(.code(code), modifiers)
        } else {
            guard !value.isEmpty else { return nil }
            self.init(.character(value), modifiers)
        }
    }

    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let chord = KeyChord(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a key chord: \(text)"))
        }
        self = chord
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}

// MARK: - Layouts

/// What each key types on a keyboard layout, with no modifier held. Labels read it, so a key cap shows what the user's
/// own keyboard prints there.
public protocol KeyLayout {
    /// nil when the key types nothing (a dead key) or the layout cannot say.
    func character(for keyCode: UInt16) -> String?
    /// What the key types with Shift held; nil when unknown.
    func shiftedCharacter(for keyCode: UInt16) -> String?
}

public extension KeyLayout {
    func shiftedCharacter(for keyCode: UInt16) -> String? { nil }
}

/// A fixed table: the US layout (the fallback and the meaning of `matchesByUSPosition`), or a layout in a test.
public struct TableKeyLayout: KeyLayout, Sendable {
    public let table: [UInt16: String]
    public let shifted: [UInt16: String]
    public init(_ table: [UInt16: String], shifted: [UInt16: String] = [:]) {
        self.table = table
        self.shifted = shifted
    }
    public func character(for keyCode: UInt16) -> String? { table[keyCode] }
    public func shiftedCharacter(for keyCode: UInt16) -> String? { shifted[keyCode] }

    /// The ANSI US layout's printable keys.
    public static let us = TableKeyLayout([
        0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v", 11: "b", 12: "q", 13: "w",
        14: "e", 15: "r", 16: "y", 17: "t", 18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9",
        26: "7", 27: "-", 28: "8", 29: "0", 30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p", 37: "l", 38: "j",
        39: "'", 40: "k", 41: ";", 42: "\\", 43: ",", 44: "/", 45: "n", 46: "m", 47: ".", 50: "`",
    ])
}

/// The keyboard layout the user types with now (or a named one), read through `UCKeyTranslate`. Results are cached
/// per layout; switching the input source is picked up on the next lookup.
@MainActor
public final class SystemKeyLayout: KeyLayout {
    public static let shared = SystemKeyLayout()

    /// nil follows the current input source; a source id ("com.apple.keylayout.Czech") pins one.
    private let sourceID: String?
    private var cache: [String: String?] = [:]

    public init(sourceID: String? = nil) { self.sourceID = sourceID }

    nonisolated public func character(for keyCode: UInt16) -> String? {
        MainActor.assumeIsolated { lookup(keyCode, shift: false) }
    }

    nonisolated public func shiftedCharacter(for keyCode: UInt16) -> String? {
        MainActor.assumeIsolated { lookup(keyCode, shift: true) }
    }

    /// The current layout's id, "com.apple.keylayout.Czech".
    public var currentSourceID: String? {
        guard let source = source() else { return nil }
        return Self.string(source, kTISPropertyInputSourceID)
    }

    private func lookup(_ keyCode: UInt16, shift: Bool) -> String? {
        guard let source = source(), let id = Self.string(source, kTISPropertyInputSourceID) else { return nil }
        let key = "\(id)|\(keyCode)|\(shift)"
        if let known = cache[key] { return known }
        let typed = Self.translate(source, keyCode, shift: shift)
        cache[key] = .some(typed)
        return typed
    }

    private func source() -> TISInputSource? {
        if let sourceID {
            let filter = [kTISPropertyInputSourceID as String: sourceID] as CFDictionary
            let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource]
            return list?.first
        }
        return TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue()
    }

    private static func string(_ source: TISInputSource, _ key: CFString) -> String? {
        guard let raw = TISGetInputSourceProperty(source, key) else { return nil }
        return Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
    }

    private static func translate(_ source: TISInputSource, _ keyCode: UInt16, shift: Bool) -> String? {
        guard let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return data.withUnsafeBytes { buffer -> String? in
            guard let base = buffer.baseAddress else { return nil }
            let layout = base.assumingMemoryBound(to: UCKeyboardLayout.self)
            var deadKeys: UInt32 = 0
            var characters = [UniChar](repeating: 0, count: 4)
            var length = 0
            let status = UCKeyTranslate(
                layout, keyCode, UInt16(kUCKeyActionDown), shift ? UInt32(shiftKey >> 8) : 0, UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysBit), &deadKeys, characters.count, &length, &characters)
            guard status == noErr, length > 0 else { return nil }
            let text = String(utf16CodeUnits: characters, count: length)
            return text.unicodeScalars.allSatisfy({ CharacterSet.controlCharacters.contains($0) }) ? nil : text
        }
    }
}

// MARK: - Key names

enum KeyNames {
    /// Keys whose cap is a name or a symbol, not a typed character.
    static let special: [UInt16: String] = [
        36: "↩", 76: "⌤", 48: "⇥", 49: "Space", 51: "⌫", 117: "⌦", 53: "⎋",
        123: "←", 124: "→", 125: "↓", 126: "↑", 115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
        103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15", 106: "F16", 64: "F17", 79: "F18", 80: "F19",
        90: "F20",
    ]

    static let functionKeys: Set<UInt16> = [
        122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
    ]

    /// `NSMenuItem.keyEquivalent` strings for the named keys.
    static let menuEquivalents: [UInt16: String] = {
        func function(_ value: Int) -> String { String(Character(UnicodeScalar(UInt32(value))!)) }
        var table: [UInt16: String] = [
            36: "\r", 76: "\u{3}", 48: "\t", 49: " ", 51: "\u{8}", 53: "\u{1b}", 117: function(NSDeleteFunctionKey),
            123: function(NSLeftArrowFunctionKey), 124: function(NSRightArrowFunctionKey),
            125: function(NSDownArrowFunctionKey), 126: function(NSUpArrowFunctionKey),
            115: function(NSHomeFunctionKey), 119: function(NSEndFunctionKey),
            116: function(NSPageUpFunctionKey), 121: function(NSPageDownFunctionKey),
        ]
        let fKeys: [UInt16] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]
        for (index, code) in fKeys.enumerated() { table[code] = function(NSF1FunctionKey + index) }
        return table
    }()
}
