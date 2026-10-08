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
        id: "agents", title: "Agent Inbox", symbol: "bubble.left.and.bubble.right.fill",
        detail: "Questions, answers, screenshots and live conversations.")
    /// Exactly the modules `WidgetCoordinator` registers. Settings offer only these, because the layout drops any
    /// configured ID the host has not registered, so a toggle for anything else would silently do nothing.
    public static let builtins: [Self] = [agents]
}

@MainActor
public enum WidgetFeatureSettings {
    public static let hiddenNotice = "The widget is off. Turn it on to see pinned sessions at the top or side."

    public static func sections(
        model: WidgetModel, modules: [WidgetModuleChoice],
        openSession: @escaping (WidgetSession) -> Void
    ) -> [NativeSettingsSection] {
        [
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
                    NativeSettingsPage(
                        id: "widgets.plugins", title: "Plugins", symbol: "puzzlepiece.extension",
                        tint: .teal, subtitle: "Extra tools for your widget surfaces."
                    ) {
                        NativeSettingsCard("Built-in widgets") {
                            ForEach(modules) { module in
                                Label(module.title, systemImage: module.symbol)
                                    .font(.system(size: 13)).frame(maxWidth: .infinity, alignment: .leading)
                            }
                            Divider()
                            Text("No third-party widget plugins are installed.")
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                        }
                    },
                ], order: 30),
            NativeSettingsSection(
                id: "dictation", title: "Dictation",
                pages: [
                    NativeSettingsPage(
                        id: "dictation.voice", title: "Dictation", symbol: "waveform",
                        tint: .pink, subtitle: "Your voice, with the provider and account you choose."
                    ) {
                        WidgetDictationSettings(model: model)
                    }
                ], order: 40),
        ]
    }
}

private struct WidgetGeneralSettings: View {
    @ObservedObject var model: WidgetModel
    @ObservedObject private var appearance = NativeSettingsAppearance.shared
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }

    var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Placement", subtitle: "Top and side share your sessions and drafts.") {
                NativeSettingsToggle(
                    "Show the widget", detail: "Panels at the top and side of your screen.",
                    identifier: "widget.showWidget", isOn: boolean("showWidget", prefs?.showWidget ?? false))
                if !(prefs?.showWidget ?? false) {
                    Text(WidgetFeatureSettings.hiddenNotice).font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
                NativeSettingsRow("Visible edges") {
                    Picker("Visible edges", selection: string("placement", prefs?.placement ?? "both")) {
                        Text("Both").tag("both")
                        Text("Top").tag("top")
                        Text("Side").tag("side")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250)
                }
                Divider()
                NativeSettingsRow("Side edge") {
                    Picker("Side edge", selection: string("side", prefs?.side ?? "right")) {
                        Text("Left").tag("left")
                        Text("Right").tag("right")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 170)
                }
                Divider()
                NativeSettingsRow("Display") {
                    Picker("Display", selection: string("display", prefs?.display ?? "")) {
                        Text("Main display").tag("")
                        ForEach(NSScreen.screens, id: \.self) { screen in
                            Text(screen.localizedName).tag(WidgetCoordinator.id(screen))
                        }
                    }.labelsHidden().frame(width: 220)
                }
            }
            NativeSettingsCard("Side widgets") {
                NativeSettingsRow("Arrangement", detail: "Three groups can have different tools.") {
                    Picker("Side arrangement", selection: string("sideLayout", prefs?.sideLayout ?? "joined")) {
                        Text("Joined").tag("joined")
                        Text("Three bubbles").tag("separated")
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 250)
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
                    }.labelsHidden().pickerStyle(.segmented).frame(width: 220)
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
                NativeSettingsToggle("Reduce motion", isOn: $appearance.reduceMotion)
                Divider()
                NativeSettingsToggle("Opaque surfaces", isOn: $appearance.reduceTransparency)
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
                    }.labelsHidden().frame(width: 150)
                }
                Divider()
                NativeSettingsToggle(
                    "Changed files", detail: "Show a session's working changes alongside its conversation.",
                    isOn: boolean("showChanges", prefs?.showChanges ?? true))
            }
        }.task { model.refreshSettings() }
            .overlay(alignment: .bottom) { WidgetSettingsError(model: model) }
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

private struct WidgetSessionSettings: View {
    @ObservedObject var model: WidgetModel
    let openSession: (WidgetSession) -> Void
    var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard {
                WidgetSessionBrowser(model: model, onOpen: openSession)
            }
            Button("Reset project and session filters") {
                model.action(["action": "preferences", "patch": ["projects": [], "sessions": []]])
            }.buttonStyle(.bordered)
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }
}

private struct WidgetProviderSettings: View {
    @ObservedObject var model: WidgetModel
    private let providers = ["claude", "codex", "grok", "unknown"]
    private var selected: [String] { model.snapshot?.state.preferences.providers ?? [] }
    var body: some View {
        NativeSettingsCard("Coding agents", subtitle: "An empty filter shows every supported source.") {
            ForEach(providers, id: \.self) { provider in
                NativeSettingsToggle(
                    provider == "unknown" ? "External questions and answers" : provider.capitalized,
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
            }.buttonStyle(.bordered)
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }
}

private struct WidgetModuleSettings: View {
    @ObservedObject var model: WidgetModel
    let modules: [WidgetModuleChoice]
    var body: some View {
        VStack(spacing: 18) {
            group("Top notch", index: nil)
            ForEach(0..<3) { index in group("Side group \(index + 1)", index: index) }
            WidgetSettingsError(model: model)
        }.task { model.refreshSettings() }
    }
    private func group(_ title: String, index: Int?) -> some View {
        NativeSettingsCard(title) {
            ForEach(modules) { module in
                let selected = index.map { model.layout.sideGroups[$0] } ?? model.layout.topModules
                NativeSettingsToggle(
                    module.title, detail: module.detail,
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
    private var prefs: WidgetPreferences? { model.snapshot?.state.preferences }
    private var provider: VoiceConfiguration.Provider? {
        configuration?.providers.first { $0.id == prefs?.voiceProvider }
    }

    var body: some View {
        VStack(spacing: 18) {
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
                    }.labelsHidden().frame(width: 230)
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
                    }.labelsHidden().frame(width: 230)
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
                    }.labelsHidden().frame(width: 280)
                }
                Divider()
                NativeSettingsRow("Language", detail: "Language codes such as en or cs. Leave empty for automatic.") {
                    TextField("Automatic", text: $language).textFieldStyle(.roundedBorder).frame(width: 130)
                        .onSubmit { patch(["voiceLanguage": .string(language.trimmingCharacters(in: .whitespaces))]) }
                    Button("Save") { patch(["voiceLanguage": .string(language.trimmingCharacters(in: .whitespaces))]) }
                        .buttonStyle(.bordered)
                }
            }
            WidgetSettingsError(model: model)
        }.task {
            model.refreshSettings()
            language = prefs?.voiceLanguage ?? ""
            await load()
        }.onChange(of: prefs?.voiceLanguage) { _, value in language = value ?? "" }
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
