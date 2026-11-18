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
    var preferredOpeningProject: String?

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
                let named = session.project.flatMap { $0.isEmpty ? nil : $0 }
                return [named].compactMap { $0 } + folders.reversed().filter { $0 != named }
            } ?? []
        case .lastOpened:
            candidates = [defaults.string(forKey: Self.lastOpenedKey)].compactMap { $0 }
        case .firstInList:
            candidates = []
        }
        let preferred = preferredOpeningProject
        preferredOpeningProject = nil
        screen.activate(preferring: [preferred].compactMap { $0 } + candidates)
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
    func deactivate() { screen.deactivate() }
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

    var body: some View {
        let words = filter.lowercased().split(whereSeparator: \.isWhitespace)
        let shown = screen.projects.filter { name in words.allSatisfy { name.lowercased().contains($0) } }
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if screen.projects.isEmpty {
                    Text(screen.projectsLoaded ? "No projects" : "Reading the projects…")
                        .font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 10)
                } else if shown.isEmpty {
                    Text("No project matches “\(filter.trimmingCharacters(in: .whitespaces))”")
                        .font(.system(size: 11)).foregroundStyle(.secondary).padding(.horizontal, 10)
                }
                ForEach(shown, id: \.self) { name in
                    WorkProjectRow(name: name, selected: screen.project == name) { openProject(name) }
                        .equatable()
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 8)
            .genScrollBars()
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
    @ObservedObject var screen: WorkScreenModel
    /// A section a title bar count asked for; the Items scroll view brings its header to the top.
    @State private var jump: String?
    @GenReduceMotion private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            header
            if let notice = screen.notice {
                NoticePill(text: notice.message, isError: !notice.ok, dismiss: { screen.clearNotice() })
                    .padding(.horizontal, 18)
                    .padding(.top, 8)
            }
            content
        }
        .hubSurface(.content)
    }

    private var header: some View {
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
                            Button { screen.pane = .items; jump = part.section } label: {
                                Text(verbatim: part.text).foregroundColor(ReviewPalette.dim).lineLimit(1)
                            }
                            .buttonStyle(.genHoverPlain())
                            .instantTooltip("Show the " + part.section.lowercased() + " section")
                        }
                    }
                    .font(.system(size: 11.5))
                }
                Spacer()
                GenSegmentedTabs("Work pane", items: WorkScreenModel.Pane.allCases.map { .init($0, $0.title) },
                                 selection: $screen.pane, minSegmentWidth: 96)
                    .frame(width: 220)
                if screen.isLoading {
                    ProgressView().controlSize(.small).accessibilityLabel("Loading")
                }
                IconButton(systemName: "arrow.clockwise", tooltip: "Read this project's work again") { screen.reload() }
            }
        }
    }

    private var summary: [(text: String, section: String)]? {
        guard screen.itemRef == nil, let snapshot = screen.snapshot else { return nil }
        return [(Plural.count(snapshot.containers.count, "container"), WorkItemsView.containersTitle),
                (Plural.count(snapshot.spotted.count, "spotted item"), WorkItemsView.spottedTitle),
                (Plural.count(snapshot.reopened.count, "reopened item"), WorkItemsView.reopenedTitle)]
    }

    @ViewBuilder
    private var content: some View {
        if let ref = screen.itemRef {
            VStack(alignment: .leading, spacing: 12) {
                Button(action: screen.closeItem) { Label("All items", systemImage: "chevron.left") }
                    .buttonStyle(.genHoverPlain())
                if let failure = screen.failure {
                    FailureInline(.unexpected(failure, outcome: "Could not open \(ref)", action: "Read the item"),
                                  form: .pane) { screen.reload() }
                } else if let detail = screen.itemDetail {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            Text(detail.item.title).font(.title3.weight(.semibold)).textSelection(.enabled)
                            Text(verbatim: "\(detail.item.type.capitalized) · \(detail.item.state.capitalized) · \(detail.item.id)")
                                .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            if let body = detail.item.body, !body.isEmpty, body != detail.item.title {
                                Text(verbatim: body).textSelection(.enabled)
                            }
                            if let acceptance = detail.item.acceptance, !acceptance.isEmpty {
                                Text("Acceptance").font(.headline)
                                Text(verbatim: acceptance).textSelection(.enabled)
                            }
                            if let members = detail.members {
                                Text("Tasks").font(.headline)
                                if members.isEmpty { EmptyState(text: "This handoff has no tasks") }
                                ForEach(members) { member in
                                    Button { screen.openItem(member.ref) } label: {
                                        Label(member.title, systemImage: WorkStateLook.symbol(member.state))
                                            .frame(maxWidth: .infinity, minHeight: 26, alignment: .leading).contentShape(Rectangle())
                                    }
                                    .buttonStyle(RowButtonStyle())
                                    .accessibilityValue(member.state)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("work.detail.\(detail.item.id)")
                    }
                    .id(detail.item.id)
                } else {
                    Text("Opening \(ref)…").foregroundStyle(.secondary)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else if let failure = screen.failure, screen.snapshot == nil {
            FailureInline(.unexpected(failure, outcome: "The work items did not load", action: "Read the work items"),
                          form: .pane) { screen.reload() }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if screen.project == nil {
            EmptyState(symbol: "checklist", text: "Pick a project", detail: "The projects with work items are on the left.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
            ScrollView {
                Group {
                    switch screen.pane {
                    case .items:
                        if let snapshot = screen.snapshot {
                            WorkItemsView(snapshot: snapshot, pending: screen.pending) { action in
                                Task { await screen.perform(action) }
                            }
                        }
                    case .notify:
                        WorkNotifyGridView(project: screen.project ?? "", rows: screen.notifyRows)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .genScrollBars()
            }
            .onChange(of: jump) { _, section in
                guard let section else { return }
                GenMotion.perform(expanding: true, reduceMotion: reduceMotion) {
                    proxy.scrollTo(WorkItemsView.sectionID(section), anchor: .top)
                }
                jump = nil
            }
            }
        }
    }
}
