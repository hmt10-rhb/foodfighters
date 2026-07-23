'use strict';

/* ============ Config ============ */

const SAVE_KEY = 'foodfighters-save-v1';
// Brand rename (2026-07-22): "Bombfodase"/"Bomb Heroes" -> "Food Fighters".
// The OLD localStorage key below may still hold real player progress —
// renaming SAVE_KEY outright would silently orphan every existing save.
// One-time migration lives in load(): if the new key is empty but the old
// key has data, that old data is read and immediately re-saved under the
// new key (see load()'s very first lines). The old key is left in place
// afterward (harmless leftover), never deleted.
const OLD_SAVE_KEY = 'bombheroes-save-v1';
const EXCHANGE_RATE = 10;          // 10 Food Coins -> 1 Chef Gems
// ENERGY MODEL REWORK (2026-07-23): base rest recovery is now a fixed 1
// energy per MINUTE (was 0.25/s under the old continuous-drain model — a
// ~15x reduction) — houses and Cafeinado (see recoveryRateFor()) are the
// real recovery levers now, not the base rate itself. BASE_DRAIN (the old
// continuous per-tick energy cost while working) is RETIRED entirely:
// planting a bomb now costs a flat 1 energy instead (0 with Sustância's 20%
// chance) — see bombEnergyCost()/plantBomb(). Movement itself costs no
// energy at all.
const BASE_RECOVERY = 1 / 60;      // energy/s while resting (1 per minute), before house/Cafeinado bonuses
const OFFLINE_CAP_S = 8 * 3600;    // away-progress cap so a week offline doesn't print money
const MAX_WORKERS = 15;            // roster-wide cap on simultaneous fielded heroes
// LEGACY, Lab-compatibility only: this constant (and the h.ghost/h.swift
// boolean fields it rolls in makeHero()) exist purely so the Lab tab's
// re-roll/sacrifice/breeding/implant/ascension code — explicitly left
// untouched in this migration, per instruction — keeps working exactly as
// it always has (implant can still buy "ghost"/"swift", breeding can still
// inherit them). Live gameplay no longer drives ANY of its own skill logic
// off SKILL_CHANCE directly; see SKILL_ROLL_TABLE below for the real
// rarity-conditional Basic/Power system that governs Massa Leve/Cafeinado/
// Folhado de Ouro/Temperamental on freshly-created rangos. (h.ghost/h.swift
// ALSO still trigger their real gameplay effect for backward compatibility
// — see hasMassaLeve()/hasCafeinado() — so Lab's implant/breeding stay
// meaningfully useful, not just decorative dead flags.)
const SKILL_CHANCE = 0.07;

/* ===== MASTER MIGRATION: 6-tier rarity ladder, replacing the old 8-tier
   Common..Robadasso system entirely, per the user's master spec. =====
   RARITIES/RARITY_CONF deliberately KEEP their existing names (not renamed
   to e.g. RARIDADES) — Lab's re-roll/breeding/ascension code (left
   untouched per explicit instruction) reads them directly by these names;
   renaming the CONSTANTS would crash Lab, which the instruction explicitly
   says to avoid. Only the VALUES inside changed. Old rarity-name string
   literals still hardcoded inside untouched Lab code (e.g.
   ASCEND_MIN_RARITY further down still literally says 'Epic', a rarity
   that no longer exists) are a DELIBERATE, flagged exception — see
   canAscend() and the session report for why that was left exactly as-is
   rather than remapped to a new-tier equivalent. */
const RARITIES = ['CASEIRO', 'TEMPERADO', 'GOURMET', 'CHEF_RENOMADO', 'ESTRELA_MICHELIN', 'RECEITA_DE_VO'];

// ===== 5-STAT REWORK (2026-07-23): Poder/Speed/Tamanho/Bombas/Stamina =====
// Replaces the old power/range/speed/maxEnergy curve entirely. FIELD NAMES
// are deliberately KEPT where Lab (re-roll/sacrifice/ascension — untouched
// per standing instruction) reads them directly: `power` = Poder (now a
// literal flat damage value, no formula — see plantBomb()/effectivePower()),
// `speed` = Speed (now tiles/sec movement velocity — see the movement-budget
// accumulator in aiTick()/moveActor()), `range` = Tamanho (blast radius in
// tiles, uniform damage, no falloff — see explode()). Two GENUINELY NEW
// fields with no old equivalent: `bombas` (max simultaneous bombs a Rango
// can have live on the map — see h.bombCapacity in makeHero()/plantBomb())
// and `stamina` (drives maxEnergy = stamina*50 — see maxEnergyFor() below;
// maxEnergy is no longer a fixed per-rarity number, it's now itself a
// rolled-per-hero value derived from rolled stamina). rerollHero() (Lab,
// untouched) still re-rolls power/range/speed within these same bounds by
// name — it simply never touches bombas/stamina, which is fine (not a
// crash, just an untouched-per-instruction side effect).
const RARITY_CONF = {
  CASEIRO:          { label: 'Caseiro',          power: [1, 3],   speed: [1, 3],   range: [1, 1], bombas: [1, 1], stamina: [1, 3],   sigla: 'C' },
  TEMPERADO:        { label: 'Temperado',        power: [3, 5],   speed: [1, 5],   range: [1, 2], bombas: [1, 2], stamina: [3, 5],   sigla: 'T' },
  GOURMET:          { label: 'Gourmet',          power: [4, 9],   speed: [5, 9],   range: [1, 2], bombas: [1, 2], stamina: [5, 9],   sigla: 'G' },
  CHEF_RENOMADO:    { label: 'Chef Renomado',    power: [6, 11],  speed: [6, 11],  range: [2, 3], bombas: [2, 3], stamina: [6, 11],  sigla: 'CR' },
  ESTRELA_MICHELIN: { label: 'Estrela Michelin', power: [9, 15],  speed: [10, 15], range: [4, 4], bombas: [4, 5], stamina: [10, 15], sigla: 'ME' },
  RECEITA_DE_VO:    { label: 'Receita de Vó',    power: [14, 20], speed: [14, 20], range: [5, 6], bombas: [5, 6], stamina: [14, 20], sigla: 'VÓ' },
};
// maxEnergy is no longer a fixed RARITY_CONF number — it's derived from
// each hero's own ROLLED stamina (Stamina x 50). Every former
// `RARITY_CONF[h.rarity].maxEnergy` call site now calls this instead.
function maxEnergyFor(h) {
  return (h.stamina || 1) * 50;
}

function rLabel(r) { return (RARITY_CONF[r] && RARITY_CONF[r].label) || r; }
function rTag(r) { return (RARITY_CONF[r] && RARITY_CONF[r].tag) || r; }
// Inventory grid-card rarity badge (2026-07-23 UI rework): a SEPARATE lookup
// from rTag() on purpose — rTag() falls back to the raw enum key (a known,
// separate bug, fixed only at its one specific display site in
// renderInventoryDetails(), NOT here) and is still used as-is by other UI
// (e.g. the shop's rarity-badge odds list) that this rework must not touch.
// Sigla mapping is deliberate/confirmed, not simple initials (e.g. Estrela
// Michelin -> "ME", Receita de Vó -> "VÓ").
function rSigla(r) { return (RARITY_CONF[r] && RARITY_CONF[r].sigla) || r; }

// Save-migration only (see load()): maps a pre-migration hero's old rarity
// string onto its new-tier equivalent, using the exact same interpolation
// RARITY_CONF itself was built from.
const LEGACY_RARITY_MIGRATION = {
  Common: 'CASEIRO', Rare: 'TEMPERADO', Epic: 'GOURMET', Legendary: 'CHEF_RENOMADO',
  SuperLegendario: 'ESTRELA_MICHELIN', Imortal: 'ESTRELA_MICHELIN',
  Shiny: 'RECEITA_DE_VO', Robadasso: 'RECEITA_DE_VO',
};

/* ===== Picante — independent variant, NOT a 7th rarity (master spec #3) =====
   Any of the 6 rarities can independently roll Picante — rolled completely
   separately from the rarity roll itself, never affecting rarity odds or
   vice versa. NO visual treatment yet (explicitly deferred by the spec) —
   see PICANTE_VISUAL_PLACEHOLDER and applySpicyStatModifier() below. Uses
   `isSpicy: boolean` on the hero object (not `variant`, which is already
   the existing sprite-art-variant 0/1/2 field). */
const PICANTE_CHANCE_SHOP = 0.03;
const PICANTE_CHANCE_JAULA_NORMAL = 0.03;
const PICANTE_CHANCE_JAULA_MERCADO_NOTURNO = 0.30;
const PICANTE_VISUAL_PLACEHOLDER = 'PICANTE VISUAL — EM BREVE';
function rollPicante(chance) { return Math.random() < chance; }
// Future hook only — per the spec's own rule 40 ("don't invent the
// multiplier yet"), this deliberately applies ZERO stat effect right now.
// Structured so a later task can fill in a real bonus without touching any
// other call site: just change what this function returns.
function applySpicyStatModifier(rango) { return rango; }

/* ===== Skills — complete replacement of the old Phantom/Swift/Midas/
   Cataclysm system (master spec #4/#5), EXPANDED 2026-07-23 with 3 new
   Basic skills (Sustância/Espetinho/Al Dente) =====
   Power category is unchanged: Folhado de Ouro (+50% Food Coins) and
   Temperamental (chains to 5 random targets per explosion) — still exactly
   2, still "roll 1-of-2, then conditionally the other".
   Basic category is now 5 skills, not 2 — a genuine model change:
     - Massa Leve: phase through destructibles (walls/border still block).
     - Cafeinado: redefined 2026-07-23 — +1 energy/SECOND while resting
       (was a x2 multiplier; see recoveryRateFor()).
     - Sustância (NEW): 20% independent chance per bomb planted that it
       costs 0 energy instead of 1 (see bombEnergyCost()).
     - Espetinho (NEW): the blast pierces through Baús (T_CHEST only —
       Mesa Variável/Jaula still stop it normally) instead of stopping at
       the first one, up to the Tamanho/blast-radius limit or an
       indestructible obstacle (see explode()).
     - Al Dente (NEW): can walk onto/through bomb-occupied tiles (every
       other Rango is blocked by bombs by default — see canWalk()).
   FLAGGED ADAPTATION (2026-07-23, my own call — the user only said "5
   Basic skills now" without specifying how the old 1-of-2 roll should
   generalize): the SAME basic1/basic2 probability-by-rarity table below is
   kept exactly as-is (still "roll >=1 Basic" then "roll a 2nd, different,
   Basic"), but the skill CHOSEN is now picked uniformly from all 5 Basic
   options instead of a fixed pair, and the 2nd roll (if it hits) picks a
   DIFFERENT skill from the remaining 4 rather than "the other one of a
   pair" (there's no fixed pair anymore). Max simultaneous skills is still
   4 total (<=2 Basic + <=2 Power), never duplicated — the pool grew, the
   ceiling didn't. */
const BASIC_SKILLS = ['MASSA_LEVE', 'CAFEINADO', 'SUSTANCIA', 'ESPETINHO', 'AL_DENTE'];
const POWER_SKILLS = ['FOLHADO_DE_OURO', 'TEMPERAMENTAL'];
// maps a BASIC_SKILLS/POWER_SKILLS slug onto the boolean field name it sets
// on a hero object — used by rollSkillsForRarity() below so picking from a
// list of N skills doesn't need an N-way if/else chain
const SKILL_FIELD = {
  MASSA_LEVE: 'massaLeve', CAFEINADO: 'cafeinado', SUSTANCIA: 'sustancia',
  ESPETINHO: 'espetinho', AL_DENTE: 'alDente',
  FOLHADO_DE_OURO: 'folhadoDeOuro', TEMPERAMENTAL: 'temperamental',
};
const SKILL_DEFS = {
  MASSA_LEVE:      { category: 'BASIC', icon: '🥟', label: 'Massa Leve', text: 'O Rango fica leve como massa folhada e atravessa obstáculos quebráveis.' },
  CAFEINADO:       { category: 'BASIC', icon: '☕', label: 'Cafeinado', text: 'Cafeína pura. Esse Rango recupera 1 energia extra por segundo enquanto descansa.', energyPerSecondBonus: 1 },
  SUSTANCIA:       { category: 'BASIC', icon: '🍖', label: 'Sustância', text: 'Esse Rango está bem servido. Cada bomba tem 20% de chance de não consumir energia.', freeBombChance: 0.20 },
  ESPETINHO:       { category: 'BASIC', icon: '🍢', label: 'Espetinho', text: 'A explosão atravessa baús e continua avançando até atingir o limite do seu alcance ou um obstáculo indestrutível.' },
  AL_DENTE:        { category: 'BASIC', icon: '🍝', label: 'Al Dente', text: 'Esse Rango escorrega pelas próprias bombas e pode atravessá-las livremente.' },
  FOLHADO_DE_OURO: { category: 'POWER', icon: '🌟', label: 'Folhado de Ouro', text: 'Um tempero lendário transforma cada recompensa em algo ainda mais gostoso.', foodCoinMultiplier: 1.5 },
  TEMPERAMENTAL:   { category: 'POWER', icon: '🌶️', label: 'Temperamental', text: 'Cada explosão atinge também 5 alvos aleatórios em qualquer ponto da arena.', randomTargetsPerExplosion: 5 },
};
// Rarity-dependent two-step conditional roll, PER CATEGORY, independently.
// Process: roll "≥1 of this category" at basic1/power1; if it hits, grant
// ONE random skill from that category's options; THEN, only if that first
// roll succeeded, roll basic2/power2 — if it ALSO hits, grant a DIFFERENT
// skill from that category too (never the same one twice). If the first
// roll fails, skip straight to 0 skills in that category (never roll the 2nd).
const SKILL_ROLL_TABLE = {
  CASEIRO:          { basic1: 0.10, basic2: 0.02, power1: 0.00, power2: 0.00 },
  TEMPERADO:        { basic1: 0.30, basic2: 0.07, power1: 0.00, power2: 0.00 },
  GOURMET:          { basic1: 1.00, basic2: 0.20, power1: 0.00, power2: 0.00 },
  CHEF_RENOMADO:    { basic1: 1.00, basic2: 0.35, power1: 0.20, power2: 0.05 },
  ESTRELA_MICHELIN: { basic1: 1.00, basic2: 0.55, power1: 0.60, power2: 0.20 },
  RECEITA_DE_VO:    { basic1: 1.00, basic2: 0.75, power1: 1.00, power2: 0.50 },
};
function rollSkillsForRarity(rarity) {
  const t = SKILL_ROLL_TABLE[rarity];
  const skills = { massaLeve: false, cafeinado: false, sustancia: false, espetinho: false, alDente: false, folhadoDeOuro: false, temperamental: false };
  if (!t) return skills;
  if (Math.random() < t.basic1) {
    const first = pick(BASIC_SKILLS);
    skills[SKILL_FIELD[first]] = true;
    if (Math.random() < t.basic2) {
      const second = pick(BASIC_SKILLS.filter(s => s !== first));
      skills[SKILL_FIELD[second]] = true;
    }
  }
  if (Math.random() < t.power1) {
    const first = pick(POWER_SKILLS);
    skills[SKILL_FIELD[first]] = true;
    if (Math.random() < t.power2) {
      const second = pick(POWER_SKILLS.filter(s => s !== first));
      skills[SKILL_FIELD[second]] = true;
    }
  }
  return skills;
}
function hasMassaLeve(h) { return !!(h.massaLeve || h.ghost); } // h.ghost: legacy Lab-implant/breeding compatibility, see SKILL_CHANCE comment above
function hasCafeinado(h) { return !!(h.cafeinado || h.swift); } // h.swift: same legacy compatibility
function hasSustancia(h) { return !!h.sustancia; }
function hasEspetinho(h) { return !!h.espetinho; }
function hasAlDente(h) { return !!h.alDente; }
function hasFolhadoDeOuro(h) { return !!h.folhadoDeOuro; }
function hasTemperamental(h) { return !!h.temperamental; }

// ENERGY MODEL REWORK (2026-07-23): planting a bomb costs a flat 1 energy,
// or 0 if Sustância's independent 20% roll hits. Rolled fresh per bomb
// planted (not a fixed discount) — see plantBomb().
function bombEnergyCost(h) {
  if (hasSustancia(h) && Math.random() < SKILL_DEFS.SUSTANCIA.freeBombChance) return 0;
  return 1;
}
// Expected/average cost per bomb — used only by the offline economy
// estimate (simulate()), which can't roll a real per-bomb Sustância check
// for every individual planted bomb across an 8h window; this is the
// closed-form expected value instead (matches bombEnergyCost()'s long-run
// average exactly, same "closed-form estimate" spirit used elsewhere in
// this file's offline simulation).
function avgEnergyCostPerBomb(h) {
  return hasSustancia(h) ? (1 - SKILL_DEFS.SUSTANCIA.freeBombChance) : 1;
}

// every tier below the RECEITA_DE_VO ceiling can attempt fusion now — the
// risk table below is what keeps the top tier rare, not a hard block
const FUSABLE = RARITIES.slice(0, RARITIES.length - 1);
const FUSE_COST = 9;
// success odds per SOURCE rarity — monotonically decreasing, brutal at the
// top; remapped from the old 7-point (Common..Shiny) curve onto these 5
// fusable source tiers (RECEITA_DE_VO is the ceiling, never a fusion
// source), same "preserve what works" interpolation as RARITY_CONF above.
const FUSE_SUCCESS_CHANCE = {
  CASEIRO: 0.95,
  TEMPERADO: 0.80,
  GOURMET: 0.55,
  CHEF_RENOMADO: 0.25,
  ESTRELA_MICHELIN: 0.06,
};
// a successful fusion can leap +2 tiers instead of +1 (clamped at RECEITA_DE_VO)
const FUSE_BONUS_JUMP = 0.18;

/* ===== Supermercado (shop) rarity odds — master spec #6 =====
   ONE flat table now, no pack-size variation: the old system gave worse
   odds on a x1 pull and better odds on a x15 pull (buildOdds()/ULTRA_ODDS
   per pack-size arrays) — the new spec gives a single table with no
   pack-size mention at all, and explicitly forbids inventing new chances,
   so x1/x5/x10/x15 now differ ONLY in how many rolls you get, never in
   per-roll odds. Rolled via rollRarity() (the same generic weighted-random
   helper the Jaula table below also uses — see master spec #12). */
const SHOP_RARITY_WEIGHTS = {
  CASEIRO: 0.8287, TEMPERADO: 0.1036, GOURMET: 0.0518,
  CHEF_RENOMADO: 0.0104, ESTRELA_MICHELIN: 0.0052, RECEITA_DE_VO: 0.0004,
};
const PACKS = [
  { size: 1,  cost: 20 },
  { size: 5,  cost: 100 },
  { size: 10, cost: 200 },
  { size: 15, cost: 300 },
];

const HOUSES = [
  { id: 'tent',     name: 'Tiny Tent',      emoji: '⛺', cost: 200,  recovery: 0.2 },
  { id: 'cabin',    name: 'Brick Cabin',    emoji: '🏠', cost: 600,  recovery: 0.5 },
  { id: 'villa',    name: 'Bomb Villa',     emoji: '🏡', cost: 1500, recovery: 1.2 },
  { id: 'fortress', name: 'Blast Fortress', emoji: '🏰', cost: 4000, recovery: 3.0 },
];

const TASKS = [
  { id: 'own15',    name: 'Recruit 15 Rangos',                   reward: 500,  check: s => s.heroes.length >= 15 },
  { id: 'mine1000', name: 'Mine 1,000 Food Coins (all-time)',   reward: 750,  check: s => s.totalMined >= 1000 },
  { id: 'fuse1',    name: 'Fuse a Rango in the Fusão Culinária', reward: 1000, check: s => s.fusions >= 1 },
  { id: 'house1',   name: 'Buy any house',                      reward: 500,  check: s => HOUSES.some(h => s.houses[h.id] > 0) },
  // Judgment call: remapped from the old "Epic or better" (index 2 of 8) to
  // GOURMET or better (index 2 of 6) — same relative ladder position.
  { id: 'epic1',    name: 'Own a Gourmet or better Rango',       reward: 1500, check: s => s.heroes.some(h => RARITIES.indexOf(h.rarity) >= RARITIES.indexOf('GOURMET')) },
];
const TASKS_UNLOCK_HEROES = 15;

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
// Balance note (rebalance pass): mineRate() multiplies globalMineMult()
// (the tech tree's mining bonus) by each hero's own ascendMult() plus
// effectivePower() (inflated by Sacrifice's bonusPower) — independently-
// "reasonable-looking" permanent-progression axes that stack
// MULTIPLICATIVELY. Every constant below was retuned together (not in
// isolation) so that even a dedicated player maxing all of them only
// reaches a bounded combined multiplier over a realistic timeframe — see
// the "combined systems" test for the concrete numeric ceiling. Prestige
// used to be a 4th axis here (prestigeMult()) — removed entirely 2026-07-23
// per explicit user request ("pode excluir tudo sobre prestígio"), game and
// Obsidian both. The Global Upgrade Tree (UPGRADE_DEFS/buyUpgrade() below)
// stays fully working in code — state.upgrades.*, globalMineMult(),
// blastRadius(), cooldownTicks() all still read it — it's only the shop UI
// for IT that's been taken out (#upgrade-grid render call removed), pending
// a better home for it later.
const SLEEP_MODE_MULT = 0.15;       // offline earn rate while Sleep Mode is on
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
    activeThemeId: ACTIVE_THEME,
    // mapsInTheme (the old every-50-maps counter) is REMOVED (2026-07-22) —
    // theme rotation now rolls a random pick on every single wave-clear
    // instead of counting toward a threshold, so there's nothing left to
    // count. An old save may still carry a leftover mapsInTheme field after
    // Object.assign(defaultState(), raw) in load(); it's simply never read
    // by anything anymore (inert legacy baggage, not deleted from old saves).
    automine: 'none',
    refCode: 'FF-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    nextHeroId: 1,
    lastSeen: Date.now(),
    sleepMode: false,
    upgrades: { mining: 0, blast: 0, haste: 0 },
    skillShards: 0,
    breeds: 0,
    ascensions: 0,
  };
}

// Mid-wave resume: snapshot the LIVE grid (tile layout + per-tile HP +
// reward-slot counters, plus its mapSeed identity) into the save alongside
// the usual state fields, so a refresh/reopen restores the exact
// in-progress map instead of rolling a brand-new one. Built as a one-off
// snapshot object rather than attaching these onto `state` itself — `state`
// stays exactly the pure economy/meta object it's always been; the grid
// vars are a separate, module-level concern that only needs to travel
// THROUGH the save blob, not live on state in memory (see load(), which
// strips them back off after reading). Shared by BOTH save() (local
// localStorage) and pushCloudSave() (cloud `saves` row) — pushCloudSave()
// used to push the bare `state` object with none of this, which meant a
// cloud pull could never restore a mid-wave map at all, even once
// pullCloudSave()'s restore LOGIC was fixed (2026-07-23, master spec #1/#5).
function saveSnapshot() {
  return Object.assign({}, state, { gridTiles, tileHp, cratesLeft, cratesTotal });
}

function save() {
  state.lastSeen = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(saveSnapshot()));
}

// Set true only inside load()'s brand-new-game branch (no valid local save
// found at all — first-ever load, or localStorage/cookies wiped) and false
// otherwise. BUG FIX (2026-07-23, master spec #1/#5): that branch's own
// save() call stamps state.lastSeen to Date.now() (i.e. "right now"), which
// would make a freshly-generated EMPTY game always look newer than any real
// cloud save no matter how old the cloud data actually is — permanently
// hiding a logged-in player's real progress behind a blank slate every time
// local storage is empty/cleared. pullCloudSave() OR's this flag into its
// "cloud wins" decision instead of trusting the timestamp comparison alone
// in that specific case, which is also what makes the cloud genuinely
// authoritative for a logged-in player after a wipe (master spec #5).
let localFreshOnBoot = false;

// Shared by load() (local save) and pullCloudSave() (cloud save) — restores
// the exact persisted grid (mid-wave resume) when it's valid AND belongs to
// the CURRENT wave, otherwise falls back to generating a fresh map. Used to
// be duplicated: pullCloudSave() had its own, worse version that just called
// bare genLayout() unconditionally on every cloud-wins pull, discarding any
// in-progress map even when the persisted grid was perfectly valid (master
// spec #1, urgent). raw's mapSeed (if present) is carried through as-is,
// since restoring is explicitly NOT rolling a new map — genLayout() itself
// is the only place a fresh mapSeed ever gets stamped (master spec #5).
function restoreOrGenerateGrid(raw, waveAtSave) {
  const validGridTiles = Array.isArray(raw.gridTiles) && raw.gridTiles.length === G_ROWS &&
    raw.gridTiles.every(row => Array.isArray(row) && row.length === G_COLS &&
      row.every(v => Number.isInteger(v) && v >= 0 && v <= 5));
  const validTileHp = raw.tileHp && typeof raw.tileHp === 'object' && !Array.isArray(raw.tileHp) &&
    Object.values(raw.tileHp).every(box => box && typeof box.hp === 'number' && typeof box.max === 'number');
  if (state.wave === waveAtSave && validGridTiles && validTileHp) {
    gridTiles = raw.gridTiles.map(row => row.slice());
    tileHp = Object.assign({}, raw.tileHp);
    cratesLeft = typeof raw.cratesLeft === 'number' ? raw.cratesLeft : 0;
    cratesTotal = typeof raw.cratesTotal === 'number' ? raw.cratesTotal : cratesLeft;
    // old saves/cloud rows from before this field existed simply don't have
    // one yet — genLayout() will stamp a fresh mapSeed the next time a real
    // new map actually rolls, so this is never left permanently missing
    if (typeof raw.mapSeed === 'string') state.mapSeed = raw.mapSeed;
    return true;
  }
  genLayout();
  return false;
}

// Factored out of load()'s brand-new-game branch so the reset button can
// reuse the exact same bootstrap (see reset-btn handler in bindEvents) —
// duplicating this by hand there was the real risk, not the extraction.
function newGameState() {
  state = defaultState();
  for (let i = 0; i < 3; i++) state.heroes.push(makeHero('CASEIRO'));
  genLayout(); // brand-new game: no persisted grid to restore, roll one
  waveRegen = false;
  localFreshOnBoot = true; // see this flag's own comment — pullCloudSave() needs to know this wasn't a real returning save
}

function load() {
  // One-time brand-rename migration (2026-07-22): if the new key is empty
  // but the OLD key still holds real player data, adopt it under the new
  // key before anything else ever reads SAVE_KEY — same graceful-migration
  // pattern used for every other save-shape change in this function. The
  // old key is left in place afterward (harmless leftover), never deleted.
  try {
    if (localStorage.getItem(SAVE_KEY) === null) {
      const oldRaw = localStorage.getItem(OLD_SAVE_KEY);
      if (oldRaw !== null) localStorage.setItem(SAVE_KEY, oldRaw);
    }
  } catch (e) {}
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) { raw = null; }
  if (!raw || !Array.isArray(raw.heroes)) {
    newGameState();
    save();
    return;
  }
  localFreshOnBoot = false;
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
  syncActiveSpawnConfig(); // keep ACTIVE_SPAWN_CONFIG in step with whatever theme just got validated/defaulted above
  // saves from before the sprite/skill/meta/portrait systems get defaults assigned once
  for (const h of state.heroes) {
    if (typeof h.variant !== 'number') h.variant = randInt(0, 2);
    if (typeof h.character !== 'string' || !HERO_CHARACTERS.includes(h.character)) h.character = pick(HERO_CHARACTERS);
    // rarity master migration: a save from before this pivot carries an OLD
    // rarity string (Common/Rare/Epic/Legendary/SuperLegendario/Imortal/
    // Shiny/Robadasso) that no longer exists in RARITY_CONF at all — mapped
    // onto its new-tier equivalent using the exact same "preserve what
    // works" interpolation used to build RARITY_CONF itself, so an existing
    // roster doesn't crash (RARITY_CONF[h.rarity] would be undefined) or
    // silently lose its relative power position.
    if (!RARITY_CONF[h.rarity]) h.rarity = LEGACY_RARITY_MIGRATION[h.rarity] || 'CASEIRO';
    h.ghost = !!h.ghost;
    h.swift = !!h.swift;
    // migration for saves from before the rarity/skill master migration —
    // old heroes get the new fields defaulted to "off" rather than rolled
    // retroactively (rolling them now would be indistinguishable from a
    // free stealth buff to every existing save on load)
    h.isSpicy = !!h.isSpicy;
    h.massaLeve = !!h.massaLeve;
    h.cafeinado = !!h.cafeinado;
    // 3 genuinely NEW Basic skills (2026-07-23 stat-system rework) — same
    // "default to off, never retroactively rolled" migration philosophy as
    // massaLeve/cafeinado above (rolling them now would be a free stealth
    // buff to every existing save on load).
    h.sustancia = !!h.sustancia;
    h.espetinho = !!h.espetinho;
    h.alDente = !!h.alDente;
    h.folhadoDeOuro = !!h.folhadoDeOuro;
    h.temperamental = !!h.temperamental;
    h.bonusPower = h.bonusPower || 0;
    h.ascendCount = h.ascendCount || 0;
    // STAT-SYSTEM REWORK migration (2026-07-23): power/range/speed used
    // completely different, incompatible ranges before this rework (e.g.
    // the old RECEITA_DE_VO power was 3000-5000; Poder for the same rarity
    // is now 14-20) — unlike the skill flags above, leaving an old hero's
    // stats as-is would NOT be a safe/conservative migration, it would be an
    // actively broken value under the new flat-damage model (a returning
    // player's old hero could have Poder in the THOUSANDS while every fresh
    // hero of the same rarity rolls under 20). Any hero missing the two
    // genuinely-new fields (bombCapacity/stamina) predates this rework
    // entirely, so power/range/speed are re-rolled fresh under the NEW
    // ranges alongside them — a real, necessary unit conversion, not a
    // stealth buff (the skill flags above are the ones that stay
    // conservative; stats are a different case because the OLD numbers are
    // simply incompatible, not just "missing a new bonus").
    if (typeof h.bombCapacity !== 'number' || typeof h.stamina !== 'number') {
      const rc = RARITY_CONF[h.rarity];
      h.power = randInt(rc.power[0], rc.power[1]);
      h.range = randInt(rc.range[0], rc.range[1]);
      h.speed = randInt(rc.speed[0], rc.speed[1]);
      h.bombCapacity = randInt(rc.bombas[0], rc.bombas[1]);
      h.stamina = randInt(rc.stamina[0], rc.stamina[1]);
    }
    // clamp in case an old save's stored energy exceeds the new
    // stamina-derived max (e.g. an old high-maxEnergy rarity's leftover
    // energy value, now under a much smaller stamina*50 ceiling)
    h.energy = Math.min(typeof h.energy === 'number' ? h.energy : 0, maxEnergyFor(h));
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
      if (mined >= 1) toast(`💤 Sleep Mode: your Rangos mined ${fmtCurrency(mined)} Food Coins while you were away.`);
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
  // for every other new save field so far. Shared with pullCloudSave() via
  // restoreOrGenerateGrid() (see its own comment) — was duplicated inline
  // here before, with pullCloudSave() carrying a worse, buggy copy.
  waveRegen = false;
  restoreOrGenerateGrid(raw, waveAtSave);
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
  // new rarity-conditional Basic/Power skill roll (master spec #5) — applies
  // at every hero creation site (shop, jaula, fusion, breeding), independent
  // of the legacy ghost/swift roll below (which exists only for Lab compat)
  const skills = rollSkillsForRarity(rarity);
  const stamina = randInt(c.stamina[0], c.stamina[1]); // rolled once, reused for both the stored stat and the starting/max energy
  return {
    id: state.nextHeroId++,
    name: nameForCharacter(character),
    emoji: pick(HERO_EMOJI),
    rarity,
    variant: randInt(0, 2),
    character,
    // Picante (master spec #3) is rolled INDEPENDENTLY by the CALLER, not
    // here — shop and jaula each have their own different chance (3% vs
    // 3%/30%), and other creation paths (fusion, breeding) don't roll it at
    // all per the spec, so this always starts false and gets set after the
    // fact by whichever call site actually rolls for it (see rollPicante()).
    isSpicy: false,
    ghost: Math.random() < SKILL_CHANCE,  // legacy Lab-compatibility flag — see SKILL_CHANCE comment
    swift: Math.random() < SKILL_CHANCE,  // legacy Lab-compatibility flag — see SKILL_CHANCE comment
    massaLeve: skills.massaLeve,
    cafeinado: skills.cafeinado,
    sustancia: skills.sustancia,
    espetinho: skills.espetinho,
    alDente: skills.alDente,
    folhadoDeOuro: skills.folhadoDeOuro,
    temperamental: skills.temperamental,
    power: randInt(c.power[0], c.power[1]),       // Poder — flat direct damage per hit
    range: randInt(c.range[0], c.range[1]),       // Tamanho — blast radius in tiles
    speed: randInt(c.speed[0], c.speed[1]),       // Speed — tiles moved per second
    bombCapacity: randInt(c.bombas[0], c.bombas[1]), // Bombas — max simultaneous bombs (NEW)
    stamina,                                          // Stamina — drives maxEnergy = stamina*50 (NEW)
    level: 1,
    energy: stamina * 50, // starts at max (maxEnergyFor(h) === stamina*50)
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
  return 1 + (state.upgrades.mining || 0) * 0.01;
}

// Generic weighted-random rarity roll — reused for BOTH the shop
// (SHOP_RARITY_WEIGHTS) and the jaula (JAULA_RARITY_WEIGHTS) tables, per
// master spec #12 ("one generic weighted-random roll helper... no
// duplicated if/else chains"). Not referenced by any Lab (re-roll/
// sacrifice/breeding/implant/ascension) code, so safe to touch freely.
function rollRarity(odds) {
  let r = Math.random();
  for (const rarity of RARITIES) {
    r -= odds[rarity];
    if (r <= 0) return rarity;
  }
  return 'CASEIRO';
}

// LEVELING PROPOSAL (2026-07-23 stat-system rework — this is MY OWN design
// call, not something the user specified; flag for their review/adjustment).
// With Poder now a flat direct-damage stat instead of a formula input,
// leveling needs its own explicit combat bonus to stay meaningful. Chose
// +10%/level (capping at +90% at MAX_LEVEL=10) as a "preserve what works"
// echo of the old mineRate() formula's +25%/level term, toned down since
// it's now a much more directly-felt multiplier on real per-hit damage,
// not one term among several in an abstract currency-conversion formula.
// Deliberately kept SEPARATE from effectivePower() (which Sacrifice/Lab
// code reads directly for dust calculations — untouched per standing
// instruction) so this bonus never silently leaks into Lab's own formulas.
const LEVEL_POWER_BONUS_PER_LEVEL = 0.10;
// BUG FIX (2026-07-23, self-caught during test-suite verification): the
// Mining Boost tech-tree upgrade (globalMineMult(), state.upgrades.mining)
// and per-hero Ascension (ascendMult(), h.ascendCount) both used to
// multiply the OLD mineRate() formula — i.e. they were the real damage/
// mining-rate multiplier that made buying Mining Boost or Ascending a hero
// actually DO anything. Retiring mineRate() as a damage source in favor of
// combatPower()/squadDamagePerSecond() silently dropped both of them —
// Lab/Ascension are explicitly "don't touch/break" systems, and a
// live Mining Boost upgrade that does nothing counts as broken even though
// nothing crashes. Folding both back in here (not into effectivePower(),
// same reasoning as the leveling bonus above — keep Sacrifice's dust-yield
// formula untouched) restores them as real multipliers on actual per-hit
// damage, same functional role they always had.
function combatPower(h) {
  return effectivePower(h) * (1 + LEVEL_POWER_BONUS_PER_LEVEL * (h.level - 1)) * ascendMult(h) * globalMineMult();
}

// RETIRED as a damage/reward source (2026-07-23 stat rework): Poder is now
// literally how much HP a bomb hit removes (see plantBomb(), which uses
// combatPower(h) directly) — no formula multiplier anymore. Verified this
// is safe: chest/jaula rewards come from CHEST_TIER_REWARD_RANGE's own
// fixed random roll in destroyTile(), completely independent of hero
// stats, and Folhado de Ouro's +50% applies to THAT roll, never to this
// function's output — so nothing else depended on the old formula for real
// damage or reward math. Kept (repurposed, not deleted) purely as a
// DISPLAY convenience, since many UI panels still reference it by this
// name — see squadDamagePerSecond() below, which now defines the real
// "combat damage per second" value this delegates to.
function mineRate(h) {
  return squadDamagePerSecond(h);
}

// ENERGY MODEL REWORK (2026-07-23): Stamina drives maxEnergy (stamina*50 —
// see maxEnergyFor()) and planting a bomb now costs a FLAT 1 energy (0 with
// Sustância's 20% chance — see bombEnergyCost()), not a continuous
// per-tick drain while working. drainRate()/BASE_DRAIN are RETIRED
// entirely — verified nothing else references them (the only 2 call sites,
// simulate()'s offline budget and economyTick()'s per-tick loop, are both
// reworked alongside this). Resting recovery is now a much smaller FIXED
// base rate — 1 energy per MINUTE, not per second — with houses and
// Cafeinado (redefined: +1 energy/SECOND while resting, a large, dominant
// bonus vs the tiny base by design) as the real levers.
function recoveryRate() {
  return BASE_RECOVERY + HOUSES.reduce((sum, hs) => sum + hs.recovery * state.houses[hs.id], 0);
}

// Cafeinado's real effect (redefined 2026-07-23): +1 energy/SECOND while
// resting — an ADDITIVE flat bonus now, not the old x2 multiplier (that
// multiplier model doesn't make sense against a base rate this tiny; a flat
// bonus is what the user's own wording describes: "+1 energia por
// segundo"). Applied on top of the shared house-driven recoveryRate().
function recoveryRateFor(h) {
  return recoveryRate() + (hasCafeinado(h) ? 1 : 0);
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
  let minedTotal = 0;
  let damageBudget = 0;

  // ENERGY MODEL REWORK (2026-07-23): energy is no longer spent via a
  // continuous per-second drain while working — it's spent in flat
  // per-bomb amounts (1, or 0 with Sustância's 20% chance — see
  // avgEnergyCostPerBomb()). "workable" here mirrors that: how many bombs
  // can this hero's current energy afford, times how long each bomb cycle
  // takes (hitCycleSeconds) — same overall workable-then-rest structure the
  // offline model always used, just re-derived for the new cost model
  // instead of the old continuous drainRate().
  for (const h of state.heroes) {
    const maxE = maxEnergyFor(h);
    const rec = recoveryRateFor(h); // Cafeinado's +1/s flat recovery bonus, per hero
    if (h.mode === 'work') {
      const costPerBomb = avgEnergyCostPerBomb(h);
      const bombsAffordable = h.energy / costPerBomb;
      const workable = bombsAffordable * hitCycleSeconds(h);
      const t = Math.min(seconds, workable);
      damageBudget += squadDamagePerSecond(h) * rateMult * t;
      const bombsSpent = t / hitCycleSeconds(h);
      h.energy -= bombsSpent * costPerBomb;
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
  // avgReward(t): master spec #8 replaced the old HP x CHEST_WORTH_S formula
  // with a FIXED reward RANGE per tier — offline simulate() can't roll the
  // per-kill randomBetween() the live game does, so it uses the range's
  // midpoint as its expected-value stand-in (matches the live long-run
  // average exactly, same "closed-form estimate" spirit as everything else
  // in this function).
  function avgReward(t) {
    const [rMin, rMax] = CHEST_TIER_REWARD_RANGE[t];
    return (rMin + rMax) / 2;
  }
  const tierCount = {};
  let totalWaveHP = 0, totalWaveWorth = 0;
  for (const t of CHEST_TIERS) {
    const cnt = (tierWeights[t] || 0) * tiles;
    tierCount[t] = cnt;
    const hp = CHEST_TIER_HP[t];
    totalWaveHP += cnt * hp;
    totalWaveWorth += cnt * avgReward(t);
  }
  totalWaveWorth *= mult;
  if (totalWaveHP > 0.0001 && damageBudget > 0.0001) {
    const fullBags = Math.floor(damageBudget / totalWaveHP);
    minedTotal += fullBags * totalWaveWorth;
    damageBudget -= fullBags * totalWaveHP;
    wave += fullBags;

    // Remainder pass (< one full wave-bag of damage left): spend it on the
    // CHEAPEST tiers first, not at the wave's blended average HP. A flat
    // average is dominated by rare-but-huge tiers (VIP=2000 HP) even at a
    // tiny spawn weight, which would otherwise zero out a weak/fresh squad's
    // ENTIRE offline income once every tier became eligible from wave 1.
    // Real live play doesn't work this way either: heroes path to nearby/
    // reachable easy targets, they are never forced to crack the wave's one
    // huge chest before earning anything — this mirrors that. Walk tiers
    // cheapest-to-priciest and greedily fill from what this bag actually
    // contains (tierCount[t]), so it can never "sell" more kills than the
    // bag has of that tier.
    const cheapestFirst = CHEST_TIERS.slice().sort((a, b) => CHEST_TIER_HP[a] - CHEST_TIER_HP[b]);
    for (const t of cheapestFirst) {
      if (damageBudget <= 0.0001) break;
      const hp = CHEST_TIER_HP[t];
      const available = tierCount[t];
      if (!available || hp <= 0) continue;
      const affordable = Math.floor(damageBudget / hp);
      const kills = Math.floor(Math.min(available, affordable));
      if (kills <= 0) continue;
      minedTotal += kills * avgReward(t) * mult;
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

// The real "combat damage per second" value — combatPower(h) (Poder +
// leveling bonus, no other formula) spread across a full bomb cycle
// (cooldown + fuse time). mineRate() is now just an alias for this (see its
// own comment) — fixed here to call combatPower() directly instead of the
// circular mineRate()->squadDamagePerSecond()->mineRate() loop that would
// otherwise infinite-recurse.
function squadDamagePerSecond(h) {
  return combatPower(h) / hitCycleSeconds(h);
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
  // ENERGY MODEL REWORK (2026-07-23): working heroes no longer drain energy
  // continuously here at all — energy is only ever spent in flat per-bomb
  // amounts (see bombEnergyCost()/plantBomb(), driven from aiTick() on its
  // own 500ms cycle). This 1-second tick's only remaining energy job is
  // resting recovery.
  for (const h of state.heroes) {
    if (h.mode !== 'work') {
      const maxE = maxEnergyFor(h);
      h.energy = Math.min(maxE, h.energy + recoveryRateFor(h));
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
  // "Opção B" (2026-07-22): a genuinely SECOND, DISTINCT theme entry for the
  // SAME Jardim Fresquinho world, built from real pre-sliced art (border
  // strips + floor tiles) instead of the CSS-recreated approximation above —
  // meant to sit side by side with jardim_fresquinho for visual comparison,
  // not replace it. Deliberately reuses the IDENTICAL background image
  // (same bg path) so the only variable between the two is border/floor
  // rendering technique. See style.css's `.theme-jardim-fresquinho-sliced`
  // block for the actual border-image/floor-checkerboard CSS.
  jardim_fresquinho_sliced: {
    name: 'Jardim Fresquinho',
    bg: 'assets/themes/jardim_fresquinho/jardim_fresquinho_bg.png',
    className: 'theme-jardim-fresquinho-sliced',
  },
};
// Explicit rotation ORDER — the user's eventual full list (Cozinha Real,
// Forno Vulcânico, Freezer Congelado, Mercado Noturno, Ilha do Sushi,
// Fazenda Crocante, Fast Food City, Castelo do Banquete, Confeitaria
// Bonanza) isn't built yet, so only the two Jardim Fresquinho variants are
// registered here — deliberately NOT fabricating placeholder entries for
// ids that don't exist as real themes yet. With 2 real ids now (as of
// 2026-07-22), rotation genuinely alternates between them every 50 cleared
// maps (see waveClear()) instead of looping on itself — the infinite-loop
// wraparound (back to the first entry after the last) is now actually
// exercised for the first time, not just a defensive no-op for a 1-entry list.
const THEME_ROTATION = ['jardim_fresquinho', 'jardim_fresquinho_sliced'];
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
// T_CRATE (2026-07-23 cleanup): kept as a DECLARED-BUT-UNUSED constant
// rather than deleted+renumbered. It's confirmed dead — seedCrates() never
// places it in any real generated map, and every reference to it in game
// LOGIC has been removed below (isDestructible(), tileClassFor()). It's
// left declared, at its original numeric slot, specifically so nothing
// ever has to renumber T_CHEST/T_JAULA/T_OBSTACLE: renumbering is real risk
// for zero benefit here — anything that hardcoded a raw tile number instead
// of the named constant (a real possibility in code I haven't audited every
// corner of, and an even bigger risk for any persisted/serialized save data
// that stored these as plain numbers) would silently break. Leaving the
// slot reserved and simply never assigning it is the safe version of "gone."
const T_WALL = 0, T_FLOOR = 1, T_CRATE = 2, T_CHEST = 3, T_JAULA = 4, T_OBSTACLE = 5;
// true only for tiles with HP that can be bombed open for a reward. Mesa
// Variável (T_OBSTACLE) is DESTRUCTIBLE now — master spec #9 explicitly
// calls for it to be breakable, phaseable-through by Massa Leve, and a
// valid Temperamental chain target, which requires real trackable HP. This
// is a genuine behavior CHANGE from the prior build (where it was a
// permanent, indestructible obstacle) — flagged in the session report,
// since the spec's own wording ("confirm it's destructible") reads as if
// this were already true, which it wasn't; per the ABSOLUTE PRIORITY RULE
// the spec wins over the existing implementation on this conflict. HP/
// reward for Mesa Variável aren't given explicit numbers anywhere in the
// spec (only the 5 named chest tiers get one) — see MESA_VARIAVEL_HP below
// for the flagged judgment call on what to use instead of inventing an
// unlisted reward.
// T_CRATE deliberately excluded (2026-07-23 cleanup) — it's a dead tile
// value (see its own comment above), never placed by seedCrates(), so it
// was never a real destructible in practice; removing it here is pure
// cleanup; every other type is unchanged.
function isDestructible(t) { return t === T_CHEST || t === T_JAULA || t === T_OBSTACLE; }
// true for anything that PERMANENTLY blocks movement + bomb blast: only the
// 136 fixed Mesa Fixa tables now (T_WALL) — Mesa Variável moved to
// isDestructible() above (it still blocks movement/blast UNTIL destroyed,
// same as any other destructible; it just doesn't block FOREVER anymore).
function isBlockingObstacle(t) { return t === T_WALL; }
// User correction (2026-07-22): set to 1 HP flat — Mesa Variável breaks on
// ANY single hit, regardless of the hitting hero's damage, not just "the
// cheapest tier" as the earlier 30 HP judgment call had it. Still pays NO
// Food Coins reward on its own (the spec's reward numbers are explicitly
// scoped to the 5 named chest tiers only; inventing a 6th reward figure for
// Mesa Variável isn't licensed by the doc). It exists to be cleared
// instantly for pathing/board-opening purposes and as a valid Temperamental
// chain target, not as a currency source.
const MESA_VARIAVEL_HP = 1;

/* ===== Jaula — replaces the old "Baú Especial" chest tier entirely (master
   spec #7). Grants exactly 1 Rango (not Food Coins) on destruction — this
   IS the old jail/hero-granting mechanic, fully renamed and re-tuned. =====
   RESOLVED CALL, FLAGGED FOR USER CONFIRMATION: the old wave-based "soft
   pity"/drought system (JAIL_PITY_BASE/MAX/TAU, jailPityChance()) is REMOVED
   in favor of these flat per-map percentages. The spec doesn't mention a
   pity/drought mechanic at all — it gives explicit flat chances (1% normal,
   50% Mercado Noturno) that read as the actual intended mechanic, and
   keeping both systems at once would mean inventing an unspecified
   interaction between them. Implemented as primary per the literal spec;
   please confirm this call is correct. */
const JAULA_HP = 1500;
const JAULA_SPAWN_CHANCE_NORMAL = 0.01;
const JAULA_SPAWN_CHANCE_MERCADO_NOTURNO = 0.50;
// Not yet a real registered theme (see THEMES/THEME_ROTATION further up —
// deliberately not fabricating placeholder theme assets/entries that don't
// exist yet), but this IS the concrete trigger condition master spec #9
// asks for: "when the active theme is Mercado Noturno, use these special
// jaula rates." The check below simply never fires until a real Mercado
// Noturno theme is registered — the WIRING is complete and ready now,
// which is what was actually being asked for.
const MERCADO_NOTURNO_THEME_ID = 'mercado_noturno';
function isMercadoNoturnoActive() { return state.activeThemeId === MERCADO_NOTURNO_THEME_ID; }
function jaulaSpawnChance() { return isMercadoNoturnoActive() ? JAULA_SPAWN_CHANCE_MERCADO_NOTURNO : JAULA_SPAWN_CHANCE_NORMAL; }
function jaulaPicanteChance() { return isMercadoNoturnoActive() ? PICANTE_CHANCE_JAULA_MERCADO_NOTURNO : PICANTE_CHANCE_JAULA_NORMAL; }
// Separate, much richer rarity table than the shop (master spec #7) — rolled
// via the same generic rollRarity() helper used for the shop table.
const JAULA_RARITY_WEIGHTS = {
  CASEIRO: 0.2500, TEMPERADO: 0.2526, GOURMET: 0.3518,
  CHEF_RENOMADO: 0.1300, ESTRELA_MICHELIN: 0.0146, RECEITA_DE_VO: 0.0010,
};

// FUSE_TICKS=7 (2026-07-23): bombs now take exactly 7 * AI_MS(500ms) = 3.5s
// to explode after being planted (was 3 ticks = 1.5s) — a clean integer
// tick count, no rounding needed.
const AI_MS = 500, FUSE_TICKS = 7;
// This N-seconds-of-idle-mineRate-driven payout formula no longer applies
// to the 5 named chest tiers (see CHEST_TIER_REWARD_RANGE below, master
// spec #8 — those are now fixed reward RANGES, not an HP-derived formula)
// or to Jaula (grants a Rango, not currency) or to Mesa Variável (pays
// nothing at all — see MESA_VARIAVEL_HP above). CHEST_WORTH_S itself is
// vestigial now too (referenced only in comments below, never read by real
// code) but is left as-is — out of scope for this cleanup, which is
// specifically about the dead T_CRATE tile type.
// CRATE_WORTH_S REMOVED (2026-07-23 cleanup): it existed only to price a
// plain "Caixa" (T_CRATE) tile's reward — T_CRATE is confirmed dead
// (seedCrates() never places it; see its own comment at the tile-constant
// declaration), so this constant was never actually read by any live code
// path either.
const CHEST_WORTH_S = 10;
// Folhado de Ouro skims +50% Food Coins on anything its bombs break (same
// bonus as the old Midas); Temperamental chains each blast to 5 extra random
// valid targets at NORMAL hit damage (UP from the old Cataclysm's 3, per
// master spec #4) — bounded fan-out, not striking the whole board.
const FOLHADO_DE_OURO_BONUS = 1.5;
const TEMPERAMENTAL_CHAIN = 5;
// Core-loop RNG: both are EV-neutral by construction, added for feel/variance
// rather than to quietly re-buff the rebalanced power curve.
const CRIT_CHANCE = 0.12, CRIT_MULT = 1.75;
const CRIT_NORMAL_MULT = (1 - CRIT_CHANCE * CRIT_MULT) / (1 - CRIT_CHANCE);
const PAYOUT_VARIANCE = 0.175; // ±17.5%, uniform, mean exactly 1x
const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

let gridTiles = [], tileEls = [], cratesLeft = 0, cratesTotal = 0, waveRegen = false;
let tileHp = {};

/* ============ Chests + per-wave variable generation ============ (master spec #8)
   5 tiers now, not 6 — "especial" became Jaula (see above), no longer a
   Food-Coin-granting chest tier at all. Chest HP AND reward are both now
   FIXED numbers straight from the spec — CHEST_TIER_REWARD_RANGE fully
   REPLACES the old HP x CHEST_WORTH_S x tier-multiplier formula; reward is
   `randomBetween(min, max)` uniformly, decimals preserved (never rounded to
   an integer). This is a drastically smaller reward scale than the rest of
   the current economy (shop/upgrade/re-roll costs are in the hundreds-to-
   thousands) — per explicit instruction relayed with the spec, implemented
   exactly as given anyway, NOT rescaled to compensate; that's a separate
   future ask. See fmt()/floatLabel() for the small-decimal display fix this
   required. */
const CHEST_TIERS = ['MADEIRA', 'FERRO', 'OURO', 'DIAMANTE', 'VIP'];
const CHEST_TIER_HP = { MADEIRA: 70, FERRO: 150, OURO: 600, DIAMANTE: 1100, VIP: 2000 };
const CHEST_TIER_REWARD_RANGE = {
  MADEIRA: [0.01, 0.02],
  FERRO: [0.03, 0.05],
  OURO: [0.16, 0.25],
  DIAMANTE: [0.40, 1.00],
  VIP: [0.40, 3.00],
};
const CHEST_TIER_ICON = {
  MADEIRA: 'bau_madeira', FERRO: 'bau_ferro', OURO: 'bau_ouro',
  DIAMANTE: 'bau_diamante', VIP: 'bau_vip',
};
function randomBetween(min, max) { return min + Math.random() * (max - min); }
// Wave-gating from an earlier round stays removed — every tier is eligible
// from wave 1, governed purely by rarityLimits' min/max RNG below.

// Balance pass (2026-07-23): both configs below reworked to the final
// numbers worked out with the user across several messages, using
// expected-value economy math to confirm balance. Data-only change — no
// generation/distribution logic touched (see getChestLimits()/
// rollChestTierCounts() below, both unmodified). Feasibility re-verified for
// both configs at the new scale (original numbers, before the density-bump
// below): for normalMapSpawnConfig, sum(rarityLimits.min) = 12+6+3+0+0 = 21
// <= chests.absoluteMin (26), so rollChestTierCounts() can always satisfy
// every tier's minimum even at the smallest realistic chest count;
// sum(rarityLimits.max) = 36+21+21+6+3 = 87 comfortably exceeds
// chests.absoluteMax (61). Same check for nightKitchenSpawnConfig below its
// own definition.
//
// Density bump (2026-07-23, second pass): normalMapSpawnConfig's numbers
// below were raised again per a confirmed follow-up decision — validated
// first as a read-only what-if simulation (1000-run audit calling the real
// getChestLimits()/rollChestTierCounts() with this exact config object,
// never written to the file until confirmed) before landing here for real.
// That simulation showed: chest-count mean ~52.6/map (vs ~43.5 on the prior
// numbers), every tier's distribution still spreads meaningfully across its
// [min,max] band under the headroom-weighted fill (no clustering-near-max
// regression), and a +21.9% average Food Coin yield per map (~6.95 vs
// ~5.71) versus the prior numbers. Feasibility re-checked for THESE numbers:
// sum(rarityLimits.min) = 15+7+4+0+0 = 26 <= chests.absoluteMin (30);
// sum(rarityLimits.max) = 44+26+26+7+4 = 107 comfortably exceeds
// chests.absoluteMax (74). nightKitchenSpawnConfig is untouched by this pass.
const normalMapSpawnConfig = {
  variableTables: { min: 100, max: 165 },
  chests: { probability: 0.40, proportionalMin: 0.30, proportionalMax: 0.45, absoluteMin: 30, absoluteMax: 74 },
  rarityLimits: {
    MADEIRA: { min: 15, max: 44 },
    FERRO: { min: 7, max: 26 },
    OURO: { min: 4, max: 26 },
    DIAMANTE: { min: 0, max: 7 },
    VIP: { min: 0, max: 4 },
  },
};
// Mercado Noturno's per-wave variable-generation density config (richer than
// the normal map) — now concretely wired to the Mercado Noturno theme (see
// activeSpawnConfig()/syncActiveSpawnConfig() below), resolving the earlier
// open question of when this should ever activate (master spec #9).
// Balance pass (2026-07-23): variableTables is now a FIXED value (min===max
// ===100), not a real range — kept as a {min,max} object anyway since
// getChestLimits()/other call sites read .min/.max generically, and a fixed
// value is just the degenerate case of a range. With variableTables fixed at
// 100 and chests.probability/proportionalMin/proportionalMax all 0.70,
// getChestLimits(100) resolves to min=max(65, ceil(100*0.70))=70 and
// max=min(75, floor(100*0.70))=70 — every Mercado Noturno map lands on
// EXACTLY 70 chests. The 65-75 absoluteMin/absoluteMax band is therefore a
// no-op safety margin (never actually the binding constraint at this fixed
// variableTables value), not a real source of variance — intentional, not a
// bug. Feasibility: sum(rarityLimits.min) = 10+8+6+1+0 = 25 <=
// chests.absoluteMin (65) and well under the real chestCount of 70, so every
// tier's minimum is always satisfiable; sum(rarityLimits.max) =
// 30+26+28+8+3 = 95 comfortably exceeds both chests.absoluteMax (75) and the
// real chestCount (70).
const nightKitchenSpawnConfig = {
  variableTables: { min: 100, max: 100 },
  chests: { probability: 0.70, proportionalMin: 0.70, proportionalMax: 0.70, absoluteMin: 65, absoluteMax: 75 },
  rarityLimits: {
    MADEIRA: { min: 10, max: 30 },
    FERRO: { min: 8, max: 26 },
    OURO: { min: 6, max: 28 },
    DIAMANTE: { min: 1, max: 8 },
    VIP: { min: 0, max: 3 },
  },
};
// live/default config for every wave; kept in sync with the active theme by
// syncActiveSpawnConfig() (called from load() and waveClear()'s theme
// rotation) rather than recomputed as a getter, so every existing call site
// that reads this as a plain variable (including the test suite) keeps working.
let ACTIVE_SPAWN_CONFIG = normalMapSpawnConfig;
// Call this whenever state.activeThemeId changes (load(), waveClear()'s
// theme-rotation block) to keep ACTIVE_SPAWN_CONFIG pointed at the right
// per-theme generation density — this IS the "concrete trigger" wiring
// master spec #9 asks for.
function syncActiveSpawnConfig() {
  ACTIVE_SPAWN_CONFIG = isMercadoNoturnoActive() ? nightKitchenSpawnConfig : normalMapSpawnConfig;
}

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
// among tiers that still have room. Returns counts summing to exactly
// chestCount (a `wood` overflow fallback absorbs the astronomically unlikely
// case where every tier hits its max before the remainder runs out).
//
// Remainder-fill weighting (2026-07-23 distribution-skew fix): a large-N
// simulation audit (thousands of real genLayout()/seedCrates() calls) found
// that the original uniform `counts[pick(eligible)]++` pick — equal odds for
// every still-eligible tier regardless of its own max — made small-max tiers
// (DIAMANTE, VIP) saturate to at/near their ceiling almost every single map
// instead of spreading across their configured [min,max] band (Mercado
// Noturno's VIP averaged 2.98/3, never once observed at its configured
// floor of 0 across 5000 runs), which compressed the intended ~2.1x Mercado
// Noturno reward premium down to a real ~1.53x. Fixed by weighting each
// eligible tier's odds, on every single-unit draw, by its REMAINING
// headroom (limits[t].max - counts[t]) as a fraction of the total remaining
// headroom across all eligible tiers — a tier with a small max simply starts
// with proportionally less weight instead of the same odds as a tier with a
// huge max, so it no longer gets filled disproportionately fast just because
// it's cheap to stay "eligible." Still guarantees mins first, still returns
// counts summing to exactly chestCount, still keeps the `wood` overflow
// fallback — only the remainder-fill's per-draw ODDS changed.
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
    let totalHeadroom = 0;
    for (const t of eligible) totalHeadroom += (limits[t].max - counts[t]);
    let roll = Math.random() * totalHeadroom;
    let chosen = eligible[eligible.length - 1]; // float-rounding fallback at the boundary
    for (const t of eligible) {
      roll -= (limits[t].max - counts[t]);
      if (roll < 0) { chosen = t; break; }
    }
    counts[chosen]++;
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
  if (val === T_JAULA) return 'jaula';
  if (val === T_OBSTACLE) return 'obstacle';
  // T_CRATE cleanup (2026-07-23): this fallback used to implicitly BE the
  // T_CRATE case ('crate' was the default for "none of the above", since
  // T_CRATE was the one tile value never explicitly checked) — dead code in
  // practice, since gridTiles only ever holds the 5 real values above.
  // Replaced with a safe, non-crate-implying default so nothing regresses
  // for a genuinely unexpected value; the .tile-prop.crate CSS rule this
  // used to select is now provably unreachable (flagged in the final report
  // — out of this cleanup's game.js-only scope).
  return 'floor';
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
  // tier keys are uppercase (MADEIRA/FERRO/OURO/DIAMANTE/VIP, matching the
  // spec's literal slugs) but CSS classes stay lowercase-conventional
  const tierClass = (val === T_CHEST && box && box.tier) ? ' chest-' + box.tier.toLowerCase() : '';
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
  // SERVER-AUTHORITATIVE MAP (2026-07-23, master spec #5): every REAL new
  // map gets a fresh unique identity, persisted alongside gridTiles/tileHp/
  // wave in both the local save and the cloud `saves` row (see
  // saveSnapshot()) — this is the single point where a genuinely NEW map is
  // ever rolled (new game, old/invalid save fallback, a real wave-clear),
  // so stamping it here (rather than at each call site)
  // guarantees it always travels with the grid it actually belongs to.
  // Restoring a persisted grid (restoreOrGenerateGrid()) does NOT call this
  // — it carries the OLD seed through unchanged, since it's still the same
  // map, not a new one.
  state.mapSeed = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
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
  let obstaclePositions = [];
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
    const candidateAssignment = candidateChests.map(([r, c], i) => [r, c, shuffledTiers[i] || 'MADEIRA']);

    for (const [r, c] of candidateObstacles) gridTiles[r][c] = T_OBSTACLE;
    for (const [r, c] of candidateAssignment) gridTiles[r][c] = T_CHEST;

    if (floorsConnected()) {
      chestTierAssignment = candidateAssignment;
      obstaclePositions = candidateObstacles;
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
    obstaclePositions = [];
  }

  // Jaula: a FLAT per-map chance now (1% normal, 50% Mercado Noturno — no
  // pity/drought system anymore, see JAULA_HP's comment above), and — same
  // as the old jail — can only ever replace a CHEST slot (never a Mesa
  // Variável obstacle, which pays no reward to begin with, see below).
  cratesLeft = chestTierAssignment.length;
  if (chestTierAssignment.length && Math.random() < jaulaSpawnChance()) {
    const idx = randInt(0, chestTierAssignment.length - 1);
    const [jr, jc] = chestTierAssignment.splice(idx, 1)[0];
    gridTiles[jr][jc] = T_JAULA;
  }
  cratesTotal = cratesLeft;

  tileHp = {};
  for (const [r, c, tier] of chestTierAssignment) {
    const maxHp = CHEST_TIER_HP[tier];
    tileHp[r + ',' + c] = { hp: maxHp, max: maxHp, chest: true, jaula: false, obstacle: false, tier };
  }
  // Mesa Variável is destructible now (master spec #9) — fixed HP, pays NO
  // reward, and (see destroyTile()) does NOT count toward cratesLeft/
  // wave-clear at all — it's optional pathing/Temperamental-fodder content,
  // not a reward slot, so it was never counted into cratesLeft above either.
  for (const [r, c] of obstaclePositions) {
    tileHp[r + ',' + c] = { hp: MESA_VARIAVEL_HP, max: MESA_VARIAVEL_HP, chest: false, jaula: false, obstacle: true };
  }
  // jaula's HP is a fixed constant (JAULA_HP) — independent of chest tiers
  if (gridTiles.some(row => row.includes(T_JAULA))) {
    for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
      if (gridTiles[r][c] === T_JAULA) tileHp[r + ',' + c] = { hp: JAULA_HP, max: JAULA_HP, chest: false, jaula: true, obstacle: false };
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
  actors[h.id] = { c, r, cd: 0, moveBudget: 0, el, target: null };
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

// Tamanho (h.range) is now DIRECTLY the blast radius in tiles (1-6 across
// the rarity table) — no more ceil(range/2) formula conversion, that was
// only needed when "range" was a much wider 1-10 input to a capped
// derived radius. The old `Math.min(4, ...)` hard cap is also dropped: it
// existed specifically to bound the old formula's disproportionate output
// (ceil(10/2)=5); Tamanho's own table already caps out at a comparable 6,
// so an artificial second ceiling on top no longer serves a real purpose.
// A small level bonus (+1 every 5 levels) is preserved from the old
// formula's cadence — part of the leveling proposal, see combatPower()'s
// comment for the fuller rationale.
function blastRadius(h) {
  const base = h.range + Math.floor((h.level - 1) / 5);
  // the global Blast Expansion upgrade adds on top, uncapped — but only
  // every OTHER level, so it's half as fast as it looks
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

// Bombas stat (NEW 2026-07-23): how many bombs THIS Rango currently has
// live on the map at once. bombs[] is never persisted (ephemeral, same as
// actors[]/tileEls[]), so this is simply computed on the fly by tagging
// each bomb with the planting hero's id (see plantBomb()) — no separate
// per-hero counter to keep in sync.
function bombCountFor(heroId) {
  return bombs.reduce((n, b) => n + (b.heroId === heroId ? 1 : 0), 0);
}

// TARGETING REWORK (2026-07-23): Rangos now commit to a single "target"
// destructible (a.target = {r,c}, persisted on the actor) instead of
// re-chasing whichever destructible is Manhattan-nearest every single step
// (the old nearestCrateDist() approach) — that greedy-without-memory scheme
// is what caused the reported "walks up and down aimlessly": it ignored
// walls/obstacles blocking the straight-line path (pure |dr|+|dc|, no real
// pathfinding) and could flip targets mid-walk if two candidates became
// equidistant. bfsWalk() below does real graph-distance pathfinding over
// canWalk()'s actual walkable tiles, so target APPROACH (which walkable
// neighbor is on the shortest real route) is exact.
//
// RETARGETING REWORK (2026-07-23 follow-up): target SELECTION is
// deliberately NOT nearest-first anymore — that made every Rango farm the
// same nearby chest from every open side ("1 bomb per target" below is the
// actual fix for that; nearest-first would just re-pick the same neighbor
// target repeatedly too). Selection is now a flat random pick among
// reachable Baú/Jaula, and a target is used for exactly one bomb before
// switching — see retarget().

function bfsWalk(h, sr, sc) {
  const startKey = sr + ',' + sc;
  const dist = new Map([[startKey, 0]]);
  const parent = new Map();
  const queue = [[sr, sc]];
  for (let qi = 0; qi < queue.length; qi++) {
    const [r, c] = queue[qi];
    const d = dist.get(r + ',' + c);
    for (const [dr, dc] of DIRS) {
      const nr = r + dr, nc = c + dc, nKey = nr + ',' + nc;
      if (dist.has(nKey) || !canWalk(h, nr, nc)) continue;
      dist.set(nKey, d + 1);
      parent.set(nKey, r + ',' + c);
      queue.push([nr, nc]);
    }
  }
  return { dist, parent };
}

// A destructible isn't itself walkable, so "reachable" means one of its 4
// floor neighbors is in the BFS distance map.
function approachTiles(target, dist) {
  return DIRS.map(([dr, dc]) => [target.r + dr, target.c + dc])
    .filter(([r, c]) => tileAt(r, c) === T_FLOOR && dist.has(r + ',' + c));
}

// Prefers a side without a live bomb on it (so arriving there is actually
// plantable); falls back to the nearest side at all if every side is
// currently bombed (the Rango just parks there and waits for one to clear).
function bestApproachTile(target, dist) {
  const sides = approachTiles(target, dist);
  if (!sides.length) return null;
  const open = sides.filter(([r, c]) => !bombAt(r, c));
  const pool = open.length ? open : sides;
  pool.sort((p, q) => dist.get(p[0] + ',' + p[1]) - dist.get(q[0] + ',' + q[1]));
  return pool[0];
}

// Baú and Jaula are equally prioritized targets (both are the actual
// "reward" tiles — Jaula pays out a new Rango instead of Food Coins, but
// it's just as much a priority target as any chest tier). Mesa Variável is
// NOT in here — it's only ever bombed incidentally, as a path-clearing
// fallback in pickNewTarget() below.
function priorityTargetsAlive() {
  const out = [];
  for (const key in tileHp) {
    if (tileHp[key].chest || tileHp[key].jaula) {
      const [r, c] = key.split(',').map(Number);
      out.push({ r, c });
    }
  }
  return out;
}

function isPriorityTargetTile(r, c) {
  const t = tileAt(r, c);
  return t === T_CHEST || t === T_JAULA;
}

// Flat random pick among reachable Baú/Jaula — `exclude` (the target just
// bombed) is left out of the pool so retarget() never re-picks the same
// spot right away, UNLESS excluding it leaves nothing else reachable, in
// which case it's allowed back in rather than freezing the Rango. If NO
// Baú/Jaula is reachable at all (walled off by Mesa Variável), falls back
// to the nearest reachable destructible of any kind so the Rango clears its
// own way out instead of freezing in place — that fallback stays
// nearest-first since it's just unblocking, not reward-target selection.
function pickNewTarget(h, a, exclude) {
  const { dist } = bfsWalk(h, a.r, a.c);
  const reachable = [];
  for (const t of priorityTargetsAlive()) {
    if (exclude && t.r === exclude.r && t.c === exclude.c) continue;
    if (!approachTiles(t, dist).length) continue;
    reachable.push(t);
  }
  if (reachable.length) return pick(reachable);
  if (exclude) return pickNewTarget(h, a);
  let best = null, bestD = Infinity;
  for (let r = 0; r < G_ROWS; r++) for (let c = 0; c < G_COLS; c++) {
    if (!isDestructible(tileAt(r, c))) continue;
    const sides = approachTiles({ r, c }, dist);
    if (!sides.length) continue;
    const d = Math.min(...sides.map(([rr, cc]) => dist.get(rr + ',' + cc)));
    if (d < bestD) { bestD = d; best = { r, c }; }
  }
  return best;
}

// Called right after planting a bomb — a target is good for exactly ONE
// bomb (even if it still has empty sides open) before switching, UNLESS
// it's the only Baú/Jaula left on the map, in which case there's nothing
// else to switch to and the Rango keeps attacking it.
function retarget(h, a) {
  const cur = a.target;
  if (cur && isPriorityTargetTile(cur.r, cur.c)) {
    const alive = priorityTargetsAlive();
    const onlyOne = alive.length === 1 && alive[0].r === cur.r && alive[0].c === cur.c;
    if (onlyOne) return;
  }
  a.target = pickNewTarget(h, a, cur);
}

function plantBomb(h, a) {
  const el = document.createElement('div');
  el.className = 'bomb';
  // Poder is now a literal flat damage value (no formula) — combatPower(h)
  // applies the leveling bonus on top of effectivePower(h) (see its own
  // comment for why that's a separate function from effectivePower()
  // itself). Espetinho is tagged here too so explode() knows whether this
  // specific bomb pierces through Baús.
  const b = {
    r: a.r, c: a.c, t: FUSE_TICKS, radius: blastRadius(h), rate: combatPower(h),
    folhadoDeOuro: hasFolhadoDeOuro(h), temperamental: hasTemperamental(h),
    espetinho: hasEspetinho(h), heroId: h.id, el,
  };
  positionBomb(b);
  document.getElementById('arena').appendChild(el);
  bombs.push(b);
  a.cd = cooldownTicks(h);
  // ENERGY MODEL REWORK (2026-07-23): flat per-bomb cost (1, or 0 with
  // Sustância's 20% chance) replaces the old continuous per-tick drain.
  h.energy = Math.max(0, h.energy - bombEnergyCost(h));
}

function canWalk(h, r, c) {
  const t = tileAt(r, c);
  if (t === undefined) return false;
  // BUG FIX (2026-07-22, user-reported via screenshot): this used to
  // unconditionally `return true` for any hasMassaLeve() hero regardless of
  // tile type — which let it phase onto (and stand on) Mesa Fixa (T_WALL)
  // too, even though the comment here always claimed otherwise. Mesa Fixa
  // must be a truly permanent, unpassable obstacle for EVERY Rango, no
  // exceptions. Massa Leve's phasing is now an explicit whitelist matching
  // the user's exact rule: only Mesa Variável/Baú/Jaula (isDestructible()'s
  // tile types) plus ordinary floor — never T_WALL, never out of bounds
  // (already excluded by the `t === undefined` check above).
  //
  // BUG FIX (2026-07-23, "bombs count as a filled square by default"): the
  // Massa Leve branch below used to skip the bombAt() check entirely —
  // Massa Leve is about walls/crates, not bombs, so a Massa Leve Rango
  // could accidentally walk onto bomb tiles too. Bomb-blocking must apply
  // to EVERY Rango by default now; Al Dente is the ONLY exception. Computed
  // ONCE here and applied identically to both branches below so they can
  // never drift apart again the way Massa Leve's did.
  const blockedByBomb = bombAt(r, c) && !(h && hasAlDente(h));
  if (h && hasMassaLeve(h)) return (t === T_FLOOR || isDestructible(t)) && !blockedByBomb;
  return t === T_FLOOR && !blockedByBomb;
}

// Moves exactly ONE tile along the real shortest path toward a.target's
// best approach tile (BFS parent-chain walk-back from the destination to
// the first step out of a.r,a.c) — replaces the old ruler-distance greedy
// hop, which is what let a blocked Rango "flip-flop" between neighbors that
// only LOOKED closer in a straight line.
function moveActor(a, h) {
  if (!a.target) return;
  const { dist, parent } = bfsWalk(h, a.r, a.c);
  const approach = bestApproachTile(a.target, dist);
  if (!approach) return; // no reachable approach tile this tick — stand still
  const [tr, tc] = approach;
  if (a.r === tr && a.c === tc) return;
  const startKey = a.r + ',' + a.c;
  let key = tr + ',' + tc, stepR = tr, stepC = tc;
  while (parent.get(key) !== startKey) {
    key = parent.get(key);
    if (key === undefined) return; // safety: no path found
    [stepR, stepC] = key.split(',').map(Number);
  }
  a.r = stepR;
  a.c = stepC;
  positionActor(a.el, a.c, a.r);
}

// SPEED REWORK (2026-07-23): Speed is now tiles-moved-per-SECOND (was an
// energy-drain-reduction modifier). aiTick() runs every AI_MS=500ms (2
// ticks/sec), so a per-actor fractional movement-budget accumulator is the
// natural fit: each tick adds `speed * (AI_MS/1000)` tiles' worth of
// movement, and whole tiles are consumed one at a time (re-checking
// canWalk() at every individual step — never skipped/teleported past an
// obstacle mid multi-tile move). A slow Rango (speed=1) adds 0.5
// tiles/tick, taking 2 ticks to afford its first step; a fast one
// (speed=20, the current stat-table ceiling) adds 10 tiles' worth in a
// SINGLE tick. Two defensive safety caps (flagged per the explicit ask —
// this is a real technical risk given how wide the speed range is):
//   - MOVE_BUDGET_CAP bounds the STORED budget itself, so a Rango that's
//     been completely blocked for a long stretch can't silently bank an
//     unbounded amount of pent-up movement that would otherwise unleash a
//     huge burst of steps the instant it becomes unblocked.
//   - MOVE_STEPS_PER_TICK_CAP bounds the per-tick while-loop directly (independent
//     of budget size), so this can never become a runaway/infinite loop
//     even if something upstream is wrong — set comfortably above the
//     theoretical max of 10 steps/tick at speed=20.
const MOVE_BUDGET_CAP = 20;
const MOVE_STEPS_PER_TICK_CAP = 25;

// shared by both plant-check call sites below: true only when the actor's
// OWN tile is empty floor, a.target specifically (not just any nearby
// destructible — TARGETING REWORK 2026-07-23) is adjacent, cooldown is
// ready, nothing already sits on this tile, the wave isn't mid-regen, AND
// this Rango hasn't already hit its Bombas (max simultaneous bombs) cap.
function canPlantHere(h, a) {
  const t = a.target;
  const nearTarget = t && isDestructible(tileAt(t.r, t.c)) &&
    tileAt(a.r, a.c) === T_FLOOR &&
    DIRS.some(([dr, dc]) => a.r + dr === t.r && a.c + dc === t.c);
  return nearTarget && a.cd === 0 && !bombAt(a.r, a.c) && !waveRegen &&
    bombCountFor(h.id) < h.bombCapacity;
}

function aiTick() {
  for (const idStr of Object.keys(actors)) {
    const id = Number(idStr);
    const h = state.heroes.find(x => x.id === id);
    if (!h || h.mode !== 'work') { removeActor(id); continue; }
    // ENERGY GATE (2026-07-23 fix): plantBomb()'s cost floors at 0 and never
    // refuses to plant on insufficient energy — the old continuous-drain
    // economyTick() used to auto-rest a working hero the instant it hit 0
    // energy, and removing that drain (energy model rework) silently
    // deleted the only place that ever happened. Without this, a hero at 0
    // energy would just keep planting bombs for free forever, making
    // Stamina/energy purely decorative once drained. Auto-rest here instead
    // — this is where energy is actually spent now, so it's the right place
    // to enforce the same "can't work at 0 energy" rule the old code had.
    if (h.energy <= 0) { h.mode = 'rest'; removeActor(id); continue; }
    const a = actors[id];
    if (a.cd > 0) a.cd--;

    a.moveBudget = Math.min(MOVE_BUDGET_CAP, (a.moveBudget || 0) + h.speed * (AI_MS / 1000));

    // Drop a stale target (chest/obstacle already destroyed by this Rango
    // or anyone else) and pick a fresh one before doing anything else.
    if (a.target && !isDestructible(tileAt(a.target.r, a.target.c))) a.target = null;
    if (!a.target) a.target = pickNewTarget(h, a);

    // Planting is NEVER gated by movement budget (it isn't movement) —
    // checked first, unconditionally, exactly like before this rework.
    if (canPlantHere(h, a)) {
      plantBomb(h, a);
      retarget(h, a);
      continue;
    }
    // Not plantable from the current tile: spend the movement budget one
    // tile at a time, re-checking plant-eligibility after EACH step so a
    // fast Rango naturally stops the instant it reaches a plantable spot
    // within the same tick, rather than always "overshooting" every tick.
    const tickStartR = a.r, tickStartC = a.c;
    let stepsThisTick = 0;
    while (a.moveBudget >= 1 && stepsThisTick < MOVE_STEPS_PER_TICK_CAP) {
      const beforeKey = a.r + ',' + a.c;
      moveActor(a, h);
      stepsThisTick++;
      a.moveBudget -= 1;
      if (beforeKey === a.r + ',' + a.c) break; // genuinely blocked (no open tile) — stop consuming budget this tick
      if (canPlantHere(h, a)) {
        plantBomb(h, a);
        retarget(h, a);
        break;
      }
    }
    // VISUAL CORNER-CUT FIX (2026-07-23, re-verification requested alongside
    // the Massa Leve fix above) — REVISED (2026-07-23, urgent live
    // regression fix): the grid logic (bfsWalk()/moveActor()) is already
    // cardinal-only and canWalk()-gated, never a real bug — the only actual
    // risk is a VISUAL one, and only in one specific case. The original fix
    // here keyed off `stepsThisTick > 1`, which was wrong: any Rango with
    // Speed >= 4 (a1 * (AI_MS/1000) = 2+ tiles' worth of budget per tick —
    // ordinary for most rarities above Caseiro/Temperado, not a rare edge
    // case) takes 2+ steps EVERY single tick in steady state, so that
    // condition fired on nearly every tick for a large share of the roster,
    // disabling the transition almost permanently and making ordinary
    // movement look like instant teleporting instead of a smooth walk —
    // exactly the live regression reported. The real risk was never "more
    // than one tile moved this tick" (a fast Rango walking several tiles in
    // a STRAIGHT line is a perfectly honest smooth glide, nothing to fix)
    // — it's specifically a tick whose NET path BENDS (visits both a row
    // AND a column change), which is what makes translate(x,y)'s linear
    // interpolation cut a visible diagonal across the corner between them.
    // Checking net displacement from BEFORE this tick's movement loop
    // started (tickStartR/C) to after it, instead of the step count, keys
    // on that real condition — genuinely rare (only when the path actually
    // turns a corner within one 500ms tick), leaving ordinary single- AND
    // multi-tile-straight-line movement smooth exactly like before this
    // whole fix ever existed.
    if (a.r !== tickStartR && a.c !== tickStartC) {
      a.el.style.transition = 'none';
      void a.el.offsetHeight; // force layout so 'none' is locked in before the transition is restored below
      a.el.style.transition = '';
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
  // DEAD-CODE NOTE (2026-07-22): this used to matter when a phasing Rango
  // could plant while standing directly on a destructible (the stale
  // comment here used to say so) — that allowance is now fully removed
  // (aiTick() requires the Rango's own tile to be T_FLOOR to plant at all),
  // and nothing else in the game ever spawns a NEW destructible onto an
  // already-floor tile mid-wave (destructibles only get placed by
  // seedCrates() at wave/theme generation). So b.r,b.c is now ALWAYS
  // T_FLOOR by the time a bomb explodes, and hitTile()'s own
  // isDestructible() guard makes this call a permanent, harmless no-op.
  // Left in place (rather than deleted) as cheap defensive robustness in
  // case a future feature ever plants a destructible under a live bomb —
  // not confusing dead logic, just intentionally inert for now.
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
      if (isDestructible(t)) {
        hitTile(r, c, b);
        // Espetinho (NEW 2026-07-23): pierces through Baús specifically —
        // ONLY T_CHEST, per the skill's exact wording ("atravessa baús") —
        // and keeps advancing in this direction instead of stopping, up to
        // the blast-radius limit (the `s <= b.radius` loop bound) or an
        // indestructible obstacle (the `isBlockingObstacle` check above,
        // still evaluated every step). Mesa Variável (T_OBSTACLE) and
        // Jaula (T_JAULA) are NOT named by the skill's wording, so they
        // still stop/absorb the blast exactly like the default (unpierced)
        // behavior — flagged assumption, since the user only ever said
        // "baús" specifically.
        if (b.espetinho && t === T_CHEST) continue;
        break;
      }
    }
  }
  // Temperamental: each blast also chains to 5 random OTHER valid targets
  // anywhere on the board — normal hit damage, bounded fan-out (master spec
  // #4 — UP from the old Cataclysm's 3). tileHp's own keys are already
  // exactly "every valid target" (Mesa Variável/chests/Jaula — floor, Mesa
  // Fixa, borders, and Rangos themselves are never tracked in tileHp at
  // all), and splicing a random one out each iteration already guarantees
  // the targets are distinct from each other and stops early once fewer
  // than TEMPERAMENTAL_CHAIN valid targets remain, exactly per spec.
  if (b.temperamental) {
    const targets = Object.keys(tileHp);
    for (let i = 0; i < TEMPERAMENTAL_CHAIN && targets.length; i++) {
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
    damageTile(r, c, b.rate * crit.mult, b.folhadoDeOuro, crit.isCrit);
  }
}

function damageTile(r, c, dmg, folhadoDeOuroBomb, isCrit) {
  const key = r + ',' + c;
  const box = tileHp[key];
  if (!box) return;
  // BUG FIX (2026-07-22, urgent, confirmed live): Mesa Variável must break
  // from ANY hit regardless of the hitting Rango's strength ("se quebrando
  // com qualquer dano") — but the generic HP-subtract-then-threshold-check
  // below only destroys once box.hp <= 0.0001, and a weak Caseiro's
  // mineRate can be as low as ~0.21 (power=5, the stat-table minimum),
  // well under MESA_VARIAVEL_HP's 1 point — needing ~5 hits to cross the
  // threshold instead of one. Special-cased here: skip the HP math
  // entirely for Mesa Variável and destroy unconditionally on first
  // contact, regardless of dmg's actual magnitude. Chests/Jaula are
  // untouched — they still use the normal HP-accumulation math below.
  if (box.obstacle) {
    destroyTile(r, c, box, folhadoDeOuroBomb);
    return;
  }
  box.hp -= dmg;
  if (box.hp > 0.0001) {
    updateHpBar(r, c);
    floatLabel(r, c, (isCrit ? '💥 CRIT -' : '-') + (dmg >= 10 ? fmt(dmg) : dmg.toFixed(1)), false, isCrit);
    return;
  }
  destroyTile(r, c, box, folhadoDeOuroBomb);
}

function destroyTile(r, c, box, folhadoDeOuroBomb) {
  delete tileHp[r + ',' + c];
  setTile(r, c, T_FLOOR);

  // Jaula is a rescue, not a payout: it grants exactly one new Rango instead
  // of Food Coins (no skill-shard roll either — the Rango IS the whole reward)
  if (box.jaula) {
    const rarity = rollRarity(JAULA_RARITY_WEIGHTS);
    const freed = makeHero(rarity);
    freed.isSpicy = rollPicante(jaulaPicanteChance());
    state.heroes.push(freed);
    floatLabel(r, c, '🔓 ' + rLabel(rarity) + '!', true);
    cratesLeft = Math.max(0, cratesLeft - 1);
    save();
    pushCloudSaveThrottled(); // master spec #4: push right after a reward event (throttled), not just the 30s baseline
    renderHeader();
    renderInventory();
    startJaulaReveal(freed);
    if (cratesLeft === 0 && !waveRegen) waveClear();
    return;
  }

  // Mesa Variável: destructible, but purely a pathing/Temperamental-fodder
  // convenience — pays no Food Coins, no Skill Shard roll, and does NOT
  // count toward cratesLeft/wave-clear (never counted into cratesLeft/
  // cratesTotal in seedCrates() either — see its comment).
  if (box.obstacle) return;

  // Chest payout: fixed reward RANGE per tier now (master spec #8), NOT the
  // old HP x CHEST_WORTH_S x tier-multiplier formula — box.max/waveMult() no
  // longer drive this at all. Folhado de Ouro skims a bounded bonus on top;
  // a small symmetric variance roll keeps the AVERAGE identical but stops
  // every single break from reading like an exact spreadsheet number. Only
  // chests reach this point (Jaula/Mesa Variável both return above), so
  // box.tier is always a valid CHEST_TIERS key here.
  const [rewardMin, rewardMax] = CHEST_TIER_REWARD_RANGE[box.tier];
  const amt = randomBetween(rewardMin, rewardMax) * (folhadoDeOuroBomb ? FOLHADO_DE_OURO_BONUS : 1) * payoutVarianceMult();
  state.starCore += amt;
  state.totalMined += amt;
  // reward scale is now fractions of a Food Coin (0.01-3.00) — always show
  // 2 decimal places (fmt()'s Math.floor() would print "0" for anything
  // under 1, which is most of this range now)
  floatLabel(r, c, '💰 +' + amt.toFixed(2), true);
  cratesLeft = Math.max(0, cratesLeft - 1);
  // rare material drop, independent of and additional to the Food Coins payout
  if (Math.random() < SKILL_SHARD_CHEST_CHANCE) {
    state.skillShards = (state.skillShards || 0) + 1;
    floatLabel(r, c, '🔮 +1', true);
  }
  pushCloudSaveThrottled(); // master spec #4: push right after a reward event (throttled), not just the 30s baseline
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
    // Theme rotation (2026-07-22 user change): a random theme is now rolled
    // on EVERY single wave-clear — replaces the old mapsInTheme counter /
    // every-50-maps threshold entirely. Uniform random pick from
    // THEME_ROTATION via the same generic pick() helper used everywhere
    // else in this file; back-to-back repeats of the same theme are
    // allowed (no "never immediately repeat" constraint was requested).
    // With 2 real themes registered (jardim_fresquinho,
    // jardim_fresquinho_sliced), each new map is a 50/50 coin flip between
    // them. state.activeThemeId itself is unchanged as the persistence
    // mechanism (still saved/restored exactly as before) — only the
    // ADVANCEMENT trigger changed, from "every 50th clear" to "every clear".
    state.activeThemeId = pick(THEME_ROTATION);
    applyTheme(state.activeThemeId);
    syncActiveSpawnConfig(); // Mercado Noturno's jaula/density config wiring — see master spec #9
    genLayout();
    applyTileClasses();
    repositionActors();
    waveRegen = false;
    save();
  }, 2000);
}

// wave walls can appear under a standing hero; shove them onto open floor
//
// BUG FIX (2026-07-23, live production report: "Massa Leve atravessa
// QUALQUER objeto"): this used to `continue` (skip repositioning
// entirely) for ANY Massa Leve hero, on the assumption that "Massa Leve can
// stand on destructibles anyway, so it never needs moving." That reasoning
// only covers the real whitelist (Mesa Variável/Baú/Jaula) — it does NOT
// account for the fresh wave's map placing Mesa Fixa (T_WALL) exactly where
// the hero was standing, which is a real, common case (every wave clear
// rerolls the whole grid). Since this function is the ONLY place that ever
// assigns a.r/a.c directly, outside the per-step canWalk()-gated BFS
// movement in moveActor()/bfsWalk(), it completely bypassed canWalk() —
// silently leaving a Massa Leve Rango stranded standing ON a Mesa Fixa
// table (or anything else) after a wave transition, no movement/phasing
// involved at all. That's almost certainly what read as "walks through/is
// inside ANY object" in the field: canWalk() itself (verified directly)
// and the BFS movement path (verified via bfsWalk()'s own canWalk() gate on
// every edge) were both already correct. Fixed by checking the ACTUAL new
// tile against the same whitelist canWalk() uses, instead of blanket-
// exempting Massa Leve regardless of what that tile turned out to be.
function repositionActors() {
  for (const id of Object.keys(actors)) {
    const a = actors[id];
    const h = state.heroes.find(x => x.id === Number(id));
    const t = tileAt(a.r, a.c);
    const okToStay = t === T_FLOOR || (h && hasMassaLeve(h) && isDestructible(t));
    if (okToStay) continue;
    const spots = openFloors();
    if (!spots.length) continue;
    const [r, c] = pick(spots);
    a.r = r;
    a.c = c;
    positionActor(a.el, c, r);
    // This is a genuine teleport (an arbitrary open tile anywhere on the
    // fresh map), not organic walking — snap instantly instead of letting
    // .actor's normal 0.45s transition glide the sprite across the whole
    // arena. Same off/reflow/restore trick as aiTick()'s movement snap-fix.
    a.el.style.transition = 'none';
    void a.el.offsetHeight;
    a.el.style.transition = '';
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
      toast('This Rango has no energy — let them rest first.');
      return;
    }
    if (workingCount() >= MAX_WORKERS) {
      toast(`Max ${MAX_WORKERS} Rangos can work at once.`);
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
    toast(`Need ${fmtCurrency(cost)} Food Coins to level up.`);
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
    toast(`Not enough Chef Gems — need ${fmtCurrency(pack.cost)}.`);
    return;
  }
  state.bcoin -= pack.cost;
  const pulled = [];
  for (let i = 0; i < pack.size; i++) {
    // ONE flat rarity table now regardless of pack size (master spec #6) —
    // pack size only changes how many rolls you get, not the per-roll odds
    const hero = makeHero(rollRarity(SHOP_RARITY_WEIGHTS));
    hero.isSpicy = rollPicante(PICANTE_CHANCE_SHOP); // independent of the rarity roll above
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
    toast(`Not enough Chef Gems — need ${fmtCurrency(house.cost)}.`);
    return;
  }
  state.bcoin -= house.cost;
  state.houses[id]++;
  save();
  toast(`${house.emoji} ${house.name} built! Recovery is now ${recoveryRate().toFixed(2)} energy/s.`);
  renderHeader();
  renderDespensa();
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
  toast(`Exchanged ${fmtCurrency(whole * EXCHANGE_RATE)} Food Coins → ${fmtCurrency(whole)} Chef Gems`);
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
        toast(`All ${FUSE_COST} Rangos must share the same rarity.`);
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
      : `⚗️ Fusão failed — the cores collapsed into a fresh ${rLabel(src)}.`;
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
    toast(`Fusão failed — ${FUSE_COST} Rangos became 1 fresh ${rLabel(src)}.`);
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
    ? `⛏️ ${changed} Rango${changed === 1 ? '' : 's'} sent to work${parts.length ? ` (${parts.join(', ')})` : ''}`
    : `😴 ${changed} Rango${changed === 1 ? '' : 's'} sent to rest`);
}

function claimTask(id) {
  const task = TASKS.find(t => t.id === id);
  if (!task || state.tasksClaimed.includes(id) || !task.check(state)) return;
  state.tasksClaimed.push(id);
  state.starCore += task.reward;
  state.totalMined += task.reward;
  save();
  toast(`Task complete! +${fmtCurrency(task.reward)} Food Coins`);
  renderHeader();
  renderTasks();
}

/* ============ Etapa 2: meta-progression ============ */

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
    toast(`Need ${fmtCurrency(cost)} Chef Gems to re-roll this hero.`);
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
    toast(`Need ${fmtCurrency(cost)} Chef Gems for the next ${UPGRADE_DEFS[key].name} level.`);
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
    toast(`Need ${fmtCurrency(cost)} Chef Gems to breed these two heroes.`);
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

// BUG FIX (2026-07-22, confirmed live): fmt()'s Math.floor() silently
// discards all decimals — harmless for plain integer counts (wave number,
// worker count, prestige count, skill shard count) but actively wrong for
// currency now that chest rewards are tiny (0.01-3.00 Food Coins per the
// master spec pivot): any reward under 1.00 displayed as "0", making it
// look like destroying a chest didn't pay out at all, when state.starCore
// was actually incrementing correctly the whole time — purely a display
// bug. Dedicated function for Food Coins/Chef Gems displays specifically;
// fmt() itself is UNCHANGED and still used for real plain-count displays.
function fmtCurrency(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(p) {
  const pct = p * 100;
  return (pct >= 0.1 ? pct.toFixed(1) : pct.toPrecision(2)) + '%';
}

// Shared rendering — used everywhere a Rango portrait renders (arena
// actors, Inventory cards, details panel, pull-reveal cards, bombers
// panel, Lab pickers). Reads the NEW skill fields (hasMassaLeve()/
// hasCafeinado()/hasFolhadoDeOuro()/hasTemperamental() — each ALSO honors
// the legacy h.ghost/h.swift Lab-implant/breeding fields for backward
// compatibility, see their definitions above).
// Picante art (2026-07-23): master spec #3 originally shipped with "no
// visual yet" (PICANTE_VISUAL_PLACEHOLDER) since no art existed for ANY
// character. Now that real art is arriving per-character, this tries
// assets/heroes/<char>_picante.png first for an isSpicy hero and silently
// falls back to the normal <char>.png via onerror if that file 404s — so
// each character's Picante art can be dropped in independently, with no
// code change needed per character and no broken-image icon for the ones
// that don't have it yet.
// `opts.showSkillIcons` (2026-07-23, user-flagged): defaults to true so
// EVERY existing call site (arena actors via positionActor(), grid card,
// Fusion picker, bomber-list, reveal cards, legend) renders identically to
// before — only renderInventoryDetails()'s ff-char-wrap call passes
// { showSkillIcons: false } now, since the detail panel scene has its own
// dedicated corner skill badges (.ff-scene-skills) making the floating
// .sp-skill icon over the character's head redundant there specifically.
// The floating icon during real gameplay (arena) is a deliberately separate,
// still-wanted at-a-glance indicator — untouched.
function spriteHtml(h, opts) {
  const showSkillIcons = !opts || opts.showSkillIcons !== false;
  const skills = !showSkillIcons ? '' :
    (hasMassaLeve(h) ? `<span class="sp-skill sk-ml" title="${SKILL_DEFS.MASSA_LEVE.label}: ${SKILL_DEFS.MASSA_LEVE.text}">${SKILL_DEFS.MASSA_LEVE.icon}</span>` : '') +
    (hasCafeinado(h) ? `<span class="sp-skill sk-cf" title="${SKILL_DEFS.CAFEINADO.label}: ${SKILL_DEFS.CAFEINADO.text}">${SKILL_DEFS.CAFEINADO.icon}</span>` : '') +
    (hasSustancia(h) ? `<span class="sp-skill sk-su" title="${SKILL_DEFS.SUSTANCIA.label}: ${SKILL_DEFS.SUSTANCIA.text}">${SKILL_DEFS.SUSTANCIA.icon}</span>` : '') +
    (hasEspetinho(h) ? `<span class="sp-skill sk-es" title="${SKILL_DEFS.ESPETINHO.label}: ${SKILL_DEFS.ESPETINHO.text}">${SKILL_DEFS.ESPETINHO.icon}</span>` : '') +
    (hasAlDente(h) ? `<span class="sp-skill sk-ad" title="${SKILL_DEFS.AL_DENTE.label}: ${SKILL_DEFS.AL_DENTE.text}">${SKILL_DEFS.AL_DENTE.icon}</span>` : '') +
    (hasFolhadoDeOuro(h) ? `<span class="sp-skill sk-fo" title="${SKILL_DEFS.FOLHADO_DE_OURO.label}: ${SKILL_DEFS.FOLHADO_DE_OURO.text}">${SKILL_DEFS.FOLHADO_DE_OURO.icon}</span>` : '') +
    (hasTemperamental(h) ? `<span class="sp-skill sk-tp" title="${SKILL_DEFS.TEMPERAMENTAL.label}: ${SKILL_DEFS.TEMPERAMENTAL.text}">${SKILL_DEFS.TEMPERAMENTAL.icon}</span>` : '');
  const char = HERO_CHARACTERS.includes(h.character) ? h.character : HERO_CHARACTERS[0];
  const baseSrc = `assets/heroes/${char}.png`;
  const src = h.isSpicy ? `assets/heroes/${char}_picante.png` : baseSrc;
  const fallback = h.isSpicy ? ` onerror="this.onerror=null;this.src='${baseSrc}';"` : '';
  return `<span class="sprite sr-${h.rarity}"><img src="${src}" alt="${char}" loading="lazy"${fallback}>${skills}</span>`;
}

function skillText(h) {
  const s = [];
  if (hasMassaLeve(h)) s.push(SKILL_DEFS.MASSA_LEVE.icon + ' ' + SKILL_DEFS.MASSA_LEVE.label);
  if (hasCafeinado(h)) s.push(SKILL_DEFS.CAFEINADO.icon + ' ' + SKILL_DEFS.CAFEINADO.label);
  if (hasSustancia(h)) s.push(SKILL_DEFS.SUSTANCIA.icon + ' ' + SKILL_DEFS.SUSTANCIA.label);
  if (hasEspetinho(h)) s.push(SKILL_DEFS.ESPETINHO.icon + ' ' + SKILL_DEFS.ESPETINHO.label);
  if (hasAlDente(h)) s.push(SKILL_DEFS.AL_DENTE.icon + ' ' + SKILL_DEFS.AL_DENTE.label);
  if (hasFolhadoDeOuro(h)) s.push(SKILL_DEFS.FOLHADO_DE_OURO.icon + ' ' + SKILL_DEFS.FOLHADO_DE_OURO.label);
  if (hasTemperamental(h)) s.push(SKILL_DEFS.TEMPERAMENTAL.icon + ' ' + SKILL_DEFS.TEMPERAMENTAL.label);
  return s.join(' · ');
}

function skillBadgesHtml(h) {
  const badges = [];
  // BUG FIX (2026-07-23): title was just the short label (e.g. "Massa
  // Leve") — the full flavor text describing what the skill actually DOES
  // already exists on SKILL_DEFS[...].text and was never surfaced anywhere
  // in the Inventory tab's badge hover. All 7 skills now show "Label: text".
  if (hasMassaLeve(h)) badges.push(`<span class="skill-pill sk-massaleve" title="${SKILL_DEFS.MASSA_LEVE.label}: ${SKILL_DEFS.MASSA_LEVE.text}">${SKILL_DEFS.MASSA_LEVE.icon}</span>`);
  if (hasCafeinado(h)) badges.push(`<span class="skill-pill sk-cafeinado" title="${SKILL_DEFS.CAFEINADO.label}: ${SKILL_DEFS.CAFEINADO.text}">${SKILL_DEFS.CAFEINADO.icon}</span>`);
  if (hasSustancia(h)) badges.push(`<span class="skill-pill sk-sustancia" title="${SKILL_DEFS.SUSTANCIA.label}: ${SKILL_DEFS.SUSTANCIA.text}">${SKILL_DEFS.SUSTANCIA.icon}</span>`);
  if (hasEspetinho(h)) badges.push(`<span class="skill-pill sk-espetinho" title="${SKILL_DEFS.ESPETINHO.label}: ${SKILL_DEFS.ESPETINHO.text}">${SKILL_DEFS.ESPETINHO.icon}</span>`);
  if (hasAlDente(h)) badges.push(`<span class="skill-pill sk-aldente" title="${SKILL_DEFS.AL_DENTE.label}: ${SKILL_DEFS.AL_DENTE.text}">${SKILL_DEFS.AL_DENTE.icon}</span>`);
  if (hasFolhadoDeOuro(h)) badges.push(`<span class="skill-pill sk-folhadodeouro" title="${SKILL_DEFS.FOLHADO_DE_OURO.label}: ${SKILL_DEFS.FOLHADO_DE_OURO.text}">${SKILL_DEFS.FOLHADO_DE_OURO.icon}</span>`);
  if (hasTemperamental(h)) badges.push(`<span class="skill-pill sk-temperamental" title="${SKILL_DEFS.TEMPERAMENTAL.label}: ${SKILL_DEFS.TEMPERAMENTAL.text}">${SKILL_DEFS.TEMPERAMENTAL.icon}</span>`);
  return badges.join('');
}

function energyBarHtml(h) {
  const maxE = maxEnergyFor(h);
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
        ${h.isSpicy ? `<span class="picante-tag" title="${PICANTE_VISUAL_PLACEHOLDER}">🌶️ Picante</span>` : ''}
      </div>
    </div>
    <div class="hero-stats">
      💪 Poder ${h.power} &nbsp; 📏 Tamanho ${blastRadius(h)} &nbsp; 👟 Speed ${h.speed} &nbsp; 💣 Bombas ${h.bombCapacity} &nbsp; ⚡ Stamina ${h.stamina}<br>
      🏅 Level ${h.level} &nbsp; ⛏️ ${mineRate(h).toFixed(2)} dmg/s &nbsp; ${working ? '<b style="color:var(--accent2)">WORKING</b>' : 'Resting'}
      ${skillText(h) ? `<br>✨ ${skillText(h)}` : ''}
    </div>
    ${energyBarHtml(h)}
    ${opts.actions ? `
    <div class="hero-actions">
      <button class="btn btn-small ${working ? 'btn-ghost' : ''}" data-toggle-id="${h.id}">${working ? '😴 Rest' : '⛏️ Work'}</button>
      ${h.level < MAX_LEVEL
        ? `<button class="btn btn-small btn-ghost" data-level-id="${h.id}">⬆️ Lv ${h.level + 1} (${fmtCurrency(levelCost(h))} Food Coins)</button>`
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
  document.getElementById('bcoin-display').textContent = fmtCurrency(state.bcoin);
  document.getElementById('score-display').textContent = fmtCurrency(state.starCore);

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
  set('hud-rate', totalRate.toFixed(2) + ' dmg/s');
  set('hud-recovery', recoveryRate().toFixed(2) + ' ⚡/s');
  document.getElementById('bombers').innerHTML = working.length
    ? working.map(h => {
        const maxE = maxEnergyFor(h);
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
              <span title="Damage rate">⛏️ ${mineRate(h).toFixed(1)} dmg/s</span>
              ${h.ascendCount > 0 ? `<span class="bomber-ascend" title="Ascension #${h.ascendCount} — permanent damage multiplier">🌌 ×${ascendMult(h).toFixed(2)}</span>` : ''}
            </div>
            ${badges ? `<div class="bomber-skills">${badges}</div>` : ''}
            <div class="energy-bar"><div class="fill ${pct < 25 ? 'low' : ''}" style="width:${pct}%"></div></div>
            <div class="bomber-energy-label">⚡ ${Math.floor(h.energy)} / ${maxE}</div>
          </div>
        </div>`;
      }).join('')
    : '<div class="bombers-empty muted">No Rangos on the field.<br>Open 🗄️ Armário and send some to work.</div>';
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
// Stat color mapping shared by the grid card's energy bar (well, just the
// single energy fill now) and the detail panel's 5 raw-stat rows (2026-07-23
// simplification pass). Renamed `blast` -> `range` (Tamanho is the RAW
// h.range stat now shown in the details panel, not a derived blastRadius()
// rate) and added `stamina` (a genuinely new 5th stat row, no prior color).
// `bombs` is reused for Bombas (h.bombCapacity, a raw count) even though it
// used to color a derived bombs/min rate — same icon/concept, just a
// different formula behind it now.
const FF_STAT_COLORS = { power: '#ff6f6f', speed: '#5ab0ff', range: '#4fd675', bombs: '#ff9a3c', stamina: '#ffd54f' };

function ffStatusDotClass(h) {
  if (h.mode !== 'work') return 'ff-dot-rest';
  const maxE = maxEnergyFor(h);
  return (h.energy / maxE) < 0.25 ? 'ff-dot-low' : 'ff-dot-work';
}

// Grid card simplification (2026-07-23, confirmed wireframe): dropped the
// "has any skill" star badge and the 4-segment attribute bar entirely (both
// removed below, no replacement concept for the star). The star's old
// top-right corner slot is now occupied by the Picante pepper (icon only, no
// "Picante" text label anymore — see .ff-card-picante in style.css, a NEW
// class, deliberately not reusing the shared .picante-tag/.ff-picante-tag
// text-label rule that other UI still uses as-is). The attr-bar's old slot
// is now a plain energy fill bar. The existing rarity badge's text switches
// from rTag(h.rarity) (buggy — always the raw enum key, see rTag()'s own
// comment) to the new, correct rSigla(h.rarity).
function ffHeroCardHtml(h) {
  const energyPct = Math.max(0, Math.min(100, (h.energy / maxEnergyFor(h)) * 100));
  return `
  <button type="button" class="ff-card r-${h.rarity}${selectedInventoryHeroId === h.id ? ' ff-card-selected' : ''}" data-select-hero="${h.id}" aria-pressed="${selectedInventoryHeroId === h.id}">
    <div class="ff-card-top">
      <span class="ff-card-id">#${String(h.id).padStart(4, '0')}</span>
      <span class="ff-status-dot ${ffStatusDotClass(h)}" data-status-dot="${h.id}" title="${h.mode === 'work' ? 'Working' : 'Resting'}"></span>
    </div>
    <div class="ff-card-image-wrap">
      ${spriteHtml(h)}
      <span class="ff-rarity-badge rarity-${h.rarity}">${rSigla(h.rarity)}</span>
      ${h.isSpicy ? `<span class="ff-card-picante" title="${PICANTE_VISUAL_PLACEHOLDER}">🌶️</span>` : ''}
    </div>
    <div class="ff-energy-bar" title="Energy: ${Math.floor(h.energy)}/${maxEnergyFor(h)}"><span style="width:${energyPct}%"></span></div>
    <span class="ff-card-name">${h.name}</span>
  </button>`;
}

// Moved into the scene's top-right corner (2026-07-23, user-flagged) —
// mirrors .ff-scene-picante's top-left corner badge treatment. Bare-icon-only
// now: no name label under the icon (kept as the hover title only) and no
// "No skills yet" placeholder card — a hero with 0 skills simply shows
// nothing in that corner, same as the Picante badge shows nothing when a
// hero isn't spicy. Markup stays deliberately simple/swappable (a plain
// small square with just the icon character) since the user plans to swap
// these emoji for real icon images later.
function ffSkillCards(h) {
  const skills = [];
  if (hasMassaLeve(h)) skills.push({ icon: SKILL_DEFS.MASSA_LEVE.icon, name: SKILL_DEFS.MASSA_LEVE.label, text: SKILL_DEFS.MASSA_LEVE.text });
  if (hasCafeinado(h)) skills.push({ icon: SKILL_DEFS.CAFEINADO.icon, name: SKILL_DEFS.CAFEINADO.label, text: SKILL_DEFS.CAFEINADO.text });
  if (hasSustancia(h)) skills.push({ icon: SKILL_DEFS.SUSTANCIA.icon, name: SKILL_DEFS.SUSTANCIA.label, text: SKILL_DEFS.SUSTANCIA.text });
  if (hasEspetinho(h)) skills.push({ icon: SKILL_DEFS.ESPETINHO.icon, name: SKILL_DEFS.ESPETINHO.label, text: SKILL_DEFS.ESPETINHO.text });
  if (hasAlDente(h)) skills.push({ icon: SKILL_DEFS.AL_DENTE.icon, name: SKILL_DEFS.AL_DENTE.label, text: SKILL_DEFS.AL_DENTE.text });
  if (hasFolhadoDeOuro(h)) skills.push({ icon: SKILL_DEFS.FOLHADO_DE_OURO.icon, name: SKILL_DEFS.FOLHADO_DE_OURO.label, text: SKILL_DEFS.FOLHADO_DE_OURO.text });
  if (hasTemperamental(h)) skills.push({ icon: SKILL_DEFS.TEMPERAMENTAL.icon, name: SKILL_DEFS.TEMPERAMENTAL.label, text: SKILL_DEFS.TEMPERAMENTAL.text });
  if (!skills.length) return '';
  // title keeps the full "Label: text" hover description — still useful
  // info, just not shown inline anymore (BUG FIX 2026-07-23 that added this
  // title in the first place is unaffected, only the inline name span is gone).
  return skills.map(s => `<div class="ff-skill-card" title="${s.name}: ${s.text}"><span class="ff-skill-icon">${s.icon}</span></div>`).join('');
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
  // Default-select-first-hero (2026-07-23, confirmed): "nothing selected yet
  // AND heroes exist" now auto-picks the first hero (sortedHeroes() order,
  // same as the grid) instead of falling into the empty state below. The
  // empty state is reserved for the genuine "zero heroes owned" case (the
  // `if (!h)` branch right after this still handles that, unchanged).
  // renderInventory() already resolves this same rule BEFORE building the
  // grid (so the grid's selection ring matches this panel from the very
  // first render) — this is a self-healing repeat of that same rule, for the
  // rarer direct-call path from updateInventoryLive() (e.g. a
  // previously-selected hero removed mid-session via Sacrifice), so the
  // panel recovers immediately instead of waiting for the next full
  // renderInventory(). (The close/deselect button this comment used to
  // reference is gone entirely now, 2026-07-23, user-flagged — with
  // default-select-first-hero, there was never a clean "empty" state left
  // to close back to while heroes are owned, so the affordance made no
  // sense; see bindEvents() for the removed data-close-details handler.)
  if (selectedInventoryHeroId == null && state.heroes.length) {
    selectedInventoryHeroId = sortedHeroes()[0].id;
  }
  const h = state.heroes.find(x => x.id === selectedInventoryHeroId);
  if (!h) {
    selectedInventoryHeroId = null;
    panel.className = 'ff-details';
    panel.innerHTML = `
    <div class="ff-empty-state">
      <span class="ff-empty-icon">🍔</span>
      <p class="ff-empty-text">Select a hero in the grid to see details.</p>
    </div>`;
    return;
  }
  const maxE = maxEnergyFor(h);
  const atMax = h.level >= MAX_LEVEL;
  const cost = atMax ? 0 : levelCost(h);
  const xpPct = atMax ? 100 : Math.min(100, Math.round((state.starCore / cost) * 100));
  const working = h.mode === 'work';

  // Rarity-colored border around the whole panel, same r-${rarity} pattern
  // and --c-* color tokens the grid card's box-shadow ring already uses
  // (see .ff-details.r-* in style.css) — kept in sync with the selected
  // hero's rarity on every render.
  panel.className = 'ff-details r-' + h.rarity;
  panel.innerHTML = `
    <div class="ff-scene">
      <div class="ff-sky"></div>
      ${h.isSpicy ? `<span class="ff-scene-picante" title="${PICANTE_VISUAL_PLACEHOLDER}">🌶️</span>` : ''}
      <div class="ff-scene-skills">${ffSkillCards(h)}</div>
      <div class="ff-char-wrap">${spriteHtml(h, { showSkillIcons: false })}</div>
      <div class="ff-ground"></div>
      <div class="ff-info-block">
        <h2 class="ff-hero-name">${h.name}</h2>
        <div class="ff-meta-row">
          <span class="ff-chip ff-chip-rarity rarity-${h.rarity}">${rLabel(h.rarity).toUpperCase()}</span>
          <span class="ff-chip ff-chip-level">Level ${h.level}</span>
          <span class="ff-chip ff-chip-energy" id="ff-energy-chip">⚡ ${Math.floor(h.energy)}/${maxE}</span>
        </div>
      </div>
    </div>

    <div class="ff-stats-panel">
      <div class="ff-stat-row"><span class="ff-stat-icon">💪</span><span class="ff-stat-label">Poder</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.power}">${h.power}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">👟</span><span class="ff-stat-label">Speed</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.speed}">${h.speed}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">📏</span><span class="ff-stat-label">Tamanho</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.range}">${h.range}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">💣</span><span class="ff-stat-label">Bombas</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.bombs}">${h.bombCapacity}</span></div>
      <div class="ff-stat-row"><span class="ff-stat-icon">⚡</span><span class="ff-stat-label">Stamina</span><span class="ff-stat-dots"></span><span class="ff-stat-value" style="color:${FF_STAT_COLORS.stamina}">${h.stamina}</span></div>
    </div>

    <footer class="ff-footer">
      <div class="ff-xp-wrap">
        <div class="ff-level-badge"><span class="ff-level-star">★</span><span class="ff-level-number">${h.level}</span></div>
        <div class="ff-xp-track">
          <div class="ff-xp-fill" id="ff-xp-fill" style="width:${xpPct}%"></div>
          <span class="ff-xp-text" id="ff-xp-text">${atMax ? 'MAX LEVEL' : `${fmtCurrency(state.starCore)} / ${fmtCurrency(cost)} Food Coins`}</span>
        </div>
        <button type="button" class="ff-evolve-btn" id="ff-levelup-btn" data-levelup-id="${h.id}" ${atMax ? 'disabled' : ''} title="${atMax ? 'Max level' : 'Level up'}">▲</button>
      </div>
      <div class="ff-actions-wrap">
        <button type="button" class="ff-toggle-btn${working ? ' ff-toggle-rest' : ''}" id="ff-work-btn" data-toggle-id="${h.id}">${working ? 'REST' : 'WORK'}</button>
      </div>
    </footer>
  `;
}

function renderInventory() {
  const heroes = sortedHeroes();
  // Default-select-first-hero (2026-07-23, confirmed): resolved HERE, before
  // building the grid, so the grid's selection ring (ff-card-selected) and
  // the details panel agree from the very first render — see the matching
  // comment/safety-net in renderInventoryDetails() for the direct-call path.
  if (selectedInventoryHeroId == null && heroes.length) {
    selectedInventoryHeroId = heroes[0].id;
  }
  document.getElementById('inventory-grid').innerHTML = heroes.length
    ? heroes.map(h => ffHeroCardHtml(h)).join('')
    : '<div class="locked-box">No Rangos yet — visit the Supermercado!</div>';
  const countEl = document.getElementById('ff-collected-count');
  if (countEl) countEl.textContent = `Rangos collected: ${heroes.length}`;
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
  const maxE = maxEnergyFor(h);
  const chip = document.getElementById('ff-energy-chip');
  if (chip) chip.textContent = `⚡ ${Math.floor(h.energy)}/${maxE}`;
  const atMax = h.level >= MAX_LEVEL;
  const cost = atMax ? 0 : levelCost(h);
  const xpPct = atMax ? 100 : Math.min(100, Math.round((state.starCore / cost) * 100));
  const fill = document.getElementById('ff-xp-fill');
  if (fill) fill.style.width = xpPct + '%';
  const text = document.getElementById('ff-xp-text');
  if (text) text.textContent = atMax ? 'MAX LEVEL' : `${fmtCurrency(state.starCore)} / ${fmtCurrency(cost)} Food Coins`;
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
        ${RARITIES.map(r => `<span class="rarity-badge rarity-${r}">${rTag(r)}</span> ${fmtPct(SHOP_RARITY_WEIGHTS[r])}`).join('<br>')}
      </div>
      <div class="price">${fmtCurrency(p.cost)} Chef Gems</div>
      <button class="btn" data-pack="${i}" ${state.bcoin < p.cost ? 'disabled' : ''}>Buy pack</button>
    </div>`).join('');
}

// Despensa (2026-07-23, was the Shop's "Houses" section — moved into its own
// dedicated tab per user request, replacing what used to be tab-prestige).
// Purchase is deliberately disabled unconditionally (not currency-gated like
// packs) — "onde guarda os rangos mais importantes" is a future mechanic not
// built yet, this only ships the browsing/showcase UI for now.
function renderDespensa() {
  document.getElementById('house-grid').innerHTML = HOUSES.map(h => `
    <div class="house-card">
      <h3>${h.emoji} ${h.name}</h3>
      <div class="muted">+${h.recovery.toFixed(1)} energy/s recovery</div>
      <div class="owned">Owned: ${state.houses[h.id]}</div>
      <div class="price">${fmtCurrency(h.cost)} Chef Gems</div>
      <button class="btn" data-house="${h.id}" disabled title="Em breve">Build</button>
    </div>`).join('');
}

// Targeted per-tick updates: rebuilding buttons via innerHTML every second
// would destroy the node between mousedown and mouseup, eating clicks
function updateShopButtons() {
  document.querySelectorAll('[data-pack]').forEach(b => {
    b.disabled = state.bcoin < PACKS[Number(b.dataset.pack)].cost;
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
    : `<div class="locked-box">No fusable Rangos (${rLabel('RECEITA_DE_VO')} is the ceiling — everything below it can attempt fusion).</div>`;
}

function renderRanking() {
  const rows = leaderboardCache
    .filter(r => r.username !== cloudUsername) // avoid double-listing yourself
    .map(r => ({ name: r.username, score: r.total_mined, player: false }));
  rows.push({ name: (cloudUsername || 'You') + ' 💣', score: state.totalMined, player: true });
  rows.sort((a, b) => b.score - a.score);
  document.querySelector('#ranking-table tbody').innerHTML = rows.map((r, i) => `
    <tr class="${r.player ? 'player-row' : ''}">
      <td>${['🥇', '🥈', '🥉'][i] || i + 1}</td>
      <td>${r.name}</td>
      <td>${fmtCurrency(r.score)}</td>
    </tr>`).join('');
}

function renderTasks() {
  const body = document.getElementById('tasks-body');
  if (state.heroes.length < TASKS_UNLOCK_HEROES) {
    body.innerHTML = `<div class="locked-box">🔒 Tasks unlock once you own <b>${TASKS_UNLOCK_HEROES} Rangos</b>.<br>
      You currently own ${state.heroes.length} — grab some packs in the 🛒 Loja!</div>`;
    return;
  }
  body.innerHTML = TASKS.map(t => {
    const claimed = state.tasksClaimed.includes(t.id);
    const ready = !claimed && t.check(state);
    return `
    <div class="task-item ${claimed ? 'done' : ''}">
      <div class="task-info">
        <div class="task-name">${claimed ? '✅' : ready ? '🟡' : '⬜'} ${t.name}</div>
        <div class="task-reward">Reward: ${fmtCurrency(t.reward)} Food Coins</div>
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
  renderDespensa();
  renderRanking();
  renderTasks();
}

/* ============ Lab rendering ============ */

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
  document.getElementById('reroll-cost').textContent = h ? `Cost: ${fmtCurrency(rerollCost(h))} Chef Gems` : '';
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
  out.textContent = `Cost: ${fmtCurrency(breedCost(p1, p2))} Chef Gems · Child rarity: ${rTag(childRarity)}`;
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

// Global Upgrade Tree's shop UI is out of the game for now (2026-07-23,
// pending a better home for it) — this used to be part of renderPrestige()
// (deleted along with the rest of Prestige). Deliberately left uncalled
// rather than deleted: state.upgrades/UPGRADE_DEFS/buyUpgrade() are all
// still fully wired into the real economy (globalMineMult()/blastRadius()/
// cooldownTicks()), only the shop card grid to SPEND into it is gone.
function renderUpgradeGrid() {
  document.getElementById('upgrade-grid').innerHTML = Object.keys(UPGRADE_DEFS).map(key => {
    const def = UPGRADE_DEFS[key];
    const lvl = state.upgrades[key] || 0;
    const cost = upgradeCost(key);
    return `
    <div class="upgrade-card">
      <h3>${def.icon} ${def.name}</h3>
      <p class="muted">${def.desc}</p>
      <div class="lvl">Level ${lvl}</div>
      <div class="price">${fmtCurrency(cost)} Chef Gems</div>
      <button class="btn btn-small" data-upgrade="${key}" ${state.bcoin < cost ? 'disabled' : ''}>Upgrade</button>
    </div>`;
  }).join('');
}

/* ============ Modal / Toast ============ */

const RARITY_INFO = {
  CASEIRO: `The everyday Rango — the bulk of pack pulls (${fmtPct(SHOP_RARITY_WEIGHTS.CASEIRO)} shop odds). Fuse 9 for a ${Math.round(FUSE_SUCCESS_CHANCE.CASEIRO * 100)}% shot at Temperado.`,
  TEMPERADO: `A real step up. ${fmtPct(SHOP_RARITY_WEIGHTS.TEMPERADO)} shop odds; 9× fusion succeeds ${Math.round(FUSE_SUCCESS_CHANCE.TEMPERADO * 100)}% of the time.`,
  GOURMET: `Heavy hitter. ${fmtPct(SHOP_RARITY_WEIGHTS.GOURMET)} shop odds — or fuse 9 Temperados (${Math.round(FUSE_SUCCESS_CHANCE.TEMPERADO * 100)}%).`,
  CHEF_RENOMADO: `The first tier that can roll Power skills. ${fmtPct(SHOP_RARITY_WEIGHTS.CHEF_RENOMADO)} shop odds, or fuse 9 Gourmets (${Math.round(FUSE_SUCCESS_CHANCE.GOURMET * 100)}%).`,
  ESTRELA_MICHELIN: `Genuinely rare. ${fmtPct(SHOP_RARITY_WEIGHTS.ESTRELA_MICHELIN)} shop odds — or a risky 9× Chef Renomado fusion (${Math.round(FUSE_SUCCESS_CHANCE.CHEF_RENOMADO * 100)}%).`,
  RECEITA_DE_VO: `The ceiling. ${fmtPct(SHOP_RARITY_WEIGHTS.RECEITA_DE_VO)} shop odds, or the ${Math.round(FUSE_SUCCESS_CHANCE.ESTRELA_MICHELIN * 100)}% miracle of fusing 9 Estrela Michelins. Cannot be fused further.`,
};

function showLegendModal() {
  document.getElementById('modal-body').innerHTML = `
    <h3>❓ Guia de raridades</h3>
    ${RARITIES.map((r, i) => {
      const c = RARITY_CONF[r];
      return `
      <div class="legend-row r-${r}">
        <span class="legend-sprite">${spriteHtml({ rarity: r, character: HERO_CHARACTERS[i % HERO_CHARACTERS.length] })}</span>
        <div>
          <span class="rarity-badge rarity-${r}">${rLabel(r)}</span>
          <div class="muted">💪 Poder ${c.power[0]}–${c.power[1]} · 📏 Tamanho ${c.range[0]}–${c.range[1]} · 👟 Speed ${c.speed[0]}–${c.speed[1]} · 💣 Bombas ${c.bombas[0]}–${c.bombas[1]} · ⚡ Stamina ${c.stamina[0]}–${c.stamina[1]} (Energy ${c.stamina[0] * 50}–${c.stamina[1] * 50})</div>
          <div class="muted">${RARITY_INFO[r]}</div>
        </div>
      </div>`;
    }).join('')}
    <h3 style="margin-top:16px">🌶️ Picante</h3>
    <div class="legend-row">
      <span class="legend-sprite">🌶️</span>
      <div><b>Picante</b><div class="muted">An independent variant ANY rarity can roll, separately from the rarity itself: ${fmtPct(PICANTE_CHANCE_SHOP)} from the Supermercado, ${fmtPct(PICANTE_CHANCE_JAULA_NORMAL)} from a Jaula (${fmtPct(PICANTE_CHANCE_JAULA_MERCADO_NOTURNO)} at Mercado Noturno). ${PICANTE_VISUAL_PLACEHOLDER} — renders identically to its base rarity for now.</div></div>
    </div>
    <h3 style="margin-top:16px">📦 Baús</h3>
    <div class="legend-row">
      <span class="legend-sprite legend-tileart"><img src="assets/blocos_unicos/bau_madeira.png" alt="Baú"></span>
      <div><b>5 tiers, fixed HP + reward</b><div class="muted">Every chest shows an HP bar (🟢 healthy · 🟠 below 50% · 🔴 below 30%). Each bomb hit deals the Rango's ⛏️ rate as damage.<br>
      Madeira: ${CHEST_TIER_HP.MADEIRA} HP, ${CHEST_TIER_REWARD_RANGE.MADEIRA[0].toFixed(2)}–${CHEST_TIER_REWARD_RANGE.MADEIRA[1].toFixed(2)} Food Coins ·
      Ferro: ${CHEST_TIER_HP.FERRO} HP, ${CHEST_TIER_REWARD_RANGE.FERRO[0].toFixed(2)}–${CHEST_TIER_REWARD_RANGE.FERRO[1].toFixed(2)} ·
      Ouro: ${CHEST_TIER_HP.OURO} HP, ${CHEST_TIER_REWARD_RANGE.OURO[0].toFixed(2)}–${CHEST_TIER_REWARD_RANGE.OURO[1].toFixed(2)} ·
      Diamante: ${CHEST_TIER_HP.DIAMANTE} HP, ${CHEST_TIER_REWARD_RANGE.DIAMANTE[0].toFixed(2)}–${CHEST_TIER_REWARD_RANGE.DIAMANTE[1].toFixed(2)} ·
      VIP: ${CHEST_TIER_HP.VIP} HP, ${CHEST_TIER_REWARD_RANGE.VIP[0].toFixed(2)}–${CHEST_TIER_REWARD_RANGE.VIP[1].toFixed(2)}.</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">🔒</span>
      <div><b>Jaula</b><div class="muted">${JAULA_HP} HP. Grants exactly 1 Rango instead of Food Coins — no Skill Shard roll, the Rango IS the reward. ${fmtPct(JAULA_SPAWN_CHANCE_NORMAL)} chance per map (${fmtPct(JAULA_SPAWN_CHANCE_MERCADO_NOTURNO)} at Mercado Noturno).</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite legend-tileart"><img src="assets/blocos_unicos/mesa_variavel.png" alt="Mesa Variável"></span>
      <div><b>Mesa Variável</b><div class="muted">${MESA_VARIAVEL_HP} HP, destructible obstacle — pays no Food Coins, but clears the path and is a valid Temperamental chain target.</div></div>
    </div>
    <h3 style="margin-top:16px">✨ Skills básicos</h3>
    <p class="muted" style="margin-bottom:8px">5 possible Basic skills total — each roll picks uniformly among them (the second roll excludes whichever one the first roll already picked, so a Rango never gets the same Basic skill twice). Rolled independently per category (Basic/Power) at Rango creation — the chance to roll at least one, and the chance to roll BOTH, both climb with rarity. See the rarity guide above for the exact odds per tier.</p>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.MASSA_LEVE.icon}</span>
      <div><b>${SKILL_DEFS.MASSA_LEVE.label}</b><div class="muted">${SKILL_DEFS.MASSA_LEVE.text}</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.CAFEINADO.icon}</span>
      <div><b>${SKILL_DEFS.CAFEINADO.label}</b><div class="muted">${SKILL_DEFS.CAFEINADO.text}</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.SUSTANCIA.icon}</span>
      <div><b>${SKILL_DEFS.SUSTANCIA.label}</b><div class="muted">${SKILL_DEFS.SUSTANCIA.text}</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.ESPETINHO.icon}</span>
      <div><b>${SKILL_DEFS.ESPETINHO.label}</b><div class="muted">${SKILL_DEFS.ESPETINHO.text}</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.AL_DENTE.icon}</span>
      <div><b>${SKILL_DEFS.AL_DENTE.label}</b><div class="muted">${SKILL_DEFS.AL_DENTE.text}</div></div>
    </div>
    <h3 style="margin-top:16px">👑 Skills de poder</h3>
    <p class="muted" style="margin-bottom:8px">Only ever rolled from Chef Renomado upward — never on Caseiro/Temperado/Gourmet. See the rarity guide above for the exact odds per tier.</p>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.FOLHADO_DE_OURO.icon}</span>
      <div><b>${SKILL_DEFS.FOLHADO_DE_OURO.label}</b><div class="muted">${SKILL_DEFS.FOLHADO_DE_OURO.text}</div></div>
    </div>
    <div class="legend-row">
      <span class="legend-sprite">${SKILL_DEFS.TEMPERAMENTAL.icon}</span>
      <div><b>${SKILL_DEFS.TEMPERAMENTAL.label}</b><div class="muted">${SKILL_DEFS.TEMPERAMENTAL.text}</div></div>
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

// Judgment call (flagged in the session report, not given explicit numbers
// by the master spec, which doesn't mention pull-reveal celebration at
// all): CHEF_RENOMADO+ is the new "celebrated" threshold, replacing the old
// Legendary+ (index 3 of 8) with the same relative "upper tiers" position
// on the new 6-tier ladder (index 3 of 6).
function isCelebrated(h) {
  return RARITIES.indexOf(h.rarity) >= RARITIES.indexOf('CHEF_RENOMADO');
}

// speed mode never lets a celebrated card fly by: celebrated pulls always
// hold the screen for the full (or mega) duration, then speed resumes.
// Picante (2026-07-23) joins that exemption — independent of rarity, it's
// the single most-wanted pull in the game per explicit design intent, so
// Speed mode must never blur past one either.
function revealDelay(h, speed) {
  if (h.rarity === 'RECEITA_DE_VO') return REVEAL_MEGA_MS;
  if (isCelebrated(h) || h.isSpicy) return REVEAL_MS;
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
  if (h.isSpicy) playPicanteCelebration(h);
  reveal.timer = setTimeout(advanceReveal, revealDelay(h, reveal.speed));
}

function renderRevealCard(h) {
  const count = document.getElementById('reveal-count');
  if (count) count.textContent = `${reveal.idx + 1} / ${reveal.heroes.length}`;
  const slot = document.getElementById('reveal-card-slot');
  if (!slot) return;
  slot.innerHTML = `
    <div class="reveal-card r-${h.rarity}${isCelebrated(h) ? ' celebrate' : ''}${h.isSpicy ? ' picante' : ''}" id="reveal-card" title="Click to continue">
      <span class="reveal-sprite">${spriteHtml(h)}</span>
      <div class="reveal-name">${h.name}</div>
      <span class="rarity-badge rarity-${h.rarity}">${rLabel(h.rarity)}</span>
      <div class="reveal-stats">
        💪 ${h.power} &nbsp; 📏 ${h.range} &nbsp; 👟 ${h.speed} &nbsp; 💣 ${h.bombCapacity} &nbsp; ⚡ ${maxEnergyFor(h)}<br>
        ⛏️ ${mineRate(h).toFixed(2)} dmg/s
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

// Jaula frees exactly one Rango at a time — reuses the same rich
// single-card reveal (portrait, stats, skills, celebration) shop pulls
// already get, just with Jaula-specific framing on the summary screen
function startJaulaReveal(hero) {
  startPackReveal([hero], `🔓 Rango libertado! ${rLabel(hero.rarity)} ${hero.name} entra pro seu time:`);
}

function cancelReveal() {
  if (!reveal) return;
  clearTimeout(reveal.timer);
  reveal = null;
}

function playCelebration(h) {
  const flash = document.createElement('div');
  flash.className = 'reveal-flash' + (h.rarity === 'RECEITA_DE_VO' ? ' mega-flash' : '');
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 900);
  if (h.rarity === 'RECEITA_DE_VO') {
    const mega = document.createElement('div');
    mega.className = 'mega-overlay';
    mega.innerHTML = '<div class="mega-text">🍲 RECEITA DE VÓ 🍲</div>';
    document.body.appendChild(mega);
    document.body.classList.add('shaking');
    setTimeout(() => { mega.remove(); document.body.classList.remove('shaking'); }, 2800);
    playMegaSound();
  }
}

// Picante celebration (2026-07-23): independent of rarity — a Caseiro
// Picante gets the exact same fire treatment as a Receita de Vó Picante,
// on purpose, per explicit design intent ("o boneco mais legal de se ter",
// stacks alongside — never replaces — the rarity's own playCelebration()).
// Bursts SKILL_ICON-style ember/pepper glyphs outward from the reveal
// card's actual on-screen position (not a fixed point), same
// create-element/setTimeout-cleanup pattern playCelebration() already uses
// for its flash div, just repeated per particle.
const PICANTE_PARTICLE_GLYPHS = ['🌶️', '🔥', '✨'];
const PICANTE_PARTICLE_COUNT = 20;
function playPicanteCelebration(h) {
  const flash = document.createElement('div');
  flash.className = 'reveal-flash picante-flash';
  document.body.appendChild(flash);
  setTimeout(() => flash.remove(), 900);

  const card = document.getElementById('reveal-card');
  const rect = card ? card.getBoundingClientRect() : null;
  const originX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
  const originY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  for (let i = 0; i < PICANTE_PARTICLE_COUNT; i++) {
    const p = document.createElement('div');
    p.className = 'picante-particle';
    p.textContent = PICANTE_PARTICLE_GLYPHS[i % PICANTE_PARTICLE_GLYPHS.length];
    const angle = (Math.PI * 2 * i) / PICANTE_PARTICLE_COUNT + (Math.random() - 0.5) * 0.5;
    const dist = 110 + Math.random() * 120;
    p.style.left = originX + 'px';
    p.style.top = originY + 'px';
    p.style.setProperty('--dx', (Math.cos(angle) * dist).toFixed(0) + 'px');
    p.style.setProperty('--dy', (Math.sin(angle) * dist).toFixed(0) + 'px');
    p.style.setProperty('--rot', (Math.random() * 720 - 360).toFixed(0) + 'deg');
    p.style.animationDelay = (Math.random() * 0.18).toFixed(2) + 's';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1400);
  }
  playPicanteSound();
}

// synthesized sizzle — a short filtered-noise burst (the "hiss") plus a
// rising sawtooth swoop underneath (the "whoosh"), same synthesized/no-
// external-assets approach as playMegaSound() but built from a noise
// buffer instead of pure tones, since a sizzle reads as noise, not pitch
function playPicanteSound() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const dur = 0.5;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3200;
    filter.Q.value = 0.7;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.35, ctx.currentTime);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start();

    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(180, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.35);
    og.gain.setValueAtTime(0.001, ctx.currentTime);
    og.gain.linearRampToValueAtTime(0.08, ctx.currentTime + 0.08);
    og.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(og);
    og.connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.45);

    setTimeout(() => ctx.close(), 900);
  } catch (e) {}
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

  // Extras is our de facto settings page (Reset, Account, etc.)
  document.getElementById('settings-btn').addEventListener('click', () => switchTab('extras'));

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
    // data-close-details handler REMOVED (2026-07-23, user-flagged): the
    // close/deselect button itself is gone (see renderInventoryDetails()) —
    // default-select-first-hero means there's no clean "empty" state to
    // close back to while heroes are owned, so the whole affordance is gone,
    // not just hidden.
    const t = e.target.closest('[data-toggle-id]');
    if (t) { toggleMode(Number(t.dataset.toggleId)); return; }
    const l = e.target.closest('[data-levelup-id]');
    if (l) { levelUp(Number(l.dataset.levelupId)); return; }
    // LAB button removed from this footer (2026-07-23 UI rework) — the
    // data-lab-id wiring that used to live here is gone, but
    // jumpToLabForReroll() itself is untouched and still fully reachable
    // from the Lab tab's own re-roll flow, per instruction.
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
    if (e.target.closest('#reveal-card')) advanceReveal();
  });

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

  document.getElementById('ref-copy').addEventListener('click', () => {
    const link = `https://foodfighters.example/ref/${state.refCode}`;
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

  document.getElementById('reset-btn').addEventListener('click', async () => {
    if (!confirm('Wipe all Food Fighters progress?')) return;
    // BUG FIX (2026-07-23): this button never actually worked. Two separate
    // bugs stacked:
    // 1) It only did `localStorage.removeItem(SAVE_KEY); location.reload();`
    //    — but location.reload() fires 'beforeunload' synchronously BEFORE
    //    navigating, and this file has a `beforeunload` listener that calls
    //    save(), which re-serializes whatever is STILL in the in-memory
    //    `state` object (i.e. the old, un-reset progress) right back into
    //    localStorage before the page actually unloads. The removeItem()
    //    was always overwritten a moment later, every single time.
    // 2) For a logged-in cloud player, even a successful local wipe would
    //    get pulled straight back from the cloud on the reload (localFreshOnBoot
    //    correctly trusts the cloud after a genuinely-accidental local wipe —
    //    exactly wrong for THIS deliberate one).
    // Fix: build the fresh state in memory FIRST (same bootstrap load() uses
    // for a brand-new game, via newGameState()) and save() it immediately —
    // so any beforeunload autosave just re-persists the already-wiped state,
    // a harmless no-op instead of a silent revert. Then, if signed in,
    // delete the player's own cloud rows (allowed by the owner-can-delete
    // policies in supabase/schema.sql) so there's nothing stale left for
    // pullCloudSave() to restore on reload either.
    if (cloudSignedIn()) {
      const [savesRes, leaderboardRes] = await Promise.all([
        sb.from('saves').delete().eq('user_id', cloudSession.user.id),
        sb.from('leaderboard').delete().eq('user_id', cloudSession.user.id),
      ]);
      if (savesRes.error || leaderboardRes.error) {
        toast('Falha ao limpar a nuvem — tente de novo.');
        return;
      }
    }
    newGameState();
    save();
    location.reload();
  });

  window.addEventListener('beforeunload', save);

  document.getElementById('account-btn').addEventListener('click', showAccountModal);
  document.getElementById('modal-body').addEventListener('click', e => {
    if (e.target.closest('#cloud-signup-btn')) cloudSignUp();
    else if (e.target.closest('#cloud-signin-btn')) cloudSignIn();
    else if (e.target.closest('#cloud-signout-btn')) cloudSignOut();
    else if (e.target.closest('#admin-grant-btn')) grantCurrency();
  });

  // Admin panel (2026-07-23) — see this button's own comment in index.html:
  // showing/hiding #admin-box is a pure client-side convenience, never the
  // real security boundary (the admin-grant-currency Edge Function
  // re-verifies the caller's identity itself, server-side, regardless).
  const adminBtn = document.getElementById('admin-btn');
  if (adminBtn) adminBtn.addEventListener('click', showAdminModal);
}

// Called from enterGame() once cloudSession is known — shows/hides the
// Extras-tab admin box based on the CLIENT's own read of the logged-in
// email. Deliberately named separately from bindEvents() since it needs to
// re-run every time cloudSession changes (login/logout), not just once at
// boot.
function updateAdminVisibility() {
  const box = document.getElementById('admin-box');
  if (!box) return;
  const isAdmin = !!(cloudSession && cloudSession.user && cloudSession.user.email === ADMIN_EMAIL);
  box.hidden = !isAdmin;
}

function showAdminModal() {
  document.getElementById('modal-body').innerHTML = `
    <h3>🛠️ Admin — conceder moeda</h3>
    <p class="muted">Isso chama a Edge Function admin-grant-currency, que reverifica sua identidade no servidor — este painel é só conveniência de UI.</p>
    <input id="admin-target-username" type="text" placeholder="Nome de usuário do jogador" style="width:100%;margin-bottom:6px;">
    <select id="admin-currency" style="width:100%;margin-bottom:6px;">
      <option value="starCore">Food Coins</option>
      <option value="bcoin">Chef Gems</option>
    </select>
    <input id="admin-amount" type="number" min="0" step="0.01" placeholder="Quantidade" style="width:100%;margin-bottom:10px;">
    <button id="admin-grant-btn" class="btn">Conceder</button>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

async function grantCurrency() {
  if (!sb) { toast('Sincronização não configurada neste build.'); return; }
  const targetUsername = document.getElementById('admin-target-username').value.trim();
  const currency = document.getElementById('admin-currency').value;
  const amount = Number(document.getElementById('admin-amount').value);
  if (!targetUsername) { toast('Informe o nome de usuário do jogador.'); return; }
  if (!Number.isFinite(amount) || amount <= 0) { toast('Informe uma quantidade positiva.'); return; }
  // the currently authenticated session's JWT is attached automatically by
  // sb.functions.invoke() — no manual header wiring needed, and no client
  // value here is trusted server-side anyway (see the Edge Function itself)
  const { data, error } = await sb.functions.invoke('admin-grant-currency', {
    body: { targetUsername, currency, amount },
  });
  if (error) { toast('Erro: ' + (error.message || 'falha ao conceder')); return; }
  if (data && data.error) { toast('Erro: ' + data.error); return; }
  toast(`✅ ${fmtCurrency(amount)} ${currency === 'starCore' ? 'Food Coins' : 'Chef Gems'} concedido(s) a ${data.targetUsername} — novo saldo: ${fmtCurrency(data.newBalance)}`);
}

/* ============ Cloud Sync (Supabase) ============ */
//
// MANDATORY LOGIN (2026-07-23): login is no longer optional — there is no
// more anonymous/guest play at all. `sb` staying null (no config.js/offline/
// Supabase down) is still handled gracefully everywhere below (every
// function no-ops), but in practice a real deployment always has it
// configured now, since the game literally cannot be reached without it —
// see enterGame()/showLoginScreen() and the boot sequence at the bottom of
// this file. localStorage remains the fast, always-on save path (see
// save()/load()); this layer mirrors that state to the cloud so a logged-in
// player can pick up on another device and appear on the shared leaderboard.
//
// "Lembrar de mim" (remember me): Supabase JS lets you choose WHERE the
// session token is written via the `storage` option passed to
// createClient() — localStorage survives closing the browser entirely,
// sessionStorage is cleared the instant the browser/tab actually closes but
// still survives a plain page refresh (persistSession stays true either
// way — only the storage TARGET changes, matching "unchecked = doesn't
// survive closing the browser", not "logs out on every refresh"). Since
// this choice has to be made at createClient() time, `sb` is now a `let`,
// (re)built by createSupabaseClient() — once at boot using whatever
// preference was saved last time (so a returning "remembered" session can
// actually be found), and again at login time if the checkbox differs from
// that.
const REMEMBER_ME_KEY = 'foodfighters-remember-me';
function getRememberMePref() {
  try { const v = localStorage.getItem(REMEMBER_ME_KEY); return v === null ? true : v === 'true'; } catch (e) { return true; }
}
function setRememberMePref(v) {
  try { localStorage.setItem(REMEMBER_ME_KEY, v ? 'true' : 'false'); } catch (e) {}
}
function createSupabaseClient(persist) {
  if (!(window.supabase && window.SUPABASE_URL)) return null;
  return window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, storage: persist ? window.localStorage : window.sessionStorage },
  });
}
let sbPersistMode = getRememberMePref();
let sb = createSupabaseClient(sbPersistMode);

let cloudSession = null;
let cloudUsername = null;
let leaderboardCache = [];
const USERNAME_KEY = 'foodfighters-username'; // brand rename (2026-07-22) — migrated from 'bombheroes-username' near the bottom of this file, alongside SAVE_KEY/UI_PREF_KEY

// Admin panel (2026-07-23): CLIENT-SIDE convenience check only — matches
// this exact email so the Extras-tab admin box shows for the one real
// admin. This is NOT the security boundary; the admin-grant-currency Edge
// Function hardcodes and re-verifies the same address itself, server-side,
// from the caller's own Supabase-verified JWT — never trusting anything
// the client claims. Even if this constant were changed/removed/spoofed in
// devtools, the Edge Function would still refuse anyone else.
const ADMIN_EMAIL = 'joaohermeto@hotmail.com';

function cloudSignedIn() { return !!cloudSession; }

async function restoreCloudSession() {
  if (!sb) return;
  const { data } = await sb.auth.getSession();
  cloudSession = data && data.session ? data.session : null;
  if (cloudSession) {
    cloudUsername = localStorage.getItem(USERNAME_KEY) || cloudSession.user.email.split('@')[0];
    await pullCloudSave();
  }
  refreshLeaderboard();
}

// shared by the login screen's "Entrar" button AND cloudSignIn() itself —
// reads the remember-me checkbox (if present — the login screen has one;
// nothing else needs to) and recreates `sb` first if the player's choice
// differs from whatever it was already built with, so the resulting
// session is written to the RIGHT storage from the very first request.
function applyRememberMeChoiceFromCheckbox() {
  const box = document.getElementById('remember-me');
  const remember = box ? !!box.checked : true;
  setRememberMePref(remember);
  if (remember !== sbPersistMode) {
    sbPersistMode = remember;
    sb = createSupabaseClient(remember);
  }
}

async function cloudSignUp() {
  if (!sb) return;
  const email = document.getElementById('cloud-email').value.trim();
  const pw = document.getElementById('cloud-pw').value;
  const username = document.getElementById('cloud-username').value.trim();
  if (!email || !pw || !username) { toast('Preencha email, senha e nome de jogador.'); return; }
  applyRememberMeChoiceFromCheckbox();
  const { data, error } = await sb.auth.signUp({ email, password: pw });
  if (error) { toast('Erro ao criar conta: ' + error.message); return; }
  cloudSession = data.session;
  cloudUsername = username;
  localStorage.setItem(USERNAME_KEY, username);
  if (cloudSession) {
    await pushCloudSave();
    toast('Conta criada e sincronizada!');
    enterGame(); // mandatory login: signup with an immediate session goes straight into the game, not to the account modal
  } else {
    toast('Conta criada — confirme o email antes de entrar (verifique a caixa de entrada).');
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) backdrop.classList.add('hidden'); // close the signup modal, back to the login screen to wait for email confirmation
  }
}

async function cloudSignIn() {
  if (!sb) return;
  // BUG FIX (2026-07-23): the login screen's own fields are #login-email/
  // #login-pw (renamed from #cloud-email/#cloud-pw, which collided with the
  // signup/account modal's fields of the same id — see index.html's comment
  // on #login-screen). Prefer those; fall back to #cloud-email/#cloud-pw for
  // the modal's own "Já tenho conta — Entrar" path.
  const emailEl = document.getElementById('login-email') || document.getElementById('cloud-email');
  const pwEl = document.getElementById('login-pw') || document.getElementById('cloud-pw');
  const email = emailEl.value.trim();
  const pw = pwEl.value;
  if (!email || !pw) { toast('Preencha email e senha.'); return; }
  applyRememberMeChoiceFromCheckbox();
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pw });
  if (error) { toast('Erro ao entrar: ' + error.message); return; }
  cloudSession = data.session;
  cloudUsername = localStorage.getItem(USERNAME_KEY) || email.split('@')[0];
  await pullCloudSave();
  enterGame(); // mandatory login: this IS the entry point into the game now
  toast('Login feito — progresso sincronizado.');
}

async function cloudSignOut() {
  if (!sb) return;
  await sb.auth.signOut();
  cloudSession = null;
  cloudUsername = null;
  // MANDATORY LOGIN (2026-07-23): signing out returns to the login screen —
  // there is no more "keep playing signed out" path, matching the hard gate
  // (a player can never be IN the game without an authenticated session).
  showLoginScreen();
  toast('Você saiu da conta.');
}

// Cloud is treated as source of truth when its save is newer than the local
// one (e.g. player progressed on another device) — otherwise we push local up.
// FIX (2026-07-23, urgent, master spec #1/#5): this used to (a) compare ONLY
// data.updated_at vs state.lastSeen, which fails hard whenever local storage
// is empty/wiped (a fresh local game's own save() stamps lastSeen to "right
// now", always beating any real cloud timestamp — see localFreshOnBoot's
// comment), and (b) always regenerated a brand-new map with a bare
// genLayout() call on every cloud-wins pull instead of reusing load()'s
// restore-or-regenerate logic, silently discarding the player's in-progress
// map (and anything earned since the last cloud push) every time this
// branch fired. Both fixed here.
async function pullCloudSave() {
  if (!sb || !cloudSession) return;
  const { data, error } = await sb
    .from('saves')
    .select('state, updated_at')
    .eq('user_id', cloudSession.user.id)
    .maybeSingle();
  if (error || !data) { localFreshOnBoot = false; await pushCloudSave(); return; }
  const cloudWins = localFreshOnBoot || new Date(data.updated_at).getTime() > (state.lastSeen || 0);
  // consumed here regardless of outcome — only the FIRST pullCloudSave()
  // call after a genuinely fresh boot should ever be affected by this; a
  // LATER manual cloudSignIn() in the same session (after real local play
  // has happened) must fall back to the normal timestamp comparison
  localFreshOnBoot = false;
  if (cloudWins) {
    state = Object.assign(defaultState(), data.state);
    state.houses = Object.assign({ tent: 0, cabin: 0, villa: 0, fortress: 0 }, data.state.houses);
    state.upgrades = Object.assign({ mining: 0, blast: 0, haste: 0 }, data.state.upgrades);
    // gridTiles/tileHp/cratesLeft/cratesTotal travel inside data.state the
    // same way they travel inside the local save blob (see saveSnapshot()) —
    // strip them back off state itself, mirroring load()'s own handling
    delete state.gridTiles; delete state.tileHp; delete state.cratesLeft; delete state.cratesTotal;
    const waveAtSave = state.wave;
    // SAME restore-or-regenerate logic load() uses — was a bare genLayout()
    // call before (see this function's own comment above)
    restoreOrGenerateGrid(data.state, waveAtSave);
    save();
    buildArena();
    syncActors();
    renderAll();
  } else {
    await pushCloudSave();
  }
}

async function pushCloudSave() {
  if (!sb || !cloudSession) return;
  await sb.from('saves').upsert({
    user_id: cloudSession.user.id,
    // FIX (2026-07-23, master spec #1/#5): used to push the bare `state`
    // object, which never carried gridTiles/tileHp/cratesLeft/cratesTotal/
    // mapSeed at all — meaning a cloud pull could NEVER restore a mid-wave
    // map even with pullCloudSave()'s restore logic fixed, since the row
    // simply never had a valid grid to restore in the first place. Same
    // snapshot shape save() writes locally now (saveSnapshot()).
    state: saveSnapshot(),
    updated_at: new Date().toISOString(),
  });
  await sb.from('leaderboard').upsert({
    user_id: cloudSession.user.id,
    username: cloudUsername || 'Miner',
    wave: state.wave,
    // FIX (2026-07-23, master spec #2): Math.floor() truncated fractional
    // lifetime totals to integers — with the whole economy now in fractions
    // of a Food Coin (chest rewards are 0.01-3.00), this could show "0" on
    // the shared leaderboard for a long time even though totalMined was
    // genuinely accumulating. Round to 2 decimals instead of flooring.
    total_mined: Math.round(state.totalMined * 100) / 100,
  });
}

async function refreshLeaderboard() {
  if (!sb) return;
  // FILTER (2026-07-23): only show players with real progress. Without this,
  // dormant accounts sitting at total_mined:0 (test/throwaway accounts, or
  // just a brand-new real player who hasn't earned anything yet) clutter the
  // shared ranking. Display-only — never deletes anything — and a real
  // player naturally starts showing up the moment they earn their first
  // Food Coin. This is the ONLY place the leaderboard is queried (the
  // Realtime subscription below re-fetches through this exact function too,
  // rather than querying separately — see subscribeLeaderboardRealtime()'s
  // own comment), so one filter here covers every render path.
  const { data } = await sb
    .from('leaderboard')
    .select('username, total_mined')
    .gt('total_mined', 0)
    .order('total_mined', { ascending: false })
    .limit(20);
  leaderboardCache = data || [];
  const active = document.querySelector('.tab-panel.active');
  if (active && active.id === 'tab-ranking') renderRanking();
}

// REAL-TIME RANKING (2026-07-23, master spec #4): a Supabase Realtime
// subscription on the `leaderboard` table's Postgres changes (over
// websocket, via `sb.channel().on('postgres_changes', ...)`) — ANY row
// changing (any player, not just this one) pushes here instantly instead of
// waiting for the next 30s poll. Re-fetches through the existing
// refreshLeaderboard() (rather than hand-patching leaderboardCache from the
// raw payload) so the cache stays correctly sorted/deduped/limited-to-20 by
// the same single source of truth the rest of the game already uses, and
// re-renders live if the Ranking tab happens to be open; if it's not open,
// there's nothing to re-render, but leaderboardCache is already fresh so
// opening it later shows current data immediately, with no wait for the
// next poll. Idempotent (safe to call more than once — never double-
// subscribes) and a safe no-op with no `sb` (offline/local-only build).
let leaderboardChannel = null;
function subscribeLeaderboardRealtime() {
  if (!sb || leaderboardChannel) return;
  leaderboardChannel = sb
    .channel('leaderboard-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'leaderboard' }, () => {
      refreshLeaderboard();
    })
    .subscribe();
}

// Throttled push triggered right after a chest/Jaula reward event (master
// spec #4: "keep pushing... don't throttle to 15 minutes... or trigger a
// push right after a reward event, throttled sensibly to avoid hammering
// the DB on every single tiny reward") — a wood-tier chest can pay out
// every couple seconds at a strong squad's mining rate, so this is a real
// per-event throttle (not just relying on the 30s interval), independent of
// it. REWARD_PUSH_THROTTLE_MS is deliberately much shorter than the 30s
// background interval (this is the "as it happens" fast path; the interval
// remains the steady baseline/fallback for players not actively cracking
// chests).
let lastRewardPush = 0;
const REWARD_PUSH_THROTTLE_MS = 5000;
function pushCloudSaveThrottled() {
  if (!cloudSignedIn()) return;
  const now = Date.now();
  if (now - lastRewardPush < REWARD_PUSH_THROTTLE_MS) return;
  lastRewardPush = now;
  pushCloudSave();
}

function showAccountModal() {
  document.getElementById('modal-body').innerHTML = sb
    ? (cloudSignedIn()
      ? `
        <h3>☁️ Conta na nuvem</h3>
        <p>Logado como <b>${cloudUsername}</b>. Progresso sincronizado entre dispositivos e visível no ranking.</p>
        <button id="cloud-signout-btn" class="btn">Sair da conta</button>`
      // MANDATORY LOGIN (2026-07-23): this "logged out but inside the
      // game" branch is now unreachable in practice — signing out
      // (cloudSignOut()) goes straight to the login screen instead of
      // leaving the game visible, and there is no way to reach account-btn
      // (hidden pre-auth) without a session either. Left in place as
      // harmless defensive dead code rather than deleted.
      : `
        <h3>☁️ Conta na nuvem</h3>
        <p class="muted">Crie uma conta pra sincronizar seu progresso entre PC/celular e entrar no ranking compartilhado.</p>
        <input id="cloud-username" type="text" placeholder="Nome de jogador (aparece no ranking)" style="width:100%;margin-bottom:6px;">
        <input id="cloud-email" type="email" placeholder="Email" style="width:100%;margin-bottom:6px;">
        <input id="cloud-pw" type="password" placeholder="Senha (mín. 6 caracteres)" style="width:100%;margin-bottom:10px;">
        <button id="cloud-signup-btn" class="btn">Criar conta</button>
        <button id="cloud-signin-btn" class="btn btn-ghost">Já tenho conta — Entrar</button>`)
    : `<h3>☁️ Conta na nuvem</h3><p class="muted">Sincronização não configurada neste build.</p>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

// "Cadastro" on the login screen opens this — the SAME cloudSignUp() field
// ids (cloud-username/cloud-email/cloud-pw) and the SAME #cloud-signup-btn
// click delegation already wired in bindEvents() (see #modal-body's click
// listener), so no new event binding was needed for the button itself.
function showSignupModal() {
  document.getElementById('modal-body').innerHTML = `
    <h3>☁️ Criar conta</h3>
    <p class="muted">Crie uma conta pra sincronizar seu progresso entre PC/celular e entrar no ranking compartilhado.</p>
    <input id="cloud-username" type="text" placeholder="Nome de jogador (aparece no ranking)" style="width:100%;margin-bottom:6px;">
    <input id="cloud-email" type="email" placeholder="Email" style="width:100%;margin-bottom:6px;">
    <input id="cloud-pw" type="password" placeholder="Senha (mín. 6 caracteres)" style="width:100%;margin-bottom:10px;">
    <button id="cloud-signup-btn" class="btn">Criar conta</button>`;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

// MANDATORY LOGIN (2026-07-23): these two are the ONLY places that ever
// toggle body.ff-authed (see style.css's gating rules) — enterGame() is the
// sole path that reveals the game shell AND starts its recurring background
// work (ticks/Realtime/periodic push), called either right after
// restoreCloudSession() finds a valid session at boot, or after a
// successful login/signup. showLoginScreen() is the default/logged-out
// state — nothing else in this file ever adds/removes that class.
let gameStarted = false;
function enterGame() {
  document.body.classList.add('ff-authed');
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.classList.add('hidden'); // close the login screen's signup modal if it was open
  updateAdminVisibility(); // re-checked on every entry, not just the first — cloudSession may differ after a sign-out+different-account-back-in
  if (gameStarted) return; // a later login (e.g. after a mid-session sign-out+back-in) shouldn't re-run boot-only setup
  gameStarted = true;
  document.getElementById('ref-code').textContent = `https://foodfighters.example/ref/${state.refCode}`;
  applyTheme(state.activeThemeId);
  buildArena();
  syncActors();
  renderAll();
  setInterval(economyTick, 1000);
  setInterval(aiTick, AI_MS);
  subscribeLeaderboardRealtime();
  setInterval(() => { if (cloudSignedIn()) pushCloudSave(); }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && cloudSignedIn()) pushCloudSave();
  });
  window.addEventListener('beforeunload', () => { if (cloudSignedIn()) pushCloudSave(); });
}
function showLoginScreen() {
  document.body.classList.remove('ff-authed');
  updateAdminVisibility(); // cloudSession is null again post-sign-out — hide the admin box along with everything else
}

/* ============ Init ============ */

const UI_PREF_KEY = 'foodfighters-ui'; // brand rename (2026-07-22) — migrated from 'bombheroes-ui' just below, alongside SAVE_KEY/USERNAME_KEY

// Brand rename (2026-07-22): same one-time-migration reasoning as
// SAVE_KEY/OLD_SAVE_KEY above, applied to the other old "bombheroes-*"
// localStorage key for the returning player's cloud username. UI_PREF_KEY's
// own migration line is now a harmless no-op — the bottom-nav collapse
// feature it used to feed (loadUiPrefs()/setBottomNavCollapsed()) was
// removed 2026-07-23 along with the toggle button, nothing reads this key
// anymore.
function migrateOldBrandKey(oldKey, newKey) {
  try {
    if (localStorage.getItem(newKey) === null) {
      const old = localStorage.getItem(oldKey);
      if (old !== null) localStorage.setItem(newKey, old);
    }
  } catch (e) {}
}
migrateOldBrandKey('bombheroes-username', USERNAME_KEY);
migrateOldBrandKey('bombheroes-ui', UI_PREF_KEY);

// load() itself now guarantees gridTiles/tileHp are populated — either
// restored from the save (mid-wave resume) or freshly generated internally
// (new game / old save / offline-wave-advance) — so no separate genLayout()
// call is needed anywhere here; buildArena() (inside enterGame()) just
// renders whatever load() left. load() itself is still unconditional and
// synchronous (cheap, local-only, sets up `state` so pullCloudSave() below
// has something to compare against) — it does NOT reveal anything by
// itself; only enterGame() ever does that.
load();
bindEvents(); // safe to bind immediately — login-screen/modal buttons are inert until clicked regardless of auth state

// MANDATORY LOGIN (2026-07-23): the game shell/ticks/Realtime subscription
// only ever start via enterGame() (see its own comment) — reached either
// automatically here if restoreCloudSession() finds a valid session
// (possibly pulling a fresher cloud state first via pullCloudSave(), same
// as before this gate existed), or later via cloudSignIn()/cloudSignUp()
// when the player logs in from the login screen. No path renders the game
// without a confirmed session (showLoginScreen() — the default state, since
// body never gets .ff-authed otherwise — is what's visible until then).
(async function boot() {
  await restoreCloudSession();
  if (cloudSignedIn()) enterGame();
  else showLoginScreen();
})();

document.getElementById('login-btn').addEventListener('click', cloudSignIn);
document.getElementById('show-signup-btn').addEventListener('click', showSignupModal);
