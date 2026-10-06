import AppKit
import GenesisKit
import SwiftUI

extension RecastModel {
    func loadReconciliation(oldSourceId: String, newSourceId: String, jobId: String?) {
        guard let file else { return }
        perform("Comparing source evidence") { model in
            var args = ["--old", oldSourceId, "--new", newSourceId]
            if let jobId { args += ["--job", jobId] }
            let answer = try await model.command("reconcile", file: file, arguments: args)
            model.reconciliationPreview = try JSONDecoder().decode(RecastReconciliationPreview.self, from: Data(answer.utf8))
        }
    }

    func startReconciliation(oldSourceId: String, newSourceId: String) {
        perform("Starting source replacement review") { model in
            let id = recastID("reconciliation")
            try await model.apply([recastOperation("start-reconciliation", [
                "id": .string(id), "oldSourceId": .string(oldSourceId), "newSourceId": .string(newSourceId)
            ])], title: "Begin source replacement")
            guard let file = model.file else { return }
            model.reconciliationJobId = id
            let answer = try await model.command("reconcile", file: file, arguments: ["--old", oldSourceId, "--new", newSourceId, "--job", id])
            model.reconciliationPreview = try JSONDecoder().decode(RecastReconciliationPreview.self, from: Data(answer.utf8))
        }
    }

    func resolveReconciliation(_ choices: [String: String]) {
        guard let preview = reconciliationPreview, let jobId = preview.jobId,
              file?.id == preview.documentId, file?.revision == preview.revision else {
            error = "The conversion changed. Refresh this source comparison before applying decisions."
            return
        }
        let resolutions: [RecastJSON] = preview.items.filter { $0.decision == "pending" }.compactMap { item in
            guard let choice = choices[item.oldAnchorId], !choice.isEmpty else { return nil }
            if choice == "keep-original" {
                return .object(["oldAnchorId": .string(item.oldAnchorId), "decision": .string("keep")])
            }
            return .object(["oldAnchorId": .string(item.oldAnchorId), "decision": .string("relink"), "newAnchorId": .string(choice)])
        }
        guard !resolutions.isEmpty else { return }
        perform("Applying source review decisions") { model in
            try await model.apply([recastOperation("resolve-reconciliation", [
                "jobId": .string(jobId), "resolutions": .array(resolutions)
            ])], title: "Review source replacement")
            guard let file = model.file else { return }
            let answer = try await model.command("reconcile", file: file,
                arguments: ["--old", preview.oldSourceId, "--new", preview.newSourceId, "--job", jobId])
            model.reconciliationPreview = try JSONDecoder().decode(RecastReconciliationPreview.self, from: Data(answer.utf8))
            model.notice = "Source decisions saved. Review the retained values before accepting the affected records."
        }
    }

    func detachEvidence(_ anchor: RecastAnchor) {
        guard let state else { return }
        let controller = RecastEvidenceWindowController(state: state, anchor: anchor)
        evidenceWindows.append(controller)
        controller.onClose = { [weak self, weak controller] in
            guard let controller else { return }
            self?.evidenceWindows.removeAll { $0 === controller }
        }
        controller.showWindow(nil)
        controller.window?.makeKeyAndOrderFront(nil)
    }
}

@MainActor
final class RecastEvidenceWindowController: NSWindowController, NSWindowDelegate {
    let model: RecastModel
    var onClose: (() -> Void)?

    init(state: RecastState, anchor: RecastAnchor) {
        model = RecastModel(toolsPath: RecastConfiguration.toolsPath)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 760),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        super.init(window: window)
        window.title = "Evidence · " + (state.file.sources.first { $0.id == anchor.sourceId }?.name ?? "Source")
        window.minSize = NSSize(width: 420, height: 420)
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self
        window.contentView = NSHostingView(rootView: RecastSourcePane(model: model, readOnly: true).preferredColorScheme(.dark))
        window.center()
        model.install(state)
        model.reveal(anchor)
    }
    required init?(coder: NSCoder) { nil }
    func windowWillClose(_ notification: Notification) { model.stop(); onClose?() }
}

struct RecastReconciliationSheet: View {
    @ObservedObject var model: RecastModel
    @Environment(\.dismiss) private var dismiss
    @State private var oldSource = ""
    @State private var newSource = ""
    @State private var choices: [String: String] = [:]

    private var selectedCount: Int {
        model.reconciliationPreview?.items.filter { $0.decision == "pending" && !(choices[$0.oldAnchorId] ?? "").isEmpty }.count ?? 0
    }
    private var newAnchors: [RecastAnchor] { model.file?.anchors.filter { $0.sourceId == newSource } ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Review a source replacement").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("Close") { dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction).disabled(model.busy)
            }
            if model.reconciliationJobId == nil {
                HStack {
                    Picker("Original", selection: $oldSource) {
                        ForEach(model.file?.sources ?? []) { Text($0.name).tag($0.id) }
                    }.accessibilityLabel("Original source for replacement review")
                    Picker("Replacement", selection: $newSource) {
                        ForEach((model.file?.sources ?? []).filter { $0.id != oldSource }) { Text($0.name).tag($0.id) }
                    }.accessibilityLabel("Replacement source for review")
                }.disabled(model.busy)
                Text("Both files stay in the document. Affected records will need review before export. Read the replacement's regions first so Recast can suggest matches.")
                    .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                Button("Start source review") { model.startReconciliation(oldSourceId: oldSource, newSourceId: newSource) }
                    .buttonStyle(.genHoverPlain()).disabled(model.busy || oldSource.isEmpty || newSource.isEmpty || oldSource == newSource)
            } else {
                HStack {
                    Text((model.file?.sources.first { $0.id == oldSource }?.name ?? "Original") + " → " +
                        (model.file?.sources.first { $0.id == newSource }?.name ?? "Replacement"))
                        .font(.system(size: 12)).lineLimit(1)
                    Spacer()
                    Button("Refresh") { model.loadReconciliation(oldSourceId: oldSource, newSourceId: newSource, jobId: model.reconciliationJobId) }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy)
                }
            }
            if let preview = model.reconciliationPreview {
                HStack {
                    Text("\(preview.items.filter { $0.decision == "pending" }.count) unresolved regions").foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Choose exact matches") {
                        for item in preview.items where item.decision == "pending" && ["exact", "unchanged"].contains(item.match) && item.candidates.count == 1 {
                            choices[item.oldAnchorId] = item.candidates[0].anchorId
                        }
                    }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                    Button("Keep all originals") {
                        for item in preview.items where item.decision == "pending" { choices[item.oldAnchorId] = "keep-original" }
                    }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                }.font(.system(size: 11))
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(preview.items) { item in
                            RecastReconciliationRow(item: item, anchors: newAnchors, busy: model.busy,
                                choice: Binding(get: { choices[item.oldAnchorId] ?? "" }, set: { choices[item.oldAnchorId] = $0 })) { id in
                                if let anchor = model.file?.anchors.first(where: { $0.id == id }) { model.detachEvidence(anchor) }
                            }
                        }
                    }
                }
                if preview.items.isEmpty {
                    Text("No active record cites the original source. There are no evidence links to move.").font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                }
                HStack {
                    Text("Values and their original corrections are retained for review.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Apply \(selectedCount) decisions") { model.resolveReconciliation(choices) }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || selectedCount == 0)
                }
            } else { Spacer() }
            if model.busy {
                HStack { ProgressView(model.progress).controlSize(.small); Button("Cancel operation") { model.cancel() }.buttonStyle(.genHoverPlain()) }
            }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
        }.padding(22).frame(width: 930, height: 720).preferredColorScheme(.dark)
        .onAppear {
            if let job = model.file?.reconciliations?.first(where: { $0.id == model.reconciliationJobId }) {
                oldSource = job.oldSourceId; newSource = job.newSourceId
                model.loadReconciliation(oldSourceId: oldSource, newSourceId: newSource, jobId: job.id)
            } else {
                oldSource = model.selectedSource
                newSource = model.file?.sources.last(where: { $0.id != oldSource })?.id ?? ""
            }
        }
        .onChange(of: model.reconciliationPreview?.revision) { _, _ in choices = [:] }
    }
}

private struct RecastReconciliationRow: View {
    var item: RecastReconciliationPreview.Item
    var anchors: [RecastAnchor]
    var busy: Bool
    @Binding var choice: String
    var showEvidence: (String) -> Void
    @State private var search = ""
    @State private var manual = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(item.label).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                Spacer()
                Text(item.decision == "kept" ? "Kept original" : item.decision == "relinked" ? "Evidence updated" : item.match.capitalized)
                    .font(.system(size: 11)).foregroundStyle(item.decision == "pending" ? ReviewPalette.modified : ReviewPalette.added)
            }
            HStack(alignment: .top, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Original reading").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                    Text(item.quote.isEmpty ? "No literal reading" : item.quote).font(.system(size: 12)).lineLimit(4).textSelection(.enabled)
                    Button("Show original") { showEvidence(item.oldAnchorId) }.buttonStyle(.genHoverPlain()).font(.system(size: 11))
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .leading, spacing: 6) {
                    if item.decision == "pending" {
                        Picker("Use", selection: $choice) {
                            Text("Unresolved").tag("")
                            Text("Keep original evidence").tag("keep-original")
                            ForEach(item.candidates) { candidate in
                                Text(String((candidate.quote.isEmpty ? candidate.method : candidate.quote).prefix(90))).tag(candidate.anchorId)
                            }
                            if !choice.isEmpty, choice != "keep-original", !item.candidates.contains(where: { $0.anchorId == choice }) {
                                Text(anchors.first { $0.id == choice }?.label ?? "Selected region").tag(choice)
                            }
                        }.disabled(busy)
                        if item.candidateCount > 1 { Text("\(item.candidateCount) possible matches; choose explicitly.").font(.system(size: 10)).foregroundStyle(ReviewPalette.modified) }
                        Toggle("Choose another region", isOn: $manual).toggleStyle(.checkbox).font(.system(size: 11))
                        if manual {
                            TextField("Find a replacement region", text: $search).textFieldStyle(.roundedBorder)
                                .accessibilityLabel("Find replacement region for \(item.quote)")
                            let matching = anchors.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) }
                            Picker("Region", selection: $choice) {
                                Text("Unresolved").tag("")
                                Text("Keep original evidence").tag("keep-original")
                                ForEach(Array(matching.prefix(100))) { anchor in Text(anchor.label).tag(anchor.id) }
                                if !choice.isEmpty, choice != "keep-original", !matching.prefix(100).contains(where: { $0.id == choice }) {
                                    Text(anchors.first { $0.id == choice }?.label ?? "Selected region").tag(choice)
                                }
                            }.disabled(busy)
                            if matching.count > 100 { Text("Refine the search to see more regions.").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim) }
                        }
                    }
                    if let id = item.newAnchorId ?? (choice.isEmpty || choice == "keep-original" ? nil : choice) {
                        Button("Show replacement") { showEvidence(id) }.buttonStyle(.genHoverPlain()).font(.system(size: 11))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(12).background(ReviewPalette.renamed.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
    }
}
