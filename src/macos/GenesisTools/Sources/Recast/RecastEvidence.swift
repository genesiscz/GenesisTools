import AppKit
import CoreTransferable
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

struct RecastEvidenceLink: Codable, Transferable, Sendable {
    var documentId: String
    var revision: Int
    var anchorId: String

    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: UTType(exportedAs: "com.genesiscz.genesistools.recast.evidence", conformingTo: .data))
    }
}

struct RecastEvidenceScope: Equatable {
    var documentId: String
    var revision: Int
    var collectionId: String
    var recordId: String
    var fieldId: String
}

struct RecastEvidenceChoice: Identifiable {
    var anchor: RecastAnchor
    var source: RecastSource
    var readings: [RecastReading]
    var searchKey: String
    var id: String { anchor.id }
}

struct RecastEvidenceSelection: Equatable {
    var anchorIds: Set<String>
    var readingIds: Set<String>

    mutating func selectAnchor(_ item: RecastEvidenceChoice, selected: Bool) {
        if selected { anchorIds.insert(item.id) }
        else {
            anchorIds.remove(item.id)
            readingIds.subtract(item.readings.map(\.id))
        }
    }

    mutating func selectReading(_ reading: RecastReading, selected: Bool) {
        if selected { readingIds.insert(reading.id); anchorIds.insert(reading.anchorId) }
        else { readingIds.remove(reading.id) }
    }
    var exceedsLimit: Bool { anchorIds.count > 16 || readingIds.count > 16 }
}

struct RecastEvidenceDraft: Identifiable {
    let id = UUID()
    var scope: RecastEvidenceScope
    var file: RecastFile
    var field: RecastField
    var cell: RecastCell
    var choices: [RecastEvidenceChoice]
    var selection: RecastEvidenceSelection
    var addedAnchor: RecastAnchor?
    var addedReading: RecastReading?
}

extension RecastModel {
    var evidenceScope: RecastEvidenceScope? {
        guard let file, let collection, let record, let field,
              record.collectionId == collection.id, record.state != "archived" else { return nil }
        return RecastEvidenceScope(documentId: file.id, revision: file.revision,
            collectionId: collection.id, recordId: record.id, fieldId: field.id)
    }

    func openEvidence(addingAnchorId: String? = nil, newAnchor: RecastAnchor? = nil, newReading: RecastReading? = nil) {
        guard !busy else { return }
        guard let scope = evidenceScope, var snapshot = file, let field else {
            error = "Select an existing field to manage its evidence."
            return
        }
        if let newAnchor { snapshot.anchors.append(newAnchor) }
        if let newReading { snapshot.readings.append(newReading) }
        let sources = Dictionary(uniqueKeysWithValues: snapshot.sources.map { ($0.id, $0) })
        let readings = Dictionary(grouping: snapshot.readings, by: \.anchorId)
        let choices = snapshot.anchors.compactMap { anchor -> RecastEvidenceChoice? in
            guard let source = sources[anchor.sourceId] else { return nil }
            let literal = readings[anchor.id] ?? []
            return RecastEvidenceChoice(anchor: anchor, source: source, readings: literal,
                searchKey: ([source.name, anchor.label] + literal.map(\.text)).joined(separator: "\n").lowercased())
        }
        let cell = cell ?? RecastCell()
        var selection = RecastEvidenceSelection(anchorIds: Set(cell.anchorIds), readingIds: Set(cell.readingIds))
        if let anchorId = addingAnchorId {
            guard choices.contains(where: { $0.id == anchorId }) else { error = "The selected source region is no longer available."; return }
            selection.anchorIds.insert(anchorId)
        }
        if let newAnchor { selection.anchorIds.insert(newAnchor.id) }
        if let newReading { selection.readingIds.insert(newReading.id) }
        error = nil
        evidenceDraft = RecastEvidenceDraft(scope: scope, file: snapshot, field: field, cell: cell,
            choices: choices, selection: selection, addedAnchor: newAnchor, addedReading: newReading)
        showEvidenceSheet = true
    }

    func evidenceOperations(draft: RecastEvidenceDraft, selection: RecastEvidenceSelection, reason: String) throws -> [RecastJSON] {
        guard evidenceDraft?.id == draft.id, evidenceScope == draft.scope else {
            throw recastError("The document or selected field changed. Reopen Manage evidence before applying.")
        }
        guard !selection.exceedsLimit else { throw recastError("A field supports at most 16 regions and 16 literal readings.") }
        let anchors = Dictionary(uniqueKeysWithValues: draft.file.anchors.map { ($0.id, $0) })
        let readings = Dictionary(uniqueKeysWithValues: draft.file.readings.map { ($0.id, $0) })
        guard selection.anchorIds.allSatisfy({ anchors[$0] != nil }), selection.readingIds.allSatisfy({ id in
            readings[id].map { selection.anchorIds.contains($0.anchorId) } == true
        }) else { throw recastError("A selected reading must belong to an attached source region.") }
        let anchorIds = draft.cell.anchorIds.filter { selection.anchorIds.contains($0) } +
            draft.file.anchors.map(\.id).filter { selection.anchorIds.contains($0) && !draft.cell.anchorIds.contains($0) }
        let readingIds = draft.cell.readingIds.filter { selection.readingIds.contains($0) } +
            draft.file.readings.map(\.id).filter { selection.readingIds.contains($0) && !draft.cell.readingIds.contains($0) }
        var operations: [RecastJSON] = []
        if let added = draft.addedAnchor, selection.anchorIds.contains(added.id) {
            var values: [String: RecastJSON] = ["anchor": try .encoded(added)]
            if let reading = draft.addedReading, selection.readingIds.contains(reading.id) { values["reading"] = try .encoded(reading) }
            operations.append(recastOperation("add-anchor", values))
        }
        operations.append(recastOperation("set-evidence", [
            "recordId": .string(draft.scope.recordId), "fieldId": .string(draft.scope.fieldId),
            "anchorIds": .array(anchorIds.map { .string($0) }), "readingIds": .array(readingIds.map { .string($0) }),
            "reason": .string(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Reviewed field evidence attachments" : reason)
        ]))
        return operations
    }

    func applyEvidence(draft: RecastEvidenceDraft, selection: RecastEvidenceSelection, reason: String) {
        do {
            let operations = try evidenceOperations(draft: draft, selection: selection, reason: reason)
            perform("Updating field evidence") { model in
                guard model.evidenceScope == draft.scope else { throw recastError("The selected field changed.") }
                try await model.apply(operations, title: "Change evidence for " + draft.field.label)
                if model.evidenceDraft?.id == draft.id { model.evidenceDraft = nil; model.showEvidenceSheet = false }
                model.notice = "Evidence updated. The value is unchanged and needs review before export."
            }
        } catch { self.error = error.localizedDescription }
    }

    func receiveEvidence(_ links: [RecastEvidenceLink], recordId: String, fieldId: String) -> Bool {
        guard !busy, let file, links.count == 1, let link = links.first else { return false }
        guard link.documentId == file.id, link.revision == file.revision,
              file.anchors.contains(where: { $0.id == link.anchorId }) else {
            error = "This source link belongs to another document or an older revision. Drag it again from the current source."
            return false
        }
        guard records.contains(where: { $0.id == recordId }), collection?.fields.contains(where: { $0.id == fieldId }) == true else { return false }
        selectField(recordId: recordId, fieldId: fieldId)
        openEvidence(addingAnchorId: link.anchorId)
        return evidenceDraft != nil
    }

    func attachSelectedRegion() {
        guard !busy, !previewBusy, evidenceScope != nil, let source else {
            error = "Select a field and wait for its source to finish opening."
            return
        }
        do {
            let region: RecastRegion
            var literal: String?
            if source.kind == "text" {
                guard textSelection.length > 0 else { throw recastError("Select the source text to attach.") }
                let ns = sourceText as NSString
                guard textSelection.location >= 0, textSelection.location <= ns.length,
                      textSelection.length <= ns.length - textSelection.location,
                      Range(textSelection, in: sourceText) != nil else { throw recastError("Select complete characters from the current source page.") }
                let quote = ns.substring(with: textSelection)
                region = RecastRegion(kind: "text", start: sourceTextOffset + textSelection.location,
                    end: sourceTextOffset + NSMaxRange(textSelection), quote: quote, prefix: "", suffix: "")
                literal = quote
            } else if ["image", "pdf"].contains(source.kind) {
                guard let selectedRegion else { throw recastError("Draw a source region or use Select Source Region first.") }
                region = .rectangle(selectedRegion, page: page)
            } else if source.kind == "audio" {
                guard audio.selectionEnd > audio.selectionStart else { throw recastError("Choose an audio interval to attach.") }
                region = RecastRegion(kind: "audio", startMs: audio.selectionStart * 1000, endMs: audio.selectionEnd * 1000)
            } else if source.kind == "unsupported" {
                region = RecastRegion(kind: "whole")
            } else { throw recastError("Choose a text, image, PDF, audio or preserved unsupported source.") }
            let anchor = RecastAnchor(id: recastID("anchor"), sourceId: source.id, sourceHash: source.contentHash,
                label: "Selected region · " + String(source.name.prefix(160)), region: region)
            let reading = literal.map { RecastReading(id: recastID("reading"), anchorId: anchor.id, text: $0,
                alternatives: [], method: "manual", engine: "Selected source text", createdAt: recastTimestamp()) }
            openEvidence(newAnchor: anchor, newReading: reading)
        } catch { self.error = error.localizedDescription }
    }
}

struct RecastEvidenceSheet: View {
    @ObservedObject var model: RecastModel
    let draft: RecastEvidenceDraft
    @State private var selection: RecastEvidenceSelection
    @State private var sourceFilter = ""
    @State private var search = ""
    @State private var reason = ""

    init(model: RecastModel, draft: RecastEvidenceDraft) {
        self.model = model; self.draft = draft
        _selection = State(initialValue: draft.selection)
    }
    private var changed: Bool { selection.anchorIds != Set(draft.cell.anchorIds) || selection.readingIds != Set(draft.cell.readingIds) }
    private var current: Bool { model.evidenceScope == draft.scope && model.evidenceDraft?.id == draft.id }

    var body: some View {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matching = draft.choices.filter { (sourceFilter.isEmpty || $0.source.id == sourceFilter) && (needle.isEmpty || $0.searchKey.contains(needle)) }
        let attached = draft.choices.filter { draft.cell.anchorIds.contains($0.id) }
        let available = matching.filter { !draft.cell.anchorIds.contains($0.id) }
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Evidence for " + draft.field.label).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("Cancel") { if model.busy { model.cancel() }; model.evidenceDraft = nil; model.showEvidenceSheet = false }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
            }
            VStack(alignment: .leading, spacing: 5) {
                Text(draft.cell.value.isNull ? "Value: Unknown" : "Value: " + draft.cell.value.display).font(.system(size: 13, weight: .medium)).lineLimit(3)
                Text("Attach source regions and literal readings without changing this value. Applying changes returns the field to review.")
                    .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            }
            HStack {
                Picker("Source", selection: $sourceFilter) {
                    Text("All sources").tag("")
                    ForEach(draft.file.sources) { source in Text(source.name).tag(source.id) }
                }.frame(maxWidth: 360)
                TextField("Find source, region or reading", text: $search).textFieldStyle(.roundedBorder)
            }.disabled(model.busy)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if !attached.isEmpty {
                        Text("Current attachments").font(.system(size: 12, weight: .semibold))
                        ForEach(attached) { item in choice(item) }
                    }
                    Text("Available regions").font(.system(size: 12, weight: .semibold))
                    ForEach(Array(available.prefix(200))) { item in choice(item) }
                    if available.count > 200 {
                        Text("Showing 200 of \(available.count) matching regions. Narrow the source or search to find another region.")
                            .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    }
                    if available.isEmpty {
                        Text(draft.choices.isEmpty ? "Select a source region and choose Attach Selected Region, or save source readings first." : "No other regions match this filter.")
                            .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
            }.background(ReviewPalette.renamed.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            TextField("Why these sources? (optional)", text: $reason).textFieldStyle(.roundedBorder).disabled(model.busy)
            if !current { Text("The document or field changed. Close this sheet and reopen it.").foregroundStyle(ReviewPalette.modified) }
            if selection.exceedsLimit { Text("Choose at most 16 regions and 16 readings.").foregroundStyle(ReviewPalette.modified) }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            HStack {
                Text("\(selection.anchorIds.count)/16 regions · \(selection.readingIds.count)/16 readings").foregroundStyle(ReviewPalette.dim)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Apply evidence changes") { model.applyEvidence(draft: draft, selection: selection, reason: reason) }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction)
                    .disabled(model.busy || !current || !changed || selection.exceedsLimit || reason.utf16.count > 4000)
            }.font(.system(size: 12))
        }.padding(22).frame(width: 820, height: 680)
            .background(Color(nsColor: ReviewPalette.background)).preferredColorScheme(.dark)
    }

    private func choice(_ item: RecastEvidenceChoice) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Toggle(isOn: Binding(get: { selection.anchorIds.contains(item.id) }, set: { selection.selectAnchor(item, selected: $0) })) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.source.name + " · " + item.anchor.label).font(.system(size: 12, weight: .medium)).lineLimit(2)
                        Text(item.anchor.region.description).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                    }
                }.toggleStyle(.checkbox).disabled(model.busy || !current)
                Spacer()
                if draft.addedAnchor?.id != item.id {
                    Button("Show source", systemImage: "arrow.up.left.and.arrow.down.right") { model.detachEvidence(item.anchor) }
                        .buttonStyle(.genHoverPlain()).font(.system(size: 11)).disabled(model.busy || !current)
                } else { Text("New region").font(.system(size: 10)).foregroundStyle(ReviewPalette.modified) }
            }
            ForEach(item.readings) { reading in
                Toggle(isOn: Binding(get: { selection.readingIds.contains(reading.id) }, set: { selection.selectReading(reading, selected: $0) })) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(reading.text.isEmpty ? "Empty reading" : reading.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        Text(reading.engine).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                        if !reading.alternatives.isEmpty {
                            Text("Other readings: " + reading.alternatives.joined(separator: " / ")).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified)
                        }
                    }
                }.toggleStyle(.checkbox).padding(.leading, 20).disabled(model.busy || !current)
                    .accessibilityLabel("Attach literal reading from " + item.source.name + ": " + reading.text)
            }
            if selection.anchorIds.contains(item.id), !item.readings.contains(where: { selection.readingIds.contains($0.id) }) {
                Text("Region attached without a literal reading.").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim).padding(.leading, 20)
            }
        }.padding(10).background(selection.anchorIds.contains(item.id) ? ReviewPalette.renamed.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 6))
    }
}
