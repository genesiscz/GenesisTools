import AppKit
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

extension RecastModel {
    func chooseCSVEdits(receipt: RecastRenderingReceipt? = nil) {
        guard !busy, let file else { return }
        guard let receipt = receipt ?? file.renderings?.last(where: {
            $0.collectionId == selectedCollection && $0.format == "csv" && $0.includeRecordIds
        }) else {
            error = "First save or copy a CSV export with row IDs. Recast keeps that version for comparing later edits."
            return
        }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.commaSeparatedText, .plainText]
        panel.message = "Choose an edited copy of this export. You will review every change before applying it."
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.reviewCSV(url: url, receipt: receipt)
        }
    }

    func reviewCSV(url: URL, receipt: RecastRenderingReceipt? = nil) {
        guard !busy, let file else { return }
        guard let receipt = receipt ?? file.renderings?.last(where: {
            $0.collectionId == selectedCollection && $0.format == "csv" && $0.includeRecordIds
        }) else {
            error = "First save or copy a CSV export with row IDs. Recast keeps that version for comparing later edits."
            return
        }
        perform("Comparing CSV edits") { model in
                let prepared = try await Task.detached(priority: .userInitiated) {
                    let attributes = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                    guard attributes.isRegularFile == true, let size = attributes.fileSize, size <= 16 * 1024 * 1024 else {
                        throw recastError("Choose a CSV file no larger than 16 MiB.")
                    }
                    let data = try Data(contentsOf: url)
                    guard data.count <= 16 * 1024 * 1024, let text = String(data: data, encoding: .utf8) else {
                        throw recastError("The CSV must be UTF-8 text no larger than 16 MiB.")
                    }
                    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("recast-csv-" + UUID().uuidString)
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                    let frozen = folder.appendingPathComponent("edited.csv")
                    do { try data.write(to: frozen, options: .atomic) }
                    catch {
                        do { try FileManager.default.removeItem(at: folder) }
                        catch { HubPerf.log("recast: failed CSV preparation cleanup: \(error)") }
                        throw error
                    }
                    return (text, folder, frozen)
                }.value
                defer {
                    do { try FileManager.default.removeItem(at: prepared.1) }
                    catch { HubPerf.log("recast: CSV comparison cleanup failed: \(error)") }
                }
                try Task.checkCancellation()
                let answer = try await model.command("roundtrip", file: file, arguments: ["--receipt", receipt.id, "--csv", prepared.2.path])
                let review = try JSONDecoder().decode(RecastRoundTripReview.self, from: Data(answer.utf8))
                model.roundTrip = RecastRoundTripDraft(csv: prepared.0, name: url.lastPathComponent, review: review)
                model.showRoundTrip = true
        }
    }

    func applyCSVEdits(_ draft: RecastRoundTripDraft, changeIds: Set<String>) {
        guard roundTrip?.id == draft.id, let file, file.id == draft.review.documentId, file.revision == draft.review.revision else {
            error = "The conversion changed. Compare this CSV again before applying edits."
            return
        }
        guard !changeIds.isEmpty else { return }
        perform("Applying reviewed CSV edits") { model in
            try await model.apply([recastOperation("apply-roundtrip", [
                "receiptId": .string(draft.review.receiptId), "csv": .string(draft.csv),
                "importChangeIds": .array(changeIds.sorted().map { .string($0) })
            ])], title: "Apply CSV edits")
            model.roundTrip = nil; model.showRoundTrip = false
            model.notice = "Applied \(changeIds.count) reviewed changes. Edited fields are drafts until accepted."
        }
    }
}

struct RecastRoundTripSheet: View {
    @ObservedObject var model: RecastModel
    var draft: RecastRoundTripDraft
    @State private var selected = Set<String>()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Review CSV edits").font(.system(size: 20, weight: .semibold))
                    Text(draft.name).font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
                }
                Spacer()
                Button("Cancel") { model.roundTrip = nil; model.showRoundTrip = false; dismiss() }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction).disabled(model.busy)
            }
            Text("\(draft.review.changes.count) changes · \(draft.review.unchanged) fields kept · \(draft.review.importedRows) CSV rows")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            if draft.review.changes.isEmpty {
                EmptyState(symbol: "checkmark.circle", text: "No new edits", detail: "The CSV introduces no changes. Newer corrections in Recast stay intact.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(draft.review.changes) { change in
                            VStack(alignment: .leading, spacing: 9) {
                                Toggle(isOn: Binding(
                                    get: { selected.contains(change.id) },
                                    set: { if $0 { selected.insert(change.id) } else { selected.remove(change.id) } }
                                )) {
                                    HStack {
                                        Text(change.kind == "archive" ? "Archive " + change.label : change.label).fontWeight(.medium)
                                        Spacer()
                                        Text(change.status == "conflict" ? "Both changed" : change.status == "invalid" ? "Needs a fix" : "CSV changed")
                                            .foregroundStyle(change.status == "change" ? ReviewPalette.added : ReviewPalette.modified)
                                    }
                                }.toggleStyle(.checkbox).disabled(change.status == "invalid" || model.busy)
                                if change.kind == "field" {
                                    HStack(alignment: .top, spacing: 16) {
                                        valueColumn("At export", change.base)
                                        valueColumn("In Recast", change.current)
                                        valueColumn("From CSV", change.incoming)
                                    }
                                }
                                Text(change.message).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                            }.font(.system(size: 12)).padding(12)
                                .background(ReviewPalette.renamed.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            HStack {
                Text("Source readings and evidence are preserved.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                Button("Apply \(selected.count) changes") { model.applyCSVEdits(draft, changeIds: selected) }
                    .buttonStyle(.genHoverPlain()).disabled(selected.isEmpty || model.busy)
            }
        }.padding(22).frame(width: 850, height: 660).preferredColorScheme(.dark)
        .background(Color(nsColor: ReviewPalette.background))
        .onAppear { selected = Set(draft.review.changes.filter { $0.status == "change" }.map(\.id)) }
    }

    private func valueColumn(_ label: String, _ value: RecastJSON) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.system(size: 10)).foregroundStyle(ReviewPalette.dim)
            Text(value.isNull ? "Unknown" : value.display).font(.system(size: 12)).textSelection(.enabled)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
