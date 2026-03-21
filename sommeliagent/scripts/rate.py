# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Rate a wine recommendation to improve future suggestions.
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from wine_db import WINE_DB

CONFIG_DIR = Path.home() / ".sommeliagent"
RATINGS_FILE = CONFIG_DIR / "ratings.json"

# Wine ID → tags mapping (derived from wine_db)
WINE_TAGS = {w.id: w.tags for w in WINE_DB}


def load_ratings() -> list[dict]:
    if RATINGS_FILE.exists():
        try:
            return json.loads(RATINGS_FILE.read_text())
        except (OSError, json.JSONDecodeError) as e:
            print(f"Warning: could not read {RATINGS_FILE}: {e}", file=sys.stderr)
            return []
    return []


def save_ratings(ratings: list[dict]) -> None:
    import stat
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RATINGS_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(ratings, indent=2))
    tmp.chmod(stat.S_IRUSR | stat.S_IWUSR)
    tmp.replace(RATINGS_FILE)


def main():
    parser = argparse.ArgumentParser(description="Rate a wine recommendation")
    parser.add_argument("--wine-id", required=True, help="Wine ID from recommendation")
    parser.add_argument("--rating", type=int, required=True, choices=[1, 2, 3, 4, 5], help="Rating 1-5")
    parser.add_argument("--notes", default="", help="Optional tasting notes")
    args = parser.parse_args()

    tags = WINE_TAGS.get(args.wine_id)
    if tags is None:
        valid_ids = ", ".join(sorted(WINE_TAGS.keys()))
        print(f"Error: Unknown wine ID '{args.wine_id}'.", file=sys.stderr)
        print(f"Valid IDs: {valid_ids}", file=sys.stderr)
        sys.exit(1)

    ratings = load_ratings()
    ratings.append({
        "wine_id": args.wine_id,
        "rating": args.rating,
        "notes": args.notes,
        "tags": tags,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    save_ratings(ratings)

    label = {1: "hated it", 2: "not great", 3: "okay", 4: "liked it", 5: "loved it"}
    print(f"Rated {args.wine_id}: {args.rating}/5 ({label[args.rating]})")
    if args.notes:
        print(f"Notes: \"{args.notes}\"")
    print(f"Total ratings: {len(ratings)}")
    print("Future recommendations will factor this in.")


if __name__ == "__main__":
    main()
