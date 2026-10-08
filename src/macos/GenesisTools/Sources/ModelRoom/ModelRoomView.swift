import AppKit
import Charts
import GenesisKit
import SwiftUI

struct ModelRoomView: View {
    @ObservedObject var model: ModelRoomModel

    var body: some View {
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 12) {
                    Image(systemName: "point.3.connected.trianglepath.dotted").foregroundStyle(ReviewPalette.renamed)
                    Text("Model Room").font(.system(size: 13, weight: .semibold)).titlebarLabel()
                    Text(model.file?.title ?? "Opening model…").foregroundStyle(ReviewPalette.dim).titlebarLabel()
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small).accessibilityLabel("Calculating") }
                    IconButton(systemName: "arrow.uturn.backward", tooltip: "Undo (⌘Z)") { model.owner?.undoManager?.undo() }
                    IconButton(systemName: "arrow.uturn.forward", tooltip: "Redo (⇧⌘Z)") { model.owner?.undoManager?.redo() }
                    Button(model.exporting ? "Exporting…" : "Export HTML") { model.exportDocument(format: "html") }
                        .buttonStyle(.genHoverPlain()).disabled(model.exporting || model.file == nil)
                    Button("Save") { model.owner?.save(nil) }.buttonStyle(.genHoverPlain())
                }
            } details: {
                HStack(spacing: 5) {
                    ForEach(ModelRoomMode.allCases, id: \.self) { mode in
                        Button(mode.rawValue) { model.mode = mode }
                            .buttonStyle(.genHoverPlain())
                            .padding(.horizontal, 8).padding(.vertical, 4)
                            .background(model.mode == mode ? ReviewPalette.renamed.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 6))
                            .accessibilityAddTraits(model.mode == mode ? [.isSelected] : [])
                    }
                    Spacer()
                    Button(model.importing ? "Reading data…" : "Import data", systemImage: "tablecells") { model.chooseObservationTable() }
                        .buttonStyle(.genHoverPlain()).disabled(model.importing)
                    Button("Explore ranges", systemImage: "chart.xyaxis.line") { model.showSweep = true }
                        .buttonStyle(.genHoverPlain()).disabled(model.file == nil)
                    Button("Add quantity", systemImage: "plus") { model.showAddQuantity = true }
                        .buttonStyle(.genHoverPlain()).keyboardShortcut("n", modifiers: [.command, .shift])
                    Button("Branch", systemImage: "arrow.triangle.branch") { model.forkScenario() }
                        .buttonStyle(.genHoverPlain()).keyboardShortcut("b", modifiers: [.command, .shift])
                }
            }
            .hubSurface(.chrome)

            if let file = model.file {
                GeometryReader { geometry in
                    HStack(spacing: 0) {
                        if model.mode != .present {
                            ResizableSidePanel(key: "model-room.outline", edge: .leading, title: "Model outline", defaultWidth: 218, minWidth: 180, maxWidth: geometry.size.width * 0.3, autoCollapse: geometry.size.width < 920) {
                                outline(file).hubSurface(.chrome)
                            }
                        }
                        VStack(spacing: 0) {
                            switch model.mode {
                            case .build:
                                ModelRoomBoard(model: model)
                                Divider()
                                ModelRoomChart(model: model).frame(height: max(190, geometry.size.height * 0.32))
                            case .explore:
                                assumptionControls(file).padding(20)
                                ModelRoomChart(model: model)
                            case .compare:
                                comparison(file)
                                ModelRoomChart(model: model)
                            case .present:
                                presentation(file)
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .hubSurface(.content)
                        if model.mode == .build {
                            ResizableSidePanel(key: "model-room.inspector", edge: .trailing, title: "Quantity inspector", defaultWidth: 270, minWidth: 230, maxWidth: geometry.size.width * 0.34, autoCollapse: geometry.size.width < 1120) {
                                if let quantity = model.selected {
                                    ModelRoomInspector(model: model, quantity: quantity).hubSurface(.chrome)
                                } else {
                                    EmptyState(symbol: "cursorarrow", text: "Select a quantity", detail: "Its formula, unit and assumptions appear here.")
                                }
                            }
                        }
                    }
                }
                timeRail(file)
            } else {
                EmptyState(symbol: "point.3.connected.trianglepath.dotted", text: model.busy ? "Opening your model" : "Create a model", detail: "Quantities, relationships, and time in one place.")
            }
            if let error = model.error ?? model.scenarioResult?.error {
                NoticePill(text: error, detail: model.stale ? "The last valid result is still shown." : nil, isError: true) { model.error = nil }
                    .padding(8)
            }
            if let notice = model.notice {
                NoticePill(text: notice) { model.notice = nil }.padding(8)
            }
            HStack(spacing: 8) {
                Circle().fill(model.stale ? ReviewPalette.modified : ReviewPalette.added).frame(width: 5, height: 5)
                Text(model.busy ? "Calculating locally…" : model.stale ? "Last valid result · model has changed" : "Local calculation")
                Text("· Explicit Euler · \(model.file?.time.step ?? 1, specifier: "%g") \(model.file?.time.unit ?? "day") step")
                Spacer()
                Text("\(model.file?.quantities.count ?? 0) quantities · \((model.file?.scenarios.count ?? 0) + 1) scenarios")
                Text(model.owner?.fileURL == nil ? "Untitled model" : model.owner?.isDocumentEdited == true ? "Unsaved changes" : "Saved locally")
            }
            .font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim)
            .padding(.horizontal, 16).padding(.vertical, 8).hubSurface(.bar)
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $model.showAddQuantity) { ModelRoomAddQuantity(model: model) }
        .sheet(isPresented: $model.showSweep) { ModelRoomSweepSheet(model: model) }
        .sheet(item: $model.tableImport) { source in ModelRoomImportSheet(model: model, source: source) }
    }

    private func outline(_ file: ModelRoomFile) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("The model").font(.system(size: 12, weight: .semibold))
                    Text("Trace a value back to its assumptions.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                }
                ForEach(file.quantities) { quantity in
                    Button { model.selectedQuantity = quantity.id } label: {
                        HStack {
                            Image(systemName: quantity.kind == "stock" ? "tray.full" : quantity.kind == "formula" ? "function" : quantity.kind == "data" ? "tablecells" : "slider.horizontal.3")
                                .frame(width: 18).foregroundStyle(ReviewPalette.renamed)
                            Text(quantity.label).lineLimit(2)
                            Spacer(minLength: 2)
                        }
                        .padding(7)
                        .background(model.selectedQuantity == quantity.id ? ReviewPalette.renamed.opacity(0.12) : .clear)
                    }
                    .buttonStyle(RowButtonStyle()).accessibilityLabel("Select \(quantity.label)")
                }
                Divider()
                Text("Scenarios").font(.system(size: 12, weight: .semibold))
                scenarioRow(id: "", label: "Baseline", color: "#a9c9ff")
                ForEach(file.scenarios) { scenario in
                    scenarioRow(id: scenario.id, label: scenario.label, color: scenario.color)
                }
                Button("New branch", systemImage: "arrow.triangle.branch") { model.forkScenario() }
                    .buttonStyle(.genHoverPlain())
                Divider()
                Text("Assumptions").font(.system(size: 12, weight: .semibold))
                Text(file.description).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
            }.padding(14)
        }
    }

    private func scenarioRow(id: String, label: String, color: String) -> some View {
        Button { model.selectedScenario = id } label: {
            HStack {
                Circle().fill(modelRoomColor(color)).frame(width: 7, height: 7)
                Text(label).font(.system(size: 12)).lineLimit(2)
                Spacer()
                if model.selectedScenario == id { Image(systemName: "checkmark").font(.system(size: 10)) }
            }.padding(7)
        }.buttonStyle(RowButtonStyle())
    }

    private func assumptionControls(_ file: ModelRoomFile) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Change an assumption").font(.system(size: 20, weight: .semibold))
            Text("Option-drag a slider to branch. The baseline stays fixed.").foregroundStyle(ReviewPalette.dim)
            ForEach(file.quantities.filter { $0.kind == "input" && $0.range != nil }) { quantity in
                ModelRoomInputSlider(model: model, quantity: quantity)
            }
        }.frame(maxWidth: 700, alignment: .leading)
    }

    private func comparison(_ file: ModelRoomFile) -> some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 12) {
                GridRow {
                    Text("Assumption").foregroundStyle(ReviewPalette.dim)
                    Text("Baseline").foregroundStyle(modelRoomColor("#a9c9ff"))
                    ForEach(file.scenarios) { scenario in Text(scenario.label).foregroundStyle(modelRoomColor(scenario.color)) }
                }
                ForEach(file.quantities.filter { $0.kind == "input" }) { quantity in
                    GridRow {
                        Text(quantity.label)
                        Text("\(quantity.baseValue, specifier: "%g") \(quantity.unit)").monospacedDigit()
                        ForEach(file.scenarios) { scenario in
                            Text("\(scenario.overrides[quantity.id] ?? quantity.baseValue, specifier: "%g") \(quantity.unit)")
                                .monospacedDigit().foregroundStyle(scenario.overrides[quantity.id] == nil ? ReviewPalette.dim : .primary)
                        }
                    }
                }
                GridRow {
                    Text("Interventions").foregroundStyle(ReviewPalette.dim)
                    Text("None")
                    ForEach(file.scenarios) { scenario in
                        Text(scenario.interventions.map { "\($0.label) · \($0.at.formatted()) \(file.time.unit)" }.joined(separator: "\n"))
                            .frame(maxWidth: 220, alignment: .leading)
                    }
                }
            }.font(.system(size: 12)).padding(24)
        }
    }

    private func presentation(_ file: ModelRoomFile) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text(file.title).font(.system(size: 26, weight: .semibold))
                    Text("Explore the assumptions. Follow what changes.").foregroundStyle(ReviewPalette.dim)
                }
                Spacer()
                if !file.presentation.steps.isEmpty {
                    IconButton(systemName: "chevron.left", tooltip: "Previous explanation") { selectPresentationStep(-1, file: file) }
                    Text("\(model.presentationStep + 1) / \(file.presentation.steps.count)").monospacedDigit()
                    IconButton(systemName: "chevron.right", tooltip: "Next explanation") { selectPresentationStep(1, file: file) }
                }
            }
            if file.presentation.steps.indices.contains(model.presentationStep) {
                let step = file.presentation.steps[model.presentationStep]
                VStack(alignment: .leading, spacing: 6) {
                    Text("Author’s explanation · this text stays as written when controls change.")
                        .font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim)
                    Text(step.title).font(.system(size: 16, weight: .medium))
                    Text(step.text).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
                }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
                    .background(ReviewPalette.renamed.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            }
            ForEach(file.quantities.filter { $0.kind == "input" && file.presentation.controls.contains($0.id) && $0.range != nil }) { quantity in
                ModelRoomInputSlider(model: model, quantity: quantity)
            }
            ModelRoomChart(model: model)
            Text(file.description).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
        }.padding(24)
    }

    private func selectPresentationStep(_ direction: Int, file: ModelRoomFile) {
        model.presentationStep = max(0, min(file.presentation.steps.count - 1, model.presentationStep + direction))
        let step = file.presentation.steps[model.presentationStep]
        model.selectedScenario = step.scenario ?? ""
        if let time = step.time {
            let tick = (time / file.time.step).rounded()
            if tick.isFinite { model.tick = Int(max(0, min(Double(model.maximumTick), tick))) }
        }
    }

    private func timeRail(_ file: ModelRoomFile) -> some View {
        HStack(spacing: 14) {
            IconButton(systemName: model.playing ? "pause.fill" : "play.fill", tooltip: model.playing ? "Pause time" : "Play time") { model.togglePlayback() }
            IconButton(systemName: "forward.frame", tooltip: "Advance one step") { model.tick = min(model.maximumTick, model.tick + 1) }
            IconButton(systemName: "backward.end", tooltip: "Reset time") { model.stopPlayback(); model.tick = 0 }
            Text("\(Double(model.tick) * file.time.step, specifier: "%g") \(file.time.unit)").font(.system(size: 12, weight: .medium)).monospacedDigit().frame(minWidth: 68)
            Slider(value: Binding(get: { Double(model.tick) }, set: { model.tick = Int($0) }), in: 0...Double(model.maximumTick), step: 1)
                .accessibilityLabel("Simulation time")
            Text("\(file.time.duration, specifier: "%g") \(file.time.unit)").foregroundStyle(ReviewPalette.dim).font(.system(size: 11))
            Button("Stop") { model.stop() }.buttonStyle(.genHoverPlain())
        }.padding(.horizontal, 16).padding(.vertical, 10).hubSurface(.bar)
    }
}

struct ModelRoomInputSlider: View {
    @ObservedObject var model: ModelRoomModel
    let quantity: ModelRoomQuantity
    var body: some View {
        if let range = quantity.range, range.min < range.max {
            HStack(spacing: 14) {
                Text(quantity.label).frame(width: 140, alignment: .leading)
                Slider(value: Binding(get: { model.inputValue(quantity) }, set: { model.setInput(quantity.id, value: $0) }), in: range.min...range.max, step: range.step) { editing in
                    if editing { model.beginGesture(branch: (NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags).contains(.option)) }
                    else { model.finishGesture() }
                }.accessibilityLabel(quantity.label)
                Text("\(model.inputValue(quantity), specifier: "%g") \(quantity.unit)")
                    .font(.system(size: 12, design: .monospaced)).frame(minWidth: 100, alignment: .trailing)
            }.font(.system(size: 12))
        }
    }
}

struct ModelRoomChart: View {
    @ObservedObject var model: ModelRoomModel
    var output: ModelRoomQuantity? {
        guard let file = model.file else { return nil }
        return file.quantities.first { $0.id == model.selectedQuantity } ?? file.quantities.first { file.presentation.outputs.contains($0.id) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(output?.label ?? "Results").font(.system(size: 13, weight: .semibold))
                Text(output?.unit ?? "").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                ForEach(model.evaluation?.scenarios ?? [], id: \.selectionID) { scenario in
                    HStack(spacing: 4) {
                        Circle().fill(modelRoomColor(scenario.color)).frame(width: 6, height: 6)
                        Text(scenario.label).font(.system(size: 10)).lineLimit(1)
                    }
                }
            }
            if let output {
                Chart {
                    ForEach(model.evaluation?.scenarios ?? [], id: \.selectionID) { scenario in
                        ForEach(scenario.result?.chartFrames[output.id] ?? [], id: \.tick) { frame in
                            if let value = frame.values[output.id] {
                                LineMark(x: .value("Time", frame.time), y: .value(output.label, value), series: .value("Scenario", scenario.label))
                                    .foregroundStyle(modelRoomColor(scenario.color))
                                    .lineStyle(StrokeStyle(lineWidth: scenario.selectionID == model.selectedScenario ? 2.8 : 1.5))
                            }
                        }
                    }
                    RuleMark(x: .value("Selected time", Double(model.tick) * (model.file?.time.step ?? 1)))
                        .foregroundStyle(ReviewPalette.dim).lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                }
                .chartXAxisLabel(model.file?.time.unit ?? "Time")
                .accessibilityLabel("\(output.label) over time for \((model.file?.scenarios.count ?? 0) + 1) scenarios")
            }
        }.padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

func modelRoomColor(_ hex: String) -> Color {
    let value = UInt32(hex.dropFirst(), radix: 16) ?? 0xa9c9ff
    return Color(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
}
