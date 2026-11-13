import Foundation

/// The command line of `genesis-kit-catalog`, read apart from drawing so a test can hold it to its rules: a flag that
/// takes a value refuses to go without one. A trailing `--only` was dropped, so the tool drew the whole catalog and
/// rewrote `manifest.json` and `index.html`, which `--only` promises never to write.
public struct KitCatalogArguments: Equatable, Sendable {
    public var out: String?
    public var only: [String] = []
    public var list = false
    public var probe: String?
    public var help = false

    public enum Failure: Error, Equatable, LocalizedError {
        /// The flag needs a value and the command line ended, or the next word is another flag.
        case missingValue(String)
        case unknown(String)

        public var errorDescription: String? {
            switch self {
            case .missingValue(let flag): return "\(flag) needs a value"
            case .unknown(let flag): return "unknown argument: \(flag)"
            }
        }
    }

    public init(out: String? = nil, only: [String] = [], list: Bool = false, probe: String? = nil, help: Bool = false) {
        self.out = out
        self.only = only
        self.list = list
        self.probe = probe
        self.help = help
    }

    /// The options in `arguments` (without the program's name). `--help` ends the reading.
    public static func parse(_ arguments: [String]) throws -> KitCatalogArguments {
        var parsed = KitCatalogArguments()
        var rest = arguments[...]
        func value(of flag: String) throws -> String {
            guard let next = rest.first, !next.hasPrefix("--") else { throw Failure.missingValue(flag) }
            rest.removeFirst()
            return next
        }
        while let flag = rest.popFirst() {
            switch flag {
            case "--out": parsed.out = try value(of: flag)
            case "--only": parsed.only.append(try value(of: flag))
            case "--list": parsed.list = true
            case "--probe": parsed.probe = try value(of: flag)
            case "--help", "-h":
                parsed.help = true
                return parsed
            default: throw Failure.unknown(flag)
            }
        }
        return parsed
    }
}
