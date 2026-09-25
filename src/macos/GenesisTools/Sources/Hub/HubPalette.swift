import AppKit
import SwiftUI

// The hub's command palette (⌘K). Typed commands read `<project> <keyword> <argument>`:
// "GenesisTools pr 424", "gt pr 424" (a project matches by name, prefix, initials or letters in
// order), "session hub", "grep FocusBridge". Every command is also a row you can pick; Tab completes
// the highlighted row, Enter runs it. When two projects match a word equally well, the rows are those
// projects to pick from, never a guess. The look and keyboard handling are modeled on Genesis's
// palette (GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/UI/CommandPaletteView.swift).

// MARK: - Engine

struct HubPaletteProject: Hashable {
    let name: String
    let path: String

    /// `other` is this folder or inside it. A plain prefix would also take `/src/app-web` for `/src/app`.
    func contains(_ other: String) -> Bool {
        other == path || other.hasPrefix(path.hasSuffix("/") ? path : path + "/")
    }
}

enum HubPaletteAction: Equatable {
    case openPR(HubPRRef)
    case selectSession(String)
    case selectWorktree(String)
    case setMode(HubMode)
    case togglePane(HubTab)
    case openCursor(String)
    case openTerminal(String)
    case newSession(String)
    /// The query, and the folder of the project the palette named (nil: the hub's own roots).
    case findInFiles(String, root: String?)
    case historySearch(String)
    case reveal(String)
    case reviewWithAgent
    case toggleGlass
}

struct HubPaletteSuggestion: Identifiable, Equatable {
    let id: String
    let title: String
    var subtitle: String?
    var symbol: String
    /// What Tab puts in the field (a completed project, keyword or id).
    var completion: String?
    /// Nil for a row that only completes (a project to pick when the word was ambiguous).
    var action: HubPaletteAction?
}

struct HubPaletteContext {
    var projects: [HubPaletteProject] = []
    var sessions: [HubSession] = []
    var prs: [HubPR] = []
    var worktrees: [HubWorktree] = []
    /// The folder the palette acts on when no project is typed (the selected session's project).
    var currentPath: String?

    /// Changes when anything the rows are built from changes.
    var signature: String {
        "\(projects.count)|\(sessions.count)|\(prs.count)|\(worktrees.count)|\(currentPath ?? "")"
    }
}

enum HubPaletteEngine {
    struct Keyword {
        let word: String
        let aliases: [String]
        let summary: String
        let symbol: String
        /// Needs a project (typed, or the current one) to act on.
        let usesProject: Bool
    }

    /// The commands, in the order an empty palette lists them.
    static let keywords: [Keyword] = [
        Keyword(word: "pr", aliases: ["mr"], summary: "Open a pull or merge request: <project> pr <number>", symbol: "arrow.triangle.pull", usesProject: true),
        Keyword(word: "session", aliases: ["s"], summary: "Open a session: <project> session <words>", symbol: "bubble.left.and.text.bubble.right", usesProject: true),
        Keyword(word: "worktree", aliases: ["branch", "wt"], summary: "Open a worktree: <project> worktree <branch>", symbol: "arrow.triangle.branch", usesProject: true),
        Keyword(word: "grep", aliases: ["find"], summary: "Find in files (⌘⇧F): grep <text>", symbol: "text.magnifyingglass", usesProject: true),
        Keyword(word: "history", aliases: ["h"], summary: "Search every session's history: history <words>", symbol: "clock.arrow.circlepath", usesProject: false),
        Keyword(word: "file", aliases: ["open"], summary: "Show a changed file: file <path>", symbol: "doc.text", usesProject: true),
        Keyword(word: "cursor", aliases: ["code"], summary: "Open the project in Cursor", symbol: "chevron.left.forwardslash.chevron.right", usesProject: true),
        Keyword(word: "terminal", aliases: ["cmux", "term"], summary: "Open the project in a new cmux workspace", symbol: "terminal", usesProject: true),
        Keyword(word: "new", aliases: ["start"], summary: "Start a new agent session in the project", symbol: "plus.bubble", usesProject: true),
        Keyword(word: "review", aliases: [], summary: "Review the selected PR with an agent", symbol: "checklist", usesProject: false),
        Keyword(word: "pane", aliases: ["tab"], summary: "Show or hide a pane: pane transcript|changes|files|decisions", symbol: "rectangle.split.3x1", usesProject: false),
        Keyword(word: "mode", aliases: [], summary: "Switch the list: mode sessions|worktrees|prs", symbol: "sidebar.left", usesProject: false),
        Keyword(word: "glass", aliases: [], summary: "Turn the glass look on or off (⌘⇧G)", symbol: "drop", usesProject: false),
    ]

    static func keyword(_ word: String) -> Keyword? {
        let lower = word.lowercased()
        return keywords.first { $0.word == lower || $0.aliases.contains(lower) }
    }

    /// How well `query` names `name`; nil when it does not. Exact > prefix > initials > substring >
    /// letters in order. "gt" matches GenesisTools by its initials.
    static func projectScore(_ query: String, _ name: String) -> Int? {
        let q = query.lowercased()
        let n = name.lowercased()
        guard !q.isEmpty else { return nil }
        if n == q { return 1000 }
        // Every prefix match is equal: "genesis" names GenesisTools and a shorter GenesisDocs alike, so
        // both are offered to pick from instead of the shorter name winning silently.
        if n.hasPrefix(q) { return 800 }
        let initials = initialsOf(name)
        if initials == q { return 700 }
        if initials.hasPrefix(q), q.count >= 2 { return 600 }
        if n.contains(q) { return 500 }
        if let gaps = subsequenceGaps(q, in: n) { return max(100, 300 - gaps * 10) }
        return nil
    }

    /// First letters of the words in a name: a capital after a lower-case letter, a run of digits, and
    /// anything after a separator start a word; an acronym ("UI") is one word.
    static func initialsOf(_ name: String) -> String {
        var result = ""
        var previous: Character?
        for character in name {
            let startsWord: Bool
            if let previous {
                let separated = !previous.isLetter && !previous.isNumber && (character.isLetter || character.isNumber)
                let digitsStart = character.isNumber && !previous.isNumber
                let lettersAfterDigits = character.isLetter && previous.isNumber
                startsWord = (character.isUppercase && !previous.isUppercase) || separated || digitsStart || lettersAfterDigits
            } else {
                startsWord = character.isLetter || character.isNumber
            }
            if startsWord {
                result.append(Character(character.lowercased()))
            }
            previous = character
        }
        return result
    }

    private static func subsequenceGaps(_ needle: String, in haystack: String) -> Int? {
        var gaps = 0
        var index = haystack.startIndex
        for character in needle {
            guard let found = haystack[index...].firstIndex(of: character) else { return nil }
            gaps += haystack.distance(from: index, to: found)
            index = haystack.index(after: found)
        }
        return gaps
    }

    /// Projects ranked for a word, and whether the best score is shared (then the user picks).
    static func projects(for word: String, in context: HubPaletteContext) -> (ranked: [HubPaletteProject], ambiguous: Bool) {
        let scored = context.projects.compactMap { project in projectScore(word, project.name).map { (project, $0) } }
            .sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.name < $1.0.name }
        guard let best = scored.first?.1 else { return ([], false) }
        let top = scored.filter { $0.1 == best }
        return (scored.map(\.0), top.count > 1)
    }

    static func suggestions(for input: String, context: HubPaletteContext, limit: Int = 12) -> [HubPaletteSuggestion] {
        let tokens = input.split(whereSeparator: \.isWhitespace).map(String.init)
        let endsWithSpace = input.last?.isWhitespace == true
        guard let first = tokens.first else {
            return keywords.map { keywordRow($0, project: nil, completion: "\($0.word) ") }
        }

        var project: HubPaletteProject?
        var rest = tokens
        if keyword(first) == nil || (tokens.count == 1 && !endsWithSpace) {
            let (ranked, ambiguous) = projects(for: first, in: context)
            // Still typing the first word: projects and commands that start with it.
            if tokens.count == 1 && !endsWithSpace {
                let projectRows = ranked.prefix(6).map { projectRow($0, completion: "\($0.name) ") }
                let keywordRows = keywords.filter { $0.word.hasPrefix(first.lowercased()) || $0.aliases.contains { $0.hasPrefix(first.lowercased()) } }
                    .map { keywordRow($0, project: nil, completion: "\($0.word) ") }
                return Array((keywordRows + projectRows).prefix(limit))
            }
            if keyword(first) == nil {
                guard let chosen = ranked.first else {
                    return [HubPaletteSuggestion(id: "none", title: "No project or command matches “\(first)”", subtitle: "Try a command: pr, session, worktree, grep, history…", symbol: "questionmark.circle")]
                }
                if ambiguous {
                    let remainder = tokens.dropFirst().joined(separator: " ")
                    return ranked.prefix(limit).map { candidate in
                        var row = projectRow(candidate, completion: "\(candidate.name) \(remainder)".trimmingCharacters(in: .whitespaces) + " ")
                        row.subtitle = "“\(first)” matches several projects: pick one (Tab) · \(candidate.path)"
                        return row
                    }
                }
                project = chosen
                rest = Array(tokens.dropFirst())
            }
        }

        let projectPrefix = project.map { "\($0.name) " } ?? ""
        guard let word = rest.first else {
            // "gt " : the project's commands.
            return keywords.filter(\.usesProject).map { keywordRow($0, project: project, completion: "\(projectPrefix)\($0.word) ") }
        }
        guard let command = keyword(word) else {
            let matching = keywords.filter { $0.word.hasPrefix(word.lowercased()) || $0.aliases.contains { $0.hasPrefix(word.lowercased()) } }
            if matching.isEmpty {
                return [HubPaletteSuggestion(id: "none", title: "No command “\(word)”", subtitle: "Commands: " + keywords.map(\.word).joined(separator: ", "), symbol: "questionmark.circle")]
            }
            return matching.map { keywordRow($0, project: project, completion: "\(projectPrefix)\($0.word) ") }
        }
        let argument = rest.dropFirst().joined(separator: " ")
        let path = project?.path ?? context.currentPath
        return Array(rows(for: command, argument: argument, project: project, path: path, prefix: projectPrefix, context: context).prefix(limit))
    }

    private static func rows(for command: Keyword, argument: String, project: HubPaletteProject?, path: String?, prefix: String,
                             context: HubPaletteContext) -> [HubPaletteSuggestion] {
        let where_ = project.map { " in \($0.name)" } ?? ""
        switch command.word {
        case "pr":
            let digits = argument.trimmingCharacters(in: CharacterSet(charactersIn: "#! "))
            let inProject = context.prs.filter { pr in project.map { HubPRRef(project: $0.name, number: pr.number).matches(pr) } ?? true }
            var rows: [HubPaletteSuggestion] = []
            if let number = Int(digits) {
                rows.append(HubPaletteSuggestion(id: "pr-\(number)", title: "Open PR #\(number)\(where_)", subtitle: inProject.first { $0.number == number }?.title,
                                                 symbol: command.symbol, completion: "\(prefix)pr \(number)", action: .openPR(HubPRRef(project: project?.name, number: number))))
            }
            let listed = inProject.filter { digits.isEmpty || String($0.number).hasPrefix(digits) || $0.title.localizedCaseInsensitiveContains(argument) }
                .filter { Int(digits) != $0.number }
                .prefix(8)
                .map { pr in
                    HubPaletteSuggestion(id: "pr-\(pr.id)", title: "\(pr.label) \(pr.title)", subtitle: "\(pr.repo) · \(pr.headBranch)", symbol: command.symbol,
                                         completion: "\(prefix)pr \(pr.number)", action: .openPR(HubPRRef(project: project?.name ?? pr.repo, number: pr.number)))
                }
            if rows.isEmpty, listed.isEmpty {
                // "gt pr" before the PRs mode ever loaded its list drew an empty box (snapshot 2026-09-25).
                let why = context.prs.isEmpty ? "The list fills once the PRs mode has loaded" : "No PR matches “\(argument)”"
                return [HubPaletteSuggestion(id: "pr-none", title: "Type a PR number to open it\(where_)", subtitle: why, symbol: "questionmark.circle")]
            }
            return rows + listed
        case "session":
            let matches = context.sessions.filter { session in
                (project?.contains(session.cwd) ?? true)
                    && (argument.isEmpty || "\(session.displayTitle) \(session.sessionId)".localizedCaseInsensitiveContains(argument))
            }
            return matches.prefix(10).map { session in
                HubPaletteSuggestion(id: "session-\(session.id)", title: session.displayTitle, subtitle: "\(session.provider) · \((session.cwd as NSString).lastPathComponent)",
                                     symbol: command.symbol, completion: nil, action: .selectSession(session.id))
            }
        case "worktree":
            let matches = context.worktrees.filter { worktree in
                (project.map { worktree.repo == $0.name || $0.contains(worktree.path) } ?? true)
                    && (argument.isEmpty || "\(worktree.branch) \(worktree.name)".localizedCaseInsensitiveContains(argument))
            }
            return matches.prefix(10).map { worktree in
                HubPaletteSuggestion(id: "wt-\(worktree.path)", title: worktree.branch, subtitle: worktree.path, symbol: command.symbol,
                                     completion: "\(prefix)worktree \(worktree.branch)", action: .selectWorktree(worktree.path))
            }
        case "grep":
            return [HubPaletteSuggestion(id: "grep", title: argument.isEmpty ? "Find in files…" : "Find “\(argument)” in files\(where_)", subtitle: path, symbol: command.symbol,
                                         completion: nil, action: .findInFiles(argument, root: project?.path))]
        case "history":
            return [HubPaletteSuggestion(id: "history", title: argument.isEmpty ? "Search session history…" : "Search history for “\(argument)”", subtitle: "tools claude history",
                                         symbol: command.symbol, completion: nil, action: .historySearch(argument))]
        case "file":
            guard !argument.isEmpty else { return [keywordRow(command, project: project, completion: nil)] }
            return [HubPaletteSuggestion(id: "file", title: "Show \(argument)", subtitle: "in Changes", symbol: command.symbol, completion: nil, action: .reveal(argument))]
        case "cursor", "terminal", "new":
            guard let path else {
                return [HubPaletteSuggestion(id: "no-path", title: "Name a project first: gt \(command.word)", subtitle: nil, symbol: "questionmark.circle")]
            }
            let action: HubPaletteAction = command.word == "cursor" ? .openCursor(path) : command.word == "terminal" ? .openTerminal(path) : .newSession(path)
            let verb = command.word == "cursor" ? "Open in Cursor" : command.word == "terminal" ? "Open in a new cmux workspace" : "New session"
            return [HubPaletteSuggestion(id: command.word, title: "\(verb)\(where_)", subtitle: path, symbol: command.symbol, completion: nil, action: action)]
        case "review":
            return [HubPaletteSuggestion(id: "review", title: "Review the selected PR with an agent", subtitle: nil, symbol: command.symbol, completion: nil, action: .reviewWithAgent)]
        case "pane":
            return HubTab.allCases.filter { argument.isEmpty || $0.rawValue.hasPrefix(argument.lowercased()) }.map { tab in
                HubPaletteSuggestion(id: "pane-\(tab.rawValue)", title: "Show or hide \(tab.title)", subtitle: nil, symbol: tab.symbol,
                                     completion: "pane \(tab.rawValue)", action: .togglePane(tab))
            }
        case "mode":
            return HubMode.allCases.filter { argument.isEmpty || $0.rawValue.hasPrefix(argument.lowercased()) }.map { mode in
                HubPaletteSuggestion(id: "mode-\(mode.rawValue)", title: "Show \(mode.title)", subtitle: nil, symbol: command.symbol,
                                     completion: "mode \(mode.rawValue)", action: .setMode(mode))
            }
        default:
            return [HubPaletteSuggestion(id: "glass", title: "Turn glass on or off", subtitle: nil, symbol: command.symbol, completion: nil, action: .toggleGlass)]
        }
    }

    private static func keywordRow(_ keyword: Keyword, project: HubPaletteProject?, completion: String?) -> HubPaletteSuggestion {
        HubPaletteSuggestion(id: "kw-\(keyword.word)", title: project.map { "\($0.name) \(keyword.word)" } ?? keyword.word, subtitle: keyword.summary,
                             symbol: keyword.symbol, completion: completion)
    }

    private static func projectRow(_ project: HubPaletteProject, completion: String) -> HubPaletteSuggestion {
        HubPaletteSuggestion(id: "project-\(project.path)", title: project.name, subtitle: project.path, symbol: "folder", completion: completion)
    }

    /// One project per repository name, from the sessions' folders and the discovered worktrees.
    static func projects(sessions: [HubSession], worktrees: [HubWorktree]) -> [HubPaletteProject] {
        var byName: [String: String] = [:]
        for worktree in worktrees where worktree.isMain || byName[worktree.repo] == nil {
            byName[worktree.repo] = worktree.path
        }
        for session in sessions where !session.cwd.isEmpty {
            let root = projectRoot(of: session.cwd)
            let name = (root as NSString).lastPathComponent
            if byName[name] == nil {
                byName[name] = root
            }
        }
        return byName.map { HubPaletteProject(name: $0.key, path: $0.value) }.sorted { $0.name < $1.name }
    }
}

// MARK: - View

struct HubPaletteView: View {
    @Binding var isPresented: Bool
    let context: HubPaletteContext
    var initialQuery = ""
    let run: (HubPaletteAction) -> Void

    @State private var query = ""
    @State private var rows: [HubPaletteSuggestion] = []
    @State private var active = 0
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { close() }
                .accessibilityHidden(true)
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text(verbatim: "⌘K")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(Color.jarvisTeal.opacity(0.85))
                    TextField("gt pr 424 · session hub · grep FocusBridge · history resize", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundColor(.settingsText)
                        .focused($focused)
                        .onSubmit { runActive() }
                        .accessibilityIdentifier("hub-palette-input")
                    Text(verbatim: "tab completes · esc")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.settingsTextMuted)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                Divider().background(Color.jarvisBorder)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                                paletteRow(row, index: index).id(row.id)
                            }
                        }
                        .padding(6)
                    }
                    .frame(maxHeight: 380)
                    .onChange(of: active) { _, index in
                        if rows.indices.contains(index) { proxy.scrollTo(rows[index].id) }
                    }
                }
            }
            .frame(width: 620)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.settingsBackground))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.jarvisTeal.opacity(0.28), lineWidth: 1))
            .shadow(color: Color.jarvisTeal.opacity(0.12), radius: 28, y: 12)
            .padding(.top, 90)
        }
        .onAppear {
            query = initialQuery
            refresh()
            focused = true
        }
        .onChange(of: query) { refresh(resetSelection: true) }
        // The session list and PRs can land after the palette opened (a launch with --palette).
        .onChange(of: context.signature) { refresh() }
        .onExitCommand { close() }
        .panelFindModal()
        .background(HubPaletteKeys(onUp: { move(-1) }, onDown: { move(1) }, onTab: complete, onEscape: close))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Command palette"))
    }

    private func paletteRow(_ row: HubPaletteSuggestion, index: Int) -> some View {
        let isActive = index == active
        return Button {
            active = index
            runActive()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: row.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(isActive ? .jarvisTeal : .settingsTextMuted)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: row.title)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.settingsText)
                        .lineLimit(1)
                    if let subtitle = row.subtitle {
                        Text(verbatim: subtitle)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(.settingsTextMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 8)
                if row.action == nil, row.completion != nil {
                    Text(verbatim: "tab")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(.settingsTextMuted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(isActive ? Color.jarvisTeal.opacity(0.12) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .onHover { inside in
            if inside { active = index }
        }
        .accessibilityIdentifier("hub-palette-row-\(row.id)")
    }

    /// New text starts at the best match again; only a change of the hub's state underneath keeps
    /// the row the keyboard moved to (Return must never run a row picked for an older query).
    private func refresh(resetSelection: Bool = false) {
        rows = HubPaletteEngine.suggestions(for: query, context: context)
        active = resetSelection ? 0 : min(active, max(0, rows.count - 1))
    }

    private func move(_ delta: Int) {
        guard !rows.isEmpty else { return }
        active = (active + delta + rows.count) % rows.count
    }

    private func complete() {
        guard rows.indices.contains(active), let completion = rows[active].completion else { return }
        query = completion
    }

    private func runActive() {
        guard rows.indices.contains(active) else { return }
        let row = rows[active]
        if let action = row.action {
            HubPerf.log("palette.run \(row.id) from “\(query)”")
            close()
            run(action)
        } else {
            complete()
        }
    }

    private func close() {
        isPresented = false
        query = ""
        active = 0
    }
}

/// Arrow keys, Tab and Escape while the palette's field has focus (a TextField keeps them otherwise).
private struct HubPaletteKeys: NSViewRepresentable {
    var onUp: () -> Void
    var onDown: () -> Void
    var onTab: () -> Void
    var onEscape: () -> Void

    func makeNSView(context: Context) -> NSView {
        context.coordinator.handlers = self
        context.coordinator.start()
        return NSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.handlers = self
    }

    static func dismantleNSView(_ nsView: NSView, coordinator: Coordinator) {
        coordinator.stop()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var handlers: HubPaletteKeys?
        private var monitor: Any?

        func start() {
            guard monitor == nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let handlers = self?.handlers else { return event }
                switch event.keyCode {
                case 126: handlers.onUp(); return nil
                case 125: handlers.onDown(); return nil
                case 48: handlers.onTab(); return nil
                case 53: handlers.onEscape(); return nil
                default: return event
                }
            }
        }

        func stop() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
            monitor = nil
        }
    }
}
