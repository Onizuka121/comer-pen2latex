from .datamodule import Batch, CROHMEDatamodule
from .vocab import vocab



def __getattr__(name):
    # vocab_size is computed on access: the vocabulary can be reloaded to
    # match a checkpoint (see comer.inference.load_model).
    if name == "vocab_size":
        return len(vocab)
    raise AttributeError(name)

__all__ = [
    "CROHMEDatamodule",
    "vocab",
    "Batch",
    "vocab_size",
]
