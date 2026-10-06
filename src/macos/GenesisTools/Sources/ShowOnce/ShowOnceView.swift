import GenesisKit
import SwiftUI

struct ShowOnceView: View {
    @ObservedObject var model: ShowOnceModel
    private var locked: Bool { model.running || model.recording || model.busy }
    var body: some View {
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 14) {
                    Text("Show Once").font(.system(size: 15, weight: .semibold)).titlebarLabel()
                    Text(model.dirty ? "Unsaved workflow" : model.recipe?.title ?? "Demonstrate a task").foregroundStyle(ReviewPalette.dim).titlebarLabel()
                    Spacer()
                    Button("Open / import", action: model.chooseOpen).buttonStyle(.genHoverPlain()).disabled(locked)
                    Button("Save") { model.save() }.buttonStyle(.genHoverPlain()).disabled(locked || model.recipe == nil)
                    Button("Export") { model.save(export: true) }.buttonStyle(.genHoverPlain()).disabled(locked || model.recipe == nil)
                }
            } details: {
                HStack {
                    Text("Browser report tasks and verified file moves").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Inspect JSON", action: model.editJSON).buttonStyle(.genHoverPlain()).disabled(locked || model.recipe == nil)
                    Button("Validate", action: model.validate).buttonStyle(.genHoverPlain()).disabled(locked || model.recipe == nil)
                }
            }
            connection.padding(14).hubSurface(.bar)
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            GeometryReader { proxy in
                HStack(spacing: 0) {
                    ResizableSidePanel(key: "show-once.steps", edge: .leading, title: "Workflow", defaultWidth: 280,
                        minWidth: 220, maxWidth: max(280, proxy.size.width * 0.4), autoCollapse: proxy.size.width < 850) {
                        stepList
                    }
                    ScrollView { stepEditor.padding(22).frame(maxWidth: .infinity, alignment: .topLeading) }.hubSurface(.content)
                    ResizableSidePanel(key: "show-once.inputs", edge: .trailing, title: "Run inputs", defaultWidth: 310,
                        minWidth: 250, maxWidth: max(310, proxy.size.width * 0.4), autoCollapse: proxy.size.width < 1000) {
                        ScrollView { runPanel.padding(16) }
                    }
                }
            }
            HStack {
                Text(model.notice).font(.system(size: 12)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Spacer()
                if model.running || model.busy { ProgressView().controlSize(.small) }
            }.padding(12).hubSurface(.bar)
        }
        .foregroundStyle(.white).hubSurface(.chrome)
        .sheet(isPresented: $model.showJSON) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Inspect or repair the portable recipe").font(.title2)
                Text("Edits are validated before they replace the workflow. Repair changes data; it never resumes a possibly executed action.").foregroundStyle(ReviewPalette.dim)
                TextEditor(text: $model.jsonDraft).font(.system(size: 12, design: .monospaced)).frame(minWidth: 850, minHeight: 550)
                HStack { Button("Cancel") { model.showJSON = false }.buttonStyle(.genHoverPlain()); Spacer(); Button("Validate and apply", action: model.applyJSON).buttonStyle(.genHoverPlain()) }
            }.padding(24).hubSurface(.content)
        }
    }
    private var connection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Picker("Recording browser", selection: $model.browserId) {
                    ForEach(model.browsers) { browser in Text(browser.name).tag(browser.id) }
                }.frame(width: 220).disabled(locked)
                TextField("Start page", text: $model.browserURL).accessibilityLabel("Start page").disabled(locked)
                Button("Open recording browser", action: model.openRecordingBrowser).buttonStyle(.genHoverPlain())
                    .disabled(locked || model.browserId.isEmpty)
            }
            Text("Open a separate browser window, sign in there if needed, then select its tab. Find tabs can also discover existing debugger connections when the port is empty.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Text("Debugger port").foregroundStyle(ReviewPalette.dim)
                TextField("Port", text: $model.port).accessibilityLabel("Debugger port").frame(width: 80).disabled(locked)
                Button("Find tabs", action: model.refreshTabs).buttonStyle(.genHoverPlain()).disabled(locked)
                Picker("Browser tab", selection: $model.targetId) {
                    Text("Select the exact tab").tag("")
                    ForEach(model.tabs) { tab in Text(tab.title + " · " + tab.url).tag(tab.id) }
                }.disabled(locked).onChange(of: model.targetId) { _, id in model.selectTab(id) }
                Spacer()
            }

            HStack(spacing: 12) {
                Button("Download folder") { model.chooseFolder(download: true) }.buttonStyle(.genHoverPlain()).disabled(locked)
                if !model.downloads.isEmpty { PathLabel(path: model.downloads).lineLimit(1) }
                Button("Move destination") { model.chooseFolder(download: false) }.buttonStyle(.genHoverPlain()).disabled(locked)
                if !model.destination.isEmpty { PathLabel(path: model.destination).lineLimit(1) }
                Spacer()
                if model.recording {
                    Text("\(model.recordingCount) actions · \(model.capturedDownloads) captured downloads").monospacedDigit().foregroundStyle(ReviewPalette.removed)
                    Button("Stop and inspect", action: model.stopRecording).buttonStyle(.genHoverPlain()).disabled(model.busy)
                } else {
                    Button("Record demonstration", action: model.startRecording).buttonStyle(.genHoverPlain())
                        .disabled(model.running || model.busy || model.targetId.isEmpty || model.downloads.isEmpty || model.destination.isEmpty)
                }
            }
            Text("During this task, browser downloads use the workflow folders. Finish other downloads before recording or replaying.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
        }.font(.system(size: 12))
    }
    private var stepList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack { Text("Workflow").font(.headline); Spacer(); Text("\(model.recipe?.steps.count ?? 0) steps").foregroundStyle(ReviewPalette.dim) }.padding(14)
            if let recipe = model.recipe {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(recipe.steps) { step in stepRow(step) }
                    }.padding(.bottom, 12)
                }
                HStack {
                    IconButton(systemName: "arrow.up", tooltip: "Move selected step earlier") { model.moveStep(-1) }
                    IconButton(systemName: "arrow.down", tooltip: "Move selected step later") { model.moveStep(1) }
                    IconButton(systemName: "trash", tooltip: "Delete selected step") { model.deleteStep() }
                    Spacer()
                }.padding(12).disabled(locked)
                HStack {
                    Button("Add checkpoint") { model.addStep(kind: "checkpoint") }.buttonStyle(.genHoverPlain())
                    Button("Add file move") { model.addStep(kind: "move") }.buttonStyle(.genHoverPlain())
                }.font(.system(size: 11)).padding([.horizontal, .bottom], 12).disabled(locked)
            } else {
                VStack(alignment: .leading, spacing: 14) {
                    Image(systemName: "record.circle").font(.system(size: 28)).foregroundStyle(ReviewPalette.renamed)
                    Text("Show the task once").font(.headline)
                    Text("Record an explicit browser tab. Download its report, rename it and move it into the chosen folder. The file's content connects the observed download to the move.").font(.system(size: 13)).foregroundStyle(ReviewPalette.dim)
                    Text("Other Mac app actions stay unsupported. The recorder does not infer their behavior from coordinates.").font(.system(size: 12)).foregroundStyle(ReviewPalette.modified)
                }.padding(18)
                Spacer()
            }
        }.hubSurface(.chrome)
    }
    private func stepRow(_ step: ShowOnceStep) -> some View {
        let index = model.recipe?.steps.firstIndex(where: { $0.id == step.id }) ?? 0
        let status = model.progress.last(where: { $0.stepId == step.id })?.status
        return Button { model.selectedStep = step.id } label: {
            HStack(alignment: .top, spacing: 10) {
                Text("\(index + 1)").font(.system(size: 12, design: .monospaced)).foregroundStyle(ReviewPalette.dim).frame(width: 24)
                VStack(alignment: .leading, spacing: 5) {
                    Text(step.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                    Text(step.kind + (step.enabled ? "" : " · disabled")).font(.system(size: 11)).foregroundStyle(step.kind == "unsupported" ? ReviewPalette.modified : ReviewPalette.dim)
                    if let status { Text(status).font(.system(size: 11)).foregroundStyle(statusColor(status)) }
                }
                Spacer(minLength: 0)
            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                .background(model.selectedStep == step.id ? ReviewPalette.renamed.opacity(0.12) : Color.clear)
        }.buttonStyle(RowButtonStyle()).padding(.horizontal, 8)
    }

    @ViewBuilder private var stepEditor: some View {
        if let step = model.selected {
            VStack(alignment: .leading, spacing: 18) {
                HStack { Text("Step details").font(.title2); Spacer(); Toggle("Enabled", isOn: Binding(get: { model.selected?.enabled ?? false }, set: { enabled in model.mutateStep { $0.enabled = enabled } })).toggleStyle(.checkbox).disabled(locked) }
                field("Name", step.title) { value in model.mutateStep { $0.title = value } }
                Text("Action: " + step.kind).font(.system(size: 12, design: .monospaced)).foregroundStyle(ReviewPalette.dim)
                if let locator = step.locator {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Semantic target").font(.headline)
                        Text("Replay requires one current match on the expected page. Changed, missing, hidden, and ambiguous targets stop the run.").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                        Picker("Target kind", selection: Binding(get: { model.selected?.locator?.kind ?? "testId" }, set: { kind in model.mutateStep { $0.locator?.kind = kind } })) {
                            Text("Test ID").tag("testId"); Text("Role and name").tag("role"); Text("CSS with recorded evidence").tag("css")
                        }.disabled(locked)
                        field("Target", locator.value) { value in model.mutateStep { $0.locator?.value = value } }
                        if locator.kind == "role" { field("Exact accessible name", locator.name ?? "") { value in model.mutateStep { $0.locator?.name = value } } }
                        if let fingerprint = locator.fingerprint {
                            field("Expected element tag", fingerprint.tag) { value in model.mutateStep { $0.locator?.fingerprint?.tag = value } }
                            field("Expected role", fingerprint.role) { value in model.mutateStep { $0.locator?.fingerprint?.role = value } }
                            field("Expected accessible name", fingerprint.name) { value in model.mutateStep { $0.locator?.fingerprint?.name = value } }
                            Text("Changing these fields explicitly repairs target identity. Inspect the browser first; the source evidence retains the original target.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        }
                    }
                }
                if let url = step.pageUrl { field("Expected document URL", url) { value in model.mutateStep { $0.pageUrl = value } } }
                if let url = step.url { field("Navigate to", url) { value in model.mutateStep { $0.url = value } } }
                if let value = step.value { field("Value or {{parameter}}", value) { value in model.mutateStep { $0.value = value } } }
                if let filename = step.filename { field("Expected filename", filename) { value in model.mutateStep { $0.filename = value } } }
                if let destination = step.destination { field("Destination folder", destination) { value in model.mutateStep { $0.destination = value } } }
                if let checks = step.contains { field("Required content, one check per line", checks.joined(separator: "\n"), multiline: true) { value in model.mutateStep { $0.contains = value.split(separator: "\n").map(String.init) } } }
                if let message = step.message { field("Checkpoint instruction", message, multiline: true) { value in model.mutateStep { $0.message = value } } }
                if let reason = step.reason { Text(reason).foregroundStyle(ReviewPalette.modified).textSelection(.enabled) }
                Divider()
                VStack(alignment: .leading, spacing: 8) {
                    Text("Source evidence").font(.headline)
                    Text(step.evidence.detail).font(.system(size: 13)).textSelection(.enabled)
                    if let value = step.evidence.recordedValue { Text("Recorded value: " + value).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }
                    if let locator = step.evidence.recordedLocator { Text(recordedTargetText(locator)).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled) }
                    if let name = step.evidence.recordedFilename { Text("Recorded filename: " + name).font(.system(size: 11, design: .monospaced)).textSelection(.enabled) }
                    if let hash = step.evidence.sha256 { Text("Recorded SHA-256: " + hash).font(.system(size: 10, design: .monospaced)).textSelection(.enabled) }
                    Text("Event " + step.evidence.eventId).font(.system(size: 11, design: .monospaced)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
                    if !step.evidence.url.isEmpty { Text(step.evidence.url).font(.system(size: 11, design: .monospaced)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled) }
                }
                if let failure = model.progress.last(where: { $0.stepId == step.id && ["refused", "uncertain"].contains($0.status) }) {
                    Divider()
                    Text(failure.status == "uncertain" ? "Action may have executed" : "Action refused").font(.headline).foregroundStyle(ReviewPalette.removed)
                    Text(failure.message).textSelection(.enabled)
                    Text("Inspect the actual browser and file state. Edit the target or recipe, validate it, and explicitly start a new run. No retry is automatic.").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 20) {
                Text("A demonstration becomes a workflow").font(.system(size: 27, weight: .semibold))
                Text("1. Choose a browser tab and two folders.\n2. Record the browser download and file move.\n3. Inspect every step and turn changing values into inputs.\n4. Replay and inspect the verified output.").font(.system(size: 16)).lineSpacing(10).foregroundStyle(ReviewPalette.dim)
                Text("Recipes contain structured actions and checks. Exported JSON can run through the CLI or MCP using the same replay engine.").font(.system(size: 14)).foregroundStyle(ReviewPalette.dim)
            }.padding(.top, 40)
        }
    }
    private func field(_ title: String, _ value: String, multiline: Bool = false, set: @escaping (String) -> Void) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(ReviewPalette.dim)
            if multiline { TextEditor(text: Binding(get: { value }, set: set)).accessibilityLabel(title).font(.system(size: 12, design: .monospaced)).frame(minHeight: 70).disabled(locked) }
            else { TextField(title, text: Binding(get: { value }, set: set)).accessibilityLabel(title).font(.system(size: 12, design: .monospaced)).textFieldStyle(.roundedBorder).disabled(locked) }
        }
    }
    private var runPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Inputs for this run").font(.headline)
            if let recipe = model.recipe {
                ForEach(recipe.parameters) { parameter in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(parameter.label).font(.system(size: 12, weight: .medium))
                        let binding = Binding(get: { model.inputs[parameter.name] ?? "" }, set: { model.inputs[parameter.name] = $0 })
                        if parameter.secret { SecureField("Requested only at run time", text: binding).accessibilityLabel(parameter.label).disabled(locked) }
                        else { TextField(parameter.name, text: binding).accessibilityLabel(parameter.label).disabled(locked) }
                        Text("{{\(parameter.name)}}" + (parameter.secret ? " · runtime secret" : "")).font(.system(size: 10, design: .monospaced)).foregroundStyle(ReviewPalette.dim)
                    }
                }
                if recipe.parameters.isEmpty { Text("Select a changing input step and add its parameter below.").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim) }
                HStack {
                    Button("Run workflow", action: model.run).buttonStyle(.genHoverPlain()).disabled(locked || model.targetId.isEmpty)
                    Button("Cancel", action: model.cancel).buttonStyle(.genHoverPlain()).disabled(!model.running && !model.recording)
                }
                if let checkpoint = model.checkpoint {
                    Text(checkpoint.message).font(.system(size: 12)).foregroundStyle(ReviewPalette.modified)
                    Button("I checked it. Continue.", action: model.resume).buttonStyle(.genHoverPlain())
                }
                Divider()
                Text("Make an input parameter").font(.headline)
                TextField("Parameter name", text: $model.parameterName).accessibilityLabel("Parameter name").disabled(locked)
                TextField("Label", text: $model.parameterLabel).accessibilityLabel("Parameter label").disabled(locked)
                Toggle("Secret, requested at run time", isOn: $model.parameterSecret).toggleStyle(.checkbox).disabled(locked)
                Button("Add parameter", action: model.addParameter).buttonStyle(.genHoverPlain()).disabled(locked)
                Text("A selected fill/select step uses the new parameter. Add {{name}} references to changing filenames and content checks in the editor.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            }
            if let receipt = model.receipt {
                Divider()
                Text("Run " + receipt.status).font(.headline).foregroundStyle(receipt.status == "completed" ? ReviewPalette.added : ReviewPalette.removed)
                ForEach(receipt.files) { file in
                    VStack(alignment: .leading, spacing: 6) {
                        PathLabel(path: file.path)
                        Text("\(file.size) bytes · SHA-256 readback").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                        Text(file.sha256).font(.system(size: 9, design: .monospaced)).lineLimit(2).textSelection(.enabled)
                    }
                }
            }
            if !model.history.isEmpty {
                Divider(); Text("Retained run receipts").font(.headline)
                ForEach(model.history, id: \.runId) { receipt in
                    Button(receipt.status + " · " + String(receipt.runId.prefix(8))) {
                        model.receipt = receipt; model.progress = receipt.events
                    }.buttonStyle(.genHoverPlain()).disabled(locked)
                    if let file = receipt.receiptFile { PathLabel(path: file).font(.system(size: 10)) }
                }
                Text("Receipts contain step outcomes, recipe hashes, and checked files. Runtime input values are not stored.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            }
            if !model.progress.isEmpty {
                Divider(); Text("Replay progress").font(.headline)
                ForEach(Array(model.progress.suffix(24))) { event in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(event.status + " · " + event.stepId).font(.system(size: 10, design: .monospaced)).foregroundStyle(statusColor(event.status))
                        Text(event.message).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
                    }
                }
            }
            Spacer(minLength: 0)
        }.textFieldStyle(.roundedBorder)
    }
    private func recordedTargetText(_ locator: ShowOnceLocator) -> String {
        let name = locator.fingerprint?.name ?? locator.name ?? ""
        return "Recorded target: \(locator.kind) · \(locator.value) · \(name)"
    }
    private func statusColor(_ status: String) -> Color {
        if status == "verified" { return ReviewPalette.added }
        if status == "refused" || status == "uncertain" { return ReviewPalette.removed }
        return ReviewPalette.modified
    }
}
