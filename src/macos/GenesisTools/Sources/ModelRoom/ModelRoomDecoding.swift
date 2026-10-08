import Foundation

extension ModelRoomQuantity {
    private enum DocumentKeys: String, CodingKey {
        case id, label, unit, description, provenance, seed, range, position, kind, value, expression, initial, derivative, min, max, points, interpolation, source
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DocumentKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        unit = try c.decode(String.self, forKey: .unit)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        provenance = try c.decodeIfPresent(String.self, forKey: .provenance) ?? "assumption"
        seed = try c.decodeIfPresent(Double.self, forKey: .seed)
        range = try c.decodeIfPresent(ModelRoomRange.self, forKey: .range)
        position = try c.decodeIfPresent(ModelRoomPoint.self, forKey: .position) ?? ModelRoomPoint(x: 0, y: 0)
        kind = try c.decode(String.self, forKey: .kind)
        value = try c.decodeIfPresent(Double.self, forKey: .value)
        expression = try c.decodeIfPresent(String.self, forKey: .expression)
        initial = try c.decodeIfPresent(Double.self, forKey: .initial)
        derivative = try c.decodeIfPresent(String.self, forKey: .derivative)
        min = try c.decodeIfPresent(Double.self, forKey: .min)
        max = try c.decodeIfPresent(Double.self, forKey: .max)
        points = try c.decodeIfPresent([ModelRoomObservation].self, forKey: .points)
        interpolation = try c.decodeIfPresent(String.self, forKey: .interpolation)
        source = try c.decodeIfPresent(String.self, forKey: .source)
    }
}

extension ModelRoomScenario {
    private enum DocumentKeys: String, CodingKey { case id, label, description, color, overrides, interventions, replacements, removed }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DocumentKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        color = try c.decodeIfPresent(String.self, forKey: .color) ?? "#a9c9ff"
        overrides = try c.decodeIfPresent([String: Double].self, forKey: .overrides) ?? [:]
        interventions = try c.decodeIfPresent([ModelRoomIntervention].self, forKey: .interventions) ?? []
        replacements = try c.decodeIfPresent([ModelRoomQuantity].self, forKey: .replacements) ?? []
        removed = try c.decodeIfPresent([String].self, forKey: .removed) ?? []
    }
}

extension ModelRoomFile {
    private enum DocumentKeys: String, CodingKey { case format, version, id, title, description, time, quantities, scenarios, subsystems, presentation }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DocumentKeys.self)
        format = try c.decode(String.self, forKey: .format)
        version = try c.decode(Int.self, forKey: .version)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        time = try c.decode(ModelRoomTime.self, forKey: .time)
        quantities = try c.decode([ModelRoomQuantity].self, forKey: .quantities)
        scenarios = try c.decodeIfPresent([ModelRoomScenario].self, forKey: .scenarios) ?? []
        subsystems = try c.decodeIfPresent([ModelRoomSubsystem].self, forKey: .subsystems) ?? []
        presentation = try c.decodeIfPresent(ModelRoomPresentation.self, forKey: .presentation) ?? ModelRoomPresentation(controls: [], outputs: [], steps: [])
    }
}
