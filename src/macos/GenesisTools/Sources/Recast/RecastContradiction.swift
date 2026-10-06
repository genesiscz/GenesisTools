import AppKit
import GenesisKit
import SwiftUI

struct RecastContradictionDraft: Identifiable {
    let id = UUID()
    var file: RecastFile
    var collection: RecastCollection
    var fieldId: String
    var review: RecastContradiction?
}

extension RecastModel {
    func openContradiction(reviewId: String? = nil) {
        guard !busy, let file, let collection else { return }
        let review = reviewId.flatMap { id in file.contradictions?.first { $0.id == id } }
        guard reviewId == nil || review?.collectionId == collection.id else {
            error = "Choose a competing-evidence review from this collection."
            return
        }
        contradictionDraft = RecastContradictionDraft(file: file, collection: collection,
            fieldId: review?.fieldId ?? selectedField, review: review)
        showContradictionSheet = true
    }

    func contradictionOperations(draft: RecastContradictionDraft, fieldId: String, records: Set<String>,
        label: String, reason: String, decision: String, preferred: String, contexts: [String: String]) throws -> [RecastJSON] {
        guard contradictionDraft?.id == draft.id, file?.id == draft.file.id,
              file?.revision == draft.file.revision, selectedCollection == draft.collection.id else {
            throw recastError("The document changed. Reopen this comparison before applying.")
        }
        guard ["keep-both", "prefer", "context"].contains(decision), records.count >= 2, records.count <= 8,
              draft.collection.fields.contains(where: { $0.id == fieldId }),
              !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw recastError("Choose two to eight records, a field and a decision reason.")
        }
        let members = draft.file.records.filter { records.contains($0.id) }
        guard members.count == records.count, members.allSatisfy({ $0.collectionId == draft.collection.id }),
              draft.review != nil || members.allSatisfy({ $0.state != "archived" }),
              draft.review.map({ Set($0.members.map(\.recordId)) == records && $0.fieldId == fieldId }) ?? true else {
            throw recastError("Keep the existing review's field and competing records, or create a new comparison.")
        }
        if decision == "prefer", !records.contains(preferred) { throw recastError("Choose the preferred record.") }
        if decision == "context", records.contains(where: { contexts[$0]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false }) {
            throw recastError("Describe when each competing record applies.")
        }
        var operations: [RecastJSON] = []
        let reviewId = draft.review?.id ?? recastID("contradiction")
        if draft.review == nil {
            operations.append(recastOperation("start-contradiction", [
                "id": .string(reviewId), "collectionId": .string(draft.collection.id), "fieldId": .string(fieldId),
                "recordIds": .array(members.map { .string($0.id) }), "label": .string(label), "reason": .string(reason)
            ]))
        }
        var resolution: [String: RecastJSON] = ["reviewId": .string(reviewId), "decision": .string(decision), "reason": .string(reason)]
        if decision == "prefer" { resolution["preferredRecordId"] = .string(preferred) }
        if decision == "context" { resolution["contexts"] = .object(contexts.filter { records.contains($0.key) }.mapValues { .string($0) }) }
        operations.append(recastOperation("resolve-contradiction", resolution))
        return operations
    }

    func applyContradiction(draft: RecastContradictionDraft, fieldId: String, records: Set<String>,
        label: String, reason: String, decision: String, preferred: String, contexts: [String: String]) {
        do {
            let operations = try contradictionOperations(draft: draft, fieldId: fieldId, records: records,
                label: label, reason: reason, decision: decision, preferred: preferred, contexts: contexts)
            perform("Resolving competing evidence") { model in
                guard model.file?.id == draft.file.id, model.file?.revision == draft.file.revision else {
                    throw recastError("The conversion changed before applying this decision.")
                }
                try await model.apply(operations, title: "Resolve competing evidence")
                if model.contradictionDraft?.id == draft.id { model.contradictionDraft = nil; model.showContradictionSheet = false }
                model.notice = "Decision saved. Review the retained records before exporting."
            }
        } catch { self.error = error.localizedDescription }
    }
}

struct RecastContradictionSheet: View {
    @ObservedObject var model: RecastModel
    let draft: RecastContradictionDraft
    @State private var fieldId: String
    @State private var selected: Set<String>
    @State private var label: String
    @State private var reason: String
    @State private var decision: String
    @State private var preferred: String
    @State private var contexts: [String: String]
    @State private var search = ""

    init(model: RecastModel, draft: RecastContradictionDraft) {
        self.model = model; self.draft = draft
        _fieldId = State(initialValue: draft.fieldId)
        _selected = State(initialValue: Set(draft.review?.members.map(\.recordId) ?? [model.selectedRecord].filter { !$0.isEmpty }))
        _label = State(initialValue: draft.review?.label ?? "Competing " + (draft.collection.fields.first { $0.id == draft.fieldId }?.label ?? "values"))
        _reason = State(initialValue: draft.review?.reason ?? "")
        _decision = State(initialValue: draft.review?.decision ?? "keep-both")
        _preferred = State(initialValue: draft.review?.preferredRecordId ?? "")
        _contexts = State(initialValue: Dictionary(uniqueKeysWithValues: draft.review?.members.map { ($0.recordId, $0.context) } ?? []))
    }
    private var current: Bool { model.file?.id == draft.file.id && model.file?.revision == draft.file.revision &&
        model.selectedCollection == draft.collection.id && model.contradictionDraft?.id == draft.id }
    private var candidates: [RecastRecord] { draft.file.records.filter { $0.collectionId == draft.collection.id &&
        ($0.state != "archived" || selected.contains($0.id)) } }
    private var chosen: [RecastRecord] { candidates.filter { selected.contains($0.id) } }
    private var valid: Bool { current && selected.count >= 2 && selected.count <= 8 && !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && reason.utf16.count <= 4000 &&
        (decision != "prefer" || selected.contains(preferred)) &&
        (decision != "context" || chosen.allSatisfy { contexts[$0.id]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Review competing evidence").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("Cancel") { if model.busy { model.cancel() }; model.contradictionDraft = nil; model.showContradictionSheet = false }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
            }
            Text("Choose records you believe describe the same claim. Different values alone do not establish a contradiction.")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            HStack {
                Picker("Compare field", selection: $fieldId) { ForEach(draft.collection.fields) { Text($0.label).tag($0.id) } }
                    .frame(width: 300).disabled(draft.review != nil || model.busy).accessibilityLabel("Competing evidence field")
                TextField("Review title", text: $label).textFieldStyle(.roundedBorder).disabled(draft.review != nil || model.busy)
                    .accessibilityLabel("Evidence review title")
            }
            HSplitView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Competing records · \(selected.count)/8").font(.system(size: 12, weight: .semibold))
                    TextField("Find records", text: $search).textFieldStyle(.roundedBorder).accessibilityLabel("Find competing records")
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 7) {
                            ForEach(Array(candidates.filter { selected.contains($0.id) || search.isEmpty ||
                                $0.cells.values.contains { $0.value.display.localizedCaseInsensitiveContains(search) } }.prefix(200))) { record in
                                Toggle(isOn: Binding(get: { selected.contains(record.id) }, set: { checked in
                                    if checked { selected.insert(record.id) } else { selected.remove(record.id) }
                                })) {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(record.cells[fieldId]?.value.isNull == false ? record.cells[fieldId]!.value.display : "Unknown")
                                            .font(.system(size: 12)).lineLimit(3)
                                        Text(record.id).font(.system(size: 9, design: .monospaced)).foregroundStyle(ReviewPalette.dim).lineLimit(1)
                                    }
                                }.toggleStyle(.checkbox).disabled(draft.review != nil || model.busy || !current)
                            }
                        }
                    }
                    Text("Up to 200 matching records shown. Search to find another.").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                }.padding(10).frame(minWidth: 270, idealWidth: 300)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(chosen) { record in member(record) }
                        if chosen.isEmpty { Text("Select the competing records to inspect their source evidence.").foregroundStyle(ReviewPalette.dim) }
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }.frame(minWidth: 400)
            }.frame(minHeight: 320).background(ReviewPalette.renamed.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
            Picker("Decision", selection: $decision) {
                Text("Keep both readings").tag("keep-both")
                Text("Prefer one record").tag("prefer")
                Text("Apply in different contexts").tag("context")
            }.pickerStyle(.segmented).disabled(model.busy || !current).accessibilityLabel("Evidence decision")
            if decision == "prefer" {
                Picker("Keep for output", selection: $preferred) {
                    Text("Choose record").tag("")
                    ForEach(chosen) { Text($0.cells[fieldId]?.value.display ?? "Unknown").tag($0.id) }
                }.accessibilityLabel("Preferred record for output")
                Text("Other competing records are archived, with their evidence retained. Reopening this review can restore them.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.modified)
            } else if decision == "context" {
                Text("The output retains both records; the evidence report carries each contextual exception.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            }
            TextField("Why this decision?", text: $reason).textFieldStyle(.roundedBorder).disabled(model.busy)
                .accessibilityLabel("Evidence decision reason")
            if !current { Text("The conversion changed. Close and reopen this comparison.").foregroundStyle(ReviewPalette.modified) }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            HStack {
                Text("A decision leaves retained records as drafts.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Save decision") { model.applyContradiction(draft: draft, fieldId: fieldId, records: selected,
                    label: label, reason: reason, decision: decision, preferred: preferred, contexts: contexts) }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction).disabled(!valid || model.busy)
            }
        }.padding(22).frame(width: 940, height: 760)
            .background(Color(nsColor: ReviewPalette.background)).preferredColorScheme(.dark)
    }

    private func member(_ record: RecastRecord) -> some View {
        let cell = record.cells[fieldId] ?? RecastCell()
        return VStack(alignment: .leading, spacing: 8) {
            Text(cell.value.isNull ? "Unknown" : cell.value.display).font(.system(size: 16, weight: .semibold)).textSelection(.enabled)
            Text(cell.origin == "user" ? "User-supplied" : cell.origin == "inferred" ? "Inferred proposal" : "Source reading")
                .font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
            if let before = draft.review?.members.first(where: { $0.recordId == record.id }),
               before.cell.value != cell.value { Text("Previously reviewed: " + before.cell.value.display).foregroundStyle(ReviewPalette.modified).font(.system(size: 11)) }
            ForEach(cell.anchorIds, id: \.self) { id in
                if let anchor = draft.file.anchors.first(where: { $0.id == id }),
                   let source = draft.file.sources.first(where: { $0.id == anchor.sourceId }) {
                    Button { model.detachEvidence(anchor) } label: {
                        Label(source.name + " · " + anchor.region.description, systemImage: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 11)).lineLimit(2)
                    }.buttonStyle(.genHoverPlain()).disabled(model.busy || !current)
                    ForEach(draft.file.readings.filter { cell.readingIds.contains($0.id) && $0.anchorId == id }) { reading in
                        Text(reading.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        if !reading.alternatives.isEmpty {
                            Text("Literal alternatives: " + reading.alternatives.joined(separator: " / ")).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified)
                        }
                    }
                }
            }
            if cell.anchorIds.isEmpty { Text("No source evidence attached.").font(.system(size: 11)).foregroundStyle(ReviewPalette.modified) }
            if decision == "context" {
                TextField("When does this record apply?", text: Binding(get: { contexts[record.id] ?? "" }, set: { contexts[record.id] = $0 }))
                    .accessibilityLabel("Context for \(record.cells[fieldId]?.value.display ?? record.id)")
                    .textFieldStyle(.roundedBorder).disabled(model.busy)
            }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(ReviewPalette.renamed.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
    }
}
