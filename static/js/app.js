// ClaudeWebUI - Developed by acidvegas in Python (https://github.com/acidvegas/claudewebui)
// claudewebui/static/js/app.js

'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  sessions:       {},
  currentSession: null,
  currentFile:    null,
  openTabs:       {},
  gitStatus:      {},
  cwd:            (window.DEFAULT_CWD || '').replace(/\/+$/, ''),

  term:        null,
  fitAddon:    null,
  shellTerm:        null,
  shellFitAddon:    null,
  shellSession:     null,
  shellSchedFit:    null,
  shellInitialized: false,
  editor:      null,
  monacoReady: false,
  monacoQueue: [],

  termFontSize:   10,
  editorFontSize: 10,
  activePane:     'welcome',

  claudeHistory:  [],
  claudeCwdMap:   {},

  statsInterval: null,
  dailyInterval: null,
  gutterDecs:    new Map(),    // path -> Monaco decoration IDs (git diff markers)
  minimapOn:     true,

  treeSelection: new Set(),    // multi-selected tree paths
  treeAnchor:    null,         // last click target for shift-range
  treeOrder:     [],           // ordered list of paths as rendered (for shift-range)

  // Notifications
  notifyEnabled:  false,
  notifyState:    {},          // { sessionId: { lastOutput, idleTimer, lastNotifiedAttention } }
};

const socket = io({ transports: ['websocket', 'polling'] });

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => {
  state.cwd = normCwd(state.cwd);
  initTerminal();
  initMonaco();
  initSocket();
  initUI();
  loadActiveSessions();
  loadClaudeHistory().then(showStartupModal);

  // Refresh git badges every 5s while the tab is visible so commit/push from
  // the terminal updates the explorer without manual refresh.
  let gitInterval = setInterval(() => {
    if (document.visibilityState === 'visible') refreshGitBadges();
  }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshGitBadges();
  });
  window.addEventListener('focus', refreshGitBadges);

  // Autosave any tabs with unsaved edits every 5 minutes.
  setInterval(autosaveDirtyTabs, 5 * 60 * 1000);
});

// ─── Terminal ─────────────────────────────────────────────────────────────────

function initTerminal() {
  const TermClass = window.Terminal && window.Terminal.Terminal
    ? window.Terminal.Terminal : window.Terminal;
  const FitClass = window.FitAddon && window.FitAddon.FitAddon
    ? window.FitAddon.FitAddon : window.FitAddon;

  const term = new TermClass({
    theme: {
      background:          '#010409',
      foreground:          '#e6edf3',
      cursor:              '#58a6ff',
      cursorAccent:        '#010409',
      selectionBackground: 'rgba(56,139,253,.25)',
      black:   '#484f58', red:     '#ff7b72',
      green:   '#3fb950', yellow:  '#d29922',
      blue:    '#58a6ff', magenta: '#bc8cff',
      cyan:    '#39c5cf', white:   '#b1bac4',
      brightBlack:   '#6e7681', brightRed:     '#ffa198',
      brightGreen:   '#56d364', brightYellow:  '#e3b341',
      brightBlue:    '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan:    '#56d4dd', brightWhite:   '#f0f6fc',
    },
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "Menlo", "Consolas", "DejaVu Sans Mono", "Symbols Nerd Font Mono", monospace',
    fontSize: state.termFontSize,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    allowProposedApi: true,
  });

  const fit = new FitClass();
  term.loadAddon(fit);

  const container = el('terminal-container');
  term.open(container);
  fit.fit();

  state.term     = term;
  state.fitAddon = fit;

  term.onData((data) => {
    if (state.currentSession)
      socket.emit('send_input', { session_id: state.currentSession, text: data });
  });

  // Debounced resize: coalesce rapid changes to avoid flicker / repeated fits
  let resizeRaf = 0;
  let lastCols = 0, lastRows = 0;
  const doFit = () => {
    try { fit.fit(); } catch (e) { return; }
    if (term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols; lastRows = term.rows;
      if (state.currentSession)
        socket.emit('resize', { session_id: state.currentSession, cols: term.cols, rows: term.rows });
    }
  };
  const scheduleFit = () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(doFit);
  };
  new ResizeObserver(scheduleFit).observe(container);
  window.addEventListener('resize', scheduleFit);
  state.scheduleFit = scheduleFit;

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); activateTerminalTab(); }
  });
}

function initShellTerminal() {
  if (state.shellTerm) return;
  const TermClass = window.Terminal && window.Terminal.Terminal
    ? window.Terminal.Terminal : window.Terminal;
  const FitClass = window.FitAddon && window.FitAddon.FitAddon
    ? window.FitAddon.FitAddon : window.FitAddon;

  const term = new TermClass({
    theme: {
      background:          '#010409',
      foreground:          '#e6edf3',
      cursor:              '#56d4dd',
      cursorAccent:        '#010409',
      selectionBackground: 'rgba(86,212,221,.25)',
      black:   '#484f58', red:     '#ff7b72',
      green:   '#3fb950', yellow:  '#d29922',
      blue:    '#58a6ff', magenta: '#bc8cff',
      cyan:    '#39c5cf', white:   '#b1bac4',
      brightBlack:   '#6e7681', brightRed:     '#ffa198',
      brightGreen:   '#56d364', brightYellow:  '#e3b341',
      brightBlue:    '#79c0ff', brightMagenta: '#d2a8ff',
      brightCyan:    '#56d4dd', brightWhite:   '#f0f6fc',
    },
    fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", "Menlo", "Consolas", "DejaVu Sans Mono", "Symbols Nerd Font Mono", monospace',
    fontSize: state.termFontSize,
    cursorBlink: true,
    cursorStyle: 'block',
    scrollback: 10000,
    allowProposedApi: true,
  });

  const fit = new FitClass();
  term.loadAddon(fit);
  const container = el('shell-container');
  term.open(container);
  try { fit.fit(); } catch {}

  state.shellTerm     = term;
  state.shellFitAddon = fit;

  term.onData((data) => {
    if (state.shellSession)
      socket.emit('send_input', { session_id: state.shellSession, text: data });
  });

  let raf = 0, lastCols = 0, lastRows = 0;
  const doFit = () => {
    try { fit.fit(); } catch { return; }
    if (term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols; lastRows = term.rows;
      if (state.shellSession)
        socket.emit('resize', { session_id: state.shellSession, cols: term.cols, rows: term.rows });
    }
  };
  const scheduleFit = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(doFit);
  };
  new ResizeObserver(scheduleFit).observe(container);
  state.shellSchedFit = scheduleFit;
}

async function respawnShell() {
  // Kill the current shell PTY (if any) and start a fresh one in state.cwd.
  const old = state.shellSession;
  state.shellSession = null;
  if (old) {
    socket.emit('leave_session', { session_id: old });
    apiFetch(`/api/shell-session/${old}`, { method: 'DELETE' });
  }
  if (state.shellTerm) {
    try { state.shellTerm.reset(); } catch {}
    try { state.shellTerm.clear(); } catch {}
  }
  await ensureShellSession();
  if (state.shellTerm) state.shellTerm.focus();
}

async function ensureShellSession() {
  if (state.shellSession) return state.shellSession;
  const cwd = state.cwd || (window.DEFAULT_CWD || '');
  const data = await apiFetch('/api/shell-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  });
  if (!data || !data.id) return null;
  state.shellSession = data.id;
  socket.emit('join_session', { session_id: data.id });

  // Force a fit so the shell starts at the real viewport size.
  requestAnimationFrame(() => {
    if (state.shellSchedFit) state.shellSchedFit();
    if (state.shellFitAddon && state.shellTerm) {
      try { state.shellFitAddon.fit(); } catch {}
      socket.emit('resize', {
        session_id: data.id,
        cols: state.shellTerm.cols,
        rows: state.shellTerm.rows,
      });
    }
  });
  return data.id;
}

// ─── Rainbow indent decorations ───────────────────────────────────────────────

function initRainbowIndents(editor) {
  const PALETTE = [
    { bg: 'rgba(121,192,255,0.10)' }, // blue
    { bg: 'rgba(163,113,247,0.10)' }, // purple
    { bg: 'rgba(63,185,80,0.10)'   }, // green
    { bg: 'rgba(219,97,162,0.10)'  }, // pink
    { bg: 'rgba(86,212,221,0.10)'  }, // cyan
    { bg: 'rgba(227,179,65,0.10)'  }, // yellow
  ];

  // Inject CSS classes for each level — filled block, no border
  const css = PALETTE.map((c, i) =>
    `.monaco-editor .ri${i}{background:${c.bg}}`
  ).join('');
  const styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  let handles = [];
  let timer = null;

  function refresh() {
    const model = editor.getModel();
    if (!model) { handles = editor.deltaDecorations(handles, []); return; }

    const lineCount = Math.min(model.getLineCount(), 6000);

    // Auto-detect indent step from first 200 lines (handles 2-space, 4-space, tabs)
    let step = 0;
    for (let ln = 1; ln <= Math.min(200, lineCount) && step !== 1; ln++) {
      const l = model.getLineContent(ln);
      let sp = 0;
      while (sp < l.length && l[sp] === ' ') sp++;
      if (sp > 0 && (step === 0 || sp < step)) step = sp;
    }
    if (step < 1) step = model.getOptions().tabSize || 4;

    const decs = [];

    for (let ln = 1; ln <= lineCount; ln++) {
      const line = model.getLineContent(ln);
      if (!line.trim()) continue;

      if (line[0] === '\t') {
        // Tab-indented: each tab = one level
        let tabs = 0;
        while (tabs < line.length && line[tabs] === '\t') tabs++;
        for (let t = 0; t < tabs; t++) {
          decs.push({
            range: new monaco.Range(ln, t + 1, ln, t + 2),
            options: { inlineClassName: `ri${t % PALETTE.length}`,
                       stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
          });
        }
      } else {
        // Space-indented: count actual leading spaces, step by detected indent width
        let spaces = 0;
        while (spaces < line.length && line[spaces] === ' ') spaces++;
        if (spaces < step) continue;

        for (let stop = 0; stop + step <= spaces; stop += step) {
          decs.push({
            range: new monaco.Range(ln, stop + 1, ln, stop + step + 1),
            options: { inlineClassName: `ri${(stop / step) % PALETTE.length}`,
                       stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
          });
        }
      }
    }

    handles = editor.deltaDecorations(handles, decs);
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 120); }

  editor.onDidChangeModel(() => { handles = []; schedule(); });
  editor.onDidChangeModelContent(schedule);
  schedule();
}

// ─── Monaco ───────────────────────────────────────────────────────────────────

function initMonaco() {
  require(['vs/editor/editor.main'], () => {
    // Custom dotenv language: KEY=value with comments, strings, var refs
    monaco.languages.register({ id: 'dotenv' });
    monaco.languages.setMonarchTokensProvider('dotenv', {
      defaultToken: '',
      tokenizer: {
        root: [
          [/^\s*#.*$/, 'comment'],
          [/\s+#.*$/, 'comment'],
          [/^\s*(export)(\s+)/, ['keyword', '']],
          [/^\s*([A-Za-z_][A-Za-z0-9_.\-]*)(\s*)(=)/, ['variable.name', '', 'delimiter']],
          [/"([^"\\]|\\.)*"/, 'string'],
          [/'([^'\\]|\\.)*'/, 'string'],
          [/\$\{[^}]+\}/, 'variable'],
          [/\$[A-Za-z_][A-Za-z0-9_]*/, 'variable'],
          [/\b(true|false|null)\b/i, 'keyword'],
          [/-?\d+(\.\d+)?\b/, 'number'],
          [/[^\s#]+/, 'string'],
        ],
      },
    });
    monaco.languages.setLanguageConfiguration('dotenv', {
      comments: { lineComment: '#' },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [
        { open: '"', close: '"' },
        { open: "'", close: "'" },
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
      ],
    });

    monaco.editor.defineTheme('claude-dark', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: {
        'editor.background':              '#0d1117',
        'editor.foreground':              '#e6edf3',
        'editorLineNumber.foreground':    '#484f58',
        'editorLineNumber.activeForeground': '#7d8590',
        'editorCursor.foreground':        '#58a6ff',
        'editor.selectionBackground':     '#264f7840',
        'editor.lineHighlightBackground': '#161b2280',
        'editorWidget.background':        '#161b22',
        'editorWidget.border':            '#30363d',
        'input.background':               '#010409',
        'input.border':                   '#30363d',
        'scrollbarSlider.background':     '#30363d80',
        'scrollbarSlider.hoverBackground':'#484f5880',
        'scrollbarSlider.activeBackground':'#58a6ff60',
        'editorGroupHeader.tabsBackground': '#010409',
        'tab.activeBackground':           '#0d1117',
        'tab.inactiveBackground':         '#010409',
        // indent guides
        'editorIndentGuide.background':         '#30363d',
        'editorIndentGuide.activeBackground':   '#484f58',
        // rainbow bracket pair guides
        'editorBracketHighlight.foreground1':   '#79c0ff',
        'editorBracketHighlight.foreground2':   '#a371f7',
        'editorBracketHighlight.foreground3':   '#3fb950',
        'editorBracketHighlight.foreground4':   '#db61a2',
        'editorBracketHighlight.foreground5':   '#56d4dd',
        'editorBracketHighlight.foreground6':   '#e3b341',
        'editorBracketHighlight.unexpectedBracket.foreground': '#f85149',
        'editorBracketPairGuide.background1':        '#79c0ff18',
        'editorBracketPairGuide.background2':        '#a371f718',
        'editorBracketPairGuide.background3':        '#3fb95018',
        'editorBracketPairGuide.background4':        '#db61a218',
        'editorBracketPairGuide.background5':        '#56d4dd18',
        'editorBracketPairGuide.background6':        '#e3b34118',
        'editorBracketPairGuide.activeBackground1':  '#79c0ff40',
        'editorBracketPairGuide.activeBackground2':  '#a371f740',
        'editorBracketPairGuide.activeBackground3':  '#3fb95040',
        'editorBracketPairGuide.activeBackground4':  '#db61a240',
        'editorBracketPairGuide.activeBackground5':  '#56d4dd40',
        'editorBracketPairGuide.activeBackground6':  '#e3b34140',
      },
    });

    const ed = monaco.editor.create(el('monaco-container'), {
      theme: 'claude-dark', language: 'plaintext',
      fontSize: state.editorFontSize,
      fontFamily: '"JetBrains Mono", monospace',
      fontLigatures: true, lineNumbers: 'on',
      minimap: { enabled: true }, scrollBeyondLastLine: false,
      wordWrap: 'off', automaticLayout: true,
      tabSize: 4, insertSpaces: true, renderLineHighlight: 'line',
      smoothScrolling: true, cursorSmoothCaretAnimation: 'on',
      cursorStyle: 'block', cursorBlinking: 'solid',
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
      guides: {
        bracketPairs: true,
        bracketPairsHorizontal: 'active',
        highlightActiveBracketPair: true,
        indentation: true,
        highlightActiveIndentation: true,
      },
    });

    ed.onDidChangeCursorPosition(updateStatusCursor);
    ed.onDidChangeCursorSelection(updateStatusCursor);
    ed.onDidChangeModelContent(() => updateStatusFile());
    ed.onDidChangeModelLanguageConfiguration(() => updateStatusFile());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);

    initRainbowIndents(ed);

    state.editor = ed;
    state.monacoReady = true;
    state.monacoQueue.forEach(fn => fn());
    state.monacoQueue = [];
  });
}

function whenMonaco(fn) {
  if (state.monacoReady) fn(); else state.monacoQueue.push(fn);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

function initSocket() {
  socket.on('output', ({ session_id, data }) => {
    if (session_id === state.shellSession) {
      if (state.shellTerm) state.shellTerm.write(data);
      return;
    }
    if (session_id === state.currentSession) state.term.write(data);
    noteSessionActivity(session_id, data);
  });

  socket.on('session_status', ({ session_id, status }) => {
    if (session_id === state.shellSession && status === 'done') {
      state.shellSession = null;
      return;
    }
    if (state.sessions[session_id]) {
      state.sessions[session_id].status = status;
      renderSessionsPanel();
      if (session_id === state.currentSession) {
        setStatusBadge(status);
        updateTermDot(status);
      }
    }
  });

  socket.on('connect', () => {
    if (state.currentSession) socket.emit('join_session', { session_id: state.currentSession });
    if (state.shellSession)   socket.emit('join_session', { session_id: state.shellSession });
  });
}

// ─── UI wiring ────────────────────────────────────────────────────────────────

function initUI() {
  // Sidebar collapse/expand
  el('btn-collapse-sidebar').addEventListener('click', () => setSidebar(false));
  el('btn-show-sidebar').addEventListener('click', () => setSidebar(true));

  el('btn-save').addEventListener('click', saveFile);

  // Tab scroll arrows
  const tabList = el('tab-list');
  el('tab-scroll-left').addEventListener('click', () => {
    tabList.scrollBy({ left: -180, behavior: 'smooth' });
  });
  el('tab-scroll-right').addEventListener('click', () => {
    tabList.scrollBy({ left: 180, behavior: 'smooth' });
  });
  tabList.addEventListener('scroll', updateTabScrollUI);
  new ResizeObserver(updateTabScrollUI).observe(tabList);

  // Explorer toolbar
  el('btn-new-file').addEventListener('click', () => createNewEntry('file'));
  el('btn-new-folder').addEventListener('click', () => createNewEntry('dir'));
  el('btn-duplicate-selected').addEventListener('click', duplicateSelected);
  el('btn-delete-selected').addEventListener('click', deleteSelected);
  el('btn-refresh-tree').addEventListener('click', () => loadTree(state.cwd));

  // Search
  initSearch();

  // Open directory (re-uses startup modal)
  el('btn-open-dir').addEventListener('click', () => {
    el('startup-dir').value = state.cwd;
    el('modal-startup').classList.remove('hidden');
    setTimeout(() => el('startup-dir').focus(), 50);
  });

  // New session
  el('btn-new-session').addEventListener('click', (e) => {
    e.stopPropagation();
    openNewSessionModal();
  });

  // Sidebar tab switching
  document.querySelectorAll('.sb-tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      document.querySelectorAll('.sb-tab[data-tab]').forEach(t => t.classList.toggle('active', t === btn));
      document.querySelectorAll('.sb-section').forEach(s => s.classList.toggle('active', s.id === target));
      if (target === 'sb-settings') renderConfigPanel();
      if (target === 'sb-git') loadGitPanel();
    });
  });

  // New session modal
  el('modal-start-btn').addEventListener('click', createSession);
  el('modal-cancel-btn').addEventListener('click', closeNewSessionModal);
  el('modal-new').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeNewSessionModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('modal-new').classList.contains('hidden'))
      closeNewSessionModal();
  });

  // Terminal tab
  el('tab-terminal').addEventListener('click', activateTerminalTab);
  el('tab-shell').addEventListener('click', activateShellTab);

  // Minimap toggle
  el('btn-toggle-minimap').addEventListener('click', () => {
    state.minimapOn = !state.minimapOn;
    whenMonaco(() => state.editor.updateOptions({ minimap: { enabled: state.minimapOn } }));
    el('btn-toggle-minimap').classList.toggle('off', !state.minimapOn);
  });

  // Font sizes
  el('btn-font-dec').addEventListener('click', () => changeFontSize(-1));
  el('btn-font-inc').addEventListener('click', () => changeFontSize(+1));
  el('btn-fit-terminal').addEventListener('click', () => {
    if (state.activePane === 'shell') respawnShell();
    else refitTerminal();
  });
  el('btn-md-preview').addEventListener('click', () => {
    if (state.currentFile) openMarkdownPreview(state.currentFile);
  });
  initNotifications();

  // 🌈 Trippy vibe mode — click the logo mark to toggle
  const logoMark = document.querySelector('.logo-mark');
  if (logoMark) {
    logoMark.style.cursor = 'pointer';
    logoMark.addEventListener('click', () => {
      const on = document.body.classList.toggle('trippy');
      try { localStorage.setItem('trippy', on ? '1' : '0'); } catch {}
    });
  }
  try {
    if (localStorage.getItem('trippy') === '1') document.body.classList.add('trippy');
  } catch {}

  makeResizableH('sidebar-resize', 'sidebar');
}

function setSidebar(open) {
  el('sidebar').classList.toggle('collapsed', !open);
  el('btn-show-sidebar').classList.toggle('hidden', open);
  el('right-pane').classList.toggle('with-show-sidebar', !open);
  if (state.scheduleFit) state.scheduleFit();
}

function prettyPath(p) {
  if (!p) return '';
  if (window.HOME_DIR && p === window.HOME_DIR) return '~';
  if (window.HOME_DIR && p.startsWith(window.HOME_DIR + '/')) return '~' + p.slice(window.HOME_DIR.length);
  return p;
}

function normCwd(p) {
  if (!p) return '';
  let s = String(p).trim();
  if (s === '~') s = window.HOME_DIR || s;
  else if (s.startsWith('~/')) s = (window.HOME_DIR || '') + s.slice(1);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

function renderSessionsPanel() {
  const list = el('sessions-list');
  list.innerHTML = '';

  // ── Active webui sessions ──────────────────────────────
  const active = Object.values(state.sessions);
  if (active.length) {
    const grpHdr = document.createElement('div');
    grpHdr.className = 'sessions-group';
    grpHdr.textContent = `Active (${active.length})`;
    list.appendChild(grpHdr);

    active.forEach(s => {
      const dir  = s.cwd.split('/').pop() || s.cwd;
      const isCurrent = s.id === state.currentSession;
      const badgeClass = s.status === 'running' ? 'sc-badge-running'
                       : s.status === 'error'   ? 'sc-badge-error' : 'sc-badge-done';
      const emoji = s.status === 'running' ? '⚡' : s.status === 'error' ? '❌' : '✅';

      const card = document.createElement('div');
      card.className = 'session-card' + (isCurrent ? ' current' : '');
      card.innerHTML =
        `<div class="sc-top">` +
          `<span class="sc-emoji">${emoji}</span>` +
          `<span class="sc-title">${esc(dir)}</span>` +
          `<span class="sc-badge ${badgeClass}">${s.status}</span>` +
          `<button class="sc-kill" title="Kill session">✕</button>` +
        `</div>` +
        `<div class="sc-bottom">` +
          `<div class="sc-path">${esc(prettyPath(s.cwd))}</div>` +
          `<div class="sc-path" style="color:var(--surface2)">${s.id}</div>` +
        `</div>`;

      card.querySelector('.sc-kill').addEventListener('click', (e) => {
        e.stopPropagation();
        killSessionById(s.id);
      });
      card.addEventListener('click', () => switchSession(s.id));
      list.appendChild(card);
    });
  }

  // ── Claude session history filtered to CURRENT cwd ─────
  const cwd = state.cwd;
  const ncwd = normCwd(cwd);
  const local = state.claudeHistory.filter(s => normCwd(s.cwd) === ncwd);
  if (local.length) {
    const grpHdr = document.createElement('div');
    grpHdr.className = 'sessions-group';
    grpHdr.textContent = `History (${local.length})`;
    list.appendChild(grpHdr);

    local.forEach(s => {
      const timeAgo = formatTimeAgo(s.timestamp);
      const title   = s.custom_title || (s.first_msg && !s.first_msg.startsWith('(') ? s.first_msg.slice(0, 60) : s.id.slice(0, 8));
      const shortId = s.id.slice(0, 8);

      const card = document.createElement('div');
      card.className = 'session-card';
      card.innerHTML =
        `<div class="sc-top">` +
          `<span class="sc-emoji">📁</span>` +
          `<span class="sc-title">${esc(title)}</span>` +
          `<span class="sc-badge sc-badge-time">${esc(timeAgo)}</span>` +
          `<button class="sc-kill" title="Delete this session permanently">🗑</button>` +
        `</div>` +
        `<div class="sc-bottom">` +
          `<div class="sc-path" style="color:var(--surface2)" title="${esc(s.id)}">${esc(shortId)}</div>` +
        `</div>`;

      card.querySelector('.sc-kill').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteClaudeSession(s.id);
      });
      card.addEventListener('click', () => {
        resumeClaudeSession(s.id, s.cwd);
      });
      list.appendChild(card);
    });
  }

  if (!active.length && !local.length) {
    list.innerHTML = '<div class="sessions-empty">No sessions for ' + esc(prettyPath(cwd)) + '.<br>＋ New to start one.</div>';
  }
}

async function deleteClaudeSession(sessionId) {
  if (!confirm(`Delete session ${sessionId.slice(0, 8)} permanently? The JSONL file will be removed.`)) return;
  const r = await apiFetch(`/api/claude-sessions/${sessionId}`, { method: 'DELETE' });
  if (r && r.ok) {
    state.claudeHistory = state.claudeHistory.filter(s => s.id !== sessionId);
    renderSessionsPanel();
  }
}

// ─── Config panel ─────────────────────────────────────────────────────────────

async function renderConfigPanel() {
  const body = el('config-panel-body');
  body.innerHTML = '<div style="padding:12px;color:var(--text-dim);font-size:11px;">Loading…</div>';
  const data = await apiFetch(`/api/config?cwd=${enc(state.cwd)}`);
  if (!data) { body.innerHTML = '<div style="padding:12px;color:var(--red);font-size:11px;">Failed to load config</div>'; return; }
  body.innerHTML = '';

  // CLAUDE.md and settings.json: one row each, with a button per scope
  function fileRow(label, entries) {
    const row = document.createElement('div');
    row.className = 'cfg-file-row';
    const buttons = entries.map(e => {
      const verb = e.exists ? e.scope : '+ ' + e.scope;
      const cls  = e.exists ? '' : ' cfg-btn-create';
      return `<button class="cfg-btn${cls}" data-path="${esc(e.path)}" data-exists="${e.exists}" title="${esc(e.path)}">${esc(verb)}</button>`;
    }).join('');
    row.innerHTML = `<span class="cfg-file-label">${esc(label)}</span>${buttons}`;
    row.querySelectorAll('.cfg-btn').forEach((btn, i) => {
      btn.addEventListener('click', () => openConfigFile(entries[i]));
    });
    return row;
  }

  body.appendChild(fileRow('CLAUDE.md',     data.claude_md));
  body.appendChild(fileRow('settings.json', data.settings));

  // ── Skills ──
  const skillsHdr = document.createElement('div');
  skillsHdr.className = 'cfg-section';
  skillsHdr.innerHTML = '<span>Skills</span><button class="cfg-add" title="New skill">＋</button>';
  skillsHdr.querySelector('.cfg-add').addEventListener('click', () => newSkill(data.global_commands_dir));
  body.appendChild(skillsHdr);

  if (!data.skills.length) {
    const empty = document.createElement('div');
    empty.className = 'cfg-empty';
    empty.textContent = 'No skills.';
    body.appendChild(empty);
  } else {
    data.skills.forEach(skill => {
      const row = document.createElement('div');
      row.className = 'cfg-item';
      row.innerHTML =
        `<span class="cfg-item-name"><span class="cfg-prefix">/</span>${esc(skill.name)}</span>` +
        `<span class="cfg-scope-tag ${skill.scope.toLowerCase()}">${esc(skill.scope)}</span>`;
      row.title = skill.path;
      row.addEventListener('click', () => openFile(skill.path));
      body.appendChild(row);
    });
  }

}

async function openConfigFile(item) {
  if (!item.exists) {
    const ok = await apiFetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: item.path, content: item.default_content }),
    });
    if (!ok) return;
  }
  openFile(item.path);
}

async function newSkill(commandsDir) {
  const name = prompt('Skill name (used as /name):');
  if (!name) return;
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
  const path = `${commandsDir}/${safe}.md`;
  const content = `# /${safe}\n\n<!-- Describe what this skill does -->\n\n`;
  const ok = await apiFetch('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (ok) {
    openFile(path);
    renderConfigPanel();
  }
}

// ─── Pane switching ───────────────────────────────────────────────────────────

function updateFitTerminalButton() {
  const btn = el('btn-fit-terminal');
  if (!btn) return;
  const show = state.activePane === 'terminal' || state.activePane === 'shell';
  btn.classList.toggle('hidden', !show);
  btn.title = state.activePane === 'shell' ? 'Restart shell (fresh in cwd)' : 'Refit terminal';
}

function updateEditorChromeButtons() {
  const onEditor = state.activePane === 'editor';
  el('btn-save').classList.toggle('hidden', !onEditor);
  el('btn-toggle-minimap').classList.toggle('hidden', !onEditor);
}

function activateTerminalTab() {
  state.activePane = 'terminal';
  document.querySelectorAll('#editor-tabs .tab').forEach(t => t.classList.remove('active'));
  el('tab-terminal').classList.add('active');
  el('welcome').classList.add('hidden');
  el('monaco-container').classList.add('hidden');
  el('diff-pane').classList.add('hidden');
  el('md-pane').classList.add('hidden');
  el('shell-pane').classList.add('hidden'); el('img-pane').classList.add('hidden');
  el('terminal-pane').classList.remove('hidden');
  el('btn-md-preview').classList.add('hidden');
  el('editor-statusbar').classList.add('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();
  requestAnimationFrame(() => {
    if (state.scheduleFit) state.scheduleFit();
    if (state.term) state.term.focus();
  });
}

async function activateShellTab() {
  state.activePane = 'shell';
  document.querySelectorAll('#editor-tabs .tab').forEach(t => t.classList.remove('active'));
  el('tab-shell').classList.add('active');
  el('welcome').classList.add('hidden');
  el('monaco-container').classList.add('hidden');
  el('diff-pane').classList.add('hidden');
  el('md-pane').classList.add('hidden');
  el('terminal-pane').classList.add('hidden');
  el('shell-pane').classList.remove('hidden');
  el('btn-md-preview').classList.add('hidden');
  el('editor-statusbar').classList.add('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();

  initShellTerminal();
  await ensureShellSession();
  requestAnimationFrame(() => {
    if (state.shellSchedFit) state.shellSchedFit();
    if (state.shellTerm) state.shellTerm.focus();
  });
}

function activateEditorPane() {
  state.activePane = 'editor';
  el('welcome').classList.add('hidden');
  el('terminal-pane').classList.add('hidden');
  el('shell-pane').classList.add('hidden'); el('img-pane').classList.add('hidden');
  el('diff-pane').classList.add('hidden');
  el('md-pane').classList.add('hidden');
  el('monaco-container').classList.remove('hidden');
  el('editor-statusbar').classList.remove('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();
}

function activateDiffPane() {
  state.activePane = 'diff';
  el('welcome').classList.add('hidden');
  el('terminal-pane').classList.add('hidden');
  el('shell-pane').classList.add('hidden'); el('img-pane').classList.add('hidden');
  el('monaco-container').classList.add('hidden');
  el('md-pane').classList.add('hidden');
  el('editor-statusbar').classList.add('hidden');
  el('diff-pane').classList.remove('hidden');
  el('btn-md-preview').classList.add('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();
}

function activateMdPane() {
  state.activePane = 'md';
  el('welcome').classList.add('hidden');
  el('terminal-pane').classList.add('hidden');
  el('shell-pane').classList.add('hidden'); el('img-pane').classList.add('hidden');
  el('monaco-container').classList.add('hidden');
  el('diff-pane').classList.add('hidden');
  el('img-pane').classList.add('hidden');
  el('editor-statusbar').classList.add('hidden');
  el('md-pane').classList.remove('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();
}

function activateImgPane() {
  state.activePane = 'img';
  el('welcome').classList.add('hidden');
  el('terminal-pane').classList.add('hidden');
  el('shell-pane').classList.add('hidden');
  el('monaco-container').classList.add('hidden');
  el('diff-pane').classList.add('hidden');
  el('md-pane').classList.add('hidden');
  el('btn-md-preview').classList.add('hidden');
  el('editor-statusbar').classList.add('hidden');
  el('img-pane').classList.remove('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();
}

function showWelcome() {
  state.activePane = 'welcome';
  el('monaco-container').classList.add('hidden');
  el('terminal-pane').classList.add('hidden');
  el('shell-pane').classList.add('hidden'); el('img-pane').classList.add('hidden');
  el('diff-pane').classList.add('hidden');
  el('md-pane').classList.add('hidden');
  el('welcome').classList.remove('hidden');
  el('editor-statusbar').classList.add('hidden');
  updateFitTerminalButton();
  updateEditorChromeButtons();
}

// ─── Font size ────────────────────────────────────────────────────────────────

// ─── Markdown preview ─────────────────────────────────────────────────────────

function isMarkdownPath(path) {
  if (!path) return false;
  const name = path.split('/').pop().toLowerCase();
  return /\.(md|mdx|markdown)$/.test(name);
}

function updateMdPreviewButton() {
  const btn = el('btn-md-preview');
  if (!btn) return;
  const show = isMarkdownPath(state.currentFile) && !String(state.currentFile).startsWith('md:');
  btn.classList.toggle('hidden', !show);
}

async function openMarkdownPreview(srcPath) {
  if (!isMarkdownPath(srcPath)) return;
  const previewPath = 'md:' + srcPath;
  state.openTabs[previewPath] = state.openTabs[previewPath] || { isMd: true, srcPath };
  state.currentFile = previewPath;
  activateMdPane();
  await renderMarkdownPreview(srcPath);
  addMdPreviewTab(previewPath, srcPath);
}

async function renderMarkdownPreview(srcPath) {
  const target = el('md-pane');
  let text = '';
  if (state.openTabs[srcPath] && state.openTabs[srcPath].model) {
    text = state.openTabs[srcPath].model.getValue();
  } else {
    const data = await apiFetch(`/api/file?path=${enc(srcPath)}`);
    if (!data) { target.innerHTML = '<div class="md-empty">Failed to load source.</div>'; return; }
    text = data.content;
  }
  let html;
  try {
    if (window.marked && window.marked.parse) {
      html = window.marked.parse(text, { breaks: true, gfm: true });
    } else {
      html = `<pre>${esc(text)}</pre>`;
    }
  } catch (err) {
    html = `<pre style="color:var(--red)">markdown render failed: ${esc(err.message || err)}</pre>`;
  }
  target.innerHTML = `<div class="md-content">${html}</div>`;
  // Run hljs over code blocks
  if (window.hljs) {
    target.querySelectorAll('pre code').forEach((block) => {
      try { hljs.highlightElement(block); } catch {}
    });
  }
}

function addMdPreviewTab(path, srcPath) {
  const tabs = el('tab-list');
  const existing = tabs.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (existing) {
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    existing.classList.add('active');
    el('tab-terminal').classList.remove('active');
    existing.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const name = srcPath.split('/').pop();
  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.dataset.path = path;
  tab.title = 'Preview · ' + prettyPath(srcPath);
  tab.style.setProperty('--tab-color', 'var(--pink)');
  tab.innerHTML =
    `<span class="tab-ftype"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5C5 3.5 2.6 5.5 1.6 8c1 2.5 3.4 4.5 6.4 4.5s5.4-2 6.4-4.5c-1-2.5-3.4-4.5-6.4-4.5z"/><circle cx="8" cy="8" r="2.2"/></svg></span>` +
    `<span class="tab-name">${esc(name)} (preview)</span>` +
    `<span class="tab-close" title="Close">×</span>`;
  tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    el('tab-terminal').classList.remove('active');
    state.currentFile = path;
    activateMdPane();
    renderMarkdownPreview(srcPath);
    updateMdPreviewButton();
  });
  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = tab.classList.contains('active');
    delete state.openTabs[path];
    tab.remove();
    if (wasActive) {
      const remaining = tabs.querySelectorAll('.tab:not(.tab-pinned)');
      if (remaining.length) {
        remaining[remaining.length - 1].click();
      } else {
        state.currentFile = null;
        showWelcome();
      }
    }
    updateTabScrollUI();
  });
  tabs.appendChild(tab);
  updateTabScrollUI();
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ─── Image preview ────────────────────────────────────────────────────────────

const IMG_SIZE_LIMIT = 5 * 1024 * 1024; // 5 MB

function isImagePath(path) {
  if (!path) return false;
  const name = path.split('/').pop().toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg|avif|tiff?)$/.test(name);
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function openImagePreview(srcPath, opts) {
  const force = !!(opts && opts.force);
  const tabPath = 'img:' + srcPath;
  state.openTabs[tabPath] = state.openTabs[tabPath] || { isImage: true, srcPath };
  state.currentFile = tabPath;
  activateImgPane();
  addImageTab(tabPath, srcPath);
  await renderImagePreview(srcPath, force);
}

async function renderImagePreview(srcPath, force) {
  const target = el('img-pane');
  let stat = null;
  let statErr = '';
  try {
    const r = await fetch('/api/stat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: srcPath }),
    });
    if (r.ok) stat = await r.json();
    else statErr = `HTTP ${r.status}`;
  } catch (e) { statErr = String(e); }
  if (!stat) {
    target.innerHTML =
      `<div class="img-confirm">` +
      `<h3>Failed to load image</h3>` +
      `<p>${esc(srcPath)}<br>${esc(statErr || 'unknown error')}</p>` +
      `</div>`;
    return;
  }
  if (!force && stat.size > IMG_SIZE_LIMIT) {
    target.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'img-confirm';
    wrap.innerHTML =
      `<h3>Large image (${esc(fmtBytes(stat.size))})</h3>` +
      `<p>${esc(srcPath.split('/').pop())} exceeds the ${fmtBytes(IMG_SIZE_LIMIT)} preview limit.</p>` +
      `<button type="button">Show anyway</button>`;
    wrap.querySelector('button').addEventListener('click', () => renderImagePreview(srcPath, true));
    target.appendChild(wrap);
    return;
  }
  // Use path-style URL ("/api/raw/abs/path") instead of "?path=" so that
  // adblockers / extensions that match suspicious-looking query strings
  // don't intercept the image request.
  const imgUrl = '/api/raw' + srcPath.split('/').map(encodeURIComponent).join('/');
  target.innerHTML =
    `<div class="img-content">` +
    `<img src="${imgUrl}" alt="${esc(srcPath)}">` +
    `<div class="img-meta">${esc(fmtBytes(stat.size))} · ${esc(srcPath.split('/').pop())}</div>` +
    `</div>`;
}

function addImageTab(path, srcPath) {
  const tabs = el('tab-list');
  const existing = tabs.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (existing) {
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    existing.classList.add('active');
    existing.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const name = srcPath.split('/').pop();
  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.dataset.path = path;
  tab.title = prettyPath(srcPath);
  tab.style.setProperty('--tab-color', 'var(--cyan, #56d4dd)');
  tab.innerHTML =
    `<span class="tab-ftype"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M2.5 12.5l3.5-3.5 2.5 2.5 2-2 3 3"/></svg></span>` +
    `<span class="tab-name">${esc(name)}</span>` +
    `<span class="tab-close" title="Close">×</span>`;
  tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.currentFile = path;
    activateImgPane();
    renderImagePreview(srcPath, false);
  });
  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = tab.classList.contains('active');
    delete state.openTabs[path];
    tab.remove();
    if (wasActive) {
      const remaining = tabs.querySelectorAll('.tab:not(.tab-pinned)');
      if (remaining.length) {
        remaining[remaining.length - 1].click();
      } else {
        state.currentFile = null;
        showWelcome();
      }
    }
    updateTabScrollUI();
  });
  tabs.appendChild(tab);
  updateTabScrollUI();
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function initNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    state.notifyEnabled = true;
    return;
  }
  if (Notification.permission === 'default') {
    try {
      const perm = await Notification.requestPermission();
      state.notifyEnabled = perm === 'granted';
    } catch {}
  }
}

const ATTENTION_PATTERNS = [
  /Do you want (?:to|me) /i,
  /\(y\/n\)/i,
  /\[Y\/n\]/, /\[y\/N\]/,
  /\b1\.\s*Yes\b/, /❯\s*1\.\s*Yes/,
  /Approve this/i,
  /\bPress\b.*\bcontinue\b/i,
];

function looksLikeAttention(text) {
  // Strip ANSI escape codes for pattern matching
  const stripped = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  return ATTENTION_PATTERNS.some(p => p.test(stripped));
}

function noteSessionActivity(sid, data) {
  if (!state.notifyEnabled) return;
  let s = state.notifyState[sid];
  if (!s) {
    s = { lastOutput: 0, idleTimer: null, hadActivity: false, lastAttention: 0 };
    state.notifyState[sid] = s;
  }
  s.lastOutput = Date.now();
  s.hadActivity = true;

  // Attention check (debounce: at most once per 8s per session)
  if (looksLikeAttention(data) && Date.now() - s.lastAttention > 8000) {
    s.lastAttention = Date.now();
    if (document.hidden || sid !== state.currentSession) {
      fireNotification('Claude needs your attention', sessionLabel(sid), true, sid);
    }
  }

  // Idle = "finished a turn". Wait 2.5s of silence after activity.
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (!s.hadActivity) return;
    s.hadActivity = false;
    if (document.hidden || sid !== state.currentSession) {
      fireNotification('Claude finished', sessionLabel(sid), false, sid);
    }
  }, 2500);
}

function sessionLabel(sid) {
  const s = state.sessions[sid];
  if (!s) return sid;
  return prettyPath(s.cwd) + ' · ' + sid.slice(0, 8);
}

function fireNotification(title, body, urgent, sid) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, {
      body,
      icon:    '/static/favicon.ico',
      tag:     sid ? `claudeweb-${sid}` : 'claudeweb',
      silent:  !urgent,
    });
    n.onclick = () => {
      window.focus();
      if (sid && state.sessions[sid]) switchSession(sid);
      n.close();
    };
    setTimeout(() => n.close(), urgent ? 12000 : 6000);
  } catch {}
}

function refitTerminal() {
  if (!state.term || !state.fitAddon) return;
  // Activate the terminal pane briefly so its container has real dimensions.
  const wasOnTerminal = state.activePane === 'terminal';
  if (!wasOnTerminal) activateTerminalTab();
  requestAnimationFrame(() => {
    try { state.fitAddon.fit(); } catch {}
    if (state.currentSession) {
      socket.emit('resize', {
        session_id: state.currentSession,
        cols: state.term.cols, rows: state.term.rows,
      });
    }
    state.term.refresh(0, state.term.rows - 1);
  });
}

function changeFontSize(delta) {
  const next = Math.max(8, Math.min(32, state.termFontSize + delta));
  state.termFontSize = next;
  state.editorFontSize = next;
  if (state.term) state.term.options.fontSize = next;
  if (state.shellTerm) state.shellTerm.options.fontSize = next;
  whenMonaco(() => state.editor && state.editor.updateOptions({ fontSize: next }));
  document.documentElement.style.setProperty('--diff-font-size', next + 'px');

  // After the font size change settles, refit + emit resize for both PTYs so
  // the running shells re-wrap to the new column count.
  requestAnimationFrame(() => {
    if (state.term && state.fitAddon) {
      try { state.fitAddon.fit(); } catch {}
      if (state.currentSession) {
        socket.emit('resize', {
          session_id: state.currentSession,
          cols: state.term.cols, rows: state.term.rows,
        });
      }
      try { state.term.refresh(0, state.term.rows - 1); } catch {}
    }
    if (state.shellTerm && state.shellFitAddon) {
      try { state.shellFitAddon.fit(); } catch {}
      if (state.shellSession) {
        socket.emit('resize', {
          session_id: state.shellSession,
          cols: state.shellTerm.cols, rows: state.shellTerm.rows,
        });
      }
      try { state.shellTerm.refresh(0, state.shellTerm.rows - 1); } catch {}
    }
  });
}

// ─── Load Claude history ──────────────────────────────────────────────────────

async function loadActiveSessions() {
  const data = await apiFetch('/api/sessions');
  if (!Array.isArray(data)) return;
  data.forEach(s => { state.sessions[s.id] = s; });
  renderSessionsPanel();
}

async function loadClaudeHistory() {
  const data = await apiFetch('/api/claude-sessions');
  if (!data) return;
  state.claudeHistory = data;
  data.forEach(s => { state.claudeCwdMap[s.id] = s.cwd; });
  renderSessionsPanel();
}

// ─── Startup modal ────────────────────────────────────────────────────────────

async function showStartupModal() {
  const modal = el('modal-startup');
  el('startup-dir').value = state.cwd;

  const recents = getRecentDirs();
  if (recents.length) {
    const list = el('startup-recents-list');
    list.innerHTML = '';
    recents.forEach(dir => {
      const item = mkStartupItem('📁', prettyPath(dir), '', '', 'open');
      item.addEventListener('click', () => dismissStartup(dir));
      list.appendChild(item);
    });
    el('startup-recents-section').classList.remove('hidden');
  }

  if (state.claudeHistory.length) {
    const list = el('startup-sessions-list');
    list.innerHTML = '';
    const scroll = document.createElement('div');
    scroll.className = 'startup-scroll';
    state.claudeHistory.forEach(s => {
      const label = (s.custom_title ? s.custom_title + ' · ' : '') + prettyPath(s.cwd) + '  [' + s.id.slice(0, 8) + ']';
      const item = mkStartupItem('⚡', label, s.first_msg, formatTimeAgo(s.timestamp), 'resume');
      item.addEventListener('click', () => {
        dismissStartup(s.cwd);
        resumeClaudeSession(s.id, s.cwd);
      });
      scroll.appendChild(item);
    });
    list.appendChild(scroll);
    el('startup-sessions-section').classList.remove('hidden');
  }

  el('startup-open-btn').addEventListener('click', () => {
    dismissStartup(el('startup-dir').value.trim() || state.cwd);
  });
  el('startup-dir').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dismissStartup(el('startup-dir').value.trim() || state.cwd);
  });

  modal.classList.remove('hidden');
  setTimeout(() => el('startup-dir').focus(), 80);
}

function mkStartupItem(icon, path, preview, time, badgeKind) {
  const item = document.createElement('div');
  item.className = 'startup-item';
  const badgeClass = badgeKind === 'resume' ? 'badge-resume' : 'badge-open';
  const badgeLabel = badgeKind === 'resume' ? 'Resume' : 'Open';
  item.innerHTML =
    `<span class="startup-item-icon">${icon}</span>` +
    `<div class="startup-item-body">` +
      `<div class="startup-item-path">${esc(path)}</div>` +
      (preview && !preview.startsWith('(') ? `<div class="startup-item-meta">${esc(preview)}</div>` : '') +
    `</div>` +
    `<div class="startup-item-right">` +
      (time ? `<span class="startup-item-time">${esc(time)}</span>` : '') +
      `<span class="startup-item-badge ${badgeClass}">${badgeLabel}</span>` +
    `</div>`;
  return item;
}

function dismissStartup(dir) {
  el('modal-startup').classList.add('hidden');
  openDirAndAutoLaunch(dir);
}

async function openDirAndAutoLaunch(dir) {
  const ncwd = normCwd(dir);
  state.cwd = ncwd;
  saveRecentDir(ncwd);
  loadTree(ncwd);
  await loadClaudeHistory();
  renderSessionsPanel();

  // 1) live session in this dir → just switch
  const live = Object.values(state.sessions).find(s => normCwd(s.cwd) === ncwd);
  if (live) { switchSession(live.id); return; }

  // 2) historical Claude sessions in this dir → resume the most recent
  const local = state.claudeHistory.filter(s => normCwd(s.cwd) === ncwd);
  if (local.length) {
    const mostRecent = local.reduce((a, b) =>
      (a.timestamp || 0) >= (b.timestamp || 0) ? a : b);
    resumeClaudeSession(mostRecent.id, ncwd);
    return;
  }

  // 3) nothing here → spawn a fresh session
  const session = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd: ncwd, prompt: '' }),
  });
  if (session) {
    state.sessions[session.id] = session;
    renderSessionsPanel();
    switchSession(session.id);
  }
}

function getRecentDirs() {
  try { return JSON.parse(localStorage.getItem('recentDirs') || '[]'); } catch { return []; }
}
function saveRecentDir(dir) {
  const r = [dir, ...getRecentDirs().filter(d => d !== dir)].slice(0, 8);
  localStorage.setItem('recentDirs', JSON.stringify(r));
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

function openNewSessionModal() {
  el('modal-cwd').value = state.cwd;
  el('modal-prompt').value = '';
  el('modal-new').classList.remove('hidden');
  el('modal-cwd').focus();
}
function closeNewSessionModal() { el('modal-new').classList.add('hidden'); }

async function createSession() {
  const cwd    = normCwd(el('modal-cwd').value.trim() || state.cwd);
  const prompt = el('modal-prompt').value.trim();
  closeNewSessionModal();

  const session = await apiFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, prompt }),
  });
  if (!session) return;

  state.sessions[session.id] = session;
  state.cwd = cwd;
  saveRecentDir(cwd);
  renderSessionsPanel();
  switchSession(session.id);
  loadTree(cwd);
}

async function resumeClaudeSession(claudeId, cwd) {
  cwd = normCwd(cwd);

  // If this Claude session is already open in some webui session, just switch.
  const existing = Object.values(state.sessions).find(s => s.claude_session_id === claudeId);
  if (existing) {
    switchSession(existing.id);
    return;
  }

  const session = await apiFetch('/api/sessions/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ claude_session_id: claudeId, cwd }),
  });
  if (!session) return;
  state.sessions[session.id] = session;
  state.cwd = cwd;
  saveRecentDir(cwd);
  loadTree(cwd);
  renderSessionsPanel();
  switchSession(session.id);
}

async function switchSession(sessionId) {
  if (state.currentSession && state.currentSession !== sessionId)
    socket.emit('leave_session', { session_id: state.currentSession });

  state.currentSession = sessionId;

  const session = state.sessions[sessionId];
  if (session && session.cwd) {
    const ncwd = normCwd(session.cwd);
    if (ncwd !== state.cwd) {
      state.cwd = ncwd;
      loadTree(ncwd);
    }
  }

  // Show + fit the terminal BEFORE writing any output, otherwise the first
  // session opens with the terminal at 0×0 and content renders mis-wrapped.
  activateTerminalTab();
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  state.term.clear();
  socket.emit('join_session', { session_id: sessionId });

  const data = await apiFetch(`/api/sessions/${sessionId}/output`);
  if (data) {
    if (data.output) state.term.write(data.output);
    setStatusBadge(data.session.status);
    updateTermDot(data.session.status);
  }

  renderSessionsPanel();
  startStatsPolling(sessionId);

  // Force a refit + resize event so the session re-renders at the real
  // viewport size (otherwise the first load comes up mis-wrapped).
  requestAnimationFrame(() => refitTerminal());
}

async function killSessionById(id) {
  if (!confirm(`Kill session ${id}?`)) return;
  await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' });
  socket.emit('leave_session', { session_id: id });
  delete state.sessions[id];

  if (state.currentSession === id) {
    state.currentSession = null;
    state.term.clear();
    setStatusBadge(null);
    updateTermDot(null);
    stopStatsPolling();
  }
  renderSessionsPanel();
}

// shared cache so both session + daily can render into one row
const _statsCache = { session: null, daily: null };

function startStatsPolling(_sessionId) { /* disabled — using ~/.claude/statusline.sh instead */ }
function stopStatsPolling()           { /* disabled */ }

const CONTEXT_MAX = 200_000;

function fmtCost(v) {
  if (!v || v === 0) return '$0.00';
  if (v < 0.0001)   return '<$0.0001';
  if (v < 0.01)     return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtTok(n) {
  return n >= 1_000_000 ? `${(n/1_000_000).toFixed(2)}M`
       : n >= 1_000     ? `${(n/1_000).toFixed(1)}k`
       : `${n}`;
}

function costTip(d) {
  return `Input: ${fmtCost(d.cost_input||0)} · Output: ${fmtCost(d.cost_output||0)} · Cache r: ${fmtCost(d.cost_cache_read||0)} · Cache w: ${fmtCost(d.cost_cache_write||0)}`;
}

function flushStats() {
  const s  = _statsCache.session;
  const dy = _statsCache.daily;

  // ── Model + effort ──────────────────────────────────────────────────────────
  if (s && s.model) {
    const shortModel = s.model.replace('claude-', '');
    const effort     = s.speed && s.speed !== 'standard' ? ` · ${s.speed}` : '';
    el('sb-model').textContent = shortModel + effort;
  }

  if (!s) return;

  // ── Statusbar stats ─────────────────────────────────────────────────────────
  const costSess  = fmtCost(s.cost_usd);
  const costToday = dy ? fmtCost(dy.cost_usd) : null;
  const costLabel = costToday ? `💰 ${costSess} sess / ${costToday} today` : `💰 ${costSess}`;
  const costTitle = costToday
    ? `Session: ${costTip(s)} | Today: ${costTip(dy)}`
    : costTip(s);

  const prompts = dy ? `  ✏️ ${dy.prompts} prompts` : '';

  el('sb-stats').innerHTML =
    `<span title="${costTitle}">${costLabel}</span>` +
    `  📤 ${fmtTok(s.input_tokens)} in` +
    `  📥 ${fmtTok(s.output_tokens)} out` +
    `  📖 ${fmtTok(s.cache_read_tokens)} r` +
    `  💾 ${fmtTok(s.cache_write_tokens)} w` +
    prompts;
}

function formatTimeAgo(isoStr) {
  if (!isoStr) return '';
  const m = Math.floor((Date.now() - new Date(isoStr).getTime()) / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function setStatusBadge(_status) {
  // badge element removed from UI; kept as no-op to avoid breaking callers
}

function updateTermDot() { /* status dot removed */ }

// ─── File tree ────────────────────────────────────────────────────────────────

async function refreshGitBadges() {
  if (!state.cwd) return;
  const data = await apiFetch(`/api/git/status?path=${enc(state.cwd)}`);
  if (!data) return;
  state.gitStatus  = data.files || {};
  state.gitIgnored = new Set(data.ignored || []);

  const cwdPrefix = state.cwd + '/';
  document.querySelectorAll('#file-tree .tree-item').forEach(item => {
    const p = item.dataset.path;
    if (!p) return;
    const rel  = p.startsWith(cwdPrefix) ? p.slice(cwdPrefix.length) : p;
    const name = p.split('/').pop();
    const status  = state.gitStatus[rel] || '';
    const ignored = state.gitIgnored.has(rel) || ALWAYS_DIM.has(name);
    const fgClass = ignored ? 'fg-ignored' : gitStatusClass(status);
    const badge   = ignored ? '' : gitBadge(status);

    const nameEl = item.querySelector('.tree-name');
    if (nameEl) {
      nameEl.classList.remove('fg-modified', 'fg-added', 'fg-deleted', 'fg-untracked', 'fg-ignored');
      if (fgClass) nameEl.classList.add(fgClass);
    }
    const oldBadge = item.querySelector('.tree-badge');
    if (oldBadge) oldBadge.remove();
    if (badge && item.classList.contains('tree-file')) {
      item.insertAdjacentHTML('beforeend', badge);
    }
  });
}

async function loadTree(path) {
  if (!path) return;
  const [nodes, gitData] = await Promise.all([
    apiFetch(`/api/tree?path=${enc(path)}`),
    apiFetch(`/api/git/status?path=${enc(path)}`),
  ]);
  state.gitStatus = (gitData && gitData.files) || {};
  state.gitIgnored = new Set((gitData && gitData.ignored) || []);
  renderTree(nodes || [], el('file-tree'), path);
  attachRootDrop(el('file-tree'), path);
}

function renderTree(nodes, container, basePath) {
  const expanded = new Set();
  container.querySelectorAll('.tree-dir.open').forEach(d => {
    if (d.dataset.path) expanded.add(d.dataset.path);
  });
  container.innerHTML = '';
  state.treeOrder = [];
  renderNodes(nodes, container, basePath, 0, expanded);
  applyTreeSelection();
}

function applyTreeSelection() {
  document.querySelectorAll('#file-tree .tree-item').forEach(n => {
    n.classList.toggle('active', state.treeSelection.has(n.dataset.path));
  });
}

const ALWAYS_DIM = new Set(['.git', '.gitignore', '.dockerignore', '.claude']);

function renderNodes(nodes, parent, basePath, depth, expanded) {
  for (const node of nodes) {
    const rel = node.path.startsWith(basePath + '/') ? node.path.slice(basePath.length + 1) : node.path;
    const status  = state.gitStatus[rel] || '';
    const ignored = (state.gitIgnored && state.gitIgnored.has(rel)) || ALWAYS_DIM.has(node.name);
    const fgClass = ignored ? 'fg-ignored' : gitStatusClass(status);
    const badge   = ignored ? '' : gitBadge(status);
    const item = document.createElement('div');
    item.className = 'tree-item';
    item.dataset.path = node.path;
    item.dataset.type = node.type;
    item.draggable = true;
    item.title = prettyPath(node.path);
    item.style.paddingLeft = `${depth * 12 + 8}px`;
    state.treeOrder.push(node.path);
    attachDragHandlers(item, node);

    if (node.type === 'dir') {
      const isOpen = expanded.has(node.path);
      item.classList.add('tree-dir');
      if (isOpen) item.classList.add('open');
      item.innerHTML =
        `<span class="tree-icon">${isOpen ? '▼' : '▶'}</span>` +
        `<span class="tree-name dir-name ${fgClass}">${esc(node.name)}</span>`;
      const children = document.createElement('div');
      children.className = 'tree-children' + (isOpen ? '' : ' hidden');
      if (node.children && node.children.length) renderNodes(node.children, children, basePath, depth + 1, expanded);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (handleTreeSelectClick(e, node.path)) return;
        // plain click: select + toggle expand
        const open = item.classList.toggle('open');
        children.classList.toggle('hidden', !open);
        item.querySelector('.tree-icon').textContent = open ? '▼' : '▶';
      });
      parent.appendChild(item);
      parent.appendChild(children);
    } else {
      item.classList.add('tree-file');
      item.innerHTML =
        `<span class="tree-icon file-icon">${fileIconHTML(node.name, node.ext)}</span>` +
        `<span class="tree-name file-name ${fgClass}">${esc(node.name)}</span>` +
        badge;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasModified = e.ctrlKey || e.metaKey || e.shiftKey;
        handleTreeSelectClick(e, node.path);
        if (!wasModified) {
          if (isImagePath(node.path)) openImagePreview(node.path);
          else openFile(node.path);
        }
      });
      parent.appendChild(item);
    }
  }
}

// Returns true if the click was a modifier-click (caller should suppress its
// default action like opening a file / toggling a folder).
function handleTreeSelectClick(e, path) {
  if (e.shiftKey && state.treeAnchor) {
    const order = state.treeOrder;
    const a = order.indexOf(state.treeAnchor);
    const b = order.indexOf(path);
    if (a !== -1 && b !== -1) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      state.treeSelection.clear();
      for (let i = lo; i <= hi; i++) state.treeSelection.add(order[i]);
      applyTreeSelection();
      return true;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    if (state.treeSelection.has(path)) state.treeSelection.delete(path);
    else state.treeSelection.add(path);
    state.treeAnchor = path;
    applyTreeSelection();
    return true;
  }
  state.treeSelection.clear();
  state.treeSelection.add(path);
  state.treeAnchor = path;
  applyTreeSelection();
  return false;
}

async function duplicateSelected() {
  const paths = [...state.treeSelection];
  if (!paths.length) {
    alert('No files or folders selected.');
    return;
  }
  const errors = [];
  const newPaths = [];
  for (const src of paths) {
    const r = await apiFetch('/api/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src }),
    });
    if (r && r.dst) newPaths.push(r.dst);
    else errors.push(src);
  }
  if (errors.length) alert('Could not duplicate:\n' + errors.join('\n'));
  state.treeSelection = new Set(newPaths);
  loadTree(state.cwd);
}

async function deleteSelected() {
  const paths = [...state.treeSelection];
  if (!paths.length) {
    alert('No files or folders selected.');
    return;
  }
  const preview = paths.length <= 6
    ? paths.map(p => prettyPath(p)).join('\n')
    : paths.slice(0, 6).map(p => prettyPath(p)).join('\n') + `\n…and ${paths.length - 6} more`;
  if (!confirm(`Delete ${paths.length} item(s)? This cannot be undone.\n\n${preview}`)) return;

  const r = await apiFetch('/api/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });
  if (!r) return;
  // Drop deleted paths from open tabs
  for (const p of (r.deleted || [])) {
    if (state.openTabs[p]) {
      try { state.openTabs[p].model.dispose(); } catch {}
      delete state.openTabs[p];
    }
    state.treeSelection.delete(p);
  }
  if (r.errors && r.errors.length) {
    alert('Some items could not be deleted:\n' + r.errors.map(e => `${e.path}: ${e.error}`).join('\n'));
  }
  loadTree(state.cwd);
}

function attachDragHandlers(item, node) {
  item.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    e.dataTransfer.effectAllowed = 'move';
    let payload;
    if (state.treeSelection.has(node.path) && state.treeSelection.size > 1) {
      payload = JSON.stringify([...state.treeSelection]);
    } else {
      payload = JSON.stringify([node.path]);
    }
    e.dataTransfer.setData('application/x-paths', payload);
    e.dataTransfer.setData('text/plain', node.path);
    item.classList.add('dragging');
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
    document.querySelectorAll('.tree-item.drag-over').forEach(n => n.classList.remove('drag-over'));
  });
  if (node.type === 'dir') {
    item.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('drag-over');
      const sources = readDragSources(e);
      await moveMany(sources, node.path);
    });
  }
}

function readDragSources(e) {
  const blob = e.dataTransfer.getData('application/x-paths');
  if (blob) { try { return JSON.parse(blob); } catch {} }
  const single = e.dataTransfer.getData('text/plain');
  return single ? [single] : [];
}

async function moveMany(sources, destDir) {
  const moved = [];
  for (const src of sources) {
    if (!src || src === destDir) continue;
    if (destDir === src || destDir.startsWith(src + '/')) continue; // can't move into itself
    const name = src.split('/').pop();
    const dst = destDir + '/' + name;
    if (dst === src) continue;
    const r = await apiFetch('/api/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src, dst }),
    });
    if (r) {
      if (state.openTabs[src]) {
        state.openTabs[dst] = state.openTabs[src];
        delete state.openTabs[src];
      }
      moved.push(dst);
    }
  }
  state.treeSelection.clear();
  loadTree(state.cwd);
}

function attachRootDrop(container, basePath) {
  if (container._rootDropAttached) return;
  container._rootDropAttached = true;
  container.addEventListener('dragover', (e) => {
    if (e.target !== container) return;
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    container.classList.add('drag-over-root');
  });
  container.addEventListener('dragleave', (e) => {
    if (e.target === container) container.classList.remove('drag-over-root');
  });
  container.addEventListener('drop', async (e) => {
    if (e.target !== container) return;
    e.preventDefault();
    container.classList.remove('drag-over-root');
    const sources = readDragSources(e);
    await moveMany(sources, basePath);
  });
}

async function createNewEntry(kind) {
  let parentPath = state.cwd;
  const anchorPath = state.treeAnchor;
  if (anchorPath) {
    let anchorEl = null;
    document.querySelectorAll('#file-tree .tree-item').forEach(n => {
      if (n.dataset.path === anchorPath) anchorEl = n;
    });
    if (anchorEl) {
      if (anchorEl.dataset.type === 'dir') {
        parentPath = anchorPath;
      } else {
        parentPath = anchorPath.split('/').slice(0, -1).join('/');
      }
    }
  }
  const name = prompt(kind === 'dir' ? 'New folder name:' : 'New file name:');
  if (!name) return;
  const path = parentPath + '/' + name;
  if (kind === 'dir') {
    const r = await apiFetch('/api/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (r) loadTree(state.cwd);
  } else {
    const r = await apiFetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content: '' }),
    });
    if (r) {
      await loadTree(state.cwd);
      openFile(path);
    }
  }
}

function gitBadge(st) {
  if (!st) return '';
  if (st.includes('M') || st.includes('U')) return '<span class="tree-badge bg-modified">M</span>';
  if (st.includes('A')) return '<span class="tree-badge bg-added">A</span>';
  if (st.includes('D')) return '<span class="tree-badge bg-deleted">D</span>';
  if (st.includes('?')) return '<span class="tree-badge bg-untracked">?</span>';
  return '';
}

function gitStatusClass(st) {
  if (!st) return '';
  if (st.includes('M') || st.includes('U')) return 'fg-modified';
  if (st.includes('A')) return 'fg-added';
  if (st.includes('D')) return 'fg-deleted';
  if (st.includes('?')) return 'fg-untracked';
  return '';
}

// ─── Git panel ────────────────────────────────────────────────────────────────

async function loadGitPanel() {
  const host = el('git-panel');
  host.innerHTML = '<div class="git-empty">Loading…</div>';
  const data = await apiFetch(`/api/git/info?path=${enc(state.cwd)}`);
  if (!data || !data.is_git) {
    host.innerHTML = '<div class="git-empty">Not a git repository.<br><span class="dim">Run <code>git init</code> in this directory.</span></div>';
    return;
  }
  renderGitPanel(data);
}

function renderGitPanel(data) {
  const host = el('git-panel');
  const st = data.status || {};
  const trackingBits = [];
  if (st.ahead)  trackingBits.push(`<span class="git-pill git-pill-ahead">↑${st.ahead}</span>`);
  if (st.behind) trackingBits.push(`<span class="git-pill git-pill-behind">↓${st.behind}</span>`);

  const statusBits = [];
  if (st.staged)    statusBits.push(`<span class="git-pill git-pill-staged">${st.staged} staged</span>`);
  if (st.modified)  statusBits.push(`<span class="git-pill git-pill-modified">${st.modified} modified</span>`);
  if (st.untracked) statusBits.push(`<span class="git-pill git-pill-untracked">${st.untracked} untracked</span>`);
  if (!statusBits.length) statusBits.push('<span class="git-pill git-pill-clean">clean</span>');

  const remoteHTML = data.remote_url
    ? `<div class="git-remote" title="${esc(data.remote_url)}">${esc(data.remote_url)}</div>`
    : '<div class="git-remote dim">no remote</div>';

  host.innerHTML = `
    <div class="git-section git-head">
      <div class="git-branch-row">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
          <circle cx="4" cy="4" r="1.6"/>
          <circle cx="4" cy="12" r="1.6"/>
          <circle cx="12" cy="9" r="1.6"/>
          <line x1="4" y1="5.6" x2="4" y2="10.4"/>
          <path d="M4 7.5c0 1.5 1 2.5 3 2.5h3.5"/>
        </svg>
        <span class="git-branch">${esc(data.branch || '(detached)')}</span>
        <span class="git-sha">${esc(data.head_short || '')}</span>
        ${trackingBits.join('')}
      </div>
      ${remoteHTML}
      <div class="git-status-row">${statusBits.join('')}</div>
    </div>

    <div class="git-section">
      <div class="git-section-title">Branches <span class="dim">(${data.branches.length})</span></div>
      <div class="git-list">
        ${data.branches.map(b =>
          `<div class="git-row${b.current ? ' current' : ''}" title="${esc(b.name)}">
            <span class="git-row-icon">${b.current ? '●' : '○'}</span>
            <span class="git-row-name">${esc(b.name)}</span>
          </div>`
        ).join('')}
      </div>
    </div>

    ${data.tags.length ? `
    <div class="git-section">
      <div class="git-section-title">Tags <span class="dim">(${data.tags.length})</span></div>
      <div class="git-list">
        ${data.tags.map(t => `<div class="git-row"><span class="git-row-icon">⌬</span><span class="git-row-name">${esc(t)}</span></div>`).join('')}
      </div>
    </div>` : ''}

    <div class="git-section">
      <div class="git-section-title">Commits <span class="dim">(${data.commits.length})</span></div>
      <div class="git-list" id="git-commits">
        ${data.commits.map(c => {
          const stats = [];
          if (c.files) stats.push(`<span class="git-stat-files">${c.files}</span>`);
          if (c.add)   stats.push(`<span class="git-stat-add">+${c.add}</span>`);
          if (c.del)   stats.push(`<span class="git-stat-del">−${c.del}</span>`);
          return `
            <div class="git-commit" data-rev="${esc(c.hash)}" data-subject="${esc(c.subject)}" title="${esc(c.subject)}">
              <div class="git-commit-row">
                <span class="git-sha">${esc(c.short_hash)}</span>
                <span class="git-commit-subject">${esc(c.subject)}</span>
                <span class="git-commit-stats">${stats.join('')}</span>
              </div>
              <div class="git-commit-meta">
                <span>${esc(c.author)}</span>
                <span class="dim">·</span>
                <span class="dim" title="${esc(c.date_iso)}">${esc(c.date_rel)}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  host.querySelectorAll('.git-commit').forEach(row => {
    row.addEventListener('click', () => openDiffTab(row.dataset.rev, row.dataset.subject));
  });
}

async function openDiffTab(rev, subject) {
  const path = `git:show:${rev}`;
  const tabName = rev.slice(0, 7);

  if (state.openTabs[path] && state.openTabs[path].commit) {
    state.currentFile = path;
    activateDiffPane();
    renderDiffInPane(state.openTabs[path].commit);
    addDiffTab(path, tabName, subject);
    return;
  }

  const data = await apiFetch(`/api/git/show?path=${enc(state.cwd)}&rev=${enc(rev)}`);
  if (!data || data.error) {
    alert('Failed to load diff: ' + ((data && data.error) || 'unknown'));
    return;
  }
  state.currentFile = path;
  activateDiffPane();
  renderDiffInPane(data);
  state.openTabs[path] = { commit: data, isDiff: true };
  addDiffTab(path, tabName, subject);
}

function renderDiffInPane(c) {
  const target = el('diff-pane');
  target.innerHTML = '';

  // ── Commit metadata header ─────────────────────────────────────────
  const a = c.author || {};
  const totalAdd = c.files.reduce((n, f) => n + (f.add || 0), 0);
  const totalDel = c.files.reduce((n, f) => n + (f.del || 0), 0);
  const dateStr  = a.date ? new Date(a.date).toLocaleString() : '';

  const meta = document.createElement('div');
  meta.className = 'diff-meta';
  meta.innerHTML = `
    <div class="diff-meta-top">
      <span class="git-sha">${esc(c.short_hash)}</span>
      <span class="diff-meta-subject">${esc(c.subject || '')}</span>
    </div>
    <div class="diff-meta-author">
      <span class="diff-meta-name">${esc(a.name || '')}</span>
      ${a.email ? `<span class="dim">&lt;${esc(a.email)}&gt;</span>` : ''}
      <span class="dim">·</span>
      <span class="dim" title="${esc(a.date || '')}">${esc(dateStr)}</span>
    </div>
    ${c.body ? `<pre class="diff-meta-body">${esc(c.body)}</pre>` : ''}
    <div class="diff-meta-stats">
      <span class="diff-stat-pill"><strong>${c.files.length}</strong> file${c.files.length === 1 ? '' : 's'}</span>
      <span class="diff-stat-pill diff-stat-add">+${totalAdd}</span>
      <span class="diff-stat-pill diff-stat-del">−${totalDel}</span>
      ${c.files_truncated ? `<span class="diff-stat-pill dim">+${c.files_truncated} more not shown</span>` : ''}
    </div>
  `;
  target.appendChild(meta);

  // ── Files ────────────────────────────────────────────────────────
  for (const f of c.files) {
    if (f.too_large) {
      target.appendChild(renderTooLargeFile(f));
    } else if (f.patch) {
      target.appendChild(renderFileDiff(f));
    }
  }

  if (c.files_truncated > 0) {
    const ft = document.createElement('div');
    ft.className = 'diff-truncated-footer';
    ft.textContent = `+${c.files_truncated} more file${c.files_truncated === 1 ? '' : 's'} hidden for brevity`;
    target.appendChild(ft);
  }
}

function renderTooLargeFile(f) {
  const ph = document.createElement('div');
  ph.className = 'diff-too-large';
  ph.innerHTML =
    `<span class="diff-too-large-icon">⚠</span>` +
    `<strong>${esc(f.path)}</strong> ` +
    `<span class="dim">— diff too large to render (${f.line_count} lines, ` +
    `<span class="diff-stat-add">+${f.add}</span> ` +
    `<span class="diff-stat-del">−${f.del}</span>)</span>`;
  return ph;
}

function renderFileDiff(f) {
  const parsed = parseFilePatch(f.patch);
  const lang   = hljsLangFor(f.path);
  const wrap   = document.createElement('div');
  wrap.className = 'dfile';

  // Header bar
  const header = document.createElement('div');
  header.className = 'dfile-header';
  header.innerHTML =
    `<span class="dfile-caret">▾</span>` +
    `<span class="dfile-name">${esc(f.path)}</span>` +
    `<span class="dfile-stats">` +
      (f.add ? `<span class="diff-stat-add">+${f.add}</span>` : '') +
      (f.del ? `<span class="diff-stat-del">−${f.del}</span>` : '') +
    `</span>` +
    `<button class="dfile-toggle" type="button">hide</button>`;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'dfile-body';
  const inner = document.createElement('div');
  inner.className = 'dfile-body-inner';
  body.appendChild(inner);
  for (const r of parsed.rows) {
    if (r.kind === 'hunk') {
      const row = document.createElement('div');
      row.className = 'drow drow-hunk';
      row.innerHTML = `<span class="dhunk">${esc(r.text)}</span>`;
      inner.appendChild(row);
      continue;
    }
    if (r.kind === 'note') {
      const row = document.createElement('div');
      row.className = 'drow drow-note';
      row.innerHTML = `<span class="dnote">${esc(r.text)}</span>`;
      inner.appendChild(row);
      continue;
    }
    const row = document.createElement('div');
    row.className = `drow drow-${r.kind}`;
    const sigil = r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' ';
    const code  = highlightLine(r.text, lang);
    row.innerHTML =
      `<span class="dnum dnum-old">${r.oldNum || ''}</span>` +
      `<span class="dnum dnum-new">${r.newNum || ''}</span>` +
      `<span class="dprefix">${sigil}</span>` +
      `<span class="dcode">${code}</span>`;
    inner.appendChild(row);
  }
  wrap.appendChild(body);

  // Click-to-collapse header
  const toggle = () => {
    wrap.classList.toggle('collapsed');
    header.querySelector('.dfile-toggle').textContent =
      wrap.classList.contains('collapsed') ? 'show' : 'hide';
  };
  header.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    toggle();
  });
  return wrap;
}

// ─── Unified diff parser ──────────────────────────────────────────────────────

function parseFilePatch(patch) {
  const lines = patch.split('\n');
  const rows  = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('@@')) i++;

  let oldN = 0, newN = 0;
  for (; i < lines.length; i++) {
    const ln = lines[i];
    if (ln === '' && i === lines.length - 1) break;
    if (ln.startsWith('@@')) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (m) { oldN = parseInt(m[1], 10); newN = parseInt(m[2], 10); }
      rows.push({ kind: 'hunk', text: ln });
      continue;
    }
    if (ln.startsWith('\\')) { rows.push({ kind: 'note', text: ln }); continue; }
    if (ln.startsWith('+')) {
      rows.push({ kind: 'add', oldNum: '', newNum: newN++, text: ln.slice(1) });
    } else if (ln.startsWith('-')) {
      rows.push({ kind: 'del', oldNum: oldN++, newNum: '', text: ln.slice(1) });
    } else {
      const text = ln.startsWith(' ') ? ln.slice(1) : ln;
      rows.push({ kind: 'ctx', oldNum: oldN++, newNum: newN++, text });
    }
  }
  return { rows };
}

function hljsLangFor(path) {
  const name = (path || '').split('/').pop().toLowerCase();
  if (name === 'dockerfile' || name.startsWith('dockerfile')) return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  const map = {
    py: 'python', pyi: 'python',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    html: 'xml', htm: 'xml', xhtml: 'xml', svg: 'xml', xml: 'xml',
    css: 'css', scss: 'scss', less: 'less', sass: 'scss',
    json: 'json', md: 'markdown', mdx: 'markdown',
    sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini',
    rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby',
    c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', php: 'php', swift: 'swift', dart: 'dart',
    lua: 'lua', pl: 'perl', sql: 'sql', diff: 'diff', vim: 'vim',
  };
  return map[ext] || '';
}

function highlightLine(text, lang) {
  if (!text) return '';
  if (!lang || !window.hljs) return esc(text);
  try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; }
  catch { return esc(text); }
}

function addDiffTab(path, tabName, subject) {
  const tabs = el('tab-list');
  const existing = tabs.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (existing) {
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    existing.classList.add('active');
    el('tab-terminal').classList.remove('active');
    existing.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.dataset.path = path;
  tab.title = subject ? `${tabName} — ${subject}` : tabName;
  tab.style.setProperty('--tab-color', 'var(--purple)');
  tab.innerHTML =
    `<span class="tab-ftype"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4" cy="4" r="1.6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="9" r="1.6"/><line x1="4" y1="5.6" x2="4" y2="10.4"/><path d="M4 7.5c0 1.5 1 2.5 3 2.5h3.5"/></svg></span>` +
    `<span class="tab-name">${esc(tabName)}</span>` +
    `<span class="tab-close" title="Close">×</span>`;
  tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    el('tab-terminal').classList.remove('active');
    const entry = state.openTabs[path];
    if (entry && entry.commit) {
      state.currentFile = path;
      activateDiffPane();
      renderDiffInPane(entry.commit);
    }
  });
  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = tab.classList.contains('active');
    delete state.openTabs[path];
    tab.remove();
    if (wasActive) {
      const remaining = tabs.querySelectorAll('.tab:not(.tab-pinned)');
      if (remaining.length) {
        const last = remaining[remaining.length - 1];
        last.click();
      } else {
        state.currentFile = null;
        state.editor && state.editor.updateOptions({ readOnly: false });
        showWelcome();
      }
    }
    updateTabScrollUI();
  });
  tabs.appendChild(tab);
  updateTabScrollUI();
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ─── Code search ──────────────────────────────────────────────────────────────

function initSearch() {
  const input = el('search-input');
  if (!input) return;
  let timer = null;
  let lastReq = 0;
  const trigger = () => {
    clearTimeout(timer);
    const q = input.value;
    if (!q || q.length < 2) {
      el('search-results').innerHTML = '';
      el('search-status').textContent = '';
      return;
    }
    timer = setTimeout(() => runSearch(q, ++lastReq, () => lastReq), 250);
  };
  input.addEventListener('input', trigger);
  el('search-include').addEventListener('input', trigger);
  el('search-exclude').addEventListener('input', trigger);
}

async function runSearch(query, reqId, getCurrentReqId) {
  el('search-status').textContent = 'Searching…';
  const inc = el('search-include').value.trim();
  const exc = el('search-exclude').value.trim();
  let url = `/api/search?path=${enc(state.cwd)}&q=${enc(query)}`;
  if (inc) url += `&include=${enc(inc)}`;
  if (exc) url += `&exclude=${enc(exc)}`;
  const data = await apiFetch(url);
  if (reqId !== getCurrentReqId()) return;
  if (!data) { el('search-status').textContent = 'Search failed'; return; }
  if (data.error) { el('search-status').textContent = data.error; return; }
  renderSearchResults(data.results || [], data.truncated, query);
}

function renderSearchResults(results, truncated, query) {
  const list = el('search-results');
  list.innerHTML = '';
  if (!results.length) {
    el('search-status').textContent = 'No results';
    return;
  }
  const matchCount = results.reduce((n, r) => n + r.matches.length, 0);
  el('search-status').textContent =
    `${matchCount} match${matchCount === 1 ? '' : 'es'} in ${results.length} file${results.length === 1 ? '' : 's'}` +
    (truncated ? ' (truncated)' : '');

  const qLower = query.toLowerCase();
  for (const r of results) {
    const file = document.createElement('div');
    file.className = 'search-file';
    const header = document.createElement('div');
    header.className = 'search-file-header';
    const slash = r.rel.lastIndexOf('/');
    const fname = slash >= 0 ? r.rel.slice(slash + 1) : r.rel;
    const fdir  = slash >= 0 ? r.rel.slice(0, slash) : '';
    header.innerHTML =
      `<span class="search-file-icon">${fileIconHTML(fname, (fname.includes('.') ? fname.split('.').pop() : '').toLowerCase())}</span>` +
      `<span class="search-file-fname">${esc(fname)}</span>` +
      (fdir ? `<span class="search-file-fdir">${esc(fdir)}</span>` : '') +
      `<span class="search-file-count">${r.matches.length}</span>`;
    header.title = r.rel;
    file.appendChild(header);
    for (const m of r.matches) {
      const row = document.createElement('div');
      row.className = 'search-match';
      row.innerHTML =
        `<span class="search-line-num">${m.line}</span>` +
        `<span class="search-line-text">${highlightMatch(m.text, qLower)}</span>`;
      row.title = `${r.rel}:${m.line}`;
      row.addEventListener('click', () => openFile(r.path, m.line));
      file.appendChild(row);
    }
    list.appendChild(file);
  }
}

function highlightMatch(text, qLower) {
  const lower = text.toLowerCase();
  let out = '';
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) { out += esc(text.slice(i)); break; }
    out += esc(text.slice(i, idx));
    out += `<mark>${esc(text.slice(idx, idx + qLower.length))}</mark>`;
    i = idx + qLower.length;
  }
  return out;
}

// Material Icon Theme CDN — flat, modern file-type icons that pair nicely
// with the GitHub-dark palette.
const ICON_CDN = 'https://cdn.jsdelivr.net/npm/material-icon-theme/icons/';

const ICON_BY_NAME = {
  'dockerfile': 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker',
  '.dockerignore': 'docker',
  'makefile': 'makefile',
  'package.json': 'nodejs', 'package-lock.json': 'npm', 'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'tsconfig.json': 'tsconfig',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  '.env': 'settings', '.env.local': 'settings', '.envrc': 'settings',
  'readme.md': 'readme', 'readme': 'readme',
  'license': 'license', 'license.md': 'license', 'license.txt': 'license',
  'pyproject.toml': 'python', 'setup.py': 'python',
  'pipfile': 'python', 'pipfile.lock': 'python',
  '.eslintrc': 'eslint', '.eslintrc.js': 'eslint', '.eslintrc.json': 'eslint',
  '.prettierrc': 'prettier', '.prettierrc.json': 'prettier',
  'cargo.toml': 'rust', 'cargo.lock': 'rust',
  'go.mod': 'go', 'go.sum': 'go',
  'webpack.config.js': 'webpack', 'vite.config.js': 'vite', 'vite.config.ts': 'vite',
  '.babelrc': 'babel',
};

const ICON_BY_EXT = {
  py: 'python', pyi: 'python', ipynb: 'jupyter',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'react',
  ts: 'typescript', tsx: 'react_ts',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', less: 'less', sass: 'sass',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'markdown', mdx: 'markdown', txt: 'document', rst: 'document',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console', ps1: 'powershell',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'settings', conf: 'settings', cfg: 'settings',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', rb: 'ruby',
  c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  h: 'h', hpp: 'h', hxx: 'h',
  cs: 'csharp', php: 'php', swift: 'swift', vue: 'vue', svelte: 'svelte',
  dart: 'dart', lua: 'lua', pl: 'perl', ex: 'elixir', exs: 'elixir',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image',
  bmp: 'image', tiff: 'image', avif: 'image',
  svg: 'svg',
  mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio',
  pdf: 'pdf',
  zip: 'zip', tar: 'zip', gz: 'zip', rar: 'zip', '7z': 'zip', xz: 'zip', bz2: 'zip',
  sql: 'database', xml: 'xml', csv: 'table',
  log: 'log', lock: 'lock', vim: 'vim',
  dockerfile: 'docker',
  diff: 'diff', patch: 'diff',
  tex: 'tex',
};

function fileIconHTML(name, ext) {
  const lower = (name || '').toLowerCase();
  let icon = ICON_BY_NAME[lower];
  if (!icon) {
    if (lower === '.env' || lower.startsWith('.env.') || lower.endsWith('.env')) icon = 'settings';
    else if (lower === 'dockerfile' || lower.startsWith('dockerfile') || lower.endsWith('.dockerfile')) icon = 'docker';
    else if (lower === 'makefile' || lower.startsWith('makefile')) icon = 'makefile';
  }
  if (!icon) icon = ICON_BY_EXT[(ext || '').toLowerCase()];
  const url = icon ? `${ICON_CDN}${icon}.svg` : `${ICON_CDN}file.svg`;
  const fallback = `${ICON_CDN}file.svg`;
  return `<img class="ftype" src="${url}" loading="lazy" decoding="async" onerror="this.onerror=null;this.src='${fallback}'">`;
}

// ─── File editing ─────────────────────────────────────────────────────────────

async function openFile(path, line) {
  const lang = pathToLang(path);

  // If we already have this file's model open, just re-attach it (preserves
  // unsaved edits + cursor/scroll position).
  if (state.openTabs[path]) {
    state.currentFile = path;
    activateEditorPane();
    updateMdPreviewButton();
    whenMonaco(() => {
      state.editor.setModel(state.openTabs[path].model);
      state.editor.updateOptions({ readOnly: false });
      el('status-lang').textContent = lang;
      el('status-file').textContent = prettyPath(path);
      applyGitGutter(path);
      updateStatusFile();
      updateStatusCursor();
      updateMdPreviewButton();
      if (typeof line === 'number' && line > 0) {
        requestAnimationFrame(() => {
          state.editor.revealLineInCenter(line);
          state.editor.setPosition({ lineNumber: line, column: 1 });
          state.editor.focus();
        });
      }
    });
    addTab(path);
    return;
  }

  const data = await apiFetch(`/api/file?path=${enc(path)}`);
  if (!data) return;
  state.currentFile = path;
  activateEditorPane();
  updateMdPreviewButton();

  whenMonaco(() => {
    const model = monaco.editor.createModel(data.content, lang);
    const entry = { model, language: lang, savedContent: data.content, dirty: false };
    entry.changeListener = model.onDidChangeContent(() => {
      const isDirty = model.getValue() !== entry.savedContent;
      if (isDirty !== entry.dirty) {
        entry.dirty = isDirty;
        setTabDirty(path, isDirty);
      }
    });
    state.openTabs[path] = entry;
    state.editor.setModel(entry.model);
    state.editor.updateOptions({ readOnly: false });
    el('status-lang').textContent = lang;
    el('status-file').textContent = prettyPath(path);
    applyGitGutter(path);
    updateMdPreviewButton();
    if (typeof line === 'number' && line > 0) {
      requestAnimationFrame(() => {
        state.editor.revealLineInCenter(line);
        state.editor.setPosition({ lineNumber: line, column: 1 });
        state.editor.focus();
      });
    }
  });

  addTab(path);
}

function updateStatusCursor() {
  const ed = state.editor;
  if (!ed) return;
  const sel = ed.getSelection();
  const model = ed.getModel();
  const pos = ed.getPosition();
  const cursorEl = el('status-cursor');
  if (!cursorEl) return;
  if (sel && !sel.isEmpty() && model) {
    const text = model.getValueInRange(sel);
    const chars = text.length;
    const lines = sel.endLineNumber - sel.startLineNumber + 1;
    cursorEl.textContent = lines > 1
      ? `${chars} sel (${lines} lines)`
      : `${chars} sel`;
  } else if (pos) {
    cursorEl.textContent = `Ln ${pos.lineNumber}, Col ${pos.column}`;
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function updateStatusFile() {
  const ed = state.editor;
  if (!ed) return;
  const model = ed.getModel();
  if (!model) return;

  // Size + line count
  const sizeEl = el('status-size');
  if (sizeEl) {
    const text = model.getValue();
    const bytes = new TextEncoder().encode(text).length;
    const lines = model.getLineCount();
    sizeEl.textContent = `${formatBytes(bytes)} · ${lines} ln`;
  }

  // Indent style
  const indentEl = el('status-indent');
  if (indentEl) {
    const opts = model.getOptions();
    indentEl.textContent = `${opts.insertSpaces ? 'Spaces' : 'Tabs'}: ${opts.tabSize}`;
  }

  // EOL
  const eolEl = el('status-eol');
  if (eolEl) {
    eolEl.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  }
}

async function applyGitGutter(path) {
  if (!state.editor || !path) return;
  const data = await apiFetch(`/api/git/file-diff?path=${enc(path)}`);
  const lines = (data && data.lines) || [];
  const decs = lines.map(ln => ({
    range: new monaco.Range(ln, 1, ln, 1),
    options: { isWholeLine: false, linesDecorationsClassName: 'gutter-modified' },
  }));
  const old = state.gutterDecs.get(path) || [];
  const ids = state.editor.deltaDecorations(old, decs);
  state.gutterDecs.set(path, ids);
}

const TAB_PALETTE = [
  '#79c0ff', // blue
  '#a371f7', // purple
  '#3fb950', // green
  '#db61a2', // pink
  '#56d4dd', // cyan
  '#e3b341', // yellow
  '#db6d28', // orange
  '#ffa198', // coral
];

function tabColor(path) {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = Math.imul(h * 31 + path.charCodeAt(i), 1) >>> 0;
  return TAB_PALETTE[h % TAB_PALETTE.length];
}

function addTab(path) {
  const tabs = el('tab-list');
  const existing = tabs.querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (existing) {
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    existing.classList.add('active');
    el('tab-terminal').classList.remove('active');
    existing.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }

  const name  = path.split('/').pop();
  const color = tabColor(path);
  const dot   = name.lastIndexOf('.');
  const ext   = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const tab   = document.createElement('div');
  tab.className = 'tab active';
  tab.dataset.path = path;
  tab.title = prettyPath(path);
  tab.style.setProperty('--tab-color', color);
  tab.innerHTML =
    `<span class="tab-ftype">${fileIconHTML(name, ext)}</span>` +
    `<span class="tab-name">${esc(name)}</span>` +
    `<span class="tab-close" title="Close">×</span>`;

  tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));

  tab.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    tabs.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    el('tab-terminal').classList.remove('active');
    openFile(path);
  });

  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation();
    const wasActive = tab.classList.contains('active');
    if (state.openTabs[path]) {
      try { state.openTabs[path].changeListener?.dispose(); } catch {}
      state.openTabs[path].model.dispose();
      delete state.openTabs[path];
    }
    tab.remove();
    if (wasActive) {
      const remaining = tabs.querySelectorAll('.tab:not(.tab-pinned)');
      if (remaining.length) {
        const last = remaining[remaining.length - 1];
        const lp = last.dataset.path || '';
        if (lp.startsWith('git:show:') || lp.startsWith('md:') || lp.startsWith('img:')) last.click();
        else { last.classList.add('active'); openFile(lp); }
      } else {
        state.currentFile = null;
        showWelcome();
      }
    }
    updateTabScrollUI();
  });

  tabs.appendChild(tab);
  updateTabScrollUI();
  tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateTabScrollUI() {
  const list = el('tab-list');
  const left = el('tab-scroll-left');
  const right = el('tab-scroll-right');
  if (!list || !left || !right) return;
  const overflow = list.scrollWidth > list.clientWidth + 1;
  left.classList.toggle('hidden', !overflow);
  right.classList.toggle('hidden', !overflow);
  if (!overflow) return;
  const atStart = list.scrollLeft <= 0;
  const atEnd   = list.scrollLeft + list.clientWidth >= list.scrollWidth - 1;
  left.disabled = atStart;
  right.disabled = atEnd;
}

async function saveFile() {
  if (!state.currentFile || !state.editor) return;
  const path = state.currentFile;
  const content = state.editor.getValue();
  const ok = await apiFetch('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  if (ok) {
    const entry = state.openTabs[path];
    if (entry) {
      entry.savedContent = content;
      entry.dirty = false;
      setTabDirty(path, false);
    }
    const btn = el('btn-save');
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = 'Save'; }, 1200);
    loadTree(state.cwd);
    applyGitGutter(path);
  }
}

function setTabDirty(path, dirty) {
  const tab = el('tab-list').querySelector(`[data-path="${CSS.escape(path)}"]`);
  if (tab) tab.classList.toggle('tab-dirty', !!dirty);
}

async function autosaveDirtyTabs() {
  const paths = Object.keys(state.openTabs);
  for (const path of paths) {
    const entry = state.openTabs[path];
    if (!entry || !entry.model || !entry.dirty) continue;
    const content = entry.model.getValue();
    const ok = await apiFetch('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    if (ok) {
      entry.savedContent = content;
      entry.dirty = false;
      setTabDirty(path, false);
      if (state.currentFile === path) applyGitGutter(path);
    }
  }
  loadTree(state.cwd);
}

// ─── Sidebar resize ───────────────────────────────────────────────────────────

function makeResizableH(handleId, targetId) {
  const handle = el(handleId);
  const target = el(targetId);
  let dragging = false, startX = 0, startW = 0;

  function startDrag(clientX) {
    dragging = true; startX = clientX; startW = target.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }
  function moveDrag(clientX) {
    if (!dragging) return;
    const w = Math.max(120, Math.min(startW + (clientX - startX), window.innerWidth * .6));
    target.style.width = w + 'px'; target.style.flex = 'none';
  }
  function endDrag() {
    if (!dragging) return;
    dragging = false; handle.classList.remove('dragging');
    document.body.style.cursor = ''; document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(e.clientX); });
  document.addEventListener('mousemove', (e) => moveDrag(e.clientX));
  document.addEventListener('mouseup', endDrag);

  handle.addEventListener('touchstart', (e) => { e.preventDefault(); startDrag(e.touches[0].clientX); }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (dragging) { e.preventDefault(); moveDrag(e.touches[0].clientX); } }, { passive: false });
  document.addEventListener('touchend', endDrag);
}

// ─── Language map ─────────────────────────────────────────────────────────────

function pathToLang(path) {
  const name = (path.split('/').pop() || '').toLowerCase();
  // Filename-first matches (extension-less or special)
  const byName = {
    'dockerfile': 'dockerfile',
    'containerfile': 'dockerfile',
    'makefile': 'shell',
    'gnumakefile': 'shell',
    'cmakelists.txt': 'cmake',
    '.gitignore': 'plaintext', '.dockerignore': 'plaintext',
    '.env': 'dotenv', '.envrc': 'shell',
  };
  if (byName[name]) return byName[name];
  if (name.startsWith('dockerfile') || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name.startsWith('makefile') || name.endsWith('.mk')) return 'shell';
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'dotenv';
  // Extract real extension (only after a dot in the basename)
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return extToLang(ext);
}

function extToLang(ext) {
  const m = {
    py:'python', pyw:'python',
    js:'javascript', mjs:'javascript', ts:'typescript', jsx:'javascript', tsx:'typescript',
    html:'html', htm:'html', css:'css', scss:'scss', less:'less',
    json:'json', jsonc:'json', md:'markdown', mdx:'markdown',
    sh:'shell', bash:'shell', zsh:'shell', yaml:'yaml', yml:'yaml', toml:'ini', ini:'ini',
    rs:'rust', go:'go', java:'java', kt:'kotlin', rb:'ruby', php:'php',
    c:'c', h:'c', cpp:'cpp', cc:'cpp', hpp:'cpp', cs:'csharp', fs:'fsharp',
    swift:'swift', dart:'dart', sql:'sql', graphql:'graphql', xml:'xml',
    r:'r', dockerfile:'dockerfile', vue:'html', svelte:'html',
  };
  return m[ext] || 'plaintext';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(id)  { return document.getElementById(id); }
function enc(s)  { return encodeURIComponent(s); }
function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function apiFetch(url, opts) {
  try {
    const r = await fetch(url, opts);
    if (!r.ok) { console.error('API error', url, await r.text()); return null; }
    return r.json();
  } catch (e) { console.error('fetch failed', url, e); return null; }
}
