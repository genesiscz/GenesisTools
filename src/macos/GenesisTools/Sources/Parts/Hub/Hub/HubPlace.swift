import Foundation

/// Where the hub was: its mode, the row it showed and the session's pane, in `~/.genesis-tools/hub/place.json`.
///
/// A rebuild kills the hub and starts it again with `--hub … --resume` (src/macos/lib/permissions/relaunch.ts).
/// `--resume` swaps the launch's own place flags for the saved place, so the new hub opens where the old
/// one was rather than on the newest session. A plain `--hub` ignores the file.
struct HubPlace: Codable, Equatable {
    var mode: String
    var selection: String?
    var tab: String?

    static let resumeFlag = "--resume"
    /// The flags that only set up the window, each with its value: a resume keeps these and `--no-activate`, and
    /// drops every other flag, since each names a place (`--pr`, `--repo`, `--commit`, `--file`, …), says who asked
    /// for it (`--actor`, `--note`, `--from`, `--nav`) or runs something once. A kept `--repo … --commit …` from an
    /// old link was passed on by every later rebuild and opened that commit over the saved place (2026-10-26 19:28
    /// to 10-27 01:58: an Inbox resume landed on a worktree commit).
    static let windowFlags: Set<String> = ["--width", "--height", "--style", "--glass", "--panes", "--set"]

    /// Under `genesisHome()` (GENESIS_TOOLS_HOME), as the face records a rebuild reads beside it.
    static var url: URL {
        NativePreview.hubFile("place.json")
    }

    init(mode: String, selection: String?, tab: String?) {
        self.mode = mode
        self.selection = selection
        self.tab = tab
    }

    init(entry: HubNavEntry, tab: HubTab) {
        self.init(mode: entry.mode.rawValue, selection: entry.selection, tab: tab.rawValue)
    }

    /// The `--hub` flags that open this place.
    var arguments: [String] {
        guard let mode = HubMode(rawValue: mode) else { return [] }
        let picked = selection.flatMap { $0.isEmpty || $0 == HubModel.wholeList ? nil : $0 }
        switch mode {
        case .sessions:
            guard let picked else { return [] }
            return ["--session", picked] + (tab.map { ["--tab", $0] } ?? [])
        case .worktrees:
            guard let picked else { return ["--mode", "worktrees"] }
            return ["--mode", "worktrees", "--worktree", picked == WorktreeCleanup.selectionID ? "cleanup" : picked]
        case .prs:
            return ["--mode", "prs"] + (picked.map { ["--pr", $0] } ?? [])
        case .inbox, .timeline:
            return ["--mode", mode.rawValue]
        case .agents:
            guard let picked, let key = AgentTree.split(picked) else { return ["--mode", "agents"] }
            if key.child == AgentTree.mainChild, let parent = key.parent {
                return ["--mode", "agents", "--session", parent]
            }
            return (key.parent.map { ["--session", $0] } ?? []) + ["--agent", key.child]
        }
    }

    /// `args` without `--resume`; with a saved place, only the launch's window flags and the saved place's own.
    /// No place (an older hub never wrote one) keeps the launch's own flags.
    static func resumed(_ args: [String], place: HubPlace?) -> [String] {
        guard args.contains(resumeFlag) else { return args }
        let rest = args.filter { $0 != resumeFlag }
        guard let place, !place.arguments.isEmpty else { return rest }
        var kept: [String] = []
        var index = 0
        while index < rest.count {
            let flag = rest[index]
            if windowFlags.contains(flag), index + 1 < rest.count {
                kept += [flag, rest[index + 1]]
                index += 2
                continue
            }
            if flag == "--no-activate" { kept.append(flag) }
            index += 1
        }
        return kept + place.arguments
    }

    /// `runHub`'s first step: expands `--resume` from the saved place.
    static func expand(_ args: [String]) -> [String] {
        guard args.contains(resumeFlag) else { return args }
        let place = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(HubPlace.self, from: $0) }
        let expanded = resumed(args, place: place)
        PerfLog.mark("hub.resume \(place.map { "\($0.mode) \($0.selection ?? "-")" } ?? "no saved place") -> \(expanded.joined(separator: " "))")
        return expanded
    }

    private static let writer = DispatchQueue(label: "hub.place.writer", qos: .utility)
    private static var lastWritten: HubPlace?

    /// Saves the place off the main thread; a scripted run (snapshot, bench) never writes it.
    @MainActor
    static func record(_ entry: HubNavEntry, tab: HubTab) {
        guard !HubDefaults.isolated else { return }
        let place = HubPlace(entry: entry, tab: tab)
        guard place != lastWritten else { return }
        lastWritten = place
        writer.async {
            do {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try JSONEncoder().encode(place).write(to: url, options: .atomic)
            } catch {
                PerfLog.mark("hub.place write failed: \(error)")
            }
        }
    }
}
