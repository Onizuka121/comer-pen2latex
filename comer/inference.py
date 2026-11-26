"""Model loading and recognition helpers (CPU friendly).

The vocabulary is taken from the checkpoint, never assumed: fine-tuning
can add tokens, and a checkpoint must always be paired with the exact
token list it was trained with, otherwise predictions are garbage or the
weights fail to load.

Python 3.7 compatible.
"""
import os
from typing import List, Optional, Tuple

import torch

from comer.datamodule.vocab import default_dict, read_dictionary, vocab

_HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(_HERE)
ORIGINAL_CKPT = os.path.join(
    REPO_ROOT,
    "lightning_logs", "version_0", "checkpoints",
    "epoch=151-step=57151-val_ExpRate=0.6365.ckpt",
)

EMBED_KEY = "comer_model.decoder.word_embed.0.weight"


def checkpoint_words(ckpt: dict, dict_path: Optional[str] = None) -> List[str]:
    """Token list (without <pad>/<sos>/<eos>) matching a checkpoint.

    New checkpoints store it under the "vocab" key.  Old ones (the original
    CoMER checkpoint, or ones made by the first version of finetuning.py)
    don't: since dictionary.txt is append-only, their vocabulary is the
    first N lines of it, N being given by the embedding matrix size.
    """
    if "vocab" in ckpt:
        return list(ckpt["vocab"])
    n = ckpt["state_dict"][EMBED_KEY].shape[0] - 3
    words = read_dictionary(dict_path or default_dict())
    if len(words) < n:
        raise RuntimeError(
            "dictionary.txt has %d tokens but the checkpoint needs %d: "
            "use the dictionary the checkpoint was trained with" % (len(words), n)
        )
    return words[:n]


def load_model(ckpt_path: str, threads: Optional[int] = None):
    """Load a LitCoMER checkpoint for CPU inference.

    Also (re)loads the global vocabulary so that it matches the checkpoint.
    """
    if threads:
        torch.set_num_threads(threads)
    ckpt = torch.load(ckpt_path, map_location="cpu")
    vocab.load_words(checkpoint_words(ckpt))

    # import after the vocabulary is set: the model sizes depend on it
    from comer.lit_comer import LitCoMER

    hparams = dict(ckpt["hyper_parameters"])
    model = LitCoMER(**hparams)
    model.load_state_dict(ckpt["state_dict"], strict=True)
    model.eval()
    return model


@torch.no_grad()
def recognize(model, img, beam_size: int = 10, max_len: int = 200) -> Tuple[List[str], float]:
    """uint8 normalised image -> (tokens, score)."""
    from comer.preprocess import to_tensor_input

    x, mask = to_tensor_input(img)
    hp = dict(model.hparams)
    hp["beam_size"] = beam_size
    hp["max_len"] = max_len
    hyp = model.comer_model.beam_search(x, mask, **hp)[0]
    return vocab.indices2words(hyp.seq), float(hyp.score)
