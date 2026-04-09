/* PR Test Diff Viewer — fully client-side, no backend required */

(function () {
  "use strict";

  // ── DOM refs ──────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const elPrUrl     = $("pr-url");
  const elBtnLoad   = $("btn-load");
  const elCommitSel = $("commit-select");
  const elPrTitle   = $("pr-title");
  const elStatus    = $("status-msg");
  const elFileList  = $("file-list");
  const elDiffPane  = $("diff-pane");
  const elSplitter  = $("splitter");
  const elSidebar   = $("sidebar");
  const elToken     = $("gh-token");
  const elViewSel   = $("view-select");
  const elFileBadge = $("file-count-badge");

  const ALLOWED_EXTENSIONS = [".mir", ".ll"];
  const TOKEN_KEY    = "checklines_gh_token";
  const DEFAULT_REPO = "ROCm/llvm-project";
  const CONTEXT_STEPS = [3, 10, 25, 75, 999999];

  // ── State ─────────────────────────────────────────────────
  const state = {
    baseRef: "", headRef: "",
    commits: [],        // [{sha, message}]
    allFiles: [],       // full-PR filenames
    commitFiles: null,  // per-commit filenames (null → use allFiles)
    commitBaseRef: "", commitHeadRef: "",
    selectedCommit: "ALL",
    selectedFile: null,
    contentCache: {},   // "base:head:filename" → {oldText, newText}
    owner: "", repo: "", prNumber: 0,
    contextSize: 3,
    trackedText: "",
  };

  // ── Token persistence ─────────────────────────────────────

  function loadToken() {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) elToken.value = saved;
  }

  function getToken() {
    return elToken.value.trim();
  }

  // ── GitHub REST API helpers ───────────────────────────────

  function ghHeaders(accept) {
    const h = { Accept: accept || "application/vnd.github+json" };
    const token = getToken();
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }

  async function ghApi(path) {
    const resp = await fetch("https://api.github.com" + path, { headers: ghHeaders() });
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

  async function getFileContent(repoSlug, ref, filepath) {
    try {
      const encoded = filepath.split("/").map(encodeURIComponent).join("/");
      const resp = await fetch(
        `https://api.github.com/repos/${repoSlug}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        { headers: ghHeaders("application/vnd.github.raw+json") }
      );
      return resp.ok ? await resp.text() : "";
    } catch { return ""; }
  }

  // ── Helpers ───────────────────────────────────────────────

  const setStatus     = (msg) => { elStatus.textContent = msg; };
  const hasAllowedExt = (f) => ALLOWED_EXTENSIONS.some((ext) => f.endsWith(ext));

  function normalizeFileCheck(text) {
    return text
      .replace(/\[\[(\w+):%\[0-9\]\+\]\]/g, "$1")
      .replace(/\[\[(\w+)\]\]/g, "$1");
  }
  const currentFiles  = () => state.selectedCommit === "ALL" ? state.allFiles : (state.commitFiles || []);
  const cacheKey      = (base, head, file) => `${base}:${head}:${file}`;

  const currentRefs = () =>
    state.selectedCommit === "ALL"
      ? { base: state.baseRef, head: state.headRef }
      : { base: state.commitBaseRef, head: state.commitHeadRef };

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function parsePrUrl(url) {
    const m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], prNumber: +m[3] } : null;
  }

  function resolveInput(raw) {
    const s = String(raw || "");
    return /^\d+$/.test(s) ? `https://github.com/${DEFAULT_REPO}/pull/${s}` : s;
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

  // ── Rendering ─────────────────────────────────────────────

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
    elDiffPane.innerHTML = Diff2Html.html(diffStr, {
      drawFileList: false,
      outputFormat: elViewSel.value === "side-by-side" ? "side-by-side" : "line-by-line",
      matching: "none",
      renderNothingWhenEmpty: false,
    });
    const isSbs = elViewSel.value === "side-by-side";
    elDiffPane.classList.toggle("sbs-mode", isSbs);
    if (isSbs) injectCodePanelSplitter();
  }

  function injectCodePanelSplitter() {
    elDiffPane.querySelectorAll(".d2h-files-diff").forEach((container) => {
      const sides = container.querySelectorAll(":scope > .d2h-file-side-diff");
      if (sides.length !== 2 || container.querySelector(".code-panel-splitter")) return;

      const splitter = document.createElement("div");
      splitter.className = "code-panel-splitter";
      container.insertBefore(splitter, sides[1]);

      let dragging = false;

      splitter.addEventListener("mousedown", (e) => {
        e.preventDefault();
        dragging = true;
        splitter.classList.add("dragging");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const rect = container.getBoundingClientRect();
        const offset = e.clientX - rect.left;
        const total = rect.width;
        const pct = Math.max(10, Math.min(90, (offset / total) * 100));
        sides[0].style.flex = "none";
        sides[1].style.flex = "none";
        sides[0].style.width = pct + "%";
        sides[1].style.width = (100 - pct) + "%";
      });

      document.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        splitter.classList.remove("dragging");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      });

      syncVerticalScroll(sides[0], sides[1]);
    });
  }

  function syncVerticalScroll(a, b) {
    let syncing = false;
    function handle(source, target) {
      if (syncing) return;
      syncing = true;
      target.scrollTop = source.scrollTop;
      syncing = false;
    }
    a.addEventListener("scroll", () => handle(a, b));
    b.addEventListener("scroll", () => handle(b, a));
  }

  function renderCurrentFile() {
    if (!state.selectedFile) { renderDiff(null); return; }
    const { base, head } = currentRefs();
    const entry = state.contentCache[cacheKey(base, head, state.selectedFile)];
    if (!entry) { renderDiff(null); return; }
    let oldText = normalizeFileCheck(entry.oldText);
    let newText = normalizeFileCheck(entry.newText);
    renderDiff(Diff.createTwoFilesPatch(
      "a/" + state.selectedFile, "b/" + state.selectedFile,
      oldText, newText, "", "", { context: state.contextSize }
    ));
    postProcessHunkHeaders();
    applyTrackHighlights();
  }

  function postProcessHunkHeaders() {
    const atMax = state.contextSize >= 999999;
    const seen = new Set();

    elDiffPane.querySelectorAll(".d2h-info").forEach((el) => {
      const tr = el.tagName === "TR" ? el : el.closest("tr");
      if (!tr || seen.has(tr)) return;
      seen.add(tr);

      if (atMax) return;

      tr.classList.add("expandable-hunk");
      tr.title = "Click to show more context lines";

      const ctn = tr.querySelector(".d2h-code-line-ctn");
      if (ctn && !ctn.querySelector(".d2h-expand-icon")) {
        const icon = document.createElement("span");
        icon.className = "d2h-expand-icon";
        icon.innerHTML = "&#x21D5;";
        ctn.prepend(icon);
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
        : 999999;
    renderCurrentFile();
    requestAnimationFrame(() => { elDiffPane.scrollTop = scrollPos; });
  }

  async function selectFile(filename) {
    state.selectedFile = filename;
    state.contextSize = 3;
    renderFileList();

    const { base, head } = currentRefs();
    const key = cacheKey(base, head, filename);
    if (state.contentCache[key]) { renderCurrentFile(); return; }

    elDiffPane.innerHTML = '<div id="diff-empty">Loading diff…</div>';
    setStatus("Fetching file contents…");

    try {
      const slug = state.owner + "/" + state.repo;
      const [oldText, newText] = await Promise.all([
        getFileContent(slug, base, filename),
        getFileContent(slug, head, filename),
      ]);
      state.contentCache[key] = { oldText, newText };
      if (state.selectedFile === filename) renderCurrentFile();
      setStatus("Ready");
    } catch (err) {
      showError(err.message);
    }
  }

  // ── Commit selector ───────────────────────────────────────

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
      const data = await ghApi(`/repos/${state.owner}/${state.repo}/commits/${sha}`);
      state.commitBaseRef = data.parents?.[0]?.sha || "";
      state.commitHeadRef = sha;
      state.commitFiles   = (data.files || []).map((f) => f.filename).filter(hasAllowedExt);
      showFirstFile();
      if (!state.selectedFile) setStatus(`Commit ${sha.slice(0, 8)} — no .mir/.ll files`);
    } catch (err) {
      showError(err.message);
    }
  }

  // ── Load PR ───────────────────────────────────────────────

  async function loadPR() {
    const raw = elPrUrl.value.trim();
    if (!raw) return;

    const url = resolveInput(raw);
    elPrUrl.value = url;

    const parsed = parsePrUrl(url);
    if (!parsed) { setStatus("Error: Invalid GitHub PR URL"); return; }

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
      const slug = parsed.owner + "/" + parsed.repo;
      const pr   = parsed.prNumber;

      const [prData, commitsData, filesData] = await Promise.all([
        ghApi(`/repos/${slug}/pulls/${pr}`),
        ghApiPaginated(`/repos/${slug}/pulls/${pr}/commits`),
        ghApiPaginated(`/repos/${slug}/pulls/${pr}/files`),
      ]);

      let baseRef = prData.base.ref;
      try {
        const cmp = await ghApi(
          `/repos/${slug}/compare/${encodeURIComponent(prData.base.ref)}...${prData.head.sha}`
        );
        if (cmp.merge_base_commit?.sha) baseRef = cmp.merge_base_commit.sha;
      } catch { /* fall back to branch name */ }

      state.baseRef  = baseRef;
      state.headRef  = prData.head.sha;
      state.allFiles = filesData.map((f) => f.filename).filter(hasAllowedExt);
      state.commits  = commitsData.map((c) => ({
        sha: c.sha,
        message: c.commit.message.split("\n")[0],
      }));

      elPrTitle.textContent = `#${pr} ${prData.title || ""}`;
      populateCommits();
      showFirstFile();
      setStatus(`${state.allFiles.length} file(s) — ${state.commits.length} commit(s)`);
    } catch (err) {
      showError(err.message);
    } finally {
      elBtnLoad.disabled = false;
    }
  }

  // ── Splitter drag ─────────────────────────────────────────

  function setupSplitter() {
    let dragging = false;

    elSplitter.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      elSplitter.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      elSidebar.style.width = Math.max(100, Math.min(e.clientX, window.innerWidth - 200)) + "px";
    });

    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      elSplitter.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // ── Track highlights ─────────────────────────────────

  function applyTrackHighlights() {
    if (!state.trackedText) return;
    const needle = state.trackedText;

    elDiffPane.querySelectorAll(".d2h-code-line-ctn").forEach((ctn) => {
      const walker = document.createTreeWalker(ctn, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      for (const node of textNodes) {
        const text = node.nodeValue;
        if (text.indexOf(needle) === -1) continue;

        const frag = document.createDocumentFragment();
        let pos = 0;
        while (true) {
          const i = text.indexOf(needle, pos);
          if (i === -1) {
            frag.appendChild(document.createTextNode(text.slice(pos)));
            break;
          }
          if (i > pos) frag.appendChild(document.createTextNode(text.slice(pos, i)));
          const mark = document.createElement("mark");
          mark.className = "track-highlight";
          mark.textContent = needle;
          frag.appendChild(mark);
          pos = i + needle.length;
        }
        node.parentNode.replaceChild(frag, node);
      }
    });
  }

  function clearTrackHighlights() {
    elDiffPane.querySelectorAll(".track-highlight").forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent));
      parent.normalize();
    });
  }

  // ── Track context menu ──────────────────────────────────

  function setupTrackContextMenu() {
    const menu = document.createElement("div");
    menu.id = "track-context-menu";

    const trackItem = document.createElement("div");
    trackItem.className = "track-menu-item";
    trackItem.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.28 3.22a.75.75 0 0 1 0 1.06L4.56 11H7.25a.75.75 0 0 1 0 1.5h-4.5A.75.75 0 0 1 2 11.75v-4.5a.75.75 0 0 1 1.5 0v2.69l6.72-6.72a.75.75 0 0 1 1.06 0ZM13.5 9.5a.75.75 0 0 0-1.5 0v2.75a.25.25 0 0 1-.25.25H9a.75.75 0 0 0 0 1.5h2.75A1.75 1.75 0 0 0 13.5 12.25V9.5Z"/></svg>' +
      "Track";

    const untrackItem = document.createElement("div");
    untrackItem.className = "track-menu-item";
    untrackItem.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/></svg>' +
      "Untrack";

    menu.appendChild(trackItem);
    menu.appendChild(untrackItem);
    document.body.appendChild(menu);

    function hideMenu() { menu.style.display = "none"; }

    let pendingText = "";

    elDiffPane.addEventListener("contextmenu", (e) => {
      const sel = window.getSelection().toString().trim();
      const hasSelection = sel.length > 0;
      const hasTracked = state.trackedText.length > 0;
      if (!hasSelection && !hasTracked) return;

      e.preventDefault();
      pendingText = sel;

      trackItem.style.display = hasSelection ? "" : "none";
      untrackItem.style.display = hasTracked ? "" : "none";

      const x = Math.min(e.clientX, window.innerWidth - 160);
      const y = Math.min(e.clientY, window.innerHeight - 80);
      menu.style.left = x + "px";
      menu.style.top = y + "px";
      menu.style.display = "block";
    });

    trackItem.addEventListener("click", () => {
      hideMenu();
      if (!pendingText) return;
      state.trackedText = pendingText;
      clearTrackHighlights();
      applyTrackHighlights();
      const count = elDiffPane.querySelectorAll(".track-highlight").length;
      setStatus(`Tracking "${pendingText.length > 30 ? pendingText.slice(0, 27) + "…" : pendingText}" — ${count} occurrence(s)`);
    });

    untrackItem.addEventListener("click", () => {
      hideMenu();
      state.trackedText = "";
      clearTrackHighlights();
      setStatus("Tracking cleared");
    });

    document.addEventListener("click", (e) => {
      if (!menu.contains(e.target)) hideMenu();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hideMenu();
    });
  }

  // ── Event wiring ──────────────────────────────────────────

  elViewSel.addEventListener("change", () => renderCurrentFile());
  elBtnLoad.addEventListener("click", loadPR);
  elPrUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") loadPR(); });
  elCommitSel.addEventListener("change", onCommitChange);
  elToken.addEventListener("change", () => {
    const t = elToken.value.trim();
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  });

  loadToken();
  setupSplitter();
  setupTrackContextMenu();
})();
