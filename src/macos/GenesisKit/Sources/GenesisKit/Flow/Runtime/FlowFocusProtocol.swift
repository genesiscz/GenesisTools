import Foundation

struct FlowSuggestionAcceptance: Codable {
    let suggestion: FlowSuggestion
    let replacement: String
}

struct FlowStoreWrite: Codable {
    let name: String
    let data: Data
}

struct FocusStartCommand: Codable {
    let phase: PomodoroPlan.Phase
    let seconds: Int?
    let tag: String?
}

struct FocusPauseCommand: Codable {
    let reason: ActivityStore.PauseReason
    let since: Date?
}

struct FlowFocusLiveSnapshot: Codable, Equatable {
    let ownerNonce: UUID
    let flowRevision: UInt64
    let configurationRevision: UInt64
    let configurationError: String?
    let flow: FlowLiveSnapshot
    let focus: FocusLiveSnapshot
    let dnd: FocusDNDSnapshot
}

struct FlowLiveSnapshot: Codable, Equatable {
    let phase: FlowPhase
    let lastError: String?
    let lastInjected: String?
    let labEnabled: Bool
    let hotkeyStatus: GlobalHotkeyStatus
    let partialText: String
    let micLevel: Double
    /// Optional so a snapshot from an owner without it still decodes.
    var accessibilityTrusted: Bool?
}

struct FocusLiveSnapshot: Codable, Equatable {
    let available: Bool
    let lastError: String?
    let engine: FocusEngineSnapshot?
    let recorder: FocusRecorderSnapshot?
}

struct FocusEngineSnapshot: Codable, Equatable {
    let state: PomodoroEngine.State
    let phase: PomodoroPlan.Phase
    let remainingSec: Int
    let completedFlows: Int
    let tag: String?
    let interruptions: Int
    let pauseReason: ActivityStore.PauseReason?
    let plan: PomodoroPlan
    let plannedSec: Int
    let sessionId: Int64?
}

struct FocusRecorderSnapshot: Codable, Equatable {
    let isCapturing: Bool
    let isIdle: Bool
    let current: ActivityRecorder.FocusSnapshot?
    let pausedUntil: Date?
    let inputHistory: [Int]
    let currentMix: [ActivityRecorder.AppShare]
}

struct FocusDNDSnapshot: Codable, Equatable {
    let isActive: Bool
    let activeReason: String?
    let suppressesSystemNotifications: Bool
    let recoveryNotice: String?
}
