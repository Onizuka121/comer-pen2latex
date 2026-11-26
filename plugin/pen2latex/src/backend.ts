// Chiamate HTTP al backend locale (backend.py).

export interface LineResult {
	latex: string;
	raw?: string;
	empty?: boolean;
	error?: string;
}

export interface Health {
	status: string;
	checkpoint?: string;
	model_loaded?: boolean;
	beam_size?: number;
	threads?: number;
}

export class BackendError extends Error {}

function join(base: string, path: string): string {
	return base.replace(/\/+$/, "") + path;
}

async function postJson(url: string, body: unknown, signal?: AbortSignal, timeoutMs = 120000): Promise<any> {
	const ctrl = new AbortController();
	const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
	const onAbort = () => ctrl.abort();
	signal?.addEventListener("abort", onAbort);
	try {
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: ctrl.signal,
			});
		} catch (e) {
			if (signal?.aborted) throw e; // annullata da noi: non e' un errore
			throw new BackendError("backend non raggiungibile");
		}
		let data: any;
		try {
			data = await res.json();
		} catch {
			throw new BackendError(`risposta non valida (HTTP ${res.status})`);
		}
		if (!res.ok || data?.error) {
			throw new BackendError(data?.error ?? `HTTP ${res.status}`);
		}
		return data;
	} finally {
		window.clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Riconosce piu' righe in una sola richiesta (stesso ordine in uscita). */
export async function recognizeLines(base: string, images: string[], signal?: AbortSignal): Promise<LineResult[]> {
	const data = await postJson(join(base, "/predict"), { images }, signal);
	if (!Array.isArray(data.results) || data.results.length !== images.length) {
		throw new BackendError("risposta del backend incompleta");
	}
	return data.results as LineResult[];
}

export async function saveCorrection(base: string, image: string, predicted: string, corrected: string): Promise<string | undefined> {
	const data = await postJson(join(base, "/save_correction"), { image, predicted, corrected }, undefined, 15000);
	return data.warning as string | undefined;
}

export async function health(base: string): Promise<Health> {
	const ctrl = new AbortController();
	const timer = window.setTimeout(() => ctrl.abort(), 4000);
	try {
		const res = await fetch(join(base, "/health"), { signal: ctrl.signal });
		return (await res.json()) as Health;
	} catch {
		throw new BackendError("backend non raggiungibile");
	} finally {
		window.clearTimeout(timer);
	}
}
