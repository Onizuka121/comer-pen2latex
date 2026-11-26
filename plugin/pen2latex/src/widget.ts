import { finishRenderMath, Notice, renderMath, setIcon } from "obsidian";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { BackendError, health, recognizeLines, saveCorrection } from "./backend";
import {
	composeInsertion,
	InkLine,
	makeStroke,
	Point,
	segmentLines,
	singleLine,
	Stroke,
	strokeHit,
} from "./ink";
import type { PenSettings } from "./settings";

/** Quello che serve al widget dal plugin (evita import circolari). */
export interface PenHost {
	settings: PenSettings;
	sessions: Map<string, PenSession>;
}

// Formato delle immagini inviate al modello: IDENTICO a quello con cui sono
// stati raccolti gli esempi di training (tratto bianco 3px su #1e1e1e,
// 1 pixel = 1 pixel CSS). Non cambiarlo senza rifare il fine-tuning.
const IMG_BG = "#1e1e1e";
const IMG_INK = "#ffffff";
const IMG_LINE_WIDTH = 3;
const IMG_MARGIN = 24;

const ERASER_RADIUS = 10;
const PALM_REJECT_MS = 1500;
const MAX_UNDO = 200;
const MAX_CACHE = 300;

interface Result {
	latex: string;
	error?: string;
}

/** Stato di un pannello: sopravvive alla distruzione/ricreazione del DOM
 * (CodeMirror distrugge i widget che escono dallo schermo). */
export class PenSession {
	strokes: Stroke[] = [];
	nextStrokeId = 1;
	undoStack: Stroke[][] = [];
	redoStack: Stroke[][] = [];
	results = new Map<string, Result>();
	edits = new Map<string, string>();
	eraser = false;
	split: boolean;
	large: boolean;
	height: number;

	constructor(readonly id: string, settings: PenSettings) {
		this.split = settings.splitLines;
		this.large = settings.startLarge;
		this.height = this.large ? settings.largeHeight : settings.compactHeight;
	}

	snapshot(): void {
		this.undoStack.push(this.strokes.slice());
		if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
		this.redoStack = [];
	}

	lines(): InkLine[] {
		return this.split ? segmentLines(this.strokes) : singleLine(this.strokes);
	}

	cacheResult(key: string, r: Result): void {
		this.results.set(key, r);
		while (this.results.size > MAX_CACHE) {
			const oldest = this.results.keys().next().value as string;
			this.results.delete(oldest);
		}
	}

	textFor(line: InkLine): string {
		return (this.edits.get(line.key) ?? this.results.get(line.key)?.latex ?? "").trim();
	}
}

// ---------------------------------------------------------------------------
// StateField: dove stanno i pannelli nel documento
// ---------------------------------------------------------------------------

export const showPenEffect = StateEffect.define<{ pos: number; id: string; host: PenHost }>();
export const hidePenEffect = StateEffect.define<{ id: string }>();

export const penWidgetField = StateField.define<DecorationSet>({
	create: () => Decoration.none,
	update(widgets, tr) {
		widgets = widgets.map(tr.changes);
		for (const e of tr.effects) {
			if (e.is(showPenEffect)) {
				const deco = Decoration.widget({
					widget: new PenWidget(e.value.id, e.value.host),
					side: 1,
					block: true,
				});
				widgets = widgets.update({ add: [deco.range(e.value.pos)] });
			} else if (e.is(hidePenEffect)) {
				// per id, non per posizione: la posizione cambia mentre si scrive
				widgets = widgets.update({
					filter: (_f, _t, v) => (v.spec.widget as PenWidget | undefined)?.id !== e.value.id,
				});
			}
		}
		return widgets;
	},
	provide: (f) => EditorView.decorations.from(f),
});

/** Posizione ATTUALE del pannello nel documento (non quella di apertura). */
function widgetPos(state: EditorState, id: string): number | null {
	let pos: number | null = null;
	state.field(penWidgetField).between(0, state.doc.length, (from, _to, v) => {
		if ((v.spec.widget as PenWidget | undefined)?.id === id) {
			pos = from;
			return false;
		}
		return undefined;
	});
	return pos;
}

export function openPen(view: EditorView, host: PenHost): void {
	const head = view.state.selection.main.head;
	const line = view.state.doc.lineAt(head);
	const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
	host.sessions.set(id, new PenSession(id, host.settings));
	view.dispatch({ effects: showPenEffect.of({ pos: line.to, id, host }) });
}

class PenWidget extends WidgetType {
	constructor(readonly id: string, readonly host: PenHost) {
		super();
	}

	eq(other: PenWidget): boolean {
		return other.id === this.id;
	}

	get estimatedHeight(): number {
		const s = this.host.sessions.get(this.id);
		return (s?.height ?? 200) + 90;
	}

	toDOM(view: EditorView): HTMLElement {
		let session = this.host.sessions.get(this.id);
		if (!session) {
			session = new PenSession(this.id, this.host.settings);
			this.host.sessions.set(this.id, session);
		}
		const pv = new PenView(view, this.id, session, this.host);
		(pv.dom as any).__penView = pv;
		return pv.dom;
	}

	destroy(dom: HTMLElement): void {
		(dom as any).__penView?.destroy();
	}

	// il widget gestisce da solo mouse/penna/tastiera
	ignoreEvent(): boolean {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Vista (DOM) di un pannello
// ---------------------------------------------------------------------------

function iconButton(parent: HTMLElement, icon: string, label: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
	const b = parent.createEl("button", { cls: "clickable-icon pen2latex-btn" });
	b.setAttribute("aria-label", label);
	b.setAttribute("title", label);
	setIcon(b, icon);
	b.addEventListener("click", (e) => {
		e.preventDefault();
		onClick(e);
	});
	return b;
}

class PenView {
	dom: HTMLElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private wrap: HTMLElement;
	private statusEl: HTMLElement;
	private resultsEl: HTMLElement;
	private rows = new Map<string, { el: HTMLElement; num: HTMLElement; preview: HTMLElement; input: HTMLInputElement; shown: string }>();
	private btn: Record<string, HTMLButtonElement> = {};

	private current: Point[] | null = null;
	private erasing = false;
	private erasedSomething = false;
	private activePointer: number | null = null;
	private lastPenTime = 0;
	private inkColor = "#ffffff";

	private timer: number | null = null;
	private ctrl: AbortController | null = null;
	private seq = 0;
	private busy = false;
	private destroyed = false;
	private resizeObs: ResizeObserver;
	private cleanups: (() => void)[] = [];
	private dpr = 1;

	constructor(private view: EditorView, private id: string, private s: PenSession, private host: PenHost) {
		const dom = document.createElement("div");
		this.dom = dom;
		dom.className = "pen2latex-widget";
		dom.tabIndex = 0;

		// --- toolbar ---
		const tb = dom.createDiv({ cls: "pen2latex-toolbar" });
		this.btn.pen = iconButton(tb, "pencil", "Penna", () => this.setEraser(false));
		this.btn.eraser = iconButton(tb, "eraser", "Gomma (anche: tasto gomma della penna)", () => this.setEraser(true));
		tb.createDiv({ cls: "pen2latex-sep" });
		this.btn.undo = iconButton(tb, "undo-2", "Annulla (Ctrl+Z)", () => this.undo());
		this.btn.redo = iconButton(tb, "redo-2", "Ripristina (Ctrl+Shift+Z)", () => this.redo());
		this.btn.clear = iconButton(tb, "trash-2", "Cancella tutto", () => this.clear());
		tb.createDiv({ cls: "pen2latex-sep" });
		this.btn.split = iconButton(tb, "list", "Più righe / una sola formula", () => this.toggleSplit());
		this.btn.size = iconButton(tb, "maximize-2", "Pannello grande / piccolo", () => this.toggleSize());
		this.btn.recognize = iconButton(tb, "scan-line", "Riconosci ora", () => this.recognize());
		this.statusEl = tb.createSpan({ cls: "pen2latex-status" });
		tb.createDiv({ cls: "pen2latex-spacer" });
		this.btn.insert = iconButton(tb, "check", "Inserisci nella nota (Ctrl+Invio; Maiusc = formato inline/blocco opposto)",
			(e) => this.insert(e.shiftKey));
		this.btn.close = iconButton(tb, "x", "Chiudi senza inserire", () => this.close());
		this.btn.insert.addClass("pen2latex-insert");

		// --- canvas ---
		this.wrap = dom.createDiv({ cls: "pen2latex-canvas-wrap" });
		this.wrap.style.height = `${this.s.height}px`;
		this.canvas = this.wrap.createEl("canvas", { cls: "pen2latex-canvas" });
		this.ctx = this.canvas.getContext("2d")!;

		const handle = dom.createDiv({ cls: "pen2latex-resize", attr: { "aria-label": "Trascina per ridimensionare" } });
		this.setupResizeHandle(handle);

		// --- risultati ---
		this.resultsEl = dom.createDiv({ cls: "pen2latex-results" });

		this.setupPointer();
		this.setupKeyboard();
		this.resizeObs = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObs.observe(this.wrap);
		this.refreshButtons();

		// stato iniziale (ricreazione dopo uno scroll: ridisegna e ricostruisce)
		requestAnimationFrame(() => {
			if (this.destroyed) return;
			this.resizeCanvas();
			this.renderResults();
			if (this.s.strokes.length && this.pendingLines().length) this.schedule(0);
		});
		if (this.s.strokes.length === 0) this.checkBackend();
	}

	destroy(): void {
		this.destroyed = true;
		this.ctrl?.abort();
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.resizeObs.disconnect();
		for (const c of this.cleanups) c();
	}

	private get settings(): PenSettings {
		return this.host.settings;
	}

	// ------------------------------------------------------------------ UI

	private setStatus(text: string, kind: "" | "error" | "busy" = ""): void {
		this.statusEl.setText(text);
		this.statusEl.toggleClass("is-error", kind === "error");
		this.statusEl.toggleClass("is-busy", kind === "busy");
	}

	private refreshButtons(): void {
		this.btn.pen.toggleClass("is-active", !this.s.eraser);
		this.btn.eraser.toggleClass("is-active", this.s.eraser);
		this.btn.split.toggleClass("is-active", this.s.split);
		this.btn.undo.disabled = this.s.undoStack.length === 0;
		this.btn.redo.disabled = this.s.redoStack.length === 0;
		this.btn.clear.disabled = this.s.strokes.length === 0;
		this.btn.insert.disabled = this.s.strokes.length === 0;
		setIcon(this.btn.size, this.s.large ? "minimize-2" : "maximize-2");
		this.canvas.toggleClass("is-eraser", this.s.eraser);
	}

	private async checkBackend(): Promise<void> {
		try {
			const h = await health(this.settings.backendUrl);
			if (!this.destroyed && h.status === "ok" && !this.s.strokes.length) this.setStatus("");
		} catch {
			if (!this.destroyed) {
				this.setStatus("Backend non raggiungibile: avvialo con run_backend.sh", "error");
			}
		}
	}

	private setEraser(on: boolean): void {
		this.s.eraser = on;
		this.refreshButtons();
	}

	private toggleSplit(): void {
		this.s.split = !this.s.split;
		this.afterChange();
	}

	private toggleSize(): void {
		this.s.large = !this.s.large;
		this.s.height = this.s.large ? this.settings.largeHeight : this.settings.compactHeight;
		this.wrap.style.height = `${this.s.height}px`;
		this.refreshButtons();
		this.view.requestMeasure();
	}

	private setupResizeHandle(handle: HTMLElement): void {
		let startY = 0, startH = 0, pid: number | null = null;
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
		const end = (e: PointerEvent) => {
			if (pid !== e.pointerId) return;
			pid = null;
			this.view.requestMeasure();
		};
		handle.addEventListener("pointerup", end);
		handle.addEventListener("pointercancel", end);
	}

	// ------------------------------------------------------------ disegno

	private cssColor(name: string, fallback: string): string {
		const v = getComputedStyle(this.dom).getPropertyValue(name).trim();
		return v || fallback;
	}

	private resizeCanvas(): void {
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

	private redraw(): void {
		const ctx = this.ctx;
		const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
		ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
		ctx.fillStyle = this.cssColor("--background-primary", "#1e1e1e");
		ctx.fillRect(0, 0, w, h);

		// righe guida (solo visive, non finiscono nell'immagine inviata)
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

		// riquadri delle righe riconosciute (quando sono piu' di una)
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

	private drawPoints(ctx: CanvasRenderingContext2D, pts: Point[], color: string, width: number): void {
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
	private lineImage(line: InkLine): string {
		const c = document.createElement("canvas");
		const w = Math.ceil(line.maxX - line.minX) + 2 * IMG_MARGIN;
		const h = Math.ceil(line.maxY - line.minY) + 2 * IMG_MARGIN;
		c.width = w;
		c.height = h;
		const ctx = c.getContext("2d")!;
		ctx.fillStyle = IMG_BG;
		ctx.fillRect(0, 0, w, h);
		ctx.translate(IMG_MARGIN - line.minX, IMG_MARGIN - line.minY);
		const ordered = [...line.strokes].sort((a, b) => a.id - b.id);
		for (const st of ordered) this.drawPoints(ctx, st.points, IMG_INK, IMG_LINE_WIDTH);
		return c.toDataURL("image/png");
	}

	// ------------------------------------------------------------- input

	private toLocal(e: PointerEvent): Point {
		const r = this.canvas.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private setupPointer(): void {
		const c = this.canvas;

		c.addEventListener("pointerdown", (e) => {
			if (this.activePointer !== null) return;
			if (e.pointerType === "mouse" && e.button !== 0) return;
			if (e.pointerType === "pen") this.lastPenTime = Date.now();
			// palm rejection: mentre usi la penna, il palmo sullo schermo e' ignorato
			if (e.pointerType === "touch" && Date.now() - this.lastPenTime < PALM_REJECT_MS) return;
			e.preventDefault();
			this.dom.focus({ preventScroll: true });
			c.setPointerCapture(e.pointerId);
			this.activePointer = e.pointerId;
			// gomma: modalita' gomma, retro della penna (button 5) o tasto laterale
			this.erasing = this.s.eraser || e.button === 5 || (e.buttons & 32) !== 0 ||
				(e.pointerType === "pen" && (e.buttons & 2) !== 0);
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

		const finish = (e: PointerEvent) => {
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

	private eraseAt(p: Point): void {
		const hit = this.s.strokes.filter((st) => strokeHit(st, p, ERASER_RADIUS));
		if (!hit.length) return;
		if (!this.erasedSomething) this.s.snapshot(); // un solo passo di undo per gesto
		this.erasedSomething = true;
		const ids = new Set(hit.map((h) => h.id));
		this.s.strokes = this.s.strokes.filter((st) => !ids.has(st.id));
		this.redraw();
	}

	private setupKeyboard(): void {
		this.dom.addEventListener("keydown", (e) => {
			const inInput = (e.target as HTMLElement).tagName === "INPUT";
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

	private undo(): void {
		const prev = this.s.undoStack.pop();
		if (!prev) return;
		this.s.redoStack.push(this.s.strokes);
		this.s.strokes = prev;
		this.afterChange();
	}

	private redo(): void {
		const next = this.s.redoStack.pop();
		if (!next) return;
		this.s.undoStack.push(this.s.strokes);
		this.s.strokes = next;
		this.afterChange();
	}

	private clear(): void {
		if (!this.s.strokes.length) return;
		this.s.snapshot();
		this.s.strokes = [];
		this.afterChange();
	}

	/** Dopo ogni modifica dei tratti: ridisegna e (ri)programma il riconoscimento. */
	private afterChange(): void {
		this.refreshButtons();
		this.redraw();
		this.renderResults();
		if (this.s.strokes.length === 0) {
			this.ctrl?.abort();
			this.setStatus("");
			return;
		}
		if (this.settings.autoRecognize) this.schedule(this.settings.autoDelayMs);
	}

	private schedule(delay: number): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => {
			this.timer = null;
			this.recognize();
		}, delay);
	}

	private pendingLines(): InkLine[] {
		return this.s.lines().filter((l) => !this.s.results.has(l.key));
	}

	// ------------------------------------------------------ riconoscimento

	/** Riconosce le righe nuove o modificate (le altre sono in cache). */
	private async recognize(): Promise<void> {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
		const todo = this.pendingLines();
		if (!todo.length) {
			this.renderResults();
			return;
		}
		this.ctrl?.abort();
		const ctrl = new AbortController();
		this.ctrl = ctrl;
		const seq = ++this.seq;
		this.busy = true;
		this.setStatus(todo.length > 1 ? `Riconosco ${todo.length} righe…` : "Riconosco…", "busy");
		try {
			const images = todo.map((l) => this.lineImage(l));
			const res = await recognizeLines(this.settings.backendUrl, images, ctrl.signal);
			if (seq !== this.seq || this.destroyed) return; // superata da una richiesta piu' recente
			todo.forEach((l, i) => {
				const r = res[i];
				this.s.cacheResult(l.key, r.error ? { latex: "", error: r.error } : { latex: r.latex ?? "" });
			});
			this.setStatus("");
		} catch (e) {
			if (ctrl.signal.aborted || seq !== this.seq || this.destroyed) return;
			const msg = e instanceof BackendError ? e.message : String(e);
			this.setStatus(
				msg === "backend non raggiungibile"
					? "Backend non raggiungibile: avvialo con run_backend.sh"
					: `Errore: ${msg}`,
				"error",
			);
		} finally {
			if (seq === this.seq) this.busy = false;
		}
		if (!this.destroyed) {
			this.renderResults();
			this.redraw();
		}
	}

	private renderPreview(el: HTMLElement, latex: string): void {
		el.empty();
		if (!latex) {
			el.setText("…");
			el.addClass("is-empty");
			return;
		}
		el.removeClass("is-empty");
		try {
			el.appendChild(renderMath(latex, true));
			finishRenderMath();
		} catch {
			el.setText(latex);
		}
	}

	private renderResults(): void {
		const lines = this.s.lines();
		const keys = new Set(lines.map((l) => l.key));
		for (const [k, row] of this.rows) {
			if (!keys.has(k)) {
				row.el.remove();
				this.rows.delete(k);
			}
		}
		lines.forEach((line, i) => {
			let row = this.rows.get(line.key);
			if (!row) {
				row = this.createRow(line.key);
				this.rows.set(line.key, row);
			}
			row.num.setText(lines.length > 1 ? String(i + 1) : "");
			row.num.toggleClass("is-hidden", lines.length <= 1);
			const res = this.s.results.get(line.key);
			const text = this.s.edits.get(line.key) ?? res?.latex ?? "";
			if (document.activeElement !== row.input && row.input.value !== text) row.input.value = text;
			row.input.placeholder = res ? (res.error ? `Errore: ${res.error}` : "(vuoto)") : "riconoscimento…";
			if (row.shown !== text || !row.preview.hasChildNodes()) {
				row.shown = text;
				this.renderPreview(row.preview, text);
			}
			this.resultsEl.appendChild(row.el); // mantiene l'ordine delle righe
		});
		this.resultsEl.toggleClass("is-hidden", lines.length === 0);
	}

	private createRow(key: string) {
		const el = document.createElement("div");
		el.className = "pen2latex-row";
		const num = el.createSpan({ cls: "pen2latex-row-num" });
		const body = el.createDiv({ cls: "pen2latex-row-body" });
		const preview = body.createDiv({ cls: "pen2latex-preview" });
		const input = body.createEl("input", { cls: "pen2latex-input", type: "text" });
		input.spellcheck = false;
		const row = { el, num, preview, input, shown: "" };
		let t: number | null = null;
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

	private close(): void {
		this.host.sessions.delete(this.id);
		this.view.dispatch({ effects: hidePenEffect.of({ id: this.id }) });
	}

	private async insert(flipInline: boolean): Promise<void> {
		if (!this.s.strokes.length) return;
		if (this.pendingLines().length || this.busy) {
			this.seq++; // invalida eventuali richieste in corso: rifacciamo tutto
			this.busy = false;
			await this.recognize();
			if (this.destroyed || this.pendingLines().length) return; // errore gia' mostrato
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
			scrollIntoView: true,
		});
		this.view.focus();
	}

	/** Ogni riga confermata diventa un esempio per il fine-tuning. */
	private saveExamples(lines: InkLine[], texts: string[]): void {
		const url = this.settings.backendUrl;
		lines.forEach((line, i) => {
			const res = this.s.results.get(line.key);
			if (!texts[i] || !res || res.error) return;
			saveCorrection(url, this.lineImage(line), res.latex, texts[i])
				.then((warning) => {
					if (warning) new Notice(`Pen to LaTeX: ${warning}`, 6000);
				})
				.catch((err) => console.warn("Pen to LaTeX: esempio non salvato", err));
		});
	}
}
