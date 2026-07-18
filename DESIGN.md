# StrongCode TUI Design System

This is an extraction of the existing terminal UI and the implementation contract for `src/tui/question/surface.ts`. Terminal cells and rows, not CSS pixels, are the unit of measure.

## 1. Atmosphere & Identity

StrongCode is a warm Ember command workspace: dark, compact, calm, and explicit about what needs an operator decision. Its signature is a restrained amber left accent against layered brown-black terminal surfaces. Information is dense but never card-heavy: direct copy, one clear active location, and keyboard help that stays visible.

## 2. Color

### Palette

`TuiConfig.theme` is the desired source of truth for every role. `src/tui/app.ts` currently carries the active hardcoded values below; use the active theme role at render time rather than copying either column into a new surface.

| Role | `TuiConfig.theme` token | Configurable Ember default | Current app value | Use |
| --- | --- | --- | --- | --- |
| Background | `background` | `#0a0a0a` | `#0c0a08` | Terminal root |
| Panel | `panel` | `#141414` | `#171411` | Dialog body |
| Element | `element` | `#1e1e1e` | `#221d19` | Active tab or focused row fill |
| Border | `border` | `#484848` | `#5c4d40` | Left accent, dividers, bounds |
| Primary | `primary` | `#fab283` | `#ffb870` | Active tab, focus, primary action |
| Secondary | `secondary` | `#5c9cf5` | `#77a9ff` | Secondary action and informational link |
| Success | `success` | `#7fd88f` | `#88da99` | Completed or accepted state |
| Warning | `warning` | `#f5a742` | `#f5be66` | Error, caution, unavailable action |
| Text | `text` | `#eeeeee` | `#f2eee6` | Direct question and option labels |
| Muted | `muted` | `#808080` | `#9a9184` | Descriptions, inactive tabs, hints |

### Rules

- Never introduce a color outside these roles. A configured Ember, Mono, or Contrast theme changes the role values, not the dialog vocabulary.
- Color is never the only selection or status signal. Pair it with text and an ASCII marker such as `>`, `[x]`, `[ ]`, `Selected`, `Error`, or `Simplifying`.
- Primary marks the current interaction; it is not decoration. Warning carries error text because the current theme exposes no separate error role.

## 3. Typography

StrongCode uses the terminal's configured monospace face and its native cell width; it does not load or name a separate font. Use terminal emphasis and the existing color roles rather than a font-family or pixel-size scale.

| Level | Terminal treatment | Use |
| --- | --- | --- |
| Chrome title | One row, `text`, compact and clipped | Dialog title and active question header |
| Question copy | One or more rows, `text`, normal terminal weight | Direct question wording |
| Option label | One row, `text`, numbered | Selectable answer |
| Supporting copy | Wrapped indented row(s), `muted` | Option description, privacy text, guidance label |
| Status and hints | One row, `muted`, status role only where meaningful | Loading, errors, keyboard footer |

Copy uses very easy English: common words, short sentences, and concrete action labels. Preserve necessary technical terms exactly. Do not use emoji or icon-only meaning.

## 4. Spacing & Layout

### Terminal scale

| Token | Value | Use |
| --- | --- | --- |
| `cell-1` | 1 column | Left accent, list marker gap, option indentation |
| `cell-2` | 2 columns | Number/marker to label gap; description indent beyond marker |
| `row-1` | 1 row | Adjacent list rows and tab strip |
| `row-2` | 2 rows | Question-to-options and section separation |

The Question Dialog is one `panel` surface with one `border` left accent and, only when needed, one horizontal divider. Option rows, editor, summary, disclosure, and footer remain inside that surface without nested cards.

### Width and text rules

- At 60 columns, use the full available width, compact `Q1`/`Q2` tab labels, one active question region, and a persistent final-row hint. Confirm cannot shrink away. Keep the action row and footer to one row each; the compact footer is exactly `U/D move  L/R tabs  Tab focus  Enter/Spc act  Esc back`. Hide nonessential tab words before hiding controls.
- At 80 columns, show numbered tab labels, direct question copy, numbered options, indented muted descriptions, and the full keyboard footer.
- At 100 columns and wider, center a dialog no wider than 100 columns; retain the same one-column reading order rather than adding a second content column.
- Question copy, descriptions, privacy disclosure, Confirm summary, and custom-answer text wrap on word boundaries within the content width. Wrapped descriptions retain their description indent.
- Tab labels, one-row titles, action labels, and keyboard hints clip with an ellipsis when necessary; never let a rendered line exceed the viewport. Preserve the active marker and action key before truncating prose.
- Keep the final keyboard-hint row visible. If height is short, the main content scrolls while the tab strip and footer remain available.
- Use OpenTUI intrinsic terminal-cell measurement and truncation for every width decision; do not use JavaScript code-unit lengths, which mismeasure wide terminal characters.
- The header remains 3 rows. At 110 columns and wider, the existing 32-column rail is visible. At 109 columns and below, the narrow fallback hides the rail without changing the header, F2 summary overlay, or composer safety.
- All dynamic Summary rows use bounded wrapping and are bounded to the rail or scrollable detail; no row may overflow the terminal viewport.

## 5. Components

### Question Dialog

- **Structure:** title; optional tab strip; active question or Confirm region; permanent privacy disclosure; persistent keyboard footer.
- **Variants:** `compact` for one or two questions, moving through the questions in order; `tabbed` for three through six questions, with one tab per question plus Confirm.
- **States:** default; hover; focus; disabled; loading; success; error. A focused or hovered row gains the active marker and role treatment; disabled actions retain their label with an explicit reason; loading shows `Simplifying...`; success says `Simplified`; validation and simplification errors use `warning` plus plain text. No state relies on color alone.

### Tab Strip

- **Structure:** one horizontal row. The active tab is a `primary` block with its question number; inactive tabs are `muted`. Tabbed mode ends with `Confirm`.
- **Interaction:** Left/Right changes question pages; click selects that page. `Tab`/`Shift+Tab` traverses the current page's focus ring rather than changing pages. The active tab exposes its number and name, not color alone.

### Question and Option Rows

- **Structure:** direct question copy followed by numbered options. Each option is `[ ] 1. Label` or `[x] 1. Label`; its description wraps beneath with a `cell-2` indent in `muted`.
- **Variants:** single selection replaces the prior choice; multiple selection toggles each choice and keeps source option order. The highlight follows up/down navigation and mouse hover. While loading, both mouse and keyboard selection are no-ops.
- **States:** selected, unselected, highlighted, focused, disabled, and error. A selection always has both the bracket marker and an explicit summary on Confirm.

### Custom Answer Editor

- **Structure:** a labeled, wrapping terminal editor below options only when that question allows a custom answer.
- **Interaction:** typing and pasting use the same editor; long text wraps within the existing one-to-six-row composer convention. Editor text keys remain with the editor. Plain text only: rejected newline input uses `warning` plus plain text and restores the last accepted editor value.

### Confirm Region

- **Structure:** one summary row per question, including `Unanswered` or the selected labels/custom answer, followed by an optional Guidance editor.
- **Interaction:** Confirm is disabled until every question has an answer. Guidance exists only in tabbed Confirm and is optional. Submit uses the same result ordering as the original questions.

### Dialog Actions and Disclosure

- **Simplify with DeepSeek:** available from the question region. It sends the visible question headers, questions, options, and descriptions to DeepSeek to make the display easier to read; it does not change local IDs, choices, or submitted source text. Repeated Simplify uses the currently visible question text. During loading it is disabled and reports `Simplifying...`; on success, expose `Show original`; on failure, retain the current display and show the `warning` plain-language error.
- **Show original:** toggles the original and simplified display copy while retaining selections, custom answers, and active context.
- **Privacy disclosure:** always visible near the actions: `Simplify sends the visible questions and options to DeepSeek. Do not enter secrets.` It is not dismissible or hidden by width changes; it wraps when necessary.
- **Cancel:** always available, returns the exact dismissed outcome, and never discards an answer without the explicit Cancel action.

### Completed Reasoning Disclosure

- **Structure:** an optional restrained `panel` container inside a completed assistant message before its final response. The container has one `border` left accent, `cell-1` internal left and right spacing, and `row-1` separation from the final answer. Every disclosure header has its own `assistant-reasoning-disclosure-` ID. The header and expanded content remain inside this container; the final assistant response is a sibling outside it.
- **States:** it is omitted when no completed reasoning exists, collapsed by default when reasoning is present, and expanded as `[-] Reasoning`. Collapsed idle uses `muted` on `panel`; pointer hover uses `text` on `element`; focus or expansion uses `primary` on `panel`. The ASCII marker and label always communicate state without relying on color. The final assistant response remains visible in every state.
- **Interaction:** the header is focusable. Left-click, Enter, and Space toggle it; Enter and Space only act while it has focus. Hover only updates the visual affordance: it never changes focus or toggles. `Ctrl+R` is the configurable default route from the normal active-session textarea: its first use focuses the newest completed reasoning disclosure and repeated use cycles the available headers. It does nothing while no session is active or a modal, help, or summary is open. Escape returns focus to the session textarea. Render completed reasoning only after terminal multiline sanitization.

### Session Summary (Todo 9)

- **Structure:** the existing `SESSION SUMMARY` rail preserves the current Ember panel, border, typography, and 32-column geometry. Generated title and general summary first, followed by tokens, context, spend, `Summary ->`, and source-ordered requested-item/decomposition rows. requested items beneath `Summary ->` retain source order and remain bounded to the rail or scrollable detail.
- **Telemetry:** token values are provider-reported when present. The context percentage uses reported current-context/input tokens divided by the snapshotted configured window; never sum child contexts. Reported spend or an explicitly labeled estimate is shown with its provenance. Missing values render `—`; the UI never invents a zero or an estimate from prompt text.
- **States:** committed Summary data is immutable after later turns and reload. In `failed-open` or cancelled states, generated title, general summary, and requested items are unavailable, while the exact original first prompt remains reachable. Pending or unavailable Summary data never fabricates generated fields.
- **Detail:** clicking Summary or pressing F2 opens the exact first non-empty prompt in the existing scrollable F2 summary overlay. Dynamic display text is terminal control sanitization at render time only; stored original-prompt bytes remain unchanged and prompt-injection text is display data, never UI instruction.

## 6. Motion & Interaction

There is no decorative animation. A short ASCII spinner or status refresh is allowed only while Simplify is in flight; it stops immediately on success, error, or cancellation.

- Left/Right changes question pages. `Tab`/`Shift+Tab` traverses only the current-page focus ring: question pages use `option -> custom when available -> Show original when available -> Simplify -> Next when available -> Submit -> Cancel`; Confirm uses `guidance -> Show original when available -> Simplify -> Submit -> Cancel`.
- Enter or Space activates the focused enabled option or action. Editor text keys remain with the editor. Mouse hover/click performs the corresponding focus/select action when not loading.
- Busy or disabled actions remain visible, cannot activate, and are skipped by traversal; Cancel remains enabled. While loading, mouse and keyboard selection are both no-ops.
- A completed reasoning disclosure has no animation or persistence. Toggling requests a new layout/render while preserving the transcript position; if the transcript was following the latest message, it follows the expanded or collapsed layout after that render.
- Disclosure focus and expansion are independent: focus/blur changes the header between `primary` and `muted` when collapsed, while expanded remains `primary` even after blur. `Ctrl+R` cycles disclosures without toggling them.
- Escape is two-stage: the first Escape leaves the editor or current focused control and returns focus to the page; a second Escape activates Cancel.
- On opening, focus the active question's first selectable option. Remember each question's option highlight and each page's focused control, restoring both when returning to that page. Before opening a dialog, remember the session control focus; restore it when the dialog closes. Resize and simplification refresh must preserve the active tab, selection, custom draft, and focus target whenever that target remains available.
- The footer states the currently valid keys in concise terms. At 60 columns it is exactly `U/D move  L/R tabs  Tab focus  Enter/Spc act  Esc back`.
- Session Summary maintains full keyboard reachability and click parity: F2, the Summary click target, and `/summary` submitted with Enter open the same detail; Escape focus restoration returns to the prior composer or control. The active overlay has a visible selected/focus state.

## 7. Depth & Surface

**Strategy: tonal shift with one border accent.** `background` sits behind `panel`; a focused row or active tab may use `element`. The dialog has one left `border` accent and minimal horizontal division. Do not use shadows, rounded-card simulations, nested boxed rows, or decorative separators. This preserves StrongCode's terminal chrome grammar and leaves the question copy as the focal layer.

Help overlay uses the primary border. Summary overlay uses the secondary border. Todo 9 adds no colors, components, motion, dependencies, or visual drift.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- Personas: a keyboard-only developer, a low-vision or high-contrast terminal user, and a cognitively overloaded developer who needs plain language and predictable choices.
- Every action is keyboard reachable, mouse equivalent, visibly focused, and described by text. Selection, completion, loading, error, and disabled states use text/ASCII indicators as well as the active theme role.
- Respect the active `TuiConfig.theme`, including a configured high-contrast theme. Keep direct copy, stable tab order, a persistent footer, and deterministic focus restoration for low-vision users.
- COGA constraints: one question task at a time, short common-word copy, numbered choices, muted descriptions beneath the related option, no surprise motion, no timed response, and an explicit Cancel path. Confirm summarizes before commitment; Simplify never alters the canonical answer data.
- No new accessibility debt may be accepted without explicit user acknowledgement and an entry below.

### Accepted Debt

| Item | Location | Why accepted | Owner / exit |
| --- | --- | --- | --- |
| Some active palette values are duplicated in `COLORS` instead of fully consuming `TuiConfig.theme`. | `src/tui/app.ts` | Existing extraction only; the values differ from the configurable Ember defaults. | Consolidate rendering on `TuiConfig.theme` before claiming theme-complete UI. |
