import Foundation

/// One face of the app: a first argument that starts a long-lived process of this bundle (`--meetings`).
///
/// Each face is declared once, in its part's row of src/macos/lib/permissions/parts.ts. `AppFaces.declared` is generated
/// from those declarations (AppFaces+Declared.swift), so the host and the rebuild's relaunch (relaunch.ts) read the
/// same facts. The host's per-face tables are views of this list: `AppParts.partOfFace`, `FaceRecord.isWindowFace` and
/// the quit question's `PartQuit.faceNames` and `PartQuit.faceOrder`. A new face is one entry in parts.ts.
struct AppFace: Equatable, Sendable {
    /// Its name in the ⌘Q question and its place there, the lowest order first.
    struct Quit: Equatable, Sendable {
        let name: String
        let order: Int
    }

    /// The first argument that starts it.
    let flag: String
    /// Older names that start the same face (`--clicky`); every table answers for them as for `flag`.
    let aliases: [String]
    /// The part that serves it; nil for the host's own window (`--window`).
    let part: String?
    /// A window the person sees: it records its argv (FaceRecord), keeps a link relay in front of it (LinkRelay) and logs
    /// its lifecycle (FaceLifecycle). False for a face with no window of its own (the recorder's menu bar item).
    let window: Bool
    /// Nil when the quit question never names it.
    let quit: Quit?

    var flags: [String] { [flag] + aliases }
}

enum AppFaces {
    /// The host's own window: a bare launch (Finder, `open -a`) and macOS's `-psn_…` argument start it too.
    static let hostWindow = "--window"

    private static let byFlag: [String: AppFace] = Dictionary(
        declared.flatMap { face in face.flags.map { ($0, face) } }, uniquingKeysWith: { first, _ in first })

    /// The face a flag or an alias starts.
    static func face(flag: String) -> AppFace? {
        byFlag[flag]
    }

    /// The face a launch's first argument starts: "" and `-psn_…` are the host's own window.
    static func face(firstArgument first: String) -> AppFace? {
        face(flag: first.isEmpty || first.hasPrefix("-psn_") ? hostWindow : first)
    }
}
