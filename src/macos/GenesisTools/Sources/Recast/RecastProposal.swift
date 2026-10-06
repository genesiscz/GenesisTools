import GenesisKit
import SwiftUI

struct RecastProposalScope: Equatable {
    var documentId: String
    var revision: Int
    var collectionId: String
    var readingIds: [String]

    func matches(documentId: String, revision: Int, collectionId: String, readingIds: [String]) -> Bool {
        self.documentId == documentId && self.revision == revision &&
            self.collectionId == collectionId && self.readingIds == readingIds.sorted()
    }
}

extension RecastModel {
    var proposalScope: RecastProposalScope? {
        guard let file, let collection else { return nil }
        return RecastProposalScope(documentId: file.id, revision: file.revision,
            collectionId: collection.id, readingIds: proposalReadingIDs.sorted())
    }

    func openProposal(readingIDs: [String]? = nil) {
        guard !busy else { return }
        let anchors = Set(sourceAnchors.map(\.id))
        let suggested = readingIDs ?? (file?.readings ?? []).filter { anchors.contains($0.anchorId) }.map(\.id)
        proposalReadingIDs = suggested.count <= 200 ? Set(suggested) : []
        proposal = nil; proposalPreviewReady = false
        showAIProposal = true
    }

    func generateProposal(instruction: String, modelChoice: String, preview: RecastProposalInput) {
        guard !busy, let scope = proposalScope,
              scope.matches(documentId: preview.documentId, revision: preview.revision,
                collectionId: preview.collectionId, readingIds: preview.readingIds) else {
            error = "The selected input changed. Wait for its preview before generating."
            return
        }
        proposal = nil
        let requestID = UUID()
        proposalRequestID = requestID
        perform("Structuring selected readings") { model in
            let saved = try await model.checkpointForInference()
            var args = ["--readings", scope.readingIds.joined(separator: ","), "--collection", scope.collectionId, "--instruction", instruction]
            let choice = modelChoice.trimmingCharacters(in: .whitespacesAndNewlines)
            if !choice.isEmpty { args += ["--model", choice] }
            let answer = try await model.command("propose", file: saved, arguments: args, timeoutSeconds: 135)
            try Task.checkCancellation()
            let proposal = try JSONDecoder().decode(RecastProposalReview.self, from: Data(answer.utf8))
            guard model.proposalRequestID == requestID, model.proposalScope == scope,
                  scope.matches(documentId: proposal.documentId, revision: proposal.revision,
                    collectionId: proposal.collectionId, readingIds: proposal.readingIds),
                  proposal.contextHash == preview.contextHash else {
                throw recastError("The selected input changed. Generate a fresh proposal before adding records.")
            }
            model.proposal = proposal
        }
    }

    func applyProposal() {
        guard let proposal, proposalScope?.matches(documentId: proposal.documentId, revision: proposal.revision,
            collectionId: proposal.collectionId, readingIds: proposal.readingIds) == true else {
            error = "The selected input changed. Generate a fresh proposal before adding records."
            return
        }
        perform("Adding proposed records") { model in
            try await model.apply([recastOperation("add-proposals", ["records": try .encoded(proposal.records)])], title: "Add AI draft records")
            model.selectedCollection = proposal.collectionId
            model.selectedRecord = proposal.records.first?.id ?? ""
            model.selectedField = model.collection?.fields.first?.id ?? ""
            model.showAIProposal = false; model.proposal = nil
            model.notice = "Draft records added. Review the evidence and accept records before export."
        }
    }
}

private struct RecastReadingChoice: Identifiable {
    var reading: RecastReading
    var source: RecastSource
    var anchor: RecastAnchor
    var id: String { reading.id }
}

struct RecastProposalSheet: View {
    @ObservedObject var model: RecastModel
    @Environment(\.dismiss) private var dismiss
    @State private var instruction = "Extract the useful records into the collection's fields. Keep missing or uncertain values unknown."
    @State private var modelChoice = ""
    @State private var accountChoice = ""
    @State private var accounts: [RecastTaskAccountChoice] = []
    @State private var accountError: String?
    @State private var filterSource = ""
    @State private var preview: RecastProposalInput?
    @State private var previewError: String?
    @State private var selectionError: String?
    @State private var previewBusy = false

    private var choices: [RecastReadingChoice] {
        guard let file = model.file else { return [] }
        let anchors = Dictionary(uniqueKeysWithValues: file.anchors.map { ($0.id, $0) })
        let sources = Dictionary(uniqueKeysWithValues: file.sources.map { ($0.id, $0) })
        return file.readings.compactMap { reading in
            guard let anchor = anchors[reading.anchorId], let source = sources[anchor.sourceId] else { return nil }
            return RecastReadingChoice(reading: reading, source: source, anchor: anchor)
        }
    }

    var body: some View {
        let choices = choices
        let shown = choices.filter { filterSource.isEmpty || $0.source.id == filterSource }
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Structure selected readings").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button(model.busy ? "Cancel" : "Close") {
                    if model.busy { model.cancel() }
                    dismiss()
                }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
            }
            Text("Choose up to 200 readings from any sources. Only their text, alternatives, source labels and regions, plus the destination fields, will be sent. Original files stay here.")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            HStack {
                Text("Destination: " + (model.collection?.label ?? "Collection")).font(.system(size: 12, weight: .medium))
                Spacer()
                Text("\(model.proposalReadingIDs.count) / 200 selected").font(.system(size: 11)).monospacedDigit()
            }
            HSplitView {
                VStack(alignment: .leading, spacing: 10) {
                    Picker("Show readings", selection: $filterSource) {
                        Text("All sources").tag("")
                        ForEach(model.file?.sources ?? []) { source in Text(source.name).tag(source.id) }
                    }
                    HStack {
                        Button("Select shown") {
                            let next = model.proposalReadingIDs.union(shown.map(\.id))
                            guard next.count <= 200 else { selectionError = "Choose at most 200 readings."; return }
                            model.proposalReadingIDs = next; selectionError = nil
                        }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                        Button("Clear selection") { model.proposalReadingIDs = []; selectionError = nil }
                            .buttonStyle(.genHoverPlain()).disabled(model.busy)
                    }.font(.system(size: 11))
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(shown) { item in readingRow(item) }
                        }
                    }
                    if shown.isEmpty {
                        Text("No saved readings here. Read a selected region or save a transcript first.")
                            .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                    }
                }.frame(minWidth: 350, idealWidth: 390).padding(.trailing, 10)
                VStack(alignment: .leading, spacing: 10) {
                    if let proposal = model.proposal {
                        Text(proposal.explanation).font(.system(size: 12)).textSelection(.enabled)
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                ForEach(proposal.records) { record in
                                    VStack(alignment: .leading, spacing: 6) {
                                        ForEach(model.collection?.fields ?? []) { field in
                                            let cell = record.cells[field.id] ?? RecastCell()
                                            HStack(alignment: .top) {
                                                Text(field.label).foregroundStyle(ReviewPalette.dim).frame(width: 95, alignment: .leading)
                                                VStack(alignment: .leading, spacing: 3) {
                                                    Text(cell.value.isNull ? "Unknown" : cell.value.display)
                                                    if !cell.note.isEmpty { Text(cell.note).foregroundStyle(ReviewPalette.modified).font(.system(size: 10)) }
                                                    Text("\(cell.readingIds.count) readings").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                                                }
                                                Spacer(minLength: 0)
                                            }.font(.system(size: 12))
                                        }
                                    }.padding(12).background(ReviewPalette.renamed.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                                }
                                ForEach(proposal.warnings, id: \.self) { Text($0).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified) }
                            }
                        }
                    } else if let preview {
                        Text("Selected source input · \(preview.characters.formatted()) / 32,000 characters")
                            .font(.system(size: 12, weight: .medium))
                        ScrollView {
                            Text(preview.serialized).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(10)
                        }.background(ReviewPalette.renamed.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    } else if previewBusy {
                        ProgressView("Checking selected input…").controlSize(.small)
                        Spacer()
                    } else {
                        Text(previewError ?? "Select the readings to include. Nothing is sent while you choose.")
                            .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                        Spacer()
                    }
                }.frame(minWidth: 360, maxWidth: .infinity).padding(.leading, 10)
            }
            if let selectionError { Text(selectionError).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified) }
            TextField("Describe the records you want", text: $instruction, axis: .vertical)
                .lineLimit(2...4).textFieldStyle(.roundedBorder).disabled(model.busy)
            Picker("AI account", selection: $accountChoice) {
                Text("App default / custom model reference").tag("")
                ForEach(accounts) { account in Text(account.name + " · " + account.provider).tag(account.modelRef) }
            }.disabled(model.busy)
            if let accountError { Text(accountError).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified) }
            HStack {
                TextField(accountChoice.isEmpty ? "Full model reference, or app default when blank" : "Model ID, or account default when blank",
                          text: $modelChoice).textFieldStyle(.roundedBorder).disabled(model.busy)
                Button(model.busy ? "Working…" : "Generate proposal") {
                    if let preview {
                        let modelID = modelChoice.trimmingCharacters(in: .whitespacesAndNewlines)
                        let reference = accountChoice.isEmpty ? modelID : accountChoice + (modelID.isEmpty ? "" : ":" + modelID)
                        model.generateProposal(instruction: instruction, modelChoice: reference, preview: preview)
                    }
                }.buttonStyle(.genHoverPlain())
                    .disabled(model.busy || previewBusy || preview == nil || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if model.busy { ProgressView(model.progress).controlSize(.small) }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            HStack {
                Text("Proposed records still need your review and acceptance.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                if let proposal = model.proposal {
                    Button("Add \(proposal.records.count) draft records") { model.applyProposal() }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || proposal.records.isEmpty)
                }
            }
        }.padding(22).frame(width: 1000, height: 740)
            .background(Color(nsColor: ReviewPalette.background)).preferredColorScheme(.dark)
        .onAppear {
            let selectedSources = Set(choices.filter { model.proposalReadingIDs.contains($0.id) }.map { $0.source.id })
            filterSource = selectedSources.count > 1 ? "" : model.selectedSource
        }
        .onChange(of: instruction) { _, _ in model.proposal = nil }
        .onChange(of: modelChoice) { _, _ in model.proposal = nil }
        .onChange(of: accountChoice) { _, _ in modelChoice = ""; model.proposal = nil }
        .task {
            do {
                let answer = try await model.command("proposal-choices")
                try Task.checkCancellation()
                accounts = try JSONDecoder().decode([RecastTaskAccountChoice].self, from: Data(answer.utf8))
            } catch is CancellationError { HubPerf.log("recast: account choices cancelled") }
            catch { accountError = error.localizedDescription }
        }
        .task(id: model.proposalScope) { await refreshPreview() }
        .onDisappear { if model.busy { model.cancel() } }
    }

    private func readingRow(_ item: RecastReadingChoice) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Toggle(isOn: Binding<Bool>(get: { model.proposalReadingIDs.contains(item.id) },
                                      set: { setReading(item.id, selected: $0) })) {
                Text(item.source.name + " · " + item.anchor.region.description)
                    .font(.system(size: 11)).lineLimit(2)
            }.toggleStyle(.checkbox).disabled(model.busy)
                .accessibilityLabel("Include " + item.source.name + ", " + item.anchor.region.description + ", " + String(item.reading.text.prefix(120)))
            Text(item.reading.text).font(.system(size: 11)).lineLimit(4)
                .frame(maxWidth: .infinity, alignment: .leading)
            if !item.reading.alternatives.isEmpty {
                Text("Alternate readings: " + item.reading.alternatives.joined(separator: " / "))
                    .font(.system(size: 10)).foregroundStyle(ReviewPalette.modified).lineLimit(3)
            }
        }.padding(9)
            .background(ReviewPalette.renamed.opacity(model.proposalReadingIDs.contains(item.id) ? 0.09 : 0.025),
                        in: RoundedRectangle(cornerRadius: 6))
    }

    private func setReading(_ id: String, selected: Bool) {
        if selected {
            guard model.proposalReadingIDs.count < 200 else { selectionError = "Choose at most 200 readings."; return }
            model.proposalReadingIDs.insert(id)
        } else { model.proposalReadingIDs.remove(id) }
        selectionError = nil
    }

    private func refreshPreview() async {
        preview = nil; previewError = nil; model.proposalPreviewReady = false
        guard let file = model.file, let scope = model.proposalScope, !scope.readingIds.isEmpty else {
            previewBusy = false; model.proposalPreviewReady = true; model.onReady?()
            return
        }
        previewBusy = true
        do {
            try await Task.sleep(for: .milliseconds(200))
            let answer = try await model.command("proposal-context", file: file,
                arguments: ["--collection", scope.collectionId, "--readings", scope.readingIds.joined(separator: ",")])
            try Task.checkCancellation()
            let result = try JSONDecoder().decode(RecastProposalInput.self, from: Data(answer.utf8))
            guard model.proposalScope == scope,
                  scope.matches(documentId: result.documentId, revision: result.revision,
                    collectionId: result.collectionId, readingIds: result.readingIds) else { return }
            preview = result
        } catch is CancellationError {
            HubPerf.log("recast: superseded input preview cancelled")
        } catch {
            if !Task.isCancelled { previewError = error.localizedDescription }
        }
        if !Task.isCancelled && model.proposalScope == scope {
            previewBusy = false; model.proposalPreviewReady = true; model.onReady?()
        }
    }
}
