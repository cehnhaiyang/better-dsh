---
name: llm-output-protocol
description: How to design, instruct and defend the in-band output protocol of an LLM chat feature — the literal text the model must emit when the transport is a plain text stream with no tool-calling channel. Covers why "call the foo tool" is inert when no tools array is passed, why the prompt (not the parser) must be fixed first when the model ignores the format, keeping exactly one copy of the format spec, separating "shown to the user" keys from "kept for the model" keys, a single reveal/end token, holding back a half-written token, filtering secrets on every streaming frame instead of at completion, tolerant recognition versus a strict instruction, and why a second hidden request must never be added to route around a prompt that does not bind.
whenToUse: Read when adding a structured-output feature to a chat UI (a sealed answer, a state update, a command, a mode switch), when the model prints something that should have stayed hidden, when the model ignores an agreed output format, or when editing the prompt that defines such a format.
---

# In-Band Output Protocol for an LLM Feature

**Scope.** A chat feature that streams plain text from a model and needs structured data back. Applies whenever the transport has no tool-calling channel and the only channel is the model's own words.

## 1. Establish the channel before writing the instruction

- A plain SSE stream carries `choices[0].delta.content` and `delta.reasoning_content`. It has **no** `tool_calls`, no `function_call`, and no schema binding.
- **Telling such a model to "call the X tool" produces nothing.** The model has no tool to call, so the sentence is inert text; it will simply describe or dump what it was supposed to hand over. The harness never errors, so the failure is silent.
- Ask "does this transport actually expose a tools array?" first. If yes, define a JSON schema and pass it as a real tool. If no, the protocol must be spelled out in the prompt as literal characters the model types, and parsed back out of the text stream.
- Never describe an output format as a "tool call", "function call" or "invocation" in the prompt unless that channel exists. Name it what it is: an output block, a line of JSON, a token.

## 2. A shape that survives plain text

- One **line of JSON with a named wrapper**, so recognition never depends on guessing where the block starts:
  `{"name":{"1":"<shown to the user>","2":"<kept for the model>"}}`
- **Split keys by audience, not by field name.** One key is the thing the user reads; the other is the thing only the model needs to remember. Naming them after their roles (`shown` / `hidden`, `face` / `answer`) keeps the instruction self-explaining.
- **One token for the reveal/end condition** (e.g. an uppercase sentinel). A single token is greppable, unambiguous, and cannot be half-expressed by accident.
- The model's own words are the transport for all three: the block carries what to hide, the token carries when to stop hiding. Nothing else about the state machine belongs in the prompt.

## 3. When the model ignores the protocol, fix the instruction first

**The prompt is the binding force; the parser is a backstop.** A model that violates the format is almost always responding to an instruction that is vague, self-contradicting, or written in a vocabulary the model cannot act on (§1).

Diagnosis order:
1. Is the required output stated as an **exact literal**, byte for byte, including the wrapper key and quoting rules? "Output the answer in a structured way" is not an instruction.
2. Is the format stated **once**? Two copies drift: a skills prompt and a per-turn addendum that each restate the shape will disagree, and the model follows the one it read last. Keep the shape in exactly one place; a per-turn addendum may say only "now produce it".
3. Is the instruction free of sections that do not instruct (see §6)?

**Anti-pattern: routing around the prompt.** If the model prints a secret instead of sealing it, the tempting repairs are all wrong:
- adding a hidden second request whose output is never shown, just to obtain what the visible request failed to produce;
- widening the parser until it recognises every variant;
- adding a "self-check" paragraph that asks the model to re-read its own draft.

Each leaves the root cause (an instruction that does not bind) in place while adding machinery that must now stay consistent forever. Fix the instruction, then keep tolerant parsing only as the safety net it is.

## 4. Filter on every streaming frame, never at completion

Deltas are painted as they arrive. "Let the model write it, then delete it when the response ends" means the user has already read the secret.

- The filter must run on the **accumulated raw text** on every frame and return the displayable text; the same function runs once more at completion on the final text.
- **Hold back a half-written end token.** While `SOUP_EN` is streaming, the user must not see it appear and then vanish. Suppress a trailing prefix of the token — but only down to length 2. Suppressing a **single** trailing letter is wrong: a display string may legitimately end in that letter, and suppressing it silently eats the user's own text.
- **A block that has started but has no closing delimiter is still a secret.** Cut from the block's opening wrapper to the end of the current frame. The value may be half-written (`{"a":"first pa`) — that is exactly the state that leaks.
- Keep the displayed remainder stable: strip the blank lines and trailing whitespace the removal leaves behind, so the layout does not jump between frames.

## 5. Tolerant recognition, strict instruction

These are not in tension; they operate on different sides.

- **The prompt names one exact format.** Ambiguity here is what causes the failure in the first place.
- **The recogniser accepts documented variants**, because the cost of missing one is a leak: accept any fence language, an alternate wrapper spelling, alternative key names, and a dropped outer wrapper. Reject anything that does not carry the payload key, so unrelated user content is never swallowed.
- Recognising "is this the payload?" **by content, not by a marker the model may change**, is the whole point: a model that swaps a fence language must not thereby leak the secret.
- Do not let the recogniser guess destructively: a block it cannot parse should be left in place, not deleted.

**Pin the single owner.** Put the protocol in one module, and add a test assertion that the caller contains no second copy of the recognition regex. Two copies drift, and the drift is the leak.

## 6. Prompt authoring style for this kind of instruction

- **Say what to do and the exact output.** Drop persuasion, rationale, threats ("this step is mandatory"), and self-check rituals. They dilute the instruction and the model weights them as noise.
- **Do not invent sections** (extra "why this matters", "self-audit before replying", "output rules" blocks) around a spec the user supplied. Keep the user's own headings and wording; if they wrote the spec, they chose its structure.
- Keep the tone of the rest of the prompt file. A single voice reads as one instruction; a mix of imperatives and essays reads as several.
- State the *shape* once and reference it elsewhere ("produce the block described above"), never twice.
