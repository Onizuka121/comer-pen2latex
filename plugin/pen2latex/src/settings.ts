import { App, PluginSettingTab, Setting } from "obsidian";
import type { MultilineFormat } from "./ink";
import { health } from "./backend";

export interface PenSettings {
	backendUrl: string;
	autoRecognize: boolean;
	autoDelayMs: number;
	compactHeight: number;
	largeHeight: number;
	startLarge: boolean;
	splitLines: boolean;
	guideSpacing: number;
	multilineFormat: MultilineFormat;
	insertInline: boolean;
	saveExamples: boolean;
}

export const DEFAULT_SETTINGS: PenSettings = {
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
	saveExamples: true,
};

interface SettingsHost {
	settings: PenSettings;
	saveSettings(): Promise<void>;
}

export class PenSettingTab extends PluginSettingTab {
	constructor(app: App, private host: SettingsHost & import("obsidian").Plugin) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.host.settings;
		const save = () => this.host.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName("Indirizzo del backend")
			.setDesc("Dove gira backend.py (default http://127.0.0.1:5005).")
			.addText((t) => t.setValue(s.backendUrl).onChange(async (v) => {
				s.backendUrl = v.trim() || DEFAULT_SETTINGS.backendUrl;
				await save();
			}))
			.addButton((b) => b.setButtonText("Verifica").onClick(async () => {
				b.setDisabled(true);
				try {
					const h = await health(s.backendUrl);
					b.setButtonText(`OK · ${h.checkpoint ?? "?"}`);
				} catch {
					b.setButtonText("Non raggiungibile");
				} finally {
					b.setDisabled(false);
				}
			}));

		new Setting(containerEl).setName("Riconoscimento").setHeading();

		new Setting(containerEl)
			.setName("Riconoscimento automatico")
			.setDesc("Riconosce da solo quando smetti di scrivere. Solo le righe modificate vengono rielaborate.")
			.addToggle((t) => t.setValue(s.autoRecognize).onChange(async (v) => {
				s.autoRecognize = v;
				await save();
			}));

		new Setting(containerEl)
			.setName("Attesa prima del riconoscimento (ms)")
			.setDesc("Pausa dopo l'ultimo tratto. Più alta = meno carico sulla CPU.")
			.addSlider((sl) => sl.setLimits(300, 3000, 100).setValue(s.autoDelayMs).setDynamicTooltip()
				.onChange(async (v) => {
					s.autoDelayMs = v;
					await save();
				}));

		new Setting(containerEl)
			.setName("Più righe")
			.setDesc("Divide la scrittura in righe (es. i passaggi di un esercizio) e le riconosce separatamente. " +
				"Lascia spazio tra una riga e l'altra.")
			.addToggle((t) => t.setValue(s.splitLines).onChange(async (v) => {
				s.splitLines = v;
				await save();
			}));

		new Setting(containerEl)
			.setName("Formato con più righe")
			.addDropdown((d) => d
				.addOption("aligned", "Allineate sul segno = (aligned)")
				.addOption("gathered", "Centrate (gathered)")
				.addOption("separate", "Un blocco $$ per riga")
				.setValue(s.multilineFormat)
				.onChange(async (v) => {
					s.multilineFormat = v as MultilineFormat;
					await save();
				}));

		new Setting(containerEl)
			.setName("Inserisci inline ($…$)")
			.setDesc("Altrimenti blocco $$…$$. Tieni premuto Maiusc mentre inserisci per usare l'altro formato.")
			.addToggle((t) => t.setValue(s.insertInline).onChange(async (v) => {
				s.insertInline = v;
				await save();
			}));

		new Setting(containerEl).setName("Pannello").setHeading();

		new Setting(containerEl)
			.setName("Apri grande")
			.setDesc("Apre direttamente il pannello grande (per esercizi interi).")
			.addToggle((t) => t.setValue(s.startLarge).onChange(async (v) => {
				s.startLarge = v;
				await save();
			}));

		const num = (name: string, desc: string, get: () => number, set: (v: number) => void, min: number, max: number) =>
			new Setting(containerEl).setName(name).setDesc(desc).addText((t) => {
				t.inputEl.type = "number";
				t.setValue(String(get())).onChange(async (v) => {
					const n = Number(v);
					if (Number.isFinite(n) && n >= min && n <= max) {
						set(Math.round(n));
						await save();
					}
				});
			});
		num("Altezza pannello piccolo (px)", "120–1600", () => s.compactHeight, (v) => (s.compactHeight = v), 120, 1600);
		num("Altezza pannello grande (px)", "120–1600", () => s.largeHeight, (v) => (s.largeHeight = v), 120, 1600);
		num("Distanza righe guida (px)", "Righe guida del pannello grande (60–400)", () => s.guideSpacing, (v) => (s.guideSpacing = v), 60, 400);

		new Setting(containerEl).setName("Fine-tuning").setHeading();

		new Setting(containerEl)
			.setName("Salva esempi per il fine-tuning")
			.setDesc("Ogni formula inserita (con le tue correzioni) viene salvata nel dataset del backend. " +
				"Più esempi = modello più preciso sulla tua scrittura (python finetuning.py).")
			.addToggle((t) => t.setValue(s.saveExamples).onChange(async (v) => {
				s.saveExamples = v;
				await save();
			}));
	}
}
