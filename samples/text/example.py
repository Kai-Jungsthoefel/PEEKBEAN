"""Example: count the parts of a parts list by size."""
import csv
from collections import Counter


def count_by_size(path: str) -> Counter:
    with open(path, encoding="utf-8") as f:
        rows = csv.DictReader(f)
        return Counter(row["Size"] for row in rows)


if __name__ == "__main__":
    for size, n in count_by_size("parts.csv").most_common():
        print(f"{size}: {n} pcs")
