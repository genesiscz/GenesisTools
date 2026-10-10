import AppKit
import SwiftUI

public struct WidgetModuleChoice: Identifiable {
    public let id: String
    public let title: String
    public let symbol: String
    public let detail: String
    public init(id: String, title: String, symbol: String, detail: String) {
        self.id = id
        self.title = title
        self.symbol = symbol
        self.detail = detail
    }

    public static let agents = Self(
        id: "agents", title: "Agent Inbox", symbol: "tray.fill",
        detail: "Questions, answers, screenshots and live conversations.")
    /// Exactly the modules `WidgetCoordinator` registers. Settings offer only these, because the layout drops any
    /// configured ID the host has not registered, so a toggle for anything else would silently do nothing.
    public static let builtins: [Self] = [
        agents,
        .init(
            id: "capture", title: "Capture", symbol: "camera.viewfinder",
            detail: "Screenshots and recordings ready for your next message."),
        .init(
            id: "shelf", title: "File Shelf", symbol: "tray.full.fill",
            detail: "Keep the files you are working with within reach."),
        .init(
            id: "tasks", title: "Tasks", symbol: "checklist",
            detail: "A small, local list for the work in front of you."),
        .init(
            id: "focus", title: "Flow", symbol: "mic.circle.fill",
            detail: "Dictation, focus sessions and your Focus Studio."),
        .init(
            id: "voice", title: "Voice Notes", symbol: "mic.fill",
            detail: "Turn a spoken thought into editable text."),
    ]
}

@MainActor
public enum WidgetFeatureSettings {
    public static let hiddenNotice = "The widget is off. Turn it on to see pinned sessions at the top or side."

    public static func sections(
        model: WidgetModel, modules: [WidgetModuleChoice],
        flowRuntime: FlowFocusRuntime? = nil, transforms: FlowTransformTools? = nil,
        openSession: @escaping (WidgetSession) -> Void
    ) -> [NativeSettingsSection] {
        var dictationPages = [NativeSettingsPage(
            id: "dictation.voice", title: "Voice Notes", symbol: "recordingtape", tint: .pink,
            subtitle: "Choose the speech provider for voice notes and agent drafts.") {
                WidgetDictationSettings(model: model)
            }]
        if let flowRuntime {
            dictationPages.append(NativeSettingsPage(id: "dictation.flow", title: "Dictation", symbol: "mic",
                tint: .cyan, subtitle: "Dictate into any app with Apple Speech.") {
                    FlowSettingsView(session: flowRuntime.flow, openLibrary: { flowRuntime.showDictation() })
                })
        }
        if let transforms {
            dictationPages.append(NativeSettingsPage(id: "dictation.transforms", title: "Text transforms",
                symbol: "wand.and.stars", tint: .purple,
                subtitle: "Choose an existing AI account and model for explicit text transforms.") {
                    FlowTransformSettingsView(tools: transforms)
                })
        }
        var sections = [
            NativeSettingsSection(
                id: "widgets", title: "Widgets",
                pages: [
                    NativeSettingsPage(
                        id: "widgets.general", title: "General", symbol: "rectangle.topthird.inset.filled",
                        tint: .blue, subtitle: "Put your tools where they belong."
                    ) {
                        WidgetGeneralSettings(model: model)
                    },
                    NativeSettingsPage(
                        id: "widgets.sessions", title: "Projects / Sessions", symbol: "folder",
                        tint: .orange, subtitle: "Pin, filter and open your local sessions."
                    ) {
                        WidgetSessionSettings(model: model, openSession: openSession)
                    },
                    NativeSettingsPage(
                        id: "widgets.providers", title: "Providers", symbol: "person.2",
                        tint: .mint, subtitle: "Choose which agents appear in your inbox."
                    ) {
                        WidgetProviderSettings(model: model)
                    },
                    NativeSettingsPage(
                        id: "widgets.modules", title: "Widgets", symbol: "square.grid.2x2",
                        tint: .purple, subtitle: "Choose a different set for each edge."
                    ) {
                        WidgetModuleSettings(model: model, modules: modules)
                    },
                ], order: 30),
            NativeSettingsSection(
                id: "dictation", title: "Dictation",
                pages: dictationPages, order: 40),
        ]
        if let flowRuntime {
            sections.append(NativeSettingsSection(id: "focus", title: "Focus", pages: [
                NativeSettingsPage(id: "focus.general", title: "Focus", symbol: "timer", tint: .orange,
                    subtitle: "Timer, capture, privacy and project settings.") {
                        FocusSettingsView(controller: flowRuntime.focus, configuration: flowRuntime.configuration)
                    }
            ], order: 45))
        }
        return sections
    }
}

private struct WidgetGeneralSettings: View {
    @ObservedObject var model: WidgetModel
    @ObservedObject private var appearance = NativeSettingsAppearance.shared
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }

    var body: some View {
        VStack(spacing: 18) {
            WidgetSettingsLoading(model: model)
            WidgetSettingsError(model: model)
            if model.settingsLoaded {
            NativeSettingsCard("Placement", subtitle: "Top and side share your sessions and drafts.") {
                NativeSettingsToggle(
                    "Show the widget", detail: "Panels at the top and side of your screen.",
                    identifier: "widget.showWidget", isOn: boolean("showWidget", prefs?.showWidget ?? false))
                if model.settingsLoaded && !(prefs?.showWidget ?? false) {
                    Text(WidgetFeatureSettings.hiddenNotice).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
                NativeSettingsRow("Visible edges") {
                    Picker("Visible edges", selection: string("placement", prefs?.placement ?? "both")) {
                        Text("Both").tag("both")
                        Text("Top").tag("top")
                        Text("Side").tag("side")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Side edge") {
                    Picker("Side edge", selection: string("side", prefs?.side ?? "right")) {
                        Text("Left").tag("left")
                        Text("Right").tag("right")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 170, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Display") {
                    Picker("Display", selection: string("display", prefs?.display ?? "")) {
                        Text("Main display").tag("")
                        ForEach(NSScreen.screens, id: \.self) { screen in
                            Text(screen.localizedName).tag(WidgetCoordinator.id(screen))
                        }
                    }.labelsHidden().frame(width: 220, alignment: .trailing)
                }
            }
            NativeSettingsCard("Side widgets") {
                NativeSettingsRow("Arrangement", detail: "Three groups can have different tools.") {
                    Picker("Side arrangement", selection: string("sideLayout", prefs?.sideLayout ?? "joined")) {
                        Text("Joined").tag("joined")
                        Text("Three bubbles").tag("separated")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Vertical position", detail: "You can also drag the handle on any side bubble.") {
                    Slider(
                        value: Binding(
                            get: { prefs?.sidePosition ?? 0.5 },
                            set: { patch(["sidePosition": .number($0)]) }), in: 0...1
                    )
                    .frame(width: 200).accessibilityLabel("Side widget vertical position")
                }
                Divider()
                NativeSettingsToggle(
                    "Hover previews", detail: "See a preview without changing keyboard focus.",
                    isOn: boolean("hoverPreviews", prefs?.hoverPreviews ?? true))
            }
            NativeSettingsCard("Shape") {
                NativeSettingsRow("Side style", detail: "Classic keeps a compact monochrome rail with its handle below.") {
                    Picker("Side style", selection: string("sideStyle", prefs?.sideStyle ?? "modular")) {
                        Text("Modular").tag("modular")
                        Text("Classic").tag("classic")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 220, alignment: .trailing)
                }
                Divider()
                NativeSettingsToggle(
                    "Join screen edges", detail: "Curved shoulders join the display. Turn off for fully rounded bubbles.",
                    isOn: boolean("joinedEdges", prefs?.joinedEdges ?? true))
            }
            NativeSettingsCard("Appearance") {
                NativeSettingsToggle(
                    "Glass effect", detail: "Use your selected theme for widget surfaces.",
                    isOn: boolean("glassEffect", prefs?.glassEffect ?? true))
                Divider()
                NativeSettingsToggle(
                    "Reduce motion", detail: "Shared with General: keeps every native window and widget still.",
                    isOn: $appearance.reduceMotion)
                Divider()
                NativeSettingsToggle(
                    "Reduce transparency", detail: "Shared with General: solid surfaces instead of glass.",
                    isOn: $appearance.reduceTransparency)
            }
            NativeSettingsCard("Inbox behavior") {
                NativeSettingsRow(
                    "Collapse when quiet", detail: "A draft, recording or active agent keeps the inbox open."
                ) {
                    Picker(
                        "Quiet timeout",
                        selection: Binding(
                            get: { prefs?.quietSeconds ?? 15 },
                            set: { patch(["quietSeconds": .number(Double($0))]) })
                    ) {
                        Text("5 seconds").tag(5)
                        Text("15 seconds").tag(15)
                        Text("30 seconds").tag(30)
                        Text("1 minute").tag(60)
                    }.labelsHidden().frame(width: 150, alignment: .trailing)
                }
                Divider()
                NativeSettingsToggle(
                    "Changed files", detail: "Show a session's working changes alongside its conversation.",
                    isOn: boolean("showChanges", prefs?.showChanges ?? true))
            }
            }
        }.task { model.refreshSettings() }
    }

    private func string(_ key: String, _ value: String) -> Binding<String> {
        Binding(get: { value }, set: { patch([key: .string($0)]) })
    }
    private func boolean(_ key: String, _ value: Bool) -> Binding<Bool> {
        Binding(get: { value }, set: { patch([key: .bool($0)]) })
    }
    private func patch(_ values: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(values)])
    }
}

/// The widget's "show only these sessions" filter: `preferences.sessions`, which the snapshot reads as an allowlist
/// (`src/hub/lib/widget/snapshot.ts`, `hiddenByFilter`). Empty means every session may appear.
public enum WidgetSessionFilter {
    public static func adding(_ key: String, to keys: [String]) -> [String] {
        keys.contains(key) ? keys : keys + [key]
    }

    public static func removing(_ key: String, from keys: [String]) -> [String] {
        keys.filter { $0 != key }
    }

    /// The preferences patch that stores `keys` as the filter.
    public static func patch(_ keys: [String]) -> [String: WidgetJSON] {
        ["sessions": .array(keys.map(WidgetJSON.string))]
    }

    /// Sessions that can still be added, newest activity first. With no query only top-level sessions are offered;
    /// a query also finds sub-agents by title, project or provider.
    public static func candidates(_ sessions: [WidgetSession], excluding keys: [String], query: String,
                                  limit: Int = 8) -> [WidgetSession] {
        let chosen = Set(keys)
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return Array(sessions
            .filter { session in
                guard !chosen.contains(session.key) else { return false }
                if needle.isEmpty { return session.agentId == nil }
                return (session.title + " " + session.project + " " + session.target.provider)
                    .localizedCaseInsensitiveContains(needle)
            }
            .sorted { $0.activityAt > $1.activityAt }
            .prefix(limit))
    }
}

private struct WidgetSessionSettings: View {
    @ObservedObject var model: WidgetModel
    let openSession: (WidgetSession) -> Void
    @State private var query = ""
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }
    private var sessions: [WidgetSession] { model.snapshot?.sessions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            NativeSettingsCard("Your sessions", subtitle: "Pin a session to keep it in the widget's rail. Click one to open it in the widget.") {
                WidgetSessionBrowser(model: model, onOpen: openSession)
            }
            filterCard
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }

    private var filterCard: some View {
        let selected = prefs?.sessions ?? []
        let projects = prefs?.projects ?? []
        return NativeSettingsCard("Show only these sessions", subtitle: "With sessions listed here, the widget shows only them. Leave the list empty to show every session.") {
            if selected.isEmpty {
                Text("Every session can appear in the widget.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            ForEach(selected, id: \.self) { key in
                let session = sessions.first { $0.key == key }
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(session?.title ?? "Session not in your recent list").font(.system(size: 13, weight: .medium))
                            .lineLimit(1)
                        Text(session.map { $0.target.provider.capitalized + " · " + $0.project } ?? key)
                            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                    IconButton(systemName: "minus.circle", tooltip: "Stop filtering to \(session?.title ?? "this session")") {
                        patch(WidgetSessionFilter.patch(WidgetSessionFilter.removing(key, from: selected)))
                    }
                }
                .padding(.vertical, 3)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("widget.sessionFilter.selected")
            }
            Divider()
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("Find a session to add", text: $query)
                    .textFieldStyle(.plain).font(.system(size: 12))
                    .accessibilityIdentifier("widget.sessionFilter.search")
                if !query.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the search") { query = "" }
                }
            }.padding(10).nativeGlassControl(radius: 10)
            let candidates = WidgetSessionFilter.candidates(sessions, excluding: selected, query: query)
            if candidates.isEmpty {
                Text(query.isEmpty ? "No other sessions to add." : "No session matches “\(query)”.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            VStack(spacing: 2) {
                ForEach(candidates) { session in
                    Button {
                        patch(WidgetSessionFilter.patch(WidgetSessionFilter.adding(session.key, to: selected)))
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "plus.circle").foregroundStyle(Color.accentColor)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                Text(session.target.provider.capitalized + " · " + session.project)
                                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverRow())
                    .nativeSettingsPointer()
                    .accessibilityLabel("Show only " + session.title)
                }
            }
            Divider()
            HStack {
                Text(filterSummary(sessions: selected.count, projects: projects.count))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Button("Clear all filters") { patch(["projects": [], "sessions": []]) }
                    .buttonStyle(.bordered)
                    .disabled(selected.isEmpty && projects.isEmpty)
                    .nativeSettingsPointer()
                    .accessibilityIdentifier("widget.filters.clear")
            }
        }
    }

    private func filterSummary(sessions: Int, projects: Int) -> String {
        switch (sessions, projects) {
        case (0, 0): return "No filters. Use Project filters above to limit the widget to some projects."
        case (_, 0): return sessions == 1 ? "1 session chosen." : "\(sessions) sessions chosen."
        case (0, _): return projects == 1 ? "1 project filter is on." : "\(projects) project filters are on."
        default: return "\(sessions) sessions and \(projects) project filters chosen."
        }
    }

    private func patch(_ values: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(values)])
    }
}

private struct WidgetProviderSettings: View {
    @ObservedObject var model: WidgetModel
    private let providers = ["claude", "codex", "grok", "unknown"]
    private var selected: [String] { model.snapshot?.state.preferences.providers ?? [] }
    var body: some View {
        VStack(spacing: 18) {
        WidgetSettingsLoading(model: model)
        if model.settingsLoaded {
        NativeSettingsCard("Coding agents", subtitle: "An empty filter shows every supported source.") {
            ForEach(providers, id: \.self) { provider in
                if provider != providers.first { Divider() }
                NativeSettingsToggle(
                    provider == "unknown" ? "External questions and answers" : provider.capitalized,
                    detail: provider == "unknown"
                        ? "Questions and answers from agents this app does not recognise, posted through the answer tool."
                        : nil,
                    identifier: "widget.provider.\(provider)",
                    isOn: Binding(
                        get: { selected.isEmpty || selected.contains(provider) },
                        set: { enabled in
                            var values = selected.isEmpty ? providers : selected
                            if enabled {
                                if !values.contains(provider) { values.append(provider) }
                            } else {
                                values.removeAll { $0 == provider }
                            }
                            if values.isEmpty {
                                model.error = "Keep at least one source enabled."
                                return
                            }
                            model.action([
                                "action": "preferences", "patch": ["providers": .array(values.map(WidgetJSON.string))],
                            ])
                        }))
            }
            Divider()
            Button("Show all providers") {
                model.action(["action": "preferences", "patch": ["providers": []]])
            }.buttonStyle(.bordered).nativeSettingsPointer().disabled(selected.isEmpty)
            WidgetSettingsError(model: model)
        }
        }
        }.task { model.refreshSettings() }
    }
}

private struct WidgetModuleSettings: View {
    @ObservedObject var model: WidgetModel
    let modules: [WidgetModuleChoice]
    var body: some View {
        VStack(spacing: 18) {
            WidgetSettingsLoading(model: model)
            if model.settingsLoaded {
                group("Top notch", index: nil)
                ForEach(0..<3) { index in group("Side group \(index + 1)", index: index) }
            }
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }
    private func group(_ title: String, index: Int?) -> some View {
        NativeSettingsCard(title) {
            ForEach(modules) { module in
                let selected = index.map { model.layout.sideGroups[$0] } ?? model.layout.topModules
                NativeSettingsToggle(
                    module.title, detail: module.detail,
                    // One identifier per edge group: the same module appears in four cards on this page.
                    identifier: "widget.modules.\(index.map { "side\($0 + 1)" } ?? "top").\(module.id)",
                    isOn: Binding(
                        get: { selected.contains(module.id) },
                        set: { enabled in
                            var ids = selected
                            if enabled { ids.append(module.id) } else { ids.removeAll { $0 == module.id } }
                            if let index {
                                var groups = model.layout.sideGroups
                                groups[index] = WidgetLayoutConfiguration.unique(ids)
                                model.action([
                                    "action": "preferences",
                                    "patch": [
                                        "sideGroups": .array(groups.map { .array($0.map(WidgetJSON.string)) })
                                    ],
                                ])
                            } else {
                                model.action([
                                    "action": "preferences",
                                    "patch": [
                                        "topModules": .array(
                                            WidgetLayoutConfiguration.unique(ids).map(WidgetJSON.string))
                                    ],
                                ])
                            }
                        }))
            }
        }
    }
}

private struct VoiceConfiguration: Decodable {
    struct Provider: Decodable, Identifiable {
        struct Account: Decodable, Identifiable {
            var id: String
            var name: String
        }
        var id: String
        var title: String
        var defaultModel: String
        var models: [String]
        var accounts: [Account]
    }
    var providers: [Provider]
}

private struct WidgetDictationSettings: View {
    @ObservedObject var model: WidgetModel
    @State private var configuration: VoiceConfiguration?
    @State private var loading = false
    @State private var failure: String?
    @State private var language = ""
    @State private var languageSaved = false
    @FocusState private var languageFocused: Bool
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }
    private var provider: VoiceConfiguration.Provider? {
        configuration?.providers.first { $0.id == prefs?.voiceProvider }
    }

    var body: some View {
        VStack(spacing: 18) {
            WidgetSettingsLoading(model: model)
            if model.settingsLoaded {
            NativeSettingsCard("Live dictation", subtitle: "Text stays editable before you send it to an agent.") {
                if loading { ProgressView().controlSize(.small) }
                if let failure {
                    Text(failure).foregroundStyle(.orange).font(.caption)
                    Button("Try again") { Task { await load() } }.buttonStyle(.bordered)
                }
                NativeSettingsRow("Provider") {
                    Picker(
                        "Dictation provider",
                        selection: Binding(
                            get: { prefs?.voiceProvider ?? "xai" },
                            set: { patch(["voiceProvider": .string($0), "voiceAccount": .null, "voiceModel": .null]) })
                    ) {
                        ForEach(configuration?.providers ?? []) { item in Text(item.title).tag(item.id) }
                        // The stored choice stays visible while the provider list loads or when it is not offered.
                        if let current = prefs?.voiceProvider,
                            configuration?.providers.contains(where: { $0.id == current }) != true
                        {
                            Text(current).tag(current)
                        }
                    }.labelsHidden().frame(width: 230, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Account", detail: "Uses your existing enabled API accounts.") {
                    Picker(
                        "Dictation account",
                        selection: Binding(
                            get: { prefs?.voiceAccount ?? "" },
                            set: { patch(["voiceAccount": $0.isEmpty ? .null : .string($0)]) })
                    ) {
                        Text("Provider default").tag("")
                        ForEach(provider?.accounts ?? []) { item in Text(item.name).tag(item.id) }
                        if let missing = prefs?.voiceAccount,
                            provider?.accounts.contains(where: { $0.id == missing }) != true
                        {
                            Text("Unavailable — select another account").tag(missing)
                        }
                    }.labelsHidden().frame(width: 230, alignment: .trailing)
                }
                if provider?.accounts.isEmpty == true {
                    Text("No enabled API account for this provider. Add one in the Hub's AI account settings.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Divider()
                NativeSettingsRow("Model") {
                    Picker(
                        "Dictation model",
                        selection: Binding(
                            get: { prefs?.voiceModel ?? "" },
                            set: { patch(["voiceModel": $0.isEmpty ? .null : .string($0)]) })
                    ) {
                        Text(provider.map { "Default · " + $0.defaultModel } ?? "Provider default").tag("")
                        ForEach(provider?.models ?? [], id: \.self) { Text($0).tag($0) }
                        if let custom = prefs?.voiceModel, provider?.models.contains(custom) != true {
                            Text(custom).tag(custom)
                        }
                    }.labelsHidden().frame(width: 280, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Language", detail: "A language code such as en or cs. Leave empty to detect it. Saved when you press Return or leave the field.") {
                    HStack(spacing: 8) {
                        if languageSaved {
                            Label("Saved", systemImage: "checkmark").font(.system(size: 11)).foregroundStyle(.secondary)
                                .transition(.opacity)
                        }
                        TextField("Automatic", text: $language).textFieldStyle(.roundedBorder).frame(width: 130)
                            .focused($languageFocused)
                            .onSubmit(saveLanguage)
                            .accessibilityIdentifier("widget.voiceLanguage")
                    }
                }
            }
            }
            WidgetSettingsError(model: model)
        }.task {
            model.refreshSettings()
            language = prefs?.voiceLanguage ?? ""
            await load()
        }
        .onChange(of: prefs?.voiceLanguage) { _, value in
            if !languageFocused { language = value ?? "" }
        }
        .onChange(of: languageFocused) { _, focused in
            if !focused { saveLanguage() }
        }
    }

    /// Stores the field when it changed, on Return or when focus leaves it, and confirms it for two seconds.
    private func saveLanguage() {
        let value = language.trimmingCharacters(in: .whitespaces)
        language = value
        guard value != (prefs?.voiceLanguage ?? "") else { return }
        patch(["voiceLanguage": .string(value)])
        withAnimation(.easeOut(duration: 0.15)) { languageSaved = true }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.easeOut(duration: 0.3)) { languageSaved = false }
        }
    }

    private func load() async {
        loading = true
        failure = nil
        defer { loading = false }
        do {
            let result = try await model.bridge.run(
                subcommand: "voice", args: ["configuration", "--json"], timeoutSeconds: 20)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
            guard !Task.isCancelled else { return }
            configuration = try JSONDecoder().decode(VoiceConfiguration.self, from: Data(result.stdout.utf8))
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
    private func patch(_ value: [String: WidgetJSON]) {
        model.action(["action": "preferences", "patch": .object(value)])
    }
}

/// Stands in for the controls until the first snapshot with the stored preferences arrives, so a page never shows
/// the defaults as if they were your settings. A failed load offers a retry.
private struct WidgetSettingsLoading: View {
    @ObservedObject var model: WidgetModel
    var body: some View {
        if !model.settingsLoaded {
            HStack(spacing: 10) {
                if model.error == nil {
                    ProgressView().controlSize(.small)
                    Text("Loading your widget settings…").font(.system(size: 12)).foregroundStyle(.secondary)
                } else {
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                    Text("Your widget settings could not be read.").font(.system(size: 12))
                }
                Spacer(minLength: 0)
                if model.error != nil {
                    Button("Try again") {
                        model.error = nil
                        model.refreshSettings()
                    }
                    .buttonStyle(.bordered).nativeSettingsPointer()
                }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .nativeGlassSurface()
            .accessibilityIdentifier("widget.settings.loading")
        }
    }
}

private struct WidgetSettingsError: View {
    @ObservedObject var model: WidgetModel
    var body: some View {
        if let error = model.error {
            HStack {
                Image(systemName: "exclamationmark.triangle")
                Text(error).font(.caption).textSelection(.enabled)
                Spacer()
                Button("Dismiss") { model.error = nil }
            }.padding(10).background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
