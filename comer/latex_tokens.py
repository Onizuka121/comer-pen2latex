"""LaTeX <-> CoMER token conversion.

CoMER works on a sequence of tokens (see comer/datamodule/dictionary.txt):
commands like ``\\frac`` or ``\\{`` are single tokens, every other character
is its own token.  This module turns a LaTeX string written by a human into
that canonical token sequence, so that fine-tuning targets use exactly the
same conventions as the CROHME training data.

Python 3.7 compatible (no walrus, no builtin generics).
"""
import re
from typing import List, Optional, Tuple

# Commands that only change horizontal spacing: invisible in handwriting,
# so they are dropped from training targets.
_DROP = {"\\ ", "\\,", "\\;", "\\:", "\\!", "\\left", "\\right", "\\displaystyle"}

# Same rendering, different spelling -> canonical CROHME spelling.
_ALIASES = {
    "\\dots": "\\ldots",
    "\\oldstyle": "\\mathcal",
    "\\to": "\\rightarrow",
    "\\le": "\\leq",
    "\\ge": "\\geq",
    "\\ne": "\\neq",
    "\\lbrace": "\\{",
    "\\rbrace": "\\}",
    "\\vert": "|",
    "\\land": "\\wedge",
    "\\lor": "\\vee",
}

# Commands accepted in user corrections besides those already in the
# dictionary.  Anything else is most likely a typo (e.g. "\\c") and the
# example is rejected instead of polluting the vocabulary.
EXTRA_COMMANDS = {
    "\\cap", "\\cup", "\\bigcap", "\\bigcup", "\\ln", "\\exp", "\\max", "\\min",
    "\\sup", "\\inf", "\\det", "\\arcsin", "\\arccos", "\\arctan", "\\sinh",
    "\\cosh", "\\tanh", "\\cot", "\\sec", "\\csc", "\\mod", "\\gcd",
    "\\emptyset", "\\varnothing", "\\cancel", "\\binom", "\\mathbb", "\\mathcal",
    "\\overline", "\\underline", "\\hat", "\\bar", "\\vec", "\\tilde", "\\dot",
    "\\ddot", "\\wedge", "\\vee", "\\neg", "\\quad", "\\qquad", "\\implies",
    "\\iff", "\\impliedby", "\\leftrightarrow", "\\Leftrightarrow",
    "\\Rightarrow", "\\Leftarrow", "\\leftarrow", "\\mapsto", "\\subset",
    "\\subseteq", "\\supset", "\\supseteq", "\\notin", "\\setminus",
    "\\partial", "\\nabla", "\\approx", "\\equiv", "\\sim", "\\simeq",
    "\\cong", "\\propto", "\\perp", "\\parallel", "\\angle", "\\circ",
    "\\ast", "\\star", "\\cdots", "\\vdots", "\\ddots", "\\prod", "\\coprod",
    "\\iint", "\\iiint", "\\oint", "\\mid", "\\nmid", "\\|", "\\langle",
    "\\rangle", "\\lfloor", "\\rfloor", "\\lceil", "\\rceil", "\\%", "\\&",
    "\\#", "\\_",
    # Greek letters
    "\\alpha", "\\beta", "\\gamma", "\\delta", "\\epsilon", "\\varepsilon",
    "\\zeta", "\\eta", "\\theta", "\\vartheta", "\\iota", "\\kappa",
    "\\lambda", "\\mu", "\\nu", "\\xi", "\\pi", "\\varpi", "\\rho",
    "\\varrho", "\\sigma", "\\varsigma", "\\tau", "\\upsilon", "\\phi",
    "\\varphi", "\\chi", "\\psi", "\\omega", "\\Gamma", "\\Delta", "\\Theta",
    "\\Lambda", "\\Xi", "\\Pi", "\\Sigma", "\\Upsilon", "\\Phi", "\\Psi",
    "\\Omega",
}

_PRIME_EXPANSION = ["^", "{", "\\prime", "}"]


def tokenize_latex(latex: str) -> List[str]:
    r"""Split a LaTeX string into CoMER tokens (canonicalised).

    >>> tokenize_latex(r"\{1,\dots,n\}") == ["\\{", "1", ",", "\\ldots", ",", "n", "\\}"]
    True
    >>> tokenize_latex(r"\left( x^2 \right)")
    ['(', 'x', '^', '{', '2', '}', ')']
    >>> tokenize_latex("p'") == ["p", "^", "{", "\\prime", "}"]
    True
    >>> " ".join(tokenize_latex(r"e^{x}_i a^\alpha"))
    'e ^ { x } _ { i } a ^ { \\alpha }'
    """
    raw = []  # type: List[str]
    i = 0
    n = len(latex)
    while i < n:
        c = latex[i]
        if c.isspace():
            i += 1
            continue
        if c == "\\":
            j = i + 1
            if j < n and latex[j].isalpha():
                while j < n and latex[j].isalpha():
                    j += 1
                raw.append(latex[i:j])
                i = j
            elif j < n:
                # control symbol: \{ \} \, \; \! \  \\ \| ...
                raw.append(latex[i : j + 1])
                i = j + 1
            else:
                raw.append("\\")  # trailing lone backslash (invalid)
                i = j
        else:
            raw.append(c)
            i += 1

    tokens = []  # type: List[str]
    for t in raw:
        t = _ALIASES.get(t, t)
        if t in _DROP:
            continue
        if t == "'":
            # x' -> x ^ { \prime }  (CROHME convention)
            tokens.extend(_PRIME_EXPANSION)
            continue
        tokens.append(t)
    return _brace_scripts(tokens)


def _brace_scripts(tokens: List[str]) -> List[str]:
    """x^2 -> x ^ { 2 }: CROHME always braces super/subscripts."""
    out = []  # type: List[str]
    i = 0
    while i < len(tokens):
        t = tokens[i]
        out.append(t)
        if t in ("^", "_") and i + 1 < len(tokens) and tokens[i + 1] != "{":
            out.extend(["{", tokens[i + 1], "}"])
            i += 2
            continue
        i += 1
    return out


def tokens_to_latex(tokens: List[str]) -> str:
    r"""Join tokens into compact, readable LaTeX (same rendering).

    Spaces are removed around ^ _ { } but always kept after a command name,
    so ``\\in x`` never becomes ``\\inx``.

    >>> tokens_to_latex(["x", "^", "{", "2", "}", "\\in", "A"])
    'x^{2} \\in A'
    >>> tokens_to_latex(["\\frac", "{", "1", "}", "{", "n", "}"])
    '\\frac{1}{n}'
    """
    out = []  # type: List[str]
    for t in tokens:
        if out:
            prev = out[-1]
            glue = t in ("^", "_", "}", "{") or prev in ("^", "_", "{")
            if prev.isdigit() and t.isdigit():
                glue = True  # 1 0 -> 10
            if prev.startswith("\\") and prev[1:].isalpha() and (t[:1].isalpha()):
                glue = False  # \in x must keep its space
            if not glue:
                out.append(" ")
        out.append(t)
    return "".join(out)


def check_tokens(tokens: List[str], known: set) -> Tuple[bool, Optional[str]]:
    """Validate a token sequence before using it as a training target.

    Returns (ok, reason).  ``known`` is the current dictionary.
    """
    if not tokens:
        return False, "empty formula"
    depth = 0
    for t in tokens:
        if t == "{":
            depth += 1
        elif t == "}":
            depth -= 1
            if depth < 0:
                return False, "unbalanced braces"
        if t.startswith("\\") and t not in known and t not in EXTRA_COMMANDS:
            return False, "unknown command %s (typo?)" % t
        if len(t) > 1 and not t.startswith("\\"):
            return False, "bad token %r" % t
    if depth != 0:
        return False, "unbalanced braces"
    return True, None
