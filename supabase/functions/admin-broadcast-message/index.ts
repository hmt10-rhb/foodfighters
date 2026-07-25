// Food Fighters — admin broadcast message to all players (2026-07-25)
//
// Inserts a new row into public.admin_broadcast — every connected player's
// client picks it up via a Realtime subscription (with a periodic poll as
// a fallback) and shows it as a full-screen overlay, same visual treatment
// as the force-reload notice but dismissible with an "OK, entendi" button
// (see showBroadcastOverlay()/dismissBroadcastOverlay() in game.js).
//
// SECURITY MODEL: same shape as admin-grant-currency — caller's JWT
// verified server-side, email compared against the hardcoded ADMIN_EMAIL
// constant. The admin_broadcast table's RLS lets anyone READ (it's just an
// announcement) but has no insert policy for regular users at all — this
// Edge Function's service-role client is the only way a row ever gets
// written.
//
// Deploy: supabase functions deploy admin-broadcast-message
// (do NOT pass --no-verify-jwt)

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

  let body: { message?: unknown };
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return json({ error: 'message is required' }, 400);
  if (message.length > 2000) return json({ error: 'message too long (max 2000 characters)' }, 400);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await adminClient
    .from('admin_broadcast')
    .insert({ message })
    .select('id, created_at')
    .single();
  if (error) return json({ error: 'Failed to send: ' + error.message }, 500);

  return json({ success: true, id: data.id, createdAt: data.created_at });
});
