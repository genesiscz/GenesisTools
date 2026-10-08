import AppKit
import GenesisKit
import SwiftUI
import UniformTypeIdentifiers

struct ModelRoomProposalNumber: Codable {
    var value: Double?
    var sourceQuote: String?
    var question: String
    enum CodingKeys: String, CodingKey { case value, sourceQuote, question }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(value, forKey: .value)
        try container.encode(sourceQuote, forKey: .sourceQuote)
        try container.encode(question, forKey: .question)
    }
}

struct ModelRoomProposal: Codable {
    struct Clock: Codable {
        var unit: String
        var duration: ModelRoomProposalNumber
        var step: ModelRoomProposalNumber
    }
    struct Quantity: Codable, Identifiable {
        var id: String
        var label: String
        var kind: String
        var unit: String
        var description: String
        var value: ModelRoomProposalNumber?
        var initial: ModelRoomProposalNumber?
        var seed: ModelRoomProposalNumber?
        var expression: String?
        var derivative: String?
        enum CodingKeys: String, CodingKey { case id, label, kind, unit, description, value, initial, seed, expression, derivative }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(label, forKey: .label)
            try container.encode(kind, forKey: .kind)
            try container.encode(unit, forKey: .unit)
            try container.encode(description, forKey: .description)
            try container.encode(seed, forKey: .seed)
            if kind == "input" { try container.encode(value, forKey: .value) }
            if kind == "stock" {
                try container.encode(initial, forKey: .initial)
                try container.encode(derivative, forKey: .derivative)
            }
            if kind == "formula" { try container.encode(expression, forKey: .expression) }
        }
    }
    var format: String
    var version: Int
    var title: String
    var explanation: String
    var time: Clock
    var quantities: [Quantity]
    var outputs: [String]
}

struct ModelRoomProposalReview: Codable {
    struct Field: Codable, Identifiable {
        var key: String
        var label: String
        var unit: String
        var question: String
        var id: String { key }
    }
    struct Assumption: Identifiable {
        var id: String
        var label: String
        var unit: String
        var evidence: ModelRoomProposalNumber
    }
    var sourceText: String
    var proposal: ModelRoomProposal
    var missing: [Field]
    var warnings: [String]

    var assumptions: [Assumption] {
        var result = [
            Assumption(id: "time.duration", label: "Duration", unit: proposal.time.unit, evidence: proposal.time.duration),
            Assumption(id: "time.step", label: "Time step", unit: proposal.time.unit, evidence: proposal.time.step)
        ]
        for quantity in proposal.quantities {
            if let evidence = quantity.kind == "input" ? quantity.value : quantity.initial {
                result.append(Assumption(id: quantity.id + (quantity.kind == "input" ? ".value" : ".initial"),
                    label: quantity.label, unit: quantity.unit, evidence: evidence))
            }
            if let seed = quantity.seed {
                result.append(Assumption(id: quantity.id + ".seed", label: quantity.label + " history seed", unit: quantity.unit, evidence: seed))
            }
        }
        return result
    }

    func answers(from text: [String: String]) throws -> [String: Double] {
        var result: [String: Double] = [:]
        for field in assumptions {
            let raw = text[field.id, default: ""].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !raw.isEmpty, let number = Double(raw), number.isFinite else {
                throw NSError(domain: "ModelRoom", code: 20, userInfo: [NSLocalizedDescriptionKey: "Enter a finite value for \(field.label)."])
            }
            result[field.id] = number
        }
        return result
    }
}

struct ModelRoomProposalSheet: View {
    @ObservedObject var model: ModelRoomModel
    @Environment(\.dismiss) private var dismiss
    @State private var request = ""
    @State private var modelRef = ""
    @State private var review: ModelRoomProposalReview?
    @State private var answers: [String: String] = [:]
    @State private var preview: ModelRoomFile?
    @State private var phase = ""
    @State private var error: String?
    @State private var operation = UUID()
    @State private var section = "Assumptions"

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "sparkles").foregroundStyle(ReviewPalette.renamed)
                Text("Draft a model with AI").font(.system(size: 20, weight: .semibold))
                Spacer()
                Button("Load draft…") { loadDraft() }.buttonStyle(.genHoverPlain()).disabled(!phase.isEmpty)
            }
            Text("Describe the relationships you want to explore. Review the equations and supply missing values before opening a new model.")
                .font(.system(size: 12)).foregroundStyle(ReviewPalette.dim)
            TextEditor(text: $request).font(.system(size: 13))
                .frame(height: 76).padding(6).background(Color(nsColor: ReviewPalette.background), in: RoundedRectangle(cornerRadius: 6))
                .accessibilityLabel("Model request").disabled(!phase.isEmpty)
            HStack {
                TextField("Configured app or chat default", text: $modelRef)
                    .textFieldStyle(.roundedBorder).accessibilityLabel("Optional AI model")
                Button("Generate draft") { generate() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!phase.isEmpty || request.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || request.count > 16000)
            }
            Text("Generation sends this description to the selected model and may incur usage charges. Loading and checking a draft run locally.")
                .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
            Divider()
            if let review {
                HStack {
                    Text(review.proposal.title).font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Picker("Review section", selection: $section) {
                        Text("Assumptions").tag("Assumptions")
                        Text("Relationships").tag("Relationships")
                    }.pickerStyle(.segmented).frame(width: 250)
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text(review.proposal.explanation).font(.system(size: 12))
                        if section == "Assumptions" {
                            ForEach(review.assumptions) { field in
                                HStack(alignment: .top, spacing: 16) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(field.label).font(.system(size: 12, weight: .medium))
                                        Text(field.evidence.sourceQuote.map { "Source: “\($0)”" } ?? field.evidence.question)
                                            .font(.system(size: 11)).foregroundStyle(ReviewPalette.dim).textSelection(.enabled)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    TextField("Required", text: Binding(get: { answers[field.id, default: ""] }, set: {
                                        answers[field.id] = $0
                                        invalidatePreview()
                                    }))
                                        .textFieldStyle(.roundedBorder).frame(width: 100)
                                        .accessibilityLabel(field.label + " value")
                                        .disabled(!phase.isEmpty)
                                    Text(field.unit).font(.system(size: 11, design: .monospaced)).frame(width: 120, alignment: .leading)
                                }
                            }
                        } else {
                            ForEach(review.proposal.quantities) { quantity in
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(quantity.label + " · " + quantity.unit).font(.system(size: 12, weight: .medium))
                                    if let formula = quantity.expression ?? quantity.derivative {
                                        Text((quantity.kind == "stock" ? "Change per " + review.proposal.time.unit + ": " : "") + formula)
                                            .font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                                    }
                                    Text(quantity.description).font(.system(size: 11)).foregroundStyle(ReviewPalette.dim)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                Divider()
                            }
                        }
                        ForEach(review.warnings, id: \.self) { Text($0).font(.system(size: 11)).foregroundStyle(ReviewPalette.modified) }
                    }.padding(.vertical, 4)
                }
            } else {
                EmptyState(symbol: "point.3.connected.trianglepath.dotted", text: "Start with a question",
                    detail: "For example: How does staffing affect the queue? Include numbers you know. Unknowns will stay open.")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error { Text(error).font(.system(size: 12)).foregroundStyle(ReviewPalette.removed).textSelection(.enabled) }
            if !phase.isEmpty {
                HStack { ProgressView().controlSize(.small); Text(phase).font(.system(size: 12)); Spacer(); Button("Stop") { cancel() } }
            }
            if let preview {
                Text("Validated \(preview.quantities.count) quantities over \(preview.time.duration, specifier: "%g") \(preview.time.unit). Ready to open as a new unsaved model.")
                    .font(.system(size: 12)).foregroundStyle(ReviewPalette.added)
            }
            Divider()
            HStack {
                Button("Cancel") { cancel(); dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("Check model") { check() }.disabled(review == nil || !phase.isEmpty)
                Button("Open new model") { open() }.buttonStyle(.borderedProminent)
                    .disabled(preview == nil || !phase.isEmpty || model.openReviewedModel == nil)
            }
        }
        .padding(24).frame(width: 740, height: 710).hubSurface(.content)
        .onChange(of: request) { _, newValue in
            if review?.sourceText != newValue { clearReview() }
        }
        .onChange(of: modelRef) { _, _ in clearReview() }
        .onDisappear { cancel() }
    }

    private func invalidatePreview() {
        preview = nil
        error = nil
    }

    private func clearReview() {
        cancel()
        review = nil
        answers = [:]
        invalidatePreview()
    }

    private func cancel() {
        operation = UUID()
        model.proposalTask?.cancel()
        model.proposalTask = nil
        phase = ""
    }

    private func receive(_ value: ModelRoomProposalReview) {
        review = value
        request = value.sourceText
        answers = Dictionary(uniqueKeysWithValues: value.assumptions.map { ($0.id, $0.evidence.value.map { String($0) } ?? "") })
        preview = nil
    }

    private func generate() {
        cancel()
        review = nil
        answers = [:]
        preview = nil
        error = nil
        phase = "Generating a reviewable draft…"
        let token = operation
        let submittedRequest = request
        let reference = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        model.proposalTask = Task {
            do {
                let result = try await model.modelCommand(command: "propose",
                    arguments: reference.isEmpty ? [] : ["--model", reference],
                    attachments: [ModelRoomCommandAttachment(flag: "--request", data: Data(submittedRequest.utf8))],
                    timeoutSeconds: 125)
                let value = try JSONDecoder().decode(ModelRoomProposalReview.self, from: Data(result.utf8))
                try Task.checkCancellation()
                guard operation == token, request == submittedRequest else { return }
                receive(value)
            } catch is CancellationError {
                HubPerf.log("model-room: proposal generation cancelled")
            } catch {
                guard operation == token else { return }
                self.error = error.localizedDescription
            }
            if operation == token { phase = ""; model.proposalTask = nil }
        }
    }

    private func check() {
        guard let review else { return }
        cancel()
        preview = nil
        error = nil
        let token = operation
        do {
            let numbers = try review.answers(from: answers)
            let attachments = [
                ModelRoomCommandAttachment(flag: "--proposal", data: try JSONEncoder().encode(review)),
                ModelRoomCommandAttachment(flag: "--answers", data: try JSONEncoder().encode(numbers))
            ]
            phase = "Checking units and calculating the complete model…"
            model.proposalTask = Task {
                do {
                    let result = try await model.modelCommand(command: "resolve-proposal", attachments: attachments)
                    let file = try JSONDecoder().decode(ModelRoomFile.self, from: Data(result.utf8))
                    try file.validateForEditing()
                    try Task.checkCancellation()
                    guard operation == token else { return }
                    preview = file
                } catch is CancellationError {
                    HubPerf.log("model-room: proposal check cancelled")
                } catch {
                    guard operation == token else { return }
                    self.error = error.localizedDescription
                }
                if operation == token { phase = ""; model.proposalTask = nil }
            }
        } catch { self.error = error.localizedDescription }
    }

    private func open() {
        guard let preview, let open = model.openReviewedModel else { return }
        do {
            try open(preview)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    private func loadDraft() {
        guard let window = model.owner?.windowControllers.first?.window else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.message = "Choose a saved AI proposal to review locally."
        panel.beginSheetModal(for: window.attachedSheet ?? window) { response in
            guard response == .OK, let url = panel.url else { return }
            clearReview()
            error = nil
            phase = "Checking the saved draft…"
            let token = operation
            model.proposalTask = Task {
                do {
                    let result = try await model.modelCommand(command: "review-proposal", arguments: ["--proposal", url.path])
                    let value = try JSONDecoder().decode(ModelRoomProposalReview.self, from: Data(result.utf8))
                    try Task.checkCancellation()
                    guard operation == token else { return }
                    receive(value)
                } catch is CancellationError {
                    HubPerf.log("model-room: draft loading cancelled")
                } catch {
                    guard operation == token else { return }
                    self.error = error.localizedDescription
                }
                if operation == token { phase = ""; model.proposalTask = nil }
            }
        }
    }
}
