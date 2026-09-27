# Parasocial design system

Source of truth for how the UI looks and behaves. PLAN.md §8 ("Visual system") sets the direction; this file
records the decisions that implement it and the rules for anyone adding UI. The live reference is `/design`
(`bun run dev`, then http://localhost:5391/design).

Target feel: Figma UI3 / Framer. Calm, precise, dense but never barren.

## Layout of the package

```
src/app.html                     pre-paint theme script (no flash)
src/app.css                      tailwind + Inter + tokens + base
src/lib/styles/tokens.css        every token, light + dark, Tailwind @theme mapping
src/lib/styles/tokens.ts         same values for Three.js / workers (selection, part palette, motion)
src/lib/styles/base.css          element defaults, utilities: field, focus-ring, nest/nest-inner, animate-pop
src/lib/theme.svelte.ts          theme controller (light | dark | system, persisted) + portal-target context
src/lib/components/ui/*          components, shadcn-svelte layout (folder + index.ts), bits-ui primitives
src/routes/+layout.svelte        app shell: CSS, theme start, Tooltip.Provider, Toaster, icon defaults
src/routes/design/*              the showcase (not shipped UI)
scripts/screens.ts               Playwright screenshots of /design → design-screens/
```

## Tokens

### Colour

- **Neutrals + one accent.** Surfaces are a slightly cool grey ramp; the only chromatic UI colour is the blue
  accent (`--accent`, light `#1273eb`, dark `#2f7ff0`). Status colours (ok / warning / error) are for status
  only.
- **Orange is selection.** `--selection-preselect`, `--selection-selected-stroke`, `--selection-selected-fill`.
  Nothing else may be orange: not warnings (those are amber-yellow, hue ~45°), not part colours, not avatars.
  The selection label pill is orange because it belongs to the selection.
- **List selection is neutral** (`bg-active`), so the parts list never competes with orange 3D selection.
- **Overrides** use `--override` (the accent's text tone) for the value and the dot.
- **Agents** are not a hue. They're graphite squircles (`--agent`) with a sparkle glyph; a working agent gets
  a slow accent sweep around the avatar. Human avatars are round with pale identity tints (`avatarTints`).
- **Borders are translucent** (`rgb(16 16 24 / .065–.2)` light, `rgb(255 255 255 / .06–.16)` dark). Opaque
  greys vanished on elevated dark surfaces (the command palette divider disappeared in round 4); translucent
  lines work on every layer.

Surface ladder (each step up is lighter in dark mode; that is where dark-mode depth comes from):

| token | light | dark | use |
|---|---|---|---|
| `bg-app` | `#ececee` | `#0e0e10` | behind everything |
| `bg-canvas` | `#f3f3f5` | `#141416` | 3D viewport backdrop |
| `bg-panel` | `#ffffff` | `#1b1b1e` | side panels, top bar |
| `bg-input` | `#f3f3f5` | `#26262a` | filled fields, segmented track |
| `bg-control` | `#ffffff` | `#34343a` | secondary buttons, segmented thumb |
| `bg-elevated` | `#ffffff` | `#252529` | toolbar, menus, popovers, dialogs |
| `bg-hover` / `bg-active` | 4.5% / 8% black | 5.5% / 9% white | overlays for states |
| `bg-tooltip` | `#1c1c1f` | `#3a3a40` | tooltips and toasts (always dark) |

Dark elevated surfaces also get a 1px inner top highlight plus a black and faint white ring (`--elev-*`),
so floating things read as lifted rather than as lighter grey mush.

### Part palette (`partColors` in tokens.ts, `--part-*` in CSS)

Graphite, Sage, Iris, Straw, Teal, Rose, Chalk, Pine, Plum, Moss, assigned round-robin via `partColorAt(i)`.
They're mid-value and low-to-moderate chroma so shading, AO, black edges and orange selection all read on top.
Excluded hue bands: orange (≈15–40°) and the accent blue (≈200–225°). Iris (≈240°) is the nearest to the
accent and is visibly violet next to it. Each colour has a `light` and a slightly deeper `dark` variant to avoid
glare on the dark canvas.

### Typography

Inter Variable, self-hosted through `@fontsource-variable/inter` (the woff2 files are bundled by Vite and
served from our origin, so it's COEP-safe). The scale is compact:

| class | size/line | use |
|---|---|---|
| `text-caption` | 10/14 | kbd chips, tiny meta |
| `text-label` | 11/16 | field labels (secondary grey), meta, badges |
| `text-ui` | 12/16 | **default**: controls, menus, list rows, values |
| `text-body` | 13/20 | reading text: notes, descriptions |
| `text-title` | 15/20 | dialog titles, empty states |
| `text-heading` / `text-display` | 20/28, 28/34 | /design and marketing-ish pages only |

Weights: 400 values/body, 500 controls/tabs/menus, 600 section titles. Every `input`, `output` and
`[role=spinbutton]` gets tabular numerals from base.css; use the `tabular` utility on any other number.
Tailwind's default palette, type scale, radii and shadows are removed (`--*: initial`), so only tokens exist.

### Spacing, sizes, radii

- 4px grid (Tailwind's `--spacing` = 4px). Controls 28px (`h-7`), small 24px, large 32px. List rows 32px.
  Panel section title rows 40px, 16px side padding. Top bar 44px.
- Radii: `sm 4 · control 6 · md 8 · popover 10 · panel 12 · dialog 14 · full`.
- **Concentric nesting: inner = outer − padding.** Encoded as paired vars and used by components:

  | container | radius | padding | item radius |
  |---|---|---|---|
  | floating toolbar | 12 | 4 | 8 (`--toolbar-item-radius`) |
  | menus / popovers | 10 | 4 | 6 (`--popover-item-radius`) |
  | segmented control | 6 | 2 | 4 (`--segment-item-radius`) |
  | viewport control cluster | 10 | 2 | 8 |
  | switch | 8 | 2 | 6 (a circle) |

  For ad-hoc nesting use `class="nest" style="--r:12px;--p:4px"` on the container and `nest-inner` on the
  child, or `innerRadius(outer, pad)` from tokens.ts.

### Elevation, focus, motion

- Shadows: `shadow-xs`, `shadow-control` (hairline + 1px drop, secondary buttons), `shadow-thumb`,
  `shadow-toolbar`, `shadow-popover`, `shadow-dialog`. Values swap per theme.
- Focus: buttons and icon buttons use `focus-ring` (2px surface gap + accent ring, `:focus-visible` only).
  Fields use the accent hairline of the `field` utility instead. List rows use an inset accent hairline.
- Motion: `--duration-fast 150`, `--duration-base 200`, `--duration-slow 250` (plus `--duration-instant 80`
  for hover colour changes, which shouldn't feel animated). Easings: `ease-out` (0.22,1,0.36,1),
  `ease-spring` (0.34,1.4,0.64,1) for thumbs and toggles, `ease-in-out` for indeterminate progress.
  `prefers-reduced-motion` zeroes the durations globally; JS animation must check `prefersReducedMotion()`.

### Theme

`app.html` resolves the stored preference (`localStorage['parasocial:theme']`: light | dark | missing = system)
before first paint and sets `data-theme` on `<html>`. `theme.svelte.ts` takes over after hydration, tracks the
OS setting and persists changes. Any subtree can force a theme with `data-theme`. Because tooltips, menus
and dialogs portal out of their subtree, a forced-theme scope must also provide a portal target
(`setPortalTarget`). Every floating component reads `usePortalTarget()`; the /design panes use this.

## Usage rules

1. **Only tokens.** No raw hex in components. If a colour is missing, add a token in both themes. (Documented
   exceptions: the always-dark tooltip/toast surface uses the `inverse-*` tokens; human-avatar initials are a
   fixed dark grey because the tints are always pale.)
2. **Icons**: `@lucide/svelte` at 16px, stroke 1.5, set once via `setLucideProps` in the layout. Use 12–14px
   only inside 20px chips or for chevrons in fields.
3. **Heights**: 28px for anything interactive in panels, 32px for list rows and toolbar tools. Don't invent
   in-between sizes.
4. **Labels** are 11px secondary grey; values are 12px primary. Units and evaluated results are tertiary and
   sit at the right edge of the field.
5. **Every interactive element needs an accessible name.** IconButton requires `label`, which also becomes
   its tooltip; `shortcut` adds the key hint.
6. **Tooltips**: use `<Tooltip label shortcut>` or `IconButton`'s built-in one. One shared provider sits in the
   layout (500 ms first delay, instant while moving between triggers). When a tooltip wraps another bits-ui
   trigger, merge props as `mergeProps(tooltipProps, triggerProps)`. The component's own props must win,
   or the tooltip's `data-state="closed"` hides toggle and open states (bug found in round 2).
7. **Errors stay calm**: a dot or small badge in lists, the quiet `StatusPill` in the viewport, never a banner.
8. **Selection colour is sacred.** If you're reaching for orange, you're either rendering selection or making
   a mistake.
9. **Never barren**: empty panels get an `EmptyState` with one line, one action and the shortcut.

## Component notes

- **NumberField** (`number-field/`): drag the leading label or icon to scrub (Shift ×10, Alt ×0.1, 2px per
  step, 3px dead zone so a click focuses the field). ↑/↓ step with the same modifiers. Enter commits and
  re-selects, Escape reverts, blur commits (invalid input is discarded, as in Figma), ⌘⌫ resets an override.
  `evaluate` is pluggable (`Evaluator = (text) => {ok, value, expression?} | {ok:false, error}`); the default
  `createEvaluator({scope, units, baseUnit})` is a small safe parser handling `=width/2`, arithmetic,
  functions, and units such as `1/4 in` and `1in + 2mm`. A trailing lone unit scales the whole expression.
  Expressions are shown as typed at rest, with the evaluated value quietly on the right. Overridden = value
  differs from `defaultValue` (or `overridden` is forced): accent value, and a ↺ reset that appears on
  hover or focus (always-visible reset icons were noisy on a column of params). The dot lives on the row
  label (`PropertyRow overridden`). Bounds errors show inline under the field with the bound
  ("Max 10 mm"). `oninput` fires live (drive latest-wins regen from it); `oncommit` fires at gesture end.
- **ListRow**: status dot and trailing content share one right-hand cell with the hover actions, so the dot
  never floats mid-row and swaps cleanly for actions on hover. Hidden parts keep the eye-off visible.
  The leading cell is a fixed 16px so swatches and file icons share a text column.
- **Menus** are data-driven (`MenuEntry[]`); DropdownMenu and ContextMenu share `MenuEntries`. Highlight
  is the accent fill, as in Figma.
- **CommandPalette** binds ⌘K itself (`hotkey`); `inline` renders it without the modal, for docs.
- **Toasts**: `toast('…')`, `toast.success/error/loading`, max 3, bottom-centre above the toolbar.
- **Viewport chrome** (`viewport/`): FloatingToolbar (V/C/P/M, optional global hotkeys that ignore typing,
  per-tool disabled reasons), SelectionLabel, StatusPill, ViewportControls, and a static ViewCube
  placeholder. The real cube and triad belong to the viewer package.

## Testing

`bun run test` runs Vitest (`bun --bun vitest run`): evaluator unit tests plus NumberField component tests
(step and modifiers, clamping, inline bounds errors, the expression hook, override/reset, ⌘⌫, Escape).
**jsdom 30 does not work under Bun** (vitest's worker fails in `EventTarget.addEventListener`), so the
environment is **happy-dom**, which works. Components that use tooltips must render inside
`src/lib/test/harness.svelte`, which provides the layout's `Tooltip.Provider`.

`bun run check` runs svelte-check. `bun run screens` (with the dev server on :5391) regenerates
`design-screens/`. It uses the cached Playwright Chromium revision 1228 through `playwright@1.61.1`, which
is pinned for that reason.

## Build notes

- Adapter: `svelte-adapter-bun`, which works (`bun --bun vite build` → `build/`).
- Dev and preview send `COOP: same-origin` and `COEP: require-corp`, so anything that breaks under
  cross-origin isolation shows up in development. All assets (fonts included) are same-origin.
- Weight: runtime deps are bits-ui, @lucide/svelte (tree-shaken per icon), tailwind-merge, tailwind-variants,
  clsx, svelte-toolbelt (already a bits-ui dependency) and the Inter woff2 files. There's no toast, command or
  animation library.

## Critique log (/design, 1440×900 @2×)

**Round 1.** The first render was structurally right but had several bugs and weak spots.
- The split view loaded scrolled halfway down: bits Command scrolls its first item into view on mount.
  Fixed with `disableInitialScroll`.
- A tooltip forced open for the docs never showed. It's replaced with static renders built from the shared
  `tooltipClass`.
- Agent avatars used lucide's Sparkle, which reads as a "+" at 20–24px, and the black squircles were heavy in
  light mode. Replaced with a custom concave four-point sparkle on a graphite gradient squircle.
- ListRow status dots floated mid-row because the invisible hover actions still took up width.
- The workspace model was cropped and oversized. The selected face looked brown: 32% orange over grey
  is mud, so the selected fill is now 50% at a brighter hue.
- The view-cube labels were unreadable.
- The fillet expression was clipped. Right panel widened to 272px, and the input now uses ellipsis.
- The destructive menu item wasn't red (a class order conflict; use `cn`). The panel swatch was invisible
  on the panel.

**Round 2.**
- Toggle, ToggleGroup and tool pressed states didn't render. Cause: `mergeProps(triggerProps, tooltipProps)`
  let the tooltip's `data-state` win. The merge order is reversed everywhere and recorded as rule 6.
- The dark segmented thumb (`#2c2c31` on `#26262a`) was invisible, so dark `bg-control` rose to `#34343a`.
- The sticky header overlapped element screenshots.
- The always-visible ↺ on every overridden param made the Params column noisy. It now appears on hover/focus,
  and the trailing unit slides left to make room.
- Status pill messages in monospace read as a log dump. They're sans now; only the source link stays mono.

**Round 3.**
- Swatch labels truncated ("accent-h…"). Groups are now full-width rows of 8, labels wrap, and alpha values
  print as `#hex n%`.
- In the Scripts list, file icons and swatches put names in different columns. Fixed with a fixed 16px leading
  cell.
- The workspace left panel was empty below four parts ("barren"). Added an Activity block with agent presence.
  The right panel got a "3 overrides in M4 · Reset all" footer.

**Round 4.**
- Dividers disappeared on dark elevated surfaces: the command palette's search/list border was `#242428` on
  `#252529`. All border tokens are now translucent.
- The side labels on the placeholder cube were still noise at 64px, so only TOP remains.
- The Activity text truncated, so it wraps now.

**Round 5 (final screens).** Holds up next to the references on density (28/32px rhythm, 11/12px type),
alignment (shared text columns, right-edge units) and depth (dark ladder plus highlights). Remaining nits are
under Known gaps.

## Known gaps

- The workspace preview is a composition check with a static SVG model. The viewer, the real view cube and
  the Properties/Notes tab contents aren't built.
- NumberField scrubbing uses pointer capture, not pointer lock, so a long drag stops at the screen edge
  (Figma wraps the cursor). The evaluator has no dimension checking (`2 mm * 3 mm` is accepted).
- The ToggleGroup/SegmentedControl thumb animates by index; with items of unequal width it would need
  measuring (every current use has equal widths).
- The DropdownMenu checkbox entries in ViewportControls act as radios for display mode. That's semantically
  a `RadioGroup`; switch it when the menu model grows radio support.
- Only Latin glyph subsets of Inter load by default (fontsource splits by unicode-range, so other scripts
  load on demand).
- Clay empty-state art is an SVG placeholder until the engine renders real AVIF/WebP clay shots.
