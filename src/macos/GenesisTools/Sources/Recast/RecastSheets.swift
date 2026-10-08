import AppKit
import GenesisKit
import SwiftUI

struct RecastExportSheet: View {
    @ObservedObject var model: RecastModel
    var embedded = false
    @Environment(\.dismiss) private var dismiss
    @State private var evidence = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Export reviewed objects").font(.system(size: 20, weight: .semibold))
                Spacer()
                if embedded {
                    Button("Refresh preview") { model.prepareExport(presentSheet: false) }.buttonStyle(.genHoverPlain())
                        .disabled(model.busy || model.records.isEmpty)
                } else {
                    Button("Done") { dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                }
            }
            HStack(spacing: 14) {
                Picker("Format", selection: $model.exportFormat) {
                    Text("CSV").tag("csv")
                    Text("Markdown").tag("markdown")
                    Text("JSON").tag("json")
                    if model.collection?.kind == "calendar" { Text("Calendar").tag("ics") }
                }.pickerStyle(.segmented)
                if model.exportFormat == "csv" {
                    Toggle("Row IDs for re-import", isOn: $model.exportIncludeRecordIDs).toggleStyle(.checkbox)
                }
            }.disabled(model.busy)
            .onChange(of: model.exportFormat) { _, _ in model.prepareExport(presentSheet: !embedded) }
            .onChange(of: model.exportIncludeRecordIDs) { _, _ in model.prepareExport(presentSheet: !embedded) }
            if model.busy { ProgressView(model.progress).controlSize(.small) }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            if model.rendering == nil && !model.busy {
                Text(model.records.isEmpty ? "Add a record to preview a destination." : "Resolve these fields and review the records before exporting.")
                    .font(.system(size: 13, weight: .medium))
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.destinationIssues.prefix(200)) { issue in
                            Button {
                                model.selectField(recordId: issue.recordId, fieldId: issue.fieldId ?? model.collection?.fields.first?.id ?? "")
                                model.workspaceMode = .objects
                                if !embedded { dismiss() }
                            } label: {
                                Label(issue.message, systemImage: "exclamationmark.circle")
                                    .font(.system(size: 12)).frame(maxWidth: .infinity, alignment: .leading)
                            }.buttonStyle(.genHoverPlain())
                        }
                        if model.destinationIssues.count > 200 {
                            Text("\(model.destinationIssues.count) issues total; first 200 shown. Review each record in Objects.")
                                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                        }
                    }
                }
            }
            if let rendering = model.rendering {
                HStack {
                    Text("\(rendering.recordIds.count) records · \(rendering.format.uppercased())").foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Toggle("Evidence map", isOn: $evidence).toggleStyle(.checkbox)
                }.font(.system(size: 12))
                ScrollView([.horizontal, .vertical]) {
                    Text(evidence ? rendering.evidence : rendering.text)
                        .font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .topLeading).padding(14)
                }.background(ReviewPalette.renamed.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                HStack {
                    Text("Source files stay in your Recast document.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                    Spacer()
                    Button("Copy") { model.copyExport(evidence: evidence) }
                        .buttonStyle(.genHoverPlain()).disabled(model.busy)
                    Button("Save file…") { model.saveExport(evidence: evidence) }.buttonStyle(.genHoverPlain()).disabled(model.busy)
                }
            }
        }.padding(22).frame(width: embedded ? nil : 820, height: embedded ? nil : 560).preferredColorScheme(.dark)
        .background(Color(nsColor: ReviewPalette.background))
        .onAppear { if embedded { model.prepareExport(presentSheet: false) } }
    }
}

struct RecastCollectionSheet: View {
    @ObservedObject var model: RecastModel
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "table"
    @State private var label = "Table"
    @State private var fields: [RecastField] = []
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Create an object collection").font(.system(size: 20, weight: .semibold))
            Picker("Make a", selection: $kind) {
                Text("Table").tag("table")
                Text("Checklist").tag("checklist")
                Text("Calendar").tag("calendar")
            }.pickerStyle(.segmented)
            TextField("Collection name", text: $label).textFieldStyle(.roundedBorder)
            Text("Fields").font(.system(size: 12, weight: .semibold))
            ScrollView {
                VStack(spacing: 9) {
                    ForEach($fields) { $field in
                        HStack(spacing: 10) {
                            TextField("Field name", text: $field.label).textFieldStyle(.roundedBorder)
                            Picker("Type", selection: $field.type) {
                                ForEach(["text", "number", "boolean", "date", "datetime", "timezone"], id: \.self) { Text($0).tag($0) }
                            }.labelsHidden().frame(width: 118).disabled(kind != "table")
                            Toggle("Required", isOn: $field.required).toggleStyle(.checkbox).disabled(kind != "table")
                            if kind == "table" {
                                IconButton(systemName: "minus.circle", tooltip: "Remove this field") { fields.removeAll { $0.id == field.id } }
                                    .disabled(fields.count <= 1)
                            }
                        }
                    }
                }
            }
            if kind == "table" {
                Button("Add field", systemImage: "plus") {
                    fields.append(RecastField(id: recastID("field"), label: "New field", type: "text", required: false))
                }.buttonStyle(.genHoverPlain()).disabled(fields.count >= 32)
            }
            if let error { NoticePill(text: error, isError: true) { self.error = nil } }
            HStack {
                Text(kind == "calendar" ? "Calendar records require start, end and an explicit time zone." : "Unknown and optional fields remain explicit.")
                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                Button("Cancel") { dismiss() }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
                Button("Create") {
                    model.addCollection(RecastCollection(id: recastID("collection"), label: label, kind: kind, fields: fields))
                    dismiss()
                }.buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction).disabled(loading || model.busy || fields.isEmpty || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(22).frame(width: 650, height: 510).preferredColorScheme(.dark)
        .task(id: kind) {
            loading = true
            do {
                let answer = try await model.command("new", arguments: ["--kind", kind])
                try Task.checkCancellation()
                let file = try JSONDecoder().decode(RecastFile.self, from: Data(answer.utf8))
                if let collection = file.collections.first { label = collection.label; fields = collection.fields }
                loading = false
            } catch is CancellationError {
                HubPerf.log("recast: collection template request cancelled")
            } catch { self.error = error.localizedDescription; loading = false }
        }
    }
}
