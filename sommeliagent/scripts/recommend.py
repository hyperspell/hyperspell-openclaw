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
class WineProfile:
    body: float = 0.0
    sweetness: float = 0.0
    tannin: float = 0.0
    acidity: float = 0.0
    complexity: float = 0.0
    fruitiness: float = 0.0
    earthiness: float = 0.0
    spiciness: float = 0.0


@dataclass
class Wine:
    id: str
    name: str
    producer: str
    region: str
    country: str
    varietal: str
    color: str
    profile: WineProfile
    price_range: str
    description: str
    tags: list[str]
    vintage: int | None = None


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
    CACHE_FILE.write_text(json.dumps(data, indent=2))
    CACHE_FILE.chmod(stat.S_IRUSR | stat.S_IWUSR)


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
    top_track_names = [f"{t['name']} — {t['artists'][0]['name']}" for t in tracks[:10]]

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
        genre_parts = set(genre.replace("-", " ").split())
        for k in keywords:
            k_parts = set(k.replace("-", " ").split())
            # Match if keyword parts are a subset of genre parts, or genre is substring of keyword
            if k_parts <= genre_parts or genre in k:
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
    tag_scores: dict[str, list[float]] = {}
    for entry in ratings:
        normalized = (entry.get("rating", 3) - 3) / 2  # 1=-1, 2=-0.5, 3=0, 4=0.5, 5=1
        for tag in entry.get("tags", []):
            tag_scores.setdefault(tag, []).append(normalized)
    return {tag: sum(scores) / len(scores) for tag, scores in tag_scores.items()}


# ──────────────────────────────────────────────
# Wine database
# ──────────────────────────────────────────────

def wp(body, sweetness, tannin, acidity, complexity, fruitiness, earthiness, spiciness) -> WineProfile:
    return WineProfile(body=body, sweetness=sweetness, tannin=tannin, acidity=acidity,
                       complexity=complexity, fruitiness=fruitiness, earthiness=earthiness, spiciness=spiciness)


WINE_DB: list[Wine] = [
    # REDS
    Wine("barolo-massolino", "Massolino Barolo", "Massolino", "Piedmont", "Italy", "Nebbiolo", "red",
         wp(0.8, 0.1, 0.9, 0.8, 0.9, 0.4, 0.8, 0.5), "premium",
         "Tar, roses, and existential weight. This is wine that demands your attention and rewards patience.",
         ["old-world", "age-worthy", "terroir-driven"], 2019),
    Wine("malbec-catena", "Catena Malbec", "Catena Zapata", "Mendoza", "Argentina", "Malbec", "red",
         wp(0.8, 0.2, 0.6, 0.5, 0.5, 0.7, 0.4, 0.6), "mid",
         "Bold, dark fruit, crowd-pleaser with altitude. Like a rock anthem — big, reliable, satisfying.",
         ["new-world", "fruit-forward", "approachable"], 2021),
    Wine("pinot-noir-burgundy", "Domaine Faiveley Gevrey-Chambertin", "Domaine Faiveley", "Burgundy", "France", "Pinot Noir", "red",
         wp(0.5, 0.1, 0.5, 0.8, 0.9, 0.5, 0.9, 0.3), "premium",
         "Forest floor, red berries, and the ghost of every autumn you've ever loved. Profound and elusive.",
         ["old-world", "terroir-driven", "elegant"], 2020),
    Wine("cab-sav-napa", "Caymus Cabernet Sauvignon", "Caymus Vineyards", "Napa Valley", "USA", "Cabernet Sauvignon", "red",
         wp(0.9, 0.3, 0.7, 0.4, 0.4, 0.8, 0.3, 0.5), "premium",
         "Rich, oaky, unapologetically Californian. Like a Hollywood blockbuster — big budget, big flavor.",
         ["new-world", "fruit-forward", "oaky"], 2021),
    Wine("syrah-northern-rhone", "E. Guigal Cote-Rotie", "E. Guigal", "Northern Rhone", "France", "Syrah", "red",
         wp(0.8, 0.1, 0.7, 0.7, 0.8, 0.5, 0.7, 0.8), "premium",
         "Smoke, black pepper, violets, and a sense of danger. For people who like their wine with an edge.",
         ["old-world", "terroir-driven", "spicy"], 2019),
    Wine("nero-davola-sicily", "Planeta Nero d'Avola", "Planeta", "Sicily", "Italy", "Nero d'Avola", "red",
         wp(0.7, 0.2, 0.5, 0.6, 0.6, 0.7, 0.5, 0.6), "mid",
         "Sun-baked Mediterranean charm. Dark cherry, chocolate, and volcanic soil.",
         ["old-world", "obscure-varietal", "mediterranean"], 2021),
    Wine("natural-gamay", "Marcel Lapierre Morgon", "Marcel Lapierre", "Beaujolais", "France", "Gamay", "red",
         wp(0.4, 0.2, 0.3, 0.8, 0.7, 0.7, 0.6, 0.2), "mid",
         "The godfather of natural wine. Pure fruit, zero pretension, dangerously drinkable.",
         ["natural", "old-world", "light-bodied", "terroir-driven"], 2022),
    Wine("tempranillo-rioja", "Lopez de Heredia Vina Tondonia Reserva", "Lopez de Heredia", "Rioja", "Spain", "Tempranillo", "red",
         wp(0.6, 0.1, 0.6, 0.7, 0.9, 0.3, 0.8, 0.4), "premium",
         "A decade in barrel and it's still got secrets. Oxidative, cerebral, unfashionable in the best way.",
         ["old-world", "age-worthy", "terroir-driven", "obscure-varietal"], 2012),
    Wine("xinomavro-naoussa", "Thymiopoulos Naoussa Young Vines", "Thymiopoulos", "Naoussa", "Greece", "Xinomavro", "red",
         wp(0.6, 0.1, 0.8, 0.8, 0.7, 0.4, 0.7, 0.5), "mid",
         "Greece's answer to Nebbiolo. Sun-dried tomato, olive, and fierce acidity. A sommelier's secret weapon.",
         ["old-world", "obscure-varietal", "terroir-driven"], 2021),
    Wine("trousseau-jura", "Domaine de la Borde Trousseau", "Domaine de la Borde", "Jura", "France", "Trousseau", "red",
         wp(0.3, 0.1, 0.3, 0.8, 0.8, 0.5, 0.7, 0.4), "mid",
         "Translucent, haunting, like a half-remembered dream. The Jura does things to your expectations.",
         ["natural", "old-world", "obscure-varietal", "light-bodied", "terroir-driven"], 2022),
    Wine("zinfandel-ridge", "Ridge Geyserville", "Ridge Vineyards", "Sonoma", "USA", "Zinfandel", "red",
         wp(0.8, 0.3, 0.6, 0.5, 0.6, 0.8, 0.4, 0.7), "premium",
         "Brambly, spicy, distinctly American. Ridge has been doing this since before it was cool.",
         ["new-world", "fruit-forward", "spicy"], 2020),

    # WHITES
    Wine("riesling-mosel", "Dr. Loosen Urziger Wurzgarten Riesling Spatlese", "Dr. Loosen", "Mosel", "Germany", "Riesling", "white",
         wp(0.3, 0.5, 0.0, 0.9, 0.7, 0.8, 0.4, 0.3), "mid",
         "Laser-sharp acidity meets stone fruit sweetness. A tightrope walk between sugar and acid.",
         ["old-world", "sweet-ish", "elegant"], 2022),
    Wine("sauvignon-blanc-loire", "Domaine Vacheron Sancerre", "Domaine Vacheron", "Loire Valley", "France", "Sauvignon Blanc", "white",
         wp(0.3, 0.1, 0.0, 0.9, 0.6, 0.5, 0.6, 0.1), "mid",
         "Flinty, mineral, with a cool wind blowing through it. Not your college party SB.",
         ["old-world", "mineral", "terroir-driven"], 2023),
    Wine("skin-contact-friulano", "Radikon Ribolla Gialla", "Radikon", "Friuli", "Italy", "Ribolla Gialla", "orange",
         wp(0.6, 0.1, 0.4, 0.7, 0.9, 0.3, 0.8, 0.4), "premium",
         "Amber-hued, tannic white. Beautiful and unsettling. Not for the faint of palate.",
         ["natural", "orange-wine", "terroir-driven", "obscure-varietal"], 2018),
    Wine("chardonnay-meursault", "Domaine Roulot Meursault", "Domaine Roulot", "Burgundy", "France", "Chardonnay", "white",
         wp(0.6, 0.1, 0.1, 0.7, 0.8, 0.5, 0.7, 0.2), "luxury",
         "Hazelnut, citrus, and a buttery texture that whispers rather than shouts. This is what Chardonnay wants to be.",
         ["old-world", "terroir-driven", "elegant"], 2021),
    Wine("gruner-veltliner", "Nikolaihof Gruner Veltliner Federspiel", "Nikolaihof", "Wachau", "Austria", "Gruner Veltliner", "white",
         wp(0.4, 0.1, 0.0, 0.8, 0.6, 0.5, 0.5, 0.5), "mid",
         "White pepper, green apple, and a mineral backbone. The sommelier's insider pick.",
         ["old-world", "biodynamic", "obscure-varietal", "mineral"], 2023),
    Wine("chenin-blanc-loire", "Domaine Huet Vouvray Le Haut-Lieu Sec", "Domaine Huet", "Loire Valley", "France", "Chenin Blanc", "white",
         wp(0.5, 0.2, 0.0, 0.8, 0.8, 0.6, 0.6, 0.2), "premium",
         "Honeyed and austere simultaneously. Chenin Blanc is the thinking person's white wine.",
         ["old-world", "biodynamic", "terroir-driven", "age-worthy"], 2020),
    Wine("assyrtiko-santorini", "Sigalas Assyrtiko", "Domaine Sigalas", "Santorini", "Greece", "Assyrtiko", "white",
         wp(0.4, 0.1, 0.0, 0.9, 0.7, 0.4, 0.7, 0.2), "mid",
         "Volcanic minerality, sea salt, and the memory of a Greek sunset. Brutally dry.",
         ["old-world", "obscure-varietal", "mineral", "terroir-driven"], 2023),

    # ROSE & SPARKLING
    Wine("provence-rose", "Domaines Ott Chateau de Selle Rose", "Domaines Ott", "Provence", "France", "Grenache/Cinsault", "rose",
         wp(0.3, 0.2, 0.1, 0.6, 0.3, 0.7, 0.2, 0.1), "mid",
         "Pale pink, bone dry, summer in a glass. For when life is good and you want it to stay that way.",
         ["old-world", "approachable", "summer"], 2023),
    Wine("cerasuolo-abruzzo", "Emidio Pepe Cerasuolo d'Abruzzo", "Emidio Pepe", "Abruzzo", "Italy", "Montepulciano", "rose",
         wp(0.5, 0.1, 0.3, 0.7, 0.7, 0.6, 0.5, 0.3), "premium",
         "This isn't pool rose. It's a serious wine that happens to be pink. Foot-crushed, amphora-aged, legendary.",
         ["old-world", "natural", "terroir-driven", "obscure-varietal"], 2021),
    Wine("champagne-grower", "Pierre Gimonnet & Fils Cuvee Gastronome", "Pierre Gimonnet", "Champagne", "France", "Chardonnay", "sparkling",
         wp(0.4, 0.2, 0.0, 0.9, 0.7, 0.5, 0.5, 0.1), "premium",
         "Grower Champagne — the indie label of sparkling wine. Chalky, precise, individual.",
         ["old-world", "terroir-driven", "elegant", "obscure-varietal"], 2018),
    Wine("pet-nat-carignan", "Las Jaras Wines Sparkling Carignan", "Las Jaras", "Mendocino", "USA", "Carignan", "sparkling",
         wp(0.4, 0.2, 0.2, 0.7, 0.5, 0.8, 0.3, 0.2), "mid",
         "Funky, fizzy, unpretentious. Natural wine's party trick — a cloudy, joyful chaos.",
         ["natural", "pet-nat", "fun", "obscure-varietal"], 2023),
    Wine("lambrusco-cleto", "Cleto Chiarli Lambrusco di Sorbara", "Cleto Chiarli", "Emilia-Romagna", "Italy", "Lambrusco", "sparkling",
         wp(0.3, 0.3, 0.2, 0.7, 0.4, 0.8, 0.3, 0.2), "budget",
         "Fizzy, fruity, and criminally underrated. The perfect wine for people who think they don't like wine.",
         ["old-world", "fun", "approachable", "obscure-varietal"], 2023),

    # === EXPANDED DATABASE ===

    # REDS
    Wine("barbera-alba", "Barbera d'Alba Superiore", "G.D. Vajra", "Piedmont", "Italy", "Barbera", "red",
         wp(0.6, 0.1, 0.3, 0.8, 0.6, 0.7, 0.3, 0.2), "mid",
         "The working-class hero of Piedmont. All the acid-driven charm of Nebbiolo's fancy neighbor without the mortgage payment.",
         ["old-world", "fruit-forward", "approachable"], None),
    Wine("cotes-du-rhone-village", "Côtes du Rhône Villages", "Domaine Gramenon", "Southern Rhône", "France", "Grenache/Syrah", "red",
         wp(0.6, 0.1, 0.4, 0.5, 0.6, 0.6, 0.4, 0.5), "budget",
         "Gramenon proves that natural wine and Southern Rhône is a love story that actually works. Garrigue for days.",
         ["old-world", "natural", "mediterranean", "approachable"], None),
    Wine("cab-franc-loire", "Chinon Les Picasses", "Olga Raffault", "Loire Valley", "France", "Cabernet Franc", "red",
         wp(0.5, 0.1, 0.5, 0.6, 0.7, 0.5, 0.5, 0.4), "mid",
         "If Cab Franc had a spiritual homeland, this is the temple. Pencil shavings, violets, and the ghost of a green bell pepper.",
         ["old-world", "terroir-driven", "elegant", "age-worthy"], None),
    Wine("cru-beaujolais-morgon", "Morgon Côte du Py", "Jean Foillard", "Beaujolais", "France", "Gamay", "red",
         wp(0.5, 0.1, 0.3, 0.6, 0.7, 0.6, 0.5, 0.3), "mid",
         "The wine that makes Burgundy collectors nervous. Foillard's Morgon ages like it read a book on how to be serious.",
         ["old-world", "natural", "terroir-driven", "age-worthy"], None),
    Wine("chianti-classico-riserva", "Chianti Classico Riserva", "Fontodi", "Tuscany", "Italy", "Sangiovese", "red",
         wp(0.7, 0.1, 0.6, 0.7, 0.7, 0.5, 0.5, 0.3), "mid",
         "Fontodi is what happens when a Tuscan estate actually respects Sangiovese instead of drowning it in new oak.",
         ["old-world", "terroir-driven", "elegant", "age-worthy"], None),
    Wine("brunello-montalcino", "Brunello di Montalcino", "Biondi-Santi", "Tuscany", "Italy", "Sangiovese Grosso", "red",
         wp(0.8, 0.05, 0.7, 0.7, 0.9, 0.4, 0.6, 0.3), "luxury",
         "The original Brunello estate. Drinking young is a crime; drinking aged is a revelation. Patience is the price of admission.",
         ["old-world", "terroir-driven", "age-worthy", "elegant"], 2016),
    Wine("pinotage-swartland", "Pinotage", "Aalst", "Swartland", "South Africa", "Pinotage", "red",
         wp(0.7, 0.1, 0.5, 0.5, 0.5, 0.6, 0.4, 0.4), "budget",
         "South Africa's controversial love child grape, redeemed. Smoky, dark-fruited, and unapologetically itself.",
         ["new-world", "fruit-forward", "approachable", "obscure-varietal"], None),
    Wine("shiraz-barossa", "Barossa Valley Shiraz", "Torbreck Woodcutter's", "Barossa Valley", "Australia", "Shiraz", "red",
         wp(0.9, 0.15, 0.6, 0.4, 0.6, 0.7, 0.3, 0.7), "mid",
         "A slab of Barossa generosity. Dark chocolate, black pepper, and the confidence of a continent with nothing to prove.",
         ["new-world", "fruit-forward", "oaky", "spicy"], None),
    Wine("pinot-noir-central-otago", "Pinot Noir", "Felton Road", "Central Otago", "New Zealand", "Pinot Noir", "red",
         wp(0.5, 0.05, 0.4, 0.6, 0.8, 0.6, 0.4, 0.3), "premium",
         "New Zealand's answer to the Burgundy question, except the answer involves more cherries and dramatic mountain scenery.",
         ["new-world", "elegant", "terroir-driven"], None),
    Wine("carmenere-chile", "Carménère Gran Reserva", "Concha y Toro Terrunyo", "Cachapoal Valley", "Chile", "Carménère", "red",
         wp(0.7, 0.1, 0.5, 0.4, 0.6, 0.6, 0.4, 0.5), "mid",
         "Bordeaux's lost grape found its true calling in Chile. Herbaceous, smoky, and perpetually underestimated.",
         ["new-world", "fruit-forward", "obscure-varietal", "approachable"], None),
    Wine("bonarda-mendoza", "Bonarda", "Zuccardi Serie A", "Mendoza", "Argentina", "Bonarda", "red",
         wp(0.6, 0.1, 0.4, 0.5, 0.5, 0.7, 0.2, 0.3), "budget",
         "Argentina's most-planted grape that nobody talks about. A juicy, plummy crowd-pleaser hiding in Malbec's shadow.",
         ["new-world", "fruit-forward", "approachable", "obscure-varietal"], None),
    Wine("etna-rosso", "Etna Rosso", "Passopisciaro", "Sicily", "Italy", "Nerello Mascalese", "red",
         wp(0.5, 0.05, 0.5, 0.7, 0.8, 0.5, 0.6, 0.3), "premium",
         "Volcanic Pinot Noir vibes from a literal volcano. Andrea Franchetti saw what Etna could be before everyone else showed up.",
         ["old-world", "terroir-driven", "elegant", "mineral"], None),
    Wine("zweigelt-austria", "Zweigelt", "Wachter-Wiesler", "Burgenland", "Austria", "Zweigelt", "red",
         wp(0.5, 0.1, 0.3, 0.5, 0.5, 0.7, 0.3, 0.3), "budget",
         "Austria's easy-drinking red that pairs with literally everything. The ultimate Tuesday night bottle that punches up.",
         ["old-world", "approachable", "fruit-forward", "fun"], None),
    Wine("mencia-bierzo", "Mencía", "Descendientes de J. Palacios Pétalos", "Bierzo", "Spain", "Mencía", "red",
         wp(0.5, 0.05, 0.4, 0.6, 0.7, 0.6, 0.5, 0.3), "mid",
         "Spain's coolest grape from Spain's coolest region. Alvaro Palacios took one look at these slate slopes and stayed forever.",
         ["old-world", "terroir-driven", "elegant", "obscure-varietal"], None),
    Wine("agiorgitiko-nemea", "Agiorgitiko", "Domaine Skouras", "Nemea", "Greece", "Agiorgitiko", "red",
         wp(0.7, 0.1, 0.5, 0.5, 0.5, 0.6, 0.3, 0.4), "budget",
         "Greece's most food-friendly red. Imagine Merlot went on holiday to the Mediterranean and came back deeply tanned.",
         ["old-world", "approachable", "fruit-forward", "mediterranean"], None),
    Wine("touriga-nacional-douro", "Douro Red", "Niepoort Fabelhaft", "Douro", "Portugal", "Touriga Nacional blend", "red",
         wp(0.7, 0.1, 0.6, 0.5, 0.6, 0.6, 0.4, 0.4), "budget",
         "Port grapes, table wine attitude. The Douro's dry reds are Portugal's best-kept secret, which we're ruining right now.",
         ["old-world", "fruit-forward", "approachable"], None),
    Wine("blaufrankisch-burgenland", "Blaufränkisch", "Moric", "Burgenland", "Austria", "Blaufränkisch", "red",
         wp(0.6, 0.05, 0.5, 0.7, 0.7, 0.5, 0.5, 0.5), "mid",
         "Austria's serious red that somms whisper about. Imagine Northern Rhône Syrah and cool-climate Pinot had a baby on limestone.",
         ["old-world", "terroir-driven", "spicy", "mineral"], None),
    Wine("sagrantino-montefalco", "Sagrantino di Montefalco", "Paolo Bea", "Umbria", "Italy", "Sagrantino", "red",
         wp(0.9, 0.05, 0.9, 0.6, 0.8, 0.4, 0.5, 0.4), "premium",
         "The most tannic grape in Italy, in the hands of a mad natural wine genius. Chew on this for a while — literally.",
         ["old-world", "natural", "age-worthy", "obscure-varietal"], None),
    Wine("pinot-noir-willamette", "Pinot Noir", "Domaine Drouhin Oregon", "Willamette Valley", "USA", "Pinot Noir", "red",
         wp(0.5, 0.05, 0.3, 0.6, 0.7, 0.6, 0.4, 0.3), "premium",
         "A Burgundy family transplanted to Oregon and proved the terroir skeptics wrong. Silky, serious, and occasionally transcendent.",
         ["new-world", "elegant", "terroir-driven"], None),
    Wine("petite-sirah-paso", "Petite Sirah", "Turley Wine Cellars", "Paso Robles", "USA", "Petite Sirah", "red",
         wp(0.9, 0.1, 0.8, 0.5, 0.6, 0.6, 0.3, 0.6), "mid",
         "Inky, massive, and zero apologies. The wine equivalent of turning the bass up until the neighbors complain.",
         ["new-world", "fruit-forward", "spicy", "oaky"], None),
    Wine("kadarka-szekszard", "Kadarka", "Heimann", "Szekszárd", "Hungary", "Kadarka", "red",
         wp(0.4, 0.05, 0.3, 0.6, 0.6, 0.5, 0.4, 0.6), "mid",
         "Hungary's ancient red grape, spicy and ethereal. Like Pinot Noir went backpacking through the Ottoman Empire.",
         ["old-world", "obscure-varietal", "elegant", "spicy"], None),
    Wine("tannat-uruguay", "Tannat Reserva", "Bodega Garzón", "Maldonado", "Uruguay", "Tannat", "red",
         wp(0.8, 0.05, 0.8, 0.5, 0.6, 0.5, 0.4, 0.4), "mid",
         "Tannat found itself in Uruguay the way some people find themselves in therapy — it just needed a warmer climate.",
         ["new-world", "age-worthy", "obscure-varietal"], None),
    Wine("cannonau-sardinia", "Cannonau di Sardegna Riserva", "Ferruccio Deiana", "Sardinia", "Italy", "Cannonau", "red",
         wp(0.7, 0.1, 0.5, 0.5, 0.5, 0.6, 0.5, 0.4), "budget",
         "Grenache's Sardinian alter ego. Herby, warm, and basically sunshine in a glass. Pairs with centenarian longevity diets.",
         ["old-world", "mediterranean", "approachable", "fruit-forward"], None),
    Wine("mouvedre-bandol", "Bandol Rouge", "Domaine Tempier", "Provence", "France", "Mourvèdre", "red",
         wp(0.8, 0.05, 0.7, 0.5, 0.8, 0.4, 0.6, 0.5), "premium",
         "The estate that put Bandol on the map and kept Mourvèdre from extinction. Meaty, herbal, and smells like the garrigue after rain.",
         ["old-world", "terroir-driven", "age-worthy", "spicy"], None),
    Wine("cab-sav-coonawarra", "Cabernet Sauvignon", "Wynns Coonawarra Estate Black Label", "Coonawarra", "Australia", "Cabernet Sauvignon", "red",
         wp(0.7, 0.05, 0.7, 0.6, 0.7, 0.5, 0.5, 0.2), "mid",
         "Terra rossa soil gives this Cab a minty, eucalyptus-laced elegance that Napa can't replicate. Australia's Bordeaux, essentially.",
         ["new-world", "terroir-driven", "age-worthy", "elegant"], None),
    Wine("primitivo-puglia", "Primitivo di Manduria", "Gianfranco Fino Es", "Puglia", "Italy", "Primitivo", "red",
         wp(0.8, 0.15, 0.5, 0.4, 0.6, 0.7, 0.3, 0.4), "mid",
         "Zinfandel's Italian cousin, sunbaked and unapologetic. Jammy, yes, but with a savory undertow that keeps you honest.",
         ["old-world", "fruit-forward", "mediterranean"], None),
    Wine("cinsault-old-vine-sa", "Old Vine Cinsault", "The Blacksmith", "Paarl", "South Africa", "Cinsault", "red",
         wp(0.4, 0.1, 0.2, 0.5, 0.5, 0.7, 0.3, 0.2), "budget",
         "South Africa's old-vine Cinsault movement is the best thing to happen to budget reds in a decade. Light, juicy, and full of soul.",
         ["new-world", "natural", "light-bodied", "fun"], None),
    Wine("grenache-mclaren-vale", "Grenache", "d'Arenberg The Derelict Vineyard", "McLaren Vale", "Australia", "Grenache", "red",
         wp(0.6, 0.1, 0.3, 0.5, 0.6, 0.7, 0.3, 0.4), "mid",
         "Old bush-vine Grenache from McLaren Vale is Australia's answer to Châteauneuf. Raspberry, licorice, and a long spicy finish.",
         ["new-world", "fruit-forward", "terroir-driven", "spicy"], None),
    Wine("dornfelder-pfalz", "Dornfelder Trocken", "Markus Schneider", "Pfalz", "Germany", "Dornfelder", "red",
         wp(0.5, 0.1, 0.3, 0.4, 0.3, 0.7, 0.2, 0.2), "budget",
         "Germany makes red wine? This one'll convince you. Dark-fruited, easy-going, and the polar opposite of what you expected.",
         ["old-world", "approachable", "fruit-forward", "fun"], None),
    Wine("dao-tinto", "Dão Tinto", "Casa de Mouraz", "Dão", "Portugal", "Touriga Nacional/Jaen", "red",
         wp(0.6, 0.05, 0.5, 0.6, 0.6, 0.5, 0.5, 0.3), "budget",
         "Central Portugal's granitic reds are finesse-driven and wildly underpriced. Organic, serious, and still under ten bucks. Why.",
         ["old-world", "natural", "terroir-driven", "approachable"], None),
    Wine("saint-joseph-rouge", "Saint-Joseph Rouge", "Domaine Jean-Louis Chave Sélection Offerus", "Northern Rhône", "France", "Syrah", "red",
         wp(0.6, 0.05, 0.5, 0.5, 0.7, 0.5, 0.4, 0.6), "mid",
         "Baby Hermitage from the house of Chave. All the black olive and violet character of Northern Rhône Syrah without selling a kidney.",
         ["old-world", "terroir-driven", "spicy", "elegant"], None),
    Wine("natural-poulsard-jura", "Poulsard", "Domaine de la Borde", "Jura", "France", "Poulsard", "red",
         wp(0.3, 0.05, 0.2, 0.6, 0.6, 0.5, 0.4, 0.2), "mid",
         "So pale it might be rosé, so funky it might be alive. Jura's Poulsard is the litmus test for natural wine tolerance.",
         ["old-world", "natural", "light-bodied", "obscure-varietal"], None),
    Wine("natural-nero-calabria", "Nerello Calabrese", "A Vita", "Calabria", "Italy", "Nerello Calabrese", "red",
         wp(0.5, 0.05, 0.4, 0.6, 0.6, 0.5, 0.5, 0.3), "mid",
         "Calabria's natural wine scene is tiny but fierce. This tastes like wild herbs, iron, and the toe of Italy's boot kicking convention.",
         ["old-world", "natural", "terroir-driven", "obscure-varietal"], None),

    # WHITES
    Wine("chablis-premier-cru", "Chablis Premier Cru Montée de Tonnerre", "Raveneau", "Chablis", "France", "Chardonnay", "white",
         wp(0.5, 0.05, 0.0, 0.8, 0.9, 0.3, 0.6, 0.1), "premium",
         "Chardonnay stripped to its mineral core. Raveneau's Chablis is what happens when oyster shells fossilize into liquid form.",
         ["old-world", "terroir-driven", "mineral", "age-worthy"], None),
    Wine("albarino-rias-baixas", "Albariño", "Zárate", "Rías Baixas", "Spain", "Albariño", "white",
         wp(0.4, 0.1, 0.0, 0.7, 0.5, 0.6, 0.3, 0.1), "mid",
         "Galicia's gift to the seafood platter. Saline, peachy, and tastes like the Atlantic breeze smells.",
         ["old-world", "approachable", "mineral", "summer"], None),
    Wine("fiano-di-avellino", "Fiano di Avellino", "Ciro Picariello", "Campania", "Italy", "Fiano", "white",
         wp(0.5, 0.1, 0.0, 0.6, 0.7, 0.5, 0.4, 0.2), "mid",
         "Southern Italy's most cerebral white. Waxy, honeyed, and way more interesting than whatever Pinot Grigio you were considering.",
         ["old-world", "terroir-driven", "obscure-varietal", "mineral"], None),
    Wine("torrontes-salta", "Torrontés", "Colomé", "Salta", "Argentina", "Torrontés", "white",
         wp(0.4, 0.15, 0.0, 0.5, 0.4, 0.7, 0.1, 0.2), "budget",
         "High-altitude aromatics from the Andes. Smells like a Muscat, drinks like something entirely its own. Argentina's floral flex.",
         ["new-world", "fruit-forward", "approachable", "fun"], None),
    Wine("viognier-condrieu", "Condrieu", "E. Guigal", "Northern Rhône", "France", "Viognier", "white",
         wp(0.7, 0.15, 0.0, 0.4, 0.7, 0.7, 0.2, 0.2), "luxury",
         "Apricots, white flowers, and the decadence of a grape that almost went extinct. Viognier's spiritual ground zero.",
         ["old-world", "fruit-forward", "elegant"], None),
    Wine("godello-valdeorras", "Godello", "Rafael Palacios As Sortes", "Valdeorras", "Spain", "Godello", "white",
         wp(0.5, 0.05, 0.0, 0.6, 0.7, 0.5, 0.5, 0.1), "mid",
         "Spain's answer to white Burgundy, except nobody told Spain. Textured, mineral, and criminally under-the-radar.",
         ["old-world", "terroir-driven", "mineral", "obscure-varietal"], None),
    Wine("verdicchio-castelli", "Verdicchio dei Castelli di Jesi Classico Superiore", "Bucci", "Marche", "Italy", "Verdicchio", "white",
         wp(0.5, 0.05, 0.0, 0.7, 0.6, 0.4, 0.4, 0.2), "budget",
         "The Marche's best-kept secret in its distinctive amphora bottle. Almondy, saline, and ages like it has something to prove.",
         ["old-world", "terroir-driven", "mineral", "age-worthy"], None),
    Wine("furmint-tokaj", "Furmint Dry", "Royal Tokaji", "Tokaj", "Hungary", "Furmint", "white",
         wp(0.5, 0.05, 0.0, 0.8, 0.7, 0.4, 0.4, 0.2), "mid",
         "Tokaj's grape freed from sweetness duty. Volcanic, razor-sharp, and the most exciting dry white you've probably never tried.",
         ["old-world", "mineral", "terroir-driven", "obscure-varietal"], None),
    Wine("semillon-hunter", "Semillon", "Tyrrell's Vat 1", "Hunter Valley", "Australia", "Semillon", "white",
         wp(0.4, 0.05, 0.0, 0.8, 0.8, 0.4, 0.3, 0.1), "mid",
         "Picked at 10% alcohol, aged for a decade, tastes like liquid toast and lanolin. Australia's most underrated flex.",
         ["new-world", "terroir-driven", "age-worthy", "mineral"], 2014),
    Wine("sauvignon-blanc-marlborough", "Sauvignon Blanc", "Cloudy Bay", "Marlborough", "New Zealand", "Sauvignon Blanc", "white",
         wp(0.3, 0.1, 0.0, 0.7, 0.4, 0.7, 0.1, 0.1), "mid",
         "The bottle that launched a thousand imitations. Passionfruit, cut grass, and the reason somms have a complicated relationship with NZ.",
         ["new-world", "fruit-forward", "approachable", "summer"], None),
    Wine("txakoli-basque", "Txakoli", "Ameztoi", "Getaria", "Spain", "Hondarrabi Zuri", "white",
         wp(0.2, 0.05, 0.0, 0.8, 0.4, 0.4, 0.2, 0.1), "budget",
         "Slightly spritzy, screaming with acid, and poured from great height into a tumbler. The Basque Country in a glass.",
         ["old-world", "light-bodied", "fun", "summer"], None),
    Wine("muscadet-sevre", "Muscadet Sèvre et Maine Sur Lie", "Domaine de la Pépière", "Loire Valley", "France", "Melon de Bourgogne", "white",
         wp(0.3, 0.05, 0.0, 0.7, 0.5, 0.3, 0.4, 0.1), "budget",
         "The oyster's best friend and the somm's guilty pleasure. Bone-dry, yeasty, and costs less than your lunch.",
         ["old-world", "mineral", "approachable", "light-bodied"], None),
    Wine("chardonnay-sonoma", "Chardonnay Sonoma Coast", "Littorai", "Sonoma Coast", "USA", "Chardonnay", "white",
         wp(0.6, 0.05, 0.0, 0.6, 0.8, 0.5, 0.4, 0.1), "premium",
         "California Chardonnay for people who say they don't like California Chardonnay. Restrained, foggy, Burgundian-adjacent.",
         ["new-world", "elegant", "terroir-driven"], None),
    Wine("gewurztraminer-alsace", "Gewurztraminer", "Trimbach", "Alsace", "France", "Gewurztraminer", "white",
         wp(0.6, 0.2, 0.0, 0.5, 0.6, 0.6, 0.2, 0.5), "mid",
         "Lychee, rose petals, and Turkish delight — basically perfume you can drink. Either you love it or you haven't had the right one yet.",
         ["old-world", "spicy", "fruit-forward"], None),
    Wine("verdejo-rueda", "Verdejo", "José Pariente", "Rueda", "Spain", "Verdejo", "white",
         wp(0.4, 0.1, 0.0, 0.6, 0.4, 0.6, 0.2, 0.1), "budget",
         "Spain's crispiest white, herbaceous and fennel-scented. The perfect fridge wine that costs almost nothing and delivers everything.",
         ["old-world", "approachable", "summer", "fun"], None),
    Wine("riesling-clare-valley", "Riesling", "Grosset Polish Hill", "Clare Valley", "Australia", "Riesling", "white",
         wp(0.4, 0.1, 0.0, 0.8, 0.7, 0.5, 0.4, 0.1), "mid",
         "Proof that Riesling thrives outside Germany. Lime cordial, slate, and the kind of acid that recalibrates your palate.",
         ["new-world", "terroir-driven", "mineral", "age-worthy"], None),
    Wine("white-burgundy-macon", "Mâcon-Villages", "Domaine Lafon", "Mâconnais", "France", "Chardonnay", "white",
         wp(0.4, 0.05, 0.0, 0.6, 0.5, 0.5, 0.3, 0.1), "mid",
         "Burgundy's best value by a mile. Lafon makes Mâcon taste like it costs three times more, which frankly is rude to other producers.",
         ["old-world", "approachable", "elegant"], None),
    Wine("vidiano-crete", "Vidiano", "Lyrarakis", "Crete", "Greece", "Vidiano", "white",
         wp(0.5, 0.1, 0.0, 0.5, 0.5, 0.6, 0.3, 0.1), "budget",
         "A grape resurrected from near-extinction on Crete. Tropical, round, and making the Greek wine revival delicious one sip at a time.",
         ["old-world", "fruit-forward", "obscure-varietal", "approachable"], None),
    Wine("marsanne-roussanne-rhone", "Crozes-Hermitage Blanc", "Domaine Alain Graillot", "Northern Rhône", "France", "Marsanne/Roussanne", "white",
         wp(0.6, 0.1, 0.0, 0.5, 0.6, 0.5, 0.3, 0.2), "mid",
         "The Northern Rhône's white secret: waxy, stone-fruited, and texturally fascinating. Graillot does it with effortless precision.",
         ["old-world", "terroir-driven", "elegant"], None),
    Wine("gruner-smaragd", "Grüner Veltliner Smaragd Achleiten", "Prager", "Wachau", "Austria", "Grüner Veltliner", "white",
         wp(0.6, 0.05, 0.0, 0.7, 0.8, 0.4, 0.5, 0.3), "premium",
         "Wachau Smaragd is Grüner Veltliner with the volume turned to 11. Concentrated, peppery, and terroir-obsessed in the best way.",
         ["old-world", "terroir-driven", "mineral", "age-worthy"], None),
    Wine("viura-rioja-blanco", "Rioja Blanco Reserva", "López de Heredia Viña Tondonia", "Rioja", "Spain", "Viura", "white",
         wp(0.5, 0.05, 0.0, 0.6, 0.8, 0.3, 0.5, 0.2), "mid",
         "Aged in barrel for years before release, this white Rioja is an anachronism in the best possible way. Oxidative, nutty, and timeless.",
         ["old-world", "terroir-driven", "age-worthy", "oaky"], 2012),
    Wine("trebbiano-valentini", "Trebbiano d'Abruzzo", "Valentini", "Abruzzo", "Italy", "Trebbiano", "white",
         wp(0.5, 0.05, 0.0, 0.7, 0.9, 0.4, 0.5, 0.2), "luxury",
         "Italy's most legendary white, from a producer who releases only the best vintages. Honey, chamomile, and decades of ageing potential.",
         ["old-world", "terroir-driven", "age-worthy", "elegant"], None),
    Wine("chenin-blanc-sa", "Chenin Blanc Old Vine", "Ken Forrester", "Stellenbosch", "South Africa", "Chenin Blanc", "white",
         wp(0.5, 0.1, 0.0, 0.6, 0.6, 0.6, 0.3, 0.1), "budget",
         "South Africa has more old-vine Chenin than the Loire does. Tropical, honeyed, and costs criminally little for this quality.",
         ["new-world", "fruit-forward", "approachable"], None),
    Wine("picpoul-de-pinet", "Picpoul de Pinet", "Domaine Félines Jourdan", "Languedoc", "France", "Picpoul", "white",
         wp(0.3, 0.05, 0.0, 0.7, 0.3, 0.4, 0.2, 0.1), "budget",
         "The Languedoc's oyster wine. Lip-smacking, lemony, and priced so you can buy it by the case without guilt.",
         ["old-world", "light-bodied", "summer", "approachable"], None),
    Wine("pinot-gris-alsace", "Pinot Gris", "Domaine Weinbach", "Alsace", "France", "Pinot Gris", "white",
         wp(0.6, 0.15, 0.0, 0.5, 0.6, 0.5, 0.3, 0.3), "mid",
         "Alsatian Pinot Gris is to Pinot Grigio what a symphony is to a ringtone. Rich, smoky, and quietly powerful.",
         ["old-world", "fruit-forward", "elegant"], None),
    Wine("roussanne-tablas-creek", "Roussanne", "Tablas Creek", "Paso Robles", "USA", "Roussanne", "white",
         wp(0.6, 0.1, 0.0, 0.5, 0.6, 0.5, 0.3, 0.2), "mid",
         "Rhône grapes in California, from a partnership with Château de Beaucastel. Herbal, waxy, and proof that Paso does more than Cab.",
         ["new-world", "terroir-driven", "elegant", "obscure-varietal"], None),
    Wine("biodynamic-pinot-blanc-alsace", "Pinot Blanc", "Domaine Marcel Deiss", "Alsace", "France", "Pinot Blanc", "white",
         wp(0.4, 0.1, 0.0, 0.5, 0.5, 0.5, 0.3, 0.1), "mid",
         "Deiss farms biodynamically and blends by terroir, not grape. His Pinot Blanc is pure Alsatian soul: orchard fruit and good vibes.",
         ["old-world", "biodynamic", "approachable"], None),
    Wine("biodynamic-riesling-alsace", "Riesling Grand Cru Schlossberg", "Domaine Weinbach", "Alsace", "France", "Riesling", "white",
         wp(0.5, 0.1, 0.0, 0.8, 0.8, 0.5, 0.5, 0.2), "premium",
         "Biodynamic Grand Cru Riesling from one of Alsace's greatest estates. Crystalline purity, granitic minerality, and effortless depth.",
         ["old-world", "biodynamic", "terroir-driven", "mineral"], None),

    # ROSÉ
    Wine("tavel-rose", "Tavel Rosé", "Domaine de la Mordorée", "Southern Rhône", "France", "Grenache/Cinsault", "rose",
         wp(0.5, 0.1, 0.2, 0.5, 0.5, 0.5, 0.3, 0.3), "mid",
         "The rosé that thinks it's a red wine. France's only rosé-only appellation delivers something darker, meatier, and year-round drinkable.",
         ["old-world", "terroir-driven", "mediterranean"], None),
    Wine("rose-bandol", "Bandol Rosé", "Domaine Tempier", "Provence", "France", "Mourvèdre/Grenache", "rose",
         wp(0.5, 0.05, 0.2, 0.6, 0.6, 0.5, 0.4, 0.3), "premium",
         "The rosé that converts rosé skeptics. Mourvèdre gives it backbone, Provence gives it beauty. A complete wine in pink clothing.",
         ["old-world", "terroir-driven", "elegant", "summer"], None),
    Wine("rose-navarra", "Rosado", "Chivite Gran Feudo", "Navarra", "Spain", "Garnacha", "rose",
         wp(0.4, 0.1, 0.1, 0.5, 0.3, 0.6, 0.2, 0.2), "budget",
         "Spain's been doing rosé longer than Provence was trendy. Strawberry-scented, bone-dry, and absurdly cheap.",
         ["old-world", "approachable", "summer", "fun"], None),
    Wine("rose-txakoli", "Txakoli Rosé", "Gorka Izagirre", "Bizkaiko", "Spain", "Hondarrabi Beltza", "rose",
         wp(0.3, 0.05, 0.1, 0.7, 0.4, 0.5, 0.2, 0.1), "mid",
         "Pink, fizzy, salty, and screaming. The Basque approach to rosé: strip it down and crank up the acidity.",
         ["old-world", "light-bodied", "fun", "summer"], None),

    # ORANGE
    Wine("orange-ribolla-gravner", "Ribolla Gialla Anfora", "Gravner", "Friuli", "Italy", "Ribolla Gialla", "orange",
         wp(0.7, 0.05, 0.4, 0.6, 0.9, 0.3, 0.7, 0.3), "luxury",
         "The godfather of orange wine. Gravner buried these amphorae and unearthed a revolution. Challenging, profound, and absolutely uncompromising.",
         ["old-world", "natural", "orange-wine", "terroir-driven"], None),
    Wine("orange-rkatsiteli-georgia", "Rkatsiteli Qvevri", "Pheasant's Tears", "Kakheti", "Georgia", "Rkatsiteli", "orange",
         wp(0.6, 0.05, 0.4, 0.6, 0.7, 0.4, 0.6, 0.3), "mid",
         "Georgia invented orange wine 8,000 years ago and didn't bother telling anyone. Amber, tannic, and tastes like history.",
         ["old-world", "natural", "orange-wine", "terroir-driven"], None),
    Wine("orange-zierfandler-austria", "Zierfandler Orange", "Weingut Stadlmann", "Thermenregion", "Austria", "Zierfandler", "orange",
         wp(0.5, 0.1, 0.3, 0.6, 0.6, 0.5, 0.4, 0.3), "mid",
         "Austrian skin-contact from a grape so obscure even most Austrians shrug. Spiced quince, dried flowers, and delightful weirdness.",
         ["old-world", "orange-wine", "obscure-varietal", "natural"], None),
    Wine("orange-malvasia-radikon", "Malvasia", "Radikon", "Friuli", "Italy", "Malvasia Istriana", "orange",
         wp(0.6, 0.05, 0.4, 0.5, 0.8, 0.4, 0.6, 0.3), "premium",
         "Radikon's amber Malvasia is a gateway drug to the deep end of natural wine. Dried apricot, tea tannins, and zero compromises.",
         ["old-world", "natural", "orange-wine", "age-worthy"], None),
    Wine("orange-muscat-sa", "Skin Contact Muscat", "Intellego", "Swartland", "South Africa", "Muscat d'Alexandrie", "orange",
         wp(0.5, 0.1, 0.3, 0.5, 0.5, 0.6, 0.3, 0.3), "mid",
         "South African natural wine meets ancient Muscat. Floral, grippy, and the kind of bottle that starts arguments at dinner parties.",
         ["new-world", "natural", "orange-wine", "fun"], None),

    # SPARKLING
    Wine("cremant-alsace", "Crémant d'Alsace Brut", "Albert Boxler", "Alsace", "France", "Pinot Blanc/Riesling", "sparkling",
         wp(0.3, 0.1, 0.0, 0.7, 0.5, 0.4, 0.3, 0.1), "budget",
         "Champagne quality at crémant prices. Boxler's version is so good it should probably be illegal at this price point.",
         ["old-world", "approachable", "fun"], None),
    Wine("franciacorta-brut", "Franciacorta Brut", "Ca' del Bosco", "Lombardy", "Italy", "Chardonnay/Pinot Nero", "sparkling",
         wp(0.4, 0.1, 0.0, 0.7, 0.7, 0.4, 0.3, 0.1), "premium",
         "Italy's answer to Champagne, and it's a convincing argument. Brioche, green apple, and tiny bubbles with big ambitions.",
         ["old-world", "elegant", "age-worthy"], None),
    Wine("cava-reserva", "Cava Gran Reserva Brut Nature", "Gramona", "Penedès", "Spain", "Xarel-lo/Macabeo", "sparkling",
         wp(0.4, 0.0, 0.0, 0.7, 0.6, 0.3, 0.4, 0.1), "mid",
         "Brut Nature means zero sugar added, and Gramona proves that's all Cava ever needed. Chalky, nutty, and dead serious.",
         ["old-world", "terroir-driven", "mineral"], None),
    Wine("sekt-riesling", "Riesling Sekt Brut", "Von Buhl", "Pfalz", "Germany", "Riesling", "sparkling",
         wp(0.3, 0.1, 0.0, 0.8, 0.5, 0.5, 0.3, 0.1), "mid",
         "German sparkling Riesling is the most underrated bubble on earth. All the racy acid of still Riesling plus fizz. Obvious, really.",
         ["old-world", "mineral", "fun", "approachable"], None),
    Wine("pet-nat-chenin", "Pét-Nat Chenin Blanc", "Les Capriades", "Loire Valley", "France", "Chenin Blanc", "sparkling",
         wp(0.3, 0.1, 0.0, 0.7, 0.4, 0.6, 0.2, 0.1), "budget",
         "Cloudy, funky, and joyful. The Loire's natural wine scene in bottle form — pop the crown cap and don't overthink it.",
         ["old-world", "natural", "pet-nat", "fun"], None),
    Wine("prosecco-superiore", "Prosecco Superiore Brut", "Bisol", "Valdobbiadene", "Italy", "Glera", "sparkling",
         wp(0.3, 0.15, 0.0, 0.5, 0.3, 0.6, 0.1, 0.1), "budget",
         "Not all Prosecco is created equal. Bisol's hillside Glera is to supermarket Prosecco what espresso is to instant coffee.",
         ["old-world", "approachable", "fun", "fruit-forward"], None),
    Wine("blanc-de-blancs-champagne", "Champagne Blanc de Blancs", "Pierre Gimonnet", "Champagne", "France", "Chardonnay", "sparkling",
         wp(0.4, 0.05, 0.0, 0.8, 0.8, 0.3, 0.4, 0.1), "premium",
         "Pure Chardonnay Champagne from the Côte des Blancs. Laser precision, chalky minerality, and bubbles that whisper instead of shout.",
         ["old-world", "elegant", "terroir-driven", "mineral"], None),
    Wine("ancestral-method-piquette", "Piquette", "Wild Arc Farm", "Hudson Valley", "USA", "Field Blend", "sparkling",
         wp(0.2, 0.05, 0.0, 0.6, 0.3, 0.5, 0.2, 0.1), "budget",
         "Not technically wine — it's the second pressing rehydrated and fermented. Low-ABV, crushable, and the hipster seltzer alternative.",
         ["new-world", "natural", "fun", "light-bodied"], None),
    Wine("cap-classique-sa", "Cap Classique Brut", "Graham Beck", "Robertson", "South Africa", "Chardonnay/Pinot Noir", "sparkling",
         wp(0.4, 0.1, 0.0, 0.6, 0.5, 0.5, 0.2, 0.1), "mid",
         "South Africa's traditional method sparkler reportedly toasted both Mandela's election and Obama's inauguration. That's a CV.",
         ["new-world", "elegant", "approachable"], None),
    Wine("pet-nat-gamay-loire", "Pét-Nat Rosé Gamay", "Domaine de la Garrelière", "Touraine", "France", "Gamay", "sparkling",
         wp(0.3, 0.1, 0.0, 0.6, 0.3, 0.6, 0.2, 0.1), "budget",
         "Pink, cloudy, fizzy, cheap, and absolutely zero pretense. Crack it open at a picnic and watch everyone's mood improve immediately.",
         ["old-world", "natural", "pet-nat", "fun"], None),

    # SWEET & DESSERT
    Wine("tokaji-aszu-5-puttonyos", "Tokaji Aszú 5 Puttonyos", "Disznókő", "Tokaj", "Hungary", "Furmint/Hárslevelű", "white",
         wp(0.7, 0.85, 0.0, 0.8, 0.9, 0.6, 0.3, 0.3), "premium",
         "The sweet wine that Napoleon called the 'king of wines.' Botrytis magic: marmalade, saffron, and acid sharp enough to balance the sugar.",
         ["old-world", "age-worthy", "sweet-ish", "elegant"], 2017),
    Wine("riesling-spatlese-mosel", "Riesling Spätlese", "Joh. Jos. Prüm", "Mosel", "Germany", "Riesling", "white",
         wp(0.3, 0.4, 0.0, 0.9, 0.7, 0.6, 0.3, 0.1), "mid",
         "Spätlese is the Mosel's sweet spot — literally. Electric acidity meets peach and petrol in a wire so taut it practically hums.",
         ["old-world", "sweet-ish", "elegant", "age-worthy"], None),
    Wine("moscato-dasti", "Moscato d'Asti", "Paolo Saracco", "Piedmont", "Italy", "Moscato Bianco", "sparkling",
         wp(0.2, 0.5, 0.0, 0.5, 0.3, 0.8, 0.1, 0.1), "budget",
         "Barely 5.5% alcohol and shamelessly delicious. Peach fizz for grown-ups who aren't afraid to admit they like sweet things.",
         ["old-world", "sweet-ish", "fun", "light-bodied"], None),
    Wine("sauternes-classic", "Sauternes", "Château Suduiraut", "Bordeaux", "France", "Sémillon/Sauvignon Blanc", "white",
         wp(0.7, 0.8, 0.0, 0.6, 0.9, 0.5, 0.3, 0.2), "luxury",
         "Noble rot at its most noble. Honey, apricot, and a richness that could double as a religious experience. Needs blue cheese or patience.",
         ["old-world", "age-worthy", "sweet-ish", "elegant"], None),
]



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
    filled = round(value * width)
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
    parser.add_argument("--color", choices=["red", "white", "rose", "orange", "sparkling"], help="Filter by wine color")
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
