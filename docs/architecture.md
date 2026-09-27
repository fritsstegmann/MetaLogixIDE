# Architecture

## Overview

MetaLogix IDE is an Electron desktop app with a main process (`src/main/`),
a preload script (`src/preload/`) and a React renderer (`src/renderer/`). The
renderer calls the main process through the IPC API that the preload script
exposes as `window.api` (`src/renderer/api.ts:4`).

This document is incomplete. At this time it describes only the Markdown
preview pipeline and the window material. The product design is in
`docs/superpowers/specs/2026-07-18-metaide-design.md`.

## Components

### Markdown preview pipeline

The Files tab shows a rendered preview for `.md`, `.markdown` and `.mdx`
files. `FilesTab.tsx` mounts `MarkdownPreview` only when the file is not in
Edit mode (`src/renderer/components/FilesTab.tsx:610`).

| Layer | File | Responsibility |
|---|---|---|
| Presentation | `src/renderer/components/MarkdownPreview.tsx` | Sets the rendered HTML, starts diagram rendering, and routes link clicks. |
| Presentation | `src/renderer/hooks/useDocumentTheme.ts` | Gives the effective light or dark theme. |
| Logic | `src/renderer/markdown/markdownRenderer.ts` | Owns the one `markdown-it` instance. Converts Markdown to an HTML string. |
| Logic | `src/renderer/markdown/fenceRule.ts` | Changes `mermaid` fences into placeholders and `math` fences into display math. |
| Logic | `src/renderer/markdown/math/mathPlugin.ts` | `markdown-it` plugin for the math delimiters. |
| Logic | `src/renderer/markdown/math/renderMath.ts` | Calls KaTeX. Changes a KaTeX error into an escaped error span. |
| Logic | `src/renderer/markdown/previewLinks.ts` | Decides if a link click opens externally or does nothing. |
| Logic | `src/renderer/markdown/mermaid/useMermaidDiagrams.ts` | Finds the placeholders and renders them one at a time. |
| Adapter | `src/renderer/markdown/mermaid/mermaidRenderer.ts` | Wraps the `mermaid` library behind the `DiagramRenderer` interface. |
| Contract | `src/renderer/markdown/contract.ts` | Class names, attributes, messages and types that the other files and the E2E suite share. |

### Window material

The window material is three app-wide settings: window opacity (30–100 %,
default 100), backdrop blur (0–40 px, default 20) and backdrop saturation
(100–200 %, default 180). The defaults follow the Apple convention
`saturate(180%) blur(20px)`.

| Layer | File | Responsibility |
|---|---|---|
| Contract | `src/shared/window-material.ts` | Ranges, defaults, setting keys, surface names. Normalises values (round, then clamp). Splits render values by platform. Serialises the `material` URL query. |
| Domain | `src/main/domain/window-material.ts` | Reads the stored material with clamping. Persists a patch and reports the changed keys. |
| Adapter | `src/main/windows/material-controller.ts` | Holds the current material in the main process. Sets native opacity on Windows and Linux. Gives new windows the current values. |
| IO | `src/main/ipc/register.ts` | `app:set-window-material` and `app:get-window-render`. `settings:set` rejects the three keys (`register.ts:503`). |
| Presentation | `src/renderer/window-material-sync.ts` | Writes `--material-alpha`, `--material-blur` and `--material-saturate` on `<html>`. Sends slider values latest-wins. |
| Presentation | `src/renderer/components/WindowMaterialFields.tsx` | The three sliders and "Reset to defaults" in Settings › General. |
| Style | `src/renderer/styles.css:182-220` | Derived surface colours, the `.window-material` class and the reduced-transparency rule. |

## Data Flow

1. `MarkdownPreview` calls `renderMarkdown(source)`. This is synchronous.
2. `markdown-it` parses the source. The math plugin renders math through
   KaTeX during the parse. The fence rule emits one placeholder per `mermaid`
   fence, with the escaped source and `data-mermaid-state="pending"`.
3. React sets the HTML string into the preview container.
4. `useMermaidDiagrams` finds the placeholders. It renders each one through
   `mermaidRenderer`, in document order. It yields to the event loop between
   diagrams (`useMermaidDiagrams.ts:47`).
5. For each diagram, the hook adds an output element or an error element to
   the block. It sets the block state to `rendered` or `error`. The source
   element stays in the block. CSS hides it when the state is `rendered`.
6. A theme change or a new HTML string starts the hook again. The effect
   cleanup cancels the previous run. The run also stops when a block is no
   longer in the document (`useMermaidDiagrams.ts:64-79`).

A link click in the preview always calls `preventDefault`
(`MarkdownPreview.tsx:22`). The handler reads `href`, then `xlink:href`.
Links inside a diagram do nothing. `http`, `https`, `mailto` and `file`
links outside a diagram open through the `app:open-external` IPC channel.

### Window material

1. A slider in `WindowMaterialFields` sends the full material through
   `app:set-window-material`. The sender keeps one request in flight and
   sends only the latest value.
2. `applyWindowMaterial` normalises the values, writes the changed keys in
   one `setMany`, and returns them. The handler emits `settings:changed` once
   per changed key and calls the controller through `WindowHooks`.
3. On Windows and Linux the controller calls `setOpacity` on every window.
   On macOS it does not touch native opacity.
4. In every window, `installWindowMaterialSync` collects the
   `settings:changed` events of one frame, calls `app:get-window-render`
   once, and sets the three CSS variables.
5. A new window gets the current values in its URL query
   (`index.ts:220`, `index.ts:241`). `main.tsx` applies them before
   `createRoot`, so the window never shows the defaults first.

## Authorization Model

Not applicable to the preview. It reads only the local file buffer.

The window material takes renderer input only through
`app:set-window-material`, which reads the three known fields, ignores
non-finite values and clamps the rest. Values reach CSS only as numbers.

## Infrastructure Dependencies

| Dependency | Version | Use |
|---|---|---|
| `markdown-it` | 14.3.0 | Markdown parser. `html` is `false`. |
| `highlight.js` | lockfile | Code block highlighting. |
| `katex` | 0.16.47, exact pin | Math. Also the version `mermaid` depends on, so the bundle has one copy. |
| `mermaid` | 11.17.2, exact pin | Diagrams. Version 12 requires Node 22, and the repo uses Node 20. |

## Architectural Decisions

- **Mermaid loads lazily.** `mermaidRenderer.ts` reaches `mermaid` only
  through `import('mermaid')` (`mermaidRenderer.ts:40`). Vite puts it in a
  separate chunk. A document without diagrams does not load it.
- **Mermaid security configuration.** The adapter calls `initialize` with
  `securityLevel: 'strict'`, `suppressErrorRendering: true` and
  `startOnLoad: false` (`mermaidRenderer.ts:50-57`). It does not set
  `secure`, so the Mermaid default secure keys apply and an `%%{init}%%`
  directive cannot change `securityLevel`.
- **Mermaid renders into a scratch element.** `mermaid.render` clears the
  element it receives. The adapter gives it a temporary child of the block
  and removes that child after the render (`mermaidRenderer.ts:73`). The
  child is absolutely positioned and hidden, so it does not change the block
  height while Mermaid lays out the diagram. This
  keeps the block source for the next render.
- **Diagram results are cached.** The adapter keeps up to 50 SVG results,
  keyed by source and theme (`mermaidRenderer.ts:27`).
- **KaTeX runs untrusted.** `renderMath.ts:5-10` sets `trust: false`,
  `maxSize: 20` and `maxExpand: 1000`.
- **Own math plugin.** No maintained plugin supports `markdown-it` 14 and all
  five delimiters. The inline rule runs before the `escape` rule
  (`mathPlugin.ts:238`), so it sees `\(` and `\[`.
- **Theme comes from the document.** `useDocumentTheme` reads
  `<html data-theme>`, then the `prefers-color-scheme` media query
  (`useDocumentTheme.ts:13-15`). It does not use `useTheme`, because each
  `useTheme` call holds its own state.
- **Fonts are never inlined.** The CSP has no `font-src`, so a `data:` font
  is blocked. The renderer build excludes font files from asset inlining
  (`electron.vite.config.ts:63`). The KaTeX stylesheet is imported in
  `src/renderer/main.tsx:5`.
- **Desktop blur belongs to macOS.** Windows use `vibrancy: 'sidebar'`.
  Electron 32 exposes no blur radius or saturation for vibrancy, and CSS
  `backdrop-filter` blurs only content inside the page. So the blur and
  saturation settings tune the app's own translucent surfaces (title bars,
  sidebars, panels, menus, toasts), not the desktop behind the window.
- **Opacity is surface alpha on macOS.** `--bg`, `--panel`,
  `--panel-strong` and `--chat-surface` are derived from `*-base` theme
  colours with CSS relative colour, scaled by `--material-alpha`. Text is
  never faded. Windows and Linux keep whole-window `setOpacity`.
- **Reduce transparency wins.** `@media (prefers-reduced-transparency:
  reduce)` makes the surfaces opaque and sets `backdrop-filter: none` on
  every element, modal scrims included. On Windows and Linux the controller
  also forces native opacity to 1 and re-applies on `nativeTheme` `updated`.
- **One write path.** Only `app:set-window-material` writes the three keys,
  so every stored value is clamped and every window is updated.
- **No filter above the terminal.** A `filter` or `backdrop-filter` on an
  ancestor of `.xterm` pixelates its canvas, so no terminal container
  carries `.window-material`.
