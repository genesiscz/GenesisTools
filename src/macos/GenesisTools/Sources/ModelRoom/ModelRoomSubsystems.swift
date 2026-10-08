import AppKit
import GenesisKit
import UniformTypeIdentifiers

struct ModelRoomCommandAttachment {
    var flag: String
    var data: Data
}

struct ModelRoomSubsystemPackage: Codable {
    var format: String
    var version: Int
    var model: ModelRoomFile
    var members: [String]
    var boundaryInputs: [String]
    var outputs: [String]
}

struct ModelRoomSubsystemInspection: Decodable {
    struct Missing: Decodable {
        var quantity: ModelRoomQuantity
        var requiredBy: [String]
    }
    var members: [ModelRoomQuantity]
    var boundaryInputs: [ModelRoomQuantity]
    var missingDependencies: [Missing]
}

struct ModelRoomSubsystemChoices: Decodable {
    struct Choice: Decodable, Identifiable {
        var quantity: ModelRoomQuantity
        var candidates: [ModelRoomQuantity]
        var id: String { quantity.id }
    }
    var packageFile: ModelRoomSubsystemPackage
    var choices: [Choice]
}

struct ModelRoomSubsystemSource: Identifiable {
    let id = UUID()
    var url: URL
    var original: ModelRoomFile
    var preview: ModelRoomSubsystemChoices
}

struct ModelRoomSubsystemImportResult: Decodable {
    var document: ModelRoomFile
    var subsystemId: String
    var mapping: [String: String]
    var added: [String]
    var bound: [String]
    var outputs: [String]
}

extension ModelRoomModel {
    func chooseSubsystem() {
        guard let window = owner?.windowControllers.first?.window, !importing else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.directoryURL = owner?.fileURL?.deletingLastPathComponent() ?? ModelRoomConfiguration.initialDirectory
        panel.allowsMultipleSelection = false
        panel.message = "Choose a reusable Model Room subsystem."
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            self?.prepareSubsystemImport(url: url)
        }
    }

    func prepareSubsystemImport(url: URL) {
        guard let original = file, !importing else { return }
        importing = true
        subsystemTask?.cancel()
        subsystemTask = Task { [weak self] in
            guard let self else { return }
            defer { importing = false }
            do {
                let data = try await Task.detached(priority: .userInitiated) {
                    let data = try Data(contentsOf: url, options: .mappedIfSafe)
                    guard data.count <= 16 * 1024 * 1024 else {
                        throw NSError(domain: "ModelRoom", code: 8, userInfo: [NSLocalizedDescriptionKey: "Subsystem packages may not exceed 16 MiB."])
                    }
                    return data
                }.value
                let output = try await documentCommand(original, command: "subsystem-bindings", attachments: [ModelRoomCommandAttachment(flag: "--subsystem", data: data)])
                let preview = try JSONDecoder().decode(ModelRoomSubsystemChoices.self, from: Data(output.utf8))
                try Task.checkCancellation()
                guard file == original else {
                    throw NSError(domain: "ModelRoom", code: 9, userInfo: [NSLocalizedDescriptionKey: "The model changed during preview. Open the subsystem again."])
                }
                subsystemImport = ModelRoomSubsystemSource(url: url, original: original, preview: preview)
            } catch is CancellationError {
                HubPerf.log("model-room: subsystem preview cancelled")
            } catch { self.error = error.localizedDescription }
        }
    }

    func inspectSubsystem(_ original: ModelRoomFile, members: Set<String>) async throws -> ModelRoomSubsystemInspection {
        let result = try await documentCommand(original, command: "inspect-subsystem", arguments: ["--members", members.sorted().joined(separator: ",")])
        return try JSONDecoder().decode(ModelRoomSubsystemInspection.self, from: Data(result.utf8))
    }

    func extractSubsystem(_ original: ModelRoomFile, members: Set<String>, outputs: Set<String>, label: String) async throws -> Data {
        let result = try await documentCommand(original, command: "extract-subsystem", arguments: ["--members", members.sorted().joined(separator: ","), "--outputs", outputs.sorted().joined(separator: ","), "--label", label])
        return Data(result.utf8)
    }

    func previewSubsystemImport(source: ModelRoomSubsystemSource, namespace: String, bindings: [String: String]) async throws -> ModelRoomSubsystemImportResult {
        let attachments = [
            ModelRoomCommandAttachment(flag: "--subsystem", data: try JSONEncoder().encode(source.preview.packageFile)),
            ModelRoomCommandAttachment(flag: "--bindings", data: try JSONEncoder().encode(bindings))
        ]
        let result = try await documentCommand(source.original, command: "import-subsystem", arguments: ["--namespace", namespace], attachments: attachments)
        let preview = try JSONDecoder().decode(ModelRoomSubsystemImportResult.self, from: Data(result.utf8))
        try preview.document.validateForEditing()
        return preview
    }

    func applySubsystemImport(_ preview: ModelRoomSubsystemImportResult, source: ModelRoomSubsystemSource) throws {
        try commitDraft(preview.document, replacing: source.original, actionName: "Import subsystem")
        selectedScenario = ""
        selectedQuantity = preview.outputs.first ?? preview.added.first ?? selectedQuantity
        notice = "Imported \(source.preview.packageFile.model.title) · \(preview.added.count) new quantities"
        subsystemImport = nil
    }
}
