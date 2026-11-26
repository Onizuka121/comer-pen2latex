# Analisi, misure e bug corretti

Tutte le scelte qui sotto sono state **misurate** sui 201 esempi reali in
`dataset/` (scrittura dell'autore, raccolti dal plugin) e sul test set
CROHME 2014, non decise a intuito. ExpRate = % di formule riconosciute in modo
esattamente corretto.

## Bug trovati e corretti

### Modello / fine-tuning

1. **Il fine-tuning distruggeva il modello.** Il vecchio `finetuning.py`
   allenava solo sui ~200 esempi personali, con batch da 1 e BatchNorm in
   modalità training. Risultato misurato sul test CROHME 2014 (300 formule):

   | checkpoint | CROHME 2014 |
   |---|---|
   | CoMER originale | 63.7% |
   | vecchio `finetuned_checkpoint.ckpt` | **23.0%** |

   Il modello aveva "dimenticato" la scrittura in generale: è una delle cause
   principali degli errori casuali. Ora: replay di esempi CROHME, BatchNorm
   congelate, augmentation, validazione e salvataggio dell'epoca migliore.

2. **Tokenizer delle correzioni sbagliato.** `\{` veniva diviso in `\` + `{`
   (graffe di insieme insegnate come token spazzatura), `x^2` diventava
   `x ^ 2` invece di `x ^ { 2 }` (convenzione CROHME), `\left( \right)`,
   `\dots`, `'` non erano normalizzati. Nel dizionario erano finiti i token
   `\` e `\c`. Nuovo tokenizer: `comer/latex_tokens.py` (con doctest e
   verifica di andata/ritorno su tutte le 12.166 formule CROHME: 0 differenze).

3. **Vocabolario e checkpoint disallineati.** Il fine-tuning modificava
   `dictionary.txt` su disco: da quel momento il checkpoint originale non si
   caricava più (113 vs 139 token) e anche `train.py`/test originali erano
   rotti. Inoltre il beam search usava una costante `vocab_size` calcolata
   all'import. Ora il vocabolario è salvato **dentro** il checkpoint e
   ricaricato con lui (`comer/inference.py`); `dictionary.txt` è tornato
   quello originale.

4. **Etichette errate nel dataset** (ora corrette guardando le immagini):
   `A \c B` → `A \cup B`, `\max{f ( x )` → `\max f ( x )`,
   `P ( A u B )` (confermato senza correggere) → `P ( A \cup B )`.
   `finetuning.py --check` ora segnala questi casi.

### Plugin

5. **Inserimento nel punto sbagliato:** la posizione veniva fissata
   all'apertura del pannello; se nel frattempo modificavi la nota sopra, la
   formula finiva altrove. Ora si usa la posizione attuale del pannello.
6. **Disegno perso scorrendo la nota:** CodeMirror distrugge i widget fuori
   schermo e il disegno viveva solo nel DOM. Ora lo stato è in una sessione
   separata e il pannello si ricostruisce identico (verificato con test).
7. Un tocco senza movimento (punto della `i`, punto decimale) non lasciava
   inchiostro; ora sì.

### Backend

8. CORS aperto a qualunque sito: una pagina web aperta nel browser poteva
   scrivere file nel tuo dataset. Ora solo Obsidian.
9. Percorsi relativi alla cartella corrente (dataset/checkpoint "sparivano"
   lanciando lo script da un'altra cartella), mancava un lock sulla scrittura
   del dataset, `flask`/`flask-cors` mancavano dalle dipendenze.

## Preprocessing: cosa conta davvero

Checkpoint originale, 76-77 esempi con soli simboli noti al modello, beam 10:

| variante | corrette |
|---|---|
| pipeline del prototipo (soglia 100, margine 20 px) | **47** |
| margine 12 px (come CROHME) | 43 |
| soglia Otsu | 44 |
| tratto più spesso | 43 |
| normalizzare la dimensione dei simboli a CROHME | 37 |
| + normalizzare lo spessore del tratto | 32 |

Le "normalizzazioni verso CROHME" peggiorano: la pipeline originale resta,
con correzioni di robustezza (polarità decisa dal bordo, rimozione puntini,
limiti di dimensione CROHME invece di 400 px, che rimpiccioliva le righe lunghe).
Il plugin genera ogni riga nello **stesso identico formato** degli esempi
raccolti (tratto 3 px bianco su `#1e1e1e`, 1 px = 1 px CSS).

## Velocità (CPU)

| beam | threads | corrette | s/formula* |
|---|---|---|---|
| 10 | 4 | 47/77 | 0.27 |
| 5 | 4 | 47/77 | 0.16 |
| 3 | 4 | 47/77 | 0.12 |
| 5 | 2 | 46/76 | 0.21 |
| 5 | 1 | 46/76 | 0.31 |

\* macchina di test a 4 core; su un i5 da laptop aspettarsi tempi simili o
fino a ~2x. Default: beam 5, 2 thread. Il plugin rielabora solo le righe
modificate e aspetta una pausa nella scrittura prima di chiamare il backend.

## Fine-tuning

Esperimento con `finetuning.py` (12 epoche, replay CROHME 1:1): 166 esempi
in training, **35 tenuti da parte e mai visti** per la misura.

| epoca | tua scrittura (35 mai visti) | CROHME (150, beam 3) |
|---|---|---|
| prima (vocabolario esteso) | 28.6% | 60.7% |
| 1 | 37.1% | 49.3% |
| 4 | 51.4% | 56.7% |
| 7 | **54.3%** | 55.3% |
| 8 | **54.3%** | 58.7% |
| 12 | 51.4% | 57.3% |

Modello dell'epoca migliore, CROHME 2014 su 300 formule a beam 5 (stesso
test della tabella del punto 1):

| checkpoint | CROHME 2014 |
|---|---|
| CoMER originale | 63.7% |
| vecchio fine-tuning | 23.0% |
| **nuovo fine-tuning** | **59.3%** |

La tua scrittura passa da 28.6% a 54.3% di formule esattamente giuste,
quasi senza perdere la scrittura generale. Con 35 esempi di validazione ogni
esempio vale ~3 punti: le oscillazioni tra epoche sono rumore.

Il `finetuned_checkpoint.ckpt` nel repo è allenato con lo stesso schema su
**tutti** i 201 esempi (`--all-data`), perché molti simboli hanno solo 1-4
esempi e ognuno conta. La curva sopra è piatta dalla 7ª alla 12ª epoca, quindi
l'ultima epoca è una scelta sicura.

### Errori rimasti e come ridurli

- **∪ scambiato per ∩**: nel dataset `\cap` compare 45 volte, `\cup` 14. Il
  modello tende verso il simbolo più frequente: servono più esempi di ∪.
- **Simboli con meno di 5 esempi** (`\ln`, `\max`, `\min`, `\subset`,
  `\implies`, `\mathcal`, `\quad`, ...) non sono ancora appresi: `\max f(x)`
  diventa `m a x f ( x )`. Servono ~10 esempi ciascuno.
- `finetuning.py --check` mostra il conteggio per simbolo e avvisa per quelli
  sotto i 5 esempi.

Un'altra etichetta errata trovata dagli errori di validazione: `{5}` (che in
MathJax non mostra le graffe) per l'insieme `\{5\}`. Il validatore ora
segnala le graffe "nude".
