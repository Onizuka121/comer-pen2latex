# pen2latex

Scrivi formule a mano (con penna, tavoletta o mouse) dentro Obsidian e ottieni
LaTeX/MathJax pronto nella nota. Il riconoscimento gira **in locale, su CPU**,
con il modello [CoMER](https://arxiv.org/abs/2207.04410) (ECCV 2022), adattabile
alla tua scrittura con il fine-tuning.

```
plugin/pen2latex/   plugin Obsidian (TypeScript)
backend.py          server locale http://127.0.0.1:5005 (Flask + CoMER)
finetuning.py       adatta il modello alla tua scrittura (dataset/)
evaluate.py         misura l'accuratezza di un checkpoint
comer/              modello CoMER (+ preprocess, tokenizer LaTeX, inferenza)
dataset/            i tuoi esempi (immagine + LaTeX corretto), salvati dal plugin
finetuned_checkpoint.ckpt                    modello adattato (usato di default)
lightning_logs/version_0/checkpoints/*.ckpt  modello CoMER originale
data.zip            dataset CROHME (serve al fine-tuning per non "dimenticare")
```

## Setup (una volta)

Serve [Miniforge/conda](https://github.com/conda-forge/miniforge).

```bash
git clone https://github.com/onizuka121/comer-pen2latex.git
```

```bash
cd comer-pen2latex
```

```bash
bash setup.sh
```

`setup.sh` crea l'ambiente conda `comer` (Python 3.8, PyTorch 1.8.1 CPU) o, se
esiste già, installa solo quello che manca, e verifica che il modello si carichi.

Installa il plugin nel tuo vault:

```bash
bash install_plugin.sh /percorso/del/tuo/vault --link
```

Con `--link` il plugin punta ai file del repo: dopo un `git pull` basta
riavviare Obsidian. Poi in Obsidian: *Impostazioni → Plugin della community →
attiva "Pen to LaTeX"*.

## Uso

Avvia il backend e lascialo aperto:

```bash
bash run_backend.sh
```

In Obsidian apri il pannello in uno di questi modi:

- comando **"Scrivi una formula a mano"** (assegnagli un tasto rapido in
  *Impostazioni → Tasti rapidi*);
- icona matita nella barra laterale;
- tasto destro nell'editor → **Scrivi formula a mano**.

Poi scrivi: quando ti fermi, la formula viene riconosciuta da sola e vedi
l'anteprima renderizzata. Correggi il testo se serve e premi **✓** (o
`Ctrl+Invio`, o `Invio` nel campo di testo).

| Funzione | Come |
|---|---|
| Esercizi interi | pannello grande (icona ⤢) con righe guida: scrivi una riga per passaggio, lasciando spazio tra le righe. Ogni riga viene riconosciuta separatamente e inserita come `aligned` (allineata sul `=`) |
| Gomma | icona gomma, oppure il retro/tasto della penna. Cancella il tratto intero |
| Annulla / ripristina | `Ctrl+Z` / `Ctrl+Shift+Z` |
| Ridimensionare | trascina la barretta sotto il pannello |
| Inline `$…$` | tieni `Maiusc` mentre inserisci (o cambia il default nelle impostazioni) |
| Palmo appoggiato | ignorato mentre usi la penna |

Solo le righe che modifichi vengono rielaborate: il PC lavora il minimo.

## Migliorare il riconoscimento (fine-tuning)

Ogni formula che inserisci viene salvata in `dataset/` con la **tua**
correzione. Più esempi raccogli (soprattutto dei simboli che sbaglia), più il
modello impara la tua scrittura. Quando ne hai raccolti un po' di nuovi:

```bash
bash finetune.sh
```

poi riavvia il backend. Lo script:

- riparte sempre dal modello originale e mescola esempi CROHME ai tuoi
  (così impara la tua scrittura **senza dimenticare** il resto);
- tiene da parte il 15% dei tuoi esempi per misurare il miglioramento reale e
  salva l'epoca migliore (il modello precedente resta in `.bak`);
- scarta e segnala le etichette sbagliate (typo, graffe non chiuse).

Controllare il dataset senza allenare:

```bash
python finetuning.py --check
```

Misurare un modello:

```bash
python evaluate.py --split val
```

**Consigli per esempi utili:** correggi sempre il testo prima di inserire (un
esempio confermato sbagliato insegna l'errore); per un simbolo nuovo servono
almeno ~10 esempi; anche altre persone possono raccogliere esempi con il plugin
e allenare un modello sulla propria scrittura.

## Impostazioni del backend

Variabili d'ambiente opzionali (vedi `backend.py`):

| Variabile | Default | |
|---|---|---|
| `PEN2LATEX_THREADS` | 2 | core CPU usati: 2 è quasi veloce come 4 ma lascia il PC reattivo |
| `PEN2LATEX_BEAM` | 5 | ampiezza beam search: stessa accuratezza di 10 sui tuoi dati, ~40% di calcolo in meno |
| `COMER_CKPT` | fine-tuned se esiste | checkpoint da usare |

Dettagli tecnici, misure e bug corretti: [docs/ANALYSIS.md](docs/ANALYSIS.md).
Il README originale di CoMER (training completo, valutazione CROHME):
[docs/COMER_ORIGINAL.md](docs/COMER_ORIGINAL.md).

## Sviluppo del plugin

```bash
cd plugin/pen2latex
```

```bash
npm install
```

```bash
npm test && npm run build
```
