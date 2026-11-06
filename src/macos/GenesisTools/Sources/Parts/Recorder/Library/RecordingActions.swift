import AppKit
import SwiftUI

/// The quick actions of one recording, the same list in the menu bar's Recent rows and on a library card: open it,
/// copy its movie or a GIF to the clipboard, show it in Finder, rename it, open its meeting, move it to the Trash.
/// The CLI (`tools recorder copy|reveal|rename|trash`) and the REPL (`movie.copy()`, `reveal()`, `rename()`,
/// `trash()`) do the same through src/recorder/lib/quick-actions.ts; a GIF is made there.
enum RecordingAction: String, CaseIterable, Identifiable {
    case open, firstComment, copyMovie, copyGIF, reveal, rename, openMeeting, trash
    var id: String { rawValue }

    var title: String {
        switch self {
        case .open: "Open in Editor"
        case .firstComment: "Open at First Comment"
        case .copyMovie: "Copy Movie"
        case .copyGIF: "Copy as GIF"
        case .reveal: "Show in Finder"
        case .rename: "Rename…"
        case .openMeeting: "Open Its Meeting"
        case .trash: "Move to Trash"
        }
    }

    var symbol: String {
        switch self {
        case .open: "film"
        case .firstComment: "text.bubble"
        case .copyMovie: "doc.on.doc"
        case .copyGIF: "photo.on.rectangle"
        case .reveal: "folder"
        case .rename: "pencil"
        case .openMeeting: "person.2"
        case .trash: "trash"
        }
    }

    /// What a recording offers: copies only with a movie, its meeting only for a meeting's recording, and never the
    /// Trash for a meeting's folder (it holds the whole meeting).
    static func offered(for item: RecorderMenu.Recent) -> [RecordingAction] {
        allCases.filter { action in
            switch action {
            case .copyMovie, .copyGIF: item.hasMovie
            case .openMeeting: item.isMeeting
            case .firstComment: item.openComments > 0
            case .trash: !item.isMeeting
            case .open, .reveal, .rename: true
            }
        }
    }
}

@MainActor
enum RecordingActions {
    /// Where Copy Movie writes; a test swaps in a pasteboard of its own so it never touches the user's clipboard.
    static var pasteboard = NSPasteboard.general
    static var commands = RecorderCommands()

    /// What an action did, for the surface to show: a short notice, a failure, or a move to the Trash (the library
    /// offers Put Back).
    enum Outcome {
        /// A slow action started (a GIF export); a `notice` or `failed` ends it.
        case working(String)
        case notice(String)
        case failed(String)
        case trashed(from: URL, to: URL)
        case renamed
    }

    static func run(_ action: RecordingAction, _ item: RecorderMenu.Recent, report: @escaping (Outcome) -> Void) {
        HubPerf.log("recorder.actions: \(action.rawValue) \(item.folder.path)")
        switch action {
        case .open:
            RecorderMenu.open(item)
        case .firstComment:
            RecorderMenu.open(item, atSourceSeconds: item.firstOpenCommentUs.map { Double($0) / 1_000_000 })
        case .copyMovie:
            guard let movie = RecordingMovie.shareable(in: item.folder) else {
                report(.failed("“\(item.title)” has no movie to copy."))
                return
            }
            pasteboard.clearContents()
            pasteboard.writeObjects([movie as NSURL])
            report(.notice("Copied \(movie.lastPathComponent) to the clipboard."))
        case .copyGIF:
            report(.working("Making a GIF of “\(item.title)”…"))
            commands.run("movie.copy", params: ["recording": item.folder.path, "gif": true],
                         argv: ["recorder", "copy", item.folder.path, "--gif"], timeout: 10 * 60) { result in
                if case .success = result {
                    report(.notice("Copied a GIF of “\(item.title)” to the clipboard."))
                } else if case let .failure(error) = result {
                    report(.failed("No GIF of “\(item.title)”: \(error.reason)"))
                }
            }
        case .reveal:
            PathOpener.reveal(item.folder.path)
        case .openMeeting:
            // The Meetings window at this meeting; the folder is the meeting's own, named by its id. Revealing
            // meeting.json in Finder stays as the fallback when the window does not open.
            ToolsRunner.run(["meetings", "window", item.folder.lastPathComponent]) { status, _, stderr in
                guard status != 0 else { return }
                let record = item.folder.appendingPathComponent("meeting.json")
                PathOpener.reveal(FileManager.default.fileExists(atPath: record.path) ? record.path : item.folder.path)
                report(.failed("The Meetings window did not open: \(stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"); its record is shown in Finder."))
            }
        case .rename:
            rename(item, report: report)
        case .trash:
            guard !item.isMeeting else {
                report(.failed("“\(item.title)” is a meeting's screen recording; its folder holds the whole meeting, so it stays. Remove the meeting with tools meetings."))
                return
            }
            NSWorkspace.shared.recycle([item.folder]) { moved, error in
                MainActor.assumeIsolated {
                    if let error {
                        HubPerf.log("recorder.actions: trash \(item.folder.path) failed: \(error.localizedDescription)")
                        report(.failed("“\(item.title)” was not moved to the Trash: \(error.localizedDescription)"))
                    } else if let to = moved[item.folder] {
                        report(.trashed(from: item.folder, to: to))
                    }
                }
            }
        }
    }

    /// Asks for a new title (a panel that leaves the front app in front, or an alert: Settings → Recorder) and writes
    /// it through the service, falling back to the same command the CLI and REPL use.
    private static func rename(_ item: RecorderMenu.Recent, report: @escaping (Outcome) -> Void) {
        let request = RecorderTitleRequest(heading: "Rename “\(item.title)”",
                                           detail: "The library and the editor show this title.",
                                           current: item.title)
        RecorderNotice.askTitle(request) { title in
            guard let title else { return }
            write(title, to: item, report: report)
        }
    }

    private static func write(_ title: String, to item: RecorderMenu.Recent, report: @escaping (Outcome) -> Void) {
        commands.run("movie.rename", params: ["recording": item.folder.path, "title": title],
                     argv: ["recorder", "rename", item.folder.path, title]) { result in
            if case .success = result {
                report(.renamed)
            } else if case let .failure(error) = result {
                HubPerf.log("recorder.actions: rename \(item.folder.path) failed: \(error.reason)")
                report(.failed("“\(item.title)” was not renamed: \(error.reason)"))
            }
        }
    }

    /// The actions as menu entries (the menu bar's Recent rows), each reporting through `report`.
    static func menuItems(for item: RecorderMenu.Recent, report: @escaping (Outcome) -> Void) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = []
        for action in RecordingAction.offered(for: item) {
            if action == .trash || action == .copyMovie || action == .rename { items.append(.divider) }
            items.append(.action(action.title, run: { run(action, item, report: report) }))
        }
        return items
    }
}

/// The actions as a context menu's buttons (a library card), each reporting through `report`.
struct RecordingActionsMenu: View {
    let item: RecorderMenu.Recent
    let report: (RecordingActions.Outcome) -> Void

    var body: some View {
        ForEach(RecordingAction.offered(for: item)) { action in
            if action == .trash || action == .copyMovie || action == .rename { Divider() }
            Button(role: action == .trash ? .destructive : nil) {
                RecordingActions.run(action, item, report: report)
            } label: {
                Label(action.title, systemImage: action.symbol)
            }
        }
        Button("Copy Folder Path") { PathOpener.copy(item.folder.path, what: "folder path") }
    }
}
