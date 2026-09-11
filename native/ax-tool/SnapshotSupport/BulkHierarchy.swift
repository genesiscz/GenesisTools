import ApplicationServices
import Darwin
import Foundation

public enum BulkHierarchyError: Error, LocalizedError {
    case unavailable(String)
    case failed(AXError)
    case missingElement
    case truncated

    public var errorDescription: String? {
        switch self {
        case .unavailable(let message): return message
        case .failed(let error): return "bulk AX hierarchy read failed (\(error.rawValue))"
        case .missingElement: return "bulk AX hierarchy omitted an element"
        case .truncated: return "bulk AX hierarchy truncated a children list"
        }
    }
}

/// The option and result keys `AXUIElementCopyHierarchy` understands. Resolved from the
/// framework's exported globals, never hard-coded, so a renamed key disables the fast path
/// instead of silently changing its meaning.
struct BulkHierarchyKeys {
    let arrayAttributes: String
    let maxArrayCount: String
    let maxDepth: String
    let returnAttributeErrors: String
    let incomplete: String
    let count: String
    let error: String
    let value: String
}

/// Soft-links the private HIServices bulk read: one cross-process round trip returns a whole
/// subtree with a caller-chosen attribute list. Sky reaches the same call through a hashed
/// soft-link table; this is the plain `dlsym` form. Absent symbol means no fast path.
public final class BulkHierarchyReader {
    private typealias CopyHierarchy = @convention(c) (
        AXUIElement, CFArray, CFDictionary?, UnsafeMutablePointer<Unmanaged<CFDictionary>?>
    ) -> AXError
    private let handle: UnsafeMutableRawPointer
    private let copy: CopyHierarchy
    let keys: BulkHierarchyKeys

    public init?() {
        guard let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY) else {
            return nil
        }
        guard let symbol = dlsym(handle, "AXUIElementCopyHierarchy") else {
            dlclose(handle)
            return nil
        }
        func key(_ name: String) -> String? {
            guard let pointer = dlsym(handle, name) else {
                return nil
            }
            return pointer.assumingMemoryBound(to: Unmanaged<CFString>.self).pointee.takeUnretainedValue() as String
        }
        guard let arrayAttributes = key("kAXUIElementCopyHierarchyArrayAttributesKey"),
              let maxArrayCount = key("kAXUIElementCopyHierarchyMaxArrayCountKey"),
              let maxDepth = key("kAXUIElementCopyHierarchyMaxDepthKey"),
              let returnAttributeErrors = key("kAXUIElementCopyHierarchyReturnAttributeErrorsKey"),
              let incomplete = key("kAXUIElementCopyHierarchyIncompleteResultKey"),
              let count = key("kAXUIElementCopyHierarchyResultCountKey"),
              let error = key("kAXUIElementCopyHierarchyResultErrorKey"),
              let value = key("kAXUIElementCopyHierarchyResultValueKey") else {
            dlclose(handle)
            return nil
        }
        self.handle = handle
        self.copy = unsafeBitCast(symbol, to: CopyHierarchy.self)
        self.keys = BulkHierarchyKeys(
            arrayAttributes: arrayAttributes, maxArrayCount: maxArrayCount, maxDepth: maxDepth,
            returnAttributeErrors: returnAttributeErrors, incomplete: incomplete, count: count,
            error: error, value: value
        )
    }

    deinit { dlclose(handle) }

    public func read(root: AXUIElement, attributes: [String], maxDepth: Int, maxArrayCount: Int) throws -> BulkHierarchySource {
        let options: [String: Any] = [
            keys.maxDepth: maxDepth,
            keys.maxArrayCount: maxArrayCount,
            keys.arrayAttributes: [kAXChildrenAttribute as String],
            keys.returnAttributeErrors: true,
        ]
        var result: Unmanaged<CFDictionary>?
        let status = copy(root, attributes as CFArray, options as CFDictionary, &result)
        guard status == .success, let dictionary = result?.takeRetainedValue() else {
            throw BulkHierarchyError.failed(status)
        }
        return BulkHierarchySource(dictionary: dictionary, keys: keys)
    }
}

/// A `HierarchySource` over one bulk result: every attribute of every element in the subtree
/// is already in memory, so only action names and settability still cost a round trip.
public final class BulkHierarchySource: HierarchySource {
    private let dictionary: CFDictionary
    private let keys: BulkHierarchyKeys

    init(dictionary: CFDictionary, keys: BulkHierarchyKeys) {
        self.dictionary = dictionary
        self.keys = keys
    }

    /// The result is keyed by the AX element objects themselves. `CFDictionaryGetValue` honours
    /// the dictionary's own `CFEqual`/`CFHash` callbacks; bridging to `[AnyHashable: Any]` does
    /// not, and every lookup missed.
    private func entry(_ element: AXUIElement) -> [String: Any]? {
        guard let raw = CFDictionaryGetValue(dictionary, Unmanaged.passUnretained(element).toOpaque()) else {
            return nil
        }
        return Unmanaged<CFDictionary>.fromOpaque(raw).takeUnretainedValue() as? [String: Any]
    }

    private func errorCode(_ attribute: [String: Any]) -> AXError? {
        guard let raw = attribute[keys.error] else {
            return nil
        }
        let object = raw as AnyObject
        guard CFGetTypeID(object) == AXValueGetTypeID() else {
            return .failure
        }
        var code = AXError.success
        return AXValueGetValue(object as! AXValue, .axError, &code) ? code : .failure
    }

    public func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        guard let attribute = entry(element)?[name] as? [String: Any] else {
            return nil
        }
        return attribute[keys.value]
    }

    public func children(of element: AXUIElement) throws -> [AXUIElement] {
        guard let entry = entry(element) else {
            throw BulkHierarchyError.missingElement
        }
        guard let attribute = entry[kAXChildrenAttribute as String] as? [String: Any] else {
            return []
        }
        if (attribute[keys.incomplete] as? Bool) == true {
            throw BulkHierarchyError.truncated
        }
        if let code = errorCode(attribute) {
            guard code == .attributeUnsupported || code == .noValue else {
                throw BulkHierarchyError.failed(code)
            }
            return []
        }
        return attribute[keys.value] as? [AXUIElement] ?? []
    }

    public func actionNames(of element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else {
            return []
        }
        return list
    }

    public func isValueSettable(_ element: AXUIElement) -> Bool? {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success else {
            return nil
        }
        return settable.boolValue
    }
}
