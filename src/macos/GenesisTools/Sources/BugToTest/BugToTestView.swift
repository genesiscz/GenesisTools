import AppKit
import GenesisKit
import SwiftUI

struct BugToTestView: View {
    @ObservedObject var model: BugToTestModel
    private func field(_ key: ReferenceWritableKeyPath<BugToTestModel, String>) -> Binding<String> {
        Binding(get: { model[keyPath: key] }, set: {
            guard !model.busy else { return }
            model[keyPath: key] = $0; model.changed()
        })
    }
    var body: some View {
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 12) {
                    Image(systemName: "ladybug").foregroundStyle(ReviewPalette.renamed)
                    Text("Bug to Test").font(.system(size: 13, weight: .semibold)).titlebarLabel()
                    Text(model.recording?.title ?? "Record · prove · rerun").foregroundStyle(ReviewPalette.dim).lineLimit(1).titlebarLabel()
                    Spacer()
                    Button("Open…") { model.open() }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                    Button("Save recording…") { model.saveAs() }.buttonStyle(.genHoverPlain()).disabled(model.busy || model.recording == nil)
                    Button("Export repro…", systemImage: "square.and.arrow.up") { model.export() }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || model.workspace == nil)
                }
            } details: {
                HStack(spacing: 12) {
                    Text("Local browser capture · private by default").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    if model.isRecording {
                        Button("Stop recording", systemImage: "stop.circle.fill") { model.stopRecording() }.buttonStyle(.genHoverPlain())
                    } else {
                        Button("Record selected tab", systemImage: "record.circle") { model.startRecording() }
                            .buttonStyle(.genHoverPlain()).disabled(model.busy || model.selectedTab.isEmpty)
                    }
                }
            }.hubSurface(.chrome)
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    ResizableSidePanel(key: "bug-to-test.browser", edge: .leading, title: "Browser tabs",
                        defaultWidth: 230, minWidth: 180, maxWidth: geometry.size.width * 0.3, autoCollapse: false) {
                        browserPane.hubSurface(.chrome)
                    }
                    HSplitView {
                        reviewPane.frame(minWidth: 330, maxWidth: .infinity, maxHeight: .infinity)
                        expectationPane.frame(minWidth: 320, idealWidth: 390, maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }.hubSurface(.content)
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil }.padding(8) }
            if let notice = model.notice { NoticePill(text: notice) { model.notice = nil }.padding(8) }
            HStack(spacing: 10) {
                if model.busy {
                    ProgressView().controlSize(.small)
                    Text(model.progress).font(.system(size: 11)).lineLimit(2)
                    Spacer()
                    Button(model.isRecording ? "Stop and save" : "Cancel") { model.cancel() }.buttonStyle(.genHoverPlain())
                } else {
                    Text(model.recording == nil ? "Select a tab to begin, or open a recording." : "Review exclusions and redactions before generating. Saved automatically on this Mac.")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Spacer()
                }
            }.padding(10).hubSurface(.bar)
        }
        .foregroundStyle(Color.white)
        .frame(minWidth: 900, minHeight: 680)
    }
    private var browserPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Browser and tab").font(.system(size: 14, weight: .semibold))
                Text("Open a separate browser for recording, or refresh to find existing recording tabs.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Picker("Recording browser", selection: $model.selectedBrowser) {
                    ForEach(model.browsers) { browser in Text(browser.name).tag(browser.id) }
                }.disabled(model.busy)
                TextField("Initial website URL (optional)", text: $model.initialBrowserURL).textFieldStyle(.roundedBorder).disabled(model.busy)
                Button("Open recording browser") { model.openRecordingBrowser() }.buttonStyle(.genHoverPlain()).disabled(model.busy || model.selectedBrowser.isEmpty)
                Text("The separate browser uses a fresh profile. Sign in there if needed, then choose its tab. Your other browser windows stay open.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                HStack {
                    TextField("Debugging port (optional)", text: $model.port).textFieldStyle(.roundedBorder)
                    IconButton(systemName: "arrow.clockwise", tooltip: "Refresh local browser tabs") { model.refreshTabs() }.disabled(model.busy)
                }
                ForEach(model.tabs) { tab in
                    Button { model.selectedTab = tab.id } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack { Image(systemName: model.selectedTab == tab.id ? "checkmark.circle.fill" : "globe"); Text(tab.title).lineLimit(2) }
                            Text(tab.url).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim).lineLimit(3)
                            Text("Port \(tab.port)").font(.system(size: 10, design: .monospaced)).foregroundStyle(ReviewPalette.dim)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                    }.buttonStyle(RowButtonStyle(cornerRadius: 6)).disabled(model.busy)
                }
                Button("Recover local recording…") { model.recover() }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                Divider()
                TextField("Bug title", text: field(\.title)).textFieldStyle(.roundedBorder).disabled(model.busy)
                if let recording = model.recording {
                    Text("\(recording.actions.filter { !$0.excluded }.count) included actions · \(recording.evidence.filter { !$0.excluded }.count) evidence entries")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Text("Sensitive fields are omitted. Request bodies, cookies, authorization headers and browser storage are never captured.")
                        .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Text("Recording URL").font(.system(size: 11, weight: .medium))
                    PathLabel(path: model.localRecordingPath, title: "Autosaved recording")
                    TextField("Starting URL (edit to redact)", text: Binding(get: { recording.initialUrl }, set: { model.recording?.initialUrl = $0; model.changed() }), axis: .vertical)
                        .textFieldStyle(.roundedBorder).font(.system(size: 10, design: .monospaced)).disabled(model.busy)
                }
                Divider()
                Text("Execution browser").font(.system(size: 11, weight: .medium))
                TextField("Chromium binary, or blank for Playwright", text: $model.browserBinary).textFieldStyle(.roundedBorder)
                    .instantTooltip("Playwright runs a new isolated browser context using this executable.")
                Text("Node.js and a Chromium browser are required. Every run has a 30-second deadline.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            }.padding(12)
        }
    }
    private var reviewPane: some View {
        VStack(spacing: 0) {
            Picker("Review captured data", selection: $model.reviewPage) {
                Text("Actions").tag("actions"); Text("Evidence").tag("evidence"); Text("Test").tag("source"); Text("Failure trace").tag("trace")
            }.pickerStyle(.segmented).padding(12)
            if let recording = model.recording {
                switch model.reviewPage {
                case "source":
                    ScrollView([.vertical, .horizontal]) {
                        Text(model.source.isEmpty ? "Generate a verified repro to inspect its ordinary Playwright source." : model.source)
                            .font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }
                case "trace": tracePane
                case "evidence":
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            Text("Exclude unrelated evidence or edit text to redact private details. Only included entries enter the export.")
                                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                            ForEach(recording.evidence) { evidence in evidenceRow(evidence) }
                        }.padding(12)
                    }
                default:
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            Text("Keep the trigger selected. Minimization removes earlier steps only when the same assertion still fails.")
                                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                            ForEach(Array(recording.actions.enumerated()), id: \.element.id) { index, action in actionRow(action, index: index) }
                            if recording.actions.isEmpty { Text("No supported user actions captured. The assertion can still check the initial page.").foregroundStyle(ReviewPalette.dim) }
                        }.padding(12)
                    }
                }
            } else {
                VStack(spacing: 18) {
                    Image(systemName: "ladybug").font(.system(size: 38)).foregroundStyle(ReviewPalette.dim)
                    Text("Turn a browser bug into a test").font(.system(size: 19, weight: .semibold))
                    Text("Record your actions, state what should happen, then verify the failure with Playwright.")
                        .font(.system(size: 13)).foregroundStyle(ReviewPalette.dim).multilineTextAlignment(.center)
                    Text("1  Select a tab\n2  Record the bug\n3  Review and redact\n4  State the expectation\n5  Prove, minimize, export and rerun")
                        .font(.system(size: 13)).lineSpacing(6)
                }.padding(28).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
    private func actionRow(_ action: BugToTestAction, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Toggle("\(index + 1). \(action.kind)", isOn: Binding(get: { !action.excluded }, set: { included in model.editAction(action.id) { $0.excluded = !included } }))
                Spacer()
                Button(model.recording?.triggerActionId == action.id ? "Trigger ✓" : "Keep as trigger") { model.recording?.triggerActionId = action.id; model.changed() }
                    .buttonStyle(.genHoverPlain()).disabled(action.excluded)
            }
            if let locator = action.locator {
                Text(locator.label).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                TextField("Recorded locator", text: Binding(get: { locator.value }, set: { value in model.editAction(action.id) { $0.locator?.value = value } })).textFieldStyle(.roundedBorder)
                if locator.kind == "role" {
                    TextField("Recorded accessible name", text: Binding(get: { locator.name ?? "" }, set: { value in model.editAction(action.id) { $0.locator?.name = value } })).textFieldStyle(.roundedBorder)
                }
                if let identity = locator.fingerprint {
                    Text("Recorded identity: \(identity.tag) · \(identity.role)").font(.system(size: 10, design: .monospaced)).foregroundStyle(ReviewPalette.dim)
                    TextField("Identity name (edit to redact)", text: Binding(get: { identity.name }, set: { value in model.editAction(action.id) { $0.locator?.fingerprint?.name = value } })).textFieldStyle(.roundedBorder)
                }
            }
            if let url = action.sourceUrl {
                TextField("Action source URL (edit to redact)", text: Binding(get: { url }, set: { value in model.editAction(action.id) { $0.sourceUrl = value } }), axis: .vertical).textFieldStyle(.roundedBorder).font(.system(size: 10, design: .monospaced))
            }
            if let url = action.url {
                TextField("Navigation URL (edit to redact)", text: Binding(get: { url }, set: { value in model.editAction(action.id) { $0.url = value } }), axis: .vertical).textFieldStyle(.roundedBorder).font(.system(size: 10, design: .monospaced))
            }
            if let value = action.value {
                TextField("Recorded value (edit to redact)", text: Binding(get: { value }, set: { value in model.editAction(action.id) { $0.value = value } })).textFieldStyle(.roundedBorder)
            }
            if action.locator != nil {
                Button("Use this target for assertion") { model.selectAssertionTarget(action) }.font(.system(size: 11)).buttonStyle(.genHoverPlain())
            }
        }.padding(10).background(Color.white.opacity(action.excluded ? 0.02 : 0.045), in: RoundedRectangle(cornerRadius: 6)).disabled(model.busy)
    }
    private func evidenceRow(_ evidence: BugToTestEvidence) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Toggle(evidence.kind, isOn: Binding(get: { !evidence.excluded }, set: { included in model.editEvidence(evidence.id) { $0.excluded = !included } }))
            TextField("Evidence text (edit to redact)", text: Binding(get: { evidence.text }, set: { text in model.editEvidence(evidence.id) { $0.text = text } }), axis: .vertical)
                .textFieldStyle(.roundedBorder).font(.system(size: 11, design: .monospaced)).lineLimit(2...8)
        }.padding(10).background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 6)).disabled(model.busy)
    }
    private var expectationPane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 13) {
                Text("What should happen?").font(.system(size: 15, weight: .semibold))
                Text("Write the expected behavior, then define its exact assertion. No browser data is sent to AI.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                TextField("Expected behavior, e.g. Adding one item shows count 1", text: field(\.description), axis: .vertical).lineLimit(2...4).textFieldStyle(.roundedBorder)
                Picker("Assertion", selection: field(\.assertionKind)) {
                    Text("Text equals").tag("text"); Text("Value equals").tag("value"); Text("Visible").tag("visible"); Text("URL equals").tag("url")
                }
                if model.assertionKind != "url" {
                    Picker("Locator", selection: field(\.locatorKind)) { Text("Test ID").tag("testId"); Text("Role + name").tag("role"); Text("CSS selector").tag("css") }
                    TextField("Assertion target", text: field(\.locatorValue)).textFieldStyle(.roundedBorder)
                    if model.locatorKind == "role" { TextField("Exact accessible name", text: field(\.locatorName)).textFieldStyle(.roundedBorder) }
                }
                TextField(model.assertionKind == "visible" ? "Expected: true or false" : "Expected exact value", text: field(\.expected)).textFieldStyle(.roundedBorder)
                Button("Generate and verify", systemImage: "play.circle.fill") { model.generateAndVerify() }.buttonStyle(.genHoverPlain()).disabled(!model.canGenerate)
                Text(model.assertionKind == "visible" && model.expected == "false"
                    ? "Hidden includes removed elements. More than one matching element is a setup failure."
                    : "A missing or ambiguous target is a setup failure. Only the stated assertion can prove the bug.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Divider()
                if let result = model.result {
                    Label(result.label, systemImage: result.status == "passed" ? "checkmark.circle.fill" : result.status == "intended-failure" ? "ladybug.fill" : "exclamationmark.triangle")
                        .font(.system(size: 15, weight: .semibold)).foregroundStyle(result.status == "passed" ? ReviewPalette.added : result.status == "intended-failure" ? ReviewPalette.removed : ReviewPalette.dim)
                    Text("\(Int(result.durationMs)) ms · exit \(result.exitCode)").font(.system(size: 11, design: .monospaced)).foregroundStyle(ReviewPalette.dim)
                    ScrollView { Text(result.message).font(.system(size: 10, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 190)
                    Text("Assertion SHA-256: " + result.testHash).font(.system(size: 9, design: .monospaced)).textSelection(.enabled)
                    Button("Minimize unnecessary steps") { model.minimize() }.buttonStyle(.genHoverPlain()).disabled(model.busy || result.status != "intended-failure" || model.recording?.triggerActionId == nil)
                    Button("Inspect failing trace") { model.reviewPage = "trace" }.buttonStyle(.genHoverPlain()).disabled(result.trace == nil)
                }
                if let workspace = model.workspace { PathLabel(path: workspace, title: "Generated isolated workspace") }
                Text("After the fix").font(.system(size: 13, weight: .semibold))
                TextField("Optional fixed deployment base URL", text: $model.baseURL).textFieldStyle(.roundedBorder)
                Button("Rerun same assertion", systemImage: "arrow.clockwise") { model.rerun() }.buttonStyle(.genHoverPlain()).disabled(model.busy || model.workspace == nil)
                Divider()
                Text("Portable export").font(.system(size: 13, weight: .semibold))
                Button("Choose local fixtures…") { model.chooseFixtures() }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                Text("\(model.exportFixtures.count) fixture files selected. Browser authentication and storage are not exported.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Button("Export Playwright bundle…") { model.export() }.buttonStyle(.genHoverPlain()).disabled(model.busy || model.workspace == nil)
            }.padding(16)
        }.disabled(model.busy)
    }
    private var tracePane: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text(model.result?.status == "intended-failure" ? "Observed Playwright failure" : "Playwright execution trace").font(.system(size: 15, weight: .semibold))
                if let result = model.result {
                    Text(result.message).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    if let trace = result.trace {
                        PathLabel(path: trace, title: "Trace ZIP")
                        Text("Open the isolated workspace in a terminal and run npx playwright show-trace with this trace ZIP. The archive contains the actual browser snapshots, network events and assertion location.")
                            .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        Button("Open trace viewer") { model.openTrace() }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                    }
                    PathLabel(path: result.report, title: "Playwright JSON report")
                } else {
                    Text("Generate and run the repro to capture an actual trace.").foregroundStyle(ReviewPalette.dim)
                }
            }.padding(16)
        }
    }
}
