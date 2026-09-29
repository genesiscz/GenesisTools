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
    } catch {
        errorExit(error.localizedDescription)
    }
}
