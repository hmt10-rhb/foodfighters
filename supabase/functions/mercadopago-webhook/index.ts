// Food Fighters — Mercado Pago webhook: confirms PIX payment, credits
// Estrela Michelin (2026-07-23)
//
// SECURITY: the webhook body/query params are NEVER trusted for the actual
// payment status — they're only used as a "something happened, go check"
// trigger. This function always re-fetches the order from Mercado Pago's
// own API (authenticated with our Access Token) before crediting anything,
// so a forged/fake webhook call can't grant free currency on its own.
//
// IDEMPOTENT: crediting only ever happens on the update() that successfully
// flips status 'awaiting_payment' -> 'approved' (a WHERE-status-matches
// update, checked via the returned row). Mercado Pago is documented to
// retry notifications, and a real player could also trigger more than one
// delivery for the same order — a duplicate delivery finds zero matching
// rows (already 'approved') and cleanly no-ops instead of double-crediting.
//
// Configure this function's URL as the notification/webhook URL in the
// Mercado Pago developer panel for this application (Aplicação >
// Webhooks) — see https://www.mercadopago.com.br/developers/pt/docs/checkout-api-orders/notifications.
//
// Deploy: supabase functions deploy mercadopago-webhook --no-verify-jwt
// (--no-verify-jwt IS REQUIRED here — Mercado Pago calls this directly with
// no Supabase session/JWT at all; payment authenticity is verified by
// calling Mercado Pago's OWN API back, not by trusting a caller identity.)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const mpAccessToken = Deno.env.get('MERCADOPAGO_ACCESS_TOKEN');
  if (!supabaseUrl || !serviceRoleKey || !mpAccessToken) {
    // Still 200 — Mercado Pago would just retry a misconfigured server
    // forever otherwise. Server misconfiguration needs to be caught by
    // watching the function's own logs, not by starving MP's retry budget.
    return json({ received: true, error: 'Server misconfigured' });
  }

  // Notifications can arrive as a JSON body (most common for Orders/topic
  // "order") or as bare query params depending on notification type/source —
  // read both, body wins if present.
  let notifBody: { type?: string; action?: string; data?: { id?: string } } = {};
  try { notifBody = await req.json(); } catch { /* not all deliveries have a JSON body */ }
  const url = new URL(req.url);
  const orderId = notifBody?.data?.id || url.searchParams.get('data.id') || url.searchParams.get('id');
  const topic = notifBody?.type || url.searchParams.get('type') || url.searchParams.get('topic');

  // Acknowledge anything we don't recognize with a plain 200 — Mercado Pago
  // sends notifications for other topics/tests too, none of which are an
  // error on our side, just nothing to act on.
  if (!orderId || (topic && topic !== 'order' && topic !== 'payment')) {
    return json({ received: true, ignored: true });
  }

  // Re-fetch the AUTHORITATIVE status straight from Mercado Pago.
  let mpRes: Response;
  try {
    mpRes = await fetch(`https://api.mercadopago.com/v1/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${mpAccessToken}` },
    });
  } catch (e) {
    return json({ received: true, error: 'Could not reach Mercado Pago: ' + String(e) });
  }
  if (!mpRes.ok) return json({ received: true, error: 'Mercado Pago lookup failed: ' + mpRes.status });
  const mpOrder = await mpRes.json();

  const ourOrderId = mpOrder.external_reference;
  const paymentStatus = mpOrder?.transactions?.payments?.[0]?.status;
  // "processed" is the Orders API's terminal success state for a payment —
  // anything else (action_required/waiting_transfer/rejected/...) means not
  // paid (yet), nothing to credit.
  if (!ourOrderId || paymentStatus !== 'processed') {
    return json({ received: true, status: paymentStatus || 'unknown' });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: updatedOrder, error: updateError } = await adminClient
    .from('michelin_orders')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', ourOrderId)
    .eq('status', 'awaiting_payment') // the atomic idempotency guard — see file header
    .select('user_id, quantity')
    .maybeSingle();

  if (updateError) return json({ received: true, error: updateError.message });
  if (!updatedOrder) return json({ received: true, alreadyProcessed: true });

  // Credit the currency — same read-modify-write pattern admin-grant-currency uses.
  const { data: saveRow, error: saveError } = await adminClient
    .from('saves')
    .select('state')
    .eq('user_id', updatedOrder.user_id)
    .maybeSingle();

  if (saveError || !saveRow) {
    // Payment confirmed but we couldn't find a save row to credit — flag
    // for manual follow-up rather than silently losing a real payment.
    await adminClient.from('michelin_orders').update({ status: 'approved_uncredited' }).eq('id', ourOrderId);
    return json({ received: true, error: 'Payment confirmed but no save row found to credit' });
  }

  const currentState = (saveRow.state && typeof saveRow.state === 'object') ? saveRow.state as Record<string, unknown> : {};
  const currentMichelin = Number(currentState.michelinCoin) || 0;
  const newState = { ...currentState, michelinCoin: currentMichelin + updatedOrder.quantity };

  const { error: creditError } = await adminClient
    .from('saves')
    .update({ state: newState, updated_at: new Date().toISOString() })
    .eq('user_id', updatedOrder.user_id);

  if (creditError) {
    await adminClient.from('michelin_orders').update({ status: 'approved_uncredited' }).eq('id', ourOrderId);
    return json({ received: true, error: 'Failed to credit: ' + creditError.message });
  }

  // NOTE (same caveat admin-grant-currency's own comment already flags): if
  // the player is online right now, their client's periodic pushCloudSave()
  // could race this write until their next fresh login/reload. Acceptable
  // here too — the credit is durably in the DB either way.
  return json({ received: true, credited: updatedOrder.quantity, userId: updatedOrder.user_id });
});
