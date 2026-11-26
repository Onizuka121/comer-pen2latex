/*
Pen to LaTeX - plugin Obsidian
Bundle generato automaticamente, non modificare a mano.
*/
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
var import_obsidian = require("obsidian");
var import_state = require("@codemirror/state");
var import_view = require("@codemirror/view");
var BACKEND_URL = "http://127.0.0.1:5005/predict";
var SAVE_CORRECTION_URL = "http://127.0.0.1:5005/save_correction";
function cleanLatexSpacing(raw) {
  return raw.replace(/\s*\^\s*/g, "^").replace(/\s*_\s*/g, "_").replace(/\{\s+/g, "{").replace(/\s+\}/g, "}").replace(/\s+/g, " ").trim();
}
function makeIconButton(icon, label) {
  const btn = document.createElement("button");
  btn.addClass("clickable-icon");
  btn.setAttribute("aria-label", label);
  (0, import_obsidian.setIcon)(btn, icon);
  return btn;
}
var showPenWidgetEffect = import_state.StateEffect.define();
var hidePenWidgetEffect = import_state.StateEffect.define();
var PenWidget = class extends import_view.WidgetType {
  constructor(pos, id) {
    super();
    this.pos = pos;
    this.id = id;
  }
  eq(other) {
    return other.id === this.id;
  }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "pen2latex-widget";
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 180;
    canvas.className = "pen2latex-canvas";
    wrap.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return wrap;
    let lastPrediction = "";
    const clearCanvas = () => {
      ctx.fillStyle = "#1e1e1e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    clearCanvas();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const strokes = [];
    let currentStroke = [];
    const redrawAll = () => {
      clearCanvas();
      for (const stroke of strokes) {
        if (stroke.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (let i = 1; i < stroke.length; i++) {
          ctx.lineTo(stroke[i].x, stroke[i].y);
        }
        ctx.stroke();
      }
    };
    let drawing = false;
    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (canvas.width / rect.width),
        y: (e.clientY - rect.top) * (canvas.height / rect.height)
      };
    };
    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      currentStroke = [getPos(e)];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const p = getPos(e);
      const prev = currentStroke[currentStroke.length - 1];
      ctx.beginPath();
      ctx.moveTo(prev.x, prev.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      currentStroke.push(p);
    });
    const stopDrawing = () => {
      if (drawing && currentStroke.length > 0) {
        strokes.push(currentStroke);
      }
      currentStroke = [];
      drawing = false;
    };
    canvas.addEventListener("pointerup", stopDrawing);
    canvas.addEventListener("pointerleave", stopDrawing);
    const toolbar = document.createElement("div");
    toolbar.className = "pen2latex-toolbar";
    wrap.appendChild(toolbar);
    const clearBtn = makeIconButton("trash-2", "Cancella tutto");
    clearBtn.onclick = () => {
      strokes.length = 0;
      clearCanvas();
    };
    toolbar.appendChild(clearBtn);
    const undoBtn = makeIconButton("undo-2", "Annulla ultimo tratto");
    undoBtn.onclick = () => {
      strokes.pop();
      redrawAll();
    };
    toolbar.appendChild(undoBtn);
    const recognizeBtn = makeIconButton("scan-line", "Riconosci");
    toolbar.appendChild(recognizeBtn);
    const cancelBtn = makeIconButton("x", "Chiudi senza inserire");
    cancelBtn.onclick = () => {
      view.dispatch({ effects: hidePenWidgetEffect.of({ id: this.id }) });
    };
    toolbar.appendChild(cancelBtn);
    const statusEl = document.createElement("span");
    statusEl.className = "pen2latex-status";
    toolbar.appendChild(statusEl);
    const resultArea = document.createElement("div");
    resultArea.className = "pen2latex-result";
    resultArea.style.display = "none";
    wrap.appendChild(resultArea);
    const latexInput = document.createElement("input");
    latexInput.type = "text";
    latexInput.className = "pen2latex-input";
    latexInput.spellcheck = false;
    resultArea.appendChild(latexInput);
    const backBtn = makeIconButton("arrow-left", "Torna al disegno");
    backBtn.onclick = () => {
      resultArea.style.display = "none";
      statusEl.textContent = "";
    };
    resultArea.appendChild(backBtn);
    const insertBtn = makeIconButton("check", "Inserisci nella nota");
    resultArea.appendChild(insertBtn);
    recognizeBtn.onclick = async () => {
      statusEl.textContent = "Riconoscimento in corso...";
      recognizeBtn.disabled = true;
      try {
        const dataUrl = canvas.toDataURL("image/png");
        const res = await fetch(BACKEND_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl })
        });
        const data = await res.json();
        if (data.error) {
          statusEl.textContent = `Errore: ${data.error}`;
        } else {
          lastPrediction = data.latex;
          latexInput.value = cleanLatexSpacing(data.latex);
          resultArea.style.display = "flex";
          statusEl.textContent = "";
          latexInput.focus();
        }
      } catch (err) {
        statusEl.textContent = `Backend non raggiungibile (${BACKEND_URL}). E' avviato?`;
      } finally {
        recognizeBtn.disabled = false;
      }
    };
    insertBtn.onclick = () => {
      const latex = latexInput.value.trim();
      if (!latex) return;
      const rawImage = canvas.toDataURL("image/png");
      fetch(SAVE_CORRECTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: rawImage,
          predicted: lastPrediction,
          corrected: latex
        })
      }).catch((err) => {
        console.warn("Pen to LaTeX: impossibile salvare l'esempio per il training", err);
      });
      const insertion = `
$$
${latex}
$$
`;
      const newCursorPos = this.pos + insertion.length;
      view.dispatch({
        changes: { from: this.pos, insert: insertion },
        selection: { anchor: newCursorPos },
        effects: hidePenWidgetEffect.of({ id: this.id })
      });
    };
    latexInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        insertBtn.click();
      }
    });
    return wrap;
  }
  // Impedisce a CodeMirror di intercettare gli eventi (click, digitazione,
  // disegno col pennino) destinati al widget invece che all'editor.
  ignoreEvent() {
    return true;
  }
};
var penWidgetField = import_state.StateField.define({
  create() {
    return import_view.Decoration.none;
  },
  update(widgets, tr) {
    widgets = widgets.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(showPenWidgetEffect)) {
        const deco = import_view.Decoration.widget({
          widget: new PenWidget(effect.value.pos, effect.value.id),
          side: 1,
          block: true
        });
        widgets = widgets.update({ add: [deco.range(effect.value.pos)] });
      } else if (effect.is(hidePenWidgetEffect)) {
        widgets = widgets.update({
          // Rimuove per ID del widget, non per posizione: robusto
          // anche se nel frattempo il documento e' cambiato.
          filter: (_from, _to, value) => {
            const widget = value.spec?.widget;
            return widget?.id !== effect.value.id;
          }
        });
      }
    }
    return widgets;
  },
  provide: (f) => import_view.EditorView.decorations.from(f)
});
var PenToLatexPlugin = class extends import_obsidian.Plugin {
  async onload() {
    this.registerEditorExtension(penWidgetField);
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem((item) => {
          item.setTitle("Avvia scrittura con penna").setIcon("pencil").onClick(() => {
            const cmView = editor.cm;
            if (!cmView) return;
            const pos = cmView.state.selection.main.head;
            const line = cmView.state.doc.lineAt(pos);
            const id = Math.random().toString(36).slice(2);
            cmView.dispatch({
              effects: showPenWidgetEffect.of({ pos: line.to, id })
            });
          });
        });
      })
    );
  }
};