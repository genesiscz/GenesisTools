import AppKit
import Foundation

/// The optional parts of GenesisTools.app (Package.swift; `src/macos/lib/permissions/parts.ts` on the TypeScript
/// side). The executable registers each part it links (Sources/GenesisTools/Parts.swift) before the host reads its
/// arguments, and the host starts a part's face only through here. A build without the part answers with a message
/// that names the command adding it, instead of failing to link.
package enum AppParts {
    /// Which part serves each face flag. The same table as `APP_PARTS` in parts.ts.
    static let partOfFace: [String: String] = [
        "--hub": "hub",
        "--review": "hub",
        "--widget": "widget",
        "--features": "features",
        // The old name of the settings face, from the time Clicky owned the window: relaunch records and scripts.
        "--clicky": "features",
        "--markdown": "markdown",
    ]

    nonisolated(unsafe) private static var faces: [String: ([String]) -> Never] = [:]
    nonisolated(unsafe) private static var linkedParts: Set<String> = []

    /// Called once per linked part, before `HostMain.run`.
    package static func register(part: String, faces partFaces: [String: ([String]) -> Never]) {
        linkedParts.insert(part)
        for (flag, run) in partFaces {
            faces[flag] = run
        }
    }

    static func isLinked(_ part: String) -> Bool {
        linkedParts.contains(part)
    }

    /// True when this build can start the face `flag` (`--hub`, `--widget`, ...).
    static func has(face flag: String) -> Bool {
        faces[flag] != nil
    }

    /// Before a window starts the face `flag` in a new process: true when this build has it and staging lets it run,
    /// else an alert that names the fix. A child that exits on its own (69 for a missing part, 64 at the staging gate)
    /// would be unseen: its stderr is discarded.
    @MainActor
    package static func canLaunch(face flag: String) -> Bool {
        if let part = partOfFace[flag], !has(face: flag) {
            return requirePart(part, for: "launch \(flag)")
        }

        guard let refusal = stagingRefusal(face: flag, facesEnabled: NativeStaging.facesEnabled) else { return true }
        HubPerf.log("launch \(flag): \(refusal)")
        let alert = NSAlert()
        alert.messageText = refusal
        alert.informativeText = "Turn the staged faces on for this Mac with: bun scripts/native/staging.ts on"
        alert.runModal()
        return false
    }

    /// The alert title when the staging gate would refuse a plain launch of `flag` (HostMain refuses it with exit 64),
    /// or nil when the face may start.
    package static func stagingRefusal(face flag: String, facesEnabled: Bool) -> String? {
        guard NativeStaging.refuses([flag], facesEnabled: facesEnabled) else { return nil }
        return NativeStaging.settingsFaces.contains(flag) ? "Settings are in staging" : "The widget is in staging"
    }

    /// Before a click opens something of `part` that has no face of its own (Clicky's settings pages): true when this
    /// build links it, else the same alert as `canLaunch`, with the command that adds it.
    @MainActor
    package static func requirePart(_ part: String, for action: String) -> Bool {
        guard !isLinked(part) else { return true }
        HubPerf.log("\(action): this build has no \(part) part")
        let alert = NSAlert()
        alert.messageText = "This GenesisTools build has no \(part) part"
        alert.informativeText = "Add it with: tools macos permissions build --add-part \(part)"
        alert.runModal()
        return false
    }

    /// A part's face reached from a click (a `genesis-tools://hub` link), where nobody reads stderr: the same alert as
    /// `canLaunch`, then the stderr line and exit 69.
    @MainActor
    static func alertMissing(face flag: String) -> Never {
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApp.activate(ignoringOtherApps: true)
        _ = canLaunch(face: flag)
        run(face: flag, [])
    }

    /// The parts this build links, sorted, for `--version` and the build manifest check.
    static var linked: [String] {
        linkedParts.sorted()
    }

    /// Runs the face `flag` with `args`. A face whose part is not linked prints which part it needs and exits 69
    /// (EX_UNAVAILABLE).
    static func run(face flag: String, _ args: [String]) -> Never {
        if let run = faces[flag] {
            run(args)
        }
        let part = partOfFace[flag] ?? flag
        FileHandle.standardError.write(Data(
            "GenesisTools: \(flag) is in the \"\(part)\" part, which this build does not include. Add it with: tools macos permissions build --add-part \(part)\n".utf8
        ))
        exit(69)
    }
}
