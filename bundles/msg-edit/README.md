# dsh-msg-edit

Edit the model's own output in a Session, **in place**.

Clicking the pencil in a reply's action row turns that reply's text into an
editable area drawn exactly over the text it replaces — same position, same
width, same font — with save and cancel beside it. Saving changes both the
transcript and the model context.

The durable log is never rewritten. What changes is the decision the next
request is built from.

## Why it works this way

The Session log is append-only, so an edit cannot be a rewrite. Each edit
appends one `plugin:msg-edit/revise` record carrying the decision, and a message
projection registered by the Host half turns that record into the model-visible
history.

Three findings drove that design, each verified against the shipped Harness
rather than read from documentation:

1. **An `assistant/message` cannot be a surface replacement.** It embeds its
   provider stream and is rejected when it carries `sourceEventSeqs`:
   `assistant/message embeds its source stream and cannot carry sourceEventSeqs`.
   So the compaction-style "shadow a range" trick is unavailable for the exact
   node that needs replacing.

2. **A `system/message` or `developer/message` replacement *can* shadow an
   assistant node**, but it cannot express "rewrite this text", and an empty
   replacement is a new node with its own `turn`/`step` requirements — it fails
   to restore unless the log happens to have that exact turn open.

3. **A message projection can rewrite a message in place.** It receives the
   history preceding the decision and returns the messages that changed, so an
   edit is a first-class projection outcome.

## Why editing is in place

There is no "assistant content" slot to contribute to. The only slot inside a
reply is its action row, and replacing the whole node renderer would take over
tool rows too.

**The action row is not inside the reply's row.** The Chat view renders a
reply's actions in the *Turn footer* — a separate `turn-tail` node — while the
text lives in an `assistant-step` node. An earlier version located the text by
walking up from the clicked button with
`button.closest('[data-chat-node-key]')`; that reaches the footer, which holds no
text, so **every** click reported "cannot be edited". The reply is now resolved
by identity first, then its rendered row by key:

```text
snapshot.order → node.data.finalNode.messageId === messageId   → the reply's node key
document.querySelectorAll('[data-chat-node-key="<key>"]')      → the rendered row
```

**The editor is not a floating box.** A second attempt drew a `position: fixed`
overlay measured against the viewport. It was not the message body, and it could
land off screen. The editor is now mounted *in the document flow*: a sibling
inserted directly after the row, with the row taken out of layout via
`display: none`. Because the editor is a normal child of the transcript column it
inherits that column's width — there is no measurement to get wrong and no
coordinate that can fall outside the viewport.

```text
row.parentElement.insertBefore(editor, row.nextSibling)
row.style.display = 'none'          → restored on cancel, save, and unload
```

The typography is copied from the row with `getComputedStyle`, so the editable
text looks like the text it replaces rather than like a form field. The editor is
plain DOM, not a React subtree: mounting it inside a React-managed list would
fight reconciliation, and a portal into the row would put a second editable
surface inside the node the Chat view owns.

**The body is `contenteditable`, not a `textarea`.** A textarea has no intrinsic
height: it must be measured and pinned with `scrollHeight`, and any mistake —
reading the height before layout, or clipping the overflow — leaves only the last
few lines visible. A third attempt did exactly that. A contenteditable block
grows with its content by itself, so the whole reply is always on screen and
there is no height formula left to get wrong. The draft is kept as literal text
(`textContent`, never Markdown re-interpretation), line breaks survive through
`white-space: pre-wrap`, and paste inserts the plain-text form.

Two other details matter:

- **The source text comes from the Chat snapshot, not the DOM.** The DOM holds
  rendered Markdown — syntax stripped, links rewritten — so comparing it against
  the source would fail for any formatted reply, and saving it back would turn
  formatting into literal characters.
- **The area is borderless and grows with its content**, so the whole reply stays
  visible while it is being edited.

## Addressing

Decisions name `messageId`, not a log position:

- it is what the browser has — the action row is handed exactly that;
- it survives a fork and a compaction, where a seq does not.

## Why there is exactly one editor

The two halves live in slots of **different scopes**, and that decides the shape
of the controller:

| Slot | Scope | `inject` receives |
|---|---|---|
| `conversation.chat.assistant-actions` | `session` | the Session id |
| `shell.overlay` | `root` | nothing |

An earlier version kept a `Map<sessionId, controller>` and resolved both slots
through it. The action row got its Session id, but the overlay — being
root-scoped — called `inject()` with no argument, so it keyed the map on
`undefined` and built a **second** controller. The button wrote to one store and
the editor rendered another, so a click did nothing at all.

The fix is not a lookup change: one editor can be open at a time, so a second
draft is unreachable state by construction. There is now **one** editor for the
frame, and the Session id travels with the click (`open({ sessionId, ... })`)
instead of with the registration.

## What an edit may change

Only `text` blocks are replaced; every other block keeps its position. Dropping
a `tool-call` block would orphan its result and the provider would reject the
next request, so an edit is scoped to the prose a human can see. A message with
no text block is not editable for the same reason.

## Known limitations

- **Interrupted messages cannot be edited.** A prefix the user stopped is still
  model output, but rewriting it would misrepresent what the model sent.
- **Only model output.** User messages are not targets; `/rewind` already owns
  withdrawing a human prompt and refilling the composer.
- **A later compaction wins.** If a compaction shadows an edited message, the
  record becomes inert. That is deliberate: a decision about history the model
  no longer sees must never make the Session unreadable.
- **The client needs a rebuild to see a change made elsewhere.** The overlay
  reads decisions on mount and after its own writes; a second tab's edit appears
  on the next rebuild, not immediately.
- **Trajectory and waterfall views are unaffected** — they read the durable
  events, which still hold the original text.
- **The original is always recoverable.** Disabling the plugin restores the
  original text everywhere, because nothing was rewritten.
- **The editor is positioned once, when it opens.** Scrolling or resizing while
  editing leaves it where it was; cancel and reopen to re-measure.

## Layout

| File | Role |
|---|---|
| `index.js` | Host half: the message projection, decision folding, and the `/api/session.message` route |
| `client.js` | Browser half: the pencil, the in-place editable area, and the transcript overlay |
| `cordis.patch.yml` | The one profile row this bundle contributes |
| `locale/*.json` | Metadata titles for the plugin list |
| `verify/` | The suites below |

## Verification

Run from this directory.

```sh
node --check index.js && node --check client.js

# The projection contract against the REAL session store: edit, supersession,
# tool-call preservation, physical round-trip, the "plugin uninstalled" case,
# the "unknown target" case, and that a delete record is rejected. 14 checks.
node --import ./verify/register-hook.mjs verify/projection.mjs

# The client half's static contract: loader envelope, dictionary parity, every
# requested label defined, the overlay's derive logic, that the editor is in flow
# rather than floating, and that no trace of deletion remains. 59 checks.
node verify/client.mjs

# The two halves wired together with a stub loader and a stub context: does
# apply() throw, does the pencil carry its Session, is an editor inserted beside
# the row, does the row leave the layout, does cancelling restore it, and does a
# second open leave exactly one editor. 21 checks.
node verify/repro.mjs

# The in-place editor's DOM logic, extracted from the shipped bundle and run
# against a structure faithful to what the Chat view renders — including the
# separate footer row that broke the first version, the floating overlay that
# broke the second, and the measured textarea that broke the third. 39 checks.
node verify/inline.mjs

# The route against the RUNNING server, using the same signed browser-session
# cookie the browser holds. 11 checks.
node verify/route.mjs

# A real edit through the running server, folded back to prove the model context
# changed, then reverted with its records removed. 15 checks.
node --import ./verify/register-hook.mjs verify/end-to-end.mjs

# The served client chunk equals the local file. Needs the running server.
node verify/client-graph.mjs
```

`verify/register-hook.mjs` exists because the DSH loader resolves a bundle's
bare `@deepseek-ai/*` imports through the profile's peer-dependency layer, which
plain `node` has no part in. It redirects exactly the declared peers onto the
installed Harness, so the suites exercise the real packages.

### What each suite proves

- **projection.mjs** — an edit keeps the message identity and rewrites only the
  prose; a second edit supersedes the first; a tool call survives and its result
  is untouched; a physical round-trip preserves the decision; a log with records
  still restores when the plugin is absent; an unknown target is inert; a delete
  record is refused.
- **client.mjs** — the loader envelope and slot ids; all eight dictionaries have
  identical key sets; every label the code requests exists; the overlay rewrites
  an edited row's text, leaves a tool-only row alone, and preserves the tool
  call; the editor is a fixed-position layer that matches typography and hides
  the element it covers; nothing about deletion remains in either half.
- **repro.mjs** — the bundle loads and exports an API; `apply()` does not throw;
  the action row is the only slot registered; the pencil carries its Session and
  can reach the Chat snapshot; a click inserts an editor beside the row and takes
  the row out of layout; the draft starts from the source text; the editor has no
  `position` and no viewport offset; cancelling restores the row and removes the
  editor; opening twice leaves exactly one editor; an unaddressable reply reports
  instead of opening. It also asserts the loader produced an API, because a
  loader that never ran would make every later assertion pass vacuously.
- **inline.mjs** — the first regression: walking up from the pencil reaches the
  Turn footer, which is not the row holding the text. The second: the editor is
  in document flow, so it has no position and no viewport rect, and it is
  inserted as a sibling with the row removed from layout and restored afterwards.
  Then the real logic: the reply resolves to its `assistant-step` node by identity
  and yields the raw Markdown; an unknown message, a tool-only message, and a
  missing binding resolve to nothing; the rendered row resolves by node key,
  tolerating a quote in the key and preferring a laid-out duplicate. It also
  guards against a false pass: if the bundle's module constants were not bound,
  every lookup would return nothing and the "resolves to nothing" checks would
  pass vacuously, so one check asserts the resolver is not vacuous.
- **route.mjs** — authorized GET returns `revision`/`edited` and no `deleted`;
  a missing session, a missing message id, a missing text, an unknown message,
  oversized text, and a non-JSON body each return their documented status.
- **end-to-end.mjs** — a real edit is accepted, read back, and folded into
  derived history; the identity survives; the durable log still holds the
  original; without the projection the original returns; the probe records are
  removed and the log still restores strictly.
- **client-graph.mjs** — the running Host serves this bundle's client chunk
  byte-for-byte, with only its own source-map reference appended.
