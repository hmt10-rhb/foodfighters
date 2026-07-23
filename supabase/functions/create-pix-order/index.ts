// Food Fighters — create a PIX order for Estrela Michelin (2026-07-23)
//
// SECURITY MODEL: the price is ALWAYS computed server-side from
// MICHELIN_PRICE_TIERS below (the exact same table game.js's
// renderMichelinBuyModal() shows the player) — the client only ever sends a
// quantity, never a price. If this trusted a client-supplied amount, a
// tampered request could buy any quantity of Michelin for R$0.01.
//
// Auth: same pattern as admin-grant-currency — the caller's JWT is verified
// server-side via auth.getUser(), and the order is always created for THAT
// verified user_id, never a client-supplied one.
//
// Deploy: supabase functions deploy create-pix-order
// (do NOT pass --no-verify-jwt — this one DOES need a real player session)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// MUST stay in sync by hand with MICHELIN_PRICE_TIERS in game.js — there's
// no shared module between this Deno function and the browser bundle in
// this project, so a future price change needs to be edited in both places.
const MICHELIN_PRICE_TIERS = [
  { min: 1, max: 19, price: 0.63 },
  { min: 20, max: 39, price: 0.58 },
  { min: 40, max: 79, price: 0.53 },
  { min: 80, max: 139, price: 0.48 },
  { min: 140, max: 299, price: 0.43 },
  { min: 300, max: Infinity, price: 0.38 },
];
function priceFor(qty: number): number {
  const tier = MICHELIN_PRICE_TIERS.find(t => qty >= t.min && qty <= t.max) || MICHELIN_PRICE_TIERS[0];
  return Math.round(qty * tier.price * 100) / 100;
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
  const mpAccessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !mpAccessToken) {
    return json({ error: 'Server misconfigured (missing env vars — check MERCADOPAGO_ACCESS_TOKEN was set as a secret)' }, 500);
  }

  // ----- verify WHO is calling, exactly like admin-grant-currency does -----
  const callerClient = createClient(supabaseUrl, anonKey);
  const { data: callerData, error: callerError } = await callerClient.auth.getUser(jwt);
  if (callerError || !callerData?.user) return json({ error: 'Invalid or expired session' }, 401);
  const userId = callerData.user.id;
  // Mercado Pago's SANDBOX rejects any payer.email that doesn't end in
  // "@testuser.com" (invalid_email_for_sandbox) — a real player's real email
  // fails there but is exactly what production needs. Controlled by the
  // MERCADOPAGO_TEST_MODE secret rather than guessing from the access
  // token's format, since that format isn't reliable/documented to sniff.
  // Flip that secret to "false" (or remove it) once switching to
  // production credentials.
  const isTestMode = Deno.env.get('MERCADOPAGO_TEST_MODE') === 'true';
  const userEmail = isTestMode
    ? `test_${userId.replace(/-/g, '')}@testuser.com`
    : (callerData.user.email || 'jogador@foodfighters.example');

  let body: { quantity?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const quantity = Math.round(Number(body.quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99999) {
    return json({ error: 'quantity must be a positive integer' }, 400);
  }

  const amountBRL = priceFor(quantity);
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // 1. Create OUR OWN pending order row first — its id becomes Mercado
  // Pago's external_reference below, so the webhook can look it up later
  // without needing to parse or trust anything else about the notification.
  const { data: orderRow, error: insertError } = await adminClient
    .from('michelin_orders')
    .insert({ user_id: userId, quantity, amount_brl: amountBRL, status: 'pending' })
    .select('id')
    .single();
  if (insertError || !orderRow) {
    return json({ error: 'Failed to create order: ' + (insertError?.message || 'unknown') }, 500);
  }

  // 2. Ask Mercado Pago for the actual PIX charge (Checkout API via Orders —
  // see https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/payment-integration/pix).
  let mpRes: Response;
  try {
    mpRes = await fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mpAccessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': orderRow.id,
      },
      body: JSON.stringify({
        type: 'online',
        total_amount: amountBRL.toFixed(2),
        external_reference: orderRow.id,
        processing_mode: 'automatic',
        transactions: {
          payments: [{
            amount: amountBRL.toFixed(2),
            payment_method: { id: 'pix', type: 'bank_transfer' },
          }],
        },
        // "APRO" in first_name is Mercado Pago's documented sandbox trick to
        // auto-approve a test PIX order a few seconds after creation (no
        // real bank/QR scan needed) — ONLY meaningful with test credentials,
        // gated the same way as the test email above so it can never affect
        // a real production order. REMOVE (or flip MERCADOPAGO_TEST_MODE to
        // "false") before accepting real payments.
        payer: isTestMode ? { email: userEmail, first_name: 'APRO' } : { email: userEmail },
      }),
    });
  } catch (e) {
    await adminClient.from('michelin_orders').update({ status: 'failed' }).eq('id', orderRow.id);
    return json({ error: 'Could not reach Mercado Pago: ' + String(e) }, 502);
  }

  const mpData = await mpRes.json();
  if (!mpRes.ok) {
    console.error('Mercado Pago rejected the order:', JSON.stringify(mpData));
    await adminClient.from('michelin_orders').update({ status: 'failed' }).eq('id', orderRow.id);
    // TEMPORARY (2026-07-23, debugging the first live test): surfacing the
    // full raw response instead of a short summary, so the real cause shows
    // up in the browser's Network tab without needing to dig through
    // Supabase's own function logs. Fine to shorten back once the
    // integration is confirmed working end to end.
    return json({ error: 'Mercado Pago error: ' + JSON.stringify(mpData) }, 502);
  }

  const payment = mpData?.transactions?.payments?.[0];
  const qrCode = payment?.payment_method?.qr_code;
  const qrCodeBase64 = payment?.payment_method?.qr_code_base64;
  if (!qrCode || !qrCodeBase64) {
    await adminClient.from('michelin_orders').update({ status: 'failed' }).eq('id', orderRow.id);
    return json({ error: 'Mercado Pago response was missing PIX QR data — check MP dashboard/logs' }, 502);
  }

  await adminClient
    .from('michelin_orders')
    .update({ mp_order_id: mpData.id, status: 'awaiting_payment' })
    .eq('id', orderRow.id);

  return json({
    orderId: orderRow.id,
    quantity,
    amountBRL,
    qrCode,       // "copia e cola" text
    qrCodeBase64, // PNG image, base64 (no data: prefix — add it client-side)
  });
});
