// Food Fighters — admin currency grant (2026-07-23)
//
// SECURITY MODEL: this function IS the real authorization boundary, not the
// client-side "🛠️ Admin" button in game.js. The client button is only a
// convenience for whoever already has access — any player could inspect the
// page's JS and call this same endpoint directly, so the check below must
// (and does) happen entirely server-side, using the caller's Supabase-
// verified identity, never anything the client claims about itself.
//
// Auth flow:
//   1. Supabase's own Edge Functions gateway verifies the request's JWT
//      SIGNATURE before this code even runs (rejects anything forged/
//      expired outright) — this only confirms "some currently-valid
//      Supabase session made this call", not WHICH one.
//   2. This function then calls auth.getUser(jwt) itself (via an anon-key
//      client) to fetch that session's VERIFIED user record straight from
//      Supabase Auth, and compares its email against the hardcoded
//      ADMIN_EMAIL constant below. This is the actual "is this really
//      joaohermeto@hotmail.com" check — a server-verified value, never a
//      client-supplied header/body field.
//   3. Only if that check passes does it use the SERVICE ROLE client
//      (bypasses Row Level Security entirely) to look up and update the
//      target player's `saves` row. The service role key is never sent to
//      or read by the browser — Supabase injects it into this function's
//      own environment automatically (see the deploy notes at the bottom).
//
// Deploy: supabase functions deploy admin-grant-currency
// (do NOT pass --no-verify-jwt — JWT verification staying ON is what
// guarantees step 1 above actually happens before this code runs)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'joaohermeto@hotmail.com';

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

type GrantCurrency = 'starCore' | 'bcoin';

interface GrantRequestBody {
  targetUsername?: unknown;
  currency?: unknown;
  amount?: unknown;
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Browsers preflight sb.functions.invoke()'s POST-with-custom-headers call
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed — use POST' }, 405);
  }

  // ----- Step 1/2: verify WHO is actually calling, server-side -----
  const authHeader = req.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return json({ error: 'Missing Authorization header' }, 401);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    // These three are auto-provisioned by the Supabase platform for every
    // Edge Function (see deploy notes) — missing means a misconfigured
    // project, not a client error.
    return json({ error: 'Server misconfigured (missing Supabase env vars)' }, 500);
  }

  // Anon-key client used ONLY to resolve the caller's own verified identity
  // from their JWT — never used for the actual data read/write below.
  const callerClient = createClient(supabaseUrl, anonKey);
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(jwt);
  if (callerError || !callerData?.user) {
    return json({ error: 'Invalid or expired session' }, 401);
  }

  // ----- THE real authorization check — hardcoded, server-verified email ----
  if (callerData.user.email !== ADMIN_EMAIL) {
    return json({ error: 'Forbidden' }, 403);
  }

  // ----- Basic request validation -----
  let body: GrantRequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const targetUsername = typeof body.targetUsername === 'string' ? body.targetUsername.trim() : '';
  const currency = body.currency as GrantCurrency;
  const amount = Number(body.amount);

  if (!targetUsername) {
    return json({ error: 'targetUsername is required' }, 400);
  }
  if (currency !== 'starCore' && currency !== 'bcoin') {
    return json({ error: 'currency must be "starCore" (Food Coins) or "bcoin" (Chef Gems)' }, 400);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return json({ error: 'amount must be a positive number' }, 400);
  }

  // ----- Step 3: service-role client for the actual DB read/write -----
  // Bypasses Row Level Security entirely (by design — that's the whole
  // point of the service role key) so it can write to ANY player's `saves`
  // row, not just the caller's own. Never used above for the identity check.
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // `leaderboard.username` has no uniqueness constraint in schema.sql (it's
  // free-text, chosen at signup, never enforced unique) — a case-insensitive
  // match is used for a friendlier admin UX, but an ambiguous (>1 row)
  // match is refused rather than silently guessing which account to credit.
  const { data: matches, error: lookupError } = await adminClient
    .from('leaderboard')
    .select('user_id, username')
    .ilike('username', targetUsername);

  if (lookupError) {
    return json({ error: 'Lookup failed: ' + lookupError.message }, 500);
  }
  if (!matches || matches.length === 0) {
    return json({ error: `No player found with username "${targetUsername}"` }, 404);
  }
  if (matches.length > 1) {
    return json({
      error: `${matches.length} players share the username "${targetUsername}" — cannot disambiguate which account to credit`,
    }, 409);
  }

  const targetUserId = matches[0].user_id as string;
  const resolvedUsername = matches[0].username as string;

  const { data: saveRow, error: saveError } = await adminClient
    .from('saves')
    .select('state')
    .eq('user_id', targetUserId)
    .maybeSingle();

  if (saveError) {
    return json({ error: 'Save lookup failed: ' + saveError.message }, 500);
  }
  if (!saveRow) {
    return json({ error: `"${resolvedUsername}" has no save data yet (never synced to the cloud)` }, 404);
  }

  const currentState = (saveRow.state && typeof saveRow.state === 'object') ? saveRow.state as Record<string, unknown> : {};
  const currentAmount = Number(currentState[currency]) || 0;
  const newAmount = currentAmount + amount;
  const newState = { ...currentState, [currency]: newAmount };

  const { error: updateError } = await adminClient
    .from('saves')
    .update({ state: newState, updated_at: new Date().toISOString() })
    .eq('user_id', targetUserId);

  if (updateError) {
    return json({ error: 'Update failed: ' + updateError.message }, 500);
  }

  // NOTE (worth knowing, not fixed here — outside this function's scope):
  // if the target player is ONLINE right now, their own client keeps
  // pushing its in-memory (un-granted) state every ~30s regardless of what
  // changed server-side in the meantime (see game.js's pushCloudSave()
  // interval) — there's no live pull-side reconciliation while already
  // logged in. This grant durably sticks the next time their client does a
  // fresh pullCloudSave() (on their next login/reload, whose updated_at
  // comparison will correctly favor this newer write) — but a target who is
  // actively mid-session right now could have their own next periodic push
  // race with/overwrite it until then.
  return json({
    success: true,
    targetUsername: resolvedUsername,
    currency,
    granted: amount,
    newBalance: newAmount,
  });
});
