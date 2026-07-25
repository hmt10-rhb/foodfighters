// Food Fighters — admin hard reset ALL non-admin accounts (2026-07-24)
//
// EXTREMELY DESTRUCTIVE, IRREVERSIBLE: deletes every registered Supabase
// Auth account except ADMIN_EMAIL. Thanks to `on delete cascade` on
// saves/leaderboard/michelin_orders (see schema.sql), deleting the
// auth.users row alone wipes everything tied to that account too — no
// separate table cleanup needed, matching exactly what the admin has been
// doing by hand via the SQL Editor (`delete from auth.users where email <>
// 'joaohermeto@hotmail.com'`) every time a full wipe was needed before this.
//
// SECURITY MODEL: same shape as admin-grant-currency — caller's JWT
// verified server-side, email compared against the hardcoded ADMIN_EMAIL
// constant (never trusting anything the client claims). The client ALSO
// requires typing a confirmation phrase before this is even reachable, and
// that same phrase is checked again here server-side — belt and suspenders
// for an action this wide-reaching (every player, not just one account).
//
// Deploy: supabase functions deploy admin-hard-reset-all
// (do NOT pass --no-verify-jwt — JWT verification staying ON is required)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL = 'joaohermeto@hotmail.com';
const CONFIRM_PHRASE = 'APAGAR TUDO';

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

  // listUsers() is paginated (default 50/page) — loop until a short page
  // signals there's nothing left, deleting every non-admin account found
  // along the way. Stops and reports partial progress on the first
  // failure rather than silently skipping it.
  let deletedCount = 0;
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data: usersPage, error: listError } = await adminClient.auth.admin.listUsers({ page, perPage });
    if (listError) {
      return json({ error: 'Failed to list users: ' + listError.message, deletedSoFar: deletedCount }, 500);
    }
    const users = usersPage.users;
    if (!users || users.length === 0) break;
    for (const u of users) {
      if (u.email === ADMIN_EMAIL) continue;
      const { error: delError } = await adminClient.auth.admin.deleteUser(u.id);
      if (delError) {
        return json({ error: `Failed deleting ${u.email}: ${delError.message}`, deletedSoFar: deletedCount }, 500);
      }
      deletedCount++;
    }
    if (users.length < perPage) break;
    page++;
  }

  return json({ success: true, deletedCount });
});
