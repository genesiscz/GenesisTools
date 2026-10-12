import SwiftUI

@MainActor
public struct FlowTransformSettingsView: View {
    private let tools: FlowTransformTools
    @ObservedObject private var configuration: FlowFocusConfiguration
    @State private var choices: FlowTransformChoices?
    @State private var providerID = ""
    @State private var accountID = ""
    @State private var modelID = ""
    @State private var failure: String?
    @State private var loading = false
    /// The model reference client.json holds, to tell an unsaved choice from the saved one. Read from the observed
    /// configuration, so a write from another window, or one that failed and was rolled back, shows at once.
    private var savedRef: String { tools.modelRef }
    /// The reference a save just wrote, for the two seconds "Saved" stays up. "Saved" is derived from it
    /// (`confirmsSave`), so it goes as soon as the choice on screen is another one.
    @State private var justSavedRef: String?
    @State private var saving = false

    public init(tools: FlowTransformTools) {
        self.tools = tools
        configuration = tools.configuration
    }

    private var provider: FlowTransformChoices.Provider? {
        choices?.providers.first { $0.id == providerID }
    }

    public var body: some View {
        VStack(spacing: 18) {
            NativeSettingsCard("Text transforms", subtitle: "Rewrite only when you choose a transform. Your existing AI account handles the request.") {
                if loading { ProgressView().controlSize(.small) }
                NativeSettingsRow("Provider") {
                    Picker("Transform provider", selection: $providerID) {
                        Text("Choose a provider").tag("")
                        ForEach(choices?.providers ?? []) { item in Text(item.title).tag(item.id) }
                    }.labelsHidden().frame(width: 230, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Account") {
                    Picker("Transform account", selection: $accountID) {
                        Text("Choose an account").tag("")
                        ForEach(provider?.accounts ?? []) { account in Text(account.name).tag(account.id) }
                        if !accountID.isEmpty, provider?.accounts.contains(where: { $0.id == accountID }) != true {
                            Text("Unavailable — select another account").tag(accountID)
                        }
                    }.labelsHidden().frame(width: 230, alignment: .trailing)
                }
                Divider()
                NativeSettingsRow("Model", detail: "Choose a supported model or enter its exact model ID.") {
                    TextField("Model ID", text: $modelID).textFieldStyle(.roundedBorder).frame(width: 200)
                    Menu("Choose") {
                        ForEach(provider?.models ?? []) { model in
                            Button(model.title) { modelID = model.id }
                        }
                    }.disabled(provider?.models.isEmpty != false)
                }
                Divider()
                HStack {
                    if choices?.providers.isEmpty == true {
                        Text("Add an enabled chat account in AI account settings first.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if Self.confirmsSave(displayed: displayedRef, saved: savedRef, justSaved: justSavedRef) {
                        Label("Saved", systemImage: "checkmark").font(.caption).foregroundStyle(.secondary)
                    } else if hasUnsavedChoice {
                        Text("Not saved yet. Press Save to use this account and model.")
                            .font(.caption).foregroundStyle(.orange)
                    }
                    Spacer()
                    Button(saving ? "Saving…" : "Save", action: save)
                        .buttonStyle(.borderedProminent)
                        .disabled(saving || !canSave || !hasUnsavedChoice)
                        .accessibilityIdentifier("flow.transforms.save")
                }
            }
            if let message = failure ?? configuration.lastError {
                Text(message).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                Button("Reload choices") { Task { await load() } }.buttonStyle(.bordered)
            }
        }
        .task { await load() }
        .onChange(of: providerID) { old, new in
            guard old != new, provider?.accounts.contains(where: { $0.id == accountID }) != true else { return }
            accountID = ""
            modelID = ""
        }
    }

    private var trimmedModel: String { modelID.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        provider?.accounts.contains(where: { $0.id == accountID }) == true && !trimmedModel.isEmpty
    }

    /// The reference the account and model on screen would be stored as; nil while the choice is incomplete.
    private var displayedRef: String? {
        canSave ? "@account/\(accountID):\(trimmedModel)" : nil
    }

    private var hasUnsavedChoice: Bool {
        displayedRef.map { $0 != savedRef } ?? false
    }

    /// Whether the footer says "Saved": the choice on screen is the one just written and still the stored one. A
    /// change of account or model during the confirmation, or a write from another window, ends it at once.
    static func confirmsSave(displayed: String?, saved: String, justSaved: String?) -> Bool {
        guard let displayed, let justSaved else { return false }
        return displayed == justSaved && saved == justSaved
    }

    /// "Saved" only after the write landed. A refused or failed write keeps the choice unsaved, so Save stays on to
    /// retry, and `configuration.lastError` (shown below the card) says why.
    private func save() {
        let account = accountID
        let model = trimmedModel
        let ref = "@account/\(account):\(model)"
        saving = true
        Task { @MainActor in
            let saved = await tools.save(accountID: account, model: model)
            saving = false
            guard saved else { return }
            justSavedRef = ref
            try? await Task.sleep(for: .seconds(2))
            if justSavedRef == ref { justSavedRef = nil }
        }
    }

    private func load() async {
        loading = true
        failure = nil
        defer { loading = false }
        do {
            let loaded = try await tools.choices()
            try Task.checkCancellation()
            choices = loaded
            let ref = tools.modelRef
            if ref.hasPrefix("@account/"), let split = ref.firstIndex(of: ":") {
                accountID = String(ref[ref.index(ref.startIndex, offsetBy: 9) ..< split])
                modelID = String(ref[ref.index(after: split)...])
                providerID = loaded.providers.first { $0.accounts.contains(where: { $0.id == accountID }) }?.id ?? ""
            }
        } catch {
            if !Task.isCancelled { failure = error.localizedDescription }
        }
    }
}
