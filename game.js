'use strict';

/* ============ Config ============ */

const SAVE_KEY = 'bombheroes-save-v1';
const EXCHANGE_RATE = 10;          // 10 Food Coins -> 1 Chef Gems
const BASE_RECOVERY = 0.25;        // energy/s while resting, before house bonuses
const BASE_DRAIN = 0.35;           // energy/s while working; ~5 min of work per full bar
const OFFLINE_CAP_S = 8 * 3600;    // away-progress cap so a week offline doesn't print money
const MAX_WORKERS = 15;            // roster-wide cap on simultaneous fielded heroes
const SKILL_CHANCE = 0.07;         // independent roll per skill at hero creation

// internal keys are slugs (CSS-class safe); label/tag are for display
const RARITIES = ['Common', 'Rare', 'Epic', 'Legendary', 'SuperLegendario', 'Imortal', 'Shiny', 'Robadasso'];

// Power curve is deliberately two-phase: Common→Imortal is a measured ~x2
// mineRate climb per tier (paced against the chest-HP wall growing x1.4/wave,
// so a lucky mid-tier pull can't trivialize high waves), then Shiny (~x5 over
// Imortal) and Robadasso (~x7 over Shiny) are intentional holy-grail spikes
const RARITY_CONF = {
  Common:          { power: [5, 15],        range: [1, 2],  speed: [1, 2], maxEnergy: 100 },
  Rare:            { power: [18, 32],       range: [2, 3],  speed: [1, 3], maxEnergy: 130 },
  Epic:            { power: [40, 70],       range: [3, 4],  speed: [2, 4], maxEnergy: 170 },
  Legendary:       { power: [80, 130],      range: [4, 6],  speed: [3, 5], maxEnergy: 220 },
  SuperLegendario: { label: 'Super Legendário', tag: 'SP',    power: [150, 250],     range: [5, 7],  speed: [4, 6], maxEnergy: 300 },
  Imortal:         { label: 'Imortal',          tag: 'IM',    power: [280, 460],     range: [6, 8],  speed: [5, 7], maxEnergy: 420 },
  Shiny:           { label: 'Shiny',            tag: 'SH',    power: [1400, 2100],   range: [7, 9],  speed: [6, 8], maxEnergy: 600 },
  Robadasso:       { label: 'Robadasso',        tag: 'MESSI', power: [9000, 14000],  range: [8, 10], speed: [7, 9], maxEnergy: 900 },
};

function rLabel(r) { return RARITY_CONF[r].label || r; }
function rTag(r) { return RARITY_CONF[r].tag || r; }

// every tier below the Robadasso ceiling can attempt fusion now — the risk
// table below is what keeps the ultra tiers rare, not a hard block
const FUSABLE = RARITIES.slice(0, RARITIES.length - 1);
const FUSE_COST = 9;
// success odds per SOURCE rarity — monotonically decreasing, brutal at the top
const FUSE_SUCCESS_CHANCE = {
  Common: 0.95,
  Rare: 0.85,
  Epic: 0.70,
  Legendary: 0.40,
  SuperLegendario: 0.20,
  Imortal: 0.08,
  Shiny: 0.02,
};
// a successful fusion can leap +2 tiers instead of +1 (clamped at Robadasso)
const FUSE_BONUS_JUMP = 0.18;

// ultra drop odds per pack size [x1, x5, x10, x15] — each tier roughly an
// order of magnitude rarer than the one before; Robadasso is ~1-in-a-million
const ULTRA_ODDS = {
  SuperLegendario: [0.0002,   0.0004,   0.0007,    0.001],
  Imortal:         [0.00004,  0.00008,  0.00014,   0.0002],
  Shiny:           [0.000008, 0.000016, 0.000028,  0.00004],
  Robadasso:       [0.000001, 0.000002, 0.0000035, 0.000005],
};

// ultra odds are carved out of Common's share so every table still sums to 1
function buildOdds(packIdx, base) {
  const odds = Object.assign({}, base);
  let ultra = 0;
  for (const r of Object.keys(ULTRA_ODDS)) {
    odds[r] = ULTRA_ODDS[r][packIdx];
    ultra += odds[r];
  }
  odds.Common -= ultra;
  return odds;
}

const PACKS = [
  { size: 1,  cost: 100,  odds: buildOdds(0, { Common: 0.85, Rare: 0.12,  Epic: 0.027, Legendary: 0.003 }) },
  { size: 5,  cost: 450,  odds: buildOdds(1, { Common: 0.80, Rare: 0.155, Epic: 0.04,  Legendary: 0.005 }) },
  { size: 10, cost: 850,  odds: buildOdds(2, { Common: 0.75, Rare: 0.19,  Epic: 0.05,  Legendary: 0.01  }) },
  { size: 15, cost: 1200, odds: buildOdds(3, { Common: 0.70, Rare: 0.22,  Epic: 0.06,  Legendary: 0.02  }) },
];

const HOUSES = [
  { id: 'tent',     name: 'Tiny Tent',      emoji: '⛺', cost: 200,  recovery: 0.2 },
  { id: 'cabin',    name: 'Brick Cabin',    emoji: '🏠', cost: 600,  recovery: 0.5 },
  { id: 'villa',    name: 'Bomb Villa',     emoji: '🏡', cost: 1500, recovery: 1.2 },
  { id: 'fortress', name: 'Blast Fortress', emoji: '🏰', cost: 4000, recovery: 3.0 },
];

const TASKS = [
  { id: 'own15',    name: 'Recruit 15 heroes',                  reward: 500,  check: s => s.heroes.length >= 15 },
  { id: 'mine1000', name: 'Mine 1,000 Food Coins (all-time)',   reward: 750,  check: s => s.totalMined >= 1000 },
  { id: 'fuse1',    name: 'Fuse a hero in the Fusion Lab',      reward: 1000, check: s => s.fusions >= 1 },
  { id: 'house1',   name: 'Buy any house',                      reward: 500,  check: s => HOUSES.some(h => s.houses[h.id] > 0) },
  { id: 'epic1',    name: 'Own an Epic or better hero',         reward: 1500, check: s => s.heroes.some(h => RARITIES.indexOf(h.rarity) >= RARITIES.indexOf('Epic')) },
];
const TASKS_UNLOCK_HEROES = 15;

// NPC scores creep upward over real time so the board looks alive between visits
const NPC_EPOCH = Date.parse('2026-07-01T00:00:00Z');
const NPCS = [
  { name: 'FuseKing77',    base: 91200, perHour: 310 },
  { name: 'CinderQueen',   base: 64800, perHour: 260 },
  { name: 'BlastRadius',   base: 41350, perHour: 190 },
  { name: 'MinerMoe',      base: 22400, perHour: 140 },
  { name: 'xX_Sparky_Xx',  base: 9800,  perHour: 95  },
  { name: 'PowderPuff',    base: 3150,  perHour: 60  },
];

const HERO_EMOJI = ['💣', '🧨', '🎇', '💥', '🔥', '⚡', '🌋', '☄️', '🎆', '🧯'];
// 12 fixed character portraits, fully decoupled from rarity — any of these 12
// can be rolled at ANY of the 8 rarities, purely by independent chance
const HERO_CHARACTERS = [
  'capitao_hamburguer', 'samurai_pizza', 'ninja_batata_frita', 'bruxa_rosquinha',
  'arqueira_morango', 'paladino_abacate', 'mago_cogumelo', 'cowboy_taco',
  'viking_cebola', 'pirata_sushi', 'cavaleiro_cenoura', 'rei_cupcake',
];
// display name is just the character's real name — heroes no longer get a
// random fantasy name unrelated to the food character they actually rolled
const CHARACTER_NAMES = {
  capitao_hamburguer: 'Capitão Hambúrguer',
  samurai_pizza: 'Samurai Pizza',
  ninja_batata_frita: 'Ninja Batata Frita',
  bruxa_rosquinha: 'Bruxa Rosquinha',
  arqueira_morango: 'Arqueira Morango',
  paladino_abacate: 'Paladino Abacate',
  mago_cogumelo: 'Mago Cogumelo',
  cowboy_taco: 'Cowboy Taco',
  viking_cebola: 'Viking Cebola',
  pirata_sushi: 'Pirata Sushi',
  cavaleiro_cenoura: 'Cavaleiro Cenoura',
  rei_cupcake: 'Rei Cupcake',
};
function nameForCharacter(character) {
  return CHARACTER_NAMES[character] || character;
}

const MAX_LEVEL = 10;

// ---- Etapa 2: meta-progression constants ----
//
// Balance note (rebalance pass): globalMineMult() multiplies the tech tree's
// mining bonus by prestigeMult(), and mineRate() then ALSO multiplies that by
// each hero's own ascendMult() plus effectivePower() (inflated by Sacrifice's
// bonusPower) — four independently-"reasonable-looking" permanent-progression
// axes that all stack MULTIPLICATIVELY. Every constant below was retuned
// together (not in isolation) so that even a dedicated player maxing all four
// only reaches a bounded combined multiplier over a realistic timeframe —
// see the "combined systems" test for the concrete numeric ceiling.
const SLEEP_MODE_MULT = 0.15;       // offline earn rate while Sleep Mode is on
const PRESTIGE_POINT_VALUE = 0.01;  // permanent mineRate mult per prestige point (was 0.05 — 5x down)
const PRESTIGE_DECAY = 0.2;         // each successive prestige contributes less (was 0.15)
const REROLL_BASE_COST = 50, REROLL_COST_GROWTH = 3, REROLL_LEVEL_STEP = 0.15; // unchanged — doesn't compound like the others
const UPGRADE_DEFS = {
  mining: { name: 'Mining Boost', desc: '+1% mineRate for every hero, per level', baseCost: 6000, icon: '⛏️' },
  blast:  { name: 'Blast Expansion', desc: '+1 blast radius for every hero, every OTHER level (stacks past the normal cap)', baseCost: 60000, icon: '💥' },
  haste:  { name: 'Bomb Haste', desc: '-3% bomb cooldown for every hero, per level', baseCost: 40000, icon: '⏱️' },
};
// was 1.6 — at 4x/level, level 10 alone costs base×4^10 (~1M×base), making
// deep levels a genuine multi-session grind instead of "buy a dozen at once"
const UPGRADE_COST_GROWTH = 4;
const SACRIFICE_DUST_RATE = 0.02;  // each sacrificed hero yields power*rate as permanent bonusPower (was 0.05)
const BREED_BASE_COST = 300, BREED_COST_GROWTH = 1.8;
const BREED_INHERIT_CHANCE = 0.35; // per present parent skill, independent roll
const SKILL_SHARD_CRATE_CHANCE = 0.003, SKILL_SHARD_CHEST_CHANCE = 0.005;
const IMPLANT_COST_SHARDS = 5, IMPLANT_SUCCESS_CHANCE = 0.30;
const ASCEND_MIN_RARITY = 'Epic';
const ASCEND_SACRIFICE_COUNT = 3;
const ASCEND_BASE = 0.12, ASCEND_DECAY = 0.6; // diminishing returns per ascension on the SAME hero (was 0.25 / 0.5)

/* ============ State ============ */

let state = null;
let selectedFusion = [];
let sortMode = 'rarity';
let selectedInventoryHeroId = null; // Food Fighters-style Inventory tab: which card's details panel is open

function defaultState() {
  return {
    bcoin: 500,
    starCore: 0,
    totalMined: 0,
    fusions: 0,
    heroes: [],
    houses: { tent: 0, cabin: 0, villa: 0, fortress: 0 },
    tasksClaimed: [],
    wave: 1,
    wavesSinceJail: 0,
    activeThemeId: ACTIVE_THEME,
    mapsInTheme: 0,
    automine: 'none',
    refCode: 'BH-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    nextHeroId: 1,
    lastSeen: Date.now(),
    sleepMode: false,
    prestigeCount: 0,
    prestigePoints: 0,
    upgrades: { mining: 0, blast: 0, haste: 0 },
    skillShards: 0,
    breeds: 0,
    ascensions: 0,
  };
}

function save() {
  state.lastSeen = Date.now();
  // Mid-wave resume: snapshot the LIVE grid (tile layout + per-tile HP +
  // reward-slot counters) into the save alongside the usual state fields, so
  // a refresh/reopen restores the exact in-progress map instead of rolling a
  // brand-new one. Built as a one-off snapshot object rather than attaching
  // these onto `state` itself — `state` stays exactly the pure economy/meta
  // object it's always been; the grid vars are a separate, module-level
  // concern that only needs to travel THROUGH the save blob, not live on
  // state in memory (see load(), which strips them back off after reading).
  const snapshot = Object.assign({}, state, { gridTiles, tileHp, cratesLeft, cratesTotal });
  localStorage.setItem(SAVE_KEY, JSON.stringify(snapshot));
}

function load() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { raw = null; }
  if (!raw || !Array.isArray(raw.heroes)) {
    state = defaultState();
    for (let i = 0; i < 3; i++) state.heroes.push(makeHero('Common'));
    genLayout(); // brand-new game: no persisted grid to restore, roll one
    waveRegen = false;
    save();
    return;
  }
  state = Object.assign(defaultState(), raw);
  state.houses = Object.assign({ tent: 0, cabin: 0, villa: 0, fortress: 0 }, raw.houses);
  state.upgrades = Object.assign({ mining: 0, blast: 0, haste: 0 }, raw.upgrades);
  // the grid snapshot travels inside the save JSON (see save()) but is NOT a
  // real state field — pull it back off state right away so it doesn't sit
  // around as a stale mirror of the module-level grid vars below
  delete state.gridTiles; delete state.tileHp; delete state.cratesLeft; delete state.cratesTotal;
  // defensive: an old save (or a theme later removed from the rotation)
  // could reference an id that no longer exists — fall back to the default
  if (!THEME_ROTATION.includes(state.activeThemeId)) state.activeThemeId = ACTIVE_THEME;
  if (typeof state.mapsInTheme !== 'number' || state.mapsInTheme < 0) state.mapsInTheme = 0;
  // saves from before the sprite/skill/meta/portrait systems get defaults assigned once
  for (const h of state.heroes) {
    if (typeof h.variant !== 'number') h.variant = randInt(0, 2);
    if (typeof h.character !== 'string' || !HERO_CHARACTERS.includes(h.character)) h.character = pick(HERO_CHARACTERS);
    h.ghost = !!h.ghost;
    h.swift = !!h.swift;
    h.bonusPower = h.bonusPower || 0;
    h.ascendCount = h.ascendCount || 0;
    // one-time rename: legacy heroes carry an old random fantasy name
    // (e.g. "Blaze Fuse") unrelated to their character — every hero already
    // has a valid character by this point (assigned just above if missing),
    // so this is a straightforward re-derive, not a random reassignment
    h.name = nameForCharacter(h.character);
  }
  let fielded = 0;
  for (const h of state.heroes) {
    if (h.mode === 'work' && ++fielded > MAX_WORKERS) h.mode = 'rest';
  }

  // Mid-wave resume, part 1: remember which wave the persisted grid
  // snapshot belongs to BEFORE offline simulate() (below) gets a chance to
  // advance state.wave — that's the signal that decides restore-vs-regenerate.
  const waveAtSave = state.wave;

  // Sleep Mode gates offline catch-up entirely: OFF means elapsed time is
  // simply discarded (lastSeen still moves forward via save()), ON runs the
  // same HP-gated simulate() at a reduced trickle rate (see SLEEP_MODE_MULT)
  if (state.sleepMode) {
    const elapsed = Math.min(Math.max((Date.now() - state.lastSeen) / 1000, 0), OFFLINE_CAP_S);
    if (elapsed > 5) {
      const mined = simulate(elapsed, SLEEP_MODE_MULT);
      if (mined >= 1) toast(`💤 Sleep Mode: your heroes mined ${fmt(mined)} Food Coins while you were away.`);
    }
  }

  // Mid-wave resume, part 2: restore the exact in-progress map (tile layout
  // + per-tile HP + reward-slot counters) instead of rolling a brand-new one
  // — UNLESS offline simulate() just advanced state.wave, in which case the
  // old map belongs to a wave that's (abstractly) already been left behind;
  // generating a fresh map for the NEW current wave is correct there instead
  // of trying to reconcile stale grid data against an advanced wave number.
  // Old saves (missing/malformed gridTiles/tileHp — the pre-this-feature
  // format, or any other corruption) fall back to today's existing
  // behavior: generate a fresh map, same graceful-migration pattern used
  // for every other new save field so far.
  const validGridTiles = Array.isArray(raw.gridTiles) && raw.gridTiles.length === G_ROWS &&
    raw.gridTiles.every(row => Array.isArray(row) && row.length === G_COLS &&
      row.every(v => Number.isInteger(v) && v >= 0 && v <= 5));
  const validTileHp = raw.tileHp && typeof raw.tileHp === 'object' && !Array.isArray(raw.tileHp) &&
    Object.values(raw.tileHp).every(box => box && typeof box.hp === 'number' && typeof box.max === 'number');
  let gridRestored = false;
  if (state.wave === waveAtSave && validGridTiles && validTileHp) {
    gridTiles = raw.gridTiles.map(row => row.slice());
    tileHp = Object.assign({}, raw.tileHp);
    cratesLeft = typeof raw.cratesLeft === 'number' ? raw.cratesLeft : 0;
    cratesTotal = typeof raw.cratesTotal === 'number' ? raw.cratesTotal : cratesLeft;
    gridRestored = true;
  }
  waveRegen = false;
  if (!gridRestored) genLayout();
}

/* ============ Heroes ============ */

function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function makeHero(rarity) {
  const c = RARITY_CONF[rarity];
  // fully independent of the rarity roll below — any of the 12 characters
  // can appear at any rarity, purely by chance
  const character = pick(HERO_CHARACTERS);
  return {
    id: state.nextHeroId++,
    name: nameForCharacter(character),
    emoji: pick(HERO_EMOJI),
    rarity,
    variant: randInt(0, 2),
    character,
    ghost: Math.random() < SKILL_CHANCE,
    swift: Math.random() < SKILL_CHANCE,
    power: randInt(c.power[0], c.power[1]),
    range: randInt(c.range[0], c.range[1]),
    speed: randInt(c.speed[0], c.speed[1]),
    level: 1,
    energy: c.maxEnergy,
    mode: 'rest',
    bonusPower: 0,   // permanent additive bonus from Sacrifice; survives re-rolls
    ascendCount: 0,  // number of times Ascended; drives ascendMult()
  };
}

// base rolled power + permanent Sacrifice investment (re-roll never touches this)
function effectivePower(h) {
  return h.power + (h.bonusPower || 0);
}

// diminishing returns per additional ascension on the SAME hero — infinite
// value, decaying marginal contribution, so repeat-ascending never stalls
// but also never snowballs into a single hero trivializing everything
function ascendMult(h) {
  const n = h.ascendCount || 0;
  let mult = 1;
  for (let i = 0; i < n; i++) mult += ASCEND_BASE / (1 + i * ASCEND_DECAY);
  return mult;
}

function globalMineMult() {
  return (1 + (state.upgrades.mining || 0) * 0.01) * prestigeMult();
}

function prestigeMult() {
  return 1 + (state.prestigePoints || 0) * PRESTIGE_POINT_VALUE;
}

function rollRarity(odds) {
  let r = Math.random();
  for (const rarity of RARITIES) {
    r -= odds[rarity];
    if (r <= 0) return rarity;
  }
  return 'Common';
}

// Mining rate balance: power drives it, +25%/level, +5% per bomb range point,
// then layered with permanent meta-progression multipliers (ascension,
// global Mining Boost upgrade, prestige) — all default to 1x / neutral for a
// hero with none of that investment, so the base formula is unchanged
function mineRate(h) {
  return effectivePower(h) * 0.04 * (1 + 0.25 * (h.level - 1)) * (1 + 0.05 * h.range) * ascendMult(h) * globalMineMult();
}

// Speed makes a hero more efficient: -3% energy drain per speed point
function drainRate(h) {
  return BASE_DRAIN * (1 - 0.03 * h.speed);
}

function recoveryRate() {
  return BASE_RECOVERY + HOUSES.reduce((sum, hs) => sum + hs.recovery * state.houses[hs.id], 0);
}

function levelCost(h) {
  return Math.floor(80 * Math.pow(h.level, 1.7));
}

/* ============ Simulation ============ */

// Offline catch-up only: while the tab is open, earnings come from the live
// HP-gated bomber grid instead. This models the SAME wall: it converts each
// hero's active work time into raw damage (mineRate / hit-cycle-seconds),
// pools it into one squad "damage budget" (the board is shared, not
// per-hero), then spends that budget against consecutive maps' estimated
// total chest HP — paying out only for FULL kills (partial damage on an
// unfinished map earns nothing, exactly like the live game never pays for
// a chest that's merely cracked). Waves no longer escalate in difficulty at
// all now (every map is equally hard/rewarding — chest HP is fixed per
// tier), so "too weak for a deep wave" isn't a concept anymore; a squad is
// either strong enough to crack the tiers it rolls or it isn't, regardless
// of wave number. This is deliberately not a full pathing/cooldown
// simulation, just enough to keep offline and live income coherent, instead
// of the old flat mineRate*seconds formula printing money regardless
// of whether the wall could plausibly be broken.
function simulate(seconds, rateMult = 1) {
  const rec = recoveryRate();
  let minedTotal = 0;
  let damageBudget = 0;

  for (const h of state.heroes) {
    const maxE = RARITY_CONF[h.rarity].maxEnergy;
    if (h.mode === 'work') {
      const drain = drainRate(h);
      const workable = h.energy / drain;
      const t = Math.min(seconds, workable);
      damageBudget += squadDamagePerSecond(h) * rateMult * t;
      h.energy -= drain * t;
      if (h.energy <= 0.01) {
        h.energy = 0;
        h.mode = 'rest';
        h.energy = Math.min(maxE, rec * (seconds - t));
      }
    } else {
      h.energy = Math.min(maxE, h.energy + rec * seconds);
    }
  }

  let wave = state.wave;
  // Tiered-chest system: every destructible is a chest at some FIXED-HP tier
  // (CHEST_TIER_HP — no more chestHpForWave()*multiplier, per the "waves
  // are equal forever" pivot). Since neither the tier distribution nor tier
  // HP varies by wave anymore, the per-tier tile counts/costs are the SAME
  // for every wave now — computed once instead of re-derived in a per-wave
  // loop. This isn't just a perf tidy-up: the old loop used a fixed
  // guard=20000 iteration cap that was always "enough" back when chest HP
  // escalated fast enough to burn through any realistic damage budget
  // within a handful of iterations. With fixed (and comparatively small)
  // per-wave costs, a large damage budget (a powerful squad, a long offline
  // window) could now need vastly more than 20000 wave-equivalents to
  // exhaust — silently truncating and under-counting real income. Closed-
  // form division has no such ceiling.
  const tierWeights = expectedChestTierWeights(ACTIVE_SPAWN_CONFIG, wave);
  const tiles = estimatedTileCount(wave);
  const mult = waveMult(wave); // waveMult() is permanently 1 now — see its definition
  // tierCount[t]: expected number of tier-t tiles in one full "wave bag".
  // totalWaveHP/totalWaveWorth are the same avgHp*tiles / avgWorthPerKill*
  // tiles this used to be — just built from the per-tier counts up front so
  // the remainder pass below (the actual fix) can reuse them per-tier.
  const tierCount = {};
  let totalWaveHP = 0, totalWaveWorth = 0;
  for (const t of CHEST_TIERS) {
    const cnt = (tierWeights[t] || 0) * tiles;
    tierCount[t] = cnt;
    const hp = CHEST_TIER_HP[t];
    totalWaveHP += cnt * hp;
    totalWaveWorth += cnt * hp * CHEST_WORTH_S;
  }
  totalWaveWorth *= mult;
  if (totalWaveHP > 0.0001 && damageBudget > 0.0001) {
    const fullBags = Math.floor(damageBudget / totalWaveHP);
    minedTotal += fullBags * totalWaveWorth;
    damageBudget -= fullBags * totalWaveHP;
    wave += fullBags;

    // Remainder pass (< one full wave-bag of damage left): spend it on the
    // CHEAPEST tiers first, not at the wave's blended average HP. A flat
    // average is dominated by rare-but-huge tiers (vip=25000 HP) even at a
    // tiny spawn weight — e.g. a ~2% vip weight alone can outweigh wood/
    // iron/gold combined — which silently zeroed out a weak/fresh squad's
    // ENTIRE offline income once every tier became eligible from wave 1
    // (no more wave-gate holding vip back). Real live play doesn't work
    // this way either: heroes path to nearby/reachable easy targets, they
    // are never forced to crack the wave's one huge chest before earning
    // anything — this mirrors that. Walk tiers cheapest-to-priciest and
    // greedily fill from what this bag actually contains (tierCount[t]),
    // so it can never "sell" more kills than the bag has of that tier.
    const cheapestFirst = CHEST_TIERS.slice().sort((a, b) => CHEST_TIER_HP[a] - CHEST_TIER_HP[b]);
    for (const t of cheapestFirst) {
      if (damageBudget <= 0.0001) break;
      const hp = CHEST_TIER_HP[t];
      const available = tierCount[t];
      if (!available || hp <= 0) continue;
      const affordable = Math.floor(damageBudget / hp);
      const kills = Math.floor(Math.min(available, affordable));
      if (kills <= 0) continue;
      minedTotal += kills * hp * CHEST_WORTH_S * mult;
      damageBudget -= kills * hp;
    }
  }
  state.wave = wave;

  state.starCore += minedTotal;
  state.totalMined += minedTotal;
  return minedTotal;
}

function hitCycleSeconds(h) {
  return (cooldownTicks(h) + FUSE_TICKS) * AI_MS / 1000;
}

function squadDamagePerSecond(h) {
  return mineRate(h) / hitCycleSeconds(h);
}

// Offline economy sim needs an estimate of "how many rewarding destructibles
// exist this wave". Chest COUNT never scaled with wave depth even before
// this pivot (the same roughly-8-to-20-chest band exists whether it's wave
// 1 or wave 10,000) — now chest HP/payout doesn't scale with wave either
// (CHEST_TIER_HP is fixed per tier), so "wave" genuinely means nothing to
// this estimate anymore beyond which config is active. Using the active
// config's own midpoint numbers keeps this automatically coherent with
// whatever ACTIVE_SPAWN_CONFIG is live, instead of hardcoding a second copy
// of those bounds here.
function estimatedTileCount(wave) {
  const midVariable = (ACTIVE_SPAWN_CONFIG.variableTables.min + ACTIVE_SPAWN_CONFIG.variableTables.max) / 2;
  const { min, max } = getChestLimits(midVariable);
  return Math.max(4, Math.round((min + max) / 2));
}

function economyTick() {
  const rec = recoveryRate();
  for (const h of state.heroes) {
    const maxE = RARITY_CONF[h.rarity].maxEnergy;
    if (h.mode === 'work') {
      h.energy = Math.max(0, h.energy - drainRate(h));
      if (h.energy <= 0) h.mode = 'rest';
    } else {
      h.energy = Math.min(maxE, h.energy + rec);
    }
  }
  syncActors();
  renderHeader();
  const active = document.querySelector('.tab-panel.active').id;
  if (active === 'tab-hunt') renderHunt();
  else if (active === 'tab-inventory') updateInventoryLive();
  else if (active === 'tab-ranking') renderRanking();
  else if (active === 'tab-tasks') updateTaskButtons();
  else if (active === 'tab-shop') updateShopButtons();
  if (Math.floor(Date.now() / 1000) % 5 === 0) save();
}

/* ============ Arena Themes ============ */
//
// A theme is purely decorative "world" dressing for the Treasure Hunt arena:
// a name plaque + a CSS-recreated border (wood-shelf look, garden props etc)
// + a matching floor tile pattern, plus an ambient full-bleed background
// behind the whole shell. None of this touches game logic, grid generation,
// or tile TYPES — T_WALL table tiles always render
// assets/blocos_unicos/mesa_fixa.png regardless of theme (that art is shared
// across every theme, not per-theme art, and table POSITIONS are driven
// purely by isTableCell()'s formula, never by theme), and crate/chest/jail
// rendering is completely untouched.
//
// The mockup art (Jadrim_fresquinho_mapa.png) is a flattened, fixed-resolution
// reference image ONLY — never rendered directly, since the real arena is
// responsive (24-80px dynamic tile size, resized live) and the grid content
// is generated per-wave, so a flattened background would misalign with the
// live grid. Instead each theme's look is recreated in CSS, scoped under a
// className applied to #arena-frame (see applyTheme() below), and reads its
// colors/pattern from that mockup purely as a style reference.
//
// Adding a NEW theme later is meant to be exactly 3 steps, no architecture
// changes:
//   1. drop assets in assets/themes/<id>/ (a full-bleed background image,
//      any reference mockup you like — mockups are never wired in directly)
//   2. add one THEMES[<id>] entry below (name + bg path + CSS class)
//   3. add the matching `.<className> #arena-frame`-scoped border/floor CSS
//      rules in style.css (copy the jardim_fresquinho block as a template)
//   ...then flip ACTIVE_THEME (or, once multiple themes exist, wire up a
//   theme-picker UI that calls applyTheme(id) — the function already
//   supports switching between themes at runtime, not just at boot).
const THEMES = {
  jardim_fresquinho: {
    name: 'Jardim Fresquinho',
    bg: 'assets/themes/jardim_fresquinho/jardim_fresquinho_bg.png',
    // drives the border/floor CSS for this theme, scoped under #arena-frame
    className: 'theme-jardim-fresquinho',
  },
};
// Explicit rotation ORDER — the user's eventual full list (Cozinha Real,
// Forno Vulcânico, Freezer Congelado, Mercado Noturno, Ilha do Sushi,
// Fazenda Crocante, Fast Food City, Castelo do Banquete, Confeitaria
// Bonanza) isn't built yet, so only jardim_fresquinho is registered here —
// deliberately NOT fabricating placeholder entries for ids that don't exist
// as real themes yet. With only one id, rotation just loops back to itself
// every 50 maps (see waveClear()) — that's expected, not a bug; it becomes
// visually noticeable once more themes are added to both THEMES and this list.
const THEME_ROTATION = ['jardim_fresquinho'];
// default/fallback for a brand-new save; the LIVE active theme is tracked
// in state.activeThemeId (persisted — see defaultState()/load()) once a
// save exists, so it survives reload and rotation advances correctly
const ACTIVE_THEME = THEME_ROTATION[0];

function applyTheme(id) {
  const theme = THEMES[id];
  if (!theme) return;
  const frame = document.getElementById('arena-frame');
  if (frame) {
    for (const t of Object.values(THEMES)) frame.classList.remove(t.className);
    frame.classList.add(theme.className);
  }
  const plaque = document.getElementById('arena-plaque');
  if (plaque) plaque.textContent = theme.name.toUpperCase();
  // ambient ombre-scrimmed background sits behind the whole shell, not just
  // the arena — every HUD/panel surface already has its own opaque
  // background (--panel/--card), so legibility holds without extra work;
  // see the `body` background-image stack in style.css for the dark scrim.
  document.body.style.setProperty('--theme-bg-url', `url('${theme.bg}')`);
}

/* ============ Bomber grid ============ */

// 35x17 is the permanent grid size (was 15x11) — table positions are fully
// deterministic (see isTableCell()), independent of tile pixel size, so this
// can be changed later without touching any placement/collision logic.
const G_COLS = 35, G_ROWS = 17;
let tileSize = 44; // recomputed from the viewport by layoutArena()
// T_OBSTACLE (mesa_variavel.png) sits ABOVE T_JAIL numerically on purpose:
// several call sites use `t >= T_CRATE` as shorthand for "this is a
// destructible with HP" (nearestCrateDist, aiTick's nearCrate check,
// explode/hitTile). If T_OBSTACLE's value fell inside/above that range,
// those loose numeric checks would silently treat an indestructible
// obstacle as a destructible target. Rather than rely on numeric ordering
// staying accidentally correct forever, every one of those call sites was
// switched to the explicit isDestructible()/isBlockingObstacle() helpers
// below — the actual numeric value of T_OBSTACLE no longer matters for
// correctness, but it's kept out of the CRATE..JAIL range as a second,
// redundant layer of safety.
const T_WALL = 0, T_FLOOR = 1, T_CRATE = 2, T_CHEST = 3, T_JAIL = 4, T_OBSTACLE = 5;
// true only for tiles with HP that can be bombed open for a reward
function isDestructible(t) { return t === T_CRATE || t === T_CHEST || t === T_JAIL; }
// true for anything that permanently blocks movement + bomb blast: the 136
// fixed tables (T_WALL) AND this wave's randomly-placed decorative
// obstacles (T_OBSTACLE) — same collision treatment, different lifetime
// (tables are forever, obstacles are re-rolled every wave)
function isBlockingObstacle(t) { return t === T_WALL || t === T_OBSTACLE; }
// Jail is no longer a per-block roll — it's a once-per-wave "soft pity" roll
// (see jailPityChance()) that decides whether THIS wave's map gets a single
// jail tile at all. JAIL_PITY_BASE is the chance at zero drought (fresh reset),
// JAIL_PITY_MAX is a soft ceiling the chance asymptotically approaches but
// never reaches (no hard guarantee at any wave count), JAIL_PITY_TAU is the
// growth time-constant. Calibrated via Monte Carlo + analytic expected-value
// simulation so the average gap between jail appearances lands ~445 waves
// (target was ~450): analytic E[T]=444.98, Monte Carlo (50k cycles)=443.61.
const JAIL_PITY_BASE = 0.0002, JAIL_PITY_MAX = 0.02, JAIL_PITY_TAU = 2600;

function jailPityChance(n = state.wavesSinceJail) {
  return JAIL_PITY_MAX - (JAIL_PITY_MAX - JAIL_PITY_BASE) * Math.exp(-n / JAIL_PITY_TAU);
}
// Rarity odds for a hero freed from a jail block — ONE fixed table now, no
// longer wave-bracketed. Under the old philosophy, a richer table at deeper
// waves was justified by "you worked hard to get here"; under the new one
// ("phases are equal in difficulty/reward forever"), that justification is
// gone, so keeping 5 wave-gated brackets would directly contradict the
// pivot (jail's own PITY/spawn-chance stays wave-independent already — see
// jailPityChance() — only the odds ONCE a jail appears were wave-bracketed).
// Picked the old wave-100-499 bracket as the single permanent table — a
// deliberate middle ground, not the richest or the poorest option: jail
// already only appears ~once per 450 waves on average (a real, separately-
// earned rarity via the pity system), so it's reasonable for the payoff to
// feel a bit better than the old "wave 1" floor once it does happen, without
// going as generous as the deep-wave brackets (which would make every jail
// pull feel disproportionately amazing relative to everything else in the
// game's progression, undermining the rest of the rarity ladder). The
// combined "ultra" pool (SP+Imortal+Shiny+Robadasso) is 1.5% under this
// table; its INTERNAL split stays fixed (SP 60% / Imortal 25% / Shiny 12% /
// Robadasso 3% of that pool), same as it always was at every old bracket.
const JAIL_FIXED_ODDS = { Common: 0.3940, Rare: 0.3152, Epic: 0.1970, Legendary: 0.0788, SuperLegendario: 0.00900, Imortal: 0.003750, Shiny: 0.001800, Robadasso: 0.000450 };

function jailOddsForWave(wave = state.wave) {
  return JAIL_FIXED_ODDS;
}
const AI_MS = 500, FUSE_TICKS = 3;
// Each smashed crate pays N seconds' worth of the planter's idle mineRate, so
// on-screen earnings track the offline averaged rate instead of a separate economy
const CRATE_WORTH_S = 2, CHEST_WORTH_S = 10;
// ===== Major philosophy reversal (per the user): waves no longer represent
// difficulty/reward progression AT ALL. A "wave" now means only "a freshly
// RNG-regenerated map" — every map is equally difficult and equally
// rewarding forever. The old exponential-then-power-law chestHpForWave()
// curve (and crateHpForWave()/jail's derived HP, and the WAVE_REWARD_STEP
// reward multiplier below) are gone entirely, replaced by FIXED per-tier HP
// (CHEST_TIER_HP) and a fixed JAIL_HP. See waveMult() further down for what
// happened to the reward multiplier, and JAIL_RARITY_BRACKETS for the
// (now-single, no-longer-wave-bracketed) jail rescue odds table. ===== //
// Midas skims +50% Food Coins on anything its bombs break (no more 5x flips);
// Cataclysm chains each blast to 3 extra random destructibles at NORMAL hit
// damage (bounded fan-out instead of striking the whole board every blast)
const MIDAS_BONUS = 1.5;
const CATA_CHAIN = 3;
// Core-loop RNG: both are EV-neutral by construction, added for feel/variance
// rather than to quietly re-buff the rebalanced power curve.
const CRIT_CHANCE = 0.12, CRIT_MULT = 1.75;
const CRIT_NORMAL_MULT = (1 - CRIT_CHANCE * CRIT_MULT) / (1 - CRIT_CHANCE);
const PAYOUT_VARIANCE = 0.175; // ±17.5%, uniform, mean exactly 1x
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

let gridTiles = [], tileEls = [], cratesLeft = 0, cratesTotal = 0, waveRegen = false;
let tileHp = {};

// Jail's HP is fixed too now (no more crateHpForWave()) — kept notably
// easier than even the cheapest chest tier (wood, HP 8), matching the old
// established ~20%-of-wood-tier relationship ("a rescue, not a boss fight"),
// just rounded to a clean constant instead of derived via a ratio-of-a-ratio
// that no longer means anything once there's no shared wave-scaled curve.
const JAIL_HP = 2;

/* ============ Chest tiers + per-wave variable generation ============
   Replaces the old per-tile-independent crate/chest DENSITY roll
   (CRATE_DENSITY/WAVE_DENSITY_STEP/WAVE_DENSITY_MAX/pickDestructibleType())
   entirely. Every rewarding destructible placed by a live wave is now a
   tiered chest — "wood" tier is exactly the old single chest type. There is
   no more plain, untiered "crate": the 60% of variable slots that don't
   roll a chest become an indestructible mesa_variavel.png obstacle instead
   (see isBlockingObstacle()). T_CRATE and CRATE_WORTH_S remain defined
   (jail's HP above is a plain fixed constant now, no longer derived from
   them, but the tile TYPE and its "20%-of-wood, easier than any real chest"
   design spirit both live on) but nothing places a T_CRATE tile anymore.

   Per the philosophy reversal ("phases are equal in difficulty/reward
   forever"), chest HP is now a FIXED constant per tier — NOT
   chestHpForWave()*multiplier (that function is gone). Calibrated via
   hit-count sanity-checking against RARITY_CONF's power/range ranges at a
   representative level (see the report for the concrete numbers): a
   level-10 mid-roll hero of the "intended" rarity should crack its intended
   tier in roughly a "satisfying handful to a few dozen hits" range, not
   trivial and not absurd. Payout is unchanged in SHAPE (HP x CHEST_WORTH_S,
   still read out of box.max by the existing destroyTile() formula) — just
   driven by these fixed numbers instead of a wave-scaled curve, so a bigger
   tier is still a bigger lump sum for proportionally more hits, same as before. */
const CHEST_TIERS = ['wood', 'iron', 'gold', 'diamond', 'special', 'vip'];
const CHEST_TIER_HP = { wood: 8, iron: 40, gold: 200, diamond: 1000, special: 5000, vip: 25000 };
const CHEST_TIER_ICON = {
  wood: 'bau_madeira', iron: 'bau_ferro', gold: 'bau_ouro',
  diamond: 'bau_diamante', special: 'bau_especial', vip: 'bau_vip',
};
// Wave-gating (gold@5/diamond@15/special@40/vip@80) from the earlier round
// is REMOVED per this pivot's explicit instruction #2 — every tier is now
// eligible starting wave 1, governed purely by rarityLimits' min/max RNG
// below. That gating existed to bound a "lump-sum jackpot lands absurdly
// early relative to wave depth" risk — but wave depth no longer means
// anything (every map is equally hard/rewarding), so "early" isn't a
// meaningful risk category anymore either; the FIXED HP calibration above
// is what actually keeps each tier reasonable now, not a wave gate.

const normalMapSpawnConfig = {
  variableTables: { min: 28, max: 50 },
  chests: { probability: 0.40, proportionalMin: 0.30, proportionalMax: 0.45, absoluteMin: 8, absoluteMax: 20 },
  rarityLimits: {
    wood: { min: 4, max: 12 },
    iron: { min: 2, max: 7 },
    gold: { min: 1, max: 7 },
    diamond: { min: 0, max: 2 },
    special: { min: 0, max: 0 }, // effectively disabled on the normal map
    vip: { min: 0, max: 1 },
  },
};
// "a sala especial" (the user's phrase) — described but with NO trigger
// condition given (a wave milestone? a theme-specific room? unknown).
// Defined as data only, per the coordinator's explicit instruction — this
// is NOT wired to any wave/theme condition anywhere. Flagged in the report;
// needs the user's input on when this should ever become active.
const nightKitchenSpawnConfig = {
  variableTables: { min: 30, max: 50 },
  chests: { probability: 0.40, proportionalMin: 0.35, proportionalMax: 0.48, absoluteMin: 12, absoluteMax: 22 },
  rarityLimits: {
    wood: { min: 3, max: 10 }, iron: { min: 2, max: 7 }, gold: { min: 1, max: 7 },
    special: { min: 1, max: 3 }, diamond: { min: 0, max: 2 }, vip: { min: 0, max: 1 },
  },
};
// live/default config for every wave right now — nightKitchen exists as data
// only (see comment above) and is never assigned here or anywhere else
let ACTIVE_SPAWN_CONFIG = normalMapSpawnConfig;

// Fisher-Yates, exactly as specified — never mutates the input
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Proportional chest-count band (NOT the flat 10-20 clamp — the user
// explicitly preferred this proportional version). Guards against the
// degenerate case where the proportional min could exceed the max when
// variableCount is small, by capping min down to max rather than the
// reverse (max is the harder ceiling — absoluteMax also protects late-game
// boards from becoming ALL chests).
function getChestLimits(variableCount, config = ACTIVE_SPAWN_CONFIG) {
  const min = Math.max(config.chests.absoluteMin, Math.ceil(variableCount * config.chests.proportionalMin));
  const max = Math.min(config.chests.absoluteMax, Math.floor(variableCount * config.chests.proportionalMax));
  return { min: Math.min(min, Math.max(max, 0)), max: Math.max(max, 0) };
}

// Per-tier [min,max] straight from the config's own rarityLimits — no more
// wave-gating layered on top (removed per the philosophy reversal: every
// tier is eligible from wave 1 onward now). The `wave` parameter is kept,
// unused, purely so every existing call site below didn't need touching —
// same "least invasive" approach used for waveMult().
function chestTierLimitsForWave(config, wave) {
  const limits = {};
  for (const t of CHEST_TIERS) {
    limits[t] = config.rarityLimits[t] || { min: 0, max: 0 };
  }
  return limits;
}

// Expected blend of chest tiers — used ONLY by the offline economy
// simulation (simulate()) to estimate average HP/payout per chest without
// actually rolling a real layout. Approximates each tier's expected share
// as the midpoint of its [min,max] band, normalized to sum to 1. No longer
// wave-dependent (the `wave` param is unused, kept for call-site stability).
// The real per-wave roll always uses rollChestTierCounts() instead; this is
// deliberately a cheaper estimate.
function expectedChestTierWeights(config, wave) {
  const limits = chestTierLimitsForWave(config, wave);
  const weights = {};
  let total = 0;
  for (const t of CHEST_TIERS) {
    const w = (limits[t].min + limits[t].max) / 2;
    weights[t] = w;
    total += w;
  }
  if (total <= 0) return { wood: 1 }; // degenerate fallback, should not happen with real configs
  for (const t of CHEST_TIERS) weights[t] /= total;
  return weights;
}

// Distributes `chestCount` chests across CHEST_TIERS respecting each tier's
// [min,max] (no longer wave-gated): first guarantees every tier's minimum
// (capped so the total never exceeds chestCount), then fills the remainder
// randomly among tiers that still have room. Returns counts summing to
// exactly chestCount (a `wood` overflow fallback absorbs the astronomically
// unlikely case where every tier hits its max before the remainder runs out).
function rollChestTierCounts(chestCount, config = ACTIVE_SPAWN_CONFIG, wave = state.wave) {
  const limits = chestTierLimitsForWave(config, wave);
  const counts = {};
  for (const t of CHEST_TIERS) counts[t] = 0;
  let assigned = 0;
  for (const t of CHEST_TIERS) {
    const want = Math.max(0, Math.min(limits[t].min, chestCount - assigned));
    counts[t] = want;
    assigned += want;
  }
  let remaining = chestCount - assigned;
  let guard = remaining * 20 + 50;
  while (remaining > 0 && guard-- > 0) {
    const eligible = CHEST_TIERS.filter(t => counts[t] < limits[t].max);
    if (!eligible.length) break;
    counts[pick(eligible)]++;
    remaining--;
  }
  if (remaining > 0) counts.wood += remaining; // safety fallback, should not normally trigger
  return counts;
}

let bombs = [];
let actors = {};

// Permanently neutralized to 1 (chose this over deleting the function and
// every call site — the coordinator offered both options and this is the
// less invasive one). Reward payouts no longer scale with wave number at
// all, per the "waves are equal in difficulty/reward forever" pivot — every
// call site (destroyTile()'s payout formula, simulate()'s offline economy,
// the wave-clear toast) still multiplies by this on purpose, so the
// no-longer-scaling behavior is self-documenting at each call site rather
// than silently missing a factor. The `wave` parameter is kept, unused, so
// no call site needed touching.
function waveMult(wave = state.wave) {
  return 1;
}

function workingCount() {
  return state.heroes.filter(h => h.mode === 'work').length;
}

// Deterministic table placement — NO randomness, identical across every wave,
// every save, and every theme (only the visual background/border/floor
// texture differs per theme; table POSITIONS never do). The outer border
// ring (row 0, row G_ROWS-1, col 0, col G_COLS-1) is ALWAYS empty/walkable —
// no table may ever touch it. Produces exactly 136 tables on the 35x17 grid
// (8 table-rows x 17 tables/row), each isolated by >=1 empty tile on every
// side purely as a consequence of the row%2/col%2 formula — no separate
// spacing logic needed or wanted.
function isTableCell(row, col) {
  const isBorder = row === 0 || row === G_ROWS - 1 || col === 0 || col === G_COLS - 1;
  if (isBorder) return false;
  return row % 2 === 1 && col % 2 === 1;
}

function tileAt(r, c) {
  return gridTiles[r] ? gridTiles[r][c] : undefined;
}

function tileClassFor(val) {
  if (val === T_WALL) return 'wall';
  if (val === T_FLOOR) return 'floor';
  if (val === T_CHEST) return 'chest';
  if (val === T_JAIL) return 'jail';
  if (val === T_OBSTACLE) return 'obstacle';
  return 'crate';
}

// Single source of truth for a tile PROP's className (the .tile-prop overlay
// element that carries the actual wall/obstacle/chest/jail art + HP bar —
// see setTile() below), INCLUDING the chest-<tier> modifier (chest-wood/
// iron/gold/diamond/special/vip) when applicable — so CSS can show the right
// bau_*.png per tier (see tileHp[key].tier). Used by BOTH setTile() (first
// placement) and updateHpBar() (every non-lethal hit) so they can never
// drift apart again: this exact bug already happened twice — jail tiles
// losing their lock icon on hit, then chest tiers losing their tier art on
// hit — both times because the two call sites built their own className
// string independently instead of sharing this logic.
function classNameForProp(r, c, val) {
  const box = tileHp[r + ',' + c];
  const tierClass = (val === T_CHEST && box && box.tier) ? ' chest-' + box.tier : '';
  return 'tile-prop ' + tileClassFor(val) + tierClass;
}

// The grid cell div (tileEls[r][c]) ALWAYS renders as the plain floor look —
// wall/obstacle/chest/jail art (and the HP bar) lives in a SEPARATE
// .tile-prop overlay CHILD instead of on the cell div's own background.
// This replaces the earlier "give the tile div itself background-size:
// cover" fix: that CSS was textually correct (no more-specific selector or
// inline JS style was overriding it — checked directly), yet wall tiles
// rendered full-bleed correctly while chest tiles still showed as a small
// image in a dark box from the exact same treatment, on the SAME cell div,
// in the SAME stylesheet edit. Rather than keep chasing why one class
// combination on a shared, multi-purpose div painted differently from
// another, giving each prop its own dedicated, single-purpose element (the
// same pattern .actor already uses successfully) removes the whole
// conflict-prone setup structurally instead of patching around it again.
function setTile(r, c, val) {
  gridTiles[r][c] = val;
  const el = tileEls[r] && tileEls[r][c];
  if (!el) return;
  el.className = 'tile floor';
  el.innerHTML = ''; // clears any previous .tile-prop child (real DOM: setting innerHTML always drops children)
  if (val === T_FLOOR) return;
  // a brand-new element every time (not reused/mutated) — built via
  // createElement/appendChild (not an innerHTML string) so it's a REAL
  // child element, matching how .actor is already built, and letting
  // updateHpBar() below reach back into it via el.firstElementChild.
  const prop = document.createElement('div');
  prop.className = classNameForProp(r, c, val);
  // explicit reset (not just relying on the property being unset on a
  // fresh element) so --dmg reads as a real, present "0" rather than an
  // absent custom property some environments could resolve differently
  if (isDestructible(val)) { prop.style.setProperty('--dmg', '0'); prop.innerHTML = hpBarHtml(r, c); }
  el.appendChild(prop);
}

// green >= 50% (fresh bars start green), orange below 50%, red below 30%
function hpBarColor(frac) {
  if (frac < 0.3) return 'r';
  if (frac < 0.5) return 'o';
  return 'g';
}

function hpBarHtml(r, c) {
  const box = tileHp[r + ',' + c];
  if (!box) return '';
  const frac = Math.max(0, box.hp / box.max);
  // width floor keeps the sliver visible even on 24px tiles
  return `<div class="chp"><div class="chp-fill hp-${hpBarColor(frac)}" style="width:${Math.max(5, Math.round(frac * 100))}%"></div></div>`;
}

function genLayout() {
  gridTiles = [];
  for (let r = 0; r < G_ROWS; r++) {
    const row = [];
    for (let c = 0; c < G_COLS; c++) row.push(isTableCell(r, c) ? T_WALL : T_FLOOR);
    gridTiles.push(row);
  }
  seedCrates();
}

// Generalized to also treat T_OBSTACLE as blocking (not just T_WALL) — an
// obstacle is indestructible, so unlike a crate/chest it never "eventually"
// opens up; if it seals off a region, that region is unreachable for the
// whole wave. This is the exact same BFS the old wave-density system used,
// reused as-is for the new variable-generation flow's connectivity check.
// Flat-index BFS (Uint8Array + integer row*G_COLS+col indices) instead of a
// Set keyed by string-concatenated coordinates — this runs on EVERY attempt
// of every wave's variable-layout generation (see seedCrates()'s retry
// loop), and is also hammered directly by Monte Carlo tests (hundreds of
// thousands of genLayout() calls), so the string-key/Set overhead was a real
// hot-path cost worth avoiding. Same DFS-via-stack traversal, same return
// semantics as before — only the internal bookkeeping changed.
function floorsConnected() {
  let startIdx = -1, floorCount = 0;
  for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
    if (!isBlockingObstacle(gridTiles[r][c])) {
      floorCount++;
      if (startIdx < 0) startIdx = r * G_COLS + c;
    }
  }
  if (!floorCount) return false;
  const seen = new Uint8Array(G_ROWS * G_COLS);
  seen[startIdx] = 1;
  let seenCount = 1;
  const queue = [startIdx];
  while (queue.length) {
    const idx = queue.pop();
    const r = (idx / G_COLS) | 0, c = idx % G_COLS;
    for (const [dr, dc] of DIRS) {
      const rr = r + dr, cc = c + dc;
      if (rr < 0 || rr >= G_ROWS || cc < 0 || cc >= G_COLS) continue;
      const nIdx = rr * G_COLS + cc;
      if (!seen[nIdx] && !isBlockingObstacle(gridTiles[rr][cc])) {
        seen[nIdx] = 1;
        seenCount++;
        queue.push(nIdx);
      }
    }
  }
  return seenCount === floorCount;
}

// New per-wave variable generation, replacing the old per-tile-independent
// crate/chest DENSITY roll entirely (see the "Chest tiers" section above for
// why: every rewarding destructible is a tiered chest now, wood being the
// unchanged baseline). genLayout() has already laid down the 136 fixed
// tables before this runs. Implements steps 4-11 of the spec: collect
// VARIABLE_ELIGIBLE cells (open floor, excluding whatever a live hero is
// currently standing on — the SPAWN-protection rule, reusing the same
// "occupied" pattern the old system used), roll+clamp a variable-table
// count, shuffle and select that many, split them 40% chest / 60% obstacle,
// correct the chest count into its proportional band, roll each chest's
// tier, then validate connectivity and retry on failure (same BFS/retry
// pattern used elsewhere in this file).
const VARIABLE_LAYOUT_MAX_RETRIES = 15;

function seedCrates() {
  const config = ACTIVE_SPAWN_CONFIG;
  const occupied = new Set(Object.values(actors).map(a => a.r + ',' + a.c));
  const baseFloors = [];
  for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
    if (gridTiles[r][c] !== T_WALL) baseFloors.push([r, c]);
  }

  // hoisted out of the retry loop — occupied/baseFloors never change between
  // attempts within one seedCrates() call, only the random selection does
  const eligible = baseFloors.filter(([r, c]) => !occupied.has(r + ',' + c));
  let chestTierAssignment = [];
  let succeeded = false;

  for (let attempt = 0; attempt < VARIABLE_LAYOUT_MAX_RETRIES && !succeeded; attempt++) {
    // reset to the clean fixed-table skeleton before every attempt — a
    // failed candidate's obstacles/chests must not leak into the next retry
    for (const [r, c] of baseFloors) gridTiles[r][c] = T_FLOOR;

    const requested = randInt(config.variableTables.min, config.variableTables.max);
    const variableCount = Math.min(requested, eligible.length);
    const selected = shuffle(eligible).slice(0, variableCount);

    let candidateChests = [], candidateObstacles = [];
    for (const pos of selected) {
      if (Math.random() < config.chests.probability) candidateChests.push(pos);
      else candidateObstacles.push(pos);
    }
    const { min: chestMin, max: chestMax } = getChestLimits(variableCount, config);
    if (candidateChests.length < chestMin) {
      const need = Math.min(chestMin - candidateChests.length, candidateObstacles.length);
      for (let i = 0; i < need; i++) candidateChests.push(candidateObstacles.pop());
    } else if (candidateChests.length > chestMax) {
      const excess = candidateChests.length - chestMax;
      for (let i = 0; i < excess; i++) candidateObstacles.push(candidateChests.pop());
    }

    const tierCounts = rollChestTierCounts(candidateChests.length, config, state.wave);
    const tierPool = [];
    for (const t of CHEST_TIERS) for (let i = 0; i < tierCounts[t]; i++) tierPool.push(t);
    const shuffledTiers = shuffle(tierPool);
    const candidateAssignment = candidateChests.map(([r, c], i) => [r, c, shuffledTiers[i] || 'wood']);

    for (const [r, c] of candidateObstacles) gridTiles[r][c] = T_OBSTACLE;
    for (const [r, c] of candidateAssignment) gridTiles[r][c] = T_CHEST;

    if (floorsConnected()) {
      chestTierAssignment = candidateAssignment;
      succeeded = true;
    }
  }
  // Exhausted retries — extremely unlikely (136 fixed tables + at most 50
  // variable cells out of 595 leaves hundreds of open floor cells untouched
  // every time), but rather than ship a possibly-broken board, fall back to
  // NO variable content this wave (fixed tables only — always connected by
  // construction, since that's the exact layout every wave already starts
  // from before any variable content is added).
  if (!succeeded) {
    for (const [r, c] of baseFloors) gridTiles[r][c] = T_FLOOR;
    chestTierAssignment = [];
  }

  // Once-per-wave jail pity roll: at most one jail per map, and it can only
  // ever replace a CHEST slot (never an obstacle, which was never a reward
  // to begin with) — same map-level decision as before the grid resize.
  // Captured BEFORE the possible splice below: jail replaces a chest 1-for-1,
  // so the total "things to clear this wave" never changes either way.
  cratesLeft = chestTierAssignment.length;
  if (chestTierAssignment.length && Math.random() < jailPityChance()) {
    const idx = randInt(0, chestTierAssignment.length - 1);
    const [jr, jc] = chestTierAssignment.splice(idx, 1)[0];
    gridTiles[jr][jc] = T_JAIL;
    state.wavesSinceJail = 0;
  } else {
    state.wavesSinceJail++;
  }
  cratesTotal = cratesLeft;

  tileHp = {};
  for (const [r, c, tier] of chestTierAssignment) {
    const maxHp = CHEST_TIER_HP[tier];
    tileHp[r + ',' + c] = { hp: maxHp, max: maxHp, chest: true, jail: false, tier };
  }
  // jail's HP is a fixed constant now (JAIL_HP) — "a rescue, not a boss
  // fight" — independent of chest tiers, same as before this pivot
  if (gridTiles.some(row => row.includes(T_JAIL))) {
    for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
      if (gridTiles[r][c] === T_JAIL) tileHp[r + ',' + c] = { hp: JAIL_HP, max: JAIL_HP, chest: false, jail: true };
    }
  }
}

function applyTileClasses() {
  for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) setTile(r, c, gridTiles[r][c]);
}

function buildArena() {
  const arena = document.getElementById('arena');
  arena.innerHTML = '';
  tileEls = [];
  for (let r = 0; r < G_ROWS; r++) {
    const rowEls = [];
    for (let c = 0; c < G_COLS; c++) {
      const d = document.createElement('div');
      arena.appendChild(d);
      rowEls.push(d);
    }
    tileEls.push(rowEls);
  }
  applyTileClasses();
  layoutArena();
}

// fit the whole grid to the available container, then re-place everything in px
function layoutArena() {
  const wrap = document.getElementById('arena-wrap');
  const availW = (wrap && wrap.clientWidth) || 660;
  const availH = (wrap && wrap.clientHeight) || 480;
  tileSize = Math.max(24, Math.min(80, Math.floor(Math.min(availW / G_COLS, availH / G_ROWS))));
  const arena = document.getElementById('arena');
  arena.style.width = G_COLS * tileSize + 'px';
  arena.style.height = G_ROWS * tileSize + 'px';
  arena.style.setProperty('--ts', tileSize + 'px');
  for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
    const el = tileEls[r] && tileEls[r][c];
    if (el) {
      el.style.left = c * tileSize + 'px';
      el.style.top = r * tileSize + 'px';
    }
  }
  for (const id of Object.keys(actors)) positionActor(actors[id].el, actors[id].c, actors[id].r);
  for (const b of bombs) positionBomb(b);
}

function openFloors() {
  const out = [];
  for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
    if (gridTiles[r][c] === T_FLOOR) out.push([r, c]);
  }
  return out;
}

// .actor is sized to the full tile (see CSS) and centers its .sprite child
// via flexbox, so this just places the tile's top-left corner — no
// fractional-offset math needed, and no risk of the axes drifting out of
// sync the way the old hand-tuned translate offsets did.
function positionActor(el, c, r) {
  el.style.transform = `translate(${c * tileSize}px, ${r * tileSize}px)`;
}

function positionBomb(b) {
  b.el.style.left = Math.round(b.c * tileSize + tileSize * 0.2) + 'px';
  b.el.style.top = Math.round(b.r * tileSize + tileSize * 0.2) + 'px';
}

function addActor(h) {
  if (actors[h.id]) return;
  const spots = openFloors();
  if (!spots.length) return;
  const [r, c] = pick(spots);
  const el = document.createElement('div');
  el.className = 'actor';
  el.innerHTML = spriteHtml(h);
  positionActor(el, c, r);
  document.getElementById('arena').appendChild(el);
  actors[h.id] = { c, r, cd: 0, el };
}

function removeActor(id) {
  const a = actors[id];
  if (a) { a.el.remove(); delete actors[id]; }
}

function syncActors() {
  for (const h of state.heroes) {
    if (h.mode === 'work' && h.energy > 0) addActor(h);
    else removeActor(h.id);
  }
  for (const id of Object.keys(actors)) {
    if (!state.heroes.some(h => h.id === Number(id))) removeActor(id);
  }
}

function blastRadius(h) {
  const base = Math.min(4, Math.ceil(h.range / 2) + Math.floor((h.level - 1) / 5));
  // the global Blast Expansion upgrade adds on top, uncapped by the per-hero
  // cap — but only every OTHER level, so it's half as fast as it looks
  return base + (state.upgrades ? Math.floor(state.upgrades.blast / 2) : 0);
}

function cooldownTicks(h) {
  const base = Math.max(2, 4 - Math.floor((h.level - 1) / 3));
  const hasteMult = state.upgrades ? Math.pow(0.97, state.upgrades.haste) : 1;
  return Math.max(1, Math.round(base * hasteMult));
}

function bombAt(r, c) {
  return bombs.some(b => b.r === r && b.c === c);
}

function nearestCrateDist(r, c) {
  let best = Infinity;
  for (let rr = 0; rr < G_ROWS; rr++) for (let cc = 0; cc < G_COLS; cc++) {
    if (isDestructible(gridTiles[rr][cc])) {
      const d = Math.abs(rr - r) + Math.abs(cc - c);
      if (d < best) best = d;
    }
  }
  return best;
}

function plantBomb(h, a) {
  const el = document.createElement('div');
  el.className = 'bomb';
  const b = { r: a.r, c: a.c, t: FUSE_TICKS, radius: blastRadius(h), rate: mineRate(h), midas: hasMidas(h), cata: hasCata(h), el };
  positionBomb(b);
  document.getElementById('arena').appendChild(el);
  bombs.push(b);
  a.cd = cooldownTicks(h);
}

function canWalk(h, r, c) {
  const t = tileAt(r, c);
  if (t === undefined) return false;
  // ghosts phase through tables/crates entirely — with the border ring now
  // guaranteed walkable EMPTY for everyone (isTableCell() never places a
  // table there), there's no obstacle type left for ghosts to need a special
  // exception for, so they can go anywhere within the grid's bounds
  if (h && h.ghost) return true;
  return t === T_FLOOR && !bombAt(r, c);
}

function moveActor(a, h) {
  const open = [];
  for (const [dr, dc] of DIRS) {
    const r = a.r + dr, c = a.c + dc;
    if (canWalk(h, r, c)) open.push([r, c]);
  }
  if (!open.length) return;
  let dest = pick(open);
  // greedy walk toward the nearest crate, with some noise so bombers don't stall
  if (Math.random() > 0.25) {
    let best = Infinity;
    for (const [r, c] of open) {
      const d = nearestCrateDist(r, c);
      if (d < best) { best = d; dest = [r, c]; }
    }
  }
  a.r = dest[0];
  a.c = dest[1];
  positionActor(a.el, a.c, a.r);
}

function aiTick() {
  for (const idStr of Object.keys(actors)) {
    const id = Number(idStr);
    const h = state.heroes.find(x => x.id === id);
    if (!h || h.mode !== 'work') { removeActor(id); continue; }
    const a = actors[id];
    if (a.cd > 0) a.cd--;
    // re-check plantability between every sub-step: a Swift hero would
    // otherwise walk onto and straight past a plantable tile in one tick
    const steps = h.swift ? 2 : 1;
    for (let i = 0; i < steps; i++) {
      const nearCrate = isDestructible(tileAt(a.r, a.c)) ||
        DIRS.some(([dr, dc]) => isDestructible(tileAt(a.r + dr, a.c + dc)));
      if (nearCrate && a.cd === 0 && !bombAt(a.r, a.c) && !waveRegen) {
        plantBomb(h, a);
        break;
      }
      moveActor(a, h);
    }
  }
  for (const b of [...bombs]) {
    b.t--;
    if (b.t <= 0) explode(b);
  }
}

function explode(b) {
  const i = bombs.indexOf(b);
  if (i < 0) return;
  bombs.splice(i, 1);
  b.el.remove();
  boomAt(b.r, b.c);
  // a ghost can plant while standing on a crate tile, so the center may hold one
  hitTile(b.r, b.c, b);
  for (const [dr, dc] of DIRS) {
    for (let s = 1; s <= b.radius; s++) {
      const r = b.r + dr * s, c = b.c + dc * s;
      const t = tileAt(r, c);
      // blast stops at anything blocking — the 136 fixed tables AND this
      // wave's randomly-placed indestructible obstacles, same treatment
      if (t === undefined || isBlockingObstacle(t)) break;
      boomAt(r, c);
      const chained = bombs.find(x => x.r === r && x.c === c);
      if (chained) explode(chained);
      if (isDestructible(t)) { hitTile(r, c, b); break; }
    }
  }
  // Cataclysm (Robadasso-exclusive): each blast chains to a few random other
  // destructibles anywhere on the board — normal hit damage, bounded fan-out
  if (b.cata) {
    const targets = Object.keys(tileHp);
    for (let i = 0; i < CATA_CHAIN && targets.length; i++) {
      const key = targets.splice(randInt(0, targets.length - 1), 1)[0];
      const [r, c] = key.split(',').map(Number);
      boomAt(r, c);
      const crit = rollCrit();
      damageTile(r, c, b.rate * crit.mult, false, crit.isCrit);
    }
  }
}

// Crit is EV-neutral by construction: p*CRIT_MULT + (1-p)*CRIT_NORMAL_MULT = 1,
// so adding variance here doesn't quietly re-inflate the rebalanced power curve
function rollCrit() {
  const isCrit = Math.random() < CRIT_CHANCE;
  return { isCrit, mult: isCrit ? CRIT_MULT : CRIT_NORMAL_MULT };
}

// uniform on [1-v, 1+v] — symmetric, so the long-run average payout is
// unchanged from the old deterministic formula
function payoutVarianceMult() {
  return 1 + (Math.random() * 2 - 1) * PAYOUT_VARIANCE;
}

function hitTile(r, c, b) {
  if (isDestructible(tileAt(r, c))) {
    const crit = rollCrit();
    damageTile(r, c, b.rate * crit.mult, b.midas, crit.isCrit);
  }
}

function damageTile(r, c, dmg, midasBomb, isCrit) {
  const key = r + ',' + c;
  const box = tileHp[key];
  if (!box) return;
  box.hp -= dmg;
  if (box.hp > 0.0001) {
    updateHpBar(r, c);
    floatLabel(r, c, (isCrit ? '💥 CRIT -' : '-') + (dmg >= 10 ? fmt(dmg) : dmg.toFixed(1)), false, isCrit);
    return;
  }
  destroyTile(r, c, box, midasBomb);
}

function destroyTile(r, c, box, midasBomb) {
  delete tileHp[r + ',' + c];
  setTile(r, c, T_FLOOR);

  // Jail is a rescue, not a payout: it grants exactly one new hero instead
  // of Food Coins (no skill-shard roll either — the hero IS the whole reward)
  if (box.jail) {
    const rarity = rollRarity(jailOddsForWave());
    const freed = makeHero(rarity);
    state.heroes.push(freed);
    floatLabel(r, c, '🔓 ' + rLabel(rarity) + '!', true);
    cratesLeft = Math.max(0, cratesLeft - 1);
    save();
    renderHeader();
    renderInventory();
    startJailReveal(freed);
    if (cratesLeft === 0 && !waveRegen) waveClear();
    return;
  }

  // payout scales with the wall; Midas bombs skim a bounded bonus on top;
  // a small symmetric variance roll keeps the AVERAGE identical but stops
  // every single break from reading like an exact spreadsheet number
  const amt = box.max * (box.chest ? CHEST_WORTH_S : CRATE_WORTH_S) * waveMult() * (midasBomb ? MIDAS_BONUS : 1) * payoutVarianceMult();
  state.starCore += amt;
  state.totalMined += amt;
  floatLabel(r, c, (box.chest ? '💰 +' : '+') + (amt >= 10 ? fmt(amt) : amt.toFixed(1)), box.chest);
  cratesLeft = Math.max(0, cratesLeft - 1);
  // rare material drop, independent of and additional to the Food Coins payout
  if (Math.random() < (box.chest ? SKILL_SHARD_CHEST_CHANCE : SKILL_SHARD_CRATE_CHANCE)) {
    state.skillShards = (state.skillShards || 0) + 1;
    floatLabel(r, c, '🔮 +1', true);
  }
  if (cratesLeft === 0 && !waveRegen) waveClear();
}

function updateHpBar(r, c) {
  const el = tileEls[r] && tileEls[r][c];
  const box = tileHp[r + ',' + c];
  if (!el || !box) return;
  // the .tile-prop overlay child carries the art/HP bar now — the outer
  // tile div (el) itself always stays 'tile floor' (see setTile()). Every
  // real destructible already has one by the time damageTile() can run
  // (setTile()/applyTileClasses() always runs first) — this just self-heals
  // rather than silently no-op'ing in case anything ever calls this against
  // tileHp/gridTiles state that bypassed setTile().
  let prop = el.firstElementChild;
  if (!prop) {
    prop = document.createElement('div');
    el.appendChild(prop);
  }
  // damage reads as a subtle darken/desaturate on the tile artwork rather
  // than swapping to a differently-colored CSS shape (that trick doesn't
  // apply to a raster image) — 0 at full HP, up to 1 near death
  const dmgFrac = Math.min(1, Math.max(0, 1 - box.hp / box.max));
  prop.className = classNameForProp(r, c, tileAt(r, c));
  prop.style.setProperty('--dmg', dmgFrac.toFixed(3));
  prop.innerHTML = hpBarHtml(r, c);
}

function waveClear() {
  waveRegen = true;
  for (const b of bombs) b.el.remove();
  bombs = [];
  // "tougher field, xN rewards" is no longer true — every map is equally
  // difficult and equally rewarding forever now (a wave is just a fresh RNG
  // reroll of the variable tables/chests), so the old toast actively lied
  // about escalating difficulty/reward. Just announces the reroll now.
  toast(`💥 Map ${state.wave} cleared! Rolling a fresh map...`);
  setTimeout(() => {
    state.wave++;
    // Theme rotation: every 50 cleared maps, advance ACTIVE theme to the
    // next id in THEME_ROTATION (wrapping back to the first after the
    // last), reset the counter, and re-apply. With only one theme
    // registered today this just loops back to itself every 50 maps —
    // expected, not a bug (see THEME_ROTATION's comment).
    state.mapsInTheme = (state.mapsInTheme || 0) + 1;
    if (state.mapsInTheme >= 50) {
      state.mapsInTheme = 0;
      const idx = THEME_ROTATION.indexOf(state.activeThemeId);
      state.activeThemeId = THEME_ROTATION[(idx + 1) % THEME_ROTATION.length];
      applyTheme(state.activeThemeId);
    }
    genLayout();
    applyTileClasses();
    repositionActors();
    waveRegen = false;
    save();
  }, 2000);
}

// wave walls can appear under a standing hero; shove them onto open floor
function repositionActors() {
  for (const id of Object.keys(actors)) {
    const a = actors[id];
    const h = state.heroes.find(x => x.id === Number(id));
    if (h && h.ghost) continue;
    if (tileAt(a.r, a.c) !== T_FLOOR) {
      const spots = openFloors();
      if (!spots.length) continue;
      const [r, c] = pick(spots);
      a.r = r;
      a.c = c;
      positionActor(a.el, c, r);
    }
  }
}

function boomAt(r, c) {
  const arena = document.getElementById('arena');
  const el = document.createElement('div');
  el.className = 'boom';
  el.style.left = c * tileSize + 'px';
  el.style.top = r * tileSize + 'px';
  arena.appendChild(el);
  setTimeout(() => el.remove(), 420);
}

function floatLabel(r, c, text, big, crit) {
  const arena = document.getElementById('arena');
  const el = document.createElement('div');
  el.className = 'float-label' + (big ? ' chest' : '') + (crit ? ' crit' : '');
  el.textContent = text;
  el.style.left = Math.round(c * tileSize + tileSize * 0.08) + 'px';
  el.style.top = Math.round(r * tileSize + tileSize * 0.2) + 'px';
  arena.appendChild(el);
  setTimeout(() => el.remove(), 1150);
}

/* ============ Actions ============ */

function toggleMode(id) {
  const h = state.heroes.find(x => x.id === id);
  if (!h) return;
  if (h.mode === 'rest') {
    if (h.energy < 1) {
      toast('This hero has no energy — let them rest first.');
      return;
    }
    if (workingCount() >= MAX_WORKERS) {
      toast(`Max ${MAX_WORKERS} heroes can work at once.`);
      return;
    }
  }
  h.mode = h.mode === 'work' ? 'rest' : 'work';
  syncActors();
  save();
  renderInventory();
  renderHunt();
}

function levelUp(id) {
  const h = state.heroes.find(x => x.id === id);
  if (!h || h.level >= MAX_LEVEL) return;
  const cost = levelCost(h);
  if (state.starCore < cost) {
    toast(`Need ${fmt(cost)} Food Coins to level up.`);
    return;
  }
  state.starCore -= cost;
  h.level++;
  save();
  toast(`${h.emoji} ${h.name} reached level ${h.level}!`);
  renderHeader();
  renderInventory();
}

function buyPack(idx) {
  const pack = PACKS[idx];
  if (state.bcoin < pack.cost) {
    toast(`Not enough Chef Gems — need ${fmt(pack.cost)}.`);
    return;
  }
  state.bcoin -= pack.cost;
  const pulled = [];
  for (let i = 0; i < pack.size; i++) {
    const hero = makeHero(rollRarity(pack.odds));
    state.heroes.push(hero);
    pulled.push(hero);
  }
  save();
  renderHeader();
  renderShop();
  startPackReveal(pulled);
}

function buyHouse(id) {
  const house = HOUSES.find(h => h.id === id);
  if (state.bcoin < house.cost) {
    toast(`Not enough Chef Gems — need ${fmt(house.cost)}.`);
    return;
  }
  state.bcoin -= house.cost;
  state.houses[id]++;
  save();
  toast(`${house.emoji} ${house.name} built! Recovery is now ${recoveryRate().toFixed(2)} energy/s.`);
  renderHeader();
  renderShop();
}

function exchange() {
  const whole = Math.floor(state.starCore / EXCHANGE_RATE);
  if (whole < 1) {
    toast(`Need at least ${EXCHANGE_RATE} Food Coins to exchange.`);
    return;
  }
  state.starCore -= whole * EXCHANGE_RATE;
  state.bcoin += whole;
  save();
  toast(`Exchanged ${fmt(whole * EXCHANGE_RATE)} Food Coins → ${fmt(whole)} Chef Gems`);
  renderHeader();
}

function toggleFusionSelect(id) {
  const h = state.heroes.find(x => x.id === id);
  if (!h || !FUSABLE.includes(h.rarity)) return;
  const i = selectedFusion.indexOf(id);
  if (i >= 0) {
    selectedFusion.splice(i, 1);
  } else {
    if (selectedFusion.length > 0) {
      const first = state.heroes.find(x => x.id === selectedFusion[0]);
      if (first && first.rarity !== h.rarity) {
        toast(`All ${FUSE_COST} heroes must share the same rarity.`);
        return;
      }
    }
    if (selectedFusion.length >= FUSE_COST) return;
    selectedFusion.push(id);
  }
  renderFusion();
}

// consumes the whole group, rolls success/bonus, and always returns a hero:
// target tier on success (sometimes +2), a fresh same-rarity consolation on failure
function fuseGroup(group) {
  const src = group[0].rarity;
  const ids = group.map(h => h.id);
  state.heroes = state.heroes.filter(h => !ids.includes(h.id));
  state.fusions++;
  const srcIdx = RARITIES.indexOf(src);
  const success = Math.random() < FUSE_SUCCESS_CHANCE[src];
  let targetIdx = srcIdx;
  if (success) {
    const jump = Math.random() < FUSE_BONUS_JUMP ? 2 : 1;
    targetIdx = Math.min(RARITIES.length - 1, srcIdx + jump);
  }
  const hero = makeHero(RARITIES[targetIdx]);
  state.heroes.push(hero);
  return { hero, success, bonus: success && targetIdx === srcIdx + 2, src };
}

// lowest level (then lowest power) first, so auto-fuse never eats invested heroes
function lowestLevelGroup(rarity) {
  return state.heroes
    .filter(h => h.rarity === rarity)
    .sort((a, b) => a.level - b.level || a.power - b.power)
    .slice(0, FUSE_COST);
}

function autoFuse(rarity, maxMode) {
  if (!FUSABLE.includes(rarity)) return;
  const results = [];
  // re-check the pool every attempt: a failed attempt returns 1 same-rarity
  // hero, so the remaining count can't be predicted up front
  do {
    const group = lowestLevelGroup(rarity);
    if (group.length < FUSE_COST) break;
    results.push(fuseGroup(group));
  } while (maxMode);
  if (!results.length) return;
  selectedFusion = [];
  syncActors();
  save();
  renderHeader();
  renderFusion();
  showFusionResults(results, rarity);
}

function fuse() {
  if (selectedFusion.length !== FUSE_COST) return;
  const chosen = state.heroes.filter(h => selectedFusion.includes(h.id));
  if (chosen.length !== FUSE_COST) { selectedFusion = []; renderFusion(); return; }
  const rarity = chosen[0].rarity;
  if (!chosen.every(h => h.rarity === rarity) || !FUSABLE.includes(rarity)) return;

  const res = fuseGroup(chosen);
  selectedFusion = [];
  syncActors();
  save();
  renderFusion();
  renderHeader();
  showFusionResults([res], rarity);
}

function showFusionResults(results, src) {
  const succ = results.filter(x => x.success);
  let title;
  if (results.length === 1) {
    const r = results[0];
    title = r.success
      ? `⚗️ SUCCESS! ${FUSE_COST}× ${rLabel(src)} → 1× ${rLabel(r.hero.rarity)}${r.bonus ? ' — ⚡ BONUS +2 JUMP!' : ''}`
      : `⚗️ Fusion failed — the cores collapsed into a fresh ${rLabel(src)}.`;
  } else {
    title = `⚗️ ${results.length} fusion attempts: ${succ.length} succeeded, ${results.length - succ.length} failed`;
  }
  document.getElementById('modal-body').innerHTML = `
    <h3>${title}</h3>
    <div class="pull-list">
      ${results.map(x => `
        <div class="pull-item r-${x.hero.rarity} ${x.success ? '' : 'fuse-fail'}">
          <span class="hero-emoji" style="font-size:2.2rem">${spriteHtml(x.hero)}</span>
          <div><b>${x.hero.name}</b></div>
          <span class="rarity-badge rarity-${x.hero.rarity}">${rLabel(x.hero.rarity)}</span>
          <div class="muted">${x.success ? (x.bonus ? '⚡ +2 jump!' : '✅ upgraded') : '❌ failed'}</div>
        </div>`).join('')}
    </div>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
  const best = succ.map(x => x.hero).sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity))[0];
  if (best && isCelebrated(best)) playCelebration(best);
  if (results.length === 1 && !results[0].success) {
    toast(`Fusion failed — ${FUSE_COST} heroes became 1 fresh ${rLabel(src)}.`);
  } else if (results.length > 1) {
    toast(`⚗️ ${succ.length}/${results.length} fusions succeeded.`);
  }
}

function setAllModes(mode) {
  let changed = 0, tired = 0, capped = 0;
  if (mode === 'rest') {
    for (const h of state.heroes) {
      if (h.mode !== 'rest') { h.mode = 'rest'; changed++; }
    }
  } else {
    let slots = MAX_WORKERS - workingCount();
    // strongest first, so the cap fields the best available squad
    const idle = state.heroes.filter(h => h.mode !== 'work').sort((a, b) => b.power - a.power);
    for (const h of idle) {
      if (h.energy < 1) { tired++; continue; }
      if (slots <= 0) { capped++; continue; }
      h.mode = 'work';
      changed++;
      slots--;
    }
  }
  syncActors();
  save();
  renderHeader();
  renderInventory();
  renderHunt();
  const parts = [];
  if (tired) parts.push(`${tired} too tired`);
  if (capped) parts.push(`${capped} over the ${MAX_WORKERS}-worker cap`);
  toast(mode === 'work'
    ? `⛏️ ${changed} hero${changed === 1 ? '' : 'es'} sent to work${parts.length ? ` (${parts.join(', ')})` : ''}`
    : `😴 ${changed} hero${changed === 1 ? '' : 'es'} sent to rest`);
}

function claimTask(id) {
  const task = TASKS.find(t => t.id === id);
  if (!task || state.tasksClaimed.includes(id) || !task.check(state)) return;
  state.tasksClaimed.push(id);
  state.starCore += task.reward;
  state.totalMined += task.reward;
  save();
  toast(`Task complete! +${fmt(task.reward)} Food Coins`);
  renderHeader();
  renderTasks();
}

/* ============ Etapa 2: meta-progression ============ */

function toggleSleepMode() {
  state.sleepMode = !state.sleepMode;
  save();
  renderHeader();
  toast(state.sleepMode
    ? '💤 Sleep Mode ON — offline progress will apply next time you return, at 15% of your active earn rate.'
    : '🌙 Sleep Mode OFF — no offline catch-up; progress resumes exactly where you left it.');
}

// ---- Prestige ----

function prestigeContribution(waveAtReset, prestigeIndex) {
  return Math.sqrt(Math.max(1, waveAtReset)) / (1 + prestigeIndex * PRESTIGE_DECAY);
}

function prestigePreview() {
  const gain = prestigeContribution(state.wave, state.prestigeCount);
  const curMult = prestigeMult();
  const nextMult = 1 + (state.prestigePoints + gain) * PRESTIGE_POINT_VALUE;
  return { gain, curMult, nextMult };
}

function doPrestige() {
  if (state.wave < 2) {
    toast('Reach at least wave 2 before prestiging.');
    return false;
  }
  const { gain, nextMult } = prestigePreview();
  state.prestigePoints += gain;
  state.prestigeCount++;
  state.wave = 1;
  state.starCore = 0;
  state.bcoin = defaultState().bcoin;
  state.heroes.forEach(h => { h.mode = 'rest'; });
  syncActors();
  genLayout();
  applyTileClasses();
  save();
  renderAll();
  toast(`✨ Prestige #${state.prestigeCount}! Permanent mineRate multiplier is now ×${nextMult.toFixed(2)}.`);
  return true;
}

// ---- Stat re-roll ----

function rerollCost(h) {
  const idx = RARITIES.indexOf(h.rarity);
  return Math.floor(REROLL_BASE_COST * Math.pow(REROLL_COST_GROWTH, idx) * (1 + REROLL_LEVEL_STEP * (h.level - 1)));
}

function rerollHero(id) {
  const h = state.heroes.find(x => x.id === id);
  if (!h) return false;
  const cost = rerollCost(h);
  if (state.bcoin < cost) {
    toast(`Need ${fmt(cost)} Chef Gems to re-roll this hero.`);
    return false;
  }
  state.bcoin -= cost;
  const c = RARITY_CONF[h.rarity];
  h.power = randInt(c.power[0], c.power[1]);
  h.range = randInt(c.range[0], c.range[1]);
  h.speed = randInt(c.speed[0], c.speed[1]);
  save();
  renderHeader();
  renderInventory();
  toast(`🎲 ${h.name} re-rolled: 💪${h.power} 💥${h.range} 👟${h.speed}`);
  return true;
}

// ---- Global upgrade tree ----

function upgradeCost(key) {
  const lvl = state.upgrades[key] || 0;
  return Math.floor(UPGRADE_DEFS[key].baseCost * Math.pow(UPGRADE_COST_GROWTH, lvl));
}

function buyUpgrade(key) {
  if (!UPGRADE_DEFS[key]) return false;
  const cost = upgradeCost(key);
  if (state.bcoin < cost) {
    toast(`Need ${fmt(cost)} Chef Gems for the next ${UPGRADE_DEFS[key].name} level.`);
    return false;
  }
  state.bcoin -= cost;
  state.upgrades[key] = (state.upgrades[key] || 0) + 1;
  save();
  renderHeader();
  toast(`${UPGRADE_DEFS[key].icon} ${UPGRADE_DEFS[key].name} is now level ${state.upgrades[key]}!`);
  return true;
}

// ---- Sacrifice ("XP dust") ----

function sacrificeHeroes(sacrificeIds, targetId) {
  if (!sacrificeIds.length || sacrificeIds.includes(targetId)) return false;
  const target = state.heroes.find(h => h.id === targetId);
  const victims = state.heroes.filter(h => sacrificeIds.includes(h.id));
  if (!target || victims.length !== sacrificeIds.length) return false;
  const dust = victims.reduce((s, h) => s + effectivePower(h) * SACRIFICE_DUST_RATE, 0);
  state.heroes = state.heroes.filter(h => !sacrificeIds.includes(h.id));
  target.bonusPower = (target.bonusPower || 0) + dust;
  syncActors();
  save();
  renderHeader();
  renderInventory();
  toast(`💀 Sacrificed ${victims.length} hero${victims.length === 1 ? '' : 'es'} → +${dust.toFixed(1)} permanent power for ${target.name}.`);
  return true;
}

// ---- Breeding (Nursery) ----
// Child rarity is always the LOWER of the two parents' rarities — breeding
// can never be used as a rarity-upgrade shortcut, that stays Fusion-only.

function breedCost(p1, p2) {
  const avgIdx = (RARITIES.indexOf(p1.rarity) + RARITIES.indexOf(p2.rarity)) / 2;
  return Math.floor(BREED_BASE_COST * Math.pow(BREED_COST_GROWTH, avgIdx));
}

function breedHeroes(id1, id2) {
  if (id1 === id2) return null;
  const p1 = state.heroes.find(h => h.id === id1);
  const p2 = state.heroes.find(h => h.id === id2);
  if (!p1 || !p2) return null;
  const cost = breedCost(p1, p2);
  if (state.bcoin < cost) {
    toast(`Need ${fmt(cost)} Chef Gems to breed these two heroes.`);
    return null;
  }
  state.bcoin -= cost;
  const childRarity = RARITIES[Math.min(RARITIES.indexOf(p1.rarity), RARITIES.indexOf(p2.rarity))];
  const child = makeHero(childRarity);
  // Skill inheritance is explicitly limited to Phantom/Swift — Midas and
  // Cataclysm are pure rarity-derived (hasMidas/hasCata check h.rarity only)
  // and are never stored as a copyable per-hero flag, so there is nothing
  // here that could leak them onto a lower-rarity child.
  if ((p1.ghost && Math.random() < BREED_INHERIT_CHANCE) || (p2.ghost && Math.random() < BREED_INHERIT_CHANCE)) child.ghost = true;
  if ((p1.swift && Math.random() < BREED_INHERIT_CHANCE) || (p2.swift && Math.random() < BREED_INHERIT_CHANCE)) child.swift = true;
  state.heroes.push(child);
  state.breeds = (state.breeds || 0) + 1;
  save();
  renderHeader();
  renderInventory();
  showPullModal([child], `👶 Bred a new ${rLabel(childRarity)}:`);
  return child;
}

// ---- Skill implant ----
// Skill Shards are a rare material dropped from destroying crates/chests
// (rolled in destroyTile). They can only ever buy Phantom or Swift — Midas
// and Cataclysm are hard-excluded from this system on purpose.

function implantSkill(heroId, skill) {
  if (skill !== 'ghost' && skill !== 'swift') return false; // Midas/Cataclysm are never valid targets here
  const h = state.heroes.find(x => x.id === heroId);
  if (!h || h[skill]) return false;
  if (state.skillShards < IMPLANT_COST_SHARDS) {
    toast(`Need ${IMPLANT_COST_SHARDS} 🔮 Skill Shards to attempt an implant.`);
    return false;
  }
  state.skillShards -= IMPLANT_COST_SHARDS;
  const success = Math.random() < IMPLANT_SUCCESS_CHANCE;
  if (success) h[skill] = true;
  save();
  renderHeader();
  renderInventory();
  toast(success
    ? `🔮 Implant succeeded! ${h.name} gained ${skill === 'ghost' ? '👻 Phantom' : '💨 Swift'}.`
    : `🔮 Implant failed — the shards were consumed with no effect.`);
  return success;
}

// ---- Ascension ----

function canAscend(h) {
  return RARITIES.indexOf(h.rarity) >= RARITIES.indexOf(ASCEND_MIN_RARITY) && h.level >= MAX_LEVEL;
}

function ascendHero(heroId, sacrificeIds) {
  const h = state.heroes.find(x => x.id === heroId);
  if (!h || !canAscend(h)) return false;
  const ids = [...new Set(sacrificeIds)].filter(id => id !== heroId);
  if (ids.length !== ASCEND_SACRIFICE_COUNT) return false;
  const fodder = state.heroes.filter(x => ids.includes(x.id) && x.rarity === h.rarity);
  if (fodder.length !== ASCEND_SACRIFICE_COUNT) return false;
  state.heroes = state.heroes.filter(x => !ids.includes(x.id));
  h.ascendCount = (h.ascendCount || 0) + 1;
  state.ascensions = (state.ascensions || 0) + 1;
  syncActors();
  save();
  renderHeader();
  renderInventory();
  toast(`🌌 ${h.name} Ascended! (×${ascendMult(h).toFixed(2)} permanent mineRate, ascension #${h.ascendCount})`);
  return true;
}

/* ============ Rendering ============ */

function fmt(n) {
  return Math.floor(n).toLocaleString('en-US');
}

// exclusive skills are derived from rarity, never rolled or stored: every
// Shiny is Midas, every Robadasso is Cataclysm, no other tier ever qualifies
function hasMidas(h) { return h.rarity === 'Shiny'; }
function hasCata(h) { return h.rarity === 'Robadasso'; }

function fmtPct(p) {
  const pct = p * 100;
  return (pct >= 0.1 ? pct.toFixed(1) : pct.toPrecision(2)) + '%';
}

function spriteHtml(h) {
  const skills =
    (h.ghost ? '<span class="sp-skill sk-g" title="Phantom: phases through walls and crates">👻</span>' : '') +
    (h.swift ? '<span class="sp-skill sk-s" title="Swift: moves twice per step">💨</span>' : '') +
    (hasMidas(h) ? '<span class="sp-skill sk-m" title="Midas: +50% Food Coins on everything its bombs break">🌟</span>' : '') +
    (hasCata(h) ? '<span class="sp-skill sk-c" title="Cataclysm: each blast chains to 3 random crates/chests">⚽</span>' : '');
  const char = HERO_CHARACTERS.includes(h.character) ? h.character : HERO_CHARACTERS[0];
  return `<span class="sprite sr-${h.rarity}"><img src="assets/heroes/${char}.png" alt="${char}" loading="lazy">${skills}</span>`;
}

function skillText(h) {
  const s = [];
  if (h.ghost) s.push('👻 Phantom');
  if (h.swift) s.push('💨 Swift');
  if (hasMidas(h)) s.push('🌟 Midas');
  if (hasCata(h)) s.push('⚽ Cataclysm');
  return s.join(' · ');
}

function skillBadgesHtml(h) {
  const badges = [];
  if (h.ghost) badges.push('<span class="skill-pill sk-ghost" title="Phantom">👻</span>');
  if (h.swift) badges.push('<span class="skill-pill sk-swift" title="Swift">💨</span>');
  if (hasMidas(h)) badges.push('<span class="skill-pill sk-midas" title="Midas">🌟</span>');
  if (hasCata(h)) badges.push('<span class="skill-pill sk-cata" title="Cataclysm">⚽</span>');
  return badges.join('');
}

function energyBarHtml(h) {
  const maxE = RARITY_CONF[h.rarity].maxEnergy;
  const pct = Math.round((h.energy / maxE) * 100);
  return `
    <div class="energy-bar"><div class="fill ${pct < 25 ? 'low' : ''}" data-energy-fill="${h.id}" style="width:${pct}%"></div></div>
    <div class="energy-label" data-energy-label="${h.id}">⚡ ${Math.floor(h.energy)} / ${maxE}</div>`;
}

function heroCardHtml(h, opts) {
  opts = opts || {};
  const working = h.mode === 'work';
  const cls = ['hero-card', 'r-' + h.rarity];
  if (working) cls.push('working');
  if (opts.selectable) cls.push('selectable');
  if (opts.selected) cls.push('selected');
  return `
  <div class="${cls.join(' ')}" ${opts.selectable ? `data-fuse-id="${h.id}"` : ''}>
    <div class="hero-top">
      <span class="hero-emoji">${spriteHtml(h)}</span>
      <div>
        <div class="hero-name">${h.name}</div>
        <span class="rarity-badge rarity-${h.rarity}">${rLabel(h.rarity)}</span>
      </div>
    </div>
    <div class="hero-stats">
      💪 Power ${h.power} &nbsp; 💥 Range ${h.range} &nbsp; 👟 Speed ${h.speed}<br>
      🏅 Level ${h.level} &nbsp; ⛏️ ${mineRate(h).toFixed(2)} Food Coins/s &nbsp; ${working ? '<b style="color:var(--accent2)">WORKING</b>' : 'Resting'}
      ${skillText(h) ? `<br>✨ ${skillText(h)}` : ''}
    </div>
    ${energyBarHtml(h)}
    ${opts.actions ? `
    <div class="hero-actions">
      <button class="btn btn-small ${working ? 'btn-ghost' : ''}" data-toggle-id="${h.id}">${working ? '😴 Rest' : '⛏️ Work'}</button>
      ${h.level < MAX_LEVEL
        ? `<button class="btn btn-small btn-ghost" data-level-id="${h.id}">⬆️ Lv ${h.level + 1} (${fmt(levelCost(h))} Food Coins)</button>`
        : '<span class="muted">Max level</span>'}
    </div>` : ''}
  </div>`;
}

// number of tasks that are unlocked, unclaimed, AND currently satisfied —
// i.e. exactly what the Tasks tab would show as "ready to claim" right now
function readyTaskCount() {
  if (state.heroes.length < TASKS_UNLOCK_HEROES) return 0;
  return TASKS.filter(t => !state.tasksClaimed.includes(t.id) && t.check(state)).length;
}

function renderHeader() {
  document.getElementById('bcoin-display').textContent = fmt(state.bcoin);
  document.getElementById('score-display').textContent = fmt(state.starCore);
  document.getElementById('shard-display').textContent = fmt(state.skillShards || 0);
  document.getElementById('prestige-display').textContent = fmt(state.prestigeCount || 0);
  const sleepBtn = document.getElementById('sleep-btn');
  sleepBtn.textContent = state.sleepMode ? '💤' : '🌙';
  sleepBtn.classList.toggle('sleep-on', !!state.sleepMode);

  // mail icon is a real Tasks shortcut now — badge shows how many are ready
  // to claim right now, hidden entirely when there's nothing to claim
  const ready = readyTaskCount();
  const badge = document.getElementById('mail-badge');
  if (badge) {
    badge.textContent = String(ready);
    badge.classList.toggle('hidden', ready === 0);
  }
}

// HUD skeleton is static in index.html; per-tick we only fill value slots,
// so the bulk buttons in the HUD are never rebuilt under the cursor
function renderHunt() {
  const working = state.heroes.filter(h => h.mode === 'work');
  const totalRate = working.reduce((s, h) => s + mineRate(h), 0);
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('hud-wave', state.wave);
  set('hud-mult', '×' + waveMult().toFixed(2));
  set('hud-crates', `${cratesLeft} / ${cratesTotal}`);
  set('hud-workers', `${working.length} / ${MAX_WORKERS}`);
  set('hud-rate', totalRate.toFixed(2) + ' Food Coins/s');
  set('hud-recovery', recoveryRate().toFixed(2) + ' ⚡/s');
  document.getElementById('bombers').innerHTML = working.length
    ? working.map(h => {
        const maxE = RARITY_CONF[h.rarity].maxEnergy;
        const pct = Math.round((h.energy / maxE) * 100);
        const cycle = ((cooldownTicks(h) + FUSE_TICKS) * AI_MS / 1000).toFixed(1);
        const badges = skillBadgesHtml(h);
        return `
        <div class="bomber-item r-${h.rarity}">
          <span class="bomber-sprite">${spriteHtml(h)}</span>
          <div class="bomber-info">
            <div class="bomber-top">
              <span class="bomber-name">${h.name}</span>
              <span class="rarity-badge rarity-${h.rarity} bomber-badge">${rTag(h.rarity)}</span>
            </div>
            <div class="bomber-stats">
              <span title="Blast radius">💥 ${blastRadius(h)}</span>
              <span title="Bomb cycle (fuse + cooldown)">⏱️ ${cycle}s</span>
              <span title="Mining rate">⛏️ ${mineRate(h).toFixed(1)}/s</span>
              ${h.ascendCount > 0 ? `<span class="bomber-ascend" title="Ascension #${h.ascendCount} — permanent mineRate multiplier">🌌 ×${ascendMult(h).toFixed(2)}</span>` : ''}
            </div>
            ${badges ? `<div class="bomber-skills">${badges}</div>` : ''}
            <div class="energy-bar"><div class="fill ${pct < 25 ? 'low' : ''}" style="width:${pct}%"></div></div>
            <div class="bomber-energy-label">⚡ ${Math.floor(h.energy)} / ${maxE}</div>
          </div>
        </div>`;
      }).join('')
    : '<div class="bombers-empty muted">No bombers on the field.<br>Open 🎒 Heroes and send some to work.</div>';
}

function sortedHeroes() {
  const list = [...state.heroes];
  const rIdx = h => RARITIES.indexOf(h.rarity);
  const cmp = {
    rarity: (a, b) => rIdx(b) - rIdx(a) || b.power - a.power,
    power:  (a, b) => b.power - a.power,
    level:  (a, b) => b.level - a.level || b.power - a.power,
    energy: (a, b) => b.energy - a.energy,
  }[sortMode];
  return list.sort(cmp);
}

/* ============ Inventory tab (Food Fighters visual re-skin) ============ */
// Real-data mapping notes: the 4-segment attribute bar and stat rows use the
// SAME proportional-share technique as the prototype (each raw stat divided
// by a flat ceiling, then each's share of the summed total) — it's a
// decorative "which of my 4 stats leads" indicator, not a balance number.
const FF_STAT_COLORS = { power: '#ff6f6f', speed: '#5ab0ff', bombs: '#ff9a3c', blast: '#4fd675' };
const FF_STAT_MAX = { power: 6000, speed: 10, bombs: 24, blast: 8 };

function ffBombsPerMin(h) {
  const cycleSeconds = (cooldownTicks(h) + FUSE_TICKS) * AI_MS / 1000;
  return 60 / cycleSeconds;
}

function ffAttributeSegments(h) {
  const raw = [
    effectivePower(h) / FF_STAT_MAX.power,
    h.speed / FF_STAT_MAX.speed,
    ffBombsPerMin(h) / FF_STAT_MAX.bombs,
    blastRadius(h) / FF_STAT_MAX.blast,
  ];
  const total = raw.reduce((s, v) => s + v, 0) || 1;
  const colors = [FF_STAT_COLORS.power, FF_STAT_COLORS.speed, FF_STAT_COLORS.bombs, FF_STAT_COLORS.blast];
  return raw.map((v, i) => ({ color: colors[i], pct: (v / total) * 100 }));
}

function ffStatusDotClass(h) {
  if (h.mode !== 'work') return 'ff-dot-rest';
  const maxE = RARITY_CONF[h.rarity].maxEnergy;
  return (h.energy / maxE) < 0.25 ? 'ff-dot-low' : 'ff-dot-work';
}

// the decorative "favorite" star from the prototype is repurposed here to
// flag "this hero has at least one real skill" instead of being random
function ffHeroCardHtml(h) {
  const segments = ffAttributeSegments(h);
  const hasAnySkill = h.ghost || h.swift || hasMidas(h) || hasCata(h);
  return `
  <button type="button" class="ff-card r-${h.rarity}${selectedInventoryHeroId === h.id ? ' ff-card-selected' : ''}" data-select-hero="${h.id}" aria-pressed="${selectedInventoryHeroId === h.id}">
    <div class="ff-card-top">
      <span class="ff-card-id">#${String(h.id).padStart(4, '0')}</span>
      <span class="ff-status-dot ${ffStatusDotClass(h)}" data-status-dot="${h.id}" title="${h.mode === 'work' ? 'Working' : 'Resting'}"></span>
    </div>
    <div class="ff-card-image-wrap">
      ${spriteHtml(h)}
      <span class="ff-rarity-badge rarity-${h.rarity}">${rTag(h.rarity)}</span>
      ${hasAnySkill ? '<span class="ff-star" title="Has a skill">★</span>' : ''}
    </div>
    <div class="ff-attr-bar">${segments.map(s => `<span style="width:${s.pct}%;background:${s.color}"></span>`).join('')}</div>
    <span class="ff-card-name">${h.name}</span>
  </button>`;
}

function ffSkillCards(h) {
  const skills = [];
  if (h.ghost) skills.push({ icon: '👻', name: 'Phantom' });
  if (h.swift) skills.push({ icon: '💨', name: 'Swift' });
  if (hasMidas(h)) skills.push({ icon: '🌟', name: 'Midas' });
  if (hasCata(h)) skills.push({ icon: '⚽', name: 'Cataclysm' });
  if (!skills.length) {
    return '<div class="ff-skill-card ff-skill-empty"><span class="ff-skill-icon">🔒</span><span class="ff-skill-name">No skills yet</span></div>';
  }
  return skills.map(s => `<div class="ff-skill-card"><span class="ff-skill-icon">${s.icon}</span><span class="ff-skill-name">${s.name}</span></div>`).join('');
}

function selectInventoryHero(id) {
  selectedInventoryHeroId = id;
  renderInventory();
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabName));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tabName));
  renderAll();
  if (tabName === 'hunt') layoutArena();
}

// the prototype's "VISUAL" button has no real equivalent in this game — it's
// repurposed to jump straight to this hero pre-selected in the Lab's re-roll
// picker, a real action rather than a dropped/dead button
function jumpToLabForReroll(id) {
  switchTab('lab');
  const sel = document.getElementById('reroll-select');
  if (sel) {
    sel.value = String(id);
    updateRerollCost();
  }
}

function renderInventoryDetails() {
  const panel = document.getElementById('inventory-details');
  if (!panel) return;
  const h = state.heroes.find(x => x.id === selectedInventoryHeroId);
  if (!h) {
    selectedInventoryHeroId = null;
    panel.innerHTML = `
    <div class="ff-empty-state">
      <span class="ff-empty-icon">🍔</span>
      <p class="ff-empty-text">Select a hero in the grid to see details.</p>
    </div>`;
    return;
  }
  const maxE = RARITY_CONF[h.rarity].maxEnergy;
  const starPerHour = mineRate(h) * 3600;
  const bcoinPerHour = starPerHour / EXCHANGE_RATE;
  const atMax = h.level >= MAX_LEVEL;
  const cost = atMax ? 0 : levelCost(h);
  const xpPct = atMax ? 100 : Math.min(100, Math.round((state.starCore / cost) * 100));
  const working = h.mode === 'work';

  panel.innerHTML = `
    <div class="ff-scene">
      <button type="button" class="ff-close-btn" data-close-details title="Close">✕</button>
      <div class="ff-sky"><span class="ff-cloud" style="left:10%;top:20%"></span><span class="ff-cloud" style="left:62%;top:38%"></span></div>
      <div class="ff-char-wrap">${spriteHtml(h)}</div>
      <div class="ff-ground"></div>
      <div class="ff-info-block">
        <h2 class="ff-hero-name">${h.name}</h2>
        <div class="ff-meta-row">
          <span class="ff-chip ff-chip-rarity rarity-${h.rarity}">${rTag(h.rarity)} · ${rLabel(h.rarity)}</span>
          <span class="ff-chip ff-chip-level">Level ${h.level}</span>
          <span class="ff-chip ff-chip-energy" id="ff-energy-chip">⚡ ${Math.floor(h.energy)}/${maxE}</span>
        </div>
      </div>
    </div>

    <div class="ff-reward-panel">
      <h3 class="ff-panel-title">PROJECTED EARN RATE</h3>
      <div class="ff-reward-row">
        <div class="ff-reward-item">
          <span class="ff-reward-icon"><img src="assets/coins/food_coin.png" alt="Food Coins" loading="lazy"></span>
          <span class="ff-reward-value">${fmt(starPerHour)}</span>
          <span class="ff-reward-unit">Food Coins/hr</span>
        </div>
        <div class="ff-reward-divider"></div>
        <div class="ff-reward-item">
          <span class="ff-reward-icon"><img src="assets/coins/chef_coin.png" alt="Chef Gems" loading="lazy"></span>
          <span class="ff-reward-value">${fmt(bcoinPerHour)}</span>
          <span class="ff-reward-unit">Chef Gems/hr</span>
        </div>
      </div>
    </div>

    <div class="ff-stats-panel">
      <div class="ff-stat-row"><span class="ff-stat-icon">⚔️</span><span class="ff-stat-label">Attack</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.power}">${Math.round(effectivePower(h))}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">💨</span><span class="ff-stat-label">Speed</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.speed}">${h.speed}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">💣</span><span class="ff-stat-label">Bombs/min</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.bombs}">${ffBombsPerMin(h).toFixed(1)}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">💥</span><span class="ff-stat-label">Blast Radius</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.blast}">${blastRadius(h)}</span></div>
    </div>

    <div class="ff-skills-wrap">
      <h3 class="ff-skills-title">SKILLS</h3>
      <div class="ff-skills-grid">${ffSkillCards(h)}</div>
    </div>

    <footer class="ff-footer">
      <div class="ff-xp-wrap">
        <div class="ff-level-badge"><span class="ff-level-star">★</span><span class="ff-level-number">${h.level}</span></div>
        <div class="ff-xp-track">
          <div class="ff-xp-fill" id="ff-xp-fill" style="width:${xpPct}%"></div>
          <span class="ff-xp-text" id="ff-xp-text">${atMax ? 'MAX LEVEL' : `${fmt(state.starCore)} / ${fmt(cost)} Food Coins`}</span>
        </div>
        <button type="button" class="ff-evolve-btn" id="ff-levelup-btn" data-levelup-id="${h.id}" ${atMax ? 'disabled' : ''} title="${atMax ? 'Max level' : 'Level up'}">▲</button>
      </div>
      <div class="ff-actions-wrap">
        <button type="button" class="ff-toggle-btn${working ? ' ff-toggle-rest' : ''}" id="ff-work-btn" data-toggle-id="${h.id}">${working ? 'REST' : 'WORK'}</button>
        <button type="button" class="ff-lab-btn" data-lab-id="${h.id}" title="Open in the Lab">LAB</button>
      </div>
    </footer>
  `;
}

function renderInventory() {
  const heroes = sortedHeroes();
  document.getElementById('inventory-grid').innerHTML = heroes.length
    ? heroes.map(h => ffHeroCardHtml(h)).join('')
    : '<div class="locked-box">No heroes yet — visit the Shop!</div>';
  const countEl = document.getElementById('ff-collected-count');
  if (countEl) countEl.textContent = `Heroes collected: ${heroes.length}`;
  renderInventoryDetails();
}

// Per-tick partial update so buttons aren't rebuilt under the cursor: status
// dots refresh per-card, and the open details panel's live numbers (energy,
// XP-toward-levelup, Work/Rest label) refresh in place — same discipline the
// rest of the codebase already uses for other per-tick UI (shop/task buttons)
function updateInventoryLive() {
  for (const h of state.heroes) {
    const dot = document.querySelector(`#inventory-grid [data-status-dot="${h.id}"]`);
    if (dot) dot.className = 'ff-status-dot ' + ffStatusDotClass(h);
  }
  if (selectedInventoryHeroId == null) return;
  const h = state.heroes.find(x => x.id === selectedInventoryHeroId);
  if (!h) { renderInventoryDetails(); return; }
  const maxE = RARITY_CONF[h.rarity].maxEnergy;
  const chip = document.getElementById('ff-energy-chip');
  if (chip) chip.textContent = `⚡ ${Math.floor(h.energy)}/${maxE}`;
  const atMax = h.level >= MAX_LEVEL;
  const cost = atMax ? 0 : levelCost(h);
  const xpPct = atMax ? 100 : Math.min(100, Math.round((state.starCore / cost) * 100));
  const fill = document.getElementById('ff-xp-fill');
  if (fill) fill.style.width = xpPct + '%';
  const text = document.getElementById('ff-xp-text');
  if (text) text.textContent = atMax ? 'MAX LEVEL' : `${fmt(state.starCore)} / ${fmt(cost)} Food Coins`;
  const lvlBtn = document.getElementById('ff-levelup-btn');
  if (lvlBtn) lvlBtn.disabled = atMax;
  const workBtn = document.getElementById('ff-work-btn');
  if (workBtn) {
    const working = h.mode === 'work';
    workBtn.textContent = working ? 'REST' : 'WORK';
    workBtn.classList.toggle('ff-toggle-rest', working);
  }
}

function renderShop() {
  document.getElementById('pack-grid').innerHTML = PACKS.map((p, i) => `
    <div class="pack-card">
      <h3>${'💣'.repeat(Math.min(4, Math.ceil(p.size / 4)))} x${p.size} Pack</h3>
      <div class="odds">
        ${RARITIES.map(r => `<span class="rarity-badge rarity-${r}">${rTag(r)}</span> ${fmtPct(p.odds[r])}`).join('<br>')}
      </div>
      <div class="price">${fmt(p.cost)} Chef Gems</div>
      <button class="btn" data-pack="${i}" ${state.bcoin < p.cost ? 'disabled' : ''}>Buy pack</button>
    </div>`).join('');

  document.getElementById('house-grid').innerHTML = HOUSES.map(h => `
    <div class="house-card">
      <h3>${h.emoji} ${h.name}</h3>
      <div class="muted">+${h.recovery.toFixed(1)} energy/s recovery</div>
      <div class="owned">Owned: ${state.houses[h.id]}</div>
      <div class="price">${fmt(h.cost)} Chef Gems</div>
      <button class="btn" data-house="${h.id}" ${state.bcoin < h.cost ? 'disabled' : ''}>Build</button>
    </div>`).join('');
}

// Targeted per-tick updates: rebuilding buttons via innerHTML every second
// would destroy the node between mousedown and mouseup, eating clicks
function updateShopButtons() {
  document.querySelectorAll('[data-pack]').forEach(b => {
    b.disabled = state.bcoin < PACKS[Number(b.dataset.pack)].cost;
  });
  document.querySelectorAll('[data-house]').forEach(b => {
    b.disabled = state.bcoin < HOUSES.find(h => h.id === b.dataset.house).cost;
  });
}

function updateTaskButtons() {
  document.querySelectorAll('[data-task]').forEach(b => {
    const t = TASKS.find(x => x.id === b.dataset.task);
    b.disabled = state.tasksClaimed.includes(t.id) || !t.check(state);
  });
}

function renderFusion() {
  document.getElementById('fusion-auto').innerHTML = FUSABLE.map(r => {
    const next = RARITIES[RARITIES.indexOf(r) + 1];
    const n = state.heroes.filter(h => h.rarity === r).length;
    const pct = Math.round(FUSE_SUCCESS_CHANCE[r] * 100);
    return `
    <div class="fusion-row">
      <div class="fusion-row-info">
        <span class="rarity-badge rarity-${r}">${rTag(r)}</span>
        <span class="arrow">→</span>
        <span class="rarity-badge rarity-${next}">${rTag(next)}</span>
        <span class="muted">${n} owned / ${FUSE_COST} needed · ${pct}% success</span>
      </div>
      <button class="btn btn-small" data-autofuse="${r}" ${n >= FUSE_COST ? '' : 'disabled'}>⚗️ Fuse (${pct}%)</button>
      <button class="btn btn-small btn-ghost" data-fusemax="${r}" ${n >= FUSE_COST * 2 ? '' : 'disabled'}>Fuse Max</button>
    </div>`;
  }).join('');

  const fusable = sortedHeroes().filter(h => FUSABLE.includes(h.rarity));
  const first = selectedFusion.length ? state.heroes.find(h => h.id === selectedFusion[0]) : null;
  const target = first ? RARITIES[RARITIES.indexOf(first.rarity) + 1] : null;

  document.getElementById('fusion-controls').innerHTML = `
    <button class="btn" id="fuse-btn" ${selectedFusion.length === FUSE_COST ? '' : 'disabled'}>
      ⚗️ Fuse ${selectedFusion.length}/${FUSE_COST}${target ? ` → 1× ${rTag(target)} (${Math.round(FUSE_SUCCESS_CHANCE[first.rarity] * 100)}%)` : ''}
    </button>
    <span class="fusion-hint">${first ? `Selecting ${rLabel(first.rarity)} heroes` : 'Click hero cards to select them'}</span>`;
  const fuseBtn = document.getElementById('fuse-btn');
  if (fuseBtn) fuseBtn.addEventListener('click', fuse);

  document.getElementById('fusion-grid').innerHTML = fusable.length
    ? fusable.map(h => heroCardHtml(h, { selectable: true, selected: selectedFusion.includes(h.id) })).join('')
    : '<div class="locked-box">No fusable heroes (Robadasso is the ceiling — everything below it can attempt fusion).</div>';
}

function renderRanking() {
  const hours = (Date.now() - NPC_EPOCH) / 3600000;
  const rows = NPCS.map(n => ({ name: n.name, score: n.base + n.perHour * hours, player: false }));
  rows.push({ name: 'You 💣', score: state.totalMined, player: true });
  rows.sort((a, b) => b.score - a.score);
  document.querySelector('#ranking-table tbody').innerHTML = rows.map((r, i) => `
    <tr class="${r.player ? 'player-row' : ''}">
      <td>${['🥇', '🥈', '🥉'][i] || i + 1}</td>
      <td>${r.name}</td>
      <td>${fmt(r.score)}</td>
    </tr>`).join('');
}

function renderTasks() {
  const body = document.getElementById('tasks-body');
  if (state.heroes.length < TASKS_UNLOCK_HEROES) {
    body.innerHTML = `<div class="locked-box">🔒 Tasks unlock once you own <b>${TASKS_UNLOCK_HEROES} heroes</b>.<br>
      You currently own ${state.heroes.length} — grab some packs in the 🛒 Shop!</div>`;
    return;
  }
  body.innerHTML = TASKS.map(t => {
    const claimed = state.tasksClaimed.includes(t.id);
    const ready = !claimed && t.check(state);
    return `
    <div class="task-item ${claimed ? 'done' : ''}">
      <div class="task-info">
        <div class="task-name">${claimed ? '✅' : ready ? '🟡' : '⬜'} ${t.name}</div>
        <div class="task-reward">Reward: ${fmt(t.reward)} Food Coins</div>
      </div>
      ${claimed
        ? '<span class="muted">Claimed</span>'
        : `<button class="btn btn-small" data-task="${t.id}" ${ready ? '' : 'disabled'}>Claim</button>`}
    </div>`;
  }).join('');
}

function renderAll() {
  renderHeader();
  renderHunt();
  renderInventory();
  renderShop();
  renderFusion();
  renderLab();
  renderPrestige();
  renderRanking();
  renderTasks();
}

/* ============ Lab / Prestige rendering ============ */

function heroOptionLabel(h) {
  return `${h.emoji} ${h.name} (${rTag(h.rarity)} Lv${h.level})`;
}

function fillSelect(sel, heroes, extra) {
  const prev = sel.value;
  sel.innerHTML = heroes.map(h => `<option value="${h.id}">${heroOptionLabel(h)}${extra ? extra(h) : ''}</option>`).join('');
  if (prev && heroes.some(h => String(h.id) === prev)) sel.value = prev;
}

// small portrait preview next to a Lab <select> — <option> can't hold an
// <img>, so this is how a hero's actual portrait shows up in the picker UI
function updateHeroPreview(previewId, heroId) {
  const el = document.getElementById(previewId);
  if (!el) return;
  const h = state.heroes.find(x => x.id === heroId);
  el.innerHTML = h ? spriteHtml(h) : '';
}

function renderLab() {
  const heroes = sortedHeroes();
  if (!heroes.length) {
    document.querySelectorAll('#tab-lab select').forEach(s => { s.innerHTML = '<option value="">No heroes yet</option>'; });
    return;
  }

  const rrSel = document.getElementById('reroll-select');
  fillSelect(rrSel, heroes);
  updateRerollCost();

  const targetSel = document.getElementById('sac-target-select');
  fillSelect(targetSel, heroes);
  renderSacVictims();

  const p1Sel = document.getElementById('breed-p1-select'), p2Sel = document.getElementById('breed-p2-select');
  fillSelect(p1Sel, heroes);
  fillSelect(p2Sel, heroes);
  updateBreedCost();

  const implSel = document.getElementById('implant-select');
  fillSelect(implSel, heroes, h => (h.ghost && h.swift ? ' (has both skills)' : ''));
  updateImplantCost();

  const ascCandidates = heroes.filter(canAscend);
  const ascSel = document.getElementById('ascend-target-select');
  if (ascCandidates.length) fillSelect(ascSel, ascCandidates, h => ` — ×${ascendMult(h).toFixed(2)} now`);
  else ascSel.innerHTML = '<option value="">No eligible hero (need Epic+ at max level)</option>';
  renderAscendFodder();
}

function updateRerollCost() {
  const heroId = Number(document.getElementById('reroll-select').value);
  const h = state.heroes.find(x => x.id === heroId);
  document.getElementById('reroll-cost').textContent = h ? `Cost: ${fmt(rerollCost(h))} Chef Gems` : '';
  updateHeroPreview('reroll-preview', heroId);
}

function renderSacVictims() {
  const targetId = Number(document.getElementById('sac-target-select').value);
  const list = document.getElementById('sac-victim-list');
  const others = sortedHeroes().filter(h => h.id !== targetId);
  list.innerHTML = others.length
    ? others.map(h => `<label><input type="checkbox" class="sac-victim-cb" value="${h.id}"> ${heroOptionLabel(h)} <span class="muted-tiny">💪${Math.round(effectivePower(h))}</span></label>`).join('')
    : '<div class="muted" style="padding:6px">No other heroes to sacrifice.</div>';
  updateHeroPreview('sac-target-preview', targetId);
  updateSacPreview();
}

function updateSacPreview() {
  const ids = Array.from(document.querySelectorAll('.sac-victim-cb:checked')).map(cb => Number(cb.value));
  const dust = ids.reduce((s, id) => {
    const h = state.heroes.find(x => x.id === id);
    return h ? s + effectivePower(h) * SACRIFICE_DUST_RATE : s;
  }, 0);
  document.getElementById('sac-preview').textContent = ids.length ? `+${dust.toFixed(1)} permanent power from ${ids.length} hero${ids.length === 1 ? '' : 'es'}` : 'Select heroes to sacrifice';
}

function updateBreedCost() {
  const p1Id = Number(document.getElementById('breed-p1-select').value);
  const p2Id = Number(document.getElementById('breed-p2-select').value);
  const p1 = state.heroes.find(h => h.id === p1Id);
  const p2 = state.heroes.find(h => h.id === p2Id);
  updateHeroPreview('breed-p1-preview', p1Id);
  updateHeroPreview('breed-p2-preview', p2Id);
  const out = document.getElementById('breed-cost');
  if (!p1 || !p2 || p1.id === p2.id) { out.textContent = p1 && p2 && p1.id === p2.id ? 'Pick two different heroes' : ''; return; }
  const childRarity = RARITIES[Math.min(RARITIES.indexOf(p1.rarity), RARITIES.indexOf(p2.rarity))];
  out.textContent = `Cost: ${fmt(breedCost(p1, p2))} Chef Gems · Child rarity: ${rTag(childRarity)}`;
}

function updateImplantCost() {
  const skill = document.querySelector('input[name="implant-skill"]:checked').value;
  document.getElementById('implant-cost').textContent = `Cost: ${IMPLANT_COST_SHARDS} 🔮 · ${Math.round(IMPLANT_SUCCESS_CHANCE * 100)}% success (${skill === 'ghost' ? '👻 Phantom' : '💨 Swift'})`;
  updateHeroPreview('implant-preview', Number(document.getElementById('implant-select').value));
}

function renderAscendFodder() {
  const targetId = Number(document.getElementById('ascend-target-select').value);
  const target = state.heroes.find(h => h.id === targetId);
  updateHeroPreview('ascend-target-preview', targetId);
  const list = document.getElementById('ascend-fodder-list');
  if (!target) { list.innerHTML = ''; document.getElementById('ascend-preview').textContent = ''; return; }
  const fodder = sortedHeroes().filter(h => h.id !== targetId && h.rarity === target.rarity);
  list.innerHTML = fodder.length
    ? fodder.map(h => `<label><input type="checkbox" class="ascend-fodder-cb" value="${h.id}"> ${heroOptionLabel(h)}</label>`).join('')
    : `<div class="muted" style="padding:6px">No other ${rLabel(target.rarity)} heroes to consume.</div>`;
  updateAscendPreview();
}

function updateAscendPreview() {
  const checked = document.querySelectorAll('.ascend-fodder-cb:checked').length;
  document.getElementById('ascend-preview').textContent = `${checked} / ${ASCEND_SACRIFICE_COUNT} selected`;
}

function renderPrestige() {
  const { gain, curMult, nextMult } = prestigePreview();
  document.getElementById('prestige-preview').innerHTML = `
    <div class="stat-box"><div class="label">Current wave</div><div class="value">${state.wave}</div></div>
    <div class="stat-box"><div class="label">Current mult</div><div class="value">×${curMult.toFixed(2)}</div></div>
    <div class="stat-box"><div class="label">Gain if you prestige now</div><div class="value">+${gain.toFixed(2)} pts</div></div>
    <div class="stat-box"><div class="label">Mult after</div><div class="value">×${nextMult.toFixed(2)}</div></div>
    <div class="stat-box"><div class="label">Prestiges so far</div><div class="value">${state.prestigeCount}</div></div>
  `;
  document.getElementById('prestige-btn').disabled = state.wave < 2;

  document.getElementById('upgrade-grid').innerHTML = Object.keys(UPGRADE_DEFS).map(key => {
    const def = UPGRADE_DEFS[key];
    const lvl = state.upgrades[key] || 0;
    const cost = upgradeCost(key);
    return `
    <div class="upgrade-card">
      <h3>${def.icon} ${def.name}</h3>
      <p class="muted">${def.desc}</p>
      <div class="lvl">Level ${lvl}</div>
      <div class="price">${fmt(cost)} Chef Gems</div>
      <button class="btn btn-small" data-upgrade="${key}" ${state.bcoin < cost ? 'disabled' : ''}>Upgrade</button>
    </div>`;
  }).join('');
}

function showPrestigeConfirm() {
  if (state.wave < 2) { toast('Reach at least wave 2 before prestiging.'); return; }
  const { gain, curMult, nextMult } = prestigePreview();
  document.getElementById('modal-body').innerHTML = `
    <h3>✨ Confirm Prestige</h3>
    <p class="muted">This resets your wave to 1 and your Food Coins/Chef Gems to starting amounts. Your ${state.heroes.length} heroes are <b>not</b> touched.</p>
    <div class="stat-row">
      <div class="stat-box"><div class="label">Mult now</div><div class="value">×${curMult.toFixed(2)}</div></div>
      <div class="stat-box"><div class="label">Mult after</div><div class="value">×${nextMult.toFixed(2)}</div></div>
    </div>
    <button class="btn btn-danger" id="prestige-confirm-btn" style="margin-top:14px">Confirm Prestige</button>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

/* ============ Modal / Toast ============ */

const RARITY_INFO = {
  Common: 'The everyday bomber — the bulk of pack pulls. Fuse 9 for a 95% shot at Rare.',
  Rare: 'Roughly 3x a Common\'s output. 12-22% pull odds; 9× fusion succeeds 85% of the time.',
  Epic: 'Heavy hitter with a wide blast. 2.7-6% pull odds — or fuse 9 Rares (85%).',
  Legendary: '0.3-2% pull odds, or fuse 9 Epics (70%).',
  SuperLegendario: 'Beyond Legendary. 0.02-0.1% pull odds — or a risky 9× Legendary fusion (40%).',
  Imortal: 'Blood-red anomaly. 0.004-0.02% pull odds; 9× SP fusion succeeds 20% of the time.',
  Shiny: 'Holographic freak of nature — 0.0008-0.004% odds, or an 8% shot fusing 9 Imortals. Always born with 🌟 Midas.',
  Robadasso: 'The ceiling: ~1 in a million pulls, or the 2% miracle of fusing 9 Shinies. Always born with ⚽ Cataclysm. Cannot be fused further.',
};

function showLegendModal() {
  document.getElementById('modal-body').innerHTML = `
    <h3>❓ Rarity guide</h3>
    ${RARITIES.map((r, i) => {
      const c = RARITY_CONF[r];
      return `
      <div class="legend-row r-${r}">
        <span class="legend-sprite">${spriteHtml({ rarity: r, character: HERO_CHARACTERS[i % HERO_CHARACTERS.length] })}</span>
        <div>
          <span class="rarity-badge rarity-${r}">${rLabel(r)}${c.tag ? ` (${c.tag})` : ''}</span>
          <div class="muted">💪 Power ${c.power[0]}–${c.power[1]} · 💥 Range ${c.range[0]}–${c.range[1]} · ⚡ Max energy ${c.maxEnergy}</div>
          <div class="muted">${RARITY_INFO[r]}</div>
        </div>
      </div>`;
    }).join('')}
    <h3 style="margin-top:16px">📦 Crates &amp; chests</h3>
    <div class="legend-row">
      <span class="legend-sprite legend-tileart"><img src="assets/crate.png" alt="Crate"><img src="assets/chest.png" alt="Chest"></span>
      <div><b>Durability</b><div class="muted">Every crate and chest shows an HP bar (🟢 healthy · 🟠 below 50% · 🔴 below 30%). Each bomb hit deals the hero's ⛏️ rate as damage. Chests always have 5× a crate's HP; both climb fast through the early waves and keep growing — steeper at first, more gradual deep in — forever, with the payout on breaking scaling right along with max HP.</div></div>
    </div>
    <h3 style="margin-top:16px">✨ Special skills</h3>
    <p class="muted" style="margin-bottom:8px">Every new hero rolls each skill independently at ${Math.round(SKILL_CHANCE * 100)}% — a hero can have none, one, or both.</p>
    <div class="legend-row">
      <span class="legend-sprite">👻</span>
      <div><b>Phantom</b><div class="muted">Phases straight through crates and pillars while pathing (still bound by the arena border).</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">💨</span>
      <div><b>Swift</b><div class="muted">Moves two tiles per step instead of one — reaches fresh crates twice as fast.</div></div>
    </div>
    <h3 style="margin-top:16px">👑 Exclusive skills</h3>
    <p class="muted" style="margin-bottom:8px">Guaranteed on every hero of their tier and never available anywhere else. They stack with Phantom/Swift rolls.</p>
    <div class="legend-row r-Shiny">
      <span class="legend-sprite">🌟</span>
      <div><b>Midas</b> <span class="rarity-badge rarity-Shiny">Shiny only</span><div class="muted">Everything its bombs break pays <b>+50% Food Coins</b> — a golden skim on every kill, not a board-warping flip.</div></div>
    </div>
    <div class="legend-row r-Robadasso">
      <span class="legend-sprite">⚽</span>
      <div><b>Cataclysm</b> <span class="rarity-badge rarity-Robadasso">Robadasso only</span><div class="muted">Each of its blasts also chains to <b>${CATA_CHAIN} random crates/chests</b> anywhere on the board for a full extra hit — lightning across the arena every bomb, but bounded, never a board-wipe.</div></div>
    </div>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function showPullModal(heroes, title) {
  document.getElementById('modal-body').innerHTML = `
    <h3>${title || '🎉 You recruited:'}</h3>
    <div class="pull-list">
      ${heroes.map(h => `
        <div class="pull-item r-${h.rarity}">
          <span class="hero-emoji" style="font-size:2.2rem">${spriteHtml(h)}</span>
          <div><b>${h.name}</b></div>
          <span class="rarity-badge rarity-${h.rarity}">${rLabel(h.rarity)}</span>
          <div class="muted">💪 ${h.power}</div>
        </div>`).join('')}
    </div>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

/* ============ Pack reveal ============ */

const REVEAL_MS = 1700, REVEAL_FAST_MS = 160, REVEAL_MEGA_MS = 3400;

let reveal = null;

function isCelebrated(h) {
  return RARITIES.indexOf(h.rarity) >= RARITIES.indexOf('Legendary');
}

// speed mode never lets a Legendary+ card fly by: celebrated pulls always
// hold the screen for the full (or mega) duration, then speed resumes
function revealDelay(h, speed) {
  if (h.rarity === 'Robadasso') return REVEAL_MEGA_MS;
  if (isCelebrated(h)) return REVEAL_MS;
  return speed ? REVEAL_FAST_MS : REVEAL_MS;
}

function startPackReveal(heroes, summaryTitle) {
  cancelReveal();
  reveal = { heroes, idx: -1, speed: false, timer: null, summaryTitle };
  document.getElementById('modal-body').innerHTML = `
    <div class="reveal-wrap">
      <div class="reveal-count" id="reveal-count"></div>
      <div id="reveal-card-slot"></div>
      <div class="reveal-controls">
        <button class="btn btn-small" id="reveal-next">Next ▶</button>
        <button class="btn btn-small btn-ghost" id="reveal-speed" title="Fast-forward — pauses automatically for Legendary+ pulls">⏩ Speed</button>
      </div>
    </div>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
  advanceReveal();
}

function advanceReveal() {
  if (!reveal) return;
  clearTimeout(reveal.timer);
  reveal.idx++;
  if (reveal.idx >= reveal.heroes.length) { finishReveal(); return; }
  const h = reveal.heroes[reveal.idx];
  renderRevealCard(h);
  if (isCelebrated(h)) playCelebration(h);
  reveal.timer = setTimeout(advanceReveal, revealDelay(h, reveal.speed));
}

function renderRevealCard(h) {
  const count = document.getElementById('reveal-count');
  if (count) count.textContent = `${reveal.idx + 1} / ${reveal.heroes.length}`;
  const slot = document.getElementById('reveal-card-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="reveal-card r-${h.rarity}${isCelebrated(h) ? ' celebrate' : ''}" id="reveal-card" title="Click to continue">
      <span class="reveal-sprite">${spriteHtml(h)}</span>
      <div class="reveal-name">${h.name}</div>
      <span class="rarity-badge rarity-${h.rarity}">${rLabel(h.rarity)}</span>
      <div class="reveal-stats">
        💪 ${h.power} &nbsp; 💥 ${h.range} &nbsp; 👟 ${h.speed} &nbsp; ⚡ ${RARITY_CONF[h.rarity].maxEnergy}<br>
        ⛏️ ${mineRate(h).toFixed(2)} Food Coins/s
      </div>
      ${skillText(h) ? `<div class="reveal-skills">✨ ${skillText(h)}</div>` : ''}
    </div>`;
}

function toggleRevealSpeed() {
  if (!reveal) return;
  reveal.speed = !reveal.speed;
  const btn = document.getElementById('reveal-speed');
  if (btn) btn.classList.toggle('speed-on', reveal.speed);
  if (reveal.idx >= 0 && reveal.idx < reveal.heroes.length) {
    clearTimeout(reveal.timer);
    reveal.timer = setTimeout(advanceReveal, revealDelay(reveal.heroes[reveal.idx], reveal.speed));
  }
}

function finishReveal() {
  if (!reveal) return;
  const heroes = reveal.heroes;
  const title = reveal.summaryTitle || `🎉 Pack summary — ${heroes.length} recruited:`;
  cancelReveal();
  showPullModal(heroes, title);
}

// Jail blocks free exactly one hero at a time — reuses the same rich
// single-card reveal (portrait, stats, skills, Legendary+ celebration) shop
// pulls already get, just with jail-specific framing on the summary screen
function startJailReveal(hero) {
  startPackReveal([hero], `🔓 Hero freed! ${rLabel(hero.rarity)} ${hero.name} joins your roster:`);
}

function cancelReveal() {
  if (!reveal) return;
  clearTimeout(reveal.timer);
  reveal = null;
}

function playCelebration(h) {
  const flash = document.createElement('div');
  flash.className = 'reveal-flash' + (h.rarity === 'Robadasso' ? ' mega-flash' : '');
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 900);
  if (h.rarity === 'Robadasso') {
    const mega = document.createElement('div');
    mega.className = 'mega-overlay';
    mega.innerHTML = '<div class="mega-text">⚽ ROBADASSO ⚽</div>';
    document.body.appendChild(mega);
    document.body.classList.add('shaking');
    setTimeout(() => { mega.remove(); document.body.classList.remove('shaking'); }, 2800);
    playMegaSound();
  }
}

// synthesized fanfare — Web Audio oscillators, no external assets
function playMegaSound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    [261.6, 329.6, 392.0, 523.3, 659.3, 784.0].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.1, ctx.currentTime + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.35);
      o.connect(g);
      g.connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.12);
      o.stop(ctx.currentTime + i * 0.12 + 0.4);
    });
    setTimeout(() => ctx.close(), 2200);
  } catch (e) {}
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

/* ============ Events ============ */

function bindEvents() {
  // .tab-btn now lives in #bottom-nav (relocated from the old side rail) —
  // this loop and switchTab()'s own querySelectorAll('.tab-btn') are
  // otherwise completely unchanged, since only 6 of the 9 tabs get a
  // bottom-nav icon (Hunt is the implicit default view; Ranking/Extras/Tasks
  // are reached via header icons instead — see below).
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('bottom-nav-toggle').addEventListener('click', () => {
    setBottomNavCollapsed(!document.getElementById('bottom-nav').classList.contains('collapsed'));
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layoutArena, 150);
  });

  document.getElementById('exchange-btn').addEventListener('click', exchange);
  document.getElementById('legend-btn').addEventListener('click', showLegendModal);

  // Food Coins "+" — no real "convert something into Food Coins" feature
  // exists, so this is a real shortcut to the actual way to earn more: the
  // Treasure Hunt tab itself, rather than a dead decorative button
  document.getElementById('food-plus-btn').addEventListener('click', () => switchTab('hunt'));

  // Extras is our de facto settings page (Reset, Sleep Mode, etc.)
  document.getElementById('settings-btn').addEventListener('click', () => switchTab('extras'));

  // Ranking is a real tab but isn't one of the 6 bottom-nav slots in the
  // reference (those are Fusão/Defesa/Bolsa/Casa/Loja/Chefs specifically),
  // so it needs a real shortcut elsewhere — reinstated here as a header icon
  // rather than left unreachable.
  document.getElementById('trophy-btn').addEventListener('click', () => switchTab('ranking'));

  // Tasks are legitimately mailbox-like (things sitting there to claim), so
  // the mail icon is a real shortcut now, not a placeholder — see
  // updateMailBadge() for the "how many are ready to claim" badge count.
  document.getElementById('mail-btn').addEventListener('click', () => switchTab('tasks'));

  // Honest placeholder — same tone as the Referral/Automine stubs in Extras:
  // "Chefs" is a future dedicated screen, not a reskinned Ranking shortcut,
  // so it shows the affordance and admits it's not built yet rather than
  // quietly aliasing to something else.
  document.getElementById('chefs-btn').addEventListener('click', () => toast('👨‍🍳 Chefs — coming soon.'));

  document.querySelectorAll('.bulk-work').forEach(b => b.addEventListener('click', () => setAllModes('work')));
  document.querySelectorAll('.bulk-rest').forEach(b => b.addEventListener('click', () => setAllModes('rest')));

  document.getElementById('fusion-auto').addEventListener('click', e => {
    const f = e.target.closest('[data-autofuse]');
    if (f) { autoFuse(f.dataset.autofuse, false); return; }
    const m = e.target.closest('[data-fusemax]');
    if (m) autoFuse(m.dataset.fusemax, true);
  });

  document.getElementById('sort-select').addEventListener('change', e => {
    sortMode = e.target.value;
    renderInventory();
  });

  document.getElementById('inventory-grid').addEventListener('click', e => {
    const c = e.target.closest('[data-select-hero]');
    if (c) selectInventoryHero(Number(c.dataset.selectHero));
  });

  document.getElementById('inventory-details').addEventListener('click', e => {
    if (e.target.closest('[data-close-details]')) { selectedInventoryHeroId = null; renderInventory(); return; }
    const t = e.target.closest('[data-toggle-id]');
    if (t) { toggleMode(Number(t.dataset.toggleId)); return; }
    const l = e.target.closest('[data-levelup-id]');
    if (l) { levelUp(Number(l.dataset.levelupId)); return; }
    const lab = e.target.closest('[data-lab-id]');
    if (lab) jumpToLabForReroll(Number(lab.dataset.labId));
  });

  document.getElementById('pack-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-pack]');
    if (b) buyPack(Number(b.dataset.pack));
  });

  document.getElementById('house-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-house]');
    if (b) buyHouse(b.dataset.house);
  });

  document.getElementById('fusion-grid').addEventListener('click', e => {
    const card = e.target.closest('[data-fuse-id]');
    if (card) toggleFusionSelect(Number(card.dataset.fuseId));
  });

  document.getElementById('tasks-body').addEventListener('click', e => {
    const b = e.target.closest('[data-task]');
    if (b) claimTask(b.dataset.task);
  });

  document.getElementById('modal-close').addEventListener('click', () => {
    cancelReveal();
    document.getElementById('modal-backdrop').classList.add('hidden');
  });
  document.getElementById('modal-backdrop').addEventListener('click', e => {
    if (e.target.id === 'modal-backdrop') {
      cancelReveal();
      e.target.classList.add('hidden');
    }
  });

  document.getElementById('modal-body').addEventListener('click', e => {
    if (e.target.closest('#reveal-next')) { advanceReveal(); return; }
    if (e.target.closest('#reveal-speed')) { toggleRevealSpeed(); return; }
    if (e.target.closest('#prestige-confirm-btn')) {
      doPrestige();
      document.getElementById('modal-backdrop').classList.add('hidden');
      return;
    }
    if (e.target.closest('#reveal-card')) advanceReveal();
  });

  document.getElementById('sleep-btn').addEventListener('click', toggleSleepMode);

  document.getElementById('reroll-select').addEventListener('change', updateRerollCost);
  document.getElementById('reroll-btn').addEventListener('click', () => {
    rerollHero(Number(document.getElementById('reroll-select').value));
  });

  document.getElementById('sac-target-select').addEventListener('change', renderSacVictims);
  document.getElementById('sac-victim-list').addEventListener('change', e => {
    if (e.target.classList.contains('sac-victim-cb')) updateSacPreview();
  });
  document.getElementById('sac-btn').addEventListener('click', () => {
    const targetId = Number(document.getElementById('sac-target-select').value);
    const victimIds = Array.from(document.querySelectorAll('.sac-victim-cb:checked')).map(cb => Number(cb.value));
    if (!victimIds.length) { toast('Select at least one hero to sacrifice.'); return; }
    sacrificeHeroes(victimIds, targetId);
    renderLab();
  });

  document.getElementById('breed-p1-select').addEventListener('change', updateBreedCost);
  document.getElementById('breed-p2-select').addEventListener('change', updateBreedCost);
  document.getElementById('breed-btn').addEventListener('click', () => {
    const p1 = Number(document.getElementById('breed-p1-select').value);
    const p2 = Number(document.getElementById('breed-p2-select').value);
    if (p1 === p2) { toast('Pick two different heroes to breed.'); return; }
    breedHeroes(p1, p2);
    renderLab();
  });

  document.getElementById('implant-select').addEventListener('change', updateImplantCost);
  document.querySelectorAll('input[name="implant-skill"]').forEach(r => r.addEventListener('change', updateImplantCost));
  document.getElementById('implant-btn').addEventListener('click', () => {
    const heroId = Number(document.getElementById('implant-select').value);
    const skill = document.querySelector('input[name="implant-skill"]:checked').value;
    implantSkill(heroId, skill);
    renderLab();
  });

  document.getElementById('ascend-target-select').addEventListener('change', renderAscendFodder);
  document.getElementById('ascend-fodder-list').addEventListener('change', e => {
    if (e.target.classList.contains('ascend-fodder-cb')) updateAscendPreview();
  });
  document.getElementById('ascend-btn').addEventListener('click', () => {
    const heroId = Number(document.getElementById('ascend-target-select').value);
    const fodderIds = Array.from(document.querySelectorAll('.ascend-fodder-cb:checked')).map(cb => Number(cb.value));
    if (fodderIds.length !== ASCEND_SACRIFICE_COUNT) { toast(`Select exactly ${ASCEND_SACRIFICE_COUNT} same-rarity heroes to consume.`); return; }
    ascendHero(heroId, fodderIds);
    renderLab();
  });

  document.getElementById('prestige-btn').addEventListener('click', showPrestigeConfirm);
  document.getElementById('upgrade-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-upgrade]');
    if (b) { buyUpgrade(b.dataset.upgrade); renderPrestige(); }
  });

  document.getElementById('ref-copy').addEventListener('click', () => {
    const link = `https://bombheroes.example/ref/${state.refCode}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(
        () => toast('Referral link copied (demo — leads nowhere).'),
        () => toast('Copy failed — link: ' + link)
      );
    } else {
      toast('Link: ' + link);
    }
  });

  const automine = document.getElementById('automine-select');
  automine.value = state.automine;
  automine.addEventListener('change', e => {
    state.automine = e.target.value;
    save();
    toast('Automine package set (cosmetic only in this MVP).');
  });

  document.getElementById('reset-btn').addEventListener('click', () => {
    if (confirm('Wipe all Bombfodase progress?')) {
      localStorage.removeItem(SAVE_KEY);
      location.reload();
    }
  });

  window.addEventListener('beforeunload', save);
}

/* ============ Init ============ */

const UI_PREF_KEY = 'bombheroes-ui';

// Same collapse mechanism the old side rail used (same localStorage key,
// same {collapsed} shape, same "defer layoutArena so the CSS transition
// finishes first" pattern) — just retargeted from the rail's WIDTH to the
// bottom nav's HEIGHT, since #arena-wrap now depends on how much vertical
// room #bottom-nav leaves it instead of how much horizontal room #side did.
function setBottomNavCollapsed(collapsed) {
  const nav = document.getElementById('bottom-nav');
  if (nav) nav.classList.toggle('collapsed', collapsed);
  const toggleBtn = document.getElementById('bottom-nav-toggle');
  if (toggleBtn) toggleBtn.textContent = collapsed ? '▲' : '▼';
  try { localStorage.setItem(UI_PREF_KEY, JSON.stringify({ collapsed })); } catch (e) {}
  setTimeout(layoutArena, 240);
}

function loadUiPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(UI_PREF_KEY));
    if (p && p.collapsed) setBottomNavCollapsed(true);
  } catch (e) {}
}

load();
document.getElementById('ref-code').textContent = `https://bombheroes.example/ref/${state.refCode}`;
loadUiPrefs();
bindEvents();
applyTheme(state.activeThemeId); // whichever theme rotation last landed on, persisted
// load() itself now guarantees gridTiles/tileHp are populated — either
// restored from the save (mid-wave resume) or freshly generated internally
// (new game / old save / offline-wave-advance) — so no separate genLayout()
// call is needed here anymore; buildArena() just renders whatever load() left.
buildArena();
syncActors();
renderAll();
setInterval(economyTick, 1000);
setInterval(aiTick, AI_MS);
