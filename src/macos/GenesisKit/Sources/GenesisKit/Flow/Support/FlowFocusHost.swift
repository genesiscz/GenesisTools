import AppKit
import Foundation
import os

/// Host-only effects shared views cannot decide, such as which settings window to raise.
@MainActor
public final class FlowFocusHost {
    public static let shared = FlowFocusHost()
    public var openSettings: () -> Void = {}
    public var notificationsEnabled = false
    public var soundsEnabled = false
    public var transformConfiguration: (() -> FlowTransformConfiguration)?

    private init() {}
}

public struct FlowTransformConfiguration: Sendable {
    public var baseURL: String
    public var model: String
    public var token: String

    public init(baseURL: String, model: String, token: String = "") {
        self.baseURL = baseURL
        self.model = model
        self.token = token
    }
}

enum FlowFocusLog {
    static let flow = Logger(subsystem: Bundle.main.bundleIdentifier ?? "dev.genesis.kit", category: "flow")
    static let focus = Logger(subsystem: Bundle.main.bundleIdentifier ?? "dev.genesis.kit", category: "focus")
    static let speech = Logger(subsystem: Bundle.main.bundleIdentifier ?? "dev.genesis.kit", category: "speech")
}
