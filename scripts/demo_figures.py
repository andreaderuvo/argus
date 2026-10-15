"""The demo's figures and its PDF, drawn from made-up numbers.

The demo used to borrow: the Argus logo stood in for the tree, and a real PDF from the home folder
of whoever ran it was copied in as the "cluster report" — a private document, one screenshot away
from a public page. Everything here is generated from a fixed seed instead: 412 invented
Salmonella isolates, four clusters, three regions, and the pictures a report on them would have.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402
from scipy.cluster.hierarchy import dendrogram, linkage  # noqa: E402
from scipy.spatial.distance import squareform  # noqa: E402

TEAL, AMBER, ROSE, SLATE, GREY = "#1f7f79", "#e3a93b", "#c8566b", "#4a6b8a", "#9aa7ae"
CLUSTERS = {"C1": (14, TEAL), "C2": (8, SLATE), "C3": (11, ROSE), "C4": (5, AMBER)}


def _isolates(rng):
    names, groups = [], []
    n = 1
    for cluster, (size, _colour) in CLUSTERS.items():
        for _ in range(size):
            names.append(f"SAL-2026-{n:04d}")
            groups.append(cluster)
            n += rng.integers(1, 9)
    for _ in range(10):                                    # sporadic, in no cluster
        names.append(f"SAL-2026-{n:04d}")
        groups.append("—")
        n += rng.integers(1, 9)
    return names, groups


def _distances(rng, groups):
    k = len(groups)
    d = np.zeros((k, k))
    for i in range(k):
        for j in range(i + 1, k):
            same = groups[i] == groups[j] and groups[i] != "—"
            d[i, j] = d[j, i] = rng.integers(0, 5) if same else rng.integers(18, 140)
    return d


def _style():
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.spines.top": False,
                         "axes.spines.right": False, "axes.edgecolor": "#5b6b75", "axes.labelcolor": "#2b3a44",
                         "xtick.color": "#5b6b75", "ytick.color": "#5b6b75", "figure.dpi": 150})


def tree(ax, names, groups, d):
    z = linkage(squareform(d), method="average")
    colour = {c: col for c, (_n, col) in CLUSTERS.items()}
    out = dendrogram(z, labels=names, orientation="left", ax=ax, color_threshold=5,
                     above_threshold_color=GREY, leaf_font_size=6.2)
    for label in ax.get_yticklabels():
        g = groups[names.index(label.get_text())]
        label.set_color(colour.get(g, "#5b6b75"))
    ax.axvline(5, color=ROSE, lw=1, ls="--")
    ax.text(5.6, 2, "5-allele threshold", color=ROSE, fontsize=7, rotation=90, va="bottom")
    ax.set_xlabel("cgMLST allelic distance")
    ax.set_title("Isolates at the 5-allele threshold (48 of 412 shown)", fontsize=10, loc="left", color="#15232d")
    return out


def epicurve(ax, rng):
    weeks = np.arange(1, 27)
    regions = [("North", TEAL), ("Centre", SLATE), ("South", AMBER)]
    bottom = np.zeros(len(weeks))
    for name, colour in regions:
        base = rng.poisson(2.2, len(weeks)).astype(float)
        if name != "Centre":
            base[19:25] += [1, 2, 3, 2, 2, 1]                # C3: six weeks, three regions
        else:
            base[20:24] += [1, 1, 2, 1]
        ax.bar(weeks, base, bottom=bottom, color=colour, width=0.8, label=name)
        bottom += base
    ax.axvspan(19.5, 25.5, color=ROSE, alpha=0.08)
    ax.text(22.5, bottom.max() * 1.02, "C3", color=ROSE, ha="center", fontsize=9, fontweight="bold")
    ax.set_xlabel("week of sampling, 2026")
    ax.set_ylabel("isolates")
    ax.legend(frameon=False, ncol=3, loc="upper left", fontsize=8)
    ax.set_title("Isolates by week and region", fontsize=10, loc="left", color="#15232d")


def heatmap(ax, names, groups, d):
    order = np.argsort([list(CLUSTERS).index(g) if g in CLUSTERS else 9 for g in groups], kind="stable")
    m = d[np.ix_(order, order)]
    im = ax.imshow(np.minimum(m, 40), cmap="viridis_r", interpolation="nearest")
    ax.set_xticks([])
    ax.set_yticks([])
    ax.set_title("Pairwise distances (capped at 40)", fontsize=10, loc="left", color="#15232d")
    plt.colorbar(im, ax=ax, fraction=0.046, pad=0.03, label="alleles")


def make(results: Path, seed: int = 2026) -> None:
    """tree.png, epicurve.png, distances.png and cluster-report.pdf under `results`."""
    _style()
    rng = np.random.default_rng(seed)
    names, groups = _isolates(rng)
    d = _distances(rng, groups)
    results.mkdir(parents=True, exist_ok=True)

    fig, ax = plt.subplots(figsize=(6.4, 7.2))
    tree(ax, names, groups, d)
    fig.tight_layout()
    fig.savefig(results / "tree.png")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 3.2))
    epicurve(ax, np.random.default_rng(seed + 1))
    fig.tight_layout()
    fig.savefig(results / "epicurve.png")
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(4.6, 4))
    heatmap(ax, names, groups, d)
    fig.tight_layout()
    fig.savefig(results / "distances.png")
    plt.close(fig)

    with PdfPages(results / "cluster-report.pdf") as pdf:
        fig = plt.figure(figsize=(8.27, 11.69))
        fig.text(0.08, 0.93, "Salmonella Typhimurium — cluster report", fontsize=18, fontweight="bold", color="#15232d")
        fig.text(0.08, 0.905, "Run 2026-08-04 · 412 isolates · scheme senterica_cgMLST (3002 loci)", fontsize=10, color="#4a5b66")
        body = ("Four clusters at the 5-allele threshold. Two were already known; C3 is new — eleven isolates,\n"
                "three regions, six weeks — and it is the one worth a phone call.\n\n"
                "Four isolates carry 40–120 missing loci; their distances are reported both with and without them.")
        fig.text(0.08, 0.83, body, fontsize=10, color="#15232d", va="top", linespacing=1.6)
        ax = fig.add_axes([0.1, 0.42, 0.82, 0.3])
        epicurve(ax, np.random.default_rng(seed + 1))
        ax2 = fig.add_axes([0.1, 0.07, 0.45, 0.3])
        heatmap(ax2, names, groups, d)
        pdf.savefig(fig)
        plt.close(fig)
        fig, ax = plt.subplots(figsize=(8.27, 11.69))
        tree(ax, names, groups, d)
        fig.tight_layout()
        pdf.savefig(fig)
        plt.close(fig)


if __name__ == "__main__":
    import sys
    make(Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/lab-figures"))
