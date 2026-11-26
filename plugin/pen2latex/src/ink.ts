// Funzioni pure su tratti e LaTeX (nessuna dipendenza da Obsidian: testabili
// in Node, vedi tests/ink.test.mjs).

export interface Point {
	x: number;
	y: number;
}

export interface Stroke {
	id: number;
	points: Point[];
	// bounding box, calcolato una volta a fine tratto
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

export interface InkLine {
	strokes: Stroke[];
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	/** identifica il contenuto della riga: cambia se cambia un suo tratto */
	key: string;
}

export function makeStroke(id: number, points: Point[]): Stroke {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.x > maxX) maxX = p.x;
		if (p.y > maxY) maxY = p.y;
	}
	return { id, points, minX, minY, maxX, maxY };
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function buildLine(strokes: Stroke[]): InkLine {
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

/**
 * Divide i tratti in righe di scrittura.
 *
 * Due tratti stanno sulla stessa riga se i loro intervalli verticali si
 * sovrappongono o distano meno di `gap`.  Il gap e' proporzionale alla
 * dimensione tipica dei simboli, cosi' numeratore / linea di frazione /
 * denominatore (vicini) restano insieme, mentre righe distinte (separate
 * da piu' spazio) vengono divise.  Gruppi molto sottili (es. una linea di
 * frazione isolata) vengono riattaccati alla riga piu' vicina.
 */
export function segmentLines(strokes: Stroke[], minGap = 14): InkLine[] {
	if (strokes.length === 0) return [];
	const heights = strokes
		.map((s) => s.maxY - s.minY)
		.filter((h) => h > 4);
	const symbolH = median(heights) || 20;
	const gap = Math.max(minGap, 0.6 * symbolH);

	const sorted = [...strokes].sort((a, b) => a.minY - b.minY);
	const groups: { strokes: Stroke[]; top: number; bottom: number }[] = [];
	for (const s of sorted) {
		const last = groups[groups.length - 1];
		if (last && s.minY <= last.bottom + gap) {
			last.strokes.push(s);
			last.bottom = Math.max(last.bottom, s.maxY);
		} else {
			groups.push({ strokes: [s], top: s.minY, bottom: s.maxY });
		}
	}

	// riattacca i gruppi "piatti" (alti meno di ~1/3 di simbolo) al vicino
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

/** Tutti i tratti come un'unica riga (modalita' "una sola formula"). */
export function singleLine(strokes: Stroke[]): InkLine[] {
	return strokes.length ? [buildLine(strokes)] : [];
}

/** Distanza punto-segmento, per la gomma. */
export function distToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x, dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	const x = a.x + t * dx - p.x, y = a.y + t * dy - p.y;
	return Math.sqrt(x * x + y * y);
}

export function strokeHit(s: Stroke, p: Point, radius: number): boolean {
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

// ---------------------------------------------------------------------------
// Composizione del LaTeX finale
// ---------------------------------------------------------------------------

export type MultilineFormat = "aligned" | "gathered" | "separate";

const RELATIONS = [
	"\\Leftrightarrow", "\\Rightarrow", "\\implies", "\\iff", "\\approx",
	"\\equiv", "\\leq", "\\geq", "\\neq", "\\le", "\\ge", "\\ne", "=", "<", ">",
];

/** Posizione della prima relazione (=, <, \leq, ...) fuori da graffe, o -1. */
export function firstRelationIndex(latex: string): number {
	let depth = 0;
	for (let i = 0; i < latex.length; i++) {
		const c = latex[i];
		if (c === "\\") {
			if (depth === 0) {
				for (const r of RELATIONS) {
					if (r.startsWith("\\") && latex.startsWith(r, i)) {
						const next = latex[i + r.length];
						if (next === undefined || !/[A-Za-z]/.test(next)) return i;
					}
				}
			}
			// salta il comando (\{ \} inclusi: non cambiano la profondita')
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

/** Testo da inserire nella nota per le formule riconosciute (una per riga). */
export function composeInsertion(lines: string[], format: MultilineFormat, inline: boolean): string {
	const clean = lines.map((l) => l.trim()).filter((l) => l.length > 0);
	if (clean.length === 0) return "";
	if (inline) {
		// inline: una formula $...$ per riga, separate da spazio
		return clean.map((l) => `$${l}$`).join(" ");
	}
	if (clean.length === 1) return `\n$$\n${clean[0]}\n$$\n`;
	if (format === "separate") {
		return clean.map((l) => `\n$$\n${l}\n$$\n`).join("");
	}
	if (format === "gathered") {
		return `\n$$\n\\begin{gathered}\n${clean.join(" \\\\\n")}\n\\end{gathered}\n$$\n`;
	}
	const rows = clean.map((l) => {
		const k = firstRelationIndex(l);
		if (k < 0) return l;
		return `${l.slice(0, k).trimEnd()} &${l.slice(k)}`.trim();
	});
	return `\n$$\n\\begin{aligned}\n${rows.join(" \\\\\n")}\n\\end{aligned}\n$$\n`;
}
