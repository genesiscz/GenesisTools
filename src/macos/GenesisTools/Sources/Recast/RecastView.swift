import AppKit
import GenesisKit
import SwiftUI

struct RecastView: View {
    @ObservedObject var model: RecastModel

    var body: some View {
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 12) {
                    Image(systemName: "viewfinder").foregroundStyle(ReviewPalette.renamed)
                    Text("Recast").font(.system(size: 13, weight: .semibold)).titlebarLabel()
                    Text(model.file?.title ?? "Opening conversion…").foregroundStyle(ReviewPalette.dim).lineLimit(1).titlebarLabel()
                    Spacer()
                    IconButton(systemName: "arrow.uturn.backward", tooltip: "Undo (⌘Z)") { model.owner?.undoManager?.undo() }
                        .disabled(model.busy || model.owner?.undoManager?.canUndo != true)
                    IconButton(systemName: "arrow.uturn.forward", tooltip: "Redo (⇧⌘Z)") { model.owner?.undoManager?.redo() }
                        .disabled(model.busy || model.owner?.undoManager?.canRedo != true)
                    Button("Save") { model.owner?.save(nil) }.buttonStyle(.genHoverPlain()).disabled(model.file == nil)
                    Button("Preview export", systemImage: "square.and.arrow.up") { model.prepareExport() }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || model.records.isEmpty)
                }
            } details: {
                HStack(spacing: 12) {
                    Picker("Workspace", selection: $model.workspaceMode) {
                        ForEach(RecastWorkspaceMode.allCases) { Text($0.rawValue).tag($0) }
                    }.pickerStyle(.segmented).frame(maxWidth: 420)
                    Button("Show evidence", systemImage: "viewfinder") { model.revealSelectedEvidence() }
                        .buttonStyle(.genHoverPlain()).disabled(model.cell?.anchorIds.isEmpty != false)
                    Spacer()
                    Button("Import sources", systemImage: "plus.rectangle.on.folder") { model.chooseSources() }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || model.file == nil)
                    Button("New collection", systemImage: "tablecells.badge.ellipsis") { model.showCollectionEditor = true }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || model.file == nil)
                }
            }.hubSurface(.chrome)
            GeometryReader { geometry in
                HStack(spacing: 0) {
                    ResizableSidePanel(key: "recast.sources", edge: .leading, title: "Sources and collections",
                        defaultWidth: 208, minWidth: 170, maxWidth: geometry.size.width * 0.3, autoCollapse: geometry.size.width < 1050) {
                        library.hubSurface(.chrome)
                    }
                    switch model.workspaceMode.effective(width: geometry.size.width) {
                    case .split:
                        HSplitView {
                            RecastSourcePane(model: model).frame(minWidth: 300, idealWidth: 540, maxWidth: .infinity)
                            objectWorkspace.frame(minWidth: 360, idealWidth: 580, maxWidth: .infinity)
                        }
                    case .source:
                        RecastSourcePane(model: model).frame(maxWidth: .infinity)
                    case .objects:
                        objectWorkspace.frame(maxWidth: .infinity)
                    case .destination:
                        RecastExportSheet(model: model, embedded: true).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .onAppear { model.workspaceWidth = geometry.size.width }
                .onChange(of: geometry.size.width) { _, width in model.workspaceWidth = width }
            }.hubSurface(.content)
            if let error = model.error, model.workspaceMode != .destination {
                NoticePill(text: error, isError: true) { model.error = nil }.padding(8)
            }
            if let notice = model.notice {
                NoticePill(text: notice) { model.notice = nil }.padding(8)
            }
            HStack(spacing: 10) {
                if model.busy {
                    ProgressView().controlSize(.small)
                    Text(model.progress).lineLimit(1)
                    Button("Cancel") { model.cancel() }.buttonStyle(.genHoverPlain())
                } else {
                    Image(systemName: "internaldrive").foregroundStyle(ReviewPalette.added)
                    Text("Originals kept in this document")
                }
                Spacer()
                Text("\(model.file?.sources.count ?? 0) sources · \(model.file?.records.filter { $0.state != "archived" }.count ?? 0) records")
                Text(model.owner?.fileURL == nil ? "Not yet saved" : model.owner?.isDocumentEdited == true ? "Unsaved changes" : "Saved locally")
            }.font(.system(size: 10.5)).foregroundStyle(ReviewPalette.dim).padding(.horizontal, 14).padding(.vertical, 8).hubSurface(.bar)
        }
        .preferredColorScheme(.dark)
        .sheet(isPresented: $model.showExport) { RecastExportSheet(model: model) }
        .sheet(isPresented: $model.showCollectionEditor) { RecastCollectionSheet(model: model) }
        .sheet(isPresented: $model.showAIProposal) { RecastProposalSheet(model: model) }
        .sheet(isPresented: $model.showRoundTrip) {
            if let draft = model.roundTrip { RecastRoundTripSheet(model: model, draft: draft) }
        }
        .sheet(item: $model.audioTranscript) { review in RecastTranscriptSheet(model: model, audio: model.audio, review: review) }
        .sheet(isPresented: $model.showReconciliation) { RecastReconciliationSheet(model: model) }
        .sheet(isPresented: $model.showRegionEditor) { RecastRegionSheet(model: model) }
        .sheet(isPresented: $model.showEvidenceSheet) {
            if let draft = model.evidenceDraft { RecastEvidenceSheet(model: model, draft: draft) }
        }
        .sheet(isPresented: $model.showContradictionSheet) {
            if let draft = model.contradictionDraft { RecastContradictionSheet(model: model, draft: draft) }
        }
        .sheet(isPresented: $model.showBulkSheet) {
            if let draft = model.bulkDraft { RecastBulkSheet(model: model, draft: draft) }
        }
        .sheet(isPresented: $model.showCorrectionExamples) {
            if let preview = model.correctionExamples { RecastCorrectionSheet(model: model, preview: preview) }
        }
    }

    private var objectWorkspace: some View {
        VSplitView {
            records.frame(minHeight: 180, idealHeight: 340)
            RecastFieldInspector(model: model).frame(minHeight: 230)
        }
    }

    private var library: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("Sources").font(.system(size: 12, weight: .semibold)).padding(.bottom, 4)
                ForEach((model.file?.contradictions ?? []).filter { $0.collectionId == model.selectedCollection }) { review in
                    Button { model.openContradiction(reviewId: review.id) } label: {
                        Label(review.label + " · " + review.status, systemImage: review.status == "pending" ? "exclamationmark.triangle" : "checkmark.circle")
                            .font(.system(size: 11)).lineLimit(2).padding(6)
                    }.buttonStyle(RowButtonStyle()).disabled(model.busy)
                }
                if model.file?.sources.isEmpty != false {
                    Text("Drop the files you want to turn into something useful here.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Button("Choose files…") { model.chooseSources() }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                }
                ForEach(model.file?.sources ?? []) { source in
                    Button {
                        model.selectedSource = source.id
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: source.kind == "pdf" ? "doc.richtext" : source.kind == "image" ? "photo" : source.kind == "audio" ? "waveform" : "doc.text")
                                .foregroundStyle(source.error == nil ? ReviewPalette.renamed : ReviewPalette.modified)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(source.name).font(.system(size: 12)).lineLimit(2)
                                Text(source.error == nil ? source.kind.uppercased() : "Needs attention").font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                            }
                            Spacer(minLength: 0)
                        }.padding(8).background(model.selectedSource == source.id ? ReviewPalette.renamed.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(RowButtonStyle()).accessibilityLabel("Source " + source.name)
                }
                if !(model.file?.reconciliations ?? []).isEmpty {
                    Divider().padding(.vertical, 10)
                    DisclosureGroup("Source reviews") {
                        ForEach(model.file?.reconciliations ?? []) { job in
                            Button {
                                model.reconciliationJobId = job.id
                                model.reconciliationPreview = nil
                                model.showReconciliation = true
                            } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(model.file?.sources.first { $0.id == job.newSourceId }?.name ?? "Replacement")
                                        .font(.system(size: 11)).lineLimit(1)
                                    Text("\(job.items.filter { $0.status == "pending" }.count) unresolved regions")
                                        .font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                                }.padding(5).frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(RowButtonStyle()).disabled(model.busy)
                        }
                    }.font(.system(size: 12, weight: .medium))
                }
                if !(model.file?.renderings ?? []).isEmpty {
                    Divider().padding(.vertical, 10)
                    DisclosureGroup("Exports") {
                        ForEach((model.file?.renderings ?? []).reversed()) { rendering in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(rendering.format.uppercased() + " · \(rendering.rows.count) records").font(.system(size: 11, weight: .medium))
                                    Spacer()
                                    IconButton(systemName: "minus.circle", tooltip: "Forget this export receipt (undoable)") { model.forgetRendering(rendering) }
                                        .disabled(model.busy)
                                }
                                Text(rendering.createdLabel).font(.system(size: 9)).foregroundStyle(ReviewPalette.dim)
                                if rendering.format == "csv" && rendering.includeRecordIds {
                                    Button("Review CSV edits…") { model.chooseCSVEdits(receipt: rendering) }
                                        .buttonStyle(.genHoverPlain()).font(.system(size: 11)).disabled(model.busy)
                                }
                            }.padding(.vertical, 5)
                        }
                    }.font(.system(size: 12, weight: .medium))
                }
                Divider().padding(.vertical, 10)
                Text("Collections").font(.system(size: 12, weight: .semibold)).padding(.bottom, 4)
                ForEach(model.file?.collections ?? []) { collection in
                    Button {
                        model.selectedCollection = collection.id; model.selectedRecord = ""; model.normalizeSelection()
                    } label: {
                        HStack {
                            Image(systemName: collection.kind == "calendar" ? "calendar" : collection.kind == "checklist" ? "checklist" : "tablecells")
                            Text(collection.label).lineLimit(1)
                            Spacer()
                            Text(verbatim: String(model.file?.records.filter { $0.collectionId == collection.id && $0.state != "archived" }.count ?? 0)).monospacedDigit()
                        }.font(.system(size: 12)).padding(8)
                            .background(model.selectedCollection == collection.id ? ReviewPalette.renamed.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 6))
                    }.buttonStyle(RowButtonStyle())
                }
            }.padding(12)
        }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            guard !model.busy else { return false }
            model.importDropped(providers)
            return true
        }
    }

    private var records: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Text(model.collection?.label ?? "Objects").font(.system(size: 13, weight: .semibold))
                Text("\(model.records.filter { $0.state == "accepted" }.count) accepted").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                Button("Competing evidence…") { model.openContradiction() }
                    .buttonStyle(.genHoverPlain()).disabled(model.busy || model.records.count < 2)
                IconButton(systemName: "plus", tooltip: "Add a record") { model.addRecord() }.disabled(model.busy)
                Button("Accept all") { model.acceptRecords(all: true) }.buttonStyle(.genHoverPlain()).disabled(model.busy || model.records.isEmpty)
            }.padding(12).hubSurface(.bar)
            if !model.records.isEmpty {
                HStack(spacing: 10) {
                    Toggle("Select all", isOn: Binding(get: { model.bulkRecordIDs.count == model.records.count },
                        set: { model.bulkRecordIDs = $0 ? Set(model.records.map(\.id)) : [] }))
                        .toggleStyle(.checkbox).disabled(model.busy)
                    Text("\(model.bulkRecordIDs.count) selected").foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Clear") { model.bulkRecordIDs = [] }.buttonStyle(.genHoverPlain()).disabled(model.busy || model.bulkRecordIDs.isEmpty)
                    Button("Correct selected…", systemImage: "pencil.line") { model.openBulk() }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy || model.bulkRecordIDs.isEmpty)
                }.font(.system(size: 11)).padding(.horizontal, 12).padding(.vertical, 6).hubSurface(.bar)
            }
            if let collection = model.collection, !model.records.isEmpty {
                GeometryReader { viewport in
                    ScrollView([.horizontal, .vertical]) {
                        LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                            Section {
                                ForEach(model.records) { record in
                                    RecastRecordRow(record: record, fields: collection.fields, selected: model.selectedRecord == record.id,
                                        selectedField: model.selectedField, marked: model.bulkRecordIDs.contains(record.id),
                                        mark: { checked in model.markRecord(record.id, checked: checked) },
                                        receiveEvidence: { field, links in model.receiveEvidence(links, recordId: record.id, fieldId: field) }) {
                                            field in model.selectField(recordId: record.id, fieldId: field)
                                        }
                                }
                            } header: {
                                HStack(spacing: 0) {
                                    Text("Select / Review").frame(width: 106, alignment: .leading)
                                    ForEach(collection.fields) { field in
                                        Text(field.label + (field.required ? " *" : "")).frame(width: 156, alignment: .leading)
                                    }
                                }.font(.system(size: 11, weight: .medium)).foregroundStyle(ReviewPalette.dim).padding(.horizontal, 12).padding(.vertical, 9).hubSurface(.bar)
                            }
                        }.frame(minWidth: viewport.size.width, minHeight: viewport.size.height, alignment: .topLeading)
                    }
                }
            } else {
                EmptyState(symbol: "tablecells", text: "From source to objects", detail: model.source?.kind == "audio" ?
                    "Select an interval, transcribe it, then review the readings and create proposed rows. You can also add a record manually." :
                    "Select text or draw over an image, then extract proposed rows. You can also add a record manually.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.hubSurface(.content)
    }
}

private struct RecastRecordRow: View {

    var record: RecastRecord
    var fields: [RecastField]
    var selected: Bool
    var selectedField: String
    var marked: Bool
    var mark: (Bool) -> Void
    var receiveEvidence: (String, [RecastEvidenceLink]) -> Bool
    var choose: (String) -> Void

    var body: some View {
        HStack(spacing: 0) {
            Toggle("", isOn: Binding(get: { marked }, set: mark)).toggleStyle(.checkbox).labelsHidden().frame(width: 28)
                .accessibilityLabel("Select record for bulk correction: " + (fields.first.flatMap { record.cells[$0.id]?.value.display } ?? record.id))
            Label(record.state == "accepted" ? "Ready" : "Review", systemImage: record.state == "accepted" ? "checkmark.circle.fill" : "circle.dotted")
                .font(.system(size: 10)).foregroundStyle(record.state == "accepted" ? ReviewPalette.added : ReviewPalette.modified)
                .frame(width: 78, alignment: .leading)
            ForEach(fields) { field in
                let cell = record.cells[field.id] ?? RecastCell()
                let origin = cell.origin == "user" ? "user-supplied" : cell.origin == "source" ? "source reading" : "inferred"
                let accessibility = [field.label, cell.value.isNull ? "Unknown" : cell.value.display, origin, cell.state].joined(separator: ", ")
                Button { choose(field.id) } label: {
                    HStack {
                        Text(cell.value.isNull ? "Unknown" : cell.value.display)
                            .foregroundStyle(cell.value.isNull ? ReviewPalette.dim : Color.primary).lineLimit(2)
                        Spacer(minLength: 2)
                        if !cell.anchorIds.isEmpty { Image(systemName: "link").font(.system(size: 9)).foregroundStyle(ReviewPalette.renamed) }
                    }.font(.system(size: 12)).padding(.horizontal, 6).padding(.vertical, 8).frame(width: 156, alignment: .leading)
                        .background(selected && selectedField == field.id ? ReviewPalette.renamed.opacity(0.18) : .clear)
                }.buttonStyle(RowButtonStyle()).accessibilityLabel(accessibility)
                    .dropDestination(for: RecastEvidenceLink.self) { links, _ in receiveEvidence(field.id, links) }
            }
        }.padding(.horizontal, 12).background(selected ? ReviewPalette.renamed.opacity(0.045) : .clear)
        Divider()
    }
}

struct RecastFieldInspector: View {
    @ObservedObject var model: RecastModel
    @State private var text = ""
    @State private var note = ""
    @State private var unknown = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let field = model.field, let record = model.record {
                    HStack {
                        Text(field.label).font(.system(size: 14, weight: .semibold))
                        Text(field.type + (field.required ? " · required" : "")).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        Spacer()
                        Button("Accept record") { model.acceptRecords(all: false) }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                        IconButton(systemName: "archivebox", tooltip: "Archive this record (undoable)") { model.archiveRecord() }.disabled(model.busy)
                    }
                    HStack {
                        TextField(field.type == "datetime" ? "2026-10-05T09:00" : field.type == "timezone" ? "Europe/Prague" : "Value", text: $text)
                            .textFieldStyle(.roundedBorder).disabled(unknown || model.busy)
                            .accessibilityLabel(field.label + " interpreted value")
                        Toggle("Unknown", isOn: $unknown).toggleStyle(.checkbox).disabled(model.busy)
                    }
                    HStack {
                        TextField("Correction note (optional)", text: $note).textFieldStyle(.roundedBorder).accessibilityLabel("Correction note")
                        Button("Apply correction") { model.editCell(text: text, unknown: unknown, note: note) }
                            .buttonStyle(.genHoverPlain()).disabled(model.busy)
                    }
                    if let cell = model.cell, !cell.alternatives.isEmpty {
                        Text("Proposed alternatives").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        ForEach(Array(cell.alternatives.enumerated()), id: \.offset) { _, value in
                            Button(value.isNull ? "Unknown" : value.display) {
                                unknown = value.isNull; text = value.isNull ? "" : value.display
                            }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                                .accessibilityLabel("Choose alternative " + (value.isNull ? "Unknown" : value.display))
                                .help("Stages this choice; use Apply correction to save it.")
                        }
                    }
                    ForEach(model.issues.filter { $0.recordId == record.id && ($0.fieldId == nil || $0.fieldId == field.id) }) { issue in
                        Label(issue.message, systemImage: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(ReviewPalette.modified)
                    }
                    Divider()
                    HStack {
                        Text("Source evidence").font(.system(size: 12, weight: .semibold))
                        Spacer()
                        Button("Manage evidence…", systemImage: "link.badge.plus") { model.openEvidence() }
                            .buttonStyle(.genHoverPlain()).font(.system(size: 11)).disabled(model.busy)
                    }
                    Text(model.cell?.origin == "user" ? "User-supplied value" : model.cell?.origin == "inferred" ? "Inferred interpretation · verify against the reading" : "Read from source · verify the interpretation")
                        .font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                    if let cell = model.cell, !cell.anchorIds.isEmpty {
                        ForEach((model.file?.anchors ?? []).filter { cell.anchorIds.contains($0.id) }) { anchor in
                            Button { model.reveal(anchor) } label: {
                                HStack {
                                    Image(systemName: "viewfinder").foregroundStyle(ReviewPalette.renamed)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(model.file?.sources.first { $0.id == anchor.sourceId }?.name ?? "Source").font(.system(size: 12))
                                        Text(anchor.region.description).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.up.left")
                                }.padding(7)
                            }.buttonStyle(RowButtonStyle())
                            ForEach((model.file?.readings ?? []).filter { $0.anchorId == anchor.id && cell.readingIds.contains($0.id) }) { reading in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text("Literal reading · " + reading.engine).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
                                    Text(reading.text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                    if !reading.alternatives.isEmpty {
                                        Text("Other readings: " + reading.alternatives.joined(separator: " / ")).font(.system(size: 11))
                                            .foregroundStyle(ReviewPalette.modified).fixedSize(horizontal: false, vertical: true)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(9)
                                    .background(ReviewPalette.renamed.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    } else {
                        Text("This value has no source region. Read a selection into this field, or supply your own value.")
                            .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    }
                    Button("Suggest a source-local correction…", systemImage: "wand.and.stars") { model.openCorrectionExamples() }
                        .buttonStyle(.genHoverPlain()).font(.system(size: 11)).disabled(model.busy || model.cell?.readingIds.isEmpty != false)
                    let corrections = (model.file?.corrections ?? []).filter { $0.recordId == record.id && $0.fieldId == field.id }
                    if !corrections.isEmpty {
                        DisclosureGroup("Corrections (\(corrections.count))") {
                            ForEach(corrections.reversed()) { correction in
                                Text((correction.before.value.isNull ? "Unknown" : correction.before.value.display) + " → " +
                                    (correction.after.value.isNull ? "Unknown" : correction.after.value.display) + "\n" + correction.reason)
                                    .font(.system(size: 11)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                            }
                        }.font(.system(size: 11))
                    }
                } else {
                    EmptyState(symbol: "cursorarrow", text: "Select a field", detail: "Review its value, original reading, and source evidence.")
                        .frame(maxWidth: .infinity)
                }
            }.padding(14)
        }.hubSurface(.chrome)
        .task(id: (model.file?.id ?? "") + ":" + model.selectedCollection + ":" + model.selectedRecord + ":" + model.selectedField + ":" + String(model.file?.revision ?? 0)) {
            text = model.cell?.value.display ?? ""; unknown = model.cell?.value.isNull ?? true; note = model.cell?.note ?? ""
        }
    }
}
