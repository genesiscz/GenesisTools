import GenesisKit
import SwiftUI

struct ModelRoomInspector: View {
    @ObservedObject var model: ModelRoomModel
    let quantity: ModelRoomQuantity
    @State private var formula = ""
    @State private var label = ""
    @State private var unit = ""
    @State private var value = ""
    @State private var interventionValue = "65"
    @State private var interventionTime = "4"
    @State private var rangeMin = "0"
    @State private var rangeMax = "100"
    @State private var rangeStep = "1"
    @State private var quantityDescription = ""
    @State private var provenance = "assumption"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Quantity").font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Text(quantity.kind).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                }
                field("Name", text: $label)
                field("Unit", text: $unit)
                Button("Apply name and unit") {
                    model.updateQuantity(quantity.id, title: "Edit quantity") { item in item.label = label; item.unit = unit }
                }.buttonStyle(.genHoverPlain())
                Divider()
                if quantity.kind == "input" || quantity.kind == "stock" {
                    field(quantity.kind == "stock" ? "Initial value" : "Assumed value", text: $value)
                    Button("Apply value") {
                        guard let number = Double(value), number.isFinite else { model.error = "Enter a finite number."; return }
                        if quantity.kind == "input" {
                            model.beginGesture(); model.setInput(quantity.id, value: number); model.finishGesture()
                        } else {
                            model.updateQuantity(quantity.id, title: "Change initial stock") { $0.initial = number }
                        }
                    }.buttonStyle(.genHoverPlain())
                    if quantity.kind == "input", quantity.range != nil {
                        ModelRoomInputSlider(model: model, quantity: quantity).fixedSize(horizontal: false, vertical: true)
                    }
                }
                if quantity.kind == "input" {
                    DisclosureGroup("Slider range") {
                        VStack(alignment: .leading, spacing: 10) {
                            field("Minimum", text: $rangeMin)
                            field("Maximum", text: $rangeMax)
                            field("Increment", text: $rangeStep)
                            HStack {
                                Button("Apply range") { applyRange() }.buttonStyle(.genHoverPlain())
                                if quantity.range != nil {
                                    Button("Remove range") { model.updateQuantity(quantity.id, title: "Remove slider range") { $0.range = nil } }
                                        .buttonStyle(.genHoverPlain())
                                }
                            }
                        }.padding(.top, 10)
                    }
                }
                if quantity.kind == "formula" || quantity.kind == "stock" {
                    Text(quantity.kind == "stock" ? "Rate of change" : "Formula").font(.system(size: 12, weight: .medium))
                    TextEditor(text: $formula).font(.system(size: 12, design: .monospaced)).frame(minHeight: 90)
                        .scrollContentBackground(.hidden).padding(6)
                        .background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityLabel("Formula for \(quantity.label)")
                        .dropDestination(for: String.self) { items, _ in
                            guard let reference = items.first, model.effectiveQuantities.contains(where: { $0.id == reference }) else { return false }
                            formula += formula.isEmpty ? reference : " + " + reference
                            return true
                        }
                    HStack {
                        Button("Evaluate") { commitFormula() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.return, modifiers: .command)
                        Button("Revert") { formula = quantity.formula }.buttonStyle(.genHoverPlain())
                    }
                    Text("Numbers can carry units: 0[tickets]. A lag uses whole steps: lag(backlog, 1).")
                        .font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim)
                    Text("Insert a reference").font(.system(size: 11, weight: .medium))
                    ForEach(model.effectiveQuantities.filter { $0.id != quantity.id }) { other in
                        Button { formula += formula.isEmpty ? other.id : " + " + other.id } label: {
                            HStack { Text(other.label); Spacer(); Text(other.unit).foregroundStyle(ReviewPalette.dim) }
                                .font(.system(size: 11)).padding(5)
                        }.buttonStyle(RowButtonStyle()).draggable(other.id)
                    }
                }
                if quantity.kind == "input", !model.selectedScenario.isEmpty {
                    Divider()
                    Text("Schedule an intervention").font(.system(size: 12, weight: .medium))
                    field("Start time (\(model.file?.time.unit ?? "day"))", text: $interventionTime)
                    field("New value", text: $interventionValue)
                    Button("Add intervention") { addIntervention() }.buttonStyle(.genHoverPlain())
                }
                Divider()
                Text("Why this value?").font(.system(size: 12, weight: .medium))
                Text(explanation).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
                Picker("Provenance", selection: $provenance) {
                    ForEach(["assumption", "identity", "measured", "estimate"], id: \.self) { Text($0.capitalized).tag($0) }
                }
                TextEditor(text: $quantityDescription).font(.system(size: 12)).frame(minHeight: 70)
                    .accessibilityLabel("Quantity explanation")
                Button("Apply explanation") {
                    model.updateQuantity(quantity.id, title: "Explain quantity") { $0.description = quantityDescription; $0.provenance = provenance }
                }.buttonStyle(.genHoverPlain())
                Text(quantity.id).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).foregroundStyle(ReviewPalette.dim)
                Button("Delete quantity", role: .destructive) { model.removeSelected() }.buttonStyle(.genHoverPlain())
            }.padding(16)
        }
        .task(id: quantity.id + quantity.formula + quantity.unit + quantity.label + model.selectedScenario) {
            formula = quantity.formula; label = quantity.label; unit = quantity.unit
            quantityDescription = quantity.description; provenance = quantity.provenance
            rangeMin = String(quantity.range?.min ?? 0); rangeMax = String(quantity.range?.max ?? 100); rangeStep = String(quantity.range?.step ?? 1)
            value = String(quantity.kind == "input" ? model.inputValue(quantity) : quantity.baseValue)
        }
        .onChange(of: model.inputValue(quantity)) { _, next in
            if quantity.kind == "input" { value = String(next) }
        }
    }

    private var explanation: String {
        if quantity.kind == "input" { return "This is a chosen assumption. A scenario can override it without changing the baseline." }
        if quantity.kind == "stock" { return "Starting at \(quantity.initial ?? 0) \(quantity.unit), each step adds the previous step's rate multiplied by the step duration. Declared stock limits are applied after integration." }
        if quantity.kind == "data" { return "Observations from \(quantity.source ?? "a local table") use \(quantity.interpolation ?? "hold") interpolation and hold the first/last value outside the measured interval." }
        return "Calculated from \(quantity.formula). Input values use canonical units internally and are converted to \(quantity.unit) for display."
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim)
            TextField(title, text: text).textFieldStyle(.roundedBorder).font(.system(size: 12)).accessibilityLabel(title)
        }
    }

    private func commitFormula() {
        model.updateQuantity(quantity.id, title: "Edit formula") { item in
            if item.kind == "stock" { item.derivative = formula } else { item.expression = formula }
        }
    }

    private func applyRange() {
        guard let minimum = Double(rangeMin), let maximum = Double(rangeMax), let increment = Double(rangeStep),
              minimum.isFinite, maximum.isFinite, increment.isFinite, minimum < maximum, increment > 0,
              (maximum - minimum).isFinite, ((maximum - minimum) / increment).isFinite else {
            model.error = "A slider needs finite increasing endpoints and a positive increment."
            return
        }
        model.updateQuantity(quantity.id, title: "Change slider range") { $0.range = ModelRoomRange(min: minimum, max: maximum, step: increment) }
    }

    private func addIntervention() {
        guard let at = Double(interventionTime), let next = Double(interventionValue), at.isFinite, next.isFinite else {
            model.error = "Use finite numbers for the intervention's time and value."
            return
        }
        let scenario = model.selectedScenario
        model.change("Add intervention") { file in
            guard let index = file.scenarios.firstIndex(where: { $0.id == scenario }) else { return }
            file.scenarios[index].interventions.append(ModelRoomIntervention(at: at, values: [quantity.id: next], label: "Change \(quantity.label)"))
        }
    }
}

struct ModelRoomAddQuantity: View {
    @ObservedObject var model: ModelRoomModel
    @Environment(\.dismiss) private var dismiss
    @State private var label = "New quantity"
    @State private var kind = "input"
    @State private var unit = "1"
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Add a quantity").font(.system(size: 20, weight: .semibold))
            TextField("Name", text: $label).textFieldStyle(.roundedBorder)
            Picker("Kind", selection: $kind) {
                Text("Assumption").tag("input")
                Text("Formula").tag("formula")
                Text("Stock").tag("stock")
            }.pickerStyle(.segmented)
            TextField("Unit, e.g. tickets/day", text: $unit).textFieldStyle(.roundedBorder)
            Text("Use 1 for a dimensionless number. Formulas reference the identifiers shown in the inspector.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Add quantity") { model.addQuantity(label: label, kind: kind, unit: unit); dismiss() }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction).disabled(label.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }.padding(24).frame(width: 390)
    }
}
