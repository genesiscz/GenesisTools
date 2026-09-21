import Foundation

public func validateModalTarget(rows: [[String: Any]], target: Int, point: CGPoint? = nil) throws {
    for index in rows.indices {
        let row = rows[index]
        let modal = row["role"] as? String == "AXSheet" || ["1", "true"].contains(String(describing: row["AXModal"] ?? ""))
        guard modal, row["visible"] as? Bool != false else { continue }
        let depth = row["depth"] as? Int ?? 0
        var end = index + 1
        while end < rows.count, (rows[end]["depth"] as? Int ?? 0) > depth { end += 1 }
        if let point {
            let frame = CGRect(x: (row["x"] as? NSNumber)?.doubleValue ?? 0,
                               y: (row["y"] as? NSNumber)?.doubleValue ?? 0,
                               width: (row["width"] as? NSNumber)?.doubleValue ?? 0,
                               height: (row["height"] as? NSNumber)?.doubleValue ?? 0)
            if frame.contains(point) { continue }
        } else if (index..<end).contains(target) { continue }
        throw SnapshotDispatchError.rejected("a visible modal blocks this target; inspect and handle the dialog first", category: .missingTarget)
    }
}

public func exactMenuOptionIndex(rows: [[String: Any]], value: String) throws -> Int {
    let matches = rows.indices.filter { rows[$0]["role"] as? String == "AXMenuItem" && rows[$0]["AXTitle"] as? String == value }
    guard matches.count == 1, let index = matches.first else {
        throw SnapshotError.refusal(.missingTarget, "dropdown option is missing or ambiguous")
    }
    let enabled = rows[index]["AXEnabled"].map { String(describing: $0) } ?? "1"
    guard !["0", "false"].contains(enabled), (rows[index]["actions"] as? [String])?.contains("AXPress") == true else {
        throw SnapshotError.refusal(.refused, "dropdown option is disabled or cannot be selected")
    }
    return index
}

public func validatePreparedTarget(before: [String:Any], after: [String:Any], sameElement: Bool) throws {
    guard sameElement else { throw SnapshotError.refusal(.missingTarget,"selected element was replaced during preparation") }
    for key in ["role","AXSubrole","AXIdentifier","AXTitle","AXDescription","AXURL","AXValue","AXSelected","AXExpanded","targetKey"] {
        guard String(describing:before[key]) == String(describing:after[key]) else {
            throw SnapshotError.refusal(.staleObservation,"selected element changed during preparation (\(key))")
        }
    }
    guard (after["AXEnabled"] as? NSNumber)?.boolValue != false else {
        throw SnapshotError.refusal(.missingTarget,"selected element became disabled during preparation")
    }
}

public enum SnapshotDispatchOperation: Equatable {
    case read
    case mutation
    case focus
    case pointer(background: Bool)
    case input
}

public enum SnapshotDispatchError: Error, LocalizedError {
    case rejected(String, category: SnapshotRefusal = .refused)
    public var category: SnapshotRefusal {
        switch self {
        case .rejected(_, let category): return category
        }
    }

    public var errorDescription: String? {
        switch self {
        case .rejected(let message, _): return message
        }
    }
}

public func validatePointerHitEnabled(_ enabledStates: [Bool?]) throws {
    guard !enabledStates.contains(false) else {
        throw SnapshotDispatchError.rejected("element is disabled; no action dispatched", category: .missingTarget)
    }
}

public struct SnapshotDispatchContext {
    public let token: SnapshotToken
    public let observedPID: Int32
    public let observedProcessLaunch: Double
    public let observedWindowID: Int
    public let observedTreeDigest: String
    public let observedElementIndex: Int
    public let observedElementCount: Int
    public let observedAt: Double
    public let targetEnabled: Bool
    public let windowFocused: Bool
    public let inputFocused: Bool
    /// Deliver input to an app that is NOT frontmost. Keys already go through CGEvent.postToPid,
    /// which cannot leave the target process, so the key window is not what makes delivery safe —
    /// the pid routing is. Requiring it only forced every text action to steal the user's focus.
    public let allowUnfocusedInput: Bool
    public let operation: SnapshotDispatchOperation

    public init(
        token: SnapshotToken,
        observedPID: Int32,
        observedProcessLaunch: Double,
        observedWindowID: Int,
        observedTreeDigest: String,
        observedElementIndex: Int,
        observedElementCount: Int,
        observedAt: Double,
        targetEnabled: Bool,
        windowFocused: Bool,
        inputFocused: Bool,
        allowUnfocusedInput: Bool = false,
        operation: SnapshotDispatchOperation
    ) {
        self.token = token
        self.observedPID = observedPID
        self.observedProcessLaunch = observedProcessLaunch
        self.observedWindowID = observedWindowID
        self.observedTreeDigest = observedTreeDigest
        self.observedElementIndex = observedElementIndex
        self.observedElementCount = observedElementCount
        self.observedAt = observedAt
        self.targetEnabled = targetEnabled
        self.windowFocused = windowFocused
        self.inputFocused = inputFocused
        self.allowUnfocusedInput = allowUnfocusedInput
        self.operation = operation
    }
}

@discardableResult
public func dispatchSnapshotAction<Result>(
    context: SnapshotDispatchContext,
    primitiveDispatch: () throws -> Result
) throws -> Result {
    _ = try context.token.validate(
        pid: context.observedPID,
        launch: context.observedProcessLaunch,
        window: context.observedWindowID,
        digest: context.observedTreeDigest,
        element: context.observedElementIndex,
        count: context.observedElementCount,
        now: context.observedAt
    )
    guard context.operation == .read || context.targetEnabled else {
        throw SnapshotDispatchError.rejected("element is disabled; no action dispatched", category: .missingTarget)
    }
    if case .pointer(background: false) = context.operation, !context.windowFocused {
        throw SnapshotDispatchError.rejected("wrong frontmost app/window; focus explicitly and refresh", category: .focusMismatch)
    }
    // 🛑 Only the KEY WINDOW requirement is waived. The focused-element check below stays, because
    // that is what decides where the text lands inside the app; without it an unfocused send would
    // type into whatever field the app last had, which is a different bug entirely.
    if context.operation == .input, !context.windowFocused, !context.allowUnfocusedInput {
        throw SnapshotDispatchError.rejected("wrong frontmost app/window; focus explicitly, or pass --no-activate to deliver without taking focus", category: .focusMismatch)
    }
    if context.operation == .input, !context.inputFocused {
        throw SnapshotDispatchError.rejected("focus changed before input; no action dispatched", category: .focusMismatch)
    }

    return try primitiveDispatch()
}

/// Only the supplied read closure is repeated; callers keep process/window identity pinned.
public func recoverSnapshotRead<T>(
    now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    isTransient: (Error) -> Bool,
    read: () throws -> T
) throws -> (value: T, retries: Int) {
    let deadline = now() + 1
    var retries = 0
    while true {
        do { return (try read(), retries) }
        catch {
            guard retries < 2, now() < deadline, isTransient(error) else { throw error }
            retries += 1
        }
    }
}
