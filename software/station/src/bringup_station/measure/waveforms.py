"""Waveform analysis: the measurement library grows here (frequency, ripple,
edge timing, bus decode hooks)."""

from __future__ import annotations

import numpy as np

from ..hal.interfaces import Waveform


def estimate_frequency(wf: Waveform) -> float:
    """Fundamental frequency estimate via zero crossings of the mean-removed
    signal. Good for clocks and periodic signals; not for modulated ones."""
    s = np.asarray(wf.samples, dtype=float)
    if len(s) < 2:
        return 0.0
    s = s - s.mean()
    signs = np.sign(s)
    signs[signs == 0] = 1
    crossing_idx = np.nonzero(np.diff(signs))[0]
    if len(crossing_idx) < 2:
        return 0.0
    # measure crossing-to-crossing so partial periods at the capture
    # boundaries don't bias the estimate
    span_s = (crossing_idx[-1] - crossing_idx[0]) / wf.sample_rate_hz
    return float((len(crossing_idx) - 1) / 2.0 / span_s)


def peak(wf: Waveform) -> float:
    s = np.asarray(wf.samples, dtype=float)
    return float(np.max(np.abs(s))) if len(s) else 0.0
