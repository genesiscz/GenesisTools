// The oracle bridge: runs the upstream Go coordinator (unreal-agent, pinned in ../../UPSTREAM.md)
// with every dependency served by the TypeScript test fakes over stdio, so the port's twin tests
// can run against the original implementation.
//
// Protocol: one JSON object per line, both directions.
//
//	TS → Go   {"op":"run","id":1,"params":{"SessionID":..,"Restored":..,"ToolHeartbeatMs":0}}
//	          {"op":"input","params":{"Input":..}}          submit to the Go inbox
//	          {"op":"inboxClose"}                            cancel the inbox context
//	          {"op":"operationUpdate","params":{"Operation":..}}
//	          {"op":"updatesClose"}
//	          {"op":"cancel"}                                cancel the run context
//	          {"id":n,"op":"internals"}                      white-box snapshot of the loop state
//	          {"id":n,"op":"setCurrentTurnType","params":{"Type":..}} | {"id":n,"op":"setCallModel","params":{"Value":..}}
//	          {"op":"replaceInbox","params":{"Reason":..}}   swap dependencies.Inbox (heartbeat_test)
//	          {"id":n,"result":..} | {"id":n,"error":{"Message":..,"Kind":..,"Ref":..}}   reply to a Go call
//	Go → TS   {"id":n,"call":"store.items","params":{..}}   and the other callbacks listed in
//	          go-coordinator.ts; {"call":"cancelCall","params":{"ID":n}} when a pending call's
//	          context ended (the TS side aborts that fake's signal).
//	          {"id":n,"result":..}                           the answer to a TS op that carried an id
//	          {"id":1,"result":<final internals>} | {"id":1,"error":..,"result":..}   the run's outcome
//
// Errors carry a Kind so sentinels survive the boundary: "unsupported" is
// operation.ErrUnsupported, "canceled" is context.Canceled. Ref is the TS error object a fake
// threw; it rides inside Go's error chain (refError) and comes back on the run error, so the
// twin's `errorIs(run.done.error, want)` still finds the object it threw.
package main

import (
	"bufio"
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"sort"
	"sync"
	"time"
	"unsafe"

	"github.com/unreallabsai/unreal-agent/harness/contextbuilder"
	"github.com/unreallabsai/unreal-agent/harness/coordinator"
	"github.com/unreallabsai/unreal-agent/harness/inbox"
	"github.com/unreallabsai/unreal-agent/harness/llm"
	"github.com/unreallabsai/unreal-agent/harness/operation"
	"github.com/unreallabsai/unreal-agent/harness/session"
	"github.com/unreallabsai/unreal-agent/harness/sessionstore"
	"github.com/unreallabsai/unreal-agent/harness/tool"
)

// bridgeError crosses the pipe in both directions. Ref names the TypeScript error object a fake
// threw, so the run error Go hands back can be re-linked to it (errors.Is on the TS side).
type bridgeError struct {
	Message string
	Kind    string `json:",omitzero"`
	Ref     int64  `json:",omitzero"`
}

// refError is a fake's error inside Go: its message, plus the TS reference it came with.
type refError struct {
	message string
	ref     int64
}

func (e *refError) Error() string { return e.message }

type message struct {
	ID     *int64         `json:"id,omitzero"`
	Op     string         `json:"op,omitzero"`
	Call   string         `json:"call,omitzero"`
	Params jsontext.Value `json:"params,omitzero"`
	Result jsontext.Value `json:"result,omitzero"`
	Error  *bridgeError   `json:"error,omitzero"`
}

type reply struct {
	result jsontext.Value
	err    *bridgeError
}

type bridge struct {
	out     *bufio.Writer
	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[int64]chan reply
	nextID    int64

	inputs      *inbox.Inbox
	inboxCancel context.CancelFunc
	updates     chan operation.Operation
	updatesOnce sync.Once
	runCancel   context.CancelFunc

	current            coordinator.Coordinator
	lastGrace          uintptr
	graceGeneration    int
	replacementCancels []context.CancelCauseFunc
}

func newBridge(out io.Writer) *bridge {
	return &bridge{out: bufio.NewWriter(out), pending: map[int64]chan reply{}}
}

func (b *bridge) send(msg message) {
	encoded, err := json.Marshal(msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "bridge: encode message: %v\n", err)
		return
	}
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	// bufio reports a failed write on Flush; stdout going away means the TS side is gone.
	_, _ = b.out.Write(encoded)
	_ = b.out.WriteByte('\n')
	if err := b.out.Flush(); err != nil {
		fmt.Fprintf(os.Stderr, "bridge: write message: %v\n", err)
	}
}

func toBridgeError(err error) *bridgeError {
	if err == nil {
		return nil
	}
	encoded := &bridgeError{Message: err.Error()}
	var ref *refError
	if errors.As(err, &ref) {
		encoded.Ref = ref.ref
	}
	switch {
	case errors.Is(err, operation.ErrUnsupported):
		encoded.Kind = "unsupported"
	case errors.Is(err, context.Canceled):
		encoded.Kind = "canceled"
	case errors.Is(err, context.DeadlineExceeded):
		encoded.Kind = "deadline"
	}
	return encoded
}

func fromBridgeError(err *bridgeError) error {
	if err == nil {
		return nil
	}
	base := &refError{message: err.Message, ref: err.Ref}
	switch err.Kind {
	case "unsupported":
		return fmt.Errorf("%w: %w", base, operation.ErrUnsupported)
	case "canceled":
		return fmt.Errorf("%w: %w", base, context.Canceled)
	}
	return base
}

// call asks the TypeScript side to run a fake and waits for its answer. When ctx ends first, the
// TS side is told to abort that fake (cancelCall) and ctx.Err() is returned, like a Go fake that
// honours its context.
func (b *bridge) call(ctx context.Context, name string, params any, out any) error {
	encoded, err := json.Marshal(params)
	if err != nil {
		return fmt.Errorf("encode %s params: %w", name, err)
	}
	done := make(chan reply, 1)
	b.pendingMu.Lock()
	b.nextID++
	id := b.nextID
	b.pending[id] = done
	b.pendingMu.Unlock()

	b.send(message{ID: &id, Call: name, Params: encoded})

	select {
	case answer := <-done:
		if answer.err != nil {
			return fromBridgeError(answer.err)
		}
		if out != nil && len(answer.result) > 0 && string(answer.result) != "null" {
			if err := json.Unmarshal(answer.result, out); err != nil {
				return fmt.Errorf("decode %s result: %w", name, err)
			}
		}
		return nil
	case <-ctx.Done():
		b.pendingMu.Lock()
		delete(b.pending, id)
		b.pendingMu.Unlock()
		cancelParams, _ := json.Marshal(map[string]int64{"ID": id})
		b.send(message{Call: "cancelCall", Params: cancelParams})
		return ctx.Err()
	}
}

func (b *bridge) deliver(id int64, answer reply) {
	b.pendingMu.Lock()
	done, ok := b.pending[id]
	if ok {
		delete(b.pending, id)
	}
	b.pendingMu.Unlock()
	if ok {
		done <- answer
	}
}

// ─────────────────────────────── dependency proxies ───────────────────────────────

type storeProxy struct{ b *bridge }

func (s *storeProxy) AddObserver(sessionstore.Observer) sessionstore.ObserverID {
	return sessionstore.ObserverID{}
}
func (s *storeProxy) RemoveObserver(sessionstore.ObserverID) {}
func (s *storeProxy) Create(context.Context, session.ID) (sessionstore.Snapshot, error) {
	return sessionstore.Snapshot{}, errors.New("bridge store: Create is not proxied")
}
func (s *storeProxy) ListSessions(context.Context) ([]sessionstore.SessionInfo, error) {
	return nil, errors.New("bridge store: ListSessions is not proxied")
}
func (s *storeProxy) Inspect(context.Context, session.ID) (sessionstore.Snapshot, error) {
	return sessionstore.Snapshot{}, errors.New("bridge store: Inspect is not proxied")
}
func (s *storeProxy) Items(ctx context.Context, id session.ID, after sessionstore.Sequence, limit int) (sessionstore.Page, error) {
	var page sessionstore.Page
	err := s.b.call(ctx, "store.items", map[string]any{"SessionID": id, "After": after, "Limit": limit}, &page)
	return page, err
}
func (s *storeProxy) AppendInput(ctx context.Context, id session.ID, input inbox.Input) error {
	return s.b.call(ctx, "store.appendInput", map[string]any{"SessionID": id, "Input": input}, nil)
}
func (s *storeProxy) AppendTurn(ctx context.Context, id session.ID, turn session.Turn) error {
	return s.b.call(ctx, "store.appendTurn", map[string]any{"SessionID": id, "Turn": turn}, nil)
}
func (s *storeProxy) AppendModelResponse(ctx context.Context, id session.ID, response sessionstore.ModelResponse) error {
	return s.b.call(ctx, "store.appendModelResponse", map[string]any{"SessionID": id, "Response": response}, nil)
}
func (s *storeProxy) AppendToolCallStatus(ctx context.Context, id session.ID, status sessionstore.ToolCallStatus) error {
	return s.b.call(ctx, "store.appendToolCallStatus", map[string]any{"SessionID": id, "Status": status}, nil)
}
func (s *storeProxy) SaveOperation(ctx context.Context, id session.ID, value operation.Operation) error {
	return s.b.call(ctx, "store.saveOperation", map[string]any{"SessionID": id, "Operation": value}, nil)
}
func (s *storeProxy) Resume(ctx context.Context, id session.ID) (sessionstore.ResumeState, error) {
	var state sessionstore.ResumeState
	err := s.b.call(ctx, "store.resume", map[string]any{"SessionID": id}, &state)
	return state, err
}
func (s *storeProxy) Fork(ctx context.Context, child session.ID, parent session.ID, previousTurn session.TurnID) (sessionstore.Snapshot, error) {
	var snapshot sessionstore.Snapshot
	err := s.b.call(ctx, "store.fork", map[string]any{"ChildID": child, "ParentID": parent, "PreviousTurnID": previousTurn}, &snapshot)
	return snapshot, err
}

type adapterProxy struct{ b *bridge }

func (a *adapterProxy) Respond(ctx context.Context, request llm.Request, options llm.RequestOptions) (llm.Response, error) {
	var response llm.Response
	err := a.b.call(ctx, "llm.respond", map[string]any{"Request": request, "Options": options}, &response)
	return response, err
}

type managerProxy struct{ b *bridge }

func (m *managerProxy) Add(value operation.Operation) error {
	return m.b.call(context.Background(), "operations.add", map[string]any{"Operation": value}, nil)
}
func (m *managerProxy) Cancel(id operation.ID, reason string) error {
	return m.b.call(context.Background(), "operations.cancel", map[string]any{"ID": id, "Reason": reason}, nil)
}
func (m *managerProxy) Updates() <-chan operation.Operation { return m.b.updates }

type builderProxy struct{ b *bridge }

func (c *builderProxy) AddExternalInput(input inbox.Input) error {
	return c.b.call(context.Background(), "builder.addExternalInput", map[string]any{"Input": input}, nil)
}
func (c *builderProxy) AddControlMessage(request inbox.ControlMessage) {
	_ = c.b.call(context.Background(), "builder.addControlMessage", map[string]any{"Request": request}, nil)
}
func (c *builderProxy) SetModel(model llm.Model) {
	_ = c.b.call(context.Background(), "builder.setModel", map[string]any{"Model": model}, nil)
}
func (c *builderProxy) SetSystemPrompt(prompt string) {
	_ = c.b.call(context.Background(), "builder.setSystemPrompt", map[string]any{"Prompt": prompt}, nil)
}
func (c *builderProxy) AddModelResponse(response llm.Response) {
	_ = c.b.call(context.Background(), "builder.addModelResponse", map[string]any{"Response": response}, nil)
}
func (c *builderProxy) AddReasoning(reasoning llm.Reasoning) {
	_ = c.b.call(context.Background(), "builder.addReasoning", map[string]any{"Reasoning": reasoning}, nil)
}
func (c *builderProxy) AddTool(value llm.Tool) {
	_ = c.b.call(context.Background(), "builder.addTool", map[string]any{"Tool": value}, nil)
}
func (c *builderProxy) AddToolResult(callID string, payload []llm.ToolResultOutput, running bool) {
	_ = c.b.call(context.Background(), "builder.addToolResult", map[string]any{"CallID": callID, "Payload": payload, "Running": running}, nil)
}
func (c *builderProxy) Commit() {
	_ = c.b.call(context.Background(), "builder.commit", map[string]any{}, nil)
}
func (c *builderProxy) Build() (contextbuilder.Result, error) {
	var result contextbuilder.Result
	err := c.b.call(context.Background(), "builder.build", map[string]any{}, &result)
	return result, err
}

type registryProxy struct{ b *bridge }

func (r *registryProxy) StaticDefinitions() []tool.Definition {
	var definitions []tool.Definition
	if err := r.b.call(context.Background(), "tools.staticDefinitions", map[string]any{}, &definitions); err != nil {
		fmt.Fprintf(os.Stderr, "bridge: tools.staticDefinitions: %v\n", err)
	}
	return definitions
}
func (r *registryProxy) Resolve(name string) (tool.Translator, bool) {
	var found bool
	if err := r.b.call(context.Background(), "tools.resolve", map[string]any{"Name": name}, &found); err != nil {
		fmt.Fprintf(os.Stderr, "bridge: tools.resolve: %v\n", err)
		return nil, false
	}
	if !found {
		return nil, false
	}
	return &translatorProxy{b: r.b, name: name}, true
}
func (r *registryProxy) RegisterSkill(skill tool.Skill) (tool.RegistrationID, error) {
	var id tool.RegistrationID
	err := r.b.call(context.Background(), "tools.registerSkill", map[string]any{"Skill": skill}, nil)
	return id, err
}
func (r *registryProxy) UnregisterSkill(tool.RegistrationID) {}
func (r *registryProxy) Skills() []tool.Skill {
	var skills []tool.Skill
	if err := r.b.call(context.Background(), "tools.skills", map[string]any{}, &skills); err != nil {
		fmt.Fprintf(os.Stderr, "bridge: tools.skills: %v\n", err)
	}
	return skills
}

// translateResult is what the TS side returns for tools.translate: the status with placeholder
// operation ids ("$1", "$2", …) and the specs submitted in order. The bridge submits each spec to
// the Go tool context, which allocates the real id, and rewrites the placeholders.
type translateResult struct {
	Status       tool.CallStatus
	Specs        []operation.Spec
	Placeholders []string
}

type translatorProxy struct {
	b    *bridge
	name string
}

func (t *translatorProxy) Translate(ctx tool.Context, call llm.ToolCall) tool.CallStatus {
	var result translateResult
	if err := t.b.call(context.Background(), "tools.translate", map[string]any{"Name": t.name, "Call": call}, &result); err != nil {
		return tool.CallStatus{Error: err.Error()}
	}
	ids := map[string]operation.ID{}
	for index, spec := range result.Specs {
		id := ctx.Submit(spec)
		if index < len(result.Placeholders) {
			ids[result.Placeholders[index]] = id
		}
	}
	for index, waiting := range result.Status.WaitingFor {
		if allocated, ok := ids[string(waiting)]; ok {
			result.Status.WaitingFor[index] = allocated
		}
	}
	return result.Status
}

func (t *translatorProxy) TranslateResult(callID string, status tool.CallStatus, operations []operation.Operation) (llm.ToolResult, error) {
	var result llm.ToolResult
	err := t.b.call(context.Background(), "tools.translateResult", map[string]any{
		"Name": t.name, "CallID": callID, "Status": status, "Operations": operations,
	}, &result)
	return result, err
}

// ─────────────────────────────── ops from the TS side ───────────────────────────────

type runParams struct {
	SessionID       session.ID
	Restored        sessionstore.ResumeState
	ToolHeartbeatMs int64
}

func (b *bridge) handleRun(id int64, params jsontext.Value) {
	var run runParams
	if err := json.Unmarshal(params, &run); err != nil {
		b.send(message{ID: &id, Error: &bridgeError{Message: "decode run params: " + err.Error()}})
		return
	}
	inboxCtx, inboxCancel := context.WithCancel(context.Background())
	b.inboxCancel = inboxCancel
	inputs, err := inbox.New(inboxCtx, nil)
	if err != nil {
		b.send(message{ID: &id, Error: toBridgeError(err)})
		return
	}
	b.inputs = inputs
	b.updates = make(chan operation.Operation, 1024)
	runCtx, runCancel := context.WithCancel(context.Background())
	b.runCancel = runCancel

	b.current = coordinator.New(coordinator.Dependencies{
		ToolHeartbeatInterval: time.Duration(run.ToolHeartbeatMs) * time.Millisecond,
		SessionID:             run.SessionID,
		Inbox:                 inputs,
		Restored:              run.Restored,
		Sessions:              &storeProxy{b: b},
		ContextBuilder:        &builderProxy{b: b},
		LLM:                   &adapterProxy{b: b},
		Tools:                 &registryProxy{b: b},
		Operations:            &managerProxy{b: b},
	})
	go func() {
		err := b.current.Run(runCtx)
		// The Go tests read the loop state after Run returned; the reply carries that final state.
		encoded, encodeErr := json.Marshal(b.snapshotInternals())
		if encodeErr != nil {
			fmt.Fprintf(os.Stderr, "bridge: encode final internals: %v\n", encodeErr)
			encoded = nil
		}
		b.send(message{ID: &id, Result: encoded, Error: toBridgeError(err)})
	}()
}

// ─────────────────────────────── white-box internals ───────────────────────────────
//
// The Go tests read the coordinator's private loop state in-package (pendingInputs, stopMode,
// grace, tool calls). The bridge is a separate module, so it reads the same fields through
// reflection, only when the twin asks (after the loop settled), and never through the loop.

type toolCallKeyJSON struct {
	TurnID session.TurnID
	CallID string
}

type toolCallStateJSON struct {
	TurnID     session.TurnID
	CallID     string
	ToolCall   llm.ToolCall
	Status     *tool.CallStatus
	Operations []operation.ID
}

type internalsSnapshot struct {
	CurrentTurnID     session.TurnID
	CurrentTurnType   session.TurnType
	CurrentTurnInputs int
	DeliveredInputs   int
	AvailableInputs   int
	StopMode          *inbox.ControlMode
	ModelActive       bool
	GraceActive       bool
	GraceGeneration   int
	CallModel         bool
	GraceToolCalls    []toolCallKeyJSON
	ToolCalls         []toolCallStateJSON
	Operations        []operation.Operation
}

// privateField makes an unexported field readable and writable. A map key or entry is not
// addressable; it is copied first, so only the copy is read.
func privateField(value reflect.Value, name string) reflect.Value {
	if !value.CanAddr() {
		copied := reflect.New(value.Type()).Elem()
		copied.Set(value)
		value = copied
	}
	field := value.FieldByName(name)
	if !field.IsValid() {
		panic(fmt.Sprintf("coordinator has no field %q at the pinned commit", name))
	}
	return reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem()
}

func (b *bridge) coordinatorValue() reflect.Value {
	return reflect.ValueOf(b.current).Elem()
}

func (b *bridge) snapshotInternals() internalsSnapshot {
	root := b.coordinatorValue()
	state := privateField(root, "state")
	snapshot := internalsSnapshot{
		CurrentTurnID:     session.TurnID(privateField(state, "currentTurnID").String()),
		CurrentTurnType:   session.TurnType(privateField(state, "currentTurnType").String()),
		CurrentTurnInputs: int(privateField(state, "currentTurnInputs").Int()),
		DeliveredInputs:   int(privateField(state, "deliveredInputs").Int()),
		AvailableInputs:   int(privateField(state, "availableInputs").Int()),
		ModelActive:       !privateField(root, "cancelModel").IsNil(),
		CallModel:         privateField(state, "callModel").Bool(),
		GraceToolCalls:    []toolCallKeyJSON{},
		ToolCalls:         []toolCallStateJSON{},
		Operations:        []operation.Operation{},
	}
	if mode := inbox.ControlMode(privateField(privateField(privateField(root, "stop"), "request"), "Mode").String()); mode != "" {
		snapshot.StopMode = &mode
	}
	grace := privateField(state, "grace")
	if !grace.IsNil() {
		snapshot.GraceActive = true
		if grace.Pointer() != b.lastGrace {
			b.lastGrace = grace.Pointer()
			b.graceGeneration++
		}
	}
	snapshot.GraceGeneration = b.graceGeneration
	for _, key := range privateField(state, "graceToolCalls").MapKeys() {
		snapshot.GraceToolCalls = append(snapshot.GraceToolCalls, toolCallKeyJSON{
			TurnID: session.TurnID(privateField(key, "turnID").String()),
			CallID: privateField(key, "callID").String(),
		})
	}
	sort.Slice(snapshot.GraceToolCalls, func(i, j int) bool {
		return snapshot.GraceToolCalls[i].TurnID < snapshot.GraceToolCalls[j].TurnID ||
			(snapshot.GraceToolCalls[i].TurnID == snapshot.GraceToolCalls[j].TurnID &&
				snapshot.GraceToolCalls[i].CallID < snapshot.GraceToolCalls[j].CallID)
	})
	calls := privateField(state, "toolCalls")
	for _, key := range calls.MapKeys() {
		entry := reflect.New(calls.Type().Elem()).Elem()
		entry.Set(calls.MapIndex(key))
		call := toolCallStateJSON{
			TurnID:     session.TurnID(privateField(key, "turnID").String()),
			CallID:     privateField(key, "callID").String(),
			Operations: []operation.ID{},
		}
		toolCall, ok := privateField(entry, "toolCall").Interface().(llm.ToolCall)
		if !ok {
			panic("coordinator toolCallState.toolCall is not llm.ToolCall at the pinned commit")
		}
		call.ToolCall = toolCall
		if status := privateField(entry, "status"); !status.IsNil() {
			value, ok := status.Interface().(*tool.CallStatus)
			if !ok {
				panic("coordinator toolCallState.status is not *tool.CallStatus at the pinned commit")
			}
			call.Status = value
		}
		for _, id := range privateField(entry, "operations").MapKeys() {
			call.Operations = append(call.Operations, operation.ID(id.String()))
		}
		sort.Slice(call.Operations, func(i, j int) bool { return call.Operations[i] < call.Operations[j] })
		snapshot.ToolCalls = append(snapshot.ToolCalls, call)
	}
	sort.Slice(snapshot.ToolCalls, func(i, j int) bool {
		return snapshot.ToolCalls[i].TurnID < snapshot.ToolCalls[j].TurnID ||
			(snapshot.ToolCalls[i].TurnID == snapshot.ToolCalls[j].TurnID &&
				snapshot.ToolCalls[i].CallID < snapshot.ToolCalls[j].CallID)
	})
	operations := privateField(state, "operations")
	for _, id := range operations.MapKeys() {
		value, ok := operations.MapIndex(id).Interface().(operation.Operation)
		if !ok {
			panic("coordinator loopState.operations value is not operation.Operation at the pinned commit")
		}
		snapshot.Operations = append(snapshot.Operations, value)
	}
	sort.Slice(snapshot.Operations, func(i, j int) bool { return snapshot.Operations[i].ID < snapshot.Operations[j].ID })
	return snapshot
}

func (b *bridge) replyResult(id int64, result any) {
	encoded, err := json.Marshal(result)
	if err != nil {
		b.send(message{ID: &id, Error: &bridgeError{Message: "encode result: " + err.Error()}})
		return
	}
	b.send(message{ID: &id, Result: encoded})
}

func (b *bridge) handleOp(msg message) {
	switch msg.Op {
	case "run":
		if msg.ID == nil {
			fmt.Fprintln(os.Stderr, "bridge: run without id")
			return
		}
		b.handleRun(*msg.ID, msg.Params)
	case "input":
		var params struct{ Input inbox.Input }
		if err := json.Unmarshal(msg.Params, &params); err != nil {
			fmt.Fprintf(os.Stderr, "bridge: decode input: %v\n", err)
			return
		}
		if b.inputs == nil {
			return
		}
		if err := b.inputs.Submit(context.Background(), params.Input); err != nil {
			encoded, _ := json.Marshal(map[string]any{"Input": params.Input, "Error": toBridgeError(err)})
			b.send(message{Call: "inputRejected", Params: encoded})
		}
	case "inboxClose":
		if b.inboxCancel != nil {
			b.inboxCancel()
		}
	case "operationUpdate":
		var params struct{ Operation operation.Operation }
		if err := json.Unmarshal(msg.Params, &params); err != nil {
			fmt.Fprintf(os.Stderr, "bridge: decode operation update: %v\n", err)
			return
		}
		if b.updates != nil {
			b.updates <- params.Operation
		}
	case "updatesClose":
		if b.updates != nil {
			b.updatesOnce.Do(func() { close(b.updates) })
		}
	case "cancel":
		if b.runCancel != nil {
			b.runCancel()
		}
	case "internals":
		if msg.ID == nil || b.current == nil {
			return
		}
		b.replyResult(*msg.ID, b.snapshotInternals())
	case "setCurrentTurnType":
		var params struct{ Type session.TurnType }
		if err := json.Unmarshal(msg.Params, &params); err != nil || msg.ID == nil || b.current == nil {
			return
		}
		privateField(privateField(b.coordinatorValue(), "state"), "currentTurnType").SetString(string(params.Type))
		b.replyResult(*msg.ID, nil)
	case "replaceInbox":
		// heartbeat_test swaps dependencies.Inbox for a stopped inbox on the coordinator goroutine;
		// the loop keeps reading the original inbox's output, only Submit sees the new one.
		var params struct{ Reason *bridgeError }
		if err := json.Unmarshal(msg.Params, &params); err != nil || b.current == nil {
			return
		}
		ctx, cancel := context.WithCancelCause(context.Background())
		// A live replacement stays open for the rest of the run; the process exit releases it.
		b.replacementCancels = append(b.replacementCancels, cancel)
		replacement, err := inbox.New(ctx, nil)
		if err != nil {
			cancel(nil)
			fmt.Fprintf(os.Stderr, "bridge: replacement inbox: %v\n", err)
			return
		}
		if params.Reason != nil {
			cancel(fromBridgeError(params.Reason))
		}
		privateField(b.coordinatorValue(), "dependencies").FieldByName("Inbox").Set(reflect.ValueOf(replacement))
	case "setCallModel":
		var params struct{ Value bool }
		if err := json.Unmarshal(msg.Params, &params); err != nil || msg.ID == nil || b.current == nil {
			return
		}
		privateField(privateField(b.coordinatorValue(), "state"), "callModel").SetBool(params.Value)
		b.replyResult(*msg.ID, nil)
	default:
		fmt.Fprintf(os.Stderr, "bridge: unknown op %q\n", msg.Op)
	}
}

func main() {
	b := newBridge(os.Stdout)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 1<<20), 64<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var msg message
		if err := json.Unmarshal(line, &msg); err != nil {
			fmt.Fprintf(os.Stderr, "bridge: decode line: %v\n", err)
			continue
		}
		switch {
		case msg.Op != "":
			// Ops are handled in arrival order: `run` sets up the inbox before any `input` can
			// reach it. None of them blocks for long: the Go inbox drains submissions on its own
			// goroutine, the updates channel is buffered, and `run` only starts a goroutine.
			b.handleOp(msg)
		case msg.ID != nil:
			b.deliver(*msg.ID, reply{result: msg.Result, err: msg.Error})
		}
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		fmt.Fprintf(os.Stderr, "bridge: stdin: %v\n", err)
	}
}
