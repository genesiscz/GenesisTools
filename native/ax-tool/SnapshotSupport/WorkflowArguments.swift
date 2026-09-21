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
                "--suffix", "--selection", "--format", "--path", "--region", "--target-key", "--dwell",
                "--revalidate-scope", "--frame",
            ]
            flagOptions = ["--background", "--double", "--refresh", "--no-cursor", "--no-image", "--prepare", "--replace", "--hold", "--no-activate"]
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
            guard let action = parsedValues["--action"], ["get", "press", "click", "move", "drag", "set", "perform", "focus", "scroll", "type", "key", "select", "paste", "hover"].contains(action) else {
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
        try reject(["--prepare"], unless: ["press","click","key","type","paste","select","set"])
        // A target key is the row's identity, so it is useful to every action that names a row,
        // not only to the prepared ones. It is what lets a live-updating window stay actionable.
        try reject(["--target-key"], unless: ["press","click","key","type","paste","select","set","perform","hover","move","scroll","get"])
        let revalidateScope = values["--revalidate-scope"] ?? "window"
        guard ["element", "window", "app"].contains(revalidateScope) else {
            throw WorkflowArgumentError.invalid("--revalidate-scope must be element, window or app")
        }
        if let key = values["--target-key"] {
            guard flags.contains("--prepare") || revalidateScope == "element", key.count == 64,
                  key.allSatisfy({ $0.isHexDigit }) else {
                throw WorkflowArgumentError.invalid("--target-key needs --prepare or --revalidate-scope element, plus a native target fingerprint")
            }
        }
        // 🛑 Element scope skips the whole-tree digest, so without an identity to check there would
        // be nothing left guarding the index. Refuse rather than silently act on whatever moved
        // into that position.
        if revalidateScope == "element", values["--target-key"] == nil {
            throw WorkflowArgumentError.invalid("--revalidate-scope element requires --target-key from the row you observed")
        }
        if flags.contains("--prepare"), flags.contains("--background") || values["--coords"] != nil || values["--region"] != nil {
            throw WorkflowArgumentError.invalid("--prepare requires a foreground element action, not coordinates or regions")
        }
        // hover deliberately excluded from --background: the whole point is to move the REAL
        // pointer, and a window-addressed event does not.
        try reject(["--background"], unless: ["click", "move", "drag", "scroll"])
        try reject(["--coords", "--region"], unless: ["click", "move", "drag", "scroll", "hover"])
        try reject(["--frame"], unless: ["click", "move", "drag", "scroll", "hover"])
        if let frame = values["--frame"] {
            guard ["window", "screen"].contains(frame) else {
                throw WorkflowArgumentError.invalid("--frame must be window or screen")
            }

            guard values["--coords"] != nil || values["--to"] != nil else {
                throw WorkflowArgumentError.invalid("--frame describes how --coords is read; supply coordinates")
            }
        }
        try reject(["--dwell", "--hold"], unless: ["hover"])
        try reject(["--no-activate"], unless: ["key", "type", "paste", "select", "set"])
        if flags.contains("--no-activate"), flags.contains("--prepare") {
            throw WorkflowArgumentError.invalid("--no-activate contradicts --prepare, which focuses and raises the target before acting")
        }
        try reject(["--prefix", "--suffix", "--selection", "--range"], unless: ["select"])
        try reject(["--format"], unless: ["paste"])
        try reject(["--replace"], unless: ["paste"])
        if flags.contains("--replace"), !flags.contains("--prepare") {
            throw WorkflowArgumentError.invalid("--replace requires --prepare")
        }
        try reject(["--text"], unless: ["type", "select", "paste"])
        try reject(["--to", "--duration"], unless: ["drag"])
        try reject(["--pages", "--pixels", "--direction"], unless: ["scroll"])
        try reject(["--value"], unless: ["set"])
        try reject(["--keys"], unless: ["key"])
        try reject(["--ax-action"], unless: ["perform"])
        if action == "key" {
            guard let keys = values["--keys"] else { throw WorkflowArgumentError.invalid("key requires --keys") }
            _ = try NativeKeyChord(keys)
        }

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
