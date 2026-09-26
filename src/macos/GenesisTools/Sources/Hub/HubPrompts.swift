import Foundation
import SwiftUI

// ⌘⇧P: the prompt library. Saved prompts with `{{variables}}` live in `~/.genesis-tools/hub/prompts.json`
// and come from `tools hub prompts list --json` (src/hub/lib/prompts.ts), most used first. Picking one
// shows its variables, filled from the selected session (its branch, the branch's PR, the file open in
// its diff); Send runs `tools hub prompts send <name> --session <id> --var k=v…`, which renders the text
// again and types it into the session's cmux pane through `tools claude cmux send` (a multi-line text
// goes into a file and a one-line pointer is typed). The preview here is only a preview.

enum PromptTemplate {
    // swiftlint:disable:next force_try
    private static let pattern = try! NSRegularExpression(pattern: "\\{\\{\\s*([A-Za-z_][\\w.-]*)\\s*\\}\\}")

    /// Each variable once, in the order it first appears (the same rule as `promptVariables`).
    static func variables(_ text: String) -> [String] {
        var names: [String] = []
        let range = NSRange(text.startIndex..., in: text)
        for match in pattern.matches(in: text, range: range) {
            if let name = Range(match.range(at: 1), in: text).map({ String(text[$0]) }), !names.contains(name) {
                names.append(name)
            }
        }
        return names
    }

    /// Every variable with a non-empty value filled; the rest stay as written.
    static func render(_ text: String, _ values: [String: String]) -> String {
        var result = ""
        var cursor = text.startIndex
        let range = NSRange(text.startIndex..., in: text)
        for match in pattern.matches(in: text, range: range) {
            guard let whole = Range(match.range, in: text), let name = Range(match.range(at: 1), in: text) else { continue }
            result += text[cursor..<whole.lowerBound]
            let value = values[String(text[name])] ?? ""
            result += value.isEmpty ? String(text[whole]) : value
            cursor = whole.upperBound
        }
        result += text[cursor...]
        return result
    }

    /// `--var k=v` pairs for the variables the prompt uses and the form filled.
    static func varArgs(_ variables: [String], _ values: [String: String]) -> [String] {
        variables.compactMap { name in
            guard let value = values[name]?.trimmed, !value.isEmpty else { return nil }
            return "--var=\(name)=\(value)"
        }
    }
}

struct HubPrompt: Decodable, Identifiable, Hashable {
    let name: String
    let text: String
    let description: String?
    let uses: Int
    let lastUsedAt: String?
    let createdAt: String
    let variables: [String]

    var id: String { name }
}

struct PromptSendResult: Decodable {
    let name: String
    let session: String
    let text: String
    let typed: String
    let mode: String
    let file: String?
    let filled: [String]
    let sent: Bool
    let dryRun: Bool
}

/// `{error, code, missing}`: what every `tools hub prompts … --json` prints on a failure.
struct PromptCLIError: Decodable, Error, CustomStringConvertible {
    let error: String
    let code: String
    let missing: [String]?

    var description: String { error }
}

/// What the picker fills variables from: the selected session and what the hub knows about it.
struct PromptContext: Equatable {
    var sessionId: String?
    var sessionTitle: String?
    var values: [String: String] = [:]
}

extension HubModel {
    /// The selected session's branch, its PR (from `RepoFactsStore`, fetched in the background), its
    /// folder and the file open in its diff.
    @MainActor
    var promptContext: PromptContext {
        guard let session = selected else { return PromptContext() }
        var values: [String: String] = ["session": session.sessionId]
        if !session.cwd.isEmpty {
            values["cwd"] = session.cwd
            let facts = RepoFactsStore.shared.facts(for: session.cwd, pr: true)
            if let branch = session.gitBranch ?? facts?.branch {
                values["branch"] = branch
            }
            if let number = facts?.pr?.number {
                values["pr"] = String(number)
            }
            if let root = facts?.root {
                values["project"] = (root as NSString).lastPathComponent
            }
        }
        if let review, let id = review.selectedID, let file = review.files.first(where: { $0.id == id }) {
            values["file"] = file.path
        }
        return PromptContext(sessionId: session.sessionId, sessionTitle: session.displayTitle, values: values)
    }
}

@MainActor
final class PromptLibraryStore: ObservableObject {
    static let shared = PromptLibraryStore()

    @Published private(set) var prompts: [HubPrompt] = []
    @Published private(set) var loading = false
    @Published private(set) var busy = false

    nonisolated private static func runCLI(_ args: [String]) throws -> Data {
        let capture = try ToolsCLIRunner.capture(args)
        if capture.status != 0 {
            if let failure = try? JSONDecoder().decode(PromptCLIError.self, from: capture.stdout) {
                throw failure
            }
            throw ReviewError.git("tools \(args.prefix(3).joined(separator: " ")) exited \(capture.status): \(String(decoding: capture.stderr, as: UTF8.self).trimmed.suffix(300))")
        }
        return capture.stdout
    }

    func load() async {
        guard !loading else { return }
        loading = true
        let span = HubPerf.begin("prompts.list", awaits: true)
        let result = await Task.detached(priority: .userInitiated) { () -> Result<[HubPrompt], Error> in
            Result { try JSONDecoder().decode([HubPrompt].self, from: Self.runCLI(["hub", "prompts", "list", "--json"])) }
        }.value
        loading = false
        switch result {
        case .success(let list):
            span.end("\(list.count) prompts")
            prompts = list
        case .failure:
            span.end("failed")
        }
    }

    func send(_ prompt: HubPrompt, session: String, values: [String: String]) async -> Result<PromptSendResult, Error> {
        busy = true
        defer { busy = false }
        let args = ["hub", "prompts", "send", prompt.name, "--session", session, "--json"] + PromptTemplate.varArgs(prompt.variables, values)
        let span = HubPerf.begin("prompts.send", prompt.name, awaits: true)
        let result = await Task.detached(priority: .userInitiated) { () -> Result<PromptSendResult, Error> in
            Result { try JSONDecoder().decode(PromptSendResult.self, from: Self.runCLI(args)) }
        }.value
        span.end((try? result.get()).map { $0.mode } ?? "failed")
        await load()
        return result
    }

    /// The text goes after `--`, so a prompt that starts with a hyphen stays text.
    func add(name: String, text: String, description: String) async -> Error? {
        busy = true
        defer { busy = false }
        let args = ["hub", "prompts", "add", "--json"] + (description.trimmed.isEmpty ? [] : ["--description", description]) + ["--", name, text]
        let result = await Task.detached(priority: .userInitiated) { () -> Error? in
            do {
                _ = try Self.runCLI(args)
                return nil
            } catch {
                return error
            }
        }.value
        await load()
        return result
    }

    func remove(_ prompt: HubPrompt) async -> Error? {
        let args = ["hub", "prompts", "remove", "--json", "--", prompt.name]
        let result = await Task.detached(priority: .userInitiated) { () -> Error? in
            do {
                _ = try Self.runCLI(args)
                return nil
            } catch {
                return error
            }
        }.value
        await load()
        return result
    }
}

/// ⌘⇧P on the hub's root: a hidden button that opens the picker over the window.
private struct HubPromptsModifier: ViewModifier {
    @ObservedObject var model: HubModel
    @State private var open = false

    func body(content: Content) -> some View {
        content
            .background(
                Button("") { open.toggle() }
                    .keyboardShortcut("p", modifiers: [.command, .shift])
                    .opacity(0)
                    .accessibilityHidden(true)
            )
            .overlay {
                if open {
                    PromptPickerView(isPresented: $open, context: model.promptContext)
                }
            }
    }
}

extension View {
    func hubPrompts(model: HubModel) -> some View {
        modifier(HubPromptsModifier(model: model))
    }
}

struct PromptPickerView: View {
    @Binding var isPresented: Bool
    let context: PromptContext
    @ObservedObject private var store = PromptLibraryStore.shared
    @State private var query = ""
    @State private var active = 0
    @State private var chosen: HubPrompt?
    @State private var values: [String: String] = [:]
    @State private var notice: (text: String, isError: Bool)?
    @State private var composing = false
    @State private var newName = ""
    @State private var newText = ""
    @State private var newDescription = ""
    @FocusState private var searchFocused: Bool

    private var matches: [HubPrompt] {
        let needle = query.trimmed.lowercased()
        guard !needle.isEmpty else { return store.prompts }
        return store.prompts.filter { "\($0.name) \($0.description ?? "") \($0.text)".lowercased().contains(needle) }
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { isPresented = false }
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().background(Color.jarvisBorder)
                if composing {
                    composer
                } else if let chosen {
                    form(chosen)
                } else {
                    list
                }
                if let notice {
                    NoticePill(text: notice.text, isError: notice.isError) { self.notice = nil }
                        .padding(10)
                }
            }
            .frame(width: 640)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.settingsBackground))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color.jarvisTeal.opacity(0.28), lineWidth: 1))
            .shadow(color: Color.jarvisTeal.opacity(0.12), radius: 28, y: 12)
            .padding(.top, 90)
        }
        .onAppear {
            searchFocused = true
            HubMainBusy.measure("prompts.open")
        }
        .task { await store.load() }
        .onExitCommand {
            if chosen != nil || composing {
                chosen = nil
                composing = false
            } else {
                isPresented = false
            }
        }
        .panelFindModal()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Prompt library"))
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text(verbatim: "⌘⇧P")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(Color.jarvisTeal.opacity(0.85))
            if chosen == nil && !composing {
                TextField("Search saved prompts", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundColor(.settingsText)
                    .focused($searchFocused)
                    .onSubmit { pick(active) }
                    .onKeyPress(.upArrow) { move(-1); return .handled }
                    .onKeyPress(.downArrow) { move(1); return .handled }
                    .onChange(of: query) { active = 0 }
            } else {
                Text(verbatim: composing ? "New prompt" : chosen?.name ?? "")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.settingsText)
                Spacer()
            }
            Text(verbatim: context.sessionTitle.map { "→ \($0)" } ?? "no session selected")
                .font(.system(size: 10.5))
                .foregroundColor(.settingsTextMuted)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: 200, alignment: .trailing)
                .instantTooltip(context.sessionId.map { "Sends into session \($0)" } ?? "Select a session in the Sessions list first")
            if chosen == nil && !composing {
                IconButton(systemName: "plus", tooltip: "Save a new prompt") {
                    composing = true
                    newName = ""
                    newText = ""
                    newDescription = ""
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var list: some View {
        let rows = matches
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                if rows.isEmpty {
                    Text(store.loading ? "Loading…" : "No prompt matches. + saves a new one.")
                        .font(.system(size: 12))
                        .foregroundColor(.settingsTextMuted)
                        .padding(14)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, prompt in
                    promptRow(prompt, isActive: index == active)
                        .onHover { inside in
                            if inside { active = index }
                        }
                        .rowButton { pick(index) }
                }
            }
            .padding(6)
        }
        .frame(maxHeight: 380)
    }

    private func promptRow(_ prompt: HubPrompt, isActive: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "text.quote")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(isActive ? .jarvisTeal : .settingsTextMuted)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: prompt.name).font(.system(size: 13, weight: .medium)).foregroundColor(.settingsText)
                    ForEach(prompt.variables, id: \.self) { name in
                        Text(verbatim: name)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundColor(context.values[name] == nil ? ReviewPalette.modified : .settingsTextMuted)
                            .padding(.horizontal, 5)
                            .background(Capsule().fill(Color.white.opacity(0.06)))
                    }
                }
                Text(verbatim: prompt.description ?? prompt.text)
                    .font(.system(size: 10.5))
                    .foregroundColor(.settingsTextMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 8)
            if prompt.uses > 0 {
                Text(verbatim: "\(prompt.uses)×")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(.settingsTextMuted)
                    .instantTooltip("Sent \(prompt.uses) times")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(isActive ? Color.jarvisTeal.opacity(0.12) : Color.clear))
        .contentShape(Rectangle())
    }

    private func form(_ prompt: HubPrompt) -> some View {
        let missing = prompt.variables.filter { (values[$0] ?? "").trimmed.isEmpty }
        return VStack(alignment: .leading, spacing: 10) {
            ForEach(prompt.variables, id: \.self) { name in
                HStack(spacing: 8) {
                    Text(verbatim: name)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundColor(.settingsTextMuted)
                        .frame(width: 80, alignment: .trailing)
                    TextField(name, text: Binding(get: { values[name] ?? "" }, set: { values[name] = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12))
                }
            }
            Text(verbatim: PromptTemplate.render(prompt.text, values))
                .font(.system(size: 12))
                .foregroundColor(.settingsText)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.04)))
            HStack(spacing: 10) {
                Button("Back") { chosen = nil }
                    .buttonStyle(.genHoverPlain())
                Button("Delete") {
                    Task {
                        if let error = await store.remove(prompt) {
                            notice = ("Delete failed: \(error)", true)
                        } else {
                            chosen = nil
                            notice = ("Deleted \(prompt.name)", false)
                        }
                    }
                }
                .buttonStyle(.genHoverPlain())
                .foregroundColor(ReviewPalette.removed)
                .instantTooltip("Remove this prompt from the library")
                Spacer()
                if prompt.text.contains("\n") {
                    Text("several lines: sent through a file")
                        .font(.system(size: 10.5))
                        .foregroundColor(.settingsTextMuted)
                }
                Button {
                    send(prompt)
                } label: {
                    Label(store.busy ? "Sending…" : "Send", systemImage: "paperplane")
                }
                .keyboardShortcut(.return, modifiers: [.command])
                .disabled(context.sessionId == nil || !missing.isEmpty || store.busy)
                .instantTooltip(context.sessionId == nil ? "Select a session first" : missing.isEmpty ? "Type it into the session's cmux pane (⌘↩)" : "Fill \(missing.joined(separator: ", ")) first")
            }
        }
        .padding(14)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("name (letters, digits, - _ . :)", text: $newName)
                .textFieldStyle(.roundedBorder)
            TextField("what it is for (optional)", text: $newDescription)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $newText)
                .font(.system(size: 12))
                .frame(height: 140)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.12)))
            Text("{{branch}}, {{pr}}, {{file}}, {{cwd}}, {{project}} and {{session}} fill themselves from the selected session; any other {{name}} gets a field.")
                .font(.system(size: 10.5))
                .foregroundColor(.settingsTextMuted)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("Cancel") { composing = false }
                    .buttonStyle(.genHoverPlain())
                Spacer()
                Button {
                    Task {
                        if let error = await store.add(name: newName.trimmed, text: newText, description: newDescription) {
                            notice = ("Not saved: \(error)", true)
                        } else {
                            composing = false
                            notice = ("Saved \(newName.trimmed)", false)
                        }
                    }
                } label: {
                    Label("Save", systemImage: "square.and.arrow.down")
                }
                .disabled(newName.trimmed.isEmpty || newText.trimmed.isEmpty || store.busy)
            }
        }
        .padding(14)
    }

    private func move(_ delta: Int) {
        let count = matches.count
        guard count > 0 else { return }
        active = (active + delta + count) % count
    }

    private func pick(_ index: Int) {
        let rows = matches
        guard rows.indices.contains(index) else { return }
        let prompt = rows[index]
        values = Dictionary(uniqueKeysWithValues: prompt.variables.compactMap { name in context.values[name].map { (name, $0) } })
        chosen = prompt
    }

    private func send(_ prompt: HubPrompt) {
        guard let session = context.sessionId else { return }
        Task {
            switch await store.send(prompt, session: session, values: values) {
            case .success(let result):
                notice = (result.mode == "file" ? "Sent \(result.name) through \((result.file ?? "") as NSString).lastPathComponent)" : "Sent \(result.name)", false)
                isPresented = false
            case .failure(let error):
                notice = ("Not sent: \(error)", true)
            }
        }
    }
}
