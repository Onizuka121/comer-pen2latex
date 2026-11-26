import { Plugin, Editor, setIcon } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import {
	EditorView,
	Decoration,
	DecorationSet,
	WidgetType,
} from "@codemirror/view";

const BACKEND_URL = "http://127.0.0.1:5005/predict";
const SAVE_CORRECTION_URL = "http://127.0.0.1:5005/save_correction";

/** Ripulisce la spaziatura "token per token" che CoMER restituisce
 * (es. "x ^ { 2 } = \sum \limits _ { a = 1 } ^ { 3 }") rendendola
 * piu' leggibile per l'editing manuale, senza cambiare il rendering
 * (in math mode gli spazi sono comunque ignorati da MathJax). */
function cleanLatexSpacing(raw: string): string {
	return raw
		.replace(/\s*\^\s*/g, "^")
		.replace(/\s*_\s*/g, "_")
		.replace(/\{\s+/g, "{")
		.replace(/\s+\}/g, "}")
		.replace(/\s+/g, " ")
		.trim();
}

/** Crea un bottone con solo icona (stile Obsidian) e tooltip. */
function makeIconButton(icon: string, label: string): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.addClass("clickable-icon");
	btn.setAttribute("aria-label", label);
	setIcon(btn, icon);
	return btn;
}

// --- Effetti per mostrare/nascondere il widget ---
// Identificati da un ID univoco, NON dalla posizione nel documento: la
// posizione si sposta quando si inserisce testo, un confronto per
// posizione fallisce silenziosamente e lascia il pannello "fantasma"
// bloccato nell'editor.

interface ShowPenWidgetPayload {
	pos: number;
	id: string;
}
interface HidePenWidgetPayload {
	id: string;
}

const showPenWidgetEffect = StateEffect.define<ShowPenWidgetPayload>();
const hidePenWidgetEffect = StateEffect.define<HidePenWidgetPayload>();

// --- Il widget vero e proprio (canvas + toolbar + campo editabile) ---

class PenWidget extends WidgetType {
	constructor(readonly pos: number, readonly id: string) {
		super();
	}

	eq(other: PenWidget): boolean {
		return other.id === this.id;
	}

	toDOM(view: EditorView): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = "pen2latex-widget";

		// --- Canvas per disegnare ---
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

		// Ogni tratto (da pointerdown a pointerup) e' un array di punti,
		// cosi' possiamo ridisegnare tutto tranne l'ultimo per l'undo.
		type Point = { x: number; y: number };
		const strokes: Point[][] = [];
		let currentStroke: Point[] = [];

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

		const getPos = (e: PointerEvent): Point => {
			const rect = canvas.getBoundingClientRect();
			return {
				x: (e.clientX - rect.left) * (canvas.width / rect.width),
				y: (e.clientY - rect.top) * (canvas.height / rect.height),
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

		// --- Toolbar (icone, non testo, per una UI minimale) ---
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

		// --- Area risultato (nascosta finche' non c'e' un riconoscimento) ---
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

		// --- Logica di riconoscimento ---
		recognizeBtn.onclick = async () => {
			statusEl.textContent = "Riconoscimento in corso...";
			recognizeBtn.disabled = true;
			try {
				const dataUrl = canvas.toDataURL("image/png");
				const res = await fetch(BACKEND_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ image: dataUrl }),
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

		// --- Inserimento finale nell'editor ---
		insertBtn.onclick = () => {
			const latex = latexInput.value.trim();
			if (!latex) return;

			// Salva l'esempio (immagine raw + predizione originale + testo
			// confermato/corretto) per il futuro fine-tuning. Fire-and-forget:
			// non blocca l'inserimento se il salvataggio fallisce o e' lento.
			const rawImage = canvas.toDataURL("image/png");
			fetch(SAVE_CORRECTION_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					image: rawImage,
					predicted: lastPrediction,
					corrected: latex,
				}),
			}).catch((err) => {
				console.warn("Pen to LaTeX: impossibile salvare l'esempio per il training", err);
			});

			const insertion = `\n$$\n${latex}\n$$\n`;
			// Posiziona il cursore DOPO il testo appena inserito, cosi' la
			// prossima volta che apri il pannello scrive sotto e non sopra.
			const newCursorPos = this.pos + insertion.length;
			view.dispatch({
				changes: { from: this.pos, insert: insertion },
				selection: { anchor: newCursorPos },
				effects: hidePenWidgetEffect.of({ id: this.id }),
			});
		};

		// Invio con Enter nel campo di testo = come cliccare "Inserisci"
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
	ignoreEvent(): boolean {
		return true;
	}
}

// --- StateField che tiene traccia dei widget attivi nel documento ---

const penWidgetField = StateField.define<DecorationSet>({
	create(): DecorationSet {
		return Decoration.none;
	},
	update(widgets, tr) {
		widgets = widgets.map(tr.changes);
		for (const effect of tr.effects) {
			if (effect.is(showPenWidgetEffect)) {
				const deco = Decoration.widget({
					widget: new PenWidget(effect.value.pos, effect.value.id),
					side: 1,
					block: true,
				});
				widgets = widgets.update({ add: [deco.range(effect.value.pos)] });
			} else if (effect.is(hidePenWidgetEffect)) {
				widgets = widgets.update({
					// Rimuove per ID del widget, non per posizione: robusto
					// anche se nel frattempo il documento e' cambiato.
					filter: (_from, _to, value) => {
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						const widget = (value as any).spec?.widget as PenWidget | undefined;
						return widget?.id !== effect.value.id;
					},
				});
			}
		}
		return widgets;
	},
	provide: (f) => EditorView.decorations.from(f),
});

// --- Plugin principale ---

export default class PenToLatexPlugin extends Plugin {
	async onload() {
		this.registerEditorExtension(penWidgetField);

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor: Editor) => {
				menu.addItem((item) => {
					item
						.setTitle("Avvia scrittura con penna")
						.setIcon("pencil")
						.onClick(() => {
							// Obsidian espone l'istanza CodeMirror 6 sottostante
							// tramite la proprieta' non ufficiale `cm`.
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							const cmView: EditorView | undefined = (editor as any).cm;
							if (!cmView) return;
							const pos = cmView.state.selection.main.head;
							const line = cmView.state.doc.lineAt(pos);
							const id = Math.random().toString(36).slice(2);
							cmView.dispatch({
								effects: showPenWidgetEffect.of({ pos: line.to, id }),
							});
						});
				});
			})
		);
	}
}