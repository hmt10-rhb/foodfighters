// Food Fighters — server-side pack opening (2026-07-24, emergency fix)
//
// WHY THIS EXISTS: buyPack() in game.js used to roll hero rarity/stats
// ENTIRELY client-side, then push the result via the player's own
// pushCloudSave() — nothing on the server ever verified the roll was fair.
// Two real exploits were found within minutes of each other in production:
// direct currency injection (`state.starCore += N`) and monkey-patching
// SHOP_RARITY_WEIGHTS/buyPack() itself to force a guaranteed Receita de Vó
// pull. A DB-side rate-limit trigger (saves_guard(), see schema.sql) was
// shipped as an emergency stopgap for both, but it can only bound the RATE
// of abuse — a single forced pull is statistically identical to real luck,
// so no trigger can catch it without also occasionally rejecting genuine
// luck. This function is the real fix for the pack-rarity half of that:
// the roll happens HERE, server-side, using a trusted RNG the client never
// touches — the client can no longer influence the outcome at all,
// regardless of what it does to its own local JS.
//
// SECURITY MODEL: same shape as create-pix-order/admin-grant-currency —
// caller's JWT verified server-side, price/cost computed from a table
// ONLY this function owns (client sends nothing but which pack index it
// wants), and the actual currency-deduct + hero-insert happens via the
// SERVICE ROLE client, bypassing RLS entirely, so this write is exactly as
// trusted as the Pix webhook's own credit.
//
// MUST STAY IN SYNC BY HAND with game.js — there's no shared module
// between this Deno function and the browser bundle in this project (see
// create-pix-order's own comment for the same caveat about its price
// table). If ANY of RARITY_CONF/SHOP_RARITY_WEIGHTS/SKILL_ROLL_TABLE/
// HERO_CHARACTERS/PACKS ever changes in game.js, mirror it here too, or
// server-rolled packs will silently drift from what the client shows in
// the legend/odds UI.
//
// Deploy: supabase functions deploy open-pack
// (do NOT pass --no-verify-jwt — a real player session is required)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
}
// ---- Mirrored from game.js — keep in sync by hand (see header comment) ----
const PACKS = [
    { size: 1, cost: 20 },
    { size: 5, cost: 100 },
    { size: 10, cost: 200 },
    { size: 15, cost: 300 },
];
const RARITIES = ['CASEIRO', 'TEMPERADO', 'GOURMET', 'ESPECIALIDADE_DA_CASA', 'COMIDA_DE_BUTECO', 'RECEITA_DE_VO'];
const SHOP_RARITY_WEIGHTS = {
    CASEIRO: 0.8287, TEMPERADO: 0.1036, GOURMET: 0.0518,
    ESPECIALIDADE_DA_CASA: 0.0104, COMIDA_DE_BUTECO: 0.0052, RECEITA_DE_VO: 0.0004,
};
const RARITY_CONF = {
    CASEIRO: { power: [1, 3], speed: [1, 3], range: [1, 1], bombas: [1, 1], stamina: [1, 3] },
    TEMPERADO: { power: [3, 5], speed: [1, 5], range: [1, 2], bombas: [1, 2], stamina: [3, 5] },
    GOURMET: { power: [4, 9], speed: [5, 9], range: [1, 2], bombas: [1, 2], stamina: [5, 9] },
    ESPECIALIDADE_DA_CASA: { power: [6, 11], speed: [6, 11], range: [2, 3], bombas: [2, 3], stamina: [6, 11] },
    COMIDA_DE_BUTECO: { power: [9, 15], speed: [10, 15], range: [4, 4], bombas: [4, 5], stamina: [10, 15] },
    RECEITA_DE_VO: { power: [14, 20], speed: [14, 20], range: [5, 6], bombas: [5, 6], stamina: [14, 20] },
};
const HERO_EMOJI = ['💣', '🧨', '🎇', '💥', '🔥', '⚡', '🌋', '☄️', '🎆', '🧯'];
const HERO_CHARACTERS = [
    'capitao_hamburguer', 'samurai_pizza', 'ninja_batata_frita', 'bruxa_rosquinha',
    'arqueira_morango', 'paladino_abacate', 'mago_cogumelo', 'cowboy_taco',
    'viking_cebola', 'pirata_sushi', 'cavaleiro_cenoura', 'rei_cupcake',
];
const CHARACTER_NAMES = {
    capitao_hamburguer: 'Capitão Hambúrguer', samurai_pizza: 'Samurai Pizza',
    ninja_batata_frita: 'Ninja Batata Frita', bruxa_rosquinha: 'Bruxa Rosquinha',
    arqueira_morango: 'Arqueira Morango', paladino_abacate: 'Paladino Abacate',
    mago_cogumelo: 'Mago Cogumelo', cowboy_taco: 'Cowboy Taco',
    viking_cebola: 'Viking Cebola', pirata_sushi: 'Pirata Sushi',
    cavaleiro_cenoura: 'Cavaleiro Cenoura', rei_cupcake: 'Rei Cupcake',
};
const SKILL_CHANCE = 0.07;
const BASIC_SKILLS = ['MASSA_LEVE', 'CAFEINADO', 'SUSTANCIA', 'ESPETINHO', 'AL_DENTE'];
const POWER_SKILLS = ['FOLHADO_DE_OURO', 'TEMPERAMENTAL'];
const SKILL_FIELD = {
    MASSA_LEVE: 'massaLeve', CAFEINADO: 'cafeinado', SUSTANCIA: 'sustancia',
    ESPETINHO: 'espetinho', AL_DENTE: 'alDente',
    FOLHADO_DE_OURO: 'folhadoDeOuro', TEMPERAMENTAL: 'temperamental',
};
const SKILL_ROLL_TABLE = {
    CASEIRO: { basic1: 0.10, basic2: 0.02, power1: 0.00, power2: 0.00 },
    TEMPERADO: { basic1: 0.30, basic2: 0.07, power1: 0.00, power2: 0.00 },
    GOURMET: { basic1: 1.00, basic2: 0.20, power1: 0.00, power2: 0.00 },
    ESPECIALIDADE_DA_CASA: { basic1: 1.00, basic2: 0.35, power1: 0.20, power2: 0.05 },
    COMIDA_DE_BUTECO: { basic1: 1.00, basic2: 0.55, power1: 0.60, power2: 0.20 },
    RECEITA_DE_VO: { basic1: 1.00, basic2: 0.75, power1: 1.00, power2: 0.50 },
};
// ---- Ports of game.js's own rand()/randInt()/pick()/rollRarity()/
// rollSkillsForRarity()/makeHero() — same logic, same shapes ----
function rand(min, max) { return min + Math.random() * (max - min); }
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function rollRarity(odds) {
    let r = Math.random();
    for (const rarity of RARITIES) {
        r -= odds[rarity];
        if (r <= 0)
            return rarity;
    }
    return 'CASEIRO';
}
function rollSkillsForRarity(rarity) {
    const t = SKILL_ROLL_TABLE[rarity];
    const skills = { massaLeve: false, cafeinado: false, sustancia: false, espetinho: false, alDente: false, folhadoDeOuro: false, temperamental: false };
    if (!t)
        return skills;
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
// Mirrors makeHero() in game.js exactly, except nextId is passed in (this
// function is pure/stateless — the caller owns the id counter) and
// isSpicy is always false (shop packs never roll Picante — Jaula-only,
// same as the client's own buyPack() comment already establishes).
function makeHero(rarity, nextId) {
    const c = RARITY_CONF[rarity];
    const character = pick(HERO_CHARACTERS);
    const skills = rollSkillsForRarity(rarity);
    const stamina = randInt(c.stamina[0], c.stamina[1]);
    return {
        id: nextId,
        name: CHARACTER_NAMES[character] || character,
        emoji: pick(HERO_EMOJI),
        rarity,
        variant: randInt(0, 2),
        character,
        isSpicy: false,
        ghost: Math.random() < SKILL_CHANCE,
        swift: Math.random() < SKILL_CHANCE,
        massaLeve: skills.massaLeve,
        cafeinado: skills.cafeinado,
        sustancia: skills.sustancia,
        espetinho: skills.espetinho,
        alDente: skills.alDente,
        folhadoDeOuro: skills.folhadoDeOuro,
        temperamental: skills.temperamental,
        power: randInt(c.power[0], c.power[1]),
        range: randInt(c.range[0], c.range[1]),
        speed: randInt(c.speed[0], c.speed[1]),
        bombCapacity: randInt(c.bombas[0], c.bombas[1]),
        stamina,
        level: 1,
        energy: stamina * 50,
        mode: 'rest',
        bonusPower: 0,
        ascendCount: 0,
        autoWork: false,
    };
}
Deno.serve(async (req) => {
    if (req.method === 'OPTIONS')
        return new Response('ok', { headers: CORS_HEADERS });
    if (req.method !== 'POST')
        return json({ error: 'Method not allowed — use POST' }, 405);
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt)
        return json({ error: 'Missing Authorization header' }, 401);
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
        return json({ error: 'Server misconfigured (missing Supabase env vars)' }, 500);
    }
    const callerClient = createClient(supabaseUrl, anonKey);
    const { data: callerData, error: callerError } = await callerClient.auth.getUser(jwt);
    if (callerError || !callerData?.user)
        return json({ error: 'Invalid or expired session' }, 401);
    const userId = callerData.user.id;
    let body;
    try {
        body = await req.json();
    }
    catch {
        return json({ error: 'Invalid JSON body' }, 400);
    }
    const packIndex = Number(body.packIndex);
    const pack = PACKS[packIndex];
    if (!Number.isInteger(packIndex) || !pack) {
        return json({ error: 'packIndex must be 0-' + (PACKS.length - 1) }, 400);
    }
    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const { data: saveRow, error: saveError } = await adminClient
        .from('saves')
        .select('state')
        .eq('user_id', userId)
        .maybeSingle();
    if (saveError)
        return json({ error: 'Save lookup failed: ' + saveError.message }, 500);
    if (!saveRow)
        return json({ error: 'No save found — log in through the game at least once first' }, 404);
    const state = (saveRow.state && typeof saveRow.state === 'object') ? saveRow.state : {};
    const currentBcoin = Number(state.bcoin) || 0;
    if (currentBcoin < pack.cost) {
        return json({ error: `Not enough Chef Gems — need ${pack.cost}, have ${currentBcoin}` }, 402);
    }
    let nextHeroId = Number(state.nextHeroId) || 1;
    const pulled = [];
    for (let i = 0; i < pack.size; i++) {
        const rarity = rollRarity(SHOP_RARITY_WEIGHTS);
        pulled.push(makeHero(rarity, nextHeroId));
        nextHeroId++;
    }
    const existingHeroes = Array.isArray(state.heroes) ? state.heroes : [];
    const newState = {
        ...state,
        bcoin: currentBcoin - pack.cost,
        heroes: [...existingHeroes, ...pulled],
        nextHeroId,
    };
    const { error: updateError } = await adminClient
        .from('saves')
        .update({ state: newState })
        .eq('user_id', userId);
    if (updateError)
        return json({ error: 'Update failed: ' + updateError.message }, 500);
    return json({
        success: true,
        heroes: pulled,
        newBcoin: newState.bcoin,
    });
});
