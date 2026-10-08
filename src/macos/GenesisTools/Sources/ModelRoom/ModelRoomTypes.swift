import Foundation

struct ModelRoomPoint: Codable, Equatable {
    var x: Double
    var y: Double
}

struct ModelRoomRange: Codable, Equatable {
    var min: Double
    var max: Double
    var step: Double
}

struct ModelRoomObservation: Codable, Equatable {
    var time: Double
    var value: Double
}

struct ModelRoomQuantity: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var unit: String
    var description: String = ""
    var provenance: String = "assumption"
    var seed: Double?
    var range: ModelRoomRange?
    var position: ModelRoomPoint
    var kind: String
    var value: Double?
    var expression: String?
    var initial: Double?
    var derivative: String?
    var min: Double?
    var max: Double?
    var points: [ModelRoomObservation]?
    var interpolation: String?
    var source: String?

    var formula: String { expression ?? derivative ?? "" }
    var baseValue: Double { value ?? initial ?? points?.first?.value ?? 0 }
}

struct ModelRoomIntervention: Codable, Equatable, Identifiable {
    var at: Double
    var values: [String: Double]
    var label: String
    var id: String { "\(at):\(label)" }
}

struct ModelRoomScenario: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var description: String = ""
    var color: String = "#dfacff"
    var overrides: [String: Double] = [:]
    var interventions: [ModelRoomIntervention] = []
    var replacements: [ModelRoomQuantity] = []
    var removed: [String] = []
}

struct ModelRoomSubsystem: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var description: String
    var quantities: [String]
}

struct ModelRoomPresentationStep: Codable, Equatable {
    var title: String
    var text: String
    var scenario: String?
    var time: Double?
}

struct ModelRoomPresentation: Codable, Equatable {
    var controls: [String]
    var outputs: [String]
    var steps: [ModelRoomPresentationStep]
}

struct ModelRoomTime: Codable, Equatable {
    var unit: String
    var duration: Double
    var step: Double
}

struct ModelRoomFile: Codable, Equatable {
    var format: String = "genesis-model-room"
    var version: Int = 1
    var id: String
    var title: String
    var description: String
    var time: ModelRoomTime
    var quantities: [ModelRoomQuantity]
    var scenarios: [ModelRoomScenario]
    var subsystems: [ModelRoomSubsystem]
    var presentation: ModelRoomPresentation
}

struct ModelRoomFrame: Codable {
    var tick: Int
    var time: Double
    var values: [String: Double]
}

struct ModelRoomResult: Codable {
    var scenarioId: String?
    var frames: [ModelRoomFrame]
    var method: String
    var timeUnit: String
    var step: Double
    var chartFrames: [String: [ModelRoomFrame]] = [:]

    private enum CodingKeys: String, CodingKey { case scenarioId, frames, method, timeUnit, step }
}

struct ModelRoomEvaluatedScenario: Codable, Identifiable {
    var id: String?
    var label: String
    var color: String
    var result: ModelRoomResult?
    var error: String?
    var selectionID: String { id ?? "" }
}

struct ModelRoomRelationship: Codable, Identifiable {
    var source: String
    var target: String
    var delayed: Bool
    var id: String { "\(source):\(target):\(delayed)" }
}

struct ModelRoomEvaluation: Codable {
    var document: ModelRoomFile
    var scenarios: [ModelRoomEvaluatedScenario]
    var relationships: [ModelRoomRelationship]

    mutating func prepareCharts() {
        let series = scenarios.reduce(0) { $0 + ($1.result?.frames.first?.values.count ?? 0) }
        let limit = min(512, max(4, 32768 / max(1, series)))
        for index in scenarios.indices {
            guard var result = scenarios[index].result, let first = result.frames.first else { continue }
            for id in first.values.keys { result.chartFrames[id] = modelRoomChartSamples(result.frames, quantity: id, limit: limit) }
            scenarios[index].result = result
        }
    }
}

func modelRoomChartSamples(_ frames: [ModelRoomFrame], quantity: String, limit: Int) -> [ModelRoomFrame] {
    let limit = max(4, limit)
    guard frames.count > limit, let first = frames.first, let last = frames.last else { return frames }
    let buckets = (limit - 2) / 2
    var sampled = [first]
    for bucket in 0..<buckets {
        let start = 1 + bucket * (frames.count - 2) / buckets
        let end = 1 + (bucket + 1) * (frames.count - 2) / buckets
        var minimum = start
        var maximum = start
        for index in start..<end {
            if (frames[index].values[quantity] ?? 0) < (frames[minimum].values[quantity] ?? 0) { minimum = index }
            if (frames[index].values[quantity] ?? 0) > (frames[maximum].values[quantity] ?? 0) { maximum = index }
        }
        for index in Set([minimum, maximum]).sorted() { sampled.append(frames[index]) }
    }
    sampled.append(last)
    return sampled
}

enum ModelRoomMode: String, CaseIterable {
    case build = "Build"
    case explore = "Explore"
    case compare = "Compare"
    case present = "Present"
}

struct ModelRoomTablePreview: Codable {
    var headers: [String]
    var preview: [[String]]
    var rowCount: Int
    var sha256: String
}

struct ModelRoomTableSource: Identifiable {
    var url: URL
    var delimiter: String
    var table: ModelRoomTablePreview
    var id: String { url.path + ":" + delimiter + ":" + table.sha256 }
}
