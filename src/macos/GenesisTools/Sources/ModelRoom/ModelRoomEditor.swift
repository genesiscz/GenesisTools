import AppKit
import GenesisKit
import SwiftUI

struct ModelRoomEditor: View {
    @ObservedObject var model: ModelRoomModel
    @Environment(\.dismiss) private var dismiss
    @State private var original: ModelRoomFile
    @State private var draft: ModelRoomFile
    @State private var tab = "Model"
    @State private var selectedScenario = ""
    @State private var targetTimeUnit: String
    @State private var invalidNumbers: Set<String> = []
    @State private var numberText: [String: String] = [:]
    @State private var error: String?
    @State private var busy = false
    @State private var work: Task<Void, Never>?

    init(model: ModelRoomModel, file: ModelRoomFile) {
        self.model = model
        _original = State(initialValue: file)
        _draft = State(initialValue: file)
        _targetTimeUnit = State(initialValue: file.time.unit)
        _selectedScenario = State(initialValue: file.scenarios.first?.id ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Shape your model").font(.system(size: 22, weight: .semibold))
                    Text("Changes are checked together before they become one undoable edit.")
                        .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                }
                Spacer()
                if busy { ProgressView().controlSize(.small).accessibilityLabel("Checking model changes") }
            }
            Picker("Editor section", selection: $tab) {
                ForEach(["Model", "Scenarios", "Presentation"], id: \.self) { Text($0).tag($0) }
            }.pickerStyle(.segmented)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    switch tab {
                    case "Scenarios": scenarios
                    case "Presentation": presentation
                    default: modelSettings
                    }
                }.padding(2).frame(maxWidth: .infinity, alignment: .leading)
            }.frame(height: 465).disabled(busy)
            if let error { NoticePill(text: error, isError: true) { self.error = nil } }
            if !invalidNumbers.isEmpty {
                Text("Complete the highlighted numbers before applying.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.removed)
            }
            HStack {
                Text("\(draft.quantities.count) quantities · \(draft.scenarios.count + 1) scenarios")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                Button(busy ? "Stop and close" : "Cancel") { work?.cancel(); dismiss() }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Check and apply") { apply() }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction)
                    .disabled(busy || !invalidNumbers.isEmpty)
            }
        }
        .padding(24).frame(width: 760)
        .onDisappear { work?.cancel() }
        .onChange(of: activeNumberFields) { _, fields in
            invalidNumbers.formIntersection(fields)
            numberText = numberText.filter { fields.contains($0.key) }
        }
    }

    private var activeNumberFields: Set<String> {
        var fields: Set<String> = ["duration", "step"]
        for scenario in draft.scenarios {
            for id in scenario.overrides.keys { fields.insert("override:\(scenario.id):\(id)") }
            for intervention in scenario.interventions {
                fields.insert("\(intervention.id):time")
                for id in intervention.values.keys { fields.insert("\(intervention.id):\(id)") }
            }
        }
        for step in draft.presentation.steps where step.time != nil { fields.insert("\(step.id):time") }
        return fields
    }

    private var modelSettings: some View {
        VStack(alignment: .leading, spacing: 18) {
            textField("Model title", text: $draft.title)
            textEditor("Assumptions and limitations", text: $draft.description, height: 110)
            Divider()
            Text("Simulation time").font(.system(size: 14, weight: .semibold))
            HStack(spacing: 18) {
                numberField("Duration (\(draft.time.unit))", value: $draft.time.duration, id: "duration")
                numberField("Step (\(draft.time.unit))", value: $draft.time.step, id: "step")
            }
            Text("Duration must contain 1–10,000 whole steps. Smaller steps improve an Euler approximation but do not make its assumptions more accurate.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            HStack(alignment: .bottom, spacing: 16) {
                textField("Convert time unit", text: $targetTimeUnit)
                Button("Convert all times") { convertTime() }
                    .buttonStyle(.genHoverPlain()).disabled(busy || !invalidNumbers.isEmpty || targetTimeUnit.isEmpty)
            }
            Text("Converts duration, steps, observation timestamps and scheduled events together, preserving elapsed time.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
        }
    }

    private var scenarios: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Picker("Branch", selection: $selectedScenario) {
                    if draft.scenarios.isEmpty { Text("No branches yet").tag("") }
                    ForEach(draft.scenarios) { Text($0.label).tag($0.id) }
                }
                Button("New branch") {
                    let id = ModelRoomLimits.identifier(label: "scenario", prefix: "s_", existing: Set(draft.scenarios.map(\.id)))
                    draft.scenarios.append(ModelRoomScenario(id: id, label: "Scenario \(draft.scenarios.count + 1)"))
                    selectedScenario = id
                }.buttonStyle(.genHoverPlain()).disabled(draft.scenarios.count >= 32)
            }
            if let index = draft.scenarios.firstIndex(where: { $0.id == selectedScenario }) {
                scenarioEditor(index)
            } else {
                Text("Add a branch to compare different assumptions and timed interventions.")
                    .foregroundStyle(ReviewPalette.dim)
            }
        }
    }

    private func scenarioEditor(_ index: Int) -> some View {
        let scenario = draft.scenarios[index]
        let inputs = draft.effectiveQuantities(scenarioID: scenario.id).filter { $0.kind == "input" }
        return VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 18) {
                textField("Branch name", text: $draft.scenarios[index].label)
                textField("Color (#RRGGBB)", text: $draft.scenarios[index].color).frame(width: 175)
                Circle().fill(modelRoomColor(scenario.color)).frame(width: 16, height: 16)
            }
            textEditor("What changes in this branch?", text: $draft.scenarios[index].description, height: 60)
            DisclosureGroup("Starting assumptions · \(scenario.overrides.count) changes") {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(inputs) { quantity in
                        HStack(spacing: 14) {
                            Toggle(quantity.label, isOn: Binding(get: { draft.scenarios[index].overrides[quantity.id] != nil }, set: { enabled in
                                draft.scenarios[index].overrides[quantity.id] = enabled ? quantity.baseValue : nil
                            })).frame(width: 240, alignment: .leading)
                            if scenario.overrides[quantity.id] != nil {
                                numberField(quantity.unit, value: Binding(get: { draft.scenarios[index].overrides[quantity.id] ?? quantity.baseValue }, set: {
                                    draft.scenarios[index].overrides[quantity.id] = $0
                                }), id: "override:\(scenario.id):\(quantity.id)")
                            } else { Text("Inherited: \(quantity.baseValue, specifier: "%g") \(quantity.unit)").foregroundStyle(ReviewPalette.dim) }
                        }
                    }
                }.padding(.top, 10)
            }
            Text("Structural changes").font(.system(size: 13, weight: .semibold))
            Text("Use Build with this branch selected to add, remove or edit quantities. Resetting a quantity here restores its baseline definition.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            ForEach(scenario.replacements) { quantity in
                HStack {
                    Text(quantity.label).lineLimit(1)
                    Text(draft.quantities.contains { $0.id == quantity.id } ? "Changed definition" : "Added in branch").foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Reset") { resetReplacement(quantity.id, scenarioIndex: index) }.buttonStyle(.genHoverPlain())
                }.font(.system(size: 12))
            }
            ForEach(scenario.removed, id: \.self) { id in
                HStack {
                    Text(draft.quantities.first { $0.id == id }?.label ?? id)
                    Text("Removed in branch").foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Restore") { draft.scenarios[index].removed.removeAll { $0 == id } }.buttonStyle(.genHoverPlain())
                }.font(.system(size: 12))
            }
            Divider()
            HStack {
                Text("Timed interventions").font(.system(size: 14, weight: .semibold))
                Spacer()
                Button("Add intervention") {
                    draft.scenarios[index].interventions.append(ModelRoomIntervention(at: 0, values: [:], label: "New intervention"))
                }.buttonStyle(.genHoverPlain()).disabled(scenario.interventions.count >= 256 || inputs.isEmpty)
            }
            Text("Events must fall on a simulation step and run chronologically. For simultaneous events, later rows win.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            ForEach($draft.scenarios[index].interventions) { $intervention in
                ModelRoomInterventionEditor(intervention: $intervention, inputs: inputs, timeUnit: draft.time.unit, invalidNumbers: $invalidNumbers, numberText: $numberText) {
                    draft.scenarios[index].interventions.removeAll { $0.id == intervention.id }
                }
            }
            Button("Delete branch", role: .destructive) {
                draft.scenarios.remove(at: index)
                for step in draft.presentation.steps.indices where draft.presentation.steps[step].scenario == scenario.id {
                    draft.presentation.steps[step].scenario = nil
                }
                selectedScenario = draft.scenarios.first?.id ?? ""
            }.buttonStyle(.genHoverPlain())
        }
    }

    private var presentation: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Choose what your audience can explore").font(.system(size: 14, weight: .semibold))
            Text("Presentation selections use baseline quantities. Branches may replace them; unavailable or incompatible values are explained in the result.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            HStack(alignment: .top, spacing: 30) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Interactive assumptions").fontWeight(.medium)
                    ForEach(draft.quantities.filter { $0.kind == "input" }) { quantity in
                        Toggle(quantity.label, isOn: membership(quantity.id, in: $draft.presentation.controls))
                            .disabled(quantity.range == nil && !draft.presentation.controls.contains(quantity.id))
                    }
                    Text("Add a slider range in the quantity inspector to expose an assumption.")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Result charts").fontWeight(.medium)
                    ForEach(draft.quantities) { quantity in
                        Toggle(quantity.label, isOn: membership(quantity.id, in: $draft.presentation.outputs))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.font(.system(size: 12))
            Divider()
            HStack {
                Text("Explanation steps").font(.system(size: 14, weight: .semibold))
                Spacer()
                Button("Add step") {
                    draft.presentation.steps.append(ModelRoomPresentationStep(title: "Step \(draft.presentation.steps.count + 1)", text: ""))
                }.buttonStyle(.genHoverPlain()).disabled(draft.presentation.steps.count >= 64)
            }
            ForEach($draft.presentation.steps) { $step in
                ModelRoomPresentationStepEditor(step: $step, scenarios: draft.scenarios, timeUnit: draft.time.unit, invalidNumbers: $invalidNumbers, numberText: $numberText,
                    move: { moveStep(step.id, by: $0) },
                    remove: { draft.presentation.steps.removeAll { $0.id == step.id } })
            }
        }
    }

    private func resetReplacement(_ id: String, scenarioIndex: Int) {
        draft.scenarios[scenarioIndex].replacements.removeAll { $0.id == id }
        let input = draft.quantities.first { $0.id == id }?.kind == "input"
        if !input {
            draft.scenarios[scenarioIndex].overrides.removeValue(forKey: id)
            for index in draft.scenarios[scenarioIndex].interventions.indices {
                draft.scenarios[scenarioIndex].interventions[index].values.removeValue(forKey: id)
            }
        }
    }

    private func moveStep(_ id: UUID, by direction: Int) {
        guard let index = draft.presentation.steps.firstIndex(where: { $0.id == id }),
              draft.presentation.steps.indices.contains(index + direction) else { return }
        draft.presentation.steps.swapAt(index, index + direction)
    }

    private func membership(_ id: String, in list: Binding<[String]>) -> Binding<Bool> {
        Binding(get: { list.wrappedValue.contains(id) }, set: { enabled in
            if enabled && !list.wrappedValue.contains(id) { list.wrappedValue.append(id) }
            if !enabled { list.wrappedValue.removeAll { $0 == id } }
        })
    }

    private func numberField(_ title: String, value: Binding<Double>, id: String) -> some View {
        ModelRoomNumberField(title: title, value: value, fieldID: id, invalidNumbers: $invalidNumbers, textByField: $numberText)
    }

    private func textField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            TextField(title, text: text).textFieldStyle(.roundedBorder).accessibilityLabel(title)
        }
    }

    private func textEditor(_ title: String, text: Binding<String>, height: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            TextEditor(text: text).font(.system(size: 12)).frame(height: height).accessibilityLabel(title)
                .scrollContentBackground(.hidden).padding(6).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    private func finishEditing() -> Bool {
        let window = model.owner?.windowControllers.first?.window?.attachedSheet ?? NSApp.keyWindow
        return window?.makeFirstResponder(nil) != false && invalidNumbers.isEmpty
    }

    private func apply() {
        guard finishEditing() else { return }
        let requested = draft
        busy = true
        error = nil
        work = Task {
            defer { busy = false }
            do {
                let checked = try await model.validateDraft(requested)
                try Task.checkCancellation()
                try model.commitDraft(checked, replacing: original)
                dismiss()
            } catch is CancellationError {
                HubPerf.log("model-room: authoring check cancelled")
            } catch { self.error = error.localizedDescription }
        }
    }

    private func convertTime() {
        guard finishEditing() else { return }
        let requested = draft
        let unit = targetTimeUnit
        busy = true
        error = nil
        work = Task {
            defer { busy = false }
            do {
                draft = try await model.convertDraftTime(requested, unit: unit)
                targetTimeUnit = draft.time.unit
            } catch is CancellationError {
                HubPerf.log("model-room: time conversion cancelled")
            } catch { self.error = error.localizedDescription }
        }
    }
}

struct ModelRoomNumberField: View {
    let title: String
    @Binding var value: Double
    let fieldID: String
    @Binding var invalidNumbers: Set<String>
    @Binding var textByField: [String: String]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            TextField(title, text: Binding(get: { textByField[fieldID] ?? String(value) }, set: { next in
                textByField[fieldID] = next
                if let number = Double(next), number.isFinite {
                    value = number
                    invalidNumbers.remove(fieldID)
                } else { invalidNumbers.insert(fieldID) }
            }))
            .textFieldStyle(.roundedBorder).accessibilityLabel(title)
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(invalidNumbers.contains(fieldID) ? ReviewPalette.removed : .clear))
        }
        .onChange(of: value) { _, next in
            if textByField[fieldID].flatMap(Double.init) != next {
                textByField[fieldID] = String(next)
                invalidNumbers.remove(fieldID)
            }
        }
    }
}

private struct ModelRoomInterventionEditor: View {
    @Binding var intervention: ModelRoomIntervention
    let inputs: [ModelRoomQuantity]
    let timeUnit: String
    @Binding var invalidNumbers: Set<String>
    @Binding var numberText: [String: String]
    let remove: () -> Void

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Intervention name", text: $intervention.label).textFieldStyle(.roundedBorder).accessibilityLabel("Intervention name")
                ModelRoomNumberField(title: "Start time (\(timeUnit))", value: $intervention.at, fieldID: "\(intervention.id):time", invalidNumbers: $invalidNumbers, textByField: $numberText)
                ForEach(inputs) { quantity in
                    HStack(spacing: 18) {
                        Toggle(quantity.label, isOn: Binding(get: { intervention.values[quantity.id] != nil }, set: { enabled in
                            intervention.values[quantity.id] = enabled ? quantity.baseValue : nil
                        })).frame(width: 240, alignment: .leading)
                        if intervention.values[quantity.id] != nil {
                            ModelRoomNumberField(title: quantity.unit, value: Binding(get: { intervention.values[quantity.id] ?? quantity.baseValue }, set: {
                                intervention.values[quantity.id] = $0
                            }), fieldID: "\(intervention.id):\(quantity.id)", invalidNumbers: $invalidNumbers, textByField: $numberText)
                        }
                    }
                }
                Button("Remove intervention", role: .destructive, action: remove).buttonStyle(.genHoverPlain())
            }.padding(.top, 10)
        } label: {
            Text("\(intervention.label) · \(intervention.at.formatted()) \(timeUnit) · \(intervention.values.count) assumptions")
                .font(.system(size: 12))
        }
    }
}

private struct ModelRoomPresentationStepEditor: View {
    @Binding var step: ModelRoomPresentationStep
    let scenarios: [ModelRoomScenario]
    let timeUnit: String
    @Binding var invalidNumbers: Set<String>
    @Binding var numberText: [String: String]
    let move: (Int) -> Void
    let remove: () -> Void

    var body: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Step title", text: $step.title).textFieldStyle(.roundedBorder).accessibilityLabel("Step title")
                TextEditor(text: $step.text).font(.system(size: 12)).frame(height: 90).accessibilityLabel("Step explanation")
                Picker("Scenario on arrival", selection: Binding(get: { step.scenario ?? "" }, set: { step.scenario = $0.isEmpty ? nil : $0 })) {
                    Text("Baseline").tag("")
                    ForEach(scenarios) { Text($0.label).tag($0.id) }
                }
                Toggle("Jump to a time", isOn: Binding(get: { step.time != nil }, set: { step.time = $0 ? 0 : nil }))
                if step.time != nil {
                    ModelRoomNumberField(title: "Arrival time (\(timeUnit))", value: Binding(get: { step.time ?? 0 }, set: { step.time = $0 }), fieldID: "\(step.id):time", invalidNumbers: $invalidNumbers, textByField: $numberText)
                }
                HStack {
                    Button("Move up") { move(-1) }.buttonStyle(.genHoverPlain())
                    Button("Move down") { move(1) }.buttonStyle(.genHoverPlain())
                    Spacer()
                    Button("Remove step", role: .destructive, action: remove).buttonStyle(.genHoverPlain())
                }
            }.padding(.top, 10)
        } label: { Text(step.title).font(.system(size: 12, weight: .medium)) }
    }
}
