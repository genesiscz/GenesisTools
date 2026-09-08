import Foundation

public enum SnapshotDispatchOperation: Equatable {
    case read
    case mutation
    case focus
    case pointer(background: Bool)
    case input
}

public enum SnapshotDispatchError: Error, LocalizedError {
    case rejected(String)

    public var errorDescription: String? {
        switch self {
        case .rejected(let message): return message
        }
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
        throw SnapshotDispatchError.rejected("element is disabled; no action dispatched")
    }
    if case .pointer(background: false) = context.operation, !context.windowFocused {
        throw SnapshotDispatchError.rejected("wrong frontmost app/window; focus explicitly and refresh")
    }
    if context.operation == .input, !context.windowFocused {
        throw SnapshotDispatchError.rejected("wrong frontmost app/window; focus explicitly and refresh")
    }
    if context.operation == .input, !context.inputFocused {
        throw SnapshotDispatchError.rejected("focus changed before input; no action dispatched")
    }

    return try primitiveDispatch()
}
