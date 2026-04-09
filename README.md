# LitDiff

Browser diff viewer for [LLVM FileCheck](https://llvm.org/docs/CommandGuide/FileCheck.html) check lines in GitHub PRs. Strips FileCheck pattern noise (`[[VAR:%[0-9]+]]` → `VAR`) from `.mir`/`.ll` files before diffing. No backend — runs entirely in the browser.

## Features

- FileCheck normalization (`[[NAME:%[0-9]+]]` → `NAME`, `[[NAME]]` → `NAME`)
- Github like UI/UX
- Code-wide text highlighting (right-click → Highlight / Unhighlight) to help track variables

> **Warning:** By default `GH_AUTH_TOKEN` is saved to browser `localStorage`, which persists across sessions and has no expiry. Anyone with access to the browser profile or developer tools can read it.

## Usage

Open `index.html`, enter a PR number (defaults to `ROCm/llvm-project`) or full PR URL, click **Load**.

**TOKEN** — gh auth token, optional read-only PAT (`public_repo`) for higher API rate limits, stored in `localStorage`.

## Architecture

Single IIFE in `app.js`, sections marked with `// ── Section ──` comments. `index.html` is the shell with CDN links (SRI-pinned). `style.css` handles dark theme and diff2html overrides.

## Security

- CDN scripts pinned with [SRI](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity) hashes
- `Content-Security-Policy` meta tag restricts sources
- Token never leaves the browser; no inline scripts
