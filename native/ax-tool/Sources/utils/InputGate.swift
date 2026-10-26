import CoreGraphics
import Foundation
import SnapshotSupport

/// Read once per process: the setting cannot change under a running command.
private let takeoverCheckEnabled = takeoverCornerEnabled(ProcessInfo.processInfo.environment)

/// Every active display, so the pure check can pick the main one (the display at the origin).
private func activeDisplayBounds() -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        return []
    }

    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
        return []
    }

    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
}

/// The physical pointer, read fresh on every check. `CGEvent(source: nil)` reports the current
/// location in global display coordinates, top-left origin.
private func pointerTakeover() -> Bool {
    guard takeoverCheckEnabled, let pointer = CGEvent(source: nil)?.location else {
        return false
    }

    return userTookOver(pointer: pointer, displays: activeDisplayBounds(), enabled: takeoverCheckEnabled)
}

/// The gate every synthetic event of this process passes through.
let inputGate = SyntheticInputGate(tookOver: pointerTakeover)
let foregroundInputGate = ForegroundInputGate(check: checkForegroundAllowed)

private let foregroundEnvironment = ProcessInfo.processInfo.environment
/// Read once per process: the agent's run cannot change these under a running command.
private let foregroundCheckEnabled = foregroundGuardEnabled(foregroundEnvironment)
private let foregroundThreshold = foregroundIdleThreshold(foregroundEnvironment)
private let foregroundAllowed = foregroundAllowedByArguments(CommandLine.arguments)
    || foregroundAllowedByEnvironment(foregroundEnvironment)

/// Seconds since the last key, click, pointer move or scroll the window server saw.
private func inputIdleSeconds() -> TimeInterval {
    let types: [CGEventType] = [.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown,
                                .otherMouseDown, .leftMouseDragged, .scrollWheel]
    return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
}

/// Refuses to bring an app to the front or move the pointer while the user is at the keyboard or mouse,
/// when an agent drives this tool. Call it before the first change, so a refusal sent nothing.
func checkForegroundAllowed() throws {
    guard foregroundCheckEnabled, !foregroundAllowed else {
        return
    }

    let idle = inputIdleSeconds()
    guard userIsActive(idleSeconds: idle, threshold: foregroundThreshold) else {
        return
    }

    throw UserActiveError(idleSeconds: idle, threshold: foregroundThreshold)
}

/// The refusal for commands that have no error channel of their own: print it and stop.
func userActiveExit(_ error: UserActiveError) -> Never {
    jsonOutput(["ok": false, "error": error.localizedDescription, "refusal": error.category.rawValue,
                "dispatchState": inputGate.posted > 0 ? "uncertain" : "not_started"])
    exit(1)
}

/// The refusal for commands that have no error channel of their own: print it and stop.
func takeoverExit(_ takeover: UserTakeoverError) -> Never {
    jsonOutput(["ok": false, "error": takeover.localizedDescription, "refusal": takeover.category.rawValue,
                "dispatchState": takeover.dispatched ? "uncertain" : "not_started"])
    exit(1)
}

/// Run a gate call for a legacy command; a takeover ends the command with its refusal.
@discardableResult
func gatedOrExit<T>(_ body: () throws -> T) -> T {
    do {
        return try body()
    } catch let takeover as UserTakeoverError {
        takeoverExit(takeover)
    } catch let refusal as UserActiveError {
        userActiveExit(refusal)
    } catch {
        errorExit(error.localizedDescription)
    }
}
