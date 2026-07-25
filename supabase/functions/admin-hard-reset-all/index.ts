// Food Fighters — admin reset ALL non-admin accounts' PROGRESS (2026-07-24)
//
// Resets every registered player's save back to a fresh start (empty
// roster, 0 Food Coins, 300 Chef Gems, ranking zeroed) WITHOUT touching
// their login (same email/password/account) and WITHOUT touching Estrela
// Michelin (real-money-backed, bought via Pix — explicitly must survive
// any reset, admin-triggered or not, per the admin's own explicit
// decision when this was built: "nao deve resetar as estrelas michelin").
//
// This REPLACED an earlier version of this same function that deleted the
// account entirely (auth.admin.deleteUser) — the admin wanted a way to
// reset progress for everyone at once without forcing anyone to
// re-register, mirroring what reset-btn already does for a single player
// who resets their own account (see game.js), just applied to every
// non-admin account from here instead of one at a time.
//
// MUST STAY IN SYNC BY HAND with defaultState() in game.js — same caveat
// as open-pack/create-pix-order. If new fields are added to defaultState(),
// mirror them here too, or a reset account will come back missing state
// that Object.assign(defaultState(), raw) on the CLIENT would normally
// backfill on load (harmless — client-side defaults still cover it — but
// better to keep this complete anyway for clarity).
//
// SECURITY MODEL: same as admin-grant-currency/admin-hard-reset-all's
// original version — caller's JWT verified server-side, email compared
// against the hardcoded ADMIN_EMAIL constant. Client requires typing a
// confirmation phrase before this is even reachable; the same phrase is
// re-checked here server-side too.
//
// Deploy: supabase functions deploy admin-hard-reset-all
// (do NOT pass --no-verify-jwt)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'joaohermeto@hotmail.com';
const CONFIRM_PHRASE = 'APAGAR TUDO';
const ACTIVE_THEME = 'jardim_fresquinho';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Mirrors defaultState() in game.js — see this file's header comment.
// michelinCoin is passed in (preserved from whatever the account already
// had) rather than hardcoded to 0, unlike every other field here.
function freshState(preservedMichelinCoin: number) {
  return {
    bcoin: 300,
    michelinCoin: preservedMichelinCoin,
    starCore: 0,
    lastKnownCloudCurrency: { starCore: 0, bcoin: 300, michelinCoin: preservedMichelinCoin, hardResetCount: 0, wheelLastClaim: 0, wheelPaidSpinUsed: false },
    totalMined: 0,
    mapEarned: 0,
    fusions: 0,
    heroes: [],
    houses: { tent: 0, cabin: 0, villa: 0, fortress: 0 },
    tasksClaimed: [],
    totalChestsBroken: 0,
    dailyChestsBroken: 0,
    dailyResetAt: Date.now(),
    dailyClaimed: false,
    tasksBaselineSet: false,
    tasksBaseline: null,
    wave: 1,
    activeThemeId: ACTIVE_THEME,
    refCode: 'FF-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    nextHeroId: 1,
    lastSeen: Date.now(),
    sleepMode: false,
    upgrades: { mining: 0, blast: 0, haste: 0 },
    skillShards: 0,
    breeds: 0,
    ascensions: 0,
    vip: { expiresAt: 0, autoWorkPct: 100, lastRerollAt: 0 },
    picanteBoost: { expiresAt: 0 },
    wheelLastClaim: 0,
    wheelPaidSpinUsed: false,
    hardResetCount: 0,
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed — use POST' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: 'Server misconfigured (missing Supabase env vars)' }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey);
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(jwt);
  if (callerError || !callerData?.user) return json({ error: 'Invalid or expired session' }, 401);
  if (callerData.user.email !== ADMIN_EMAIL) return json({ error: 'Forbidden' }, 403);

  let body: { confirm?: unknown };
  try { body = await req.json(); } catch { body = {}; }
  if (body.confirm !== CONFIRM_PHRASE) {
    return json({ error: `Confirmation phrase missing or incorrect — expected exactly "${CONFIRM_PHRASE}"` }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Paginated — loop until a short page signals there's nothing left,
  // resetting every non-admin account's saves+leaderboard rows found along
  // the way. Stops and reports partial progress on the first failure
  // rather than silently skipping it.
  let resetCount = 0;
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data: usersPage, error: listError } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (listError) {
      return json({ error: 'Failed to list users: ' + listError.message, resetSoFar: resetCount }, 500);
    }
    const users = usersPage.users;
    if (!users || users.length === 0) break;
    for (const u of users) {
      if (u.email === ADMIN_EMAIL) continue;

      const { data: saveRow, error: saveError } = await adminClient
        .from('saves')
        .select('state')
        .eq('user_id', u.id)
        .maybeSingle();
      if (saveError) {
        return json({ error: `Failed reading save for ${u.email}: ${saveError.message}`, resetSoFar: resetCount }, 500);
      }
      // no save row yet (never played) — nothing to reset for this account
      if (!saveRow) continue;

      const currentState = (saveRow.state && typeof saveRow.state === 'object') ? saveRow.state as Record<string, unknown> : {};
      const preservedMichelinCoin = Number(currentState.michelinCoin) || 0;

      const { error: saveUpdateError } = await adminClient
        .from('saves')
        .update({ state: freshState(preservedMichelinCoin) })
        .eq('user_id', u.id);
      if (saveUpdateError) {
        return json({ error: `Failed resetting save for ${u.email}: ${saveUpdateError.message}`, resetSoFar: resetCount }, 500);
      }

      // Zero the ranking too (keeps the username, just resets the stats) —
      // deliberately NOT deleted, matching "reset progress, not the account".
      const { error: leaderboardError } = await adminClient
        .from('leaderboard')
        .update({ wave: 1, total_mined: 0 })
        .eq('user_id', u.id);
      if (leaderboardError) {
        return json({ error: `Failed resetting leaderboard for ${u.email}: ${leaderboardError.message}`, resetSoFar: resetCount }, 500);
      }

      resetCount++;
    }
    if (users.length < perPage) break;
    page++;
  }

  return json({ success: true, resetCount });
});
