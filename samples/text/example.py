"""Beispiel: Schraubenliste auswerten."""
import csv
from collections import Counter


def count_by_size(path: str) -> Counter:
    with open(path, encoding="utf-8") as f:
        rows = csv.DictReader(f, delimiter=";")
        return Counter(row["Groesse"] for row in rows)


if __name__ == "__main__":
    for size, n in count_by_size("teile.csv").most_common():
        print(f"{size}: {n} Stück")
