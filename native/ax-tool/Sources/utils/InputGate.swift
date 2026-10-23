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
let inputGate = SyntheticInputGate(tookOver: pointerTakeover, onPost: recordOwnInput)

private let foregroundEnvironment = ProcessInfo.processInfo.environment
/// Read once per process: the agent's run cannot change these under a running command.
private let foregroundCheckEnabled = foregroundGuardEnabled(foregroundEnvironment)
private let foregroundThreshold = foregroundIdleThreshold(foregroundEnvironment)
private let foregroundAllowed = CommandLine.arguments.contains("--allow-foreground")
    || foregroundAllowedByEnvironment(foregroundEnvironment)

/// Seconds since the last key, click, pointer move or scroll the window server saw.
private func inputIdleSeconds() -> TimeInterval {
    let types: [CGEventType] = [.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown,
                                .otherMouseDown, .leftMouseDragged, .scrollWheel]
    return types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
}

/// When any process of this tool last posted a synthetic event. The window server counts those as
/// input, and an agent's own previous click must not read as the user working.
private let ownInputFile: URL = {
    let home = foregroundEnvironment["GENESIS_TOOLS_HOME"].map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis-tools")
    return home.appendingPathComponent("control").appendingPathComponent("last-synthetic-input")
}()
private var ownInputWrittenAt: TimeInterval = 0

/// At most one write per quarter second; the guard's 0.3 s slack covers the posts in between.
private func recordOwnInput() {
    guard foregroundCheckEnabled else {
        return
    }

    let now = Date().timeIntervalSince1970
    guard now - ownInputWrittenAt >= 0.25 else {
        return
    }

    ownInputWrittenAt = now
    do {
        try FileManager.default.createDirectory(at: ownInputFile.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try String(now).write(to: ownInputFile, atomically: true, encoding: .utf8)
    } catch {
        fputs("could not record the time of this tool's own input: \(error.localizedDescription)\n", stderr)
    }
}

private func ownInputAgo() -> TimeInterval? {
    guard let text = try? String(contentsOf: ownInputFile, encoding: .utf8),
          let at = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)) else {
        return nil
    }

    return Date().timeIntervalSince1970 - at
}

/// Refuses to bring an app to the front or move the pointer while the user is at the keyboard or mouse,
/// when an agent drives this tool. Call it before the first change, so a refusal sent nothing.
func checkForegroundAllowed() throws {
    guard foregroundCheckEnabled, !foregroundAllowed else {
        return
    }

    let idle = inputIdleSeconds()
    guard userIsActive(idleSeconds: idle, ownInputAgo: ownInputAgo(), threshold: foregroundThreshold) else {
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
    } catch {
        errorExit(error.localizedDescription)
    }
}
