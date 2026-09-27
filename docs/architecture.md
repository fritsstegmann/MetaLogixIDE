# Architecture

## Overview

MetaLogix IDE is an Electron desktop app with a main process (`src/main/`),
a preload script (`src/preload/`) and a React renderer (`src/renderer/`). The
renderer calls the main process through the IPC API that the preload script
exposes as `window.api` (`src/renderer/api.ts:4`).

This document is incomplete. At this time it describes only the Markdown
preview pipeline. The product design is in
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

### Terminal focus

When a window gains OS focus, the visible shell terminal takes keyboard
focus, so typing goes to the Claude Code prompt without a click. One
coordinator per window makes the decision. Each renderer window is its own
JS realm, so a module-level instance gives one owner per window.

| Layer | File | Responsibility |
|---|---|---|
| Logic | `src/renderer/terminal-focus.ts` | Classifies the active element, holds the focus rules, and builds the coordinator. DOM-free. |
| Adapter | `src/renderer/hooks/useWindowTerminalFocus.ts` | Creates the window's one `terminalFocus` coordinator. Owns the `window` `focus` and `blur` listeners and passes the overlay flag. |
| Presentation | `src/renderer/components/ShellTab.tsx` | Registers its terminal, and reports when it opens, when it is used, and when it unmounts. |
| Presentation | `src/renderer/App.tsx` | Computes the overlay flag, marks the left pane and the popout terminal as `primary`, and forwards `shell:focus-request` and popout open to `requestFocus`. |

Rules:

- On window focus, a terminal takes focus only when no overlay is open and
  focus is on nothing or on a non-text control. Focus in a text field, the
  editor, the find box or the chat panel stays where it is.
- The target is the last-used terminal, then the `primary` terminal, then
  the only terminal. A target that has not opened yet takes focus when it
  opens, and the rule is checked again at that moment.
- A notification click or a popout open requests a specific shell. The
  request expires after `FOCUS_REQUEST_TTL_MS`. It is honoured when no
  overlay is open and no text-entry element has focus.
- The focus call runs synchronously in the window `focus` handler. An
  activating click on a text field therefore keeps that field focused.
- In-app shell tab and project switches do not move focus.

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

## Authorization Model

Not applicable to the preview. It reads only the local file buffer.

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
- **Terminal focus uses the renderer `window` focus event.** On macOS,
  webContents `focus` and `blur` do not fire when the user switches between
  windows, so the coordinator listens on the renderer `window` instead.
  Unit tests cover the coordinator in the node environment. The E2E suite
  (`tests/e2e/terminal-window-focus.spec.ts`) dispatches a `focus` event,
  because a real `BrowserWindow.blur()`/`focus()` under Playwright did not
  reliably deliver it.
