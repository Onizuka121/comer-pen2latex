import { Editor, MarkdownView, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { DEFAULT_SETTINGS, PenSettings, PenSettingTab } from "./src/settings";
import { openPen, penWidgetField, PenSession } from "./src/widget";

export default class PenToLatexPlugin extends Plugin {
	settings: PenSettings = { ...DEFAULT_SETTINGS };
	/** stato dei pannelli aperti, per id (sopravvive allo scroll) */
	sessions = new Map<string, PenSession>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.registerEditorExtension(penWidgetField);
		this.addSettingTab(new PenSettingTab(this.app, this));

		// Comando (assegnabile a una scorciatoia in Impostazioni → Tasti rapidi)
		this.addCommand({
			id: "open-pen-panel",
			name: "Scrivi una formula a mano",
			icon: "pencil",
			editorCallback: (editor: Editor) => this.open(editor),
		});

		// Icona nella barra laterale
		this.addRibbonIcon("pencil", "Scrivi una formula a mano", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) this.open(view.editor);
		});

		// Menu contestuale dell'editor (tasto destro)
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor: Editor) => {
				menu.addItem((item) =>
					item.setTitle("Scrivi formula a mano").setIcon("pencil").onClick(() => this.open(editor)),
				);
			}),
		);
	}

	onunload(): void {
		this.sessions.clear();
	}

	private open(editor: Editor): void {
		// Obsidian espone l'EditorView di CodeMirror 6 come proprieta' `cm`
		const cm = (editor as unknown as { cm?: EditorView }).cm;
		if (!cm) return;
		openPen(cm, this);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
