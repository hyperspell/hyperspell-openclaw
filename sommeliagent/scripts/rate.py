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

CONFIG_DIR = Path.home() / ".sommeliagent"
RATINGS_FILE = CONFIG_DIR / "ratings.json"

# Wine ID → tags mapping (must match recommend.py database)
WINE_TAGS = {
    # REDS (original)
    "barolo-massolino": ["old-world", "age-worthy", "terroir-driven"],
    "malbec-catena": ["new-world", "fruit-forward", "approachable"],
    "pinot-noir-burgundy": ["old-world", "terroir-driven", "elegant"],
    "cab-sav-napa": ["new-world", "fruit-forward", "oaky"],
    "syrah-northern-rhone": ["old-world", "terroir-driven", "spicy"],
    "nero-davola-sicily": ["old-world", "obscure-varietal", "mediterranean"],
    "natural-gamay": ["natural", "old-world", "light-bodied", "terroir-driven"],
    "tempranillo-rioja": ["old-world", "age-worthy", "terroir-driven", "obscure-varietal"],
    "xinomavro-naoussa": ["old-world", "obscure-varietal", "terroir-driven"],
    "trousseau-jura": ["natural", "old-world", "obscure-varietal", "light-bodied", "terroir-driven"],
    "zinfandel-ridge": ["new-world", "fruit-forward", "spicy"],
    # WHITES (original)
    "riesling-mosel": ["old-world", "sweet-ish", "elegant"],
    "sauvignon-blanc-loire": ["old-world", "mineral", "terroir-driven"],
    "skin-contact-friulano": ["natural", "orange-wine", "terroir-driven", "obscure-varietal"],
    "chardonnay-meursault": ["old-world", "terroir-driven", "elegant"],
    "gruner-veltliner": ["old-world", "biodynamic", "obscure-varietal", "mineral"],
    "chenin-blanc-loire": ["old-world", "biodynamic", "terroir-driven", "age-worthy"],
    "assyrtiko-santorini": ["old-world", "obscure-varietal", "mineral", "terroir-driven"],
    # ROSÉ & SPARKLING (original)
    "provence-rose": ["old-world", "approachable", "summer"],
    "cerasuolo-abruzzo": ["old-world", "natural", "terroir-driven", "obscure-varietal"],
    "champagne-grower": ["old-world", "terroir-driven", "elegant", "obscure-varietal"],
    "pet-nat-carignan": ["natural", "pet-nat", "fun", "obscure-varietal"],
    "lambrusco-cleto": ["old-world", "fun", "approachable", "obscure-varietal"],
    # REDS (expanded)
    "barbera-alba": ["old-world", "fruit-forward", "approachable"],
    "cotes-du-rhone-village": ["old-world", "natural", "mediterranean", "approachable"],
    "cab-franc-loire": ["old-world", "terroir-driven", "elegant", "age-worthy"],
    "cru-beaujolais-morgon": ["old-world", "natural", "terroir-driven", "age-worthy"],
    "chianti-classico-riserva": ["old-world", "terroir-driven", "elegant", "age-worthy"],
    "brunello-montalcino": ["old-world", "terroir-driven", "age-worthy", "elegant"],
    "pinotage-swartland": ["new-world", "fruit-forward", "approachable", "obscure-varietal"],
    "shiraz-barossa": ["new-world", "fruit-forward", "oaky", "spicy"],
    "pinot-noir-central-otago": ["new-world", "elegant", "terroir-driven"],
    "carmenere-chile": ["new-world", "fruit-forward", "obscure-varietal", "approachable"],
    "bonarda-mendoza": ["new-world", "fruit-forward", "approachable", "obscure-varietal"],
    "etna-rosso": ["old-world", "terroir-driven", "elegant", "mineral"],
    "zweigelt-austria": ["old-world", "approachable", "fruit-forward", "fun"],
    "mencia-bierzo": ["old-world", "terroir-driven", "elegant", "obscure-varietal"],
    "agiorgitiko-nemea": ["old-world", "approachable", "fruit-forward", "mediterranean"],
    "touriga-nacional-douro": ["old-world", "fruit-forward", "approachable"],
    "blaufrankisch-burgenland": ["old-world", "terroir-driven", "spicy", "mineral"],
    "sagrantino-montefalco": ["old-world", "natural", "age-worthy", "obscure-varietal"],
    "pinot-noir-willamette": ["new-world", "elegant", "terroir-driven"],
    "petite-sirah-paso": ["new-world", "fruit-forward", "spicy", "oaky"],
    "kadarka-szekszard": ["old-world", "obscure-varietal", "elegant", "spicy"],
    "tannat-uruguay": ["new-world", "age-worthy", "obscure-varietal"],
    "cannonau-sardinia": ["old-world", "mediterranean", "approachable", "fruit-forward"],
    "mouvedre-bandol": ["old-world", "terroir-driven", "age-worthy", "spicy"],
    "cab-sav-coonawarra": ["new-world", "terroir-driven", "age-worthy", "elegant"],
    "primitivo-puglia": ["old-world", "fruit-forward", "mediterranean"],
    "cinsault-old-vine-sa": ["new-world", "natural", "light-bodied", "fun"],
    "grenache-mclaren-vale": ["new-world", "fruit-forward", "terroir-driven", "spicy"],
    "dornfelder-pfalz": ["old-world", "approachable", "fruit-forward", "fun"],
    "dao-tinto": ["old-world", "natural", "terroir-driven", "approachable"],
    "saint-joseph-rouge": ["old-world", "terroir-driven", "spicy", "elegant"],
    "natural-poulsard-jura": ["old-world", "natural", "light-bodied", "obscure-varietal"],
    "natural-nero-calabria": ["old-world", "natural", "terroir-driven", "obscure-varietal"],
    # WHITES (expanded)
    "chablis-premier-cru": ["old-world", "terroir-driven", "mineral", "age-worthy"],
    "albarino-rias-baixas": ["old-world", "approachable", "mineral", "summer"],
    "fiano-di-avellino": ["old-world", "terroir-driven", "obscure-varietal", "mineral"],
    "torrontes-salta": ["new-world", "fruit-forward", "approachable", "fun"],
    "viognier-condrieu": ["old-world", "fruit-forward", "elegant"],
    "godello-valdeorras": ["old-world", "terroir-driven", "mineral", "obscure-varietal"],
    "verdicchio-castelli": ["old-world", "terroir-driven", "mineral", "age-worthy"],
    "furmint-tokaj": ["old-world", "mineral", "terroir-driven", "obscure-varietal"],
    "semillon-hunter": ["new-world", "terroir-driven", "age-worthy", "mineral"],
    "sauvignon-blanc-marlborough": ["new-world", "fruit-forward", "approachable", "summer"],
    "txakoli-basque": ["old-world", "light-bodied", "fun", "summer"],
    "muscadet-sevre": ["old-world", "mineral", "approachable", "light-bodied"],
    "chardonnay-sonoma": ["new-world", "elegant", "terroir-driven"],
    "gewurztraminer-alsace": ["old-world", "spicy", "fruit-forward"],
    "verdejo-rueda": ["old-world", "approachable", "summer", "fun"],
    "riesling-clare-valley": ["new-world", "terroir-driven", "mineral", "age-worthy"],
    "white-burgundy-macon": ["old-world", "approachable", "elegant"],
    "vidiano-crete": ["old-world", "fruit-forward", "obscure-varietal", "approachable"],
    "marsanne-roussanne-rhone": ["old-world", "terroir-driven", "elegant"],
    "gruner-smaragd": ["old-world", "terroir-driven", "mineral", "age-worthy"],
    "viura-rioja-blanco": ["old-world", "terroir-driven", "age-worthy", "oaky"],
    "trebbiano-valentini": ["old-world", "terroir-driven", "age-worthy", "elegant"],
    "chenin-blanc-sa": ["new-world", "fruit-forward", "approachable"],
    "picpoul-de-pinet": ["old-world", "light-bodied", "summer", "approachable"],
    "pinot-gris-alsace": ["old-world", "fruit-forward", "elegant"],
    "roussanne-tablas-creek": ["new-world", "terroir-driven", "elegant", "obscure-varietal"],
    "biodynamic-pinot-blanc-alsace": ["old-world", "biodynamic", "approachable"],
    "biodynamic-riesling-alsace": ["old-world", "biodynamic", "terroir-driven", "mineral"],
    # ROSÉ (expanded)
    "tavel-rose": ["old-world", "terroir-driven", "mediterranean"],
    "rose-bandol": ["old-world", "terroir-driven", "elegant", "summer"],
    "rose-navarra": ["old-world", "approachable", "summer", "fun"],
    "rose-txakoli": ["old-world", "light-bodied", "fun", "summer"],
    # ORANGE (expanded)
    "orange-ribolla-gravner": ["old-world", "natural", "orange-wine", "terroir-driven"],
    "orange-rkatsiteli-georgia": ["old-world", "natural", "orange-wine", "terroir-driven"],
    "orange-zierfandler-austria": ["old-world", "orange-wine", "obscure-varietal", "natural"],
    "orange-malvasia-radikon": ["old-world", "natural", "orange-wine", "age-worthy"],
    "orange-muscat-sa": ["new-world", "natural", "orange-wine", "fun"],
    # SPARKLING (expanded)
    "cremant-alsace": ["old-world", "approachable", "fun"],
    "franciacorta-brut": ["old-world", "elegant", "age-worthy"],
    "cava-reserva": ["old-world", "terroir-driven", "mineral"],
    "sekt-riesling": ["old-world", "mineral", "fun", "approachable"],
    "pet-nat-chenin": ["old-world", "natural", "pet-nat", "fun"],
    "prosecco-superiore": ["old-world", "approachable", "fun", "fruit-forward"],
    "blanc-de-blancs-champagne": ["old-world", "elegant", "terroir-driven", "mineral"],
    "ancestral-method-piquette": ["new-world", "natural", "fun", "light-bodied"],
    "cap-classique-sa": ["new-world", "elegant", "approachable"],
    "pet-nat-gamay-loire": ["old-world", "natural", "pet-nat", "fun"],
    # SWEET & DESSERT
    "tokaji-aszu-5-puttonyos": ["old-world", "age-worthy", "sweet-ish", "elegant"],
    "riesling-spatlese-mosel": ["old-world", "sweet-ish", "elegant", "age-worthy"],
    "moscato-dasti": ["old-world", "sweet-ish", "fun", "light-bodied"],
    "sauternes-classic": ["old-world", "age-worthy", "sweet-ish", "elegant"],
}


def load_ratings() -> list[dict]:
    if RATINGS_FILE.exists():
        return json.loads(RATINGS_FILE.read_text())
    return []


def save_ratings(ratings: list[dict]) -> None:
    import stat
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    RATINGS_FILE.write_text(json.dumps(ratings, indent=2))
    RATINGS_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)


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
