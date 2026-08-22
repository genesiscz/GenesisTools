# Test Quality — tests that can actually fail

**When to read: before writing any test body (the SKILL.md gate sent you here).** Most worthless tests are not wrong — they are unfalsifiable: they pass no matter what the production code does. Every rule below keeps a test falsifiable.

Two principles govern everything here:

1. **Every test names the break it catches.**
2. **Every test exercises the real thing** (test doubles and their rules live in `mocking.md`).

## Gate: name the break

Before writing the test body, answer: **what production change should make this test fail — and is that change a bug or a decision?** A test earns its place by catching a wrong branch, a missing side effect, a wrong argument, a boundary case, or a broken contract.

```
Cannot name a breaking change          → redesign the test around an observable behavior
"The source text changed"              → run the artifact and assert its effects
Only intentional decisions can fail it → change detector; test the behavior that depends on the decision
Expected value reuses the code's logic → tautology; replace it with a literal or hand-checked fixture
```

## Derive expected values independently

Expected values come from outside the code under test: hand-derived literals, worked examples, the spec. Table-driven tests with literal `want` values are the preferred shape. An expectation computed by the code under test — or its helpers — passes no matter what that code does.

```typescript
// ❌ Mirror assertion: the same builder computes both sides — always true
const expected = buildSearchQuery({ tag: "urgent" });
expect(buildSearchQuery({ tag: "urgent" })).toBe(expected);

// ✅ Hand-derived literal
expect(buildSearchQuery({ tag: "urgent" })).toBe('tag:"urgent"');
```

The tautology also hides as recomputation — the assertion re-implements the algorithm:

```typescript
// ❌ Recomputes the expected value the way the code does — passes by construction
const items = [{ price: 10 }, { price: 5 }];
expect(calculateTotal(items)).toBe(items.reduce((sum, i) => sum + i.price, 0));

// ✅ Independent literal
expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
```

If setup and assertion share the same object, equality is guaranteed before the code under test ever runs.

## Snapshots record, they do not assert

`toMatchSnapshot()` writes whatever the code produced and then passes. On first run it can never fail, so it is a tautology by construction, and the updater flag (`-u`) converts every future failure into a new baseline. Use a snapshot only for large output you have read line by line and committed as reviewed. For anything you can name, assert the specific property instead:

```typescript
// ❌ Records the format, whatever it is
expect(renderReceipt(input)).toMatchSnapshot();

// ✅ Asserts the contract you actually promised
expect(renderReceipt(input)).toBe("book x1 .......... 12.00");
```

Never accept a snapshot you did not read. Never run the updater to make a red test green.

## No change detectors

If only intentional decisions can fail a test — a constant's value, exact message wording, private structure — it fires on every redesign and sleeps through every bug. Test the behavior that depends on the decision:

```typescript
// ❌ Fails only when someone edits the constant on purpose
expect(MAX_RETRIES).toBe(5);

// ✅ The behavior the constant drives
test("a failing call is retried 5 times and the 6th attempt never happens", async () => {
    let attempts = 0;
    await expect(withRetries(() => { attempts++; throw new Error("down"); })).rejects.toThrow();
    expect(attempts).toBe(5);
});
```

## Behavior, not text

Asserting that a script, skill, or config file contains an exact line proves only that the source is the source. Run scripts against controlled inputs and assert outputs, side effects, or exit codes. Prose written for humans earns no test at all.

## Your contract, not the framework

Test the contract your code makes at its boundaries — the route you register, the query you emit, the payload you produce. Upstream mechanics are their maintainers' tests to write (the classic: asserting your router invokes a registered handler — that is the framework's test, not yours). When upstream behavior genuinely surprised you, write one narrow characterization test naming the assumption. The same boundary applies inside your code: constructors, getters, constants, and trivial forwarding earn tests only when they validate, normalize, default, derive, or cause side effects — otherwise assert the first consumer-visible result that depends on them.

## Verify through the interface

Observe behavior through the public interface under test, not through a side channel. A side-channel assertion couples the test to storage details and keeps passing after the interface breaks.

```typescript
// ❌ Bypasses the interface to verify
await createUser({ name: "Alice" });
const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
expect(row).toBeDefined();

// ✅ Verifies through the interface
const user = await createUser({ name: "Alice" });
expect((await getUser(user.id)).name).toBe("Alice");
```

## One behavior per test

One logical assertion per test, and a name that describes the behavior: "rejects empty email", not "test1" or "validation works". An "and" in the name means two tests. Names describe WHAT the code does, never HOW it does it — a HOW name goes stale on the next refactor.

## The mutation check (run when the test file is done)

Mutate the production code mentally; for each realistic mutation, at least one test must fail. A mutation nothing catches marks the behavior as unprotected — or the test as tautological.

| Mutation | Example | The test that catches it |
|---|---|---|
| Wrong constant or argument | retry limit 2 instead of 3 | asserts the observable count, not the constant |
| Inverted or wrong branch | `if (!isValid)` flipped | one test per branch outcome |
| Missing state change or side effect | notification never dispatched | asserts the effect at the boundary |
| Empty or default return | `return []` stub survives | asserts real content, not just shape or length |
| Missing validation | empty email accepted | asserts rejection of zero/empty/nil/unauthorized/malformed input |

## Warning signs

- Setup and assertion share the same object, guaranteeing equality
- The test can fail only through a crash or a missing selector
- The test fails on every intentional change, never on accidental breakage
- Expected values are hidden behind loops, builders, or helpers
- The test greps source text, or asserts a removed symbol stays removed
- The test would still pass with your code deleted and only the framework remaining
- The test exists for coverage and checks no side effect or outcome
- The name contains "works", "correctly", or "and"

## Quick reference

| When you... | Do |
|---|---|
| Write any test | Name the production change that makes it fail — a bug, not a decision |
| Build an expected value | Derive it by hand; never with the code under test or its helpers |
| Test a script or document | Run it and assert effects; never grep its text |
| Reach for `toMatchSnapshot` | Read the output line by line first; prefer a specific assertion |
| Reach for a dependency test | Test your boundary contract, not the framework's mechanics |
| Verify a result | Go through the public interface, not a side channel |
| Name a test | One behavior; WHAT, not HOW |
| Finish the test file | Run the mutation check table above |
