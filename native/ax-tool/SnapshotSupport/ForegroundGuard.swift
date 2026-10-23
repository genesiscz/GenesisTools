import Foundation

/// The quiet time, in seconds, an agent waits for before it may bring an app to the front or move the
/// pointer. Less than this since the user's last key, click, move or scroll means the user is working,
/// and an agent that took focus then typed into their window (2026-10-23: "you're taking my focus quite
/// a lot during this testing").
public let defaultForegroundIdleSeconds: TimeInterval = 5

/// `GENESIS_CONTROL_FOREGROUND_GUARD=1` turns the check on. The TypeScript runner sets it when an agent
/// drives the tool; a person typing a command just pressed Return, and must not be refused for it.
public func foregroundGuardEnabled(_ environment: [String: String]) -> Bool {
    environment["GENESIS_CONTROL_FOREGROUND_GUARD"]?.trimmingCharacters(in: .whitespaces) == "1"
}

/// `GENESIS_CONTROL_FOREGROUND_IDLE=<seconds>` sets the quiet time; 0 turns the check off. A value that
/// is not a number keeps the default: a guard that a typo disables is not a guard.
public func foregroundIdleThreshold(_ environment: [String: String]) -> TimeInterval {
    guard let raw = environment["GENESIS_CONTROL_FOREGROUND_IDLE"]?.trimmingCharacters(in: .whitespaces),
          let value = Double(raw), value.isFinite, value >= 0 else {
        return defaultForegroundIdleSeconds
    }

    return value
}

/// `GENESIS_CONTROL_ALLOW_FOREGROUND=1` lets a whole run take focus: a demonstration the user asked for.
public func foregroundAllowedByEnvironment(_ environment: [String: String]) -> Bool {
    guard let raw = environment["GENESIS_CONTROL_ALLOW_FOREGROUND"]?.trimmingCharacters(in: .whitespaces).lowercased() else {
        return false
    }

    return ["1", "true", "yes", "on"].contains(raw)
}

/// True when the newest key, click, move or scroll is the user's and came within `threshold` seconds.
/// The window server counts this tool's own synthetic events as input too, so an event no newer than its
/// last post (`ownInputAgo`, with 0.3 s of slack for the throttled record) is the agent's, not the user's.
public func userIsActive(idleSeconds: TimeInterval, ownInputAgo: TimeInterval?, threshold: TimeInterval) -> Bool {
    guard threshold > 0, idleSeconds.isFinite, idleSeconds >= 0, idleSeconds < threshold else {
        return false
    }

    if let own = ownInputAgo, idleSeconds >= own - 0.3 {
        return false
    }

    return true
}

/// The user is at the keyboard or mouse, so this call did not take focus. Never retried automatically.
public struct UserActiveError: Error, LocalizedError {
    public let idleSeconds: TimeInterval
    public let threshold: TimeInterval

    public init(idleSeconds: TimeInterval, threshold: TimeInterval) {
        self.idleSeconds = idleSeconds
        self.threshold = threshold
    }

    public var category: SnapshotRefusal { .userActive }

    public var errorDescription: String? {
        "the user is working on this Mac (their last key, click or pointer move was "
            + String(format: "%.1f", idleSeconds) + " s ago, under the " + String(format: "%g", threshold)
            + " s quiet time), so no app was brought to the front and the pointer did not move. Act in the "
            + "background instead: click without prepare (AXPress or a window-addressed click), press_key with "
            + "activate:false, set_value or fill_form without prepare, launch_app with activate:false, open -g "
            + "for a URL. Only for a visible demonstration the user asked for: allow_foreground:true "
            + "(--allow-foreground, or GENESIS_CONTROL_ALLOW_FOREGROUND=1 for a whole run). "
            + "GENESIS_CONTROL_FOREGROUND_IDLE=0 turns this check off"
    }
}
