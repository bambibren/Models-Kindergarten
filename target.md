# Models Kindergarten context-summary target.md

> Pair with: `design.md`  
> Target artifact: local React chat-stream edit  
> User goal: remove the Runtime/evaluation link and expose only hidden model context beneath each user turn.

## Target Summary

- Page type: local edit inside the chat workbench
- Primary job: understand what additional context entered the current model turn without leaving the conversation
- First-screen priority: the user message remains primary; context is discoverable but collapsed
- Main object: one ACP prompt turn
- Source provides: visual language and exact placement
- Success: summary uses real Remote context, preserves first-seen order, persists with the turn, and never duplicates the current prompt

## Required Modules

- Remove `Runtime 与评测` from the chat projection.
- Add one `上下文提要` disclosure immediately after the matching user bubble.
- Expanded content contains structured rows for system instruction, available tools, skills, MCP resources, session history, and truncation only when actually present.
- Each row may show title, concise detail, item count, trust state when meaningful, and estimated tokens.

## Data And Protocol Rules

- Remote is the source of truth because it owns context assembly.
- Deliver the summary through one namespaced ACP extension notification.
- Persist the summary as a session fact and replay it during `load`; `resume` remains zero-replay.
- Exclude all `current_turn` prompt content. This boundary also excludes future Mention and attachment content represented by the user bubble.
- Do not reconstruct old summaries after the fact or expose raw system prompt/resource contents.

## Layout Rules

- Frozen: session rail, header, chat width, composer, user bubble, assistant response, Thought/Tool activity rendering.
- Editable: the former per-turn evaluation-link region and the new row directly below the user bubble.
- Expanded panel uses the same warm-neutral palette, a single hairline container, flat rows, and no pure black.

## Interaction Rules

- Default closed; trigger toggles in place without changing message ordering.
- Expanded rows are read-only and do not navigate to another product.
- Long details stay one line with ellipsis and native hover title on desktop.
- On narrow screens, metadata drops below copy and never forces horizontal scroll.

## Anti-Patterns

- No Runtime timeline, evaluation score, external evaluation page entry, raw JSON dump, dark terminal panel, duplicated prompt text, or speculative context.
- No reordering based on completion time.
- No summary for historical turns whose original context snapshot was never recorded.

## Stress Checklist

- 0 optional skills/resources: base instruction and available tools still render correctly.
- Many tools/skills: detail truncates and full value remains discoverable.
- Long Chinese/Mixed English identifiers: no horizontal overflow.
- Truncated history: a distinct explanatory row appears.
- Load: summary returns in the original turn position.
- Resume: no summary replay.
- Invalid extension payload or wrong session: ignored/rejected at the protocol boundary.
- Mobile width: collapsed metadata hides; expanded metadata wraps below copy.

## Validation Checklist

- Unit tests cover protocol parsing, ordering, persistence/load, resume, and current-prompt exclusion.
- Typecheck and production build pass.
- Browser verifies collapsed/open states and a real prompt with `qwen3:8b`.
- Existing tool, permission, AskUser, and message streaming behavior still works.
