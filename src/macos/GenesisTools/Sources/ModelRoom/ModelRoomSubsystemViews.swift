import AppKit
import GenesisKit
import SwiftUI

struct ModelRoomSubsystemExportSheet: View {
    @ObservedObject var model: ModelRoomModel
    @Environment(\.dismiss) private var dismiss
    @State private var original: ModelRoomFile
    @State private var members: Set<String>
    @State private var outputs: Set<String>
    @State private var label: String
    @State private var inspection: ModelRoomSubsystemInspection?
    @State private var inspectedMembers: Set<String> = []
    @State private var error: String?
    @State private var busy = false
    @State private var work: Task<Void, Never>?
    @State private var savePanel: NSSavePanel?

    init(model: ModelRoomModel, file: ModelRoomFile) {
        self.model = model
        _original = State(initialValue: file)
        let selected = file.quantities.first { $0.id == model.selectedQuantity } ?? file.quantities[0]
        _members = State(initialValue: [selected.id])
        _outputs = State(initialValue: [selected.id])
        _label = State(initialValue: selected.label)
    }

    private var selectionReady: Bool { inspection != nil && inspectedMembers == members }
    private var canSave: Bool {
        selectionReady && inspection?.missingDependencies.isEmpty == true && !outputs.isEmpty && !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Save a reusable subsystem").font(.system(size: 22, weight: .semibold))
            Text("Choose equations and outputs from this baseline. Their input assumptions travel with them.")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            TextField("Subsystem name", text: $label).textFieldStyle(.roundedBorder).accessibilityLabel("Subsystem name")
            HStack {
                Text("Include in subsystem").font(.system(size: 12, weight: .medium))
                Spacer()
                Text("Expose as result").font(.system(size: 12, weight: .medium))
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(original.quantities) { quantity in
                        HStack(spacing: 18) {
                            Toggle(isOn: membership(quantity.id)) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(quantity.label)
                                    Text("\(quantity.kind) · \(quantity.unit) · \(quantity.id)").font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim)
                                }
                            }
                            Spacer()
                            Toggle("Output", isOn: outputMembership(quantity.id)).labelsHidden()
                                .accessibilityLabel("Expose \(quantity.label)")
                                .disabled(!members.contains(quantity.id) || (!outputs.contains(quantity.id) && outputs.count >= 32))
                        }
                    }
                }.padding(10)
            }.frame(height: 235).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
                .disabled(busy)
            if selectionReady, let inspection {
                if !inspection.missingDependencies.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Include the changing values these equations depend on.").fontWeight(.medium)
                        Text(inspection.missingDependencies.map { $0.quantity.label }.joined(separator: ", "))
                            .foregroundStyle(ReviewPalette.dim)
                        Button("Include required dependencies") {
                            members.formUnion(inspection.missingDependencies.map { $0.quantity.id })
                        }.buttonStyle(.genHoverPlain()).disabled(busy)
                    }.font(.system(size: 12))
                } else {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Copied boundary inputs").font(.system(size: 12, weight: .medium))
                        ScrollView {
                            Text(inspection.boundaryInputs.isEmpty ? "None needed." : inspection.boundaryInputs.map {
                                "\($0.label): \($0.baseValue.formatted()) \($0.unit)"
                            }.joined(separator: "  ·  ")).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        }.frame(maxHeight: 55)
                    }
                }
            } else if !members.isEmpty {
                ProgressView("Inspecting dependencies…").controlSize(.small)
            }
            Text("This package contains the selected baseline equations and data, with a \(original.time.step.formatted()) \(original.time.unit) step. Scenario branches and presentation explanations are not copied.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            if let error { NoticePill(text: error, isError: true) { self.error = nil } }
            HStack {
                if busy { ProgressView().controlSize(.small) }
                Spacer()
                Button("Cancel") { work?.cancel(); dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Save subsystem…") { save() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction).disabled(!canSave)
            }
        }
        .padding(24).frame(width: 760)
        .task(id: members.sorted()) {
            let requested = members
            inspection = nil
            error = nil
            guard !requested.isEmpty else { return }
            do {
                let result = try await model.inspectSubsystem(original, members: requested)
                try Task.checkCancellation()
                guard members == requested else { return }
                inspection = result
                inspectedMembers = requested
            } catch is CancellationError {
                HubPerf.log("model-room: subsystem selection superseded")
            } catch {
                if members == requested { self.error = error.localizedDescription }
            }
        }
        .onDisappear { work?.cancel(); savePanel?.cancel(nil) }
    }

    private func membership(_ id: String) -> Binding<Bool> {
        Binding(get: { members.contains(id) }, set: { included in
            if included { members.insert(id) }
            else { members.remove(id); outputs.remove(id) }
        })
    }

    private func outputMembership(_ id: String) -> Binding<Bool> {
        Binding(get: { outputs.contains(id) }, set: { included in
            if included { outputs.insert(id) } else { outputs.remove(id) }
        })
    }

    private func save() {
        let parent = model.owner?.windowControllers.first?.window
        let sheet = parent?.attachedSheet ?? parent
        guard let sheet, sheet.makeFirstResponder(nil) else { return }
        let selectedMembers = members
        let selectedOutputs = outputs
        let title = label
        busy = true
        error = nil
        work = Task {
            do {
                let data = try await model.extractSubsystem(original, members: selectedMembers, outputs: selectedOutputs, label: title)
                try Task.checkCancellation()
                let panel = NSSavePanel()
                savePanel = panel
                panel.allowedContentTypes = [.json]
                panel.directoryURL = model.owner?.fileURL?.deletingLastPathComponent() ?? ModelRoomConfiguration.initialDirectory
                panel.nameFieldStringValue = title + ".subsystem.json"
                panel.message = "A portable model with its own equations, units and input assumptions."
                panel.beginSheetModal(for: sheet) { response in
                    savePanel = nil
                    guard response == .OK, let url = panel.url else { busy = false; return }
                    work = Task {
                        do {
                            HubPerf.log("model-room: writing subsystem to \(url.path)")
                            try await Task.detached(priority: .userInitiated) { try data.write(to: url, options: .atomic) }.value
                            model.notice = "Saved subsystem \(url.lastPathComponent)"
                            dismiss()
                        } catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }
            } catch is CancellationError {
                HubPerf.log("model-room: subsystem export cancelled")
                busy = false
            } catch { self.error = error.localizedDescription; busy = false }
        }
    }
}

struct ModelRoomSubsystemImportSheet: View {
    @ObservedObject var model: ModelRoomModel
    let source: ModelRoomSubsystemSource
    @Environment(\.dismiss) private var dismiss
    @State private var namespace: String
    @State private var bindings: [String: String] = [:]
    @State private var preview: ModelRoomSubsystemImportResult?
    @State private var error: String?
    @State private var busy = false
    @State private var work: Task<Void, Never>?

    init(model: ModelRoomModel, source: ModelRoomSubsystemSource) {
        self.model = model
        self.source = source
        _namespace = State(initialValue: String(ModelRoomLimits.identifier(label: source.preview.packageFile.model.title, prefix: "part_", existing: []).prefix(32)))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Text("Import \(source.preview.packageFile.model.title)").font(.system(size: 22, weight: .semibold))
                Text("\(source.url.lastPathComponent) · \(source.preview.packageFile.members.count) members · \(source.preview.packageFile.outputs.count) output\(source.preview.packageFile.outputs.count == 1 ? "" : "s")")
                    .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            }
            HStack(spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("New quantity prefix").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    TextField("New quantity prefix", text: $namespace).textFieldStyle(.roundedBorder).accessibilityLabel("New quantity prefix")
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Package: \(source.preview.packageFile.model.time.step.formatted()) \(source.preview.packageFile.model.time.unit) per step")
                    Text("Destination: \(source.original.time.step.formatted()) \(source.original.time.unit) per step")
                }.font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            }.disabled(busy)
            Text("Choose where each input comes from").font(.system(size: 14, weight: .semibold))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(source.preview.choices) { choice in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(choice.quantity.label).font(.system(size: 12, weight: .medium))
                            Picker("Connect \(choice.quantity.label)", selection: Binding(get: { bindings[choice.id] ?? "" }, set: {
                                bindings[choice.id] = $0.isEmpty ? nil : $0
                            })) {
                                Text("Create new · \(choice.quantity.baseValue.formatted()) \(choice.quantity.unit)").tag("")
                                ForEach(choice.candidates) { candidate in
                                    Text("\(candidate.label) · \(candidate.baseValue.formatted()) \(candidate.unit)").tag(candidate.id)
                                }
                            }.labelsHidden().accessibilityLabel("Connect \(choice.quantity.label)")
                            if let seed = choice.quantity.seed {
                                Text("Package history seed: \(seed.formatted()) \(choice.quantity.unit)")
                                    .font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim)
                            }
                        }
                    }
                    if source.preview.choices.isEmpty {
                        Text("This subsystem has no input assumptions to connect.").foregroundStyle(ReviewPalette.dim)
                    }
                }.padding(10)
            }.frame(height: 250).background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 8)).disabled(busy)
            Text("Existing inputs supply their values, history and scenario changes. New quantities are added to Baseline; every branch is checked before applying. The import uses the package snapshot shown here.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            if let preview {
                VStack(alignment: .leading, spacing: 5) {
                    Label("Ready to add \(preview.added.count) quantities", systemImage: "checkmark.circle").font(.system(size: 13, weight: .medium))
                    Text("\(preview.bound.count) inputs connected · \(preview.document.scenarios.count + 1) scenarios validated · one undoable edit")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                }
            }
            if let error { NoticePill(text: error, isError: true) { self.error = nil } }
            HStack {
                if busy { ProgressView("Checking equations and scenarios…").controlSize(.small) }
                Spacer()
                Button("Cancel") { work?.cancel(); dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Preview import") { check() }.buttonStyle(.genHoverPlain()).disabled(busy)
                Button("Add to Baseline") {
                    guard let preview else { return }
                    do { try model.applySubsystemImport(preview, source: source) }
                    catch { self.error = error.localizedDescription }
                }.buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction).disabled(preview == nil || busy)
            }
        }
        .padding(24).frame(width: 760)
        .onChange(of: namespace) { _, _ in preview = nil }
        .onChange(of: bindings) { _, _ in preview = nil }
        .onDisappear { work?.cancel() }
    }

    private func check() {
        let window = model.owner?.windowControllers.first?.window?.attachedSheet ?? NSApp.keyWindow
        guard window?.makeFirstResponder(nil) != false else { return }
        let requestedNamespace = namespace
        let requestedBindings = bindings
        error = nil
        preview = nil
        busy = true
        work = Task {
            defer { busy = false }
            do {
                let result = try await model.previewSubsystemImport(source: source, namespace: requestedNamespace, bindings: requestedBindings)
                try Task.checkCancellation()
                guard namespace == requestedNamespace && bindings == requestedBindings else { return }
                preview = result
            } catch is CancellationError {
                HubPerf.log("model-room: subsystem import check cancelled")
            } catch { self.error = error.localizedDescription }
        }
    }
}
