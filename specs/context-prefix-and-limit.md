# Context Prefix Stability & Hard Limit (V1 1.19.5 fork)

Status: draft for implementation on branch `custom-v1195`.
Scope: `packages/opencode`, V1 session path only.

## Goal

Guarantee two host properties without breaking existing V1 plugins:

1. **Stable prefix**: once a request has been sent, its system prefix, tool definitions, and historical messages are never mutated. Only new tail content may be appended. This preserves provider prompt-cache hits.
2. **Hard context ceiling**: no provider request may exceed `model.limit.context` due to our own message/system/tool assembly. Compaction is the only boundary that may replace history, and its own request must fit too.

## Non-goals

- No V2 session-core redesign.
- No change to provider-specific tokenizers; estimates are intentionally conservative.
- No new mandatory plugin API. Existing V1 hooks remain valid.

## Current V1 violations

- `packages/opencode/src/session/prompt.ts:1338` calls `compaction.prune` after every turn.
- `packages/opencode/src/session/compaction.ts:273-317` mutates historical tool parts (`state.time.compacted`, output cleared).
- `packages/opencode/src/session/prompt.ts:1255` gives plugins mutable access to the whole `msgs` array; no guard against rewriting old messages.
- `packages/opencode/src/session/llm/request.ts:68-77` lets a plugin edit `system[0]` in place.
- `packages/opencode/src/session/compaction.ts:319-380` serializes selected history into one prompt without a final hard-ceiling fit.

## Design

### 1. Prefix definition

For each session request, the prefix is:

- serialized `system` blocks in order,
- sorted tool definition names/descriptions/schemas,
- all messages existing before the current turn's newly appended tail.

`prefix_hash = sha256(JSON.stringify({system, tools, prefix_messages}))`.

The host records the hash per session and request kind. It does not persist it; it is a runtime guard.

### 2. Host-enforced immutability around plugin hooks

Before `experimental.chat.messages.transform`:

- deep-clone (structuredClone) the existing messages and system;
- pass mutable copies to the plugin.

After the hook:

- compare every pre-existing message by id and serialized content;
- if changed, restore the original and log `[prefix] rollback sid=... message=...`;
- allow new messages appended after the snapshot (tail-only).

For `experimental.chat.system.transform`:

- snapshot `system` before the hook;
- after the hook, require the original blocks to remain byte-identical and in order;
- accept only appended blocks; otherwise restore the snapshot and log `[prefix] system rollback`.

### 3. Tail-only dynamic channel

Add an optional host API for plugins:

```ts
experimental.chat.context.append?: (input, output: { messages: ... }) => void
```

or equivalent internal helper. opencode-goal moves TODO/audit nails here. The existing transform remains for compatibility and is guarded by section 2; old plugins that only append keep working.

### 4. Remove per-turn prune

Delete the `compaction.prune` call at `prompt.ts:1338`.

Pruning of old tool output becomes allowed only at a compaction boundary, because compaction is already replacing the prefix. `compaction.prune` may still be called from the compaction path.

### 5. Compaction hard fit

In `compaction.process`:

- after `select` and plugin transforms, build `nextPrompt`;
- estimate `tokens = Token.estimate(JSON.stringify(request messages + system + tools))`;
- `ceiling = model.limit.input ? model.limit.input - reserved : model.limit.context - maxOutputTokens(model)`;
- while `tokens > ceiling` and `selected.head` has more than one turn, drop the oldest complete turn and rebuild;
- if still over, return a typed `ContextLimitError` with `{ estimated, ceiling }` instead of calling the provider.

This makes the compaction request itself safe; it also covers the observed `1,048,848 + 40,413 = 1,089,261` case.

### 6. Normal request preflight

In `prompt.ts`, after `MessageV2.toModelMessagesEffect` and tool resolution, estimate the same payload. If over ceiling:

- request one automatic compaction (`compaction.create({auto:true})`) and continue;
- if the loop has already compacted in this turn, return the typed error instead of retrying forever.

Keep the existing `isOverflow` check as the first trigger; the preflight is the last line of defense.

## Compatibility

- Existing V1 plugins still register `experimental.chat.messages.transform` and `system.transform`.
- Only historical mutation is rejected; appending tail messages remains allowed.
- Plugin hooks that intentionally rewrite history (rare) can opt in via a new config flag `experimental.allow_prefix_rewrite` if ever needed, default false.
- opencode-goal needs no immediate rewrite for TODO/audit nails because they append; it should move to the tail channel when convenient.

## Tests

1. **Prefix stability**
   - Send 3 turns with no compaction; assert `prefix_hash` unchanged and serialized prefix bytes identical.
   - Plugin mutates an old message -> host rolls back; hash unchanged; log emitted.
   - Plugin appends a tail message -> hash unchanged; tail present.

2. **System stability**
   - Plugin appends a system block -> accepted.
   - Plugin edits `system[0]` -> rolled back.

3. **No per-turn prune**
   - Two turns with old tool output; assert historical tool part bytes unchanged until compaction.

4. **Hard ceiling**
   - Synthetic `total=1,048,848` + 40,413 prompt: compaction fit drops oldest turns until under ceiling; no provider call if impossible.
   - Normal request at ceiling: one compaction then success; no infinite loop.

5. **Regression**
   - Existing `compaction.test.ts`, `prompt.test.ts`, `message-v2.test.ts`, `llm.test.ts` pass.
   - Plugin transform tests pass.

## Build/verification

- `bun install` in repo root.
- `bun run --cwd packages/opencode typecheck`.
- `bun test` from `packages/opencode` for targeted suites.

## Rollout

- Keep branch `custom-v1195`.
- No upstream merge; upstream remains `origin/v1` for reference.
- Version stays `1.19.5` with a local build tag (e.g. binary name `opencode-custom`).
