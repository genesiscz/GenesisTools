import Foundation
import XCTest
@testable import GenesisTools

final class ShowOnceTests: XCTestCase {
    func testRecipeRoundTripPreservesTargetEvidenceAndRuntimeSecretDeclaration() throws {
        let source = """
        {"version":1,"id":"example","title":"Report","createdAt":"2026-10-06T00:00:00Z","allowedOrigins":["https://example.com"],"parameters":[{"name":"password","label":"Password","secret":true}],"steps":[{"id":"fill","title":"Fill password","enabled":true,"kind":"fill","locator":{"kind":"testId","value":"password","fingerprint":{"tag":"INPUT","role":"textbox","name":"Password"}},"pageUrl":"https://example.com/login","value":"{{password}}","evidence":{"eventId":"explicit-repair","url":"https://example.com/login","at":1,"detail":"User supplied runtime secret reference"}}]}
        """
        let recipe = try JSONDecoder().decode(ShowOnceRecipe.self, from: Data(source.utf8))
        let restored = try JSONDecoder().decode(ShowOnceRecipe.self, from: JSONEncoder().encode(recipe))
        XCTAssertEqual(restored, recipe)
        XCTAssertEqual(restored.steps[0].locator?.fingerprint?.name, "Password")
        XCTAssertNil(restored.parameters[0].defaultValue)
        XCTAssertEqual(restored.steps[0].value, "{{password}}")
    }
    func testNativeDecodeDoesNotInventMissingRequiredRecipeFields() {
        XCTAssertThrowsError(try JSONDecoder().decode(ShowOnceRecipe.self, from: Data("{\"version\":1}".utf8)))
    }
}
