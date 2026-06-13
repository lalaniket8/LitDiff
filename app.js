/* LitDiff — client-side GitHub PR diff viewer for .mir/.ll files */

(function () {
  "use strict";

  // ── DOM element references ──────────────────────────────
  function byId(id) { return document.getElementById(id); }
  const elPrUrl       = byId("pr-url");
  const elBtnLoad     = byId("btn-load");
  const elCommitSel   = byId("commit-select");
  const elPrTitle     = byId("pr-title");
  const elStatus      = byId("status-msg");
  const elFileList    = byId("file-list");
  const elDiffPane    = byId("diff-pane");
  const elSplitter    = byId("splitter");
  const elSidebar     = byId("sidebar");
  const elToken       = byId("gh-token");
  const elViewSel     = byId("view-select");
  const elShowAllCtx  = byId("show-all-context");
  const elDisableDiff = byId("disable-diff");
  const elFileBadge   = byId("file-count-badge");
  const elBtnInfo     = byId("btn-info");
  const elAboutOverlay = byId("about-overlay");
  const elAboutClose  = byId("about-close");
  const elBtnSidebarCollapse = byId("btn-sidebar-collapse");
  const elBtnSidebarExpand   = byId("btn-sidebar-expand");

  // ── Constants ───────────────────────────────────────────
  const ALLOWED_EXTENSIONS = [".mir", ".ll"];
  const TOKEN_KEY     = "litdiff_gh_token";
  const HINT_KEY      = "litdiff_hint_shown";
  const DEFAULT_REPO  = "ROCm/llvm-project";
  const CONTEXT_ALL   = Infinity;
  const CONTEXT_STEPS = [3, 10, 25, 75, CONTEXT_ALL];

  // ── Application state ───────────────────────────────────
  const state = {
    baseRef: "", headRef: "",
    commits: [],
    allFiles: [],
    commitFiles: null,
    commitBaseRef: "", commitHeadRef: "",
    selectedCommit: "ALL",
    selectedFile: null,
    contentCache: {},
    owner: "", repo: "", prNumber: 0,
    contextSize: 3,
    showAllContext: false,
    disableDiff: false,
    highlightPhrases: [],
  };

  // Default context for a freshly selected file (full file when "show all" is on)
  function defaultContextSize() {
    return state.showAllContext ? CONTEXT_ALL : 3;
  }

  // ── Global error handler for uncaught promise rejections ──
  window.addEventListener("unhandledrejection", function (e) {
    showError(e.reason?.message || "Unexpected error");
  });

  // ── GitHub REST API helpers ─────────────────────────────

  function ghHeaders(accept) {
    const h = { Accept: accept || "application/vnd.github+json" };
    const token = elToken.value.trim();
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  // Warn user when API rate limit is nearly exhausted
  function checkRateLimit(resp) {
    const remaining = resp.headers.get("X-RateLimit-Remaining");
    if (remaining !== null && parseInt(remaining, 10) <= 10) {
      setStatus("Warning: " + remaining + " API requests remaining");
    }
  }

  async function ghApi(path) {
    const resp = await fetch("https://api.github.com" + path, { headers: ghHeaders() });
    checkRateLimit(resp);
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.message || "GitHub API " + resp.status);
    }
    return resp.json();
  }

  async function ghApiPaginated(path, maxPages = 30) {
    const results = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await ghApi(path + sep + "per_page=100&page=" + page);
      results.push(...data);
      if (data.length < 100) break;
    }
    return results;
  }

  // Returns file text; empty string for 404 (new/deleted file), throws on real errors
  async function getFileContent(repoSlug, ref, filepath) {
    const encoded = filepath.split("/").map(encodeURIComponent).join("/");
    const resp = await fetch(
      `https://api.github.com/repos/${repoSlug}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      { headers: ghHeaders("application/vnd.github.raw+json") }
    );
    checkRateLimit(resp);
    if (resp.ok) return await resp.text();
    if (resp.status === 404) return "";
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.message || "GitHub API " + resp.status);
  }

  // ── Utility helpers ─────────────────────────────────────

  function setStatus(msg) { elStatus.textContent = msg; }

  function hasAllowedExt(f) {
    return ALLOWED_EXTENSIONS.some((ext) => f.endsWith(ext));
  }

  // Strip FileCheck pattern noise from .mir/.ll content
  function normalizeFileCheck(text) {
    return text.replace(/\[\[(\w+)(?::%\[0-9\]\+)?\]\]/g, "$1");
  }

  function currentFiles() {
    return state.selectedCommit === "ALL" ? state.allFiles : (state.commitFiles || []);
  }

  function cacheKey(base, head, file) {
    return `${base}:${head}:${file}`;
  }

  function currentRefs() {
    return state.selectedCommit === "ALL"
      ? { base: state.baseRef, head: state.headRef }
      : { base: state.commitBaseRef, head: state.commitHeadRef };
  }

  function repoSlug() { return state.owner + "/" + state.repo; }

  function parseInput(raw) {
    const s = (raw || "").trim();
    if (/^\d+$/.test(s)) {
      const [owner, repo] = DEFAULT_REPO.split("/");
      return { owner, repo, prNumber: +s };
    }
    const m = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], prNumber: +m[3] } : null;
  }

  function showError(msg) {
    setStatus("Error: " + msg);
    const div = document.createElement("div");
    div.id = "diff-empty";
    div.style.color = "#ffa198";
    div.textContent = msg;
    elDiffPane.replaceChildren(div);
  }

  function showFirstFile() {
    const files = currentFiles();
    if (files.length) {
      selectFile(files[0]);
    } else {
      state.selectedFile = null;
      renderFileList();
      renderDiff(null);
    }
  }

  // ── Drag helper (supports AbortSignal for listener cleanup) ──

  // AbortController for code-panel splitter listeners (re-created each render)
  let codePanelAC = null;

  function makeDraggable(splitterEl, onDrag, signal) {
    let dragging = false;
    let rafId = 0;
    const opts = signal ? { signal } : undefined;

    splitterEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      splitterEl.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }, opts);

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => onDrag(e));
    }, opts);

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      cancelAnimationFrame(rafId);
      splitterEl.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }, opts);
  }

  // ── Rendering ───────────────────────────────────────────

  function renderFileList() {
    const files = currentFiles();
    elFileList.innerHTML = "";
    elFileBadge.textContent = files.length;

    if (!files.length) {
      elFileList.innerHTML =
        '<div style="padding:12px;color:var(--muted);font-size:12px">No .mir / .ll files</div>';
      return;
    }

    for (const filename of files) {
      const div = document.createElement("div");
      div.className = "file-item" + (filename === state.selectedFile ? " active" : "");
      div.title = filename;

      const name = filename.split("/").pop();
      const nameSpan = document.createElement("span");
      nameSpan.className = "file-name-text";
      nameSpan.textContent = name;

      div.appendChild(nameSpan);
      div.addEventListener("click", () => selectFile(filename));
      elFileList.appendChild(div);
    }
  }

  function renderDiff(diffStr) {
    if (!diffStr) {
      elDiffPane.innerHTML = '<div id="diff-empty">Select a file from the list</div>';
      return;
    }
    const isSbs = elViewSel.value === "side-by-side";
    elDiffPane.innerHTML = Diff2Html.html(diffStr, {
      drawFileList: false,
      outputFormat: isSbs ? "side-by-side" : "line-by-line",
      matching: "words",
      matchWordsThreshold: 0.25,
      renderNothingWhenEmpty: false,
    });
    elDiffPane.classList.toggle("sbs-mode", isSbs);
    if (isSbs) {
      injectCodePanelSplitter();
      postProcessFileHeader();
    }
    postProcessHunkHeaders();
    postProcessGutterFolds();
    applyHighlights();
  }

  // ── "Disable diff view": plain old/new text side by side ──

  // Builds one .d2h-file-side-diff pane whose lines all render as context
  // (no d2h-del/d2h-ins), mirroring diff2html's side-by-side DOM so the
  // existing CSS, highlight, splitter and scroll-sync logic all apply.
  function buildPlainSide(text) {
    const side = document.createElement("div");
    side.className = "d2h-file-side-diff";
    const wrap = document.createElement("div");
    wrap.className = "d2h-code-wrapper";
    const table = document.createElement("table");
    table.className = "d2h-diff-table";
    const tbody = document.createElement("tbody");
    tbody.className = "d2h-diff-tbody";

    const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    lines.forEach((line, i) => {
      const tr = document.createElement("tr");

      const numTd = document.createElement("td");
      numTd.className = "d2h-code-side-linenumber d2h-cntx";
      numTd.textContent = String(i + 1);

      const codeTd = document.createElement("td");
      codeTd.className = "d2h-cntx";
      const lineDiv = document.createElement("div");
      lineDiv.className = "d2h-code-side-line";
      const prefix = document.createElement("span");
      prefix.className = "d2h-code-line-prefix";
      prefix.innerHTML = "&nbsp;";
      const ctn = document.createElement("span");
      ctn.className = "d2h-code-line-ctn";
      if (line === "") ctn.innerHTML = "<br>";
      else ctn.textContent = line;
      lineDiv.appendChild(prefix);
      lineDiv.appendChild(ctn);
      codeTd.appendChild(lineDiv);

      tr.appendChild(numTd);
      tr.appendChild(codeTd);
      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    side.appendChild(wrap);
    return side;
  }

  function renderPlainDiff(entry, file) {
    const wrapper = document.createElement("div");
    wrapper.className = "d2h-wrapper";
    const fileWrap = document.createElement("div");
    fileWrap.className = "d2h-file-wrapper";

    const header = document.createElement("div");
    header.className = "d2h-file-header";
    fileWrap.appendChild(header);

    const filesDiff = document.createElement("div");
    filesDiff.className = "d2h-files-diff";
    filesDiff.appendChild(buildPlainSide(entry.oldText));
    filesDiff.appendChild(buildPlainSide(entry.newText));
    fileWrap.appendChild(filesDiff);

    wrapper.appendChild(fileWrap);
    elDiffPane.replaceChildren(wrapper);

    elDiffPane.classList.add("sbs-mode");
    injectCodePanelSplitter();
    postProcessFileHeader();
    postProcessGutterFolds();
    applyHighlights();
  }

  // Adds a draggable splitter between left/right code panels in SBS mode
  function injectCodePanelSplitter() {
    if (codePanelAC) codePanelAC.abort();
    codePanelAC = new AbortController();

    elDiffPane.querySelectorAll(".d2h-files-diff").forEach((container) => {
      const sides = container.querySelectorAll(":scope > .d2h-file-side-diff");
      if (sides.length !== 2 || container.querySelector(".code-panel-splitter")) return;

      const splitter = document.createElement("div");
      splitter.className = "code-panel-splitter";
      container.insertBefore(splitter, sides[1]);

      makeDraggable(splitter, (e) => {
        const rect = container.getBoundingClientRect();
        const pct = Math.max(10, Math.min(90, ((e.clientX - rect.left) / rect.width) * 100));
        sides[0].style.flex = "none";
        sides[1].style.flex = "none";
        sides[0].style.width = pct + "%";
        sides[1].style.width = (100 - pct) + "%";
      }, codePanelAC.signal);

      syncVerticalScroll(sides[0], sides[1]);
    });
  }

  // Keeps left and right code panels scrolled in sync (rAF-throttled)
  function syncVerticalScroll(a, b) {
    let syncing = false;
    let rafId = 0;
    function handle(source, target) {
      if (syncing) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        syncing = true;
        target.scrollTop = source.scrollTop;
        syncing = false;
      });
    }
    a.addEventListener("scroll", () => handle(a, b));
    b.addEventListener("scroll", () => handle(b, a));
  }

  // ── Split file header + per-pane copy buttons (SBS only) ──

  const COPY_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
  const CHECK_ICON_SVG =
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

  // ── Clipboard helpers ──────────────────────────────────
  // Strip empty/whitespace-only lines so copied text has no blank lines
  // between content lines. Original line content (incl. indentation) and
  // order are preserved; no leading/trailing blank line is left behind.
  function stripBlankLines(text) {
    return String(text)
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .join("\n");
  }

  function copyPaneText(text, btn) {
    const clip = stripBlankLines(text);
    navigator.clipboard.writeText(clip).then(() => {
      const n = clip === "" ? 0 : clip.split("\n").length;
      setStatus(`Copied ${n} line(s) to clipboard`);
      if (btn) {
        btn.innerHTML = CHECK_ICON_SVG;
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = COPY_ICON_SVG;
          btn.classList.remove("copied");
        }, 1200);
      }
    }).catch((err) => {
      setStatus("Copy failed: " + (err && err.message ? err.message : "clipboard unavailable"));
    });
  }

  function buildHeaderHalf(label, text, side) {
    const half = document.createElement("div");
    half.className = "d2h-header-half d2h-header-half--" + side;

    const name = document.createElement("span");
    name.className = "d2h-file-name";
    name.textContent = label;
    name.title = label;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "d2h-copy-btn";
    btn.title = "Copy full " + (side === "left" ? "old" : "new") + " file text";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = COPY_ICON_SVG;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyPaneText(text, btn);
    });

    half.appendChild(name);
    half.appendChild(btn);
    return half;
  }

  // Splits each .d2h-file-header into left/right halves aligned with the two
  // code panes, each showing the file name and a copy button for that pane.
  function postProcessFileHeader() {
    if (!elDiffPane.classList.contains("sbs-mode")) return;
    const file = state.selectedFile;
    const { base, head } = currentRefs();
    const entry = file ? state.contentCache[cacheKey(base, head, file)] : null;
    const oldText = entry ? entry.oldText : "";
    const newText = entry ? entry.newText : "";

    elDiffPane.querySelectorAll(".d2h-file-header").forEach((header) => {
      if (header.classList.contains("d2h-file-header--split")) return;
      header.classList.add("d2h-file-header--split");
      header.replaceChildren(
        buildHeaderHalf("a/" + (file || ""), oldText, "left"),
        buildHeaderHalf("b/" + (file || ""), newText, "right")
      );
    });
  }

  function renderCurrentFile() {
    if (!state.selectedFile) { renderDiff(null); return; }
    const { base, head } = currentRefs();
    const entry = state.contentCache[cacheKey(base, head, state.selectedFile)];
    if (!entry) { renderDiff(null); return; }
    if (state.disableDiff) { renderPlainDiff(entry, state.selectedFile); return; }
    renderDiff(Diff.createTwoFilesPatch(
      "a/" + state.selectedFile, "b/" + state.selectedFile,
      entry.oldText, entry.newText, "", "", { context: state.contextSize }
    ));
  }

  // Adds expand-on-click behaviour to @@ hunk header rows
  function postProcessHunkHeaders() {
    if (state.contextSize >= CONTEXT_ALL) return;

    elDiffPane.querySelectorAll(".d2h-info").forEach((el) => {
      const tr = el.tagName === "TR" ? el : el.closest("tr");
      if (!tr || tr.classList.contains("expandable-hunk")) return;

      tr.classList.add("expandable-hunk");
      tr.title = "Click to show more context lines";

      const lineNumCell = tr.querySelector(".d2h-code-linenumber, .d2h-code-side-linenumber");
      if (lineNumCell && !lineNumCell.querySelector(".d2h-expand-icon")) {
        const icon = document.createElement("span");
        icon.className = "d2h-expand-icon";
        icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a.75.75 0 0 1 .53.22l3.25 3.25a.75.75 0 0 1-1.06 1.06L8 2.81 5.28 5.53a.75.75 0 0 1-1.06-1.06L7.47 1.22A.75.75 0 0 1 8 1Zm3.78 9.47a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 11.53a.75.75 0 1 1 1.06-1.06L8 13.19l2.72-2.72a.75.75 0 0 1 1.06 0Z"/></svg>';
        lineNumCell.prepend(icon);
      }

      tr.addEventListener("click", expandContext);
    });
  }

  function expandContext() {
    const scrollPos = elDiffPane.scrollTop;
    const idx = CONTEXT_STEPS.indexOf(state.contextSize);
    state.contextSize =
      idx >= 0 && idx < CONTEXT_STEPS.length - 1
        ? CONTEXT_STEPS[idx + 1]
        : CONTEXT_ALL;
    renderCurrentFile();
    requestAnimationFrame(() => { elDiffPane.scrollTop = scrollPos; });
  }

  // ── Gutter block (brace) selection ─────────────────────
  // Clicking a line-number gutter cell whose code line opens a `{ … }` block
  // selects that whole block (real DOM selection + clipboard copy). Brace
  // matching runs against the full file text in state.contentCache, so it is
  // correct even when only collapsed context is rendered.

  const FOLD_ICON_SVG =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 1 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"/></svg>';

  // "old" → left pane / oldText, "new" → right pane / newText
  function paneSideOf(sideEl) {
    const parent = sideEl && sideEl.parentElement;
    if (!parent) return "new";
    const sides = parent.querySelectorAll(":scope > .d2h-file-side-diff");
    return sides[0] === sideEl ? "old" : "new";
  }

  // Full file lines (1-based when indexed +1) for a given side, from the cache.
  function blockLinesForSide(side) {
    const file = state.selectedFile;
    if (!file) return [];
    const { base, head } = currentRefs();
    const entry = state.contentCache[cacheKey(base, head, file)];
    if (!entry) return [];
    const text = side === "old" ? entry.oldText : entry.newText;
    return text === "" ? [] : text.replace(/\n$/, "").split("\n");
  }

  // True when a line leaves at least one `{` unclosed (a real block opener).
  // Closes that come before their open (e.g. "} else {") are ignored.
  function lineOpensBlock(line) {
    if (!line || line.indexOf("{") === -1) return false;
    let depth = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "{") depth++;
      else if (ch === "}" && depth > 0) depth--;
    }
    return depth > 0;
  }

  // 0-based index of the line holding the matching `}`, or -1 if unbalanced.
  function findBlockEnd(lines, startIdx) {
    let depth = 0, started = false;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === "{") { depth++; started = true; }
        else if (ch === "}" && started) { depth--; if (depth === 0) return i; }
      }
    }
    return -1;
  }

  // Resolve { mode, side, line, sideEl|table } from a gutter <td>, or null.
  function gutterCellInfo(cell) {
    if (cell.classList.contains("d2h-info")) return null;
    if (cell.classList.contains("d2h-code-side-linenumber")) {
      const n = parseInt(cell.textContent, 10);
      if (isNaN(n)) return null;
      const sideEl = cell.closest(".d2h-file-side-diff");
      return { mode: "sbs", side: paneSideOf(sideEl), line: n, sideEl };
    }
    if (cell.classList.contains("d2h-code-linenumber")) {
      const tr = cell.closest("tr");
      const code = tr && tr.querySelector("td.d2h-code-line");
      if (!code) return null;
      const n1 = parseInt((cell.querySelector(".line-num1") || {}).textContent, 10);
      const n2 = parseInt((cell.querySelector(".line-num2") || {}).textContent, 10);
      let side, line;
      if (code.classList.contains("d2h-del")) { side = "old"; line = n1; }
      else if (code.classList.contains("d2h-ins")) { side = "new"; line = n2; }
      else if (!isNaN(n2)) { side = "new"; line = n2; }
      else if (!isNaN(n1)) { side = "old"; line = n1; }
      else return null;
      if (isNaN(line)) return null;
      return { mode: "unified", side, line, table: tr.closest("table") };
    }
    return null;
  }

  // Ordered [{ line, ctn }] of code rows currently rendered for info's side.
  function collectRenderedLines(info) {
    const result = [];
    if (info.mode === "sbs") {
      info.sideEl.querySelectorAll("tr").forEach((tr) => {
        const gut = tr.querySelector("td.d2h-code-side-linenumber");
        const ctn = tr.querySelector(".d2h-code-line-ctn");
        if (!gut || !ctn) return;
        const n = parseInt(gut.textContent, 10);
        if (!isNaN(n)) result.push({ line: n, ctn });
      });
      return result;
    }
    const table = info.table || elDiffPane.querySelector(".d2h-diff-table");
    if (!table) return result;
    table.querySelectorAll("tr").forEach((tr) => {
      const gut = tr.querySelector("td.d2h-code-linenumber");
      const code = tr.querySelector("td.d2h-code-line");
      const ctn = tr.querySelector(".d2h-code-line-ctn");
      if (!gut || !code || !ctn) return;
      if (info.side === "old") {
        if (code.classList.contains("d2h-ins")) return;
        const n = parseInt((gut.querySelector(".line-num1") || {}).textContent, 10);
        if (!isNaN(n)) result.push({ line: n, ctn });
      } else {
        if (code.classList.contains("d2h-del")) return;
        const n = parseInt((gut.querySelector(".line-num2") || {}).textContent, 10);
        if (!isNaN(n)) result.push({ line: n, ctn });
      }
    });
    return result;
  }

  function copyBlockText(text, lineCount, partial, unbalanced) {
    let msg;
    if (unbalanced)
      msg = `Block of ${lineCount} line(s) — no matching “}” found, selected to end of file`;
    else if (partial)
      msg = `Copied block (${lineCount} lines); enable “Show all lines” to select it fully on screen`;
    else
      msg = `Copied block (${lineCount} lines) to clipboard`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(stripBlankLines(text))
        .then(() => setStatus(msg))
        .catch(() => setStatus(`Selected block (${lineCount} lines)`));
    } else {
      setStatus(`Selected block (${lineCount} lines)`);
    }
  }

  // Select the brace-delimited block that starts at the clicked gutter line.
  function selectBlockFromGutter(cell) {
    const info = gutterCellInfo(cell);
    if (!info) return;
    const lines = blockLinesForSide(info.side);
    const startIdx = info.line - 1;
    if (startIdx < 0 || startIdx >= lines.length) return;
    if (!lineOpensBlock(lines[startIdx])) return;

    const endIdx = findBlockEnd(lines, startIdx);
    const unbalanced = endIdx === -1;
    const endLine = unbalanced ? lines.length : endIdx + 1;
    const startLine = info.line;
    const lineCount = endLine - startLine + 1;
    const blockText = lines.slice(startIdx, endLine).join("\n");

    // Real selection over the rows that are actually rendered for this side.
    const rows = collectRenderedLines(info)
      .filter((r) => r.line >= startLine && r.line <= endLine);
    let partial = true;
    if (rows.length) {
      const range = document.createRange();
      range.setStartBefore(rows[0].ctn);
      range.setEndAfter(rows[rows.length - 1].ctn);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      partial = rows[rows.length - 1].line < endLine;
    }
    copyBlockText(blockText, lineCount, partial, unbalanced);
  }

  function markFoldCell(cell) {
    if (cell.classList.contains("lit-fold-cell")) return;
    cell.classList.add("lit-fold-cell");
    cell.title = "Click to select this { … } block";
    const icon = document.createElement("span");
    icon.className = "lit-fold-icon";
    icon.innerHTML = FOLD_ICON_SVG;
    cell.appendChild(icon);
  }

  // After each render, flag gutter cells whose code line opens a block.
  function postProcessGutterFolds() {
    if (!state.selectedFile) return;
    if (elDiffPane.classList.contains("sbs-mode")) {
      elDiffPane.querySelectorAll(".d2h-file-side-diff").forEach((sideEl) => {
        const lines = blockLinesForSide(paneSideOf(sideEl));
        if (!lines.length) return;
        sideEl.querySelectorAll("td.d2h-code-side-linenumber").forEach((gut) => {
          if (gut.classList.contains("d2h-info")) return;
          const n = parseInt(gut.textContent, 10);
          if (!isNaN(n) && n >= 1 && n <= lines.length && lineOpensBlock(lines[n - 1]))
            markFoldCell(gut);
        });
      });
      return;
    }
    const oldLines = blockLinesForSide("old");
    const newLines = blockLinesForSide("new");
    elDiffPane.querySelectorAll("td.d2h-code-linenumber").forEach((gut) => {
      if (gut.classList.contains("d2h-info")) return;
      const tr = gut.closest("tr");
      const code = tr && tr.querySelector("td.d2h-code-line");
      if (!code) return;
      let lines, n;
      if (code.classList.contains("d2h-del")) {
        lines = oldLines;
        n = parseInt((gut.querySelector(".line-num1") || {}).textContent, 10);
      } else if (code.classList.contains("d2h-ins")) {
        lines = newLines;
        n = parseInt((gut.querySelector(".line-num2") || {}).textContent, 10);
      } else {
        lines = newLines;
        n = parseInt((gut.querySelector(".line-num2") || {}).textContent, 10);
        if (isNaN(n)) {
          lines = oldLines;
          n = parseInt((gut.querySelector(".line-num1") || {}).textContent, 10);
        }
      }
      if (!isNaN(n) && n >= 1 && n <= lines.length && lineOpensBlock(lines[n - 1]))
        markFoldCell(gut);
    });
  }

  function setupGutterBlockSelect() {
    elDiffPane.addEventListener("click", (e) => {
      const cell = e.target.closest("td.d2h-code-side-linenumber, td.d2h-code-linenumber");
      if (!cell || cell.classList.contains("d2h-info")) return;
      if (!cell.classList.contains("lit-fold-cell")) return;
      e.preventDefault();
      selectBlockFromGutter(cell);
    });
  }

  async function selectFile(filename) {
    state.selectedFile = filename;
    state.contextSize = defaultContextSize();
    renderFileList();

    const { base, head } = currentRefs();
    const key = cacheKey(base, head, filename);
    if (state.contentCache[key]) { renderCurrentFile(); maybeShowHighlightHint(); return; }

    elDiffPane.innerHTML = '<div id="diff-empty">Loading diff…</div>';
    setStatus("Fetching file contents…");

    try {
      const [oldText, newText] = await Promise.all([
        getFileContent(repoSlug(), base, filename),
        getFileContent(repoSlug(), head, filename),
      ]);
      state.contentCache[key] = { oldText: normalizeFileCheck(oldText), newText: normalizeFileCheck(newText) };
      if (state.selectedFile === filename) renderCurrentFile();
      setStatus("Ready");
      maybeShowHighlightHint();
    } catch (err) {
      showError(err.message);
    }
  }

  // ── One-time highlight feature hint (shown once after first file loads) ──

  function maybeShowHighlightHint() {
    if (localStorage.getItem(HINT_KEY) || state.highlightPhrases.length > 0) return;
    localStorage.setItem(HINT_KEY, "1");
    setStatus("Tip: Select text and right-click → Add highlight (multiple phrases supported)");
    setTimeout(() => {
      if (elStatus.textContent.startsWith("Tip:")) setStatus("Ready");
    }, 8000);
  }

  // ── Commit selector ─────────────────────────────────────

  function populateCommits() {
    elCommitSel.innerHTML = '<option value="ALL">ALL</option>';
    state.commits.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = c.sha;
      const msg = c.message.length > 60 ? c.message.slice(0, 57) + "…" : c.message;
      opt.textContent = `${i + 1}. ${c.sha.slice(0, 8)} — ${msg}`;
      elCommitSel.appendChild(opt);
    });
    elCommitSel.disabled = false;
  }

  async function onCommitChange() {
    const sha = elCommitSel.value;
    state.selectedCommit = sha;

    if (sha === "ALL") {
      state.commitFiles = null;
      showFirstFile();
      return;
    }

    setStatus("Fetching commit info…");
    try {
      const data = await ghApi(`/repos/${repoSlug()}/commits/${sha}`);
      state.commitBaseRef = data.parents?.[0]?.sha || "";
      state.commitHeadRef = sha;
      state.commitFiles   = (data.files || []).map((f) => f.filename).filter(hasAllowedExt);
      showFirstFile();
      if (!state.selectedFile) setStatus(`Commit ${sha.slice(0, 8)} — no .mir/.ll files`);
    } catch (err) {
      showError(err.message);
    }
  }

  // ── Load PR (main entry point) ──────────────────────────

  async function loadPR() {
    const raw = elPrUrl.value.trim();
    if (!raw) return;

    const parsed = parseInput(raw);
    if (!parsed) { setStatus("Error: Invalid GitHub PR URL"); return; }
    elPrUrl.value = `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.prNumber}`;

    if (typeof gtag === "function") {
      gtag("event", "pr_loaded", {
        event_category: "engagement",
        event_label: "pr_load",
      });
    }

    Object.assign(state, {
      owner: parsed.owner, repo: parsed.repo, prNumber: parsed.prNumber,
      contentCache: {}, selectedCommit: "ALL", commitFiles: null,
    });

    elBtnLoad.disabled = true;
    setStatus("Loading PR…");
    elPrTitle.textContent = "";
    elCommitSel.disabled = true;
    elCommitSel.innerHTML = '<option value="ALL">ALL</option>';
    elFileList.innerHTML = "";
    elDiffPane.innerHTML = '<div id="diff-empty">Loading…</div>';

    try {
      const slug = repoSlug();
      const [prData, commitsData, filesData] = await Promise.all([
        ghApi(`/repos/${slug}/pulls/${state.prNumber}`),
        ghApiPaginated(`/repos/${slug}/pulls/${state.prNumber}/commits`),
        ghApiPaginated(`/repos/${slug}/pulls/${state.prNumber}/files`),
      ]);

      let baseRef = prData.base.ref;
      try {
        const cmp = await ghApi(
          `/repos/${slug}/compare/${encodeURIComponent(prData.base.ref)}...${prData.head.sha}`
        );
        if (cmp.merge_base_commit?.sha) baseRef = cmp.merge_base_commit.sha;
      } catch (e) {
        if (e.message && /rate limit/i.test(e.message)) throw e;
      }

      state.baseRef  = baseRef;
      state.headRef  = prData.head.sha;
      state.allFiles = filesData.map((f) => f.filename).filter(hasAllowedExt);
      state.commits  = commitsData.map((c) => ({
        sha: c.sha,
        message: c.commit.message.split("\n")[0],
      }));

      elPrTitle.textContent = `#${state.prNumber} ${prData.title || ""}`;
      populateCommits();
      showFirstFile();
      setStatus(`${state.allFiles.length} file(s) — ${state.commits.length} commit(s)`);
    } catch (err) {
      showError(err.message);
    } finally {
      elBtnLoad.disabled = false;
    }
  }

  // ── Diff highlights (text search + <mark> injection) ──
  const HIGHLIGHT_COLOR_COUNT = 8;
  const WORD_CHAR_RE = /[A-Za-z0-9_]/;

  function isWordChar(ch) {
    return !!ch && WORD_CHAR_RE.test(ch);
  }

  // Determine which pane the current selection sits in: "left", "right", or
  // "both" (context lines in line-by-line, or no selection).
  function detectSelectionSide() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "both";
    let node = sel.getRangeAt(0).startContainer;
    if (node && node.nodeType !== 1) node = node.parentElement;
    if (!node) return "both";

    const sideEl = node.closest(".d2h-file-side-diff");
    if (sideEl && sideEl.parentElement) {
      const sides = sideEl.parentElement.querySelectorAll(":scope > .d2h-file-side-diff");
      if (sides.length === 2) return sides[0] === sideEl ? "left" : "right";
    }
    const codeCell = node.closest("td.d2h-code-line, td.d2h-code-side-line");
    if (codeCell) {
      if (codeCell.classList.contains("d2h-del")) return "left";
      if (codeCell.classList.contains("d2h-ins")) return "right";
    }
    return "both";
  }

  // Resolve the set of `.d2h-code-line-ctn` elements a phrase may match
  // against, scoped to the side it was added on.
  function getHighlightContainers(side) {
    if (side === "both") {
      return Array.from(elDiffPane.querySelectorAll(".d2h-code-line-ctn"));
    }
    const containers = [];
    if (elDiffPane.classList.contains("sbs-mode")) {
      elDiffPane.querySelectorAll(".d2h-files-diff").forEach((files) => {
        const sides = files.querySelectorAll(":scope > .d2h-file-side-diff");
        if (sides.length !== 2) return;
        const sideEl = side === "left" ? sides[0] : sides[1];
        sideEl.querySelectorAll(".d2h-code-line-ctn").forEach((c) => containers.push(c));
      });
      return containers;
    }
    const cls = side === "left" ? "d2h-del" : "d2h-ins";
    return Array.from(elDiffPane.querySelectorAll(`td.d2h-code-line.${cls} .d2h-code-line-ctn`));
  }

  // Word-boundary check is only applied on a side where the phrase itself
  // starts/ends with a word char (mirrors regex \b), so phrases like "%1"
  // or " foo " still match where the user explicitly chose those delimiters.
  function wrapPhraseMatchesInMarks(phrase, colorIndex, side) {
    if (!phrase) return;
    const mod = colorIndex % HIGHLIGHT_COLOR_COUNT;
    const checkLeftBoundary = isWordChar(phrase[0]);
    const checkRightBoundary = isWordChar(phrase[phrase.length - 1]);

    for (const lineContainer of getHighlightContainers(side)) {
      const walker = document.createTreeWalker(lineContainer, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      for (const textNode of textNodes) {
        const text = textNode.nodeValue;
        if (text.indexOf(phrase) === -1) continue;

        const matchStarts = [];
        let searchFrom = 0;
        let matchIndex;
        while ((matchIndex = text.indexOf(phrase, searchFrom)) !== -1) {
          const matchEnd = matchIndex + phrase.length;
          const prevChar = matchIndex > 0 ? text[matchIndex - 1] : "";
          const nextChar = matchEnd < text.length ? text[matchEnd] : "";
          const leftOk = !checkLeftBoundary || !isWordChar(prevChar);
          const rightOk = !checkRightBoundary || !isWordChar(nextChar);
          if (leftOk && rightOk) {
            matchStarts.push(matchIndex);
            searchFrom = matchEnd;
          } else {
            searchFrom = matchIndex + 1;
          }
        }
        if (!matchStarts.length) continue;

        const fragment = document.createDocumentFragment();
        let sliceStart = 0;
        for (const start of matchStarts) {
          if (start > sliceStart) {
            fragment.appendChild(document.createTextNode(text.slice(sliceStart, start)));
          }
          const mark = document.createElement("mark");
          mark.className = "diff-highlight diff-highlight--" + mod;
          mark.textContent = phrase;
          fragment.appendChild(mark);
          sliceStart = start + phrase.length;
        }
        fragment.appendChild(document.createTextNode(text.slice(sliceStart)));
        textNode.replaceWith(fragment);
      }
    }
  }

  // Each entry is { phrase, side }. Color is keyed off the first entry that
  // shares the same phrase, so adding the same phrase on both sides reads as
  // one logical highlight in two scopes. Longest-first ordering prevents a
  // shorter phrase from shadowing a longer one nested inside it.
  function applyHighlights() {
    clearHighlights();
    const phrases = state.highlightPhrases;
    if (!phrases.length) return;
    const order = phrases
      .map((entry) => ({
        ...entry,
        colorIndex: phrases.findIndex((e) => e.phrase === entry.phrase),
      }))
      .sort((a, b) => b.phrase.length - a.phrase.length);
    for (const { phrase, side, colorIndex } of order) {
      wrapPhraseMatchesInMarks(phrase, colorIndex, side);
    }
  }

  function clearHighlights() {
    elDiffPane.querySelectorAll(".diff-highlight").forEach((elHighlightMark) => {
      const parentNode = elHighlightMark.parentNode;
      elHighlightMark.replaceWith(document.createTextNode(elHighlightMark.textContent));
      parentNode.normalize();
    });
  }

  // ── Highlight context menu (right-click) ──

  function setupHighlightContextMenu() {
    const elHighlightMenu = document.createElement("div");
    elHighlightMenu.id = "highlight-context-menu";

    const elMenuAddPhrase = document.createElement("div");
    elMenuAddPhrase.className = "highlight-menu-item";
    elMenuAddPhrase.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.28 3.22a.75.75 0 0 1 0 1.06L4.56 11H7.25a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 2 11.75v-4.5a.75.75 0 0 1 1.5 0v2.69l6.72-6.72a.75.75 0 0 1 1.06 0ZM13.5 9.5a.75.75 0 0 0-1.5 0v2.75a.25.25 0 0 1-.25.25H9a.75.75 0 0 0 0 1.5h2.75A1.75 1.75 0 0 0 13.5 12.25V9.5Z"/></svg>' +
      "Add highlight";

    const elMenuClearAll = document.createElement("div");
    elMenuClearAll.className = "highlight-menu-item";
    elMenuClearAll.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>' +
      "Unhighlight";

    elHighlightMenu.appendChild(elMenuAddPhrase);
    elHighlightMenu.appendChild(elMenuClearAll);
    document.body.appendChild(elHighlightMenu);

    function hideHighlightMenu() { elHighlightMenu.style.display = "none"; }

    let pendingSelectedPhrase = "";
    let pendingSelectedSide = "both";

    elDiffPane.addEventListener("contextmenu", (e) => {
      const selectedText = window.getSelection().toString().trim();
      const hasTextSelection = selectedText.length > 0;
      const hasActiveHighlights = state.highlightPhrases.length > 0;
      if (!hasTextSelection && !hasActiveHighlights) return;

      e.preventDefault();
      pendingSelectedPhrase = selectedText;
      pendingSelectedSide = hasTextSelection ? detectSelectionSide() : "both";

      const sideSuffix =
        pendingSelectedSide === "left" ? " (left pane)"
        : pendingSelectedSide === "right" ? " (right pane)"
        : "";
      elMenuAddPhrase.lastChild.nodeValue = "Add highlight" + sideSuffix;

      elMenuAddPhrase.style.display = hasTextSelection ? "" : "none";
      elMenuClearAll.style.display = hasActiveHighlights ? "" : "none";

      const x = Math.min(e.clientX, window.innerWidth - 160);
      const y = Math.min(e.clientY, window.innerHeight - 80);
      elHighlightMenu.style.left = x + "px";
      elHighlightMenu.style.top = y + "px";
      elHighlightMenu.style.display = "block";
    });

    elMenuAddPhrase.addEventListener("click", () => {
      hideHighlightMenu();
      if (!pendingSelectedPhrase) return;
      const phrase = pendingSelectedPhrase;
      const side = pendingSelectedSide;
      const exists = state.highlightPhrases.some((e) => e.phrase === phrase && e.side === side);
      if (!exists) state.highlightPhrases.push({ phrase, side });
      applyHighlights();
      const phraseCount = state.highlightPhrases.length;
      const matchCount = elDiffPane.querySelectorAll(".diff-highlight").length;
      const phrasePreview = phrase.length > 30 ? phrase.slice(0, 27) + "…" : phrase;
      setStatus(`${phraseCount} phrase(s), ${matchCount} occurrence(s) — added "${phrasePreview}"`);
    });

    elMenuClearAll.addEventListener("click", () => {
      hideHighlightMenu();
      state.highlightPhrases = [];
      clearHighlights();
      setStatus("All highlights cleared");
    });

    document.addEventListener("click", (e) => {
      if (!elHighlightMenu.contains(e.target)) hideHighlightMenu();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideHighlightMenu();
    });
  }

  // ── About modal ────────────────────────────────────────

  function showAbout()  { elAboutOverlay.classList.remove("hidden"); }
  function hideAbout()  { elAboutOverlay.classList.add("hidden"); }

  elBtnInfo.addEventListener("click", showAbout);
  elAboutClose.addEventListener("click", hideAbout);
  elAboutOverlay.addEventListener("click", (e) => {
    if (e.target === elAboutOverlay) hideAbout();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !elAboutOverlay.classList.contains("hidden")) hideAbout();
  });

  // ── Event wiring and initialization ─────────────────────

  elViewSel.addEventListener("change", renderCurrentFile);

  elShowAllCtx.addEventListener("change", () => {
    state.showAllContext = elShowAllCtx.checked;
    state.contextSize = defaultContextSize();
    renderCurrentFile();
  });

  elDisableDiff.addEventListener("change", () => {
    state.disableDiff = elDisableDiff.checked;
    // Layout / context controls don't apply while showing raw full text
    elViewSel.disabled = elDisableDiff.checked;
    elShowAllCtx.disabled = elDisableDiff.checked;
    renderCurrentFile();
  });

  elBtnLoad.addEventListener("click", loadPR);
  elPrUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") loadPR(); });
  elCommitSel.addEventListener("change", onCommitChange);

  elToken.addEventListener("change", () => {
    const t = elToken.value.trim();
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  });

  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (savedToken) elToken.value = savedToken;

  makeDraggable(elSplitter, (e) => {
    elSidebar.style.width = Math.max(100, Math.min(e.clientX, window.innerWidth - 200)) + "px";
  });

  // ── Sidebar collapse / expand ───────────────────────────
  let lastSidebarWidth = "";

  function setSidebarCollapsed(collapsed) {
    if (collapsed) {
      lastSidebarWidth = elSidebar.style.width || "";
      elSidebar.classList.add("collapsed");
      elBtnSidebarCollapse.setAttribute("aria-expanded", "false");
      elBtnSidebarExpand.hidden = false;
      elBtnSidebarExpand.setAttribute("aria-expanded", "false");
    } else {
      elSidebar.classList.remove("collapsed");
      if (lastSidebarWidth) elSidebar.style.width = lastSidebarWidth;
      elBtnSidebarCollapse.setAttribute("aria-expanded", "true");
      elBtnSidebarExpand.hidden = true;
      elBtnSidebarExpand.setAttribute("aria-expanded", "true");
    }
  }

  elBtnSidebarCollapse.addEventListener("click", () => setSidebarCollapsed(true));
  elBtnSidebarExpand.addEventListener("click", () => setSidebarCollapsed(false));

  setupHighlightContextMenu();
  setupGutterBlockSelect();
})();
