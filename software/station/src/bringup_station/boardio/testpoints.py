"""Board model and test point import.

Test points come from the board's CAD export in board coordinates. CSV format
(header required): name,net,x_mm,y_mm. Fiducials use the same format in a
separate file or are flagged by a name prefix (FID*). KiCad/centroid importers
land here in roadmap S3.
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Tuple


@dataclass(frozen=True)
class TestPoint:
    __test__ = False  # not a pytest class, despite the name

    name: str
    net: str
    x_mm: float
    y_mm: float

    @property
    def is_fiducial(self) -> bool:
        return self.name.upper().startswith("FID")


@dataclass
class Board:
    name: str
    testpoints: Dict[str, TestPoint] = field(default_factory=dict)

    @property
    def fiducials(self) -> List[TestPoint]:
        return [tp for tp in self.testpoints.values() if tp.is_fiducial]

    def point(self, name: str) -> TestPoint:
        try:
            return self.testpoints[name]
        except KeyError:
            raise KeyError("board {!r} has no test point {!r}".format(
                self.name, name)) from None


def load_csv(path: "str | Path", board_name: "str | None" = None) -> Board:
    path = Path(path)
    board = Board(name=board_name or path.stem)
    with path.open(newline="") as fh:
        for row in csv.DictReader(fh):
            tp = TestPoint(name=row["name"].strip(), net=row["net"].strip(),
                           x_mm=float(row["x_mm"]), y_mm=float(row["y_mm"]))
            board.testpoints[tp.name] = tp
    return board


def load_json(path: "str | Path") -> Board:
    data = json.loads(Path(path).read_text())
    board = Board(name=data["name"])
    for item in data["testpoints"]:
        tp = TestPoint(name=item["name"], net=item["net"],
                       x_mm=float(item["x_mm"]), y_mm=float(item["y_mm"]))
        board.testpoints[tp.name] = tp
    return board
