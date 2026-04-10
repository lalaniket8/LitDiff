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
  const elFileBadge   = byId("file-count-badge");
  const elBtnInfo     = byId("btn-info");
  const elAboutOverlay = byId("about-overlay");
  const elAboutClose  = byId("about-close");

  // ── Constants ───────────────────────────────────────────
  const ALLOWED_EXTENSIONS = [".mir", ".ll"];
  const TOKEN_KEY     = "litdiff_gh_token";
  const HINT_KEY      = "litdiff_hint_shown";
  const DEFAULT_REPO  = "ROCm/llvm-project";
  const CONTEXT_ALL   = Infinity;
  const CONTEXT_STEPS = [3, 10, 25, 75, CONTEXT_ALL];

  // ── Application state (single mutable object) ──────────
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
    highlightPhrases: [],
  };

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
    let results = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await ghApi(path + sep + "per_page=100&page=" + page);
      results = results.concat(data);
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

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

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
    elDiffPane.innerHTML = `<div id="diff-empty" style="color:#ffa198">${escapeHtml(msg)}</div>`;
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

    const { base, head } = currentRefs();

    for (const filename of files) {
      const div = document.createElement("div");
      div.className = "file-item" + (filename === state.selectedFile ? " active" : "");
      div.title = filename;

      const entry = state.contentCache[cacheKey(base, head, filename)];
      const status = !entry ? "M" : !entry.oldText && entry.newText ? "A" : entry.oldText && !entry.newText ? "D" : "M";
      const statusCls = status === "A" ? "added" : status === "D" ? "deleted" : "modified";

      const statusSpan = document.createElement("span");
      statusSpan.className = "file-status file-status-" + statusCls;
      statusSpan.textContent = status;

      const name     = filename.split("/").pop();
      const dotIdx   = name.lastIndexOf(".");
      const baseName = dotIdx > 0 ? name.slice(0, dotIdx) : name;
      const ext      = dotIdx > 0 ? name.slice(dotIdx) : "";

      const nameSpan = document.createElement("span");
      nameSpan.className = "file-name-text";
      nameSpan.innerHTML = escapeHtml(baseName) + '<span class="file-ext">' + escapeHtml(ext) + "</span>";

      div.appendChild(statusSpan);
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
      matching: "none",
      renderNothingWhenEmpty: false,
    });
    elDiffPane.classList.toggle("sbs-mode", isSbs);
    if (isSbs) injectCodePanelSplitter();
    postProcessHunkHeaders();
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

  function renderCurrentFile() {
    if (!state.selectedFile) { renderDiff(null); return; }
    const { base, head } = currentRefs();
    const entry = state.contentCache[cacheKey(base, head, state.selectedFile)];
    if (!entry) { renderDiff(null); return; }
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

  // Steps through CONTEXT_STEPS on each click
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

  // Fetches file contents and renders diff for the selected file
  async function selectFile(filename) {
    state.selectedFile = filename;
    state.contextSize = 3;
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

  function uniquePhrasesPreservingOrder(phrases) {
    const seen = new Set();
    const out = [];
    for (const p of phrases) {
      if (seen.has(p)) continue;
      seen.add(p);
      out.push(p);
    }
    return out;
  }

  function wrapPhraseMatchesInMarks(phrase) {
    elDiffPane.querySelectorAll(".d2h-code-line-ctn").forEach((lineContainer) => {
      const walker = document.createTreeWalker(lineContainer, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      for (const textNode of textNodes) {
        const text = textNode.nodeValue;
        if (text.indexOf(phrase) === -1) continue;

        const fragment = document.createDocumentFragment();
        let sliceStart = 0;
        let matchIndex;
        while ((matchIndex = text.indexOf(phrase, sliceStart)) !== -1) {
          if (matchIndex > sliceStart) {
            fragment.appendChild(document.createTextNode(text.slice(sliceStart, matchIndex)));
          }
          const mark = document.createElement("mark");
          mark.className = "diff-highlight";
          mark.textContent = phrase;
          fragment.appendChild(mark);
          sliceStart = matchIndex + phrase.length;
        }
        fragment.appendChild(document.createTextNode(text.slice(sliceStart)));
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    });
  }

  function applyHighlights() {
    clearHighlights();
    if (!state.highlightPhrases.length) return;
    const phrasesLongestFirst = uniquePhrasesPreservingOrder(state.highlightPhrases)
      .slice()
      .sort((a, b) => b.length - a.length);
    for (const phrase of phrasesLongestFirst) wrapPhraseMatchesInMarks(phrase);
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

    elDiffPane.addEventListener("contextmenu", (e) => {
      const selectedText = window.getSelection().toString().trim();
      const hasTextSelection = selectedText.length > 0;
      const hasActiveHighlights = state.highlightPhrases.length > 0;
      if (!hasTextSelection && !hasActiveHighlights) return;

      e.preventDefault();
      pendingSelectedPhrase = selectedText;

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
      if (!state.highlightPhrases.includes(pendingSelectedPhrase)) {
        state.highlightPhrases.push(pendingSelectedPhrase);
      }
      applyHighlights();
      const uniquePhraseCount = uniquePhrasesPreservingOrder(state.highlightPhrases).length;
      const matchCount = elDiffPane.querySelectorAll(".diff-highlight").length;
      const phrasePreviewForStatus =
        pendingSelectedPhrase.length > 30
          ? pendingSelectedPhrase.slice(0, 27) + "…"
          : pendingSelectedPhrase;
      setStatus(`${uniquePhraseCount} phrase(s), ${matchCount} occurrence(s) — added "${phrasePreviewForStatus}"`);
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
  setupHighlightContextMenu();
})();
