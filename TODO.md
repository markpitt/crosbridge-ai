# TODO

## Deferred: native Prompt API tool sessions in the browser

**Status:** blocked on Chrome web Prompt API tool support

The bridge briefly migrated toward browser-native Prompt API tools so the model could call tools through `LanguageModel.create({ tools })` instead of being prompted to emit OpenAI-style JSON. In the current localhost web context, tool-enabled session creation fails with:

- `Tool use feature is not enabled`

Base Prompt API requests still work, so this appears to be a feature-gating issue for native tool use, not a general Prompt API failure.

## Why revisit this later

If Chrome enables Prompt API tool use for normal web pages, this bridge can become much more reliable for tool-calling clients:

- fewer prompt-engineered guard rails
- less context spent describing JSON output contracts
- tool argument validation shifts closer to the browser API
- the same browser-side model session can stay alive across multiple OpenAI tool round trips

## Intended architecture

The target design is a **stateful request block** layered on top of OpenAI-style `chat.completions`.

### Request flow

1. Client sends `POST /v1/chat/completions` with `tools`.
2. Server creates a browser job and forwards the request over WebSocket.
3. Browser creates `LanguageModel.create({ tools })`.
4. Browser-native tool `execute()` handlers do **not** run the real tool locally. Instead, they RPC the tool call back to the server over WebSocket.
5. Server returns OpenAI `tool_calls` to the client.
6. Client executes the tool and sends a follow-up `chat.completions` request containing trailing `tool` messages.
7. Server matches those `tool_call_id`s back to the suspended browser job.
8. Server sends `tool-results` over WebSocket to the browser page.
9. Browser resolves the pending `execute()` promises, allowing the same Prompt API session to continue.
10. The model either requests more tools or produces a final answer.

## Wire protocol

These messages were the basis of the in-progress design and should be reused:

### Server → browser

- `generate`
  - `requestId`
  - `payload.model`
  - `payload.messages`
  - `payload.promptText`
  - `payload.tools`

- `tool-results`
  - `requestId`
  - `results: [{ id, content }]`

### Browser → server

- `browser-ready`
  - `promptApiAvailable`
  - optionally `promptApiAvailability`

- `job-started`
  - `requestId`
  - prompt/context usage metrics

- `job-chunk`
  - `requestId`
  - `delta`

- `job-tool-calls`
  - `requestId`
  - `toolCalls: [{ id, name, arguments }]`

- `job-complete`
  - `requestId`
  - `text`
  - usage/timing metrics

- `job-error`
  - `requestId`
  - `error`
  - optional structured details

## Server changes to reapply

Primary file: `src/server.js`

Rebuild the following pieces:

### 1. Persistent suspended jobs

Add job state so a single browser-side model session can survive multiple HTTP requests:

- `state.toolCallOwners = new Map()` mapping `tool_call_id -> job.id`
- per-job fields:
  - `pendingToolCalls`
  - `awaitingToolResults`
  - step-level promise handlers (`resolveStep`, `rejectStep`)

### 2. Step-based job lifecycle

Instead of a job resolving only once at final text, it must yield intermediate tool-call steps:

- `createJobStep(job)`
- `resolveJobStep(job, value)`
- `yieldToolCalls(job, toolCalls, usage, timings)`
- `clearPendingToolOwnership(job)`

The job result should be able to resolve to either:

- `{ kind: 'tool_calls', toolCalls, usage }`
- `{ kind: 'final', text, usage }`

### 3. Resume logic

When a new OpenAI request arrives in tool mode:

- inspect trailing `tool` messages
- collect their `tool_call_id`s
- map them back through `state.toolCallOwners`
- ensure they all belong to one suspended job
- send `tool-results` to the browser instead of starting a new browser session

Helper shape that worked well conceptually:

- `collectTrailingToolMessages(messages)`
- `findResumableToolJob(messages)`
- `resumeToolJob(job, messages, trailingToolMessages, metadata)`

### 4. WebSocket handlers

Handle a new browser message:

- `job-tool-calls`

Convert those into OpenAI `tool_calls`:

- `id`
- `type: 'function'`
- `function.name`
- `function.arguments` as JSON string

Then suspend the job until matching `tool-results` arrive later.

## Browser changes to reapply

Primary file: `public/app.js`

### 1. Active bridge jobs

Keep browser request state alive while the model waits for tool results:

- `activeBridgeJobs = new Map()`
- per-job:
  - `pendingToolResolvers`
  - `pendingBatch`
  - `flushTimer`

### 2. Browser tool wrappers

Build Prompt API tools dynamically from OpenAI tool schemas:

- `createBrowserTools(socket, bridgeJob, tools)`
- each tool has:
  - `name`
  - `description`
  - `inputSchema`
  - `execute(argumentsObject)`

`execute()` should:

- create a deferred promise
- enqueue `{ id, name, arguments }`
- flush batched calls via `job-tool-calls`
- return the deferred promise

### 3. Tool result resolution

Add:

- `resolveToolResults(payload)`

This should match `payload.results[]` back to deferred tool promises and resolve them with string content.

### 4. Request execution

In `runRequest()`:

- when `payload.tools.length > 0`, pass browser-native tools into `LanguageModel.create({ tools, ... })`
- measure/log availability for tool-enabled sessions separately from plain sessions
- keep the session alive until final completion, not merely until first tool call

## Compatibility and fallback requirements

Before re-enabling this work, add runtime gating:

1. Probe whether native Prompt API tool use is actually available in the current browser context.
2. If not available, automatically fall back to the existing server-side JSON/tool-call compatibility path.
3. Keep the old tolerant parsing path as a fallback until native-tool mode is proven stable.

Do **not** make native browser tools the only path unless:

- tool-enabled `LanguageModel.create()` works reliably on localhost web pages
- resumed sessions survive multiple tool rounds
- Goose-style clients can complete at least simple tool tasks end-to-end

## Testing to restore

Primary file: `test/server.test.js`

Recreate tests for:

- initial request returning OpenAI `tool_calls` from browser-native tools
- follow-up request with trailing `tool` messages resuming the same browser job
- preserving the same `requestId` across the request block
- multiple tool calls in one batch
- timeout/disconnect behavior while a job is suspended awaiting tool results
- fallback to legacy tool parsing when native tool use is unavailable

## Operational note

The hosted dashboard should log:

- requested tool names
- availability results for plain vs tool-enabled sessions
- whether native tool mode or legacy tool mode handled each request

This is the fastest way to distinguish:

- Prompt API base availability problems
- native tool feature-gating problems
- model/tool orchestration bugs
