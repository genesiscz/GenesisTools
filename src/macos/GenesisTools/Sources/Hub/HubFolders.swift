import AppKit
import SwiftUI

// Files → "Add folder": more roots beside the session's own folder (a notes vault, a sibling repo).
// The session's one review shows them all (Review/ReviewRoots.swift): one toolbar, one diff, one Files
// tree whose top level is one folder per root. The chips above Changes ("Changes in GenesisTools",
// "Changes in notes") pick the roots; each root's folder row has the same checkbox and a remove button.

struct HubFilesPane: View {
    @ObservedObject var model: HubModel

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Text("Files").font(.system(size: 11.5, weight: .semibold)).foregroundColor(ReviewPalette.dim)
                Spacer()
                IconButton(systemName: "folder.badge.plus", tooltip: "Add a folder: its changed files show here, and in Changes when ticked") {
                    chooseFolder()
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            if let review = model.review {
                FileSidebar(model: review)
                    // Files can be open without Changes: the list still needs its model loading.
                    .task(id: ObjectIdentifier(review)) { review.start() }
            } else {
                Text("This session's folder is not on this Mac.")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Add folder"
        panel.message = "A folder whose changes this session's Files and Changes can show"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            model.addFolder(url.path)
        }
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
                ReviewRootView(model: review, showsFileList: !model.panes.contains(.files))
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
