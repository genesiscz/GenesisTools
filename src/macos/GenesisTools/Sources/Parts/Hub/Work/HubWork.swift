import Combine
import GenesisKit
import SwiftUI

/// The Work mode (work-items P8 decision 1): one screen per project with its handoffs and their tasks, the spotted
/// items, the reopened items nobody works on, and who hears about each change. The data and the writes go through the
/// `work` area of the actions service (GenesisKit Work/); the hub only places the screen.
@MainActor
final class HubWorkModel: ObservableObject {
    let screen: WorkScreenModel
    private let defaults: UserDefaults
    private static let lastOpenedKey = "hub.work.lastOpenedProject"
    /// Called once when the screen has something to show (its first snapshot, a failure, or no project at all): a
    /// launch with `--mode work` settles there, as the Timeline and Inbox modes settle on their first load.
    var onLoaded: (() -> Void)? { didSet { watchFirstLoad() } }
    private var loadWatch: AnyCancellable?
    private var requestedProject: String?

    init(source: WorkSource? = nil, defaults: UserDefaults = HubDefaults.store) {
        self.defaults = defaults
        screen = WorkScreenModel(source: source ?? LiveWorkSource())
        // No reload while nobody can see the hub (Hub/HubVisibility.swift); one when it shows again.
        screen.setVisible(HubVisibility.shared.visible)
        HubVisibility.shared.onChange(self) { model, visible in model.screen.setVisible(visible) }
    }

    func activate(sessions: [HubSession] = []) {
        let candidates: [String]
        switch HubWorkOpeningProject.stored(defaults.string(forKey: HubWorkOpeningProject.key)) {
        case .recentSession:
            // A transcript's metadata can change after its last turn. Older rows have only the file time.
            let latest = sessions.max { ($0.lastCacheAt ?? $0.mtime) < ($1.lastCacheAt ?? $1.mtime) }
            candidates = latest.map { session in
                // A session in a subfolder or linked worktree can carry that folder's name as its project.
                // Match the named project first, then the closest Work project in the cached path.
                let folders = (session.cwd as NSString).pathComponents
                if let project = session.project, !project.isEmpty, project != folders.last { return [project] }
                return Array(folders.reversed())
            } ?? []
        case .lastOpened:
            candidates = [defaults.string(forKey: Self.lastOpenedKey)].compactMap { $0 }
        case .firstInList:
            candidates = []
        }
        screen.activate(preferring: requestedProject.map { [$0] } ?? candidates)
        requestedProject = nil
    }

    func openLinkedProject(_ name: String) {
        requestedProject = name
        openProject(name)
        screen.pane = .items
    }

    func openProject(_ name: String) {
        defaults.set(name, forKey: Self.lastOpenedKey)
        screen.project = name
    }

    private func watchFirstLoad() {
        guard onLoaded != nil else { loadWatch = nil; return }
        let screen = screen
        loadWatch = screen.$snapshot.combineLatest(screen.$failure, screen.$projectsLoaded, screen.$itemDetail)
            .first { snapshot, failure, loaded, detail in
                if screen.itemRef != nil { return detail != nil || failure != nil }
                return snapshot != nil || failure != nil || (loaded && screen.project == nil)
            }
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                let done = self?.onLoaded
                self?.onLoaded = nil
                done?()
            }
    }
    func deactivate() { requestedProject = nil; screen.deactivate() }
}

/// The Work mode's answers to the hub (Hub/HubModeModel.swift).
extension HubWorkModel: HubModeModel {
    var navSelection: String? { screen.project }
    func navTitle(selection: String) -> String { "Work: \(selection)" }
    var showsTitlebarHeader: Bool { true }
    func reload() { screen.reload() }
}

/// The sidebar: the projects that have items in the work store.
struct WorkProjectsList: View {
    @ObservedObject var screen: WorkScreenModel
    let filter: String
    let openProject: (String) -> Void
    var clearFilter: (() -> Void)?
    @FocusState private var focused: Bool

    var body: some View {
        let words = filter.lowercased().split(whereSeparator: \.isWhitespace)
        let shown = screen.projects.filter { name in words.allSatisfy { name.lowercased().contains($0) } }
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if screen.projects.isEmpty {
                        Text(screen.failure != nil ? "Projects unavailable" : screen.projectsLoaded ? "No projects with work items" : "Reading the projects…")
                            .font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 10)
                    } else if shown.isEmpty {
                        EmptyState(text: "No matching projects", detail: filter.trimmingCharacters(in: .whitespacesAndNewlines),
                                   actionTitle: clearFilter == nil ? nil : "Clear filter", action: clearFilter)
                    }
                    ForEach(shown, id: \.self) { name in
                        WorkProjectRow(name: name, selected: screen.project == name) { openProject(name) }
                            .equatable()
                            .id(name)
                            .contextMenu {
                                Button("Read the work again") {
                                    if screen.project == name, screen.itemRef == nil { screen.reload() }
                                    else { openProject(name) }
                                }
                                .accessibilityIdentifier("work.project.reload.\(name)")
                            }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 8)
                .genScrollBars()
            }
            .modifier(SidebarArrowKeys(ids: { shown }, selection: { screen.project }, select: openProject,
                                         proxy: proxy, focused: $focused, focusOnClick: true))
        }
    }
}

struct WorkProjectRow: View, Equatable {
    let name: String
    let selected: Bool
    let action: () -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.name == rhs.name && lhs.selected == rhs.selected }

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "folder")
                .font(.system(size: 11.5))
                .foregroundColor(selected ? .white : ReviewPalette.dim)
                .frame(width: 18)
            Text(name)
                .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                .foregroundColor(Color.white.opacity(selected ? 0.95 : 0.78))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .frame(height: 26)
        .contentShape(Rectangle())
        .rowButton(cornerRadius: 6, action)
        .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.white.opacity(0.1) : .clear))
        .instantTooltip("The work items of \(name)")
        .liveRow(selected: selected)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// The main view: the header in the title bar, then the Items or the Notifications pane.
struct WorkMain: View {
    @State private var findRequest = 0
    @State private var focusAfterReturn = false
    @FocusState private var workFocus: Bool
    @GenReduceMotion private var reduceMotion
    @StateObject private var inspectorDrafts = WorkItemInspectorDrafts()
    @ObservedObject var screen: WorkScreenModel
    /// A section a title bar count asked for; the Items scroll view brings its header to the top.
    @State private var jump: String?
    @State private var foldedSections: Set<String> = []
    @AppStorage(HubWorkSections.foldLongListsKey, store: HubDefaults.store) private var foldLongLists = true

    @ObservedObject var preferences: HubPreferences
    var mainCheckout: String?
    let openCommit: (String, String?) -> Void
    let openPullRequest: (String) -> Void

    init(screen: WorkScreenModel, preferences: HubPreferences? = nil, mainCheckout: String? = nil,
         openCommit: @escaping (String, String?) -> Void = { _, _ in },
         openPullRequest: @escaping (String) -> Void = { _ in }) {
        self.screen = screen
        self.preferences = preferences ?? HubDefaults.preferences
        self.mainCheckout = mainCheckout
        self.openCommit = openCommit
        self.openPullRequest = openPullRequest
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if screen.pane == .notify, screen.project != nil, screen.itemRef == nil {
                WorkNotifyPane(screen: screen).id(screen.project)
            } else {
                content
                    .workRowUpdates(screen: screen)
                    .overlay {
                        if screen.isFirstLoad && screen.isLoading && screen.project != nil && screen.itemRef == nil {
                            ProgressView("Reading this project's work").controlSize(.small)
                        }
                    }
            }
        }
        .noticeStack(screen.noticeStack)
        .hubSurface(.content)
        .onChange(of: screen.snapshot?.project, initial: true) { _, project in
            if project != nil { resetSectionFolds() }
        }
        .onChange(of: foldLongLists) { _, _ in resetSectionFolds() }
    }

    private func resetSectionFolds() {
        guard let snapshot = screen.snapshot else { return }
        foldedSections = HubWorkSections.startsFolded(snapshot, preference: foldLongLists) ? [WorkItemsView.containersTitle] : []
    }

    private var header: some View {
        WorkHeader(screen: screen, onJump: { section in foldedSections.remove(section); jump = section })
    }

    private var inspector: some View {
        WorkItemInspector(model: screen, drafts: inspectorDrafts, projectRoot: mainCheckout, openCommit: { sha in
            openCommit(sha, mainCheckout ?? screen.itemDetail?.item.project)
        }, openPullRequest: openPullRequest, externalLink: { text, url in
            AnyView(ExternalLink(text: text, url: url))
        })
    }

    @ViewBuilder
    private var content: some View {
        if screen.pane == .notify {
            if let failure = screen.failure, screen.project == nil {
                FailureInline(.unexpected(failure, outcome: "The projects did not load", action: "Read the Work projects"),
                              form: .pane) { Task { await screen.loadProjects() } }
            } else if let failure = screen.failure, screen.snapshot == nil {
                FailureInline(.unexpected(failure, outcome: "The work items did not load", action: "Read the work items"),
                              form: .pane) { screen.reload() }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let project = screen.project {
                ScrollView {
                    WorkNotifyGridView(project: project, rows: screen.notifyRows)
                        .padding(.horizontal, 18).padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .genScrollBars()
                }
            } else {
                EmptyState(symbol: "checklist", text: screen.projectsLoaded ? "No projects with work items" : "Reading projects…",
                           detail: screen.projectsLoaded ? "Projects appear here when they have a work item." : nil)
            }
        } else {
            GeometryReader { geometry in
                // Work fills the trailing edge. The sidebar contributes to window width, even when folded.
                let beside = geometry.frame(in: .global).maxX >= 900 && preferences.workDetailPlacement == "beside"
                Group {
                    if beside {
                        HStack(spacing: 0) {
                            itemList
                            ResizableSidePanel(key: "work.inspector", edge: .trailing, title: "Item details",
                                               defaultWidth: 420, minWidth: 320,
                                               maxWidth: min(640, max(320, geometry.size.width - 270)),
                                               collapsedStore: HubDefaults.store) { inspector }
                        }
                    } else if screen.selection != nil {
                        VStack(alignment: .leading, spacing: 0) {
                            Button(action: screen.closeItem) { Label("All items", systemImage: "chevron.left") }
                                .buttonStyle(.genHoverPlain())
                                .accessibilityIdentifier("work.detail.allItems")
                                .padding(.leading, 14).padding(.vertical, 6)
                            Divider()
                            inspector
                        }
                    } else { itemList }
                }
                .focusable()
                .focused($workFocus)
                .onKeyPress(keys: [.upArrow, .downArrow, .return, .escape]) { press in
                    guard press.modifiers.isEmpty,
                          !(NSApp.keyWindow?.firstResponder is NSTextView) else { return .ignored }
                    switch press.key {
                    case .upArrow: screen.moveSelection(-1)
                    case .downArrow: screen.moveSelection(1)
                    case .return:
                        guard let ref = screen.selection,
                              screen.results?.containers.contains(where: { $0.ref == ref }) == true else { return .ignored }
                        screen.toggleContainer(ref)
                    case .escape:
                        guard screen.selection != nil else { return .ignored }
                        screen.closeItem()
                    default: return .ignored
                    }
                    return .handled
                }
                .panelFindNative("work.items") {
                    if !beside, screen.selection != nil {
                        focusAfterReturn = true
                        screen.closeItem()
                    } else { findRequest += 1 }
                }
            }
        }
    }

    private var itemList: some View {
        VStack(spacing: 0) {
            WorkFindBar(filter: $screen.filter,
                        matchedCount: screen.results?.matchedCount ?? 0,
                        totalCount: screen.results?.totalCount ?? 0,
                        focusRequest: findRequest, filterNotice: screen.filterNotice,
                        onClear: { screen.filter = .default },
                        onSubmit: { if let ref = screen.filter.fullRef { screen.select(ref) } })
                .id(screen.project)
                .disabled(screen.snapshot == nil)
            Divider()
            if let snapshot = screen.snapshot, let rows = screen.results {
                ScrollViewReader { reader in
                    ScrollView {
                        WorkItemsView(snapshot: snapshot, projection: rows, filter: screen.filter,
                                      selection: screen.selection, pending: screen.pending,
                                      indexLoading: screen.indexLoading, indexFailure: screen.indexFailure,
                                      foldedSections: $foldedSections, select: { workFocus = true; screen.select($0) }, toggleExpansion: { ref, _ in screen.toggleContainer(ref) },
                                      showMore: screen.showMore, clearFilters: { screen.filter = .default },
                                      retryIndex: screen.loadIndexIfNeeded, perform: screen.write)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .genScrollBars()
                    }
                    // initial: a count clicked on the Notify pane switches to this list and sets the jump in one step.
                    .onChange(of: jump, initial: true) { _, section in
                        guard let section else { return }
                        GenMotion.perform(expanding: true, reduceMotion: reduceMotion) {
                            reader.scrollTo(WorkItemsView.sectionID(section), anchor: .top)
                        }
                        jump = nil
                    }
                    .onChange(of: screen.selection) { _, ref in
                        guard let ref else { return }
                        if reduceMotion { reader.scrollTo(ref, anchor: nil) }
                        else { withAnimation(.easeOut(duration: 0.12)) { reader.scrollTo(ref, anchor: nil) } }
                    }
                    .onChange(of: screen.selection.map { screen.visibleRefs.contains($0) } ?? false, initial: true) { old, nowVisible in
                        guard nowVisible, let ref = screen.selection else { return }
                        // A routed item can already be in the list when the list first appears (an archive row far
                        // below the fold). On that first value the rows are not laid out yet, so the scroll waits one
                        // turn. A row already on screen does not move.
                        if old == nowVisible {
                            DispatchQueue.main.async { reader.scrollTo(ref, anchor: nil) }
                        } else {
                            reader.scrollTo(ref, anchor: nil)
                        }
                    }
                }
            } else if let failure = screen.failure, screen.project == nil, screen.selection == nil {
                FailureInline(.unexpected(failure, outcome: "The projects did not load", action: "Read the Work projects"),
                              form: .pane) { Task { await screen.loadProjects() } }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let failure = screen.listFailure ?? (screen.selection == nil ? screen.failure : nil) {
                FailureInline(.unexpected(failure, outcome: "The work items did not load", action: "Read the work items"),
                              form: .pane) { if screen.selection == nil { screen.reload() } else { screen.readListBesideDetail() } }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if screen.project == nil && screen.selection == nil {
                EmptyState(symbol: "checklist", text: screen.projectsLoaded ? "No projects with work items" : "Reading projects…",
                           detail: screen.projectsLoaded ? "Projects appear here when they have a work item." : nil)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView("Reading work items").controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            if focusAfterReturn {
                focusAfterReturn = false
                findRequest += 1
            }
        }
        .task(id: screen.filter.fullRef) {
            guard let ref = screen.filter.fullRef else { return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled, screen.filter.fullRef == ref, let snapshot = screen.snapshot,
                  !snapshot.containers.contains(where: { $0.ref == ref || $0.members.contains(where: { $0.ref == ref && $0.isOpen }) }),
                  !snapshot.triage.contains(where: { $0.ref == ref }) else { return }
            screen.select(ref)
        }
    }
}

/// The title bar reads snapshot values only. A fixed trailing recovery slot keeps the tabs in place when live
/// updates stop; loading and catching up deliberately have no header indicator.
struct WorkHeader: View {
    @ObservedObject var screen: WorkScreenModel
    /// Opens the Items section a count names; nil leaves the counts unclickable.
    var onJump: ((String) -> Void)?

    var body: some View {
        TitlebarHeader {
            HStack(spacing: 10) {
                Group {
                    Image(systemName: "checklist").foregroundColor(ReviewPalette.renamed)
                    Text("Work").font(.system(size: 14, weight: .semibold))
                    Text(verbatim: (screen.itemRef == nil ? screen.project : screen.itemDetail?.item.project) ?? "")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                }
                .titlebarLabel()
                if let summary {
                    // Every count opens what it counts: 47 handoffs push the spotted items far below the fold.
                    HStack(spacing: 2) {
                        ForEach(Array(summary.enumerated()), id: \.offset) { index, part in
                            if index > 0 { Text(verbatim: "·").foregroundColor(ReviewPalette.dim) }
                            Button { screen.pane = .items; onJump?(part.section) } label: {
                                ViewThatFits(in: .horizontal) {
                                    Text(verbatim: part.text).fixedSize()
                                    Label(String(part.count), systemImage: part.symbol).fixedSize()
                                }
                                    .foregroundColor(ReviewPalette.dim)
                                    .padding(.horizontal, 3).frame(minHeight: 24).contentShape(Rectangle())
                            }
                            .buttonStyle(.genHoverPlain())
                            .disabled(onJump == nil)
                            .instantTooltip("Show the " + part.section.lowercased() + " section")
                            .accessibilityLabel("Show \(part.text)")
                        }
                    }
                    .font(.system(size: 11.5))
                    .monospacedDigit()
                }
                Spacer()
                GenSegmentedTabs("Work pane", items: WorkScreenModel.Pane.allCases.map { .init($0, $0.title) },
                                 selection: $screen.pane, minSegmentWidth: 96)
                    .frame(width: 220)
                ZStack(alignment: .trailing) {
                    if case .stopped(let reason) = screen.live {
                        Button(action: screen.reconnect) {
                            Label("Not live", systemImage: "arrow.clockwise")
                                .font(.system(size: 11.5))
                                .foregroundStyle(ReviewPalette.modified)
                                .padding(.horizontal, 8)
                                .frame(minHeight: 24)
                                .background(ReviewPalette.modified.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip("\(reason) Reconnect to follow changes again.")
                        .accessibilityLabel("Reconnect live updates")
                        .accessibilityValue("Not live")
                        .accessibilityIdentifier("work.live.reconnect")
                    }
                }
                .frame(width: 84, height: 24, alignment: .trailing)
            }
        }
    }

    private var summary: [(text: String, section: String, count: Int, symbol: String)]? {
        guard screen.itemRef == nil, let snapshot = screen.snapshot else { return nil }
        return [(Plural.count(snapshot.containers.count, "container"), WorkItemsView.containersTitle, snapshot.containers.count, "tray.full"),
                (Plural.count(snapshot.spotted.count, "spotted item"), WorkItemsView.spottedTitle, snapshot.spotted.count, "eye"),
                (Plural.count(snapshot.reopened.count, "reopened item"), WorkItemsView.reopenedTitle, snapshot.reopened.count, "arrow.uturn.backward")]
    }
}

/// Resolve application routes here so the shared inspector stays usable in a standalone kit host.
struct HubWorkContent: View {
    let model: HubModel
    @ObservedObject var screen: WorkScreenModel
    @State private var resolvedCheckout: (origin: String, main: String)?

    var body: some View {
        let origin = screen.itemDetail?.item.checkoutPath
        let known = screen.project.flatMap { name in
            model.worktrees.first { $0.isMain && $0.repo.caseInsensitiveCompare(name) == .orderedSame }?.path
                ?? PRsModel.projectRoot(name, in: model.prs.allProjects)
        }
        WorkMain(screen: screen, mainCheckout: (resolvedCheckout?.origin == origin ? resolvedCheckout?.main : nil) ?? known,
                 openCommit: { sha, repo in model.openCommitLink(sha, repo: repo) },
                 openPullRequest: { ref in _ = model.apply(HubRequest(["--pr", ref])) })
            .task(id: origin) {
                guard let origin, resolvedCheckout?.origin != origin else { return }
                let main = await Task.detached(priority: .utility) { () -> String? in
                    let source = GitWorkingTreeSource(repo: URL(fileURLWithPath: origin))
                    guard let layout = try? source.repositoryLayout(), layout.commonDirectory.lastPathComponent == ".git"
                    else { return nil }
                    return layout.commonDirectory.deletingLastPathComponent().path
                }.value
                if let main, !Task.isCancelled { resolvedCheckout = (origin, main) }
            }
    }
}
