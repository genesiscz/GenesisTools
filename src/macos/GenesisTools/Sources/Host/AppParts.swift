import AppKit
import Foundation

/// The optional parts of GenesisTools.app (Package.swift; `src/macos/lib/permissions/parts.ts` on the TypeScript
/// side). The executable registers each part it links (Sources/GenesisTools/Parts.swift) before the host reads its
/// arguments, and the host starts a part's face only through here. A build without the part answers with a message
/// that names the command adding it, instead of failing to link.
package enum AppParts {
    /// Which part serves each face flag. The same table as `APP_PARTS` in parts.ts.
    package static let partOfFace: [String: String] = [
        "--hub": "hub",
        "--review": "hub",
        "--widget": "widget",
        "--clicky": "clicky",
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

    package static func isLinked(_ part: String) -> Bool {
        linkedParts.contains(part)
    }

    /// True when this build can start the face `flag` (`--hub`, `--widget`, ...).
    package static func has(face flag: String) -> Bool {
        faces[flag] != nil
    }

    /// Before a window starts the face `flag` in a new process: true when this build has it, else an alert with the
    /// command that adds its part. A child that exits 69 on its own would be unseen: its stderr is discarded.
    @MainActor
    package static func canLaunch(face flag: String) -> Bool {
        guard let part = partOfFace[flag], !has(face: flag) else { return true }
        HubPerf.log("launch \(flag): this build has no \(part) part")
        let alert = NSAlert()
        alert.messageText = "This GenesisTools build has no \(part) part"
        alert.informativeText = "Add it with: tools macos permissions build --add-part \(part)"
        alert.runModal()
        return false
    }

    /// The parts this build links, sorted, for `--version` and the build manifest check.
    package static var linked: [String] {
        linkedParts.sorted()
    }

    /// Runs the face `flag` with `args`. A face whose part is not linked prints which part it needs and exits 69
    /// (EX_UNAVAILABLE).
    package static func run(face flag: String, _ args: [String]) -> Never {
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
