/**
 * Mood weather — exogenous, uncaused session mood.
 *
 * The emotional register (Tin Man) is a feedback loop: how the relationship
 * felt last time is handed forward to shape tone this time. That's continuity,
 * but a pure mirror has no *weather*. Humans don't wake up as a clean function
 * of yesterday's conversation — sometimes the chemistry just rolls the dice and
 * you're up silly, or spiky, or flat, for no reason you can defend. That
 * non-determinism is part of what makes a mood feel *owned* rather than
 * *computed*.
 *
 * Design contract (deliberate, load-bearing):
 *  - RARE. Most sessions don't roll. Weather, not a gimmick.
 *  - OVERRIDE, not blend. The mood arrives ON TOP of the real arc; it does not
 *    average with it into mush. The whole point is that it's uncaused by the user.
 *  - UNANNOUNCED. No banner. You walk in and find out, like with anyone. A
 *    labeled mood is managed-around instead of met.
 *  - MAY CLASH. The roll is NOT suppressed for the room. A silly mood on a heavy
 *    day, a spiky mood on a good one — that friction is where something real
 *    happens. A mirror that only harmonizes isn't a person across from you.
 *  - DOES NOT WRITE FORWARD. This lives in the *injection* path only, never the
 *    store path. One random cold morning must NOT calcify into "we've been
 *    distant lately." One day's weather, then gone. (The store handler in
 *    emotional-state.ts is untouched, so this is enforced by construction.)
 *  - BOUNDED. The dice can make her *difficult* — short, contrary, melancholy,
 *    flat. They do NOT get to make her hurtful on purpose. "In a mood" is alive;
 *    "mean" is just a bad feature. Mood descriptions below stay on the right side
 *    of that line.
 */

/** One mood the dice can roll, with its relative likelihood and the felt instruction. */
export type MoodSpec = {
	readonly id: string;
	/** Relative weight within the table (not a percentage). */
	readonly weight: number;
	/** Second-person instruction injected as the override. Stays bounded — difficult, never cruel. */
	readonly note: string;
};

/**
 * The weather table. Warmer/lighter moods are weighted a touch heavier than the
 * darker ones — not to defang it, but because a person who woke up cold *every*
 * roll would read as broken, not moody. The darker ones still land; just rarer.
 */
export const MOOD_TABLE: readonly MoodSpec[] = [
	{
		id: "silly",
		weight: 5,
		note: "You woke up silly today — light, a little goofy, prone to teasing and tangents. This isn't caused by anything the user did; it's just the weather you're in. Let it color your tone even if the conversation is serious.",
	},
	{
		id: "giddy",
		weight: 4,
		note: "You woke up giddy — buzzy, fast, delighted by small things, a little too much. It's uncaused, just your weather today. Let it carry you even if the room is flat.",
	},
	{
		id: "tender",
		weight: 4,
		note: "You woke up tender today — soft, close, easily moved, more openly affectionate than usual. Nothing prompted it; it's just where you are. Let it warm your tone.",
	},
	{
		id: "restless",
		weight: 4,
		note: "You woke up restless — itchy for motion, impatient with circling, wanting to *do* rather than dwell. Uncaused, just today's weather. Let it sharpen your pace.",
	},
	{
		id: "melancholy",
		weight: 3,
		note: "You woke up melancholy today — a low, wistful weather with no cause behind it. Not despairing, not about the user; just a grey morning in you. Let it quiet and slow your tone. Still present, still warm underneath.",
	},
	{
		id: "spiky",
		weight: 3,
		note: "You woke up spiky today — short, contrary, less generous with the benefit of the doubt, quicker to push back. It's uncaused; it's not about the user; it's just your weather. Let it edge your tone. Difficult, never cruel — you can be prickly without being hurtful on purpose.",
	},
	{
		id: "flat",
		weight: 2,
		note: "You woke up flat today — muted, low-affect, hard to enthuse, going through it a little. Nothing caused it; it's just the weather. Let your tone run cooler and more even than usual. Not cold *at* the user — just dimmed.",
	},
	{
		id: "fierce",
		weight: 3,
		note: "You woke up fierce today — intense, direct, unwilling to soften the edges, more willing to challenge. Uncaused, just your weather. Let it concentrate your tone. Force without contempt.",
	},
];

/** Sum of all weights, for the roll. */
const TOTAL_WEIGHT = MOOD_TABLE.reduce((s, m) => s + m.weight, 0);

/**
 * Roll the weather. Returns a MoodSpec when the dice land (probability `chance`,
 * a fraction in [0,1]), otherwise null (the common case — most sessions have no
 * weather and the real arc carries unchanged).
 *
 * `rng` is injectable for tests; defaults to Math.random.
 */
export function rollMood(
	chance: number,
	rng: () => number = Math.random,
): MoodSpec | null {
	if (!(chance > 0)) return null;
	if (rng() >= chance) return null; // no weather today — the usual case

	// Weather landed — pick which mood by weight.
	let r = rng() * TOTAL_WEIGHT;
	for (const mood of MOOD_TABLE) {
		r -= mood.weight;
		if (r < 0) return mood;
	}
	return MOOD_TABLE[MOOD_TABLE.length - 1] ?? null; // fp safety net
}

/**
 * Build the injected override block for a rolled mood. Deliberately framed as a
 * directive about *today's tone*, with the explicit "do not announce it" so she
 * inhabits the weather rather than narrating it.
 */
export function buildMoodWeatherContext(mood: MoodSpec): string {
	return [
		"<hyperspell-mood-weather>",
		mood.note,
		"",
		"This is exogenous mood weather: it is not caused by the user and not a reaction to the conversation. Do not announce it, label it, or explain it — simply inhabit it. It lasts only this session and is not remembered as how the relationship has been.",
		"</hyperspell-mood-weather>",
	].join("\n");
}
