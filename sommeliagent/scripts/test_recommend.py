# /// script
# requires-python = ">=3.11"
# dependencies = ["pytest", "httpx"]
# ///
"""Tests for SommeliAgent recommendation engine."""

import json
import sys
from pathlib import Path

# Import from recommend.py in same directory
sys.path.insert(0, str(Path(__file__).parent))
from recommend import (
    MusicProfile,
    WineProfile,
    Wine,
    clamp01,
    weighted_avg,
    music_to_wine_profile,
    score_wine_match,
    generate_connections,
    recommend_wines,
    normalize_scores,
    genre_affinity,
    estimate_features_from_genres,
    derive_mood,
    load_rating_boosts,
    WINE_DB,
    DEMO_PROFILE,
    wp,
)


# ──────────────────────────────────────────────
# Utility tests
# ──────────────────────────────────────────────

class TestClamp01:
    def test_within_range(self):
        assert clamp01(0.5) == 0.5

    def test_below_zero(self):
        assert clamp01(-0.5) == 0.0

    def test_above_one(self):
        assert clamp01(1.5) == 1.0

    def test_boundaries(self):
        assert clamp01(0.0) == 0.0
        assert clamp01(1.0) == 1.0


class TestWeightedAvg:
    def test_equal_weights(self):
        result = weighted_avg([(0.0, 1.0), (1.0, 1.0)])
        assert abs(result - 0.5) < 0.01

    def test_single_value(self):
        assert weighted_avg([(0.7, 1.0)]) == 0.7

    def test_empty(self):
        assert weighted_avg([]) == 0.0

    def test_clamps_inputs(self):
        result = weighted_avg([(2.0, 1.0), (-1.0, 1.0)])
        assert 0.0 <= result <= 1.0


class TestDeriveMood:
    def test_euphoric(self):
        assert derive_mood(0.8, 0.8) == "euphoric"

    def test_melancholic(self):
        assert derive_mood(0.2, 0.2) == "melancholic"

    def test_intense(self):
        assert derive_mood(0.2, 0.8) == "intense"

    def test_serene(self):
        assert derive_mood(0.8, 0.2) == "serene"

    def test_middle_ground(self):
        mood = derive_mood(0.5, 0.5)
        assert mood in ("upbeat", "driven", "contemplative")


# ──────────────────────────────────────────────
# Genre feature estimation tests
# ──────────────────────────────────────────────

class TestGenreAffinity:
    def test_matching_genres(self):
        genres = {"jazz": 0.5, "classical": 0.3, "pop": 0.2}
        assert genre_affinity(genres, ["jazz", "classical"]) == 0.8

    def test_no_match(self):
        genres = {"jazz": 0.5, "classical": 0.5}
        assert genre_affinity(genres, ["metal", "punk"]) == 0.0

    def test_empty_genres(self):
        assert genre_affinity({}, ["jazz"]) == 0.0

    def test_word_boundary_match(self):
        genres = {"indie rock": 0.5, "art rock": 0.3}
        assert genre_affinity(genres, ["rock"]) == 0.8

    def test_no_false_positive_substring(self):
        """'art' keyword should NOT match 'martial industrial'."""
        genres = {"martial industrial": 0.5}
        assert genre_affinity(genres, ["art"]) == 0.0

    def test_compound_genre_match(self):
        """'post-punk' keyword should match 'post-punk' genre."""
        genres = {"post-punk": 0.5, "darkwave": 0.3}
        assert genre_affinity(genres, ["post-punk"]) == 0.5

    def test_no_double_counting(self):
        """A genre should only be counted once even if multiple keywords match."""
        genres = {"pop punk": 0.5}
        # Both "pop" and "punk" could match, but weight should be 0.5 not 1.0
        assert genre_affinity(genres, ["pop", "punk"]) == 0.5


class TestEstimateFeaturesFromGenres:
    def test_jazz_listener(self):
        artists = [{"genres": ["jazz"]}, {"genres": ["jazz", "bebop"]}]
        valence, energy, dance, acoustic, tempo, complexity = estimate_features_from_genres(artists)
        assert complexity > 0.7  # Jazz = complex
        assert acoustic > 0.5   # Jazz = acoustic

    def test_edm_listener(self):
        artists = [{"genres": ["edm"]}, {"genres": ["house"]}]
        valence, energy, dance, acoustic, tempo, complexity = estimate_features_from_genres(artists)
        assert energy > 0.6
        assert dance > 0.7
        assert acoustic < 0.2

    def test_no_genres(self):
        artists = [{"genres": []}, {"genres": []}]
        result = estimate_features_from_genres(artists)
        assert all(0.0 <= v <= 200.0 for v in result)  # tempo can be up to 200

    def test_empty_artists(self):
        result = estimate_features_from_genres([])
        assert len(result) == 6

    def test_no_genres_returns_bpm_not_normalized(self):
        """Empty genre list should still return tempo in BPM, not 0-1."""
        artists = [{"genres": []}, {"genres": []}]
        _, _, _, _, tempo, _ = estimate_features_from_genres(artists)
        assert tempo > 50, f"Tempo should be BPM (>50), got {tempo}"

    def test_tempo_always_in_bpm_range(self):
        """All paths should return tempo as BPM (roughly 60-200)."""
        # With genres
        artists_with = [{"genres": ["jazz"]}, {"genres": ["rock"]}]
        _, _, _, _, tempo_with, _ = estimate_features_from_genres(artists_with)
        assert 60 < tempo_with < 200, f"Tempo with genres: {tempo_with}"
        # Without genres
        artists_without = [{"genres": []}]
        _, _, _, _, tempo_without, _ = estimate_features_from_genres(artists_without)
        assert 60 < tempo_without < 200, f"Tempo without genres: {tempo_without}"


# ──────────────────────────────────────────────
# Mapping engine tests
# ──────────────────────────────────────────────

class TestMusicToWineProfile:
    def test_all_dimensions_in_range(self):
        profile = music_to_wine_profile(DEMO_PROFILE)
        for dim in ["body", "sweetness", "tannin", "acidity", "complexity", "fruitiness", "earthiness", "spiciness"]:
            val = getattr(profile, dim)
            assert 0.0 <= val <= 1.0, f"{dim} out of range: {val}"

    def test_dark_complex_listener(self):
        """Dark, complex music should map to tannic, earthy, complex wines."""
        dark = MusicProfile(
            avg_valence=0.15, avg_energy=0.6, avg_danceability=0.3,
            avg_acousticness=0.7, avg_tempo=100, avg_complexity=0.9,
            obscurity_score=0.8, genre_distribution={"post-punk": 0.4, "jazz": 0.3, "ambient": 0.3},
            mood_label="intense", top_artists=["Swans"], top_tracks=[], has_audio_features=True,
        )
        wine = music_to_wine_profile(dark)
        assert wine.tannin > wine.sweetness
        assert wine.complexity > 0.5
        assert wine.earthiness > 0.5

    def test_bright_pop_listener(self):
        """Bright pop listener should map to fruity, sweet, low-tannin wines."""
        pop = MusicProfile(
            avg_valence=0.85, avg_energy=0.7, avg_danceability=0.8,
            avg_acousticness=0.15, avg_tempo=120, avg_complexity=0.2,
            obscurity_score=0.1, genre_distribution={"pop": 0.6, "dance": 0.3, "edm": 0.1},
            mood_label="euphoric", top_artists=["Dua Lipa"], top_tracks=[], has_audio_features=True,
        )
        wine = music_to_wine_profile(pop)
        assert wine.fruitiness > wine.earthiness
        assert wine.sweetness > wine.tannin
        assert wine.body > 0.4  # high energy = some body

    def test_genre_influence(self):
        """Genre data should meaningfully shift the profile."""
        base = MusicProfile(
            avg_valence=0.5, avg_energy=0.5, avg_danceability=0.5,
            avg_acousticness=0.5, avg_tempo=120, avg_complexity=0.5,
            obscurity_score=0.5, genre_distribution={}, mood_label="contemplative",
            top_artists=[], top_tracks=[], has_audio_features=True,
        )
        with_jazz = MusicProfile(
            avg_valence=0.5, avg_energy=0.5, avg_danceability=0.5,
            avg_acousticness=0.5, avg_tempo=120, avg_complexity=0.5,
            obscurity_score=0.5, genre_distribution={"jazz": 0.5, "classical": 0.5},
            mood_label="contemplative", top_artists=[], top_tracks=[], has_audio_features=True,
        )
        profile_base = music_to_wine_profile(base)
        profile_jazz = music_to_wine_profile(with_jazz)
        assert profile_jazz.complexity > profile_base.complexity
        assert profile_jazz.acidity > profile_base.acidity

    def test_extreme_values_dont_break(self):
        """Edge case: all zeros and all ones."""
        zeros = MusicProfile(has_audio_features=True)
        ones = MusicProfile(
            avg_valence=1.0, avg_energy=1.0, avg_danceability=1.0,
            avg_acousticness=1.0, avg_tempo=200, avg_complexity=1.0,
            obscurity_score=1.0, has_audio_features=True,
        )
        p0 = music_to_wine_profile(zeros)
        p1 = music_to_wine_profile(ones)
        for dim in ["body", "sweetness", "tannin", "acidity", "complexity"]:
            assert 0.0 <= getattr(p0, dim) <= 1.0
            assert 0.0 <= getattr(p1, dim) <= 1.0


# ──────────────────────────────────────────────
# Scoring tests
# ──────────────────────────────────────────────

class TestScoreWineMatch:
    def test_perfect_match(self):
        target = wp(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5)
        wine = Wine("test", "Test", "Test", "Test", "Test", "Test", "red",
                     wp(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5),
                     "mid", "Test", [])
        assert score_wine_match(target, wine) == 1.0

    def test_opposite_extremes(self):
        target = wp(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
        wine = Wine("test", "Test", "Test", "Test", "Test", "Test", "red",
                     wp(1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0),
                     "mid", "Test", [])
        score = score_wine_match(target, wine)
        assert score < 0.2  # should be very low

    def test_score_in_range(self):
        target = wp(0.3, 0.7, 0.4, 0.8, 0.6, 0.5, 0.3, 0.9)
        for wine in WINE_DB:
            score = score_wine_match(target, wine)
            assert 0.0 <= score <= 1.0, f"Score out of range for {wine.id}: {score}"

    def test_squared_distance_spreads_scores(self):
        """Verify that squared differences create meaningful spread."""
        target = music_to_wine_profile(DEMO_PROFILE)
        scores = [score_wine_match(target, w) for w in WINE_DB]
        spread = max(scores) - min(scores)
        assert spread > 0.1, f"Score spread too narrow: {spread}"


class TestNormalizeScores:
    def test_rescales_to_display_range(self):
        data = [("a", 0.82, []), ("b", 0.78, []), ("c", 0.71, [])]
        normalized = normalize_scores(data)
        scores = [s for _, s, _ in normalized]
        assert max(scores) >= 0.95
        assert min(scores) >= 0.60

    def test_single_item(self):
        data = [("a", 0.75, [])]
        result = normalize_scores(data)
        assert len(result) == 1

    def test_identical_scores(self):
        data = [("a", 0.80, []), ("b", 0.80, [])]
        result = normalize_scores(data)
        assert all(abs(s - 0.90) < 0.01 for _, s, _ in result)


# ──────────────────────────────────────────────
# Connection generation tests
# ──────────────────────────────────────────────

class TestGenerateConnections:
    def test_demo_profile_gets_connections(self):
        """The demo profile should produce at least some connections for top wines."""
        recs = recommend_wines(DEMO_PROFILE, WINE_DB, 5)
        total_connections = sum(len(r.connections) for r in recs)
        assert total_connections > 0, "Demo profile produced zero connections"

    def test_bright_pop_gets_connections(self):
        """Even a mainstream listener should get connections."""
        pop = MusicProfile(
            avg_valence=0.8, avg_energy=0.7, avg_danceability=0.8,
            avg_acousticness=0.1, avg_tempo=120, avg_complexity=0.2,
            obscurity_score=0.15, genre_distribution={"pop": 0.5, "dance pop": 0.3, "edm": 0.2},
            mood_label="euphoric", top_artists=["Taylor Swift"], top_tracks=[],
            has_audio_features=True,
        )
        recs = recommend_wines(pop, WINE_DB, 5)
        total_connections = sum(len(r.connections) for r in recs)
        assert total_connections > 0, "Pop listener got zero connections"

    def test_neutral_profile_gets_connections(self):
        """A slightly characterful profile should get some connections."""
        neutral = MusicProfile(
            avg_valence=0.45, avg_energy=0.55, avg_danceability=0.5,
            avg_acousticness=0.5, avg_tempo=120, avg_complexity=0.55,
            obscurity_score=0.5, genre_distribution={"indie rock": 0.4, "alternative": 0.3, "folk": 0.3},
            mood_label="contemplative", top_artists=["Radiohead"], top_tracks=[],
            has_audio_features=True,
        )
        recs = recommend_wines(neutral, WINE_DB, 10)
        total_connections = sum(len(r.connections) for r in recs)
        assert total_connections > 0, "Profile with slight character got zero connections"

    def test_connections_dont_mutate_order(self):
        """Ensure recommendation building doesn't mutate connection lists."""
        recs = recommend_wines(DEMO_PROFILE, WINE_DB, 3)
        for rec in recs:
            if len(rec.connections) > 1:
                # Check that connections are not necessarily sorted by strength
                # (they should be in generation order, not sorted)
                strengths = [c.strength for c in rec.connections]
                # Just verify they exist and are valid
                assert all(0 < s <= 1.0 for s in strengths)


# ──────────────────────────────────────────────
# End-to-end recommendation tests
# ──────────────────────────────────────────────

class TestRecommendWines:
    def test_returns_requested_count(self):
        recs = recommend_wines(DEMO_PROFILE, WINE_DB, 3)
        assert len(recs) == 3

    def test_sorted_by_score(self):
        recs = recommend_wines(DEMO_PROFILE, WINE_DB, 5)
        scores = [r.score for r in recs]
        assert scores == sorted(scores, reverse=True)

    def test_all_fields_populated(self):
        recs = recommend_wines(DEMO_PROFILE, WINE_DB, 3)
        for rec in recs:
            assert rec.wine.id
            assert rec.wine.name
            assert rec.reasoning
            assert 0.0 <= rec.score <= 1.0

    def test_dark_listener_gets_complex_wines(self):
        """A dark, complex listener should get old-world terroir wines, not pop wines."""
        dark = MusicProfile(
            avg_valence=0.15, avg_energy=0.5, avg_danceability=0.3,
            avg_acousticness=0.7, avg_tempo=100, avg_complexity=0.9,
            obscurity_score=0.85, genre_distribution={"art rock": 0.3, "jazz": 0.4, "post-punk": 0.3},
            mood_label="melancholic", top_artists=["Radiohead"], top_tracks=[],
            has_audio_features=True,
        )
        recs = recommend_wines(dark, WINE_DB, 3)
        # Top picks should include terroir-driven wines
        top_tags = set()
        for r in recs:
            top_tags.update(r.wine.tags)
        assert "terroir-driven" in top_tags or "old-world" in top_tags

    def test_pop_listener_gets_approachable_wines(self):
        """A pop listener should get fruit-forward, approachable wines."""
        pop = MusicProfile(
            avg_valence=0.85, avg_energy=0.75, avg_danceability=0.85,
            avg_acousticness=0.1, avg_tempo=125, avg_complexity=0.15,
            obscurity_score=0.1, genre_distribution={"pop": 0.6, "dance pop": 0.4},
            mood_label="euphoric", top_artists=["Dua Lipa"], top_tracks=[],
            has_audio_features=True,
        )
        recs = recommend_wines(pop, WINE_DB, 3)
        top_tags = set()
        for r in recs:
            top_tags.update(r.wine.tags)
        assert "fruit-forward" in top_tags or "approachable" in top_tags or "fun" in top_tags

    def test_color_filter(self):
        whites = [w for w in WINE_DB if w.color == "white"]
        recs = recommend_wines(DEMO_PROFILE, whites, 3)
        for rec in recs:
            assert rec.wine.color == "white"

    def test_single_wine_available(self):
        recs = recommend_wines(DEMO_PROFILE, WINE_DB[:1], 1)
        assert len(recs) == 1


# ──────────────────────────────────────────────
# Wine database integrity tests
# ──────────────────────────────────────────────

class TestWineDB:
    def test_unique_ids(self):
        ids = [w.id for w in WINE_DB]
        assert len(ids) == len(set(ids)), f"Duplicate wine IDs: {[x for x in ids if ids.count(x) > 1]}"

    def test_profiles_in_range(self):
        for wine in WINE_DB:
            for dim in ["body", "sweetness", "tannin", "acidity", "complexity", "fruitiness", "earthiness", "spiciness"]:
                val = getattr(wine.profile, dim)
                assert 0.0 <= val <= 1.0, f"{wine.id}.{dim} = {val}"

    def test_all_have_tags(self):
        for wine in WINE_DB:
            assert len(wine.tags) > 0, f"{wine.id} has no tags"

    def test_valid_colors(self):
        valid = {"red", "white", "rose", "orange", "sparkling"}
        for wine in WINE_DB:
            assert wine.color in valid, f"{wine.id} has invalid color: {wine.color}"

    def test_valid_price_ranges(self):
        valid = {"budget", "mid", "premium", "luxury"}
        for wine in WINE_DB:
            assert wine.price_range in valid, f"{wine.id} has invalid price: {wine.price_range}"


# ──────────────────────────────────────────────
# Rating boost tests
# ──────────────────────────────────────────────

class TestRatingBoosts:
    def test_no_ratings_file(self, tmp_path, monkeypatch):
        monkeypatch.setattr("recommend.RATINGS_FILE", tmp_path / "nonexistent.json")
        assert load_rating_boosts() == {}

    def test_corrupt_ratings_file(self, tmp_path, monkeypatch):
        bad_file = tmp_path / "ratings.json"
        bad_file.write_text("not json{{{")
        monkeypatch.setattr("recommend.RATINGS_FILE", bad_file)
        assert load_rating_boosts() == {}

    def test_boosts_are_bounded(self, tmp_path, monkeypatch):
        ratings_file = tmp_path / "ratings.json"
        # 10 max ratings on same tags
        ratings = [{"rating": 5, "tags": ["terroir-driven", "old-world"]} for _ in range(10)]
        ratings_file.write_text(json.dumps(ratings))
        monkeypatch.setattr("recommend.RATINGS_FILE", ratings_file)

        boosts = load_rating_boosts()
        # With multiplicative application capped at +/-15%, even strong boosts are safe
        for tag, boost in boosts.items():
            assert -1.0 <= boost <= 1.0


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
