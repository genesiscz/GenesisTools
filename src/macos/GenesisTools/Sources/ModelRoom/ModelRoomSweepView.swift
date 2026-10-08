import AppKit
import GenesisKit
import SwiftUI

struct ModelRoomSweepDraft: Identifiable {
    var id: String
    var label: String
    var unit: String
    var included = false
    var lower: String
    var upper: String
    var count = "5"

    static func inputs(file: ModelRoomFile, scenarioID: String, included: Set<String>? = nil) -> [Self] {
        let overrides = file.scenarios.first { $0.id == scenarioID }?.overrides ?? [:]
        return file.effectiveQuantities(scenarioID: scenarioID).filter { $0.kind == "input" }.enumerated().map { index, quantity in
            let value = overrides[quantity.id] ?? quantity.baseValue
            return Self(id: quantity.id, label: quantity.label, unit: quantity.unit,
                        included: included?.contains(quantity.id) ?? (index == 0),
                        lower: String(quantity.range?.min ?? value), upper: String(quantity.range?.max ?? value + 1))
        }
    }
}

struct ModelRoomSweepSheet: View {
    @ObservedObject var model: ModelRoomModel
    @StateObject private var runner: ModelRoomSweepController
    @Environment(\.dismiss) private var dismiss
    @State private var axes: [ModelRoomSweepDraft] = []
    @State private var output = ""
    @State private var scenario = ""
    @State private var usedAxes: [String] = []
    @State private var usedOutput = ""
    @State private var usedScenario = ""

    init(model: ModelRoomModel) {
        self.model = model
        _runner = StateObject(wrappedValue: ModelRoomSweepController(bridge: model.bridge))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Explore a range of assumptions").font(.system(size: 22, weight: .semibold))
                    Text("Compare final outcomes across up to 10,000 combinations. Your model stays unchanged.")
                        .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                }
                Spacer()
                if runner.running { ProgressView().controlSize(.small) }
            }
            ScrollView {
                LazyVStack(spacing: 9) {
                    HStack {
                        Text("Assumption").frame(width: 190, alignment: .leading)
                        Text("From").frame(width: 125)
                        Text("Through").frame(width: 125)
                        Text("Samples").frame(width: 90)
                        Spacer()
                    }.foregroundStyle(ReviewPalette.dim)
                    ForEach($axes) { $axis in
                        HStack {
                            Toggle(axis.label, isOn: $axis.included).frame(width: 190, alignment: .leading)
                            TextField("Minimum for \(axis.label)", text: $axis.lower).frame(width: 125).accessibilityLabel("Minimum for \(axis.label)")
                            TextField("Maximum for \(axis.label)", text: $axis.upper).frame(width: 125).accessibilityLabel("Maximum for \(axis.label)")
                            TextField("Samples for \(axis.label)", text: $axis.count).frame(width: 90).accessibilityLabel("Samples for \(axis.label)")
                            Text(axis.unit).foregroundStyle(ReviewPalette.dim).frame(maxWidth: .infinity, alignment: .leading)
                        }.textFieldStyle(.roundedBorder)
                    }
                }.font(.system(size: 12))
            }.frame(height: 155).disabled(runner.running)
            HStack(spacing: 20) {
                Picker("Scenario", selection: $scenario) {
                    Text("Baseline").tag("")
                    ForEach(model.file?.scenarios ?? []) { Text($0.label).tag($0.id) }
                }
                Picker("Final outcome", selection: $output) {
                    ForEach(model.file?.effectiveQuantities(scenarioID: scenario) ?? []) { Text("\($0.label) (\($0.unit))").tag($0.id) }
                }
            }.disabled(runner.running)
            HStack {
                Text(runner.status).font(.system(size: 12))
                Spacer()
                Text("\(runner.runs.count) / \(runner.total)").monospacedDigit()
                if runner.running {
                    Button("Stop calculation") { runner.stop() }.buttonStyle(.genHoverPlain())
                } else {
                    Button("Run sweep") { start() }.buttonStyle(.genHoverPlain())
                }
            }
            ProgressView(value: Double(runner.runs.count), total: Double(max(1, runner.total)))
            if let error = runner.error {
                NoticePill(text: error, isError: true) { runner.error = nil }
            }
            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Run").frame(width: 42, alignment: .trailing)
                        ForEach(usedAxes, id: \.self) { id in Text(label(id)).frame(width: 120, alignment: .trailing) }
                        Text(label(usedOutput)).fontWeight(.semibold).frame(width: 140, alignment: .trailing)
                        Text("Keep assumptions").frame(width: 125)
                    }.foregroundStyle(ReviewPalette.dim)
                    ForEach(Array(runner.runs.enumerated()), id: \.offset) { index, run in
                        HStack {
                            Text("\(index + 1)").frame(width: 42, alignment: .trailing)
                            ForEach(usedAxes, id: \.self) { id in
                                Text(run.inputs[id]?.formatted(.number.precision(.significantDigits(1...6))) ?? "—")
                                    .frame(width: 120, alignment: .trailing)
                            }
                            Text(run.outputs[usedOutput]?.formatted(.number.precision(.significantDigits(1...8))) ?? "—")
                                .frame(width: 140, alignment: .trailing)
                            Button("Use as scenario") { apply(run, index: index) }.buttonStyle(.genHoverPlain()).frame(width: 125)
                                .accessibilityLabel("Use result \(index + 1) as scenario")
                        }.monospacedDigit()
                    }
                }.font(.system(size: 11)).padding(10)
            }.frame(minHeight: 180, maxHeight: 250).hubSurface(.content)
            HStack {
                Text("Values are measured at the model's final time. Scheduled interventions still apply.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                Button("Close") { runner.stop(); dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
            }
        }
        .padding(24).frame(width: 820)
        .onAppear {
            scenario = model.selectedScenario
            rebuildAxes()
        }
        .onChange(of: scenario) { _, _ in rebuildAxes() }
        .onDisappear { runner.stop() }
    }

    private func rebuildAxes() {
        guard let file = model.file else { return }
        let included = axes.isEmpty ? nil : Set(axes.filter(\.included).map(\.id))
        axes = ModelRoomSweepDraft.inputs(file: file, scenarioID: scenario, included: included)
        let quantities = file.effectiveQuantities(scenarioID: scenario)
        let ids = Set(quantities.map(\.id))
        if !ids.contains(output) {
            output = file.presentation.outputs.first(where: { ids.contains($0) }) ?? quantities.first?.id ?? ""
        }
    }

    private func label(_ id: String) -> String { model.file?.effectiveQuantities(scenarioID: usedScenario).first { $0.id == id }?.label ?? id }

    private func start() {
        let editor = model.owner?.windowControllers.first?.window?.attachedSheet ?? NSApp.keyWindow
        editor?.makeFirstResponder(nil)
        guard let file = model.file else { return }
        let chosen = axes.filter(\.included)
        guard (1...8).contains(chosen.count), !output.isEmpty else { runner.error = "Choose one to eight input ranges and an outcome."; return }
        var parsed: [ModelRoomSweepAxis] = []
        var total = 1
        for axis in chosen {
            guard let lower = Double(axis.lower), let upper = Double(axis.upper), let count = Int(axis.count), lower.isFinite, upper.isFinite, (upper - lower).isFinite, upper >= lower, (2...10000).contains(count), total <= 10000 / count else {
                runner.error = "Use finite increasing ranges, 2 to 10,000 samples each, and at most 10,000 combinations."
                return
            }
            total *= count
            let values = (0..<count).map { index in index == count - 1 ? upper : lower + (upper - lower) * (Double(index) / Double(count - 1)) }
            parsed.append(ModelRoomSweepAxis(quantityId: axis.id, values: values))
        }
        usedAxes = chosen.map(\.id); usedOutput = output; usedScenario = scenario
        runner.start(file: file, configuration: ModelRoomSweepConfiguration(axes: parsed, outputs: [output], scenarioId: scenario.isEmpty ? nil : scenario))
    }

    private func apply(_ run: ModelRoomSweepRun, index: Int) {
        let id = "sweep_" + UUID().uuidString.replacingOccurrences(of: "-", with: "_")
        let parent = model.file?.scenarios.first { $0.id == usedScenario }
        model.change("Keep sweep assumptions") { file in
            var overrides = parent?.overrides ?? [:]
            overrides.merge(run.inputs) { _, new in new }
            file.scenarios.append(ModelRoomScenario(id: id, label: "Sweep result \(index + 1)", overrides: overrides,
                                                    interventions: parent?.interventions ?? [], replacements: parent?.replacements ?? [], removed: parent?.removed ?? []))
        }
        if model.file?.scenarios.contains(where: { $0.id == id }) == true {
            model.selectedScenario = id
            model.selectedQuantity = usedOutput
            runner.stop()
            dismiss()
        } else { runner.error = model.error }
    }
}
