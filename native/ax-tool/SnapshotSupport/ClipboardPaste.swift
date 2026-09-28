import AppKit
import Darwin

/// Everything a clipboard paste touches outside the pasteboard, injected so every exit path can
/// be exercised without a real app. `SnapshotWorkflow` wires these to AX reads and posted keys.
public struct ClipboardPastePrimitives {
    /// The target's current AXValue; nil when it cannot be read.
    public var readValue: () -> String?
    /// The target still holds keyboard focus in the intended app and window.
    public var focusedOnTarget: () -> Bool
    /// Select `0..<length` by writing AXSelectedTextRange; false when the write is refused.
    public var setSelection: (_ length: Int) -> Bool
    /// The current AXSelectedTextRange as (location, length); nil when it cannot be read.
    public var selectedRange: () -> (location: Int, length: Int)?
    /// Posts cmd+a to the target process.
    public var postSelectAll: () throws -> Void
    /// Posts cmd+v to the target process. This is the irreversible step.
    public var postPaste: () throws -> Void
    public var now: () -> TimeInterval
    public var wait: (TimeInterval) -> Void

    public init(readValue: @escaping () -> String?, focusedOnTarget: @escaping () -> Bool,
                setSelection: @escaping (Int) -> Bool, selectedRange: @escaping () -> (location: Int, length: Int)?,
                postSelectAll: @escaping () throws -> Void, postPaste: @escaping () throws -> Void,
                now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
                wait: @escaping (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }) {
        self.readValue = readValue
        self.focusedOnTarget = focusedOnTarget
        self.setSelection = setSelection
        self.selectedRange = selectedRange
        self.postSelectAll = postSelectAll
        self.postPaste = postPaste
        self.now = now
        self.wait = wait
    }
}

public struct ClipboardPasteOutcome {
    public let readback: String?
    /// "restored" or "unchanged" on every path that returns.
    public let clipboardRestore: String
    /// False when the field's value cannot be read, so nothing proved the paste landed.
    public let verified: Bool
    /// "ax", "keys", "unverified", "empty" or nil when no replacement was asked for.
    public let selection: String?
    /// True when the field already held the text and nothing was pasted.
    public let skipped: Bool
}

/// A paste that did not complete cleanly. The clipboard has already been handled when this is
/// thrown: `clipboardRestore` says how, and `dispatched` says whether cmd+v was posted.
public struct ClipboardPasteError: Error, LocalizedError {
    public let message: String
    public let clipboardRestore: String
    public let dispatched: Bool
    public var errorDescription: String? { message }
}

/// Whether an inserted paste shows up in the field. Only plain text can be compared: an html or md
/// paste is rendered by the receiver, so its markup never appears in AXValue. Line endings are
/// compared after normalizing, because text fields turn CRLF into LF.
func insertedTextVisible(_ value: String?, text: String, format: String) -> Bool {
    guard format == "text" else { return true }
    func normalized(_ string: String) -> String { string.replacingOccurrences(of: "\r\n", with: "\n") }
    return value.map { normalized($0).contains(normalized(text)) } ?? false
}

/// Wait until the receiver has visibly consumed the paste: the value moved away from `before`
/// and satisfies `settled`. Returns the last value read and whether any change was seen.
public func waitForPasteConsumption(before: String?, timeout: TimeInterval, now: () -> TimeInterval,
                                    wait: (TimeInterval) -> Void, read: () -> String?,
                                    settled: (String?) -> Bool) -> (value: String?, consumed: Bool) {
    let deadline = now() + timeout
    var current = before
    var consumed = false
    while now() < deadline {
        wait(min(0.05, max(0, deadline - now())))
        current = read()
        if current != before { consumed = true }
        if consumed, settled(current) { return (current, true) }
    }
    return (current, consumed)
}

/// The whole-field selection a replacement needs, proved before cmd+v is posted. A missed
/// select-all turns a replacement into an insertion (measured on Brave's omnibox 2026-09-28: the
/// page URL plus the pasted URL), so an unproven selection refuses instead of pasting.
private func selectWholeField(length: Int, primitives: ClipboardPastePrimitives) throws -> String {
    guard length > 0 else { return "empty" }
    func covered() -> Bool? {
        guard let range = primitives.selectedRange() else { return nil }
        return range.location == 0 && range.length == length
    }
    if primitives.setSelection(length), covered() == true {
        return "ax"
    }
    try primitives.postSelectAll()
    let deadline = primitives.now() + 1
    while true {
        switch covered() {
        case true?: return "keys"
        case nil: return "unverified"
        case false?:
            guard primitives.now() < deadline else {
                let range = primitives.selectedRange().map { "\($0.location):\($0.length)" } ?? "unreadable"
                throw WindowEventError.unavailable("select-all did not cover the field (selected \(range) of \(length) characters); paste not dispatched, clipboard restored")
            }
            primitives.wait(0.05)
        }
    }
}

/// One clipboard-backed paste into one field. The original clipboard is restored on EVERY path:
/// success, refusal before cmd+v, readback mismatch, a receiver that never consumed the paste, and
/// a thrown primitive. Restoration waits for evidence that the receiver read the pasteboard (its
/// value changed), bounded by `consumeTimeout`, because restoring first makes a slow receiver
/// paste the user's ORIGINAL clipboard instead.
public func performClipboardPaste(transaction: ClipboardTransaction, text: String, format: String, replace: Bool,
                                  consumeTimeout: TimeInterval = 3,
                                  primitives: ClipboardPastePrimitives) throws -> ClipboardPasteOutcome {
    let before = primitives.readValue()
    if replace, before == text {
        // Nothing to replace. Writing the clipboard here would only open a window in which a late
        // cmd+v pastes whatever is restored.
        return ClipboardPasteOutcome(readback: before, clipboardRestore: "unchanged", verified: true,
                                     selection: nil, skipped: true)
    }
    if replace, before == nil {
        throw ClipboardPasteError(message: "replacement needs a readable AXValue to verify; nothing was pasted",
                                  clipboardRestore: "unchanged", dispatched: false)
    }
    var dispatched = false
    var selection: String?
    let attempt: Result<(value: String?, consumed: Bool), Error>
    do {
        try transaction.write(text: text, format: format)
        guard primitives.focusedOnTarget() else {
            throw WindowEventError.unavailable("focus changed before paste; clipboard restored without dispatch")
        }
        if replace {
            selection = try selectWholeField(length: (before ?? "").utf16.count, primitives: primitives)
            guard primitives.focusedOnTarget() else {
                throw WindowEventError.unavailable("focus changed while selecting; clipboard restored without dispatch")
            }
        }
        try transaction.dispatchPaste {
            dispatched = true
            try primitives.postPaste()
        }
        attempt = .success(waitForPasteConsumption(
            before: before, timeout: consumeTimeout, now: primitives.now, wait: primitives.wait,
            read: primitives.readValue,
            settled: { replace ? $0 == text : insertedTextVisible($0, text: text, format: format) }))
    } catch {
        attempt = .failure(error)
    }
    let restoration = transaction.restore()
    let value: String?
    let consumed: Bool
    switch attempt {
    case .failure(let error):
        throw ClipboardPasteError(message: error.localizedDescription, clipboardRestore: restoration, dispatched: dispatched)
    case .success(let result):
        value = result.value
        consumed = result.consumed
    }
    if before == nil, value == nil {
        return ClipboardPasteOutcome(readback: nil, clipboardRestore: restoration, verified: false,
                                     selection: selection, skipped: false)
    }
    guard consumed else {
        throw ClipboardPasteError(
            message: "the target did not take the paste within \(Int(consumeTimeout)) s; the clipboard was restored, so a paste that lands late inserts the ORIGINAL clipboard. Inspect the field before retrying",
            clipboardRestore: restoration, dispatched: true)
    }
    if replace, value != text {
        throw ClipboardPasteError(message: "paste replacement read-back differs; inspect before retrying",
                                  clipboardRestore: restoration, dispatched: true)
    }
    if !replace, !insertedTextVisible(value, text: text, format: format) {
        throw ClipboardPasteError(
            message: "the field changed but does not contain the pasted text (another clipboard or a transformed paste); inspect before retrying",
            clipboardRestore: restoration, dispatched: true)
    }
    return ClipboardPasteOutcome(readback: value, clipboardRestore: restoration, verified: true,
                                 selection: selection, skipped: false)
}

/// Restores the clipboard when the process is told to stop mid-paste. The caller's deadline sends
/// SIGTERM and SIGKILL 100 ms later; without this the SIGTERM ended the process between the write
/// and the restore, and the pasted text stayed on the user's clipboard.
public final class ClipboardTerminationGuard {
    private var sources: [DispatchSourceSignal] = []
    /// The disposition each signal had before, restored by cancel(). nil is SIG_DFL, so it is kept
    /// in a list: a dictionary would drop the nil and leave the signal ignored for good.
    private var previous: [(signal: Int32, handler: sig_t?)] = []

    public init(transaction: ClipboardTransaction, signals: [Int32] = [SIGTERM, SIGINT, SIGHUP],
                terminate: @escaping (_ signal: Int32, _ clipboardRestore: String) -> Void) {
        let queue = DispatchQueue(label: "ax-tool.clipboard-termination")
        for number in signals {
            previous.append((number, signal(number, SIG_IGN)))
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { [weak transaction] in
                let restoration = transaction?.restore() ?? "unchanged"
                terminate(number, restoration)
            }
            source.resume()
            sources.append(source)
        }
    }

    public func cancel() {
        for source in sources { source.cancel() }
        sources.removeAll()
        for entry in previous { signal(entry.signal, entry.handler) }
        previous.removeAll()
    }

    deinit { cancel() }
}
