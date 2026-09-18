import Foundation

public enum WorkflowArgumentError: Error, LocalizedError {
    case invalid(String)

    public var errorDescription: String? {
        switch self {
        case .invalid(let message):
            return message
        }
    }
}

public struct WorkflowArguments {
    public let values: [String: String]
    public let flags: Set<String>

    public init(_ args: [String], command: String) throws {
        let valueOptions: Set<String>
        let flagOptions: Set<String>
        switch command {
        case "see":
            valueOptions = ["--app", "--window-index", "--window-id", "--depth", "--path", "--scope", "--perception", "--perception-crop", "--perception-width"]
            flagOptions = ["--no-image"]
        case "act":
            valueOptions = [
                "--app", "--snapshot", "--element", "--action", "--value", "--ax-action", "--direction", "--text",
                "--keys", "--coords", "--button", "--to", "--duration", "--pages", "--pixels", "--range", "--prefix",
                "--suffix", "--selection", "--format", "--path", "--region",
            ]
            flagOptions = ["--background", "--double", "--refresh", "--no-cursor", "--no-image"]
        default:
            throw WorkflowArgumentError.invalid("unknown workflow command \(command)")
        }

        var parsedValues: [String: String] = [:]
        var parsedFlags = Set<String>()
        var index = 0
        while index < args.count {
            let option = args[index]
            if valueOptions.contains(option) {
                guard parsedValues[option] == nil, !parsedFlags.contains(option) else {
                    throw WorkflowArgumentError.invalid("duplicate option \(option)")
                }
                guard index + 1 < args.count else {
                    throw WorkflowArgumentError.invalid("missing value for \(option)")
                }
                parsedValues[option] = args[index + 1]
                index += 2
            } else if flagOptions.contains(option) {
                guard parsedValues[option] == nil, parsedFlags.insert(option).inserted else {
                    throw WorkflowArgumentError.invalid("duplicate option \(option)")
                }
                index += 1
            } else {
                throw WorkflowArgumentError.invalid("unknown option \(option)")
            }
        }

        guard parsedValues["--app"] != nil else {
            throw WorkflowArgumentError.invalid("--app required")
        }
        if command == "see", parsedFlags.contains("--no-image"), parsedValues["--path"] != nil {
            throw WorkflowArgumentError.invalid("--no-image cannot be combined with --path")
        }
        if command == "see" {
            if let mode = parsedValues["--perception"], mode != "ocr" {
                throw WorkflowArgumentError.invalid("--perception supports native ocr only")
            }
            if parsedValues["--perception-crop"] != nil || parsedValues["--perception-width"] != nil {
                guard parsedValues["--perception"] == "ocr" else {
                    throw WorkflowArgumentError.invalid("perception transforms require --perception ocr")
                }
            }
            if parsedFlags.contains("--no-image"), parsedValues["--perception"] != nil {
                throw WorkflowArgumentError.invalid("OCR perception requires an image")
            }
        }
        if command == "act" {
            guard let action = parsedValues["--action"], ["get", "press", "click", "move", "drag", "set", "perform", "focus", "scroll", "type", "key", "select", "paste"].contains(action) else {
                throw WorkflowArgumentError.invalid("--action required and must name a supported action")
            }
            guard parsedValues["--snapshot"] != nil else {
                throw WorkflowArgumentError.invalid("--snapshot required")
            }
            let hasElement = parsedValues["--element"] != nil
            let hasCoordinates = parsedValues["--coords"] != nil
            let hasRegion = parsedValues["--region"] != nil
            guard [hasElement, hasCoordinates, hasRegion].filter({ $0 }).count == 1 else {
                throw WorkflowArgumentError.invalid("act requires exactly one of --element, --coords or --region")
            }
            try Self.validateAction(action, values: parsedValues, flags: parsedFlags)
        }

        values = parsedValues
        flags = parsedFlags
    }

    private static func validateAction(_ action: String, values: [String: String], flags: Set<String>) throws {
        func reject(_ options: Set<String>, unless allowed: Set<String>) throws {
            if !options.isDisjoint(with: Set(values.keys).union(flags)) && !allowed.contains(action) {
                throw WorkflowArgumentError.invalid("option is not valid for \(action)")
            }
        }

        try reject(["--button", "--double"], unless: ["click"])
        try reject(["--background", "--coords", "--region"], unless: ["click", "move", "drag", "scroll"])
        try reject(["--prefix", "--suffix", "--selection", "--range"], unless: ["select"])
        try reject(["--format"], unless: ["paste"])
        try reject(["--text"], unless: ["type", "select", "paste"])
        try reject(["--to", "--duration"], unless: ["drag"])
        try reject(["--pages", "--pixels", "--direction"], unless: ["scroll"])
        try reject(["--value"], unless: ["set"])
        try reject(["--keys"], unless: ["key"])
        try reject(["--ax-action"], unless: ["perform"])

        if flags.contains("--no-image"), !flags.contains("--refresh") || values["--path"] != nil {
            throw WorkflowArgumentError.invalid("--no-image requires --refresh and cannot use --path")
        }
        if values["--path"] != nil, !flags.contains("--refresh") {
            throw WorkflowArgumentError.invalid("--path requires --refresh")
        }

        if action == "type", let text = values["--text"], text.utf16.count > 256 {
            throw WorkflowArgumentError.invalid("type text exceeds 256 UTF-16 units; use paste for longer text")
        }
    }
}
