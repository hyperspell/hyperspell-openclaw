# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
View SommeliAgent recommendation history and ratings.
"""

import json
import sys
from pathlib import Path

CONFIG_DIR = Path.home() / ".sommeliagent"
RATINGS_FILE = CONFIG_DIR / "ratings.json"


def main():
    if not RATINGS_FILE.exists():
        print("No ratings yet. Try some wines and rate them!")
        sys.exit(0)

    try:
        ratings = json.loads(RATINGS_FILE.read_text())
    except (json.JSONDecodeError, OSError) as e:
        print(f"Error reading ratings file: {e}", file=sys.stderr)
        print(f"You can delete {RATINGS_FILE} to reset.", file=sys.stderr)
        sys.exit(1)
    if not ratings:
        print("No ratings yet. Try some wines and rate them!")
        sys.exit(0)

    print(f"SommeliAgent — Rating History ({len(ratings)} wines rated)")
    print("=" * 50)
    print()

    label = {1: "hated it", 2: "not great", 3: "okay", 4: "liked it", 5: "loved it"}

    for i, entry in enumerate(ratings, 1):
        wine_id = entry.get("wine_id", "unknown")
        rating = max(1, min(5, entry.get("rating", 3)))
        stars = "★" * rating + "☆" * (5 - rating)
        print(f"{i}. {wine_id}")
        print(f"   {stars} ({label.get(rating, 'unknown')})")
        if entry.get("notes"):
            print(f"   \"{entry['notes']}\"")
        if entry.get("timestamp"):
            print(f"   Rated: {entry['timestamp'][:10]}")
        print()

    # Summary stats
    avg = sum(r.get("rating", 3) for r in ratings) / len(ratings)
    loved = sum(1 for r in ratings if r.get("rating", 3) >= 4)
    print(f"Average rating: {avg:.1f}/5")
    print(f"Wines you loved: {loved}/{len(ratings)}")

    # Tag preferences
    tag_scores: dict[str, list[int]] = {}
    for r in ratings:
        for tag in r.get("tags", []):
            tag_scores.setdefault(tag, []).append(r.get("rating", 3))

    if tag_scores:
        print("\nYour taste profile (from ratings):")
        sorted_tags = sorted(tag_scores.items(), key=lambda x: -sum(x[1]) / len(x[1]))
        for tag, scores in sorted_tags[:8]:
            avg_tag = sum(scores) / len(scores)
            bar = "★" * round(avg_tag) + "☆" * (5 - round(avg_tag))
            print(f"  {tag:<20} {bar} ({avg_tag:.1f} avg, {len(scores)} wines)")


if __name__ == "__main__":
    main()
