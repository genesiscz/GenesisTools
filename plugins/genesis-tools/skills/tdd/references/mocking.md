# Mocking — test doubles that don't lie

**When to read: the moment a test needs its first mock, fake, stub, or spy (the SKILL.md gate sent you here).** Mocks are a means to isolate, never the thing being tested. Each anti-pattern below has shipped real broken tests; run its gate before the mock goes in.

## The boundary rule

Mock at **system boundaries** only:

- External APIs (payment, email, third-party HTTP)
- Databases — sometimes; prefer a real test DB
- Time and randomness
- Filesystem — sometimes

Never mock your own classes, modules, or internal collaborators. A test that mocks internals is coupled to implementation: it breaks on refactor while behavior is unchanged, and keeps passing while real integration is broken.

```typescript
// ❌ Mocks an internal collaborator and asserts on the plumbing
const mockPayment = mock(paymentService);
await checkout(cart, payment);
expect(mockPayment.process).toHaveBeenCalledWith(cart.total);

// ✅ Observable behavior through the public interface
const result = await checkout(cart, paymentMethod);
expect(result.status).toBe("confirmed");
```

## Design for mockability at the boundary

**Dependency injection** — pass external dependencies in; never construct them inside:

```typescript
// ✅ Easy to mock — the client arrives from outside
function processPayment(order: Order, paymentClient: PaymentClient) {
    return paymentClient.charge(order.total);
}

// ❌ Hard to mock — constructs its own client from env
function processPayment(order: Order) {
    const client = new StripeClient(env.STRIPE_KEY);
    return client.charge(order.total);
}
```

**SDK-style interfaces over generic fetchers** — one function per external operation, so each mock returns one specific shape, no conditional logic leaks into test setup, and each endpoint is typed:

```typescript
// ✅ Each function independently mockable
const api = {
    getUser: (id: string) => fetch(`/users/${id}`),
    getOrders: (userId: string) => fetch(`/users/${userId}/orders`),
    createOrder: (data: OrderInput) => fetch("/orders", { method: "POST", body: JSON.stringify(data) }),
};

// ❌ One generic fetcher — every mock needs conditional logic on the endpoint
const api = { fetch: (endpoint: string, options?: RequestInit) => fetch(endpoint, options) };
```

**Make doubles specific.** When arguments, call counts, or ordering are part of the boundary contract, assert them — a fake that accepts anything verifies nothing. Give each branch (success, error, malformed) its own fixture, so the wrong branch cannot satisfy the expectation.

## Anti-pattern 1: testing mock behavior

```typescript
// ❌ Verifies the mock exists, not that the component works
render(<Page />);
expect(screen.getByTestId("sidebar-mock")).toBeInTheDocument();

// ✅ Test the real component's behavior
render(<Page />);
expect(screen.getByRole("navigation")).toBeInTheDocument();
```

The mock earns no assertions: a mock assertion passes when the mock is present and fails when it is absent — it says nothing about the component.

**Gate — before asserting on anything mocked:**

```
Am I testing real behavior or just mock existence?
  Mock existence → delete the assertion, or unmock the component and test it for real.
```

## Anti-pattern 2: test-only methods in production

```typescript
// ❌ destroy() exists only for test cleanup, but reads like production API
class Session {
    async destroy() { await this.workspaceManager?.destroyWorkspace(this.id); }
}

// ✅ Cleanup lives in test utilities
export async function cleanupSession(session: Session) {
    const workspace = session.getWorkspaceInfo();
    if (workspace) { await workspaceManager.destroyWorkspace(workspace.id); }
}
```

A test-only method pollutes the production class, is dangerous if production ever calls it, and confuses object lifecycle with entity lifecycle.

**Gate — before adding any method to a production class:**

```
Is this only called from tests?          → don't add it; put it in test utilities.
Does this class own this resource's
lifecycle?                               → no → wrong class for the method anyway.
```

## Anti-pattern 3: mocking without understanding side effects

```typescript
// ❌ The mocked method had a side effect the test depends on (writing config)
vi.mock("ToolCatalog", () => ({ discoverAndCacheTools: vi.fn().mockResolvedValue(undefined) }));
await addServer(config);
await addServer(config); // should throw "duplicate" — but the config write never happened

// ✅ Mock one level lower: the slow part, keeping the behavior the test needs real
vi.mock("MCPServerManager"); // only the slow server startup
```

Mocking a method without knowing its side effects silently removes behavior the test depends on; the test then passes for the wrong reason or fails mysteriously.

**Gate — before mocking any method:**

```
1. What side effects does the real method have?
2. Does this test depend on any of them?
3. Unsure → run the test against the real implementation FIRST and observe.
Depends on a side effect → mock the slow/external level BELOW it, not the method itself.
Red flags: "I'll mock this to be safe", "this might be slow, better mock it".
```

## Anti-pattern 4: incomplete mocks

```typescript
// ❌ Partial mock — only the fields this test happens to read
const mockResponse = {
    status: "success",
    data: { userId: "123", name: "Alice" },
    // missing: metadata that downstream code reads → breaks at integration
};

// ✅ Mirror the real response completely
const mockResponse = {
    status: "success",
    data: { userId: "123", name: "Alice" },
    metadata: { requestId: "req-789", timestamp: 1234567890 },
};
```

Partial mocks hide structural assumptions and fail silently when downstream code reads an omitted field: the test passes while integration breaks.

**Gate — before creating a mock response:**

```
What does the REAL response contain? (docs, a captured example, the response DTO)
Include every field the system might consume downstream; when uncertain, include all documented fields.
Never invent fields — the mock mirrors reality, not your test's needs.
```

## When mock setup outgrows the test

Warning signs: mock setup longer than the test logic, mocks missing methods the real components have, the test breaking when the mock changes, or you cannot explain why the mock is needed. At that point stop patching the mock — switch to an integration test with real components; it is usually simpler and proves more.

## Quick reference

| When you... | Do |
|---|---|
| Reach for a mock | Confirm the dependency is a system boundary; internals stay real |
| Need a boundary easy to fake | Inject the dependency; SDK-style function per operation |
| Want to assert on a mocked element | Test the real component, or delete the assertion |
| Need cleanup only tests use | Test utilities, never a production method |
| Are about to mock a method | List its side effects; mock the slow/external level below them |
| Build a mock response | Mirror the complete real structure, all documented fields |
| Watch mock setup balloon | Switch to an integration test with real components |
