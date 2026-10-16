---
name: webview-host-layout
description: Hard layout and interaction constraints when hosting an Electron webview inside a renderer page. Covers the correct fix for OOPIF swallowing pointer events so a drag "loses focus" (a full-viewport overlay plus a blur fallback), that changing the webview's parent chain reloads the page so only the width may change and never the structure, whether a persistent sidebar and a fullscreen panel should be flex siblings or fixed overlays, z-index ordering, that a dynamic width requires container queries rather than viewport breakpoints, that CSS keyframe animations override utility classes, where the prefers-reduced-motion block must be written and its specificity trap, and when several component files should be merged into one. Read when adding interaction around a webview, when adjusting a panel layout/width/open-close/fullscreen that contains a webview, or when merging or splitting browser panel component files.
---

# Layout and Interaction for a webview Host Page

**Core fact: `<webview>` is not an ordinary DOM element; it is a Chromium cross-process OOPIF.**

From the official documentation:

> You can not add keyboard, mouse, and scroll event listeners to `webview`

- For main-process-side constraints (module boundaries, `webRequest`, attribute semantics) see `electron-main-constraints`
- For how to audit React state and dead code see `react-state-and-identity-audit`
- For HLS and streaming downloads see `hls-and-media-download`

---

## 1. Pointer interaction: crossing a webview boundary requires an overlay

### Symptom: dragging the sidebar "loses focus"

The moment the mouse strays a little to the left of the drag handle, the drag dies; move it back and dragging resumes.
It presents as "it loses focus as soon as the movement gets slightly large", making the width nearly impossible to change.

**Three wrong attributions** (all thought of first, all wrong): "lost focus", a stale closure,
or a configuration change swapping `onMouseDown` for a new function.

**The real cause**: `window.addEventListener('mousemove')` **receives no movement once the pointer lands on the webview**.
The handle sits on the sidebar's left edge, so a slight move left puts the mouse over the webview and
`mousemove` no longer bubbles to the host page's `window`.
**The listener is not broken; the event simply never arrives.**

**Fix**: during the drag, cover the viewport with a transparent overlay so the pointer always stays inside the host page.

```tsx
{resizing && <div className="fixed inset-0 z-[60] cursor-col-resize" />}
```

### Companion issue: releasing outside the window leaves the overlay stuck

Dragging outside the window means `mouseup` never arrives -> `resizing` stays set and the overlay never comes off ->
**the entire page becomes unclickable**. A `blur` listener must clean up as well:

```tsx
const onCancel = () => onUp();
window.addEventListener('blur', onCancel);
// remove it in the cleanup too
```

**Criterion**: every pointer interaction that **crosses a webview boundary** needs an overlay —
drag-to-resize, marquee selection, drag and drop, hover previews. Do not count on "the mouse probably will not leave".
**The overlay must also have a fallback removal path**, otherwise one anomaly locks the whole interface.

---

## 2. The webview's parent chain must not change

The moment React unmounts and remounts a `<webview>`, the page **reloads once** —
login state, scroll position, SPA route and playback progress are all lost.

| Scenario | Correct | Wrong |
|---|---|---|
| Sidebar open/close | change only the container **width**, not the DOM structure | wrap the webview in a conditionally rendered container |
| Tab switching | keep all of them mounted, toggle visibility with `invisible` / `z-0` | `{active && <webview/>}` |

**Corollary**: the sidebar must be a **sibling** of the webview container, never a wrapper around it.
If wrapped, then when the sidebar collapses that layer's width or existence changes and React may rebuild the subtree.

> **Layout may change; the tree structure must not.**

**Same family**: if collapsing the sidebar **unmounts** the content (an early `return`),
the conversation scroll position and the input draft are lost. To preserve state, keep the content mounted and hide it with `hidden` only.

---

## 3. Two ways to position a panel container

| Need | Positioning | Why |
|---|---|---|
| Persistent sidebar (open/close squeezes the content) | flex sibling + `style={{ width }}` | a width change only squeezes the left column; the webview's parent chain does not move |
| Fullscreen / overlay | `fixed inset-0` | the parent container is only as tall as that panel row and cannot fill the viewport |

**Reference z-index ordering**:

```
floating ball z-[70]   <- globally highest, must not be covered by any panel
drag overlay  z-[60]
fullscreen panel z-40
webview container z-10
```

### Whether fullscreen should be opaque: is it a "comparison tool"?

The Agent fullscreen uses translucency plus background blur rather than a solid fill, for this reason:
the user goes fullscreen to view a large image or read a long text, and **still needs to see the page underneath** to judge whether the Agent changed it correctly.
A solid background turns it back into an isolated black box — exactly what moving it out of the floating ball into the browser panel was meant to avoid.

**Criterion**: if the purpose of fullscreen includes "comparing against what is behind it", do not make it opaque.

### The collapsed and fullscreen flags must not leak into each other

Collapsing the sidebar **must clear the fullscreen flag too**, otherwise the next expand suddenly fills the screen.

```tsx
onClick={() => persist({ ...prefs, open: false, fullscreen: false })}
```

---

## 4. Dynamic width uses container queries, not viewport breakpoints

The sidebar width is draggable (typically 320-720). Using `sm:` / `lg:` is **the wrong measure**:

> In a 1440px window, a sidebar dragged to 320 has only 320px available,
> yet `lg:` (1024px) judges it "wide" and forces two inputs side by side.

```css
.aside-panel { container-type: inline-size; container-name: asidepanel; }
.field-grid  { display: grid; grid-template-columns: 1fr; gap: 0.625rem; }

@container asidepanel (min-width: 460px) {
    .field-grid { grid-template-columns: 1fr 1fr; }
    .field-wide { grid-column: 1 / -1; }
}
```

**Whenever a container's width is not determined by the viewport, use a container query.**
The same pitfall is easily hit twice in one project (the player's bottom bar has available width = viewport - sidebar width, which is the same class).

Note: a global `index.css` is usually **unlayered** CSS, while Tailwind v4's utilities live in `@layer utilities`.
By the cascade-layer rules, unlayered styles **beat any layered style unconditionally** —
so a container query must **never write a "restore the default" value** (such as `display: revert`),
because that would knock out the element's Tailwind `flex` / `inline-flex` as well.
Write only the `display: none` needed when narrowing; when the query does not match, the element naturally keeps its own class.

---

## 5. CSS animations override utility classes (the same "unlayered" root cause)

**Silent failure**: the floating ball's breathing glow declared `opacity-45 group-hover:opacity-85`,
yet hover **never took effect**. The reason: the keyframes also tweened `opacity`.

```css
/* bad: keyframes carry opacity */
@keyframes orb-breath {
    0%, 100% { transform: scale(1);    opacity: 0.55; }
    50%      { transform: scale(1.15); opacity: 0.95; }
}
```

**CSS animations take precedence over normal declarations.** From the CSS Animations spec:

> CSS Animations affect computed property values. This effect happens by adding a
> specified value to the CSS cascade (at the level for CSS Animations) ...
> **animations override all normal rules, but are overridden by !important rules.**

So `opacity` inside the keyframes beats `group-hover:opacity-85` unconditionally
(unless you add `!important` — but that is fighting the cascade; better to write the keyframes cleanly).

**Fix**: the keyframes tween **one** property only; leave the rest to utility classes.

```css
@keyframes orb-breath {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.15); }
}
/* on the element: opacity-45 transition-opacity group-hover:opacity-85  <- now it works */
```

### An infinite decorative animation must be switchable off

| Pitfall | Symptom | Fix |
|---|---|---|
| keyframes tween `opacity` | hover opacity changes do nothing | keep only `transform` in the keyframes |
| an infinite decorative animation | the interface is always moving; annoying when left open a long time | make it **finite** (`animation: ... 3`), or add `prefers-reduced-motion` |

**The `prefers-reduced-motion` override block must come after the animation declarations.**
When selector specificity is equal, **the later one wins**; if that block sits above them in the file,
it overrides rules defined later -> **equivalent to not having written it**.

```css
.animate-orb-sonar { animation: orb-sonar 2.4s ... infinite; }

/* must be below: written above, the rules above override it right back */
@media (prefers-reduced-motion: reduce) {
    .animate-orb-sonar, .animate-orb-breath, .animate-orb-badge { animation: none; }
}
```

> One clue: if the `prefers-reduced-motion` block lists **only entrance animations** like `animate-in` / `animate-fade-in`
> while the project also has looping animations, it is almost certainly missing them —
> **the looping animations are precisely the ones that most need turning off.**

### Specificity trap: write the selector too short and the whole block is empty

If the block writes only `.animate-in { animation: none; }` while the animation name actually hangs on
`.animate-in.fade-in` (specificity 0,2,0), then bare `.animate-in` (0,1,0) **cannot override it at all**, and not one rule in the block takes effect.

**Rule**: before writing an override block, look at **which selector the animation name is actually declared on**,
copy that selector verbatim (using a compound selector if needed), and do not assume from the name.

Same family: **Tailwind's `animate-ping` / `animate-bounce` live in `@layer utilities`**,
so an unlayered override block can beat them; but **list the concrete class names one by one** rather than hoping for one wildcard rule.

**Whether it should be turned off**: state-carrying ones like `animate-pulse` / `animate-spin`
(loading, LIVE) are **deliberately kept** — turning them off hides information.
Turn off only the purely decorative looping animations.

---

## 6. When to merge several component files into one

**The criterion is whether the lifecycles are coupled, not the line count.** Merging is justified if any one holds:

| Criterion | Example |
|---|---|
| They share an invisible external resource (a webview / the same hook instance) | the Agent panel + the browser panel |
| They share one lifecycle or keep-alive policy | the sniffer + magnet + settings floating panels |

**The first**: the Agent can only work through the webview (executing scripts, injecting rules, reading the page URL),
and the webview's `dom-ready` broadcast, rule injection and automatic script execution all hang off the same browser hook.
**Split into two directories, one side changes the interface and the other does not know, with no compile-time warning whatsoever.**

**The second**: those three floating panels are governed by **the same `visited` set** —
once opened they stay in memory, and switching pages or closing the ball only hides them with `hidden`, preserving input, scroll and loaded lists as they were.
**Split into several files, changing that policy once requires touching several places at once, and missing one means "switch a page and the search conditions are gone".**

**The reverse criterion**: if two pieces of content **each have their own persistence and mounting policy**,
they should not be merged even when displayed side by side in the same panel.
"Put related things together" is not "put everything together".

### The order of operations for merging

1. **Read every file to be merged first** (do not read and write alternately)
2. Write one new file, **keeping the export names unchanged** (zero changes at call sites)
3. Delete the old files
4. **Update the source paths hard-coded in tests** — such paths are outside compile-time checking

> After merging, places in the static self-check suite that read source paths need updating; the assertion contents do not.
> **The symptom of forgetting is a test reporting "file not found", not a compile error.**

### A file and a directory of the same name cannot coexist

When `components/Panel.tsx` and `components/Panel/` both exist, module resolution is ambiguous.
**So a merge must delete the old directory entirely**; it cannot be kept as a backup.

### "Implicit contracts" to re-check after merging

A merge is pure relocation, but what relocation most easily loses is **unwritten convention**. Check each:

- [ ] **Line endings**: is the new file LF or CRLF? Were the files in the old directory consistent? (see `safe-source-file-editing`)
- [ ] **Export surface**: did the old `index.tsx` end with re-exports like `export { X } from './X'`?
      If so, **confirm zero references before deleting them**
- [ ] **Module-level constants**: after moving a `const X = [...]` from an old file into the new one,
      does it collide by name or duplicate the meaning of an existing constant?
- [ ] **`useMemo`'d element arrays**: if after merging several panels are rendered by one parent component,
      the element array must be memoized, otherwise the parent re-rendering every frame drags all child panels with it
      (see `react-state-and-identity-audit` pattern G)

---

## Self-check list

- [ ] Is there any drag / overlay interaction path swallowed by the webview? Does it need an overlay? Does the overlay have a fallback removal?
- [ ] Did the webview's parent chain change (did you only change width / visibility)?
- [ ] Is content unmounted on collapse / expand (losing conversation scroll position and input draft)?
- [ ] Do the collapsed and fullscreen flags leak into each other?
- [ ] Does the dynamic width use a container query or a viewport breakpoint?
- [ ] Did the container query write a "restore the default" value (which unlayered rules would use to knock out utility classes)?
- [ ] Do the keyframes tween only one property? Is the `prefers-reduced-motion` block after the animation declarations?
- [ ] Is the override block's selector specificity sufficient (did you write it too short so the whole block idles)?
- [ ] After merging / renaming, did you update the source paths hard-coded in tests?
