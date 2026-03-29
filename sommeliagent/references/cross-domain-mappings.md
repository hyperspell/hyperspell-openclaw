# Cross-Domain Mapping: Music → Wine

The core thesis: sensory and aesthetic preferences transfer across domains. Someone who seeks complexity in music seeks complexity in wine. Someone drawn to dark, brooding sounds wants wines with tension and structure, not crowd-pleasers.

## Music → Wine Dimension Map

| Music Signal | Wine Dimension | Logic |
|---|---|---|
| Tempo / energy | Body / weight | High energy → bold, full-bodied; ambient → light, delicate |
| Complexity (jazz, prog, classical) | Complexity (terroir-driven, natural wines) | Listeners who tolerate/seek complexity want wines that challenge |
| Valence (happy vs dark) | Sweetness / dryness spectrum | Bright pop → approachable, off-dry; minor key → dry, tannic, austere |
| Acoustic vs electronic | Old World vs New World | Organic, analog sound → traditional winemaking; synthetic → modern, tech-forward wines |
| Obscurity / niche taste | Obscurity of region/varietal | Niche listeners don't want grocery store Cab Sav |
| Repetition tolerance | Familiarity preference | Loop-heavy listeners → reliable house pours; variety seekers → discovery |
| Lyrical depth | Label story / terroir narrative | People who care about lyrics care about provenance |

## Mapping Algorithm

### Step 1: Music Profile Aggregation

From Spotify's audio features API, we aggregate across a user's top 50 tracks:
- **avgValence** (0-1): musical positiveness
- **avgEnergy** (0-1): intensity and activity
- **avgDanceability** (0-1): dance suitability
- **avgAcousticness** (0-1): acoustic vs electronic
- **avgTempo** (BPM): normalized to 0-1 range (/200)
- **avgComplexity** (derived): instrumentalness × 0.3 + time signature variety × 0.3 + (1 - danceability) × 0.4
- **obscurityScore** (derived): 1 - (average track popularity / 100)

### Step 2: Wine Dimension Translation

Each wine dimension is a weighted average of music features:

**Body** = energy × 0.5 + tempo × 0.3 + (1 - acousticness) × 0.2
**Sweetness** = valence × 0.6 + danceability × 0.3 + (1 - complexity) × 0.1
**Tannin** = (1 - valence) × 0.4 + complexity × 0.3 + energy × 0.3
**Acidity** = complexity × 0.4 + (1 - valence) × 0.3 + obscurity × 0.3
**Complexity** = complexity × 0.5 + obscurity × 0.3 + (1 - danceability) × 0.2
**Fruitiness** = valence × 0.5 + energy × 0.3 + (1 - complexity) × 0.2
**Earthiness** = acousticness × 0.4 + complexity × 0.3 + obscurity × 0.3
**Spiciness** = energy × 0.4 + (1 - valence) × 0.3 + complexity × 0.3

### Step 3: Wine Scoring

Each wine in the database has a profile with the same 8 dimensions. Match score = weighted cosine similarity between target profile and wine profile.

Weights: body (1.5), sweetness (1.2), complexity (1.5), tannin (1.0), acidity (1.0), fruitiness (0.8), earthiness (0.8), spiciness (0.7).

### Step 4: Connection Generation

For each recommended wine, the system identifies which specific music-wine connections are strongest and generates explanations.

## Expansion Signals (Future)

- **Reading history** → intellectual complexity tolerance
- **Food delivery** → direct cuisine/region pairing data
- **Time of day / mood** → contextual recommendations
- **Weather + location** → seasonal suggestions
- **Instagram aesthetic** → visual preference → label/winemaking philosophy

## Philosophy

The signal doesn't need to be scientifically rigorous. This is entertainment that gets smarter. The delight is in the explanation, not the accuracy. The feedback loop (ratings) quietly builds a genuine cross-domain taste database over time.
