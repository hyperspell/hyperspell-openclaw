# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx"]
# ///
"""
SommeliAgent — Wine recommendation engine.

Fetches Spotify listening data, maps music features to wine dimensions,
and outputs personalized recommendations with cross-domain explanations.
"""

import argparse
import json
import stat
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import httpx

from wine_db import WineProfile, Wine, WINE_DB  # noqa: E402

CONFIG_DIR = Path.home() / ".sommeliagent"
TOKEN_FILE = CONFIG_DIR / "token.json"
RATINGS_FILE = CONFIG_DIR / "ratings.json"
CACHE_FILE = CONFIG_DIR / "profile_cache.json"
SPOTIFY_API = "https://api.spotify.com/v1"
CACHE_TTL_SECONDS = 3600  # 1 hour


# ──────────────────────────────────────────────
# Types
# ──────────────────────────────────────────────

@dataclass
class MusicProfile:
    avg_valence: float = 0.0
    avg_energy: float = 0.0
    avg_danceability: float = 0.0
    avg_acousticness: float = 0.0
    avg_tempo: float = 0.0
    avg_complexity: float = 0.0
    obscurity_score: float = 0.0
    genre_distribution: dict[str, float] = field(default_factory=dict)
    mood_label: str = ""
    top_artists: list[str] = field(default_factory=list)
    top_tracks: list[str] = field(default_factory=list)
    has_audio_features: bool = True


@dataclass
class MusicWineConnection:
    music_signal: str
    wine_signal: str
    explanation: str
    strength: float


@dataclass
class Recommendation:
    wine: Wine
    score: float
    reasoning: str
    connections: list[MusicWineConnection]


# ──────────────────────────────────────────────
# Spotify API (with retry + caching)
# ──────────────────────────────────────────────

def get_access_token() -> str:
    """Get a valid Spotify access token. Delegates refresh to auth module."""
    # Import auth module from same directory
    sys.path.insert(0, str(Path(__file__).parent))
    from auth import get_access_token as _refresh_token, load_token

    token = _refresh_token()
    if token:
        return token

    # Fallback: use stored access token directly (may be expired)
    token_data = load_token()
    if token_data and token_data.get("access_token"):
        return token_data["access_token"]

    print("ERROR: Not authenticated. Run the auth script first.", file=sys.stderr)
    sys.exit(1)


def spotify_get(token: str, endpoint: str, params: dict | None = None, max_retries: int = 2) -> dict:
    """GET with retry on 429 (rate limit) and transient errors."""
    for attempt in range(max_retries + 1):
        resp = httpx.get(
            f"{SPOTIFY_API}{endpoint}",
            headers={"Authorization": f"Bearer {token}"},
            params=params or {},
        )
        if resp.status_code == 401:
            print("ERROR: Spotify token expired. Re-run auth script.", file=sys.stderr)
            sys.exit(1)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 2))
            if attempt < max_retries:
                print(f"Rate limited. Waiting {retry_after}s...", file=sys.stderr)
                time.sleep(retry_after)
                continue
        if resp.status_code >= 500 and attempt < max_retries:
            time.sleep(2 ** attempt)
            continue
        resp.raise_for_status()
        return resp.json()
    resp.raise_for_status()
    return {}  # unreachable


def load_cached_profile() -> MusicProfile | None:
    if not CACHE_FILE.exists():
        return None
    try:
        data = json.loads(CACHE_FILE.read_text())
        if time.time() - data.get("_cached_at", 0) > CACHE_TTL_SECONDS:
            return None
        del data["_cached_at"]
        return MusicProfile(**data)
    except Exception:
        return None


def save_cached_profile(profile: MusicProfile) -> None:
    data = asdict(profile)
    data["_cached_at"] = time.time()
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp_file = CACHE_FILE.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(data, indent=2))
    tmp_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    tmp_file.replace(CACHE_FILE)


def build_music_profile(token: str) -> MusicProfile:
    # Check cache first
    cached = load_cached_profile()
    if cached:
        return cached

    # Fetch top tracks and artists (always available)
    top_tracks_data = spotify_get(token, "/me/top/tracks", {"time_range": "medium_term", "limit": 50})
    top_artists_data = spotify_get(token, "/me/top/artists", {"time_range": "medium_term", "limit": 50})

    tracks = top_tracks_data.get("items", [])
    artists = top_artists_data.get("items", [])

    if not tracks:
        print("ERROR: No listening data found. Listen to more music on Spotify first!", file=sys.stderr)
        sys.exit(1)

    # Try audio features (may be deprecated/restricted)
    features: list[dict] = []
    track_ids = [t["id"] for t in tracks]
    try:
        features_data = spotify_get(token, "/audio-features", {"ids": ",".join(track_ids[:100])})
        features = [f for f in features_data.get("audio_features", []) if f is not None]
    except Exception as e:
        print(f"Audio features unavailable (may be deprecated): {e}", file=sys.stderr)
        print("Falling back to genre-based profiling.", file=sys.stderr)

    profile = aggregate_profile(tracks, artists, features)
    save_cached_profile(profile)
    return profile


def aggregate_profile(tracks: list, artists: list, features: list) -> MusicProfile:
    has_audio_features = len(features) > 0
    n = len(features) or 1

    if has_audio_features:
        avg_valence = sum(f["valence"] for f in features) / n
        avg_energy = sum(f["energy"] for f in features) / n
        avg_danceability = sum(f["danceability"] for f in features) / n
        avg_acousticness = sum(f["acousticness"] for f in features) / n
        avg_tempo = sum(f["tempo"] for f in features) / n

        avg_instrumentalness = sum(f["instrumentalness"] for f in features) / n
        time_sigs = set(f["time_signature"] for f in features)
        time_sig_variety = min(len(time_sigs) / 5, 1.0)
        avg_complexity = avg_instrumentalness * 0.3 + time_sig_variety * 0.3 + (1 - avg_danceability) * 0.4
    else:
        # Fallback: estimate from genres
        avg_valence, avg_energy, avg_danceability, avg_acousticness, avg_tempo, avg_complexity = (
            estimate_features_from_genres(artists)
        )

    avg_popularity = sum(t.get("popularity", 50) for t in tracks) / (len(tracks) or 1)
    obscurity_score = 1 - avg_popularity / 100

    genre_counts: dict[str, int] = {}
    for artist in artists:
        for genre in artist.get("genres", []):
            genre_counts[genre] = genre_counts.get(genre, 0) + 1
    total_genres = sum(genre_counts.values()) or 1
    genre_distribution = {g: c / total_genres for g, c in sorted(genre_counts.items(), key=lambda x: -x[1])}

    mood_label = derive_mood(avg_valence, avg_energy)

    top_artist_names = [a["name"] for a in artists[:10]]
    top_track_names = [f"{t['name']} — {t['artists'][0]['name']}" for t in tracks[:10] if t.get('artists')]

    return MusicProfile(
        avg_valence=avg_valence,
        avg_energy=avg_energy,
        avg_danceability=avg_danceability,
        avg_acousticness=avg_acousticness,
        avg_tempo=avg_tempo,
        avg_complexity=avg_complexity,
        obscurity_score=obscurity_score,
        genre_distribution=genre_distribution,
        mood_label=mood_label,
        top_artists=top_artist_names,
        top_tracks=top_track_names,
        has_audio_features=has_audio_features,
    )


# ──────────────────────────────────────────────
# Genre-based feature estimation (fallback)
# ──────────────────────────────────────────────

# Genre archetypes: (valence, energy, danceability, acousticness, tempo_norm, complexity)
GENRE_ARCHETYPES: dict[str, tuple[float, float, float, float, float, float]] = {
    # Electronic / Dance
    "edm": (0.6, 0.8, 0.8, 0.1, 0.65, 0.2),
    "house": (0.6, 0.7, 0.8, 0.1, 0.62, 0.3),
    "techno": (0.3, 0.8, 0.7, 0.05, 0.65, 0.4),
    "ambient": (0.3, 0.2, 0.2, 0.6, 0.40, 0.6),
    "electronic": (0.5, 0.6, 0.6, 0.15, 0.60, 0.5),
    "drum and bass": (0.4, 0.9, 0.6, 0.05, 0.85, 0.4),
    "trip hop": (0.3, 0.4, 0.5, 0.3, 0.45, 0.6),
    # Rock
    "rock": (0.5, 0.7, 0.5, 0.3, 0.60, 0.4),
    "indie rock": (0.4, 0.6, 0.5, 0.4, 0.55, 0.5),
    "art rock": (0.3, 0.5, 0.4, 0.4, 0.50, 0.8),
    "post-punk": (0.3, 0.6, 0.5, 0.3, 0.55, 0.6),
    "shoegaze": (0.3, 0.5, 0.3, 0.3, 0.50, 0.6),
    "post-rock": (0.3, 0.5, 0.2, 0.4, 0.50, 0.7),
    "punk": (0.5, 0.9, 0.4, 0.3, 0.70, 0.2),
    "metal": (0.3, 0.9, 0.3, 0.1, 0.70, 0.5),
    "alternative": (0.4, 0.6, 0.5, 0.3, 0.55, 0.5),
    "grunge": (0.3, 0.7, 0.4, 0.3, 0.55, 0.4),
    "classic rock": (0.5, 0.7, 0.5, 0.3, 0.60, 0.4),
    "progressive rock": (0.4, 0.6, 0.3, 0.3, 0.55, 0.9),
    # Jazz / Classical / Complex
    "jazz": (0.4, 0.4, 0.4, 0.7, 0.55, 0.9),
    "classical": (0.4, 0.3, 0.2, 0.9, 0.50, 0.9),
    "contemporary classical": (0.3, 0.3, 0.2, 0.8, 0.45, 0.9),
    "experimental": (0.3, 0.5, 0.3, 0.4, 0.50, 0.9),
    "avant-garde": (0.3, 0.5, 0.2, 0.4, 0.50, 0.9),
    # Folk / Acoustic / Singer-Songwriter
    "folk": (0.5, 0.3, 0.4, 0.8, 0.50, 0.4),
    "singer-songwriter": (0.4, 0.3, 0.4, 0.7, 0.50, 0.4),
    "acoustic": (0.5, 0.3, 0.4, 0.9, 0.50, 0.3),
    "americana": (0.5, 0.4, 0.4, 0.7, 0.55, 0.4),
    "country": (0.6, 0.5, 0.5, 0.6, 0.55, 0.3),
    "bluegrass": (0.5, 0.5, 0.5, 0.9, 0.60, 0.5),
    # Pop / R&B
    "pop": (0.7, 0.6, 0.7, 0.2, 0.60, 0.2),
    "indie pop": (0.6, 0.5, 0.6, 0.3, 0.55, 0.3),
    "r&b": (0.5, 0.5, 0.7, 0.3, 0.55, 0.4),
    "soul": (0.5, 0.5, 0.6, 0.5, 0.55, 0.5),
    "funk": (0.7, 0.7, 0.8, 0.3, 0.55, 0.5),
    "neo soul": (0.5, 0.4, 0.6, 0.4, 0.50, 0.6),
    # Hip-Hop
    "hip hop": (0.5, 0.6, 0.8, 0.1, 0.55, 0.3),
    "rap": (0.5, 0.7, 0.7, 0.1, 0.55, 0.3),
    "underground hip hop": (0.4, 0.5, 0.6, 0.2, 0.50, 0.5),
    # World / Latin
    "bossa nova": (0.6, 0.3, 0.6, 0.7, 0.55, 0.5),
    "latin": (0.7, 0.7, 0.8, 0.3, 0.55, 0.3),
    "afrobeat": (0.6, 0.7, 0.8, 0.3, 0.55, 0.6),
    "reggae": (0.6, 0.5, 0.7, 0.4, 0.45, 0.3),
    # Blues
    "blues": (0.4, 0.5, 0.5, 0.6, 0.50, 0.5),
    "delta blues": (0.3, 0.4, 0.4, 0.8, 0.50, 0.5),
}

# Default for unrecognized genres
_DEFAULT_ARCHETYPE = (0.5, 0.5, 0.5, 0.5, 0.55, 0.5)


def estimate_features_from_genres(
    artists: list[dict],
) -> tuple[float, float, float, float, float, float]:
    """Estimate audio features from genre distribution when audio features API is unavailable."""
    genre_weights: dict[str, float] = {}
    for artist in artists:
        for genre in artist.get("genres", []):
            genre_weights[genre] = genre_weights.get(genre, 0) + 1

    if not genre_weights:
        v, e, d, a, t, c = _DEFAULT_ARCHETYPE
        return (v, e, d, a, t * 200, c)

    total = sum(genre_weights.values())
    valence = energy = dance = acoustic = tempo = complexity = 0.0

    for genre, count in genre_weights.items():
        w = count / total
        # Find best matching archetype (longest key match wins)
        archetype = _DEFAULT_ARCHETYPE
        best_len = 0
        for key, vals in GENRE_ARCHETYPES.items():
            if key in genre or genre in key:
                if len(key) > best_len:
                    archetype = vals
                    best_len = len(key)
        valence += archetype[0] * w
        energy += archetype[1] * w
        dance += archetype[2] * w
        acoustic += archetype[3] * w
        tempo += archetype[4] * w
        complexity += archetype[5] * w

    return valence, energy, dance, acoustic, tempo * 200, complexity


def derive_mood(valence: float, energy: float) -> str:
    if valence > 0.6 and energy > 0.6:
        return "euphoric"
    if valence > 0.6 and energy < 0.4:
        return "serene"
    if valence < 0.4 and energy > 0.6:
        return "intense"
    if valence < 0.4 and energy < 0.4:
        return "melancholic"
    if valence > 0.5:
        return "upbeat"
    if energy > 0.5:
        return "driven"
    return "contemplative"


# ──────────────────────────────────────────────
# Cross-domain mapping
# ──────────────────────────────────────────────

def clamp01(n: float) -> float:
    return max(0.0, min(1.0, n))


def weighted_avg(pairs: list[tuple[float, float]]) -> float:
    total = sum(clamp01(v) * w for v, w in pairs)
    weight_sum = sum(w for _, w in pairs)
    return clamp01(total / weight_sum) if weight_sum else 0.0


def genre_affinity(genres: dict[str, float], keywords: list[str]) -> float:
    """How much of the genre distribution matches the given keywords (0-1).
    Uses word-boundary-aware matching to avoid false positives like 'art' matching 'martial'."""
    total = 0.0
    for genre, weight in genres.items():
        genre_tokens = genre.replace("-", " ").split()
        genre_parts = set(genre_tokens)
        for k in keywords:
            k_tokens = k.replace("-", " ").split()
            k_parts = set(k_tokens)
            # Match if keyword parts are a subset of genre parts, or genre is substring of keyword
            if k_parts <= genre_parts or genre in k:
                total += weight
                break
            # Prefix matching: a keyword token is a prefix of a genre token or vice versa
            if any(
                gt.startswith(kt) or kt.startswith(gt)
                for kt in k_tokens
                for gt in genre_tokens
            ):
                total += weight
                break
    return total


def music_to_wine_profile(m: MusicProfile) -> WineProfile:
    # Genre signals (supplements audio features, serves as primary signal when unavailable)
    g = m.genre_distribution
    genre_dark = genre_affinity(g, ["metal", "punk", "goth", "dark", "doom", "black", "death", "grunge", "post-punk"])
    genre_complex = genre_affinity(g, ["jazz", "classical", "prog", "experimental", "avant", "art rock", "contemporary"])
    genre_acoustic = genre_affinity(g, ["folk", "acoustic", "singer-songwriter", "bluegrass", "americana", "chamber"])
    genre_electronic = genre_affinity(g, ["edm", "house", "techno", "electronic", "synth", "drum and bass", "dubstep"])
    genre_bright = genre_affinity(g, ["pop", "indie pop", "dance", "disco", "funk", "latin", "reggaeton", "k-pop"])
    genre_earthy = genre_affinity(g, ["blues", "delta", "soul", "gospel", "country", "roots", "world", "afrobeat"])

    # Normalize tempo to 0-1 (cap at 180 to handle DnB sensibly, floor at 60)
    tempo_norm = clamp01((m.avg_tempo - 60) / 120) if m.avg_tempo > 0 else 0.5

    return WineProfile(
        body=weighted_avg([
            (m.avg_energy, 0.4), (tempo_norm, 0.2), (1 - m.avg_acousticness, 0.15),
            (genre_dark, 0.15), (genre_electronic, 0.1),
        ]),
        sweetness=weighted_avg([
            (m.avg_valence, 0.4), (m.avg_danceability, 0.2), (1 - m.avg_complexity, 0.1),
            (genre_bright, 0.2), (1 - genre_dark, 0.1),
        ]),
        tannin=weighted_avg([
            (1 - m.avg_valence, 0.3), (m.avg_complexity, 0.2), (m.avg_energy, 0.2),
            (genre_dark, 0.2), (genre_complex, 0.1),
        ]),
        acidity=weighted_avg([
            (m.avg_complexity, 0.3), (1 - m.avg_valence, 0.2), (m.obscurity_score, 0.2),
            (genre_complex, 0.2), (genre_acoustic, 0.1),
        ]),
        complexity=weighted_avg([
            (m.avg_complexity, 0.3), (m.obscurity_score, 0.2), (1 - m.avg_danceability, 0.1),
            (genre_complex, 0.3), (genre_earthy, 0.1),
        ]),
        fruitiness=weighted_avg([
            (m.avg_valence, 0.3), (m.avg_energy, 0.2), (1 - m.avg_complexity, 0.1),
            (genre_bright, 0.25), (1 - genre_dark, 0.15),
        ]),
        earthiness=weighted_avg([
            (m.avg_acousticness, 0.3), (m.avg_complexity, 0.2), (m.obscurity_score, 0.2),
            (genre_acoustic, 0.15), (genre_earthy, 0.15),
        ]),
        spiciness=weighted_avg([
            (m.avg_energy, 0.3), (1 - m.avg_valence, 0.2), (m.avg_complexity, 0.2),
            (genre_dark, 0.15), (genre_electronic, 0.15),
        ]),
    )


def score_wine_match(target: WineProfile, wine: Wine) -> float:
    """Score using squared differences to amplify spread between good and bad matches."""
    weights = {
        "body": 1.5, "sweetness": 1.2, "tannin": 1.0, "acidity": 1.0,
        "complexity": 1.5, "fruitiness": 0.8, "earthiness": 0.8, "spiciness": 0.7,
    }
    total_weight = 0.0
    weighted_sq_distance = 0.0
    for dim, w in weights.items():
        diff = getattr(target, dim) - getattr(wine.profile, dim)
        weighted_sq_distance += (diff ** 2) * w
        total_weight += w
    # Squared distance max is 1.0 per dim, so normalize and convert to similarity
    return 1 - (weighted_sq_distance / total_weight) ** 0.5


def normalize_scores(recs: list[tuple]) -> list[tuple]:
    """Rescale scores so best match = 95-99% and worst = proportionally lower."""
    if len(recs) <= 1:
        return recs
    scores = [r[1] for r in recs]
    lo, hi = min(scores), max(scores)
    spread = hi - lo
    if spread < 0.01:
        return [(w, 0.90, c) for w, _, c in recs]
    return [
        (w, 0.60 + 0.38 * (s - lo) / spread, c)
        for w, s, c in recs
    ]


def generate_connections(music: MusicProfile, wine: Wine) -> list[MusicWineConnection]:
    """Generate cross-domain connections. Uses graduated thresholds to ensure
    most users get at least some connections (the entertainment value)."""
    connections = []
    g = music.genre_distribution

    # Dark/brooding music → tannic wines (graduated threshold)
    dark_score = (1 - music.avg_valence) * 0.5 + genre_affinity(g, ["post-punk", "metal", "goth", "dark", "doom", "grunge"]) * 0.5
    if dark_score > 0.25 and wine.profile.tannin > 0.5:
        connections.append(MusicWineConnection(
            music_signal=f"Your music leans dark and introspective (valence: {music.avg_valence * 100:.0f}%)",
            wine_signal="This wine has serious tannin structure",
            explanation="You like your art with tension — this wine delivers that same brooding complexity",
            strength=min(0.5 + dark_score, 0.95),
        ))

    # Acoustic/organic → old-world wines (graduated)
    acoustic_score = music.avg_acousticness * 0.5 + genre_affinity(g, ["folk", "acoustic", "singer-songwriter", "bluegrass", "classical"]) * 0.5
    if acoustic_score > 0.3 and "old-world" in wine.tags:
        connections.append(MusicWineConnection(
            music_signal="You gravitate toward acoustic, organic sounds",
            wine_signal=f"{wine.region} has centuries of winemaking tradition",
            explanation="Analog music lover, traditional winemaking. No synthetic shortcuts",
            strength=min(0.4 + acoustic_score, 0.9),
        ))

    # Complexity seekers (graduated)
    complexity_score = music.avg_complexity * 0.4 + genre_affinity(g, ["jazz", "classical", "prog", "experimental", "art rock"]) * 0.6
    if complexity_score > 0.3 and wine.profile.complexity > 0.6:
        connections.append(MusicWineConnection(
            music_signal="You seek out musically complex, layered compositions",
            wine_signal=f"This {wine.varietal} rewards patient attention",
            explanation="You don't want background music, and you don't want background wine",
            strength=min(0.5 + complexity_score * 0.5, 0.95),
        ))

    # Niche taste → obscure varietals (graduated)
    niche_score = music.obscurity_score
    if niche_score > 0.4 and "obscure-varietal" in wine.tags:
        artist_ref = music.top_artists[0] if music.top_artists else "niche artists"
        connections.append(MusicWineConnection(
            music_signal="Your taste runs deep into niche territory",
            wine_signal=f"{wine.varietal} from {wine.region} — not exactly grocery store fare",
            explanation=f"Someone who listens to {artist_ref} doesn't want the wine equivalent of Top 40",
            strength=min(0.4 + niche_score * 0.5, 0.95),
        ))

    # High energy → bold wines (graduated)
    energy_score = music.avg_energy * 0.6 + genre_affinity(g, ["metal", "punk", "edm", "drum and bass", "hard rock"]) * 0.4
    if energy_score > 0.4 and wine.profile.body > 0.6:
        connections.append(MusicWineConnection(
            music_signal="Your playlists hit hard — high energy, high intensity",
            wine_signal=f"This is a full-bodied {wine.color} that doesn't hold back",
            explanation="You like your music loud and your wine bold",
            strength=min(0.4 + energy_score * 0.4, 0.85),
        ))

    # Bright/happy → fruit-forward (graduated)
    bright_score = music.avg_valence * 0.5 + genre_affinity(g, ["pop", "indie pop", "funk", "disco", "latin"]) * 0.5
    if bright_score > 0.35 and wine.profile.fruitiness > 0.5:
        connections.append(MusicWineConnection(
            music_signal="Your music is bright and upbeat",
            wine_signal=f"Fruit-forward {wine.varietal} with approachable charm",
            explanation="Happy music, happy wine — nothing wrong with joy",
            strength=min(0.3 + bright_score * 0.5, 0.8),
        ))

    # Danceable → approachable/sweet
    if music.avg_danceability > 0.55 and wine.profile.sweetness > 0.2:
        connections.append(MusicWineConnection(
            music_signal="You love a groove — high danceability across your library",
            wine_signal=f"This {wine.varietal} has a touch of approachable sweetness",
            explanation="Dance music and a hint of sweetness — both are about pleasure, not pretension",
            strength=min(0.3 + music.avg_danceability * 0.4, 0.75),
        ))

    # Quiet/ambient → delicate wines
    quiet_score = (1 - music.avg_energy) * 0.5 + genre_affinity(g, ["ambient", "drone", "minimal", "new age"]) * 0.5
    if quiet_score > 0.35 and wine.profile.body < 0.5:
        connections.append(MusicWineConnection(
            music_signal="Your listening is quiet, ambient, introspective",
            wine_signal=f"A delicate {wine.color} that whispers rather than shouts",
            explanation="You don't need volume to feel something. This wine understands that",
            strength=min(0.4 + quiet_score * 0.4, 0.85),
        ))

    # Genre-region affinity
    if genre_affinity(g, ["bossa nova", "latin", "flamenco"]) > 0.1 and wine.country in ("Spain", "Argentina", "Portugal"):
        connections.append(MusicWineConnection(
            music_signal="Latin and Mediterranean rhythms in your library",
            wine_signal=f"This {wine.varietal} comes from {wine.country}'s winemaking tradition",
            explanation="Your music has warmth and rhythm — so does this wine's homeland",
            strength=0.65,
        ))

    if genre_affinity(g, ["blues", "soul", "gospel", "americana"]) > 0.1 and wine.country == "USA":
        connections.append(MusicWineConnection(
            music_signal="American roots music runs through your listening",
            wine_signal=f"{wine.producer} in {wine.region} — American terroir",
            explanation="Rooted in American soil, both the music and the wine",
            strength=0.6,
        ))

    return connections


def recommend_wines(music: MusicProfile, wines: list[Wine], top_n: int = 3) -> list[Recommendation]:
    target = music_to_wine_profile(music)

    rating_boosts = load_rating_boosts()

    scored = []
    for wine in wines:
        score = score_wine_match(target, wine)
        # Multiplicative boost from ratings (caps total adjustment at +/-15%)
        boost = sum(rating_boosts.get(tag, 0.0) for tag in wine.tags)
        boost = max(-0.15, min(0.15, boost * 0.03))
        score = clamp01(score * (1 + boost))
        connections = generate_connections(music, wine)
        scored.append((wine, score, connections))

    scored.sort(key=lambda x: -x[1])
    # Normalize so scores use the full display range
    scored = normalize_scores(scored)

    results = []
    for wine, score, connections in scored[:top_n]:
        best_conn = sorted(connections, key=lambda c: -c.strength) if connections else []
        if best_conn:
            reasoning = f"{best_conn[0].explanation}. Try this {wine.name} — a {wine.varietal} from {wine.producer} in {wine.region}."
        else:
            reasoning = f"Based on your overall taste profile, this {wine.varietal} from {wine.region} should resonate with you."
        results.append(Recommendation(wine=wine, score=score, reasoning=reasoning, connections=connections))

    return results


def load_rating_boosts() -> dict[str, float]:
    """Load tag-level boosts from past ratings. Positive = liked, negative = disliked."""
    if not RATINGS_FILE.exists():
        return {}
    try:
        ratings = json.loads(RATINGS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(ratings, list):
        return {}
    tag_scores: dict[str, list[float]] = {}
    for entry in ratings:
        normalized = (entry.get("rating", 3) - 3) / 2  # 1=-1, 2=-0.5, 3=0, 4=0.5, 5=1
        for tag in entry.get("tags", []):
            tag_scores.setdefault(tag, []).append(normalized)
    return {tag: sum(scores) / len(scores) for tag, scores in tag_scores.items()}


# ──────────────────────────────────────────────
# Demo profile
# ──────────────────────────────────────────────

DEMO_PROFILE = MusicProfile(
    avg_valence=0.32,
    avg_energy=0.55,
    avg_danceability=0.45,
    avg_acousticness=0.62,
    avg_tempo=115.0,
    avg_complexity=0.72,
    obscurity_score=0.68,
    genre_distribution={
        "art rock": 0.15, "post-punk": 0.12, "jazz": 0.10,
        "indie rock": 0.09, "ambient": 0.08, "shoegaze": 0.07, "classical": 0.06,
    },
    mood_label="contemplative",
    top_artists=["Radiohead", "Nick Cave", "Talk Talk", "Bjork", "John Coltrane",
                 "Portishead", "The National", "Brian Eno", "Deerhunter", "Low"],
    top_tracks=["Reckoner — Radiohead", "Into My Arms — Nick Cave",
                "Bloodbuzz Ohio — The National", "Hyperballad — Bjork",
                "A Love Supreme Pt. 1 — John Coltrane"],
    has_audio_features=True,
)


# ──────────────────────────────────────────────
# Output formatting
# ──────────────────────────────────────────────

def format_bar(value: float, width: int = 20) -> str:
    filled = round(max(0.0, min(1.0, value)) * width)
    return "=" * filled + "-" * (width - filled)


def print_profile(music: MusicProfile, wine_profile: WineProfile) -> None:
    print("=" * 50)
    print("YOUR MUSIC PROFILE")
    print("=" * 50)
    if not music.has_audio_features:
        print("  (estimated from genres — audio features unavailable)")
    print(f"  Mood:          {music.mood_label}")
    print(f"  Valence:       [{format_bar(music.avg_valence)}] {music.avg_valence * 100:.0f}%")
    print(f"  Energy:        [{format_bar(music.avg_energy)}] {music.avg_energy * 100:.0f}%")
    print(f"  Danceability:  [{format_bar(music.avg_danceability)}] {music.avg_danceability * 100:.0f}%")
    print(f"  Acousticness:  [{format_bar(music.avg_acousticness)}] {music.avg_acousticness * 100:.0f}%")
    print(f"  Complexity:    [{format_bar(music.avg_complexity)}] {music.avg_complexity * 100:.0f}%")
    print(f"  Obscurity:     [{format_bar(music.obscurity_score)}] {music.obscurity_score * 100:.0f}%")
    print(f"  Tempo:         {music.avg_tempo:.0f} BPM")
    if music.top_artists:
        print(f"  Top artists:   {', '.join(music.top_artists[:5])}")
    if music.genre_distribution:
        top_genres = list(music.genre_distribution.keys())[:5]
        print(f"  Top genres:    {', '.join(top_genres)}")
    print()

    print("=" * 50)
    print("DERIVED WINE PROFILE")
    print("=" * 50)
    for dim in ["body", "sweetness", "tannin", "acidity", "complexity", "fruitiness", "earthiness", "spiciness"]:
        val = getattr(wine_profile, dim)
        print(f"  {dim:<12}   [{format_bar(val)}] {val * 100:.0f}%")
    print()


def print_recommendations(recs: list[Recommendation]) -> None:
    print("=" * 50)
    print("RECOMMENDATIONS")
    print("=" * 50)
    print()

    for i, rec in enumerate(recs, 1):
        w = rec.wine
        stars = "*" * round(rec.score * 5) + "." * (5 - round(rec.score * 5))
        print(f"{i}. {w.name}")
        print(f"   {w.varietal} | {w.region}, {w.country} | {w.price_range}")
        if w.vintage:
            print(f"   Vintage: {w.vintage}")
        print(f"   Match: [{stars}] ({rec.score * 100:.0f}%)")
        print(f"   \"{w.description}\"")
        print(f"   Why: {rec.reasoning}")
        for conn in rec.connections:
            print(f"   ~ {conn.explanation}")
        print()


def print_json_output(music: MusicProfile, wine_profile: WineProfile, recs: list[Recommendation]) -> None:
    output = {
        "music_profile": asdict(music),
        "wine_profile": asdict(wine_profile),
        "recommendations": [
            {
                "wine": {
                    "id": r.wine.id,
                    "name": r.wine.name,
                    "producer": r.wine.producer,
                    "region": r.wine.region,
                    "country": r.wine.country,
                    "varietal": r.wine.varietal,
                    "color": r.wine.color,
                    "price_range": r.wine.price_range,
                    "description": r.wine.description,
                    "tags": r.wine.tags,
                    "vintage": r.wine.vintage,
                    "profile": asdict(r.wine.profile),
                },
                "score": round(r.score, 3),
                "reasoning": r.reasoning,
                "connections": [asdict(c) for c in r.connections],
            }
            for r in recs
        ],
    }
    print(json.dumps(output, indent=2))


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="SommeliAgent — Wine recommendations from your Spotify")
    parser.add_argument("--demo", action="store_true", help="Use demo profile (no Spotify needed)")
    parser.add_argument("--color", choices=["red", "white", "rose", "orange", "sparkling", "dessert"], help="Filter by wine color")
    parser.add_argument("--price", choices=["budget", "mid", "premium", "luxury"], help="Filter by price range")
    parser.add_argument("--count", type=int, default=3, help="Number of recommendations (default: 3)")
    parser.add_argument("--profile", action="store_true", help="Show full music + wine profile")
    parser.add_argument("--json", action="store_true", help="Output as JSON (for programmatic use)")
    parser.add_argument("--no-cache", action="store_true", help="Bypass profile cache")
    args = parser.parse_args()

    if args.demo:
        music = DEMO_PROFILE
    else:
        if args.no_cache and CACHE_FILE.exists():
            CACHE_FILE.unlink()
        token = get_access_token()
        music = build_music_profile(token)

    wines = WINE_DB
    if args.color:
        wines = [w for w in wines if w.color == args.color]
    if args.price:
        wines = [w for w in wines if w.price_range == args.price]

    if not wines:
        print("No wines match your filters.", file=sys.stderr)
        sys.exit(1)

    wine_profile = music_to_wine_profile(music)
    count = max(1, min(args.count, len(wines)))
    recs = recommend_wines(music, wines, count)

    if args.json:
        print_json_output(music, wine_profile, recs)
    else:
        if args.profile:
            print_profile(music, wine_profile)
        print_recommendations(recs)


if __name__ == "__main__":
    main()
