// Test della logica pura (segmentazione righe, composizione LaTeX).
// Esegui con: npm test
import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "pen2latex-")), "ink.mjs");
await build({ entryPoints: ["src/ink.ts"], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const ink = await import(pathToFileURL(out).href);

let id = 1;
// tratto "simbolo" alto h a partire da (x, y)
const sym = (x, y, h = 30, w = 15) => ink.makeStroke(id++, [{ x, y }, { x: x + w, y: y + h }]);
const hline = (x, y, w = 60) => ink.makeStroke(id++, [{ x, y }, { x: x + w, y }]);
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok -", name); };

test("una riga resta una riga", () => {
	const s = [sym(10, 20), sym(40, 22), sym(70, 18)];
	assert.equal(ink.segmentLines(s).length, 1);
});

test("due righe ben separate", () => {
	const s = [sym(10, 20), sym(40, 22), sym(10, 120), sym(40, 125)];
	const lines = ink.segmentLines(s);
	assert.equal(lines.length, 2);
	assert.ok(lines[0].minY < lines[1].minY);
});

test("frazione (numeratore, linea, denominatore) = una riga", () => {
	const s = [sym(20, 10, 25), hline(10, 45), sym(20, 52, 25)];
	assert.equal(ink.segmentLines(s).length, 1);
});

test("linea di frazione isolata si riattacca", () => {
	// numeratore e denominatore un po' distanti dalla linea
	const s = [sym(20, 0, 30), hline(10, 50), sym(20, 72, 30)];
	const lines = ink.segmentLines(s);
	assert.equal(lines.reduce((a, l) => a + l.strokes.length, 0), 3);
	assert.ok(lines.every((l) => l.maxY - l.minY > 5), "nessuna riga composta solo dalla linea");
});

test("pedici e apici restano sulla riga", () => {
	const s = [sym(10, 30), sym(28, 50, 14, 8), sym(40, 30), sym(58, 14, 14, 8)];
	assert.equal(ink.segmentLines(s).length, 1);
});

test("chiave di riga stabile e dipendente dai tratti", () => {
	const a = sym(10, 20), b = sym(40, 20);
	const k1 = ink.segmentLines([a, b])[0].key;
	const k2 = ink.segmentLines([b, a])[0].key;
	assert.equal(k1, k2);
	const k3 = ink.segmentLines([a])[0].key;
	assert.notEqual(k1, k3);
});

test("gomma: hit test", () => {
	const s = ink.makeStroke(99, [{ x: 0, y: 0 }, { x: 100, y: 0 }]);
	assert.ok(ink.strokeHit(s, { x: 50, y: 8 }, 10));
	assert.ok(!ink.strokeHit(s, { x: 50, y: 15 }, 10));
	assert.ok(!ink.strokeHit(s, { x: 120, y: 0 }, 10));
	const dot = ink.makeStroke(100, [{ x: 5, y: 5 }]);
	assert.ok(ink.strokeHit(dot, { x: 8, y: 9 }, 10));
});

test("firstRelationIndex", () => {
	assert.equal(ink.firstRelationIndex("f ( x ) = x^{2}"), 8);
	assert.equal(ink.firstRelationIndex("x^{a=b} = 2"), 8);
	assert.equal(ink.firstRelationIndex("a \\leq b"), 2);
	assert.equal(ink.firstRelationIndex("\\left( x \\right) < 1"), 17);
	assert.equal(ink.firstRelationIndex("\\{ x \\} = A"), 8);
	assert.equal(ink.firstRelationIndex("x + 1"), -1);
	assert.equal(ink.firstRelationIndex("\\leftrightarrow x"), -1);
	assert.equal(ink.firstRelationIndex("= 3"), 0);
});

test("composeInsertion: riga singola", () => {
	assert.equal(ink.composeInsertion(["x^{2}"], "aligned", false), "\n$$\nx^{2}\n$$\n");
	assert.equal(ink.composeInsertion(["  ", ""], "aligned", false), "");
	assert.equal(ink.composeInsertion(["x", "y"], "aligned", true), "$x$ $y$");
});

test("composeInsertion: aligned / gathered / separate", () => {
	const a = ink.composeInsertion(["f ( x ) = 2 x", "= 4", "x + 1"], "aligned", false);
	assert.equal(a, "\n$$\n\\begin{aligned}\nf ( x ) &= 2 x \\\\\n&= 4 \\\\\nx + 1\n\\end{aligned}\n$$\n");
	const g = ink.composeInsertion(["a", "b"], "gathered", false);
	assert.equal(g, "\n$$\n\\begin{gathered}\na \\\\\nb\n\\end{gathered}\n$$\n");
	const s = ink.composeInsertion(["a", "b"], "separate", false);
	assert.equal(s, "\n$$\na\n$$\n\n$$\nb\n$$\n");
});

console.log(`\n${n} test superati`);
