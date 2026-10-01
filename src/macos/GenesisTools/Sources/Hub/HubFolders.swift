import AppKit
import SwiftUI

// Files → "Add folder": more roots beside the session's own folder (a notes vault, a sibling repo).
// The session's one review shows them all (Review/ReviewRoots.swift): one toolbar, one diff, one Files
// tree whose top level is one folder per root. The chips above Changes ("Changes in GenesisTools",
// "Changes in notes") pick the roots; each root's folder row has the same checkbox and a remove button.
//
// The file list (the Files pane, and the list inside Changes while Files is closed) shows either the
// changed files or the folders themselves: every file under the session's folder and each added one
// (Martin, 2026-10-02: "No changed files … I should be able to swap … to the files of the selected folders").

struct HubFilesPane: View {
    @ObservedObject var model: HubModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("Files").font(.system(size: 11.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                Spacer()
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            if let review = model.review {
                HubFileList(model: model, review: review)
                    // Files can be open without Changes: the list still needs its model loading.
                    .task(id: ObjectIdentifier(review)) { review.start() }
            } else {
                Text("This session's folder is not on this Mac.")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// What the file list shows: the review's changed files, or the folders' own files.
enum HubFileListMode: String {
    case changed, folders

    static let key = "hub.files.mode"
}

/// The hub's file list: "Changed" / "Folders" chips and the add-folder button over the list they pick.
struct HubFileList: View {
    @ObservedObject var model: HubModel
    @ObservedObject var review: ReviewModel
    @AppStorage(HubFileListMode.key, store: HubDefaults.store) private var mode = HubFileListMode.changed.rawValue

    private var showsFolders: Bool { mode == HubFileListMode.folders.rawValue }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                FilterChip(title: "Changed", isOn: !showsFolders, tint: ReviewPalette.renamed) {
                    mode = HubFileListMode.changed.rawValue
                }
                .instantTooltip("The files this session's changes touch")
                FilterChip(title: "Folders", isOn: showsFolders, tint: ReviewPalette.renamed) {
                    mode = HubFileListMode.folders.rawValue
                }
                .instantTooltip("Every file in this session's folder and the folders you added")
                Spacer(minLength: 0)
                IconButton(systemName: "folder.badge.plus", tooltip: "Add a folder: its files show here, and its changes in Changes when ticked") {
                    chooseFolder()
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 8)
            if showsFolders {
                HubFolderTrees(roots: [review.repo.path] + model.extraFolders, review: review, changesShown: model.panes.contains(.changes))
            } else {
                FileSidebar(model: review)
            }
        }
    }

    /// Opens at the session's folder: its siblings and its own subfolders are the usual picks.
    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = review.repo
        panel.prompt = "Add folder"
        panel.message = "A folder whose files and changes this session's Files and Changes can show"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            model.addFolder(url.path)
        }
    }
}

/// One folder tree per root (GenesisKit `FileTreeView`), the session's folder first. A file with a change
/// opens in the diff while Changes is open; any other file opens in Cursor.
struct HubFolderTrees: View {
    let roots: [String]
    @ObservedObject var review: ReviewModel
    let changesShown: Bool
    @StateObject private var trees = HubFolderTreeStore()
    @State private var selected: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(roots, id: \.self) { root in
                    let tree = trees.model(for: root)
                    HubFolderTreeHeader(root: root, folded: trees.folded.contains(root)) {
                        trees.toggleFold(root)
                    }
                    .padding(.top, root == roots.first ? 4 : 10)
                    if !trees.folded.contains(root) {
                        FileTreeView(model: tree, selected: selected, style: Self.style, actions: actions(tree)) { row in
                            !row.isFolder && review.file(atPath: row.id) != nil ? "pencil.circle" : FileTreeView.defaultIcon(row)
                        }
                    }
                }
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 12)
        }
    }

    private func actions(_ tree: FileTreeModel) -> FileTreeActions {
        FileTreeActions(
            open: { url in
                selected = url.path
                if changesShown, let file = review.file(atPath: url.path) {
                    review.select(file.id)
                } else {
                    PathOpener.cursor(url.path)
                }
            },
            setRoot: { url in tree.setRoot(url) },
            changed: { _ in tree.reload() }
        )
    }

    private static let style = FileTreeStyle(
        text: .white,
        secondary: Color.white.opacity(0.82),
        muted: ReviewPalette.dim,
        accent: ReviewPalette.renamed,
        selection: ReviewPalette.renamed.opacity(0.16),
        font: { .system(size: 12, weight: $0 ? .semibold : .regular) }
    )
}

/// The trees, kept while the list stays: switching back to Folders keeps what was open.
@MainActor
final class HubFolderTreeStore: ObservableObject {
    private var models: [String: FileTreeModel] = [:]
    @Published private(set) var folded = Set<String>()

    func model(for root: String) -> FileTreeModel {
        if let model = models[root] {
            return model
        }
        let url = URL(fileURLWithPath: root)
        let model = FileTreeModel(root: url)
        models[root] = model
        // Read on the next turn: a body must not publish.
        DispatchQueue.main.async { model.setRoot(url) }
        return model
    }

    func toggleFold(_ root: String) {
        if folded.remove(root) == nil {
            folded.insert(root)
        }
    }
}

private struct HubFolderTreeHeader: View {
    let root: String
    let folded: Bool
    let toggle: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Button(action: toggle) {
                HStack(spacing: 5) {
                    Image(systemName: folded ? "chevron.right" : "chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundColor(ReviewPalette.dim)
                        .frame(width: 10)
                    Image(systemName: "folder.fill")
                        .font(.system(size: 10))
                        .foregroundColor(ReviewPalette.renamed)
                    Text((root as NSString).lastPathComponent)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(.white)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(root)
            .contextMenu { PathActionsMenu(path: root) }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
    }
}

struct HubChangesPane: View {
    @ObservedObject var model: HubModel

    var body: some View {
        VStack(spacing: 0) {
            if !model.extraFolders.isEmpty {
                rootChips
                Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            }
            if let review = model.review {
                ReviewRootView(model: review, showsFileList: !model.panes.contains(.files)) {
                    AnyView(HubFileList(model: model, review: review))
                }
            } else {
                Text("This session's folder is not on this Mac.")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    /// "Changes in <folder>" for the session's folder and every added one: a multiselect.
    private var rootChips: some View {
        let roots = (model.review.map { [$0.repo.path] } ?? []) + model.extraFolders
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(roots, id: \.self) { root in
                    Toggle("Changes in \((root as NSString).lastPathComponent)", isOn: Binding(get: { model.showsChanges(of: root) }, set: { model.setChangesRoot(root, shown: $0) }))
                    .toggleStyle(.checkbox)
                    .font(.system(size: 11.5))
                    .disabled(!model.isGitFolder(root))
                    .instantTooltip(root)
                }
            }
            .padding(.horizontal, 10)
        }
        .frame(height: 30)
    }
}
