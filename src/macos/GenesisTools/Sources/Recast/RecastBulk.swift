import AppKit
import GenesisKit
import SwiftUI

struct RecastBulkDraft: Identifiable {
    let id = UUID()
    var documentId: String
    var revision: Int
    var collection: RecastCollection
    var records: [RecastRecord]
    var fieldId: String
    var sourceLabels: [String: String]
}

extension RecastModel {
    static func manualCellValue(text: String, unknown: Bool, field: RecastField) throws -> RecastJSON {
        let value: RecastJSON
        if unknown { value = .null }
        else if field.type == "number" {
            guard let number = Double(text), number.isFinite else { throw recastError("Enter a finite number.") }
            value = .number(number)
        } else if field.type == "boolean" {
            guard ["true", "false"].contains(text.lowercased()) else { throw recastError("Enter true or false.") }
            value = .bool(text.lowercased() == "true")
        } else { value = .string(text) }
        return value
    }
    func markRecord(_ id: String, checked: Bool) {
        guard !busy, records.contains(where: { $0.id == id }) else { return }
        if checked { bulkRecordIDs.insert(id) } else { bulkRecordIDs.remove(id) }
    }
    func openBulk() {
        guard !busy, let file, let collection else { return }
        let selected = records.filter { bulkRecordIDs.contains($0.id) }
        guard !selected.isEmpty else { error = "Select the records to correct first."; return }
        let anchorSources = Dictionary(uniqueKeysWithValues: file.anchors.map { ($0.id, $0.sourceId) })
        let sourceNames = Dictionary(uniqueKeysWithValues: file.sources.map { ($0.id, $0.name) })
        let labels = Dictionary(uniqueKeysWithValues: selected.map { record in
            (record.id, Set(record.cells.values.flatMap(\.anchorIds).compactMap { anchorSources[$0].flatMap { sourceNames[$0] } }).sorted().joined(separator: " · "))
        })
        bulkDraft = RecastBulkDraft(documentId: file.id, revision: file.revision, collection: collection,
            records: selected, fieldId: selectedField, sourceLabels: labels)
        showBulkSheet = true
    }
    func bulkOperation(draft: RecastBulkDraft, fieldId: String, text: String, unknown: Bool, note: String, reason: String) throws -> RecastJSON {
        guard bulkDraft?.id == draft.id, file?.id == draft.documentId, file?.revision == draft.revision,
              selectedCollection == draft.collection.id, let field = draft.collection.fields.first(where: { $0.id == fieldId }) else {
            throw recastError("The conversion changed. Reopen this bulk correction.")
        }
        guard !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw recastError("Explain the bulk correction before applying it.")
        }
        let value = try Self.manualCellValue(text: text, unknown: unknown, field: field)
        return recastOperation("bulk-correct", ["collectionId": .string(draft.collection.id), "fieldId": .string(fieldId),
            "recordIds": .array(draft.records.map { .string($0.id) }), "value": value, "note": .string(note), "reason": .string(reason)])
    }
    func applyBulk(draft: RecastBulkDraft, fieldId: String, text: String, unknown: Bool, note: String, reason: String) {
        do {
            let operation = try bulkOperation(draft: draft, fieldId: fieldId, text: text, unknown: unknown, note: note, reason: reason)
            perform("Correcting selected records") { model in
                guard model.file?.id == draft.documentId, model.file?.revision == draft.revision else {
                    throw recastError("The selected records changed before applying.")
                }
                try await model.apply([operation], title: "Correct \(draft.records.count) records")
                model.selectedField = fieldId
                model.notice = "Corrected \(draft.records.count) records. Source readings are unchanged; review the records before exporting."
            }
        } catch { self.error = error.localizedDescription }
    }
}

struct RecastBulkSheet: View {
    @ObservedObject var model: RecastModel
    let draft: RecastBulkDraft
    @State private var fieldId: String
    @State private var text: String
    @State private var unknown: Bool
    @State private var note = ""
    @State private var reason = ""
    @State private var page = 0

    init(model: RecastModel, draft: RecastBulkDraft) {
        self.model = model; self.draft = draft
        _fieldId = State(initialValue: draft.fieldId)
        _text = State(initialValue: draft.records.first?.cells[draft.fieldId]?.value.display ?? "")
        _unknown = State(initialValue: draft.records.first?.cells[draft.fieldId]?.value.isNull ?? true)
    }
    private var current: Bool { model.file?.id == draft.documentId && model.file?.revision == draft.revision &&
        model.selectedCollection == draft.collection.id && model.bulkDraft?.id == draft.id }
    private var pageCount: Int { max(1, (draft.records.count + 199) / 200) }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Correct \(draft.records.count) selected records").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("Cancel") { if model.busy { model.cancel() }; model.bulkDraft = nil; model.showBulkSheet = false }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
            }
            Text("Set one field across this exact selection. Original source readings and evidence links stay attached. One Undo restores the entire batch.")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            Picker("Field", selection: $fieldId) { ForEach(draft.collection.fields) { Text($0.label).tag($0.id) } }
                .frame(maxWidth: 360).disabled(model.busy).accessibilityLabel("Bulk correction field")
                .onChange(of: fieldId) { _, id in text = draft.records.first?.cells[id]?.value.display ?? ""; unknown = draft.records.first?.cells[id]?.value.isNull ?? true; page = 0 }
            HStack {
                TextField("Replacement value", text: $text).textFieldStyle(.roundedBorder).disabled(unknown || model.busy)
                    .accessibilityLabel("Bulk replacement value")
                Toggle("Unknown", isOn: $unknown).toggleStyle(.checkbox).disabled(model.busy)
            }
            HStack {
                Text("Before → proposed replacement").font(.system(size: 12, weight: .semibold))
                Spacer()
                IconButton(systemName: "chevron.left", tooltip: "Previous preview page") { page -= 1 }.disabled(page <= 0)
                Text("\(page + 1) / \(pageCount)").font(.system(size: 11)).monospacedDigit()
                IconButton(systemName: "chevron.right", tooltip: "Next preview page") { page += 1 }.disabled(page + 1 >= pageCount)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(draft.records.dropFirst(page * 200).prefix(200))) { record in
                        VStack(alignment: .leading, spacing: 6) {
                            if let contextField = draft.collection.fields.first(where: { $0.type == "text" && $0.id != fieldId }) {
                                Text(record.cells[contextField.id]?.value.display ?? "Untitled record").font(.system(size: 11, weight: .medium))
                            }
                            if let sources = draft.sourceLabels[record.id], !sources.isEmpty {
                                Text(sources).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim).lineLimit(2)
                            }
                            HStack(alignment: .top, spacing: 12) {
                                Text(record.cells[fieldId]?.value.isNull == false ? record.cells[fieldId]!.value.display : "Unknown")
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "arrow.right").foregroundStyle(ReviewPalette.dim)
                                Text(unknown ? "Unknown" : text).frame(maxWidth: .infinity, alignment: .leading)
                            }.font(.system(size: 12)).lineLimit(4)
                        }.padding(9)
                            .background(ReviewPalette.renamed.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                    }
                }.padding(10)
            }.frame(minHeight: 320)
            TextField("Field note (optional)", text: $note).textFieldStyle(.roundedBorder).disabled(model.busy)
                .accessibilityLabel("Bulk correction note")
            TextField("Why this bulk correction?", text: $reason).textFieldStyle(.roundedBorder).disabled(model.busy)
                .accessibilityLabel("Bulk correction reason")
            if !current { Text("The conversion changed. Close and reopen this correction.").foregroundStyle(ReviewPalette.modified) }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            HStack {
                Text("Every selected record returns to review.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Apply to \(draft.records.count) records") { model.applyBulk(draft: draft, fieldId: fieldId,
                    text: text, unknown: unknown, note: note, reason: reason) }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction)
                    .disabled(model.busy || !current || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        reason.utf16.count > 4000 || note.utf16.count > 4000 || text.utf16.count > 8000)
            }
        }.padding(22).frame(width: 900, height: 740)
            .background(Color(nsColor: ReviewPalette.background)).preferredColorScheme(.dark)
    }
}
