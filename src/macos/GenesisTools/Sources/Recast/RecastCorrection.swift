import AppKit
import GenesisKit
import SwiftUI

struct RecastCorrectionExample: Decodable, Identifiable {
    var correctionId: String
    var value: RecastJSON
    var previousValue: RecastJSON
    var reason: String
    var sourceNames: [String]
    var previousReadings: [String]
    var currentReadings: [String]
    var id: String { correctionId }
}
struct RecastCorrectionPreview: Decodable {
    var documentId: String
    var revision: Int
    var recordId: String
    var fieldId: String
    var fieldLabel: String
    var examples: [RecastCorrectionExample]
}

extension RecastModel {
    func openCorrectionExamples() {
        guard !busy, let file, let scope = evidenceScope else { return }
        correctionExamples = nil; correctionExampleScope = scope
        perform("Checking source-local corrections") { model in
            let answer = try await model.command("correction-examples", file: file,
                arguments: ["--record", scope.recordId, "--field", scope.fieldId])
            let preview = try JSONDecoder().decode(RecastCorrectionPreview.self, from: Data(answer.utf8))
            guard model.evidenceScope == scope, preview.documentId == scope.documentId, preview.revision == scope.revision,
                  preview.recordId == scope.recordId, preview.fieldId == scope.fieldId else {
                throw recastError("The selected field changed. Reopen correction suggestions.")
            }
            model.correctionExamples = preview; model.showCorrectionExamples = true
        }
    }

    func correctionExampleOperation(preview: RecastCorrectionPreview, correctionId: String) throws -> RecastJSON {
        guard let scope = evidenceScope, correctionExampleScope == scope,
              preview.documentId == scope.documentId, preview.revision == scope.revision,
              preview.recordId == scope.recordId, preview.fieldId == scope.fieldId,
              correctionExamples?.examples.contains(where: { $0.id == correctionId }) == true else {
            throw recastError("The conversion changed. Inspect fresh source-local suggestions.")
        }
        return recastOperation("reuse-correction", ["recordId": .string(scope.recordId), "fieldId": .string(scope.fieldId),
            "correctionId": .string(correctionId), "reason": .string("Reviewed source-local correction example")])
    }

    func applyCorrectionExample(preview: RecastCorrectionPreview, correctionId: String) {
        do {
            let operation = try correctionExampleOperation(preview: preview, correctionId: correctionId)
            perform("Proposing source-local correction") { model in
                try await model.apply([operation], title: "Propose source-local correction")
                model.notice = "Correction proposed on the current source evidence. Verify it before accepting."
            }
        } catch { self.error = error.localizedDescription }
    }
}

struct RecastCorrectionSheet: View {
    @ObservedObject var model: RecastModel
    let preview: RecastCorrectionPreview
    @State private var selected = ""
    private var current: Bool {
        guard let scope = model.evidenceScope else { return false }
        return model.correctionExampleScope == scope && scope.documentId == preview.documentId &&
            scope.revision == preview.revision && scope.recordId == preview.recordId && scope.fieldId == preview.fieldId
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Source-local suggestions for " + preview.fieldLabel).font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("Close") {
                    if model.busy { model.cancel() }
                    model.showCorrectionExamples = false; model.correctionExamples = nil; model.correctionExampleScope = nil
                }.buttonStyle(.genHoverPlain()).keyboardShortcut(.cancelAction)
            }
            Text("These earlier human corrections match this field's frozen source regions and readings. Reuse creates an inferred draft; it does not train a recognizer or accept the value.")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            if preview.examples.isEmpty {
                EmptyState(symbol: "wand.and.stars", text: "No matching local correction",
                    detail: "Correct a source-bound value manually first. Different sources, object kinds, field types or regions do not reuse that judgment.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(preview.examples) { example in
                            VStack(alignment: .leading, spacing: 9) {
                                Toggle(isOn: Binding(get: { selected == example.id }, set: { selected = $0 ? example.id : "" })) {
                                    Text("Propose " + example.value.display).font(.system(size: 16, weight: .semibold))
                                }.toggleStyle(.checkbox).disabled(model.busy || !current)
                                Text("Earlier value: " + (example.previousValue.isNull ? "Unknown" : example.previousValue.display))
                                    .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                                Text(example.reason).font(.system(size: 12)).textSelection(.enabled)
                                Text(example.sourceNames.joined(separator: " · ")).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                                Text("Earlier literal excerpts").font(.system(size: 11, weight: .semibold))
                                Text(example.previousReadings.joined(separator: "\n")).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                Text("Current literal excerpts").font(.system(size: 11, weight: .semibold))
                                Text(example.currentReadings.joined(separator: "\n")).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                                .background(ReviewPalette.renamed.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }.padding(8)
                }
            }
            if !current { Text("The selected field changed. Reopen suggestions.").foregroundStyle(ReviewPalette.modified) }
            if let error = model.error { NoticePill(text: error, isError: true) { model.error = nil } }
            HStack {
                Text("Up to 64 recent matches; excerpts are bounded.").font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                Spacer()
                Button("Show current source") { model.revealSelectedEvidence(detached: true) }.buttonStyle(.genHoverPlain()).disabled(!current || model.busy)
                if model.busy { ProgressView().controlSize(.small) }
                Button("Use as proposal") { model.applyCorrectionExample(preview: preview, correctionId: selected) }
                    .buttonStyle(.genHoverPlain()).keyboardShortcut(.defaultAction)
                    .disabled(model.busy || !current || selected.isEmpty)
            }
        }.padding(22).frame(width: 900, height: 740)
            .background(Color(nsColor: ReviewPalette.background)).preferredColorScheme(.dark)
    }
}
