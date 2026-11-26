/*
Pen to LaTeX - plugin Obsidian
Bundle generato da main.ts con "npm run build": non modificare a mano.
*/

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => PenToLatexPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/settings.ts
var import_obsidian = require("obsidian");

// src/backend.ts
var BackendError = class extends Error {
};
function join(base, path) {
  return base.replace(/\/+$/, "") + path;
}
async function postJson(url, body, signal, timeoutMs = 12e4) {
  var _a;
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal == null ? void 0 : signal.addEventListener("abort", onAbort);
  try {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } catch (e) {
      if (signal == null ? void 0 : signal.aborted) throw e;
      throw new BackendError("backend non raggiungibile");
    }
    let data;
    try {
      data = await res.json();
    } catch (e) {
      throw new BackendError(`risposta non valida (HTTP ${res.status})`);
    }
    if (!res.ok || (data == null ? void 0 : data.error)) {
      throw new BackendError((_a = data == null ? void 0 : data.error) != null ? _a : `HTTP ${res.status}`);
    }
    return data;
  } finally {
    window.clearTimeout(timer);
    signal == null ? void 0 : signal.removeEventListener("abort", onAbort);
  }
}
async function recognizeLines(base, images, signal) {
  const data = await postJson(join(base, "/predict"), { images }, signal);
  if (!Array.isArray(data.results) || data.results.length !== images.length) {
    throw new BackendError("risposta del backend incompleta");
  }
  return data.results;
}
async function saveCorrection(base, image, predicted, corrected) {
  const data = await postJson(join(base, "/save_correction"), { image, predicted, corrected }, void 0, 15e3);
  return data.warning;
}
async function health(base) {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 4e3);
  try {
    const res = await fetch(join(base, "/health"), { signal: ctrl.signal });
    return await res.json();
  } catch (e) {
    throw new BackendError("backend non raggiungibile");
  } finally {
    window.clearTimeout(timer);
  }
}

// src/settings.ts
var DEFAULT_SETTINGS = {
  backendUrl: "http://127.0.0.1:5005",
  autoRecognize: true,
  autoDelayMs: 800,
  compactHeight: 200,
  largeHeight: 480,
  startLarge: false,
  splitLines: true,
  guideSpacing: 110,
  multilineFormat: "aligned",
  insertInline: false,
  saveExamples: true
};
var PenSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, host) {
    super(app, host);
    this.host = host;
  }
  display() {
    const { containerEl } = this;
    const s = this.host.settings;
    const save = () => this.host.saveSettings();
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Indirizzo del backend").setDesc("Dove gira backend.py (default http://127.0.0.1:5005).").addText((t) => t.setValue(s.backendUrl).onChange(async (v) => {
      s.backendUrl = v.trim() || DEFAULT_SETTINGS.backendUrl;
      await save();
    })).addButton((b) => b.setButtonText("Verifica").onClick(async () => {
      var _a;
      b.setDisabled(true);
      try {
        const h = await health(s.backendUrl);
        b.setButtonText(`OK \xB7 ${(_a = h.checkpoint) != null ? _a : "?"}`);
      } catch (e) {
        b.setButtonText("Non raggiungibile");
      } finally {
        b.setDisabled(false);
      }
    }));
    new import_obsidian.Setting(containerEl).setName("Riconoscimento").setHeading();
    new import_obsidian.Setting(containerEl).setName("Riconoscimento automatico").setDesc("Riconosce da solo quando smetti di scrivere. Solo le righe modificate vengono rielaborate.").addToggle((t) => t.setValue(s.autoRecognize).onChange(async (v) => {
      s.autoRecognize = v;
      await save();
    }));
    new import_obsidian.Setting(containerEl).setName("Attesa prima del riconoscimento (ms)").setDesc("Pausa dopo l'ultimo tratto. Pi\xF9 alta = meno carico sulla CPU.").addSlider((sl) => sl.setLimits(300, 3e3, 100).setValue(s.autoDelayMs).setDynamicTooltip().onChange(async (v) => {
      s.autoDelayMs = v;
      await save();
    }));
    new import_obsidian.Setting(containerEl).setName("Pi\xF9 righe").setDesc("Divide la scrittura in righe (es. i passaggi di un esercizio) e le riconosce separatamente. Lascia spazio tra una riga e l'altra.").addToggle((t) => t.setValue(s.splitLines).onChange(async (v) => {
      s.splitLines = v;
      await save();
    }));
    new import_obsidian.Setting(containerEl).setName("Formato con pi\xF9 righe").addDropdown((d) => d.addOption("aligned", "Allineate sul segno = (aligned)").addOption("gathered", "Centrate (gathered)").addOption("separate", "Un blocco $$ per riga").setValue(s.multilineFormat).onChange(async (v) => {
      s.multilineFormat = v;
      await save();
    }));
    new import_obsidian.Setting(containerEl).setName("Inserisci inline ($\u2026$)").setDesc("Altrimenti blocco $$\u2026$$. Tieni premuto Maiusc mentre inserisci per usare l'altro formato.").addToggle((t) => t.setValue(s.insertInline).onChange(async (v) => {
      s.insertInline = v;
      await save();
    }));
    new import_obsidian.Setting(containerEl).setName("Pannello").setHeading();
    new import_obsidian.Setting(containerEl).setName("Apri grande").setDesc("Apre direttamente il pannello grande (per esercizi interi).").addToggle((t) => t.setValue(s.startLarge).onChange(async (v) => {
      s.startLarge = v;
      await save();
    }));
    const num = (name, desc, get, set, min, max) => new import_obsidian.Setting(containerEl).setName(name).setDesc(desc).addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(get())).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= min && n <= max) {
          set(Math.round(n));
          await save();
        }
      });
    });
    num("Altezza pannello piccolo (px)", "120\u20131600", () => s.compactHeight, (v) => s.compactHeight = v, 120, 1600);
    num("Altezza pannello grande (px)", "120\u20131600", () => s.largeHeight, (v) => s.largeHeight = v, 120, 1600);
    num("Distanza righe guida (px)", "Righe guida del pannello grande (60\u2013400)", () => s.guideSpacing, (v) => s.guideSpacing = v, 60, 400);
    new import_obsidian.Setting(containerEl).setName("Fine-tuning").setHeading();
    new import_obsidian.Setting(containerEl).setName("Salva esempi per il fine-tuning").setDesc("Ogni formula inserita (con le tue correzioni) viene salvata nel dataset del backend. Pi\xF9 esempi = modello pi\xF9 preciso sulla tua scrittura (python finetuning.py).").addToggle((t) => t.setValue(s.saveExamples).onChange(async (v) => {
      s.saveExamples = v;
      await save();
    }));
  }
};

// src/widget.ts
var import_obsidian2 = require("obsidian");
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");

// src/ink.ts
function makeStroke(id, points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { id, points, minX, minY, maxX, maxY };
}
function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function buildLine(strokes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) {
    minX = Math.min(minX, s.minX);
    minY = Math.min(minY, s.minY);
    maxX = Math.max(maxX, s.maxX);
    maxY = Math.max(maxY, s.maxY);
  }
  const ids = strokes.map((s) => s.id).sort((a, b) => a - b);
  return { strokes, minX, minY, maxX, maxY, key: ids.join(",") };
}
function segmentLines(strokes, minGap = 14) {
  if (strokes.length === 0) return [];
  const heights = strokes.map((s) => s.maxY - s.minY).filter((h) => h > 4);
  const symbolH = median(heights) || 20;
  const gap = Math.max(minGap, 0.6 * symbolH);
  const sorted = [...strokes].sort((a, b) => a.minY - b.minY);
  const groups = [];
  for (const s of sorted) {
    const last = groups[groups.length - 1];
    if (last && s.minY <= last.bottom + gap) {
      last.strokes.push(s);
      last.bottom = Math.max(last.bottom, s.maxY);
    } else {
      groups.push({ strokes: [s], top: s.minY, bottom: s.maxY });
    }
  }
  let changed = true;
  while (changed && groups.length > 1) {
    changed = false;
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.bottom - g.top >= 0.35 * symbolH) continue;
      const up = i > 0 ? g.top - groups[i - 1].bottom : Infinity;
      const down = i < groups.length - 1 ? groups[i + 1].top - g.bottom : Infinity;
      const j = up <= down ? i - 1 : i + 1;
      const t = groups[j];
      t.strokes.push(...g.strokes);
      t.top = Math.min(t.top, g.top);
      t.bottom = Math.max(t.bottom, g.bottom);
      groups.splice(i, 1);
      changed = true;
      break;
    }
  }
  return groups.map((g) => buildLine(g.strokes));
}
function singleLine(strokes) {
  return strokes.length ? [buildLine(strokes)] : [];
}
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
  return Math.sqrt(x * x + y * y);
}
function strokeHit(s, p, radius) {
  if (p.x < s.minX - radius || p.x > s.maxX + radius || p.y < s.minY - radius || p.y > s.maxY + radius) {
    return false;
  }
  if (s.points.length === 1) {
    return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) <= radius;
  }
  for (let i = 1; i < s.points.length; i++) {
    if (distToSegment(p, s.points[i - 1], s.points[i]) <= radius) return true;
  }
  return false;
}
var RELATIONS = [
  "\\Leftrightarrow",
  "\\Rightarrow",
  "\\implies",
  "\\iff",
  "\\approx",
  "\\equiv",
  "\\leq",
  "\\geq",
  "\\neq",
  "\\le",
  "\\ge",
  "\\ne",
  "=",
  "<",
  ">"
];
function firstRelationIndex(latex) {
  let depth = 0;
  for (let i = 0; i < latex.length; i++) {
    const c = latex[i];
    if (c === "\\") {
      if (depth === 0) {
        for (const r of RELATIONS) {
          if (r.startsWith("\\") && latex.startsWith(r, i)) {
            const next = latex[i + r.length];
            if (next === void 0 || !/[A-Za-z]/.test(next)) return i;
          }
        }
      }
      let j = i + 1;
      if (j < latex.length && /[A-Za-z]/.test(latex[j])) {
        while (j < latex.length && /[A-Za-z]/.test(latex[j])) j++;
        i = j - 1;
      } else {
        i = j;
      }
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "=" || c === "<" || c === ">")) return i;
  }
  return -1;
}
function composeInsertion(lines, format, inline) {
  const clean = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (clean.length === 0) return "";
  if (inline) {
    return clean.map((l) => `$${l}$`).join(" ");
  }
  if (clean.length === 1) return `
$$
${clean[0]}
$$
`;
  if (format === "separate") {
    return clean.map((l) => `
$$
${l}
$$
`).join("");
  }
  if (format === "gathered") {
    return `
$$
\\begin{gathered}
${clean.join(" \\\\\n")}
\\end{gathered}
$$
`;
  }
  const rows = clean.map((l) => {
    const k = firstRelationIndex(l);
    if (k < 0) return l;
    return `${l.slice(0, k).trimEnd()} &${l.slice(k)}`.trim();
  });
  return `
$$
\\begin{aligned}
${rows.join(" \\\\\n")}
\\end{aligned}
$$
`;
}

// src/widget.ts
var IMG_BG = "#1e1e1e";
var IMG_INK = "#ffffff";
var IMG_LINE_WIDTH = 3;
var IMG_MARGIN = 24;
var ERASER_RADIUS = 10;
var PALM_REJECT_MS = 1500;
var MAX_UNDO = 200;
var MAX_CACHE = 300;
var PenSession = class {
  constructor(id, settings) {
    this.id = id;
    this.strokes = [];
    this.nextStrokeId = 1;
    this.undoStack = [];
    this.redoStack = [];
    this.results = /* @__PURE__ */ new Map();
    this.edits = /* @__PURE__ */ new Map();
    this.eraser = false;
    this.split = settings.splitLines;
    this.large = settings.startLarge;
    this.height = this.large ? settings.largeHeight : settings.compactHeight;
  }
  snapshot() {
    this.undoStack.push(this.strokes.slice());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
  }
  lines() {
    return this.split ? segmentLines(this.strokes) : singleLine(this.strokes);
  }
  cacheResult(key, r) {
    this.results.set(key, r);
    while (this.results.size > MAX_CACHE) {
      const oldest = this.results.keys().next().value;
      this.results.delete(oldest);
    }
  }
  textFor(line) {
    var _a, _b, _c;
    return ((_c = (_b = this.edits.get(line.key)) != null ? _b : (_a = this.results.get(line.key)) == null ? void 0 : _a.latex) != null ? _c : "").trim();
  }
};
var showPenEffect = import_state.StateEffect.define();
var hidePenEffect = import_state.StateEffect.define();
var penWidgetField = import_state.StateField.define({
  create: () => import_view.Decoration.none,
  update(widgets, tr) {
    widgets = widgets.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(showPenEffect)) {
        const deco = import_view.Decoration.widget({
          widget: new PenWidget(e.value.id, e.value.host),
          side: 1,
          block: true
        });
        widgets = widgets.update({ add: [deco.range(e.value.pos)] });
      } else if (e.is(hidePenEffect)) {
        widgets = widgets.update({
          filter: (_f, _t, v) => {
            var _a;
            return ((_a = v.spec.widget) == null ? void 0 : _a.id) !== e.value.id;
          }
        });
      }
    }
    return widgets;
  },
  provide: (f) => import_view.EditorView.decorations.from(f)
});
function widgetPos(state, id) {
  let pos = null;
  state.field(penWidgetField).between(0, state.doc.length, (from, _to, v) => {
    var _a;
    if (((_a = v.spec.widget) == null ? void 0 : _a.id) === id) {
      pos = from;
      return false;
    }
    return void 0;
  });
  return pos;
}
function openPen(view, host) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  host.sessions.set(id, new PenSession(id, host.settings));
  view.dispatch({ effects: showPenEffect.of({ pos: line.to, id, host }) });
}
var PenWidget = class extends import_view.WidgetType {
  constructor(id, host) {
    super();
    this.id = id;
    this.host = host;
  }
  eq(other) {
    return other.id === this.id;
  }
  get estimatedHeight() {
    var _a;
    const s = this.host.sessions.get(this.id);
    return ((_a = s == null ? void 0 : s.height) != null ? _a : 200) + 90;
  }
  toDOM(view) {
    let session = this.host.sessions.get(this.id);
    if (!session) {
      session = new PenSession(this.id, this.host.settings);
      this.host.sessions.set(this.id, session);
    }
    const pv = new PenView(view, this.id, session, this.host);
    pv.dom.__penView = pv;
    return pv.dom;
  }
  destroy(dom) {
    var _a;
    (_a = dom.__penView) == null ? void 0 : _a.destroy();
  }
  // il widget gestisce da solo mouse/penna/tastiera
  ignoreEvent() {
    return true;
  }
};
function iconButton(parent, icon, label, onClick) {
  const b = parent.createEl("button", { cls: "clickable-icon pen2latex-btn" });
  b.setAttribute("aria-label", label);
  b.setAttribute("title", label);
  (0, import_obsidian2.setIcon)(b, icon);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    onClick(e);
  });
  return b;
}
var PenView = class {
  constructor(view, id, s, host) {
    this.view = view;
    this.id = id;
    this.s = s;
    this.host = host;
    this.rows = /* @__PURE__ */ new Map();
    this.btn = {};
    this.current = null;
    this.erasing = false;
    this.erasedSomething = false;
    this.activePointer = null;
    this.lastPenTime = 0;
    this.inkColor = "#ffffff";
    this.timer = null;
    this.ctrl = null;
    this.seq = 0;
    this.busy = false;
    this.destroyed = false;
    this.cleanups = [];
    this.dpr = 1;
    const dom = document.createElement("div");
    this.dom = dom;
    dom.className = "pen2latex-widget";
    dom.tabIndex = 0;
    const tb = dom.createDiv({ cls: "pen2latex-toolbar" });
    this.btn.pen = iconButton(tb, "pencil", "Penna", () => this.setEraser(false));
    this.btn.eraser = iconButton(tb, "eraser", "Gomma (anche: tasto gomma della penna)", () => this.setEraser(true));
    tb.createDiv({ cls: "pen2latex-sep" });
    this.btn.undo = iconButton(tb, "undo-2", "Annulla (Ctrl+Z)", () => this.undo());
    this.btn.redo = iconButton(tb, "redo-2", "Ripristina (Ctrl+Shift+Z)", () => this.redo());
    this.btn.clear = iconButton(tb, "trash-2", "Cancella tutto", () => this.clear());
    tb.createDiv({ cls: "pen2latex-sep" });
    this.btn.split = iconButton(tb, "list", "Pi\xF9 righe / una sola formula", () => this.toggleSplit());
    this.btn.size = iconButton(tb, "maximize-2", "Pannello grande / piccolo", () => this.toggleSize());
    this.btn.recognize = iconButton(tb, "scan-line", "Riconosci ora", () => this.recognize());
    this.statusEl = tb.createSpan({ cls: "pen2latex-status" });
    tb.createDiv({ cls: "pen2latex-spacer" });
    this.btn.insert = iconButton(
      tb,
      "check",
      "Inserisci nella nota (Ctrl+Invio; Maiusc = formato inline/blocco opposto)",
      (e) => this.insert(e.shiftKey)
    );
    this.btn.close = iconButton(tb, "x", "Chiudi senza inserire", () => this.close());
    this.btn.insert.addClass("pen2latex-insert");
    this.wrap = dom.createDiv({ cls: "pen2latex-canvas-wrap" });
    this.wrap.style.height = `${this.s.height}px`;
    this.canvas = this.wrap.createEl("canvas", { cls: "pen2latex-canvas" });
    this.ctx = this.canvas.getContext("2d");
    const handle = dom.createDiv({ cls: "pen2latex-resize", attr: { "aria-label": "Trascina per ridimensionare" } });
    this.setupResizeHandle(handle);
    this.resultsEl = dom.createDiv({ cls: "pen2latex-results" });
    this.setupPointer();
    this.setupKeyboard();
    this.resizeObs = new ResizeObserver(() => this.resizeCanvas());
    this.resizeObs.observe(this.wrap);
    this.refreshButtons();
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.resizeCanvas();
      this.renderResults();
      if (this.s.strokes.length && this.pendingLines().length) this.schedule(0);
    });
    if (this.s.strokes.length === 0) this.checkBackend();
  }
  destroy() {
    var _a;
    this.destroyed = true;
    (_a = this.ctrl) == null ? void 0 : _a.abort();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.resizeObs.disconnect();
    for (const c of this.cleanups) c();
  }
  get settings() {
    return this.host.settings;
  }
  // ------------------------------------------------------------------ UI
  setStatus(text, kind = "") {
    this.statusEl.setText(text);
    this.statusEl.toggleClass("is-error", kind === "error");
    this.statusEl.toggleClass("is-busy", kind === "busy");
  }
  refreshButtons() {
    this.btn.pen.toggleClass("is-active", !this.s.eraser);
    this.btn.eraser.toggleClass("is-active", this.s.eraser);
    this.btn.split.toggleClass("is-active", this.s.split);
    this.btn.undo.disabled = this.s.undoStack.length === 0;
    this.btn.redo.disabled = this.s.redoStack.length === 0;
    this.btn.clear.disabled = this.s.strokes.length === 0;
    this.btn.insert.disabled = this.s.strokes.length === 0;
    (0, import_obsidian2.setIcon)(this.btn.size, this.s.large ? "minimize-2" : "maximize-2");
    this.canvas.toggleClass("is-eraser", this.s.eraser);
  }
  async checkBackend() {
    try {
      const h = await health(this.settings.backendUrl);
      if (!this.destroyed && h.status === "ok" && !this.s.strokes.length) this.setStatus("");
    } catch (e) {
      if (!this.destroyed) {
        this.setStatus("Backend non raggiungibile: avvialo con run_backend.sh", "error");
      }
    }
  }
  setEraser(on) {
    this.s.eraser = on;
    this.refreshButtons();
  }
  toggleSplit() {
    this.s.split = !this.s.split;
    this.afterChange();
  }
  toggleSize() {
    this.s.large = !this.s.large;
    this.s.height = this.s.large ? this.settings.largeHeight : this.settings.compactHeight;
    this.wrap.style.height = `${this.s.height}px`;
    this.refreshButtons();
    this.view.requestMeasure();
  }
  setupResizeHandle(handle) {
    let startY = 0, startH = 0, pid = null;
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pid = e.pointerId;
      startY = e.clientY;
      startH = this.s.height;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (pid !== e.pointerId) return;
      this.s.height = Math.max(120, Math.min(1600, startH + e.clientY - startY));
      this.wrap.style.height = `${this.s.height}px`;
    });
    const end = (e) => {
      if (pid !== e.pointerId) return;
      pid = null;
      this.view.requestMeasure();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  // ------------------------------------------------------------ disegno
  cssColor(name, fallback) {
    const v = getComputedStyle(this.dom).getPropertyValue(name).trim();
    return v || fallback;
  }
  resizeCanvas() {
    const r = this.wrap.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.round(r.width * this.dpr), h = Math.round(r.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.redraw();
  }
  redraw() {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.cssColor("--background-primary", "#1e1e1e");
    ctx.fillRect(0, 0, w, h);
    if (this.s.split && this.s.large) {
      const sp = this.settings.guideSpacing;
      ctx.strokeStyle = this.cssColor("--background-modifier-border", "#444");
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      for (let y = sp; y < h; y += sp) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
        ctx.stroke();
      }
    }
    const lines = this.s.lines();
    if (lines.length > 1) {
      ctx.strokeStyle = this.cssColor("--interactive-accent", "#7f6df2");
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.font = "11px var(--font-interface, sans-serif)";
      lines.forEach((l, i) => {
        ctx.strokeRect(l.minX - 6, l.minY - 6, l.maxX - l.minX + 12, l.maxY - l.minY + 12);
        ctx.fillText(String(i + 1), Math.max(2, l.minX - 18), l.minY + 6);
      });
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    const ink = this.cssColor("--text-normal", "#ffffff");
    for (const st of this.s.strokes) this.drawPoints(ctx, st.points, ink, IMG_LINE_WIDTH);
    if (this.current) this.drawPoints(ctx, this.current, ink, IMG_LINE_WIDTH);
  }
  drawPoints(ctx, pts, color, width) {
    if (pts.length === 0) return;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  /** Immagine di una riga nel formato atteso dal modello. */
  lineImage(line) {
    const c = document.createElement("canvas");
    const w = Math.ceil(line.maxX - line.minX) + 2 * IMG_MARGIN;
    const h = Math.ceil(line.maxY - line.minY) + 2 * IMG_MARGIN;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = IMG_BG;
    ctx.fillRect(0, 0, w, h);
    ctx.translate(IMG_MARGIN - line.minX, IMG_MARGIN - line.minY);
    const ordered = [...line.strokes].sort((a, b) => a.id - b.id);
    for (const st of ordered) this.drawPoints(ctx, st.points, IMG_INK, IMG_LINE_WIDTH);
    return c.toDataURL("image/png");
  }
  // ------------------------------------------------------------- input
  toLocal(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  setupPointer() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      if (this.activePointer !== null) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.pointerType === "pen") this.lastPenTime = Date.now();
      if (e.pointerType === "touch" && Date.now() - this.lastPenTime < PALM_REJECT_MS) return;
      e.preventDefault();
      this.dom.focus({ preventScroll: true });
      c.setPointerCapture(e.pointerId);
      this.activePointer = e.pointerId;
      this.erasing = this.s.eraser || e.button === 5 || (e.buttons & 32) !== 0 || e.pointerType === "pen" && (e.buttons & 2) !== 0;
      this.erasedSomething = false;
      if (this.timer !== null) window.clearTimeout(this.timer);
      const p = this.toLocal(e);
      if (this.erasing) {
        this.eraseAt(p);
      } else {
        this.inkColor = this.cssColor("--text-normal", "#ffffff");
        this.current = [p];
        this.redraw();
      }
    });
    c.addEventListener("pointermove", (e) => {
      if (e.pointerId !== this.activePointer) return;
      if (e.pointerType === "pen") this.lastPenTime = Date.now();
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const list = events.length ? events : [e];
      if (this.erasing) {
        for (const ev of list) this.eraseAt(this.toLocal(ev));
        return;
      }
      if (!this.current) return;
      const ctx = this.ctx;
      const ink = this.inkColor;
      for (const ev of list) {
        const p = this.toLocal(ev);
        const last = this.current[this.current.length - 1];
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) < 0.75) continue;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.strokeStyle = ink;
        ctx.lineWidth = IMG_LINE_WIDTH;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        this.current.push(p);
      }
    });
    const finish = (e) => {
      if (e.pointerId !== this.activePointer) return;
      this.activePointer = null;
      if (this.erasing) {
        this.erasing = false;
        if (this.erasedSomething) this.afterChange();
        return;
      }
      const pts = this.current;
      this.current = null;
      if (pts && pts.length) {
        this.s.snapshot();
        this.s.strokes.push(makeStroke(this.s.nextStrokeId++, pts));
        this.afterChange();
      }
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", finish);
    c.addEventListener("lostpointercapture", finish);
    c.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  eraseAt(p) {
    const hit = this.s.strokes.filter((st) => strokeHit(st, p, ERASER_RADIUS));
    if (!hit.length) return;
    if (!this.erasedSomething) this.s.snapshot();
    this.erasedSomething = true;
    const ids = new Set(hit.map((h) => h.id));
    this.s.strokes = this.s.strokes.filter((st) => !ids.has(st.id));
    this.redraw();
  }
  setupKeyboard() {
    this.dom.addEventListener("keydown", (e) => {
      const inInput = e.target.tagName === "INPUT";
      const mod = e.ctrlKey || e.metaKey;
      let handled = true;
      if (e.key === "Enter" && (mod || inInput)) {
        this.insert(e.shiftKey);
      } else if (!inInput && mod && e.key.toLowerCase() === "z") {
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (!inInput && mod && e.key.toLowerCase() === "y") {
        this.redo();
      } else {
        handled = false;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }
  // ------------------------------------------------------------ editing
  undo() {
    const prev = this.s.undoStack.pop();
    if (!prev) return;
    this.s.redoStack.push(this.s.strokes);
    this.s.strokes = prev;
    this.afterChange();
  }
  redo() {
    const next = this.s.redoStack.pop();
    if (!next) return;
    this.s.undoStack.push(this.s.strokes);
    this.s.strokes = next;
    this.afterChange();
  }
  clear() {
    if (!this.s.strokes.length) return;
    this.s.snapshot();
    this.s.strokes = [];
    this.afterChange();
  }
  /** Dopo ogni modifica dei tratti: ridisegna e (ri)programma il riconoscimento. */
  afterChange() {
    var _a;
    this.refreshButtons();
    this.redraw();
    this.renderResults();
    if (this.s.strokes.length === 0) {
      (_a = this.ctrl) == null ? void 0 : _a.abort();
      this.setStatus("");
      return;
    }
    if (this.settings.autoRecognize) this.schedule(this.settings.autoDelayMs);
  }
  schedule(delay) {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.recognize();
    }, delay);
  }
  pendingLines() {
    return this.s.lines().filter((l) => !this.s.results.has(l.key));
  }
  // ------------------------------------------------------ riconoscimento
  /** Riconosce le righe nuove o modificate (le altre sono in cache). */
  async recognize() {
    var _a;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    const todo = this.pendingLines();
    if (!todo.length) {
      this.renderResults();
      return;
    }
    (_a = this.ctrl) == null ? void 0 : _a.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    const seq = ++this.seq;
    this.busy = true;
    this.setStatus(todo.length > 1 ? `Riconosco ${todo.length} righe\u2026` : "Riconosco\u2026", "busy");
    try {
      const images = todo.map((l) => this.lineImage(l));
      const res = await recognizeLines(this.settings.backendUrl, images, ctrl.signal);
      if (seq !== this.seq || this.destroyed) return;
      todo.forEach((l, i) => {
        var _a2;
        const r = res[i];
        this.s.cacheResult(l.key, r.error ? { latex: "", error: r.error } : { latex: (_a2 = r.latex) != null ? _a2 : "" });
      });
      this.setStatus("");
    } catch (e) {
      if (ctrl.signal.aborted || seq !== this.seq || this.destroyed) return;
      const msg = e instanceof BackendError ? e.message : String(e);
      this.setStatus(
        msg === "backend non raggiungibile" ? "Backend non raggiungibile: avvialo con run_backend.sh" : `Errore: ${msg}`,
        "error"
      );
    } finally {
      if (seq === this.seq) this.busy = false;
    }
    if (!this.destroyed) {
      this.renderResults();
      this.redraw();
    }
  }
  renderPreview(el, latex) {
    el.empty();
    if (!latex) {
      el.setText("\u2026");
      el.addClass("is-empty");
      return;
    }
    el.removeClass("is-empty");
    try {
      el.appendChild((0, import_obsidian2.renderMath)(latex, true));
      (0, import_obsidian2.finishRenderMath)();
    } catch (e) {
      el.setText(latex);
    }
  }
  renderResults() {
    const lines = this.s.lines();
    const keys = new Set(lines.map((l) => l.key));
    for (const [k, row] of this.rows) {
      if (!keys.has(k)) {
        row.el.remove();
        this.rows.delete(k);
      }
    }
    lines.forEach((line, i) => {
      var _a, _b;
      let row = this.rows.get(line.key);
      if (!row) {
        row = this.createRow(line.key);
        this.rows.set(line.key, row);
      }
      row.num.setText(lines.length > 1 ? String(i + 1) : "");
      row.num.toggleClass("is-hidden", lines.length <= 1);
      const res = this.s.results.get(line.key);
      const text = (_b = (_a = this.s.edits.get(line.key)) != null ? _a : res == null ? void 0 : res.latex) != null ? _b : "";
      if (document.activeElement !== row.input && row.input.value !== text) row.input.value = text;
      row.input.placeholder = res ? res.error ? `Errore: ${res.error}` : "(vuoto)" : "riconoscimento\u2026";
      if (row.shown !== text || !row.preview.hasChildNodes()) {
        row.shown = text;
        this.renderPreview(row.preview, text);
      }
      this.resultsEl.appendChild(row.el);
    });
    this.resultsEl.toggleClass("is-hidden", lines.length === 0);
  }
  createRow(key) {
    const el = document.createElement("div");
    el.className = "pen2latex-row";
    const num = el.createSpan({ cls: "pen2latex-row-num" });
    const body = el.createDiv({ cls: "pen2latex-row-body" });
    const preview = body.createDiv({ cls: "pen2latex-preview" });
    const input = body.createEl("input", { cls: "pen2latex-input", type: "text" });
    input.spellcheck = false;
    const row = { el, num, preview, input, shown: "" };
    let t = null;
    input.addEventListener("input", () => {
      this.s.edits.set(key, input.value);
      if (t !== null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        row.shown = input.value.trim();
        this.renderPreview(preview, row.shown);
      }, 250);
    });
    return row;
  }
  // ----------------------------------------------------------- uscita
  close() {
    this.host.sessions.delete(this.id);
    this.view.dispatch({ effects: hidePenEffect.of({ id: this.id }) });
  }
  async insert(flipInline) {
    if (!this.s.strokes.length) return;
    if (this.pendingLines().length || this.busy) {
      this.seq++;
      this.busy = false;
      await this.recognize();
      if (this.destroyed || this.pendingLines().length) return;
    }
    const lines = this.s.lines();
    const texts = lines.map((l) => this.s.textFor(l));
    const inline = flipInline ? !this.settings.insertInline : this.settings.insertInline;
    const text = composeInsertion(texts, this.settings.multilineFormat, inline);
    if (!text) {
      this.setStatus("Niente da inserire", "error");
      return;
    }
    const pos = widgetPos(this.view.state, this.id);
    if (pos === null) return;
    if (this.settings.saveExamples) this.saveExamples(lines, texts);
    let insertText = text;
    if (inline) {
      const before = pos > 0 ? this.view.state.sliceDoc(pos - 1, pos) : "";
      if (before && !/\s/.test(before)) insertText = " " + insertText;
    }
    this.host.sessions.delete(this.id);
    this.view.dispatch({
      changes: { from: pos, insert: insertText },
      selection: { anchor: pos + insertText.length },
      effects: hidePenEffect.of({ id: this.id }),
      scrollIntoView: true
    });
    this.view.focus();
  }
  /** Ogni riga confermata diventa un esempio per il fine-tuning. */
  saveExamples(lines, texts) {
    const url = this.settings.backendUrl;
    lines.forEach((line, i) => {
      const res = this.s.results.get(line.key);
      if (!texts[i] || !res || res.error) return;
      saveCorrection(url, this.lineImage(line), res.latex, texts[i]).then((warning) => {
        if (warning) new import_obsidian2.Notice(`Pen to LaTeX: ${warning}`, 6e3);
      }).catch((err) => console.warn("Pen to LaTeX: esempio non salvato", err));
    });
  }
};

// main.ts
var PenToLatexPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    /** stato dei pannelli aperti, per id (sopravvive allo scroll) */
    this.sessions = /* @__PURE__ */ new Map();
  }
  async onload() {
    await this.loadSettings();
    this.registerEditorExtension(penWidgetField);
    this.addSettingTab(new PenSettingTab(this.app, this));
    this.addCommand({
      id: "open-pen-panel",
      name: "Scrivi una formula a mano",
      icon: "pencil",
      editorCallback: (editor) => this.open(editor)
    });
    this.addRibbonIcon("pencil", "Scrivi una formula a mano", () => {
      const view = this.app.workspace.getActiveViewOfType(import_obsidian3.MarkdownView);
      if (view) this.open(view.editor);
    });
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem(
          (item) => item.setTitle("Scrivi formula a mano").setIcon("pencil").onClick(() => this.open(editor))
        );
      })
    );
  }
  onunload() {
    this.sessions.clear();
  }
  open(editor) {
    const cm = editor.cm;
    if (!cm) return;
    openPen(cm, this);
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
