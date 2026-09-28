import CoreGraphics
import CryptoKit
import Foundation

/// Return and keypad Enter: the keys that submit a text field (a browser omnibox navigates).
public let commitKeyCodes: Set<CGKeyCode> = [36, 76]

/// The only keys a clipboard paste posts: cmd+a to select, cmd+v to paste. Never a commit key, so a
/// paste cannot submit the field it fills.
public enum ClipboardPasteKeys {
    public static let selectAll: CGKeyCode = 0
    public static let paste: CGKeyCode = 9
}

private let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]

/// SHA-256 of a field value, as `act --expect-value-sha256` carries the value the caller observed.
/// A digest keeps the text itself off the command line.
public func fieldValueDigest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// Why a commit key must not be sent, or nil when it may. A text field commits exactly what it holds
/// when the key lands, so the text must still be what the caller observed. Measured 2026-09-28 on
/// Brave: the omnibox lost its last character between set_value and a prepared Return, and the
/// Return navigated to the shortened URL.
///
/// `expectedDigest` is the value the caller saw at `see`. `observed` is only this act's own
/// read, which a stable-key pin (an AXIdentifier, blind to the text) re-resolves after the text
/// changed, so on its own it would let a value edited since `see` be submitted.
public func commitRefusal(role: String?, code: CGKeyCode, observed: String?, live: String?,
                          expectedDigest: String? = nil) -> String? {
    guard commitKeyCodes.contains(code), textInputRoles.contains(role ?? "") else { return nil }
    if let expectedDigest, live.map(fieldValueDigest) != expectedDigest {
        return "the field's text changed since it was observed: it now holds \"\(live ?? "unreadable")\"; "
            + "nothing was sent. Read the field again and send the key only if its text is what you want to submit"
    }
    // An unreadable value, then or now, leaves nothing to compare, so what the key would submit is
    // unknown. Refuse rather than submit blind; a caller that accepts that sends the key to the
    // window instead of the field.
    guard let observed, let live else {
        return "the field's text cannot be read (\(observed == nil ? "when it was observed" : "now")), so what the "
            + "commit key would submit cannot be checked; nothing was sent. Send the key to the window, not the "
            + "field, only if an unchecked submit is acceptable"
    }
    guard live == observed else {
        return "the field's text changed before the commit key: observed \"\(observed)\", now \"\(live ?? "unreadable")\"; "
            + "nothing was sent. Read the field again and send the key only if its text is what you want to submit"
    }
    return nil
}

/// A value an app rewrote after it accepted an AXValue write (an omnibox reacting to autocomplete),
/// read for `duration` after the write. Returns the rewritten value, or nil when it held.
public func valueRewrittenAfterWrite(written: String, duration: TimeInterval = 0.3,
                                     now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                                     wait: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) },
                                     read: () -> String?) -> String? {
    let deadline = now() + duration
    while now() < deadline {
        wait(min(0.05, max(0, deadline - now())))
        let current = read()
        if current != written { return current ?? "unreadable" }
    }
    return nil
}
