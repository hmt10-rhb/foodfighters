-- Food Fighters — cloud save + shared ranking
-- Run this once in the Supabase dashboard: Project > SQL Editor > New query > paste > Run.

-- ============ Cloud saves (private, full game state) ============
create table if not exists public.saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.saves enable row level security;

create policy "saves: owner can read" on public.saves
  for select using (auth.uid() = user_id);
create policy "saves: owner can insert" on public.saves
  for insert with check (auth.uid() = user_id);
create policy "saves: owner can update" on public.saves
  for update using (auth.uid() = user_id);
create policy "saves: owner can delete" on public.saves
  for delete using (auth.uid() = user_id);

-- ============ Public leaderboard (small subset, safe to expose) ============
create table if not exists public.leaderboard (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  wave integer not null default 1,
  -- NOTE: must be numeric, not bigint/integer. The economy is entirely
  -- fractional (chest rewards 0.01-3.00), and game.js writes
  -- total_mined rounded to 2 decimals — a bigint column silently rejects
  -- that ("invalid input syntax for type bigint") on every write that
  -- isn't a whole number, which is nearly always. See migration below for
  -- fixing an existing table created before this was caught (2026-07-23).
  total_mined numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- MIGRATION (2026-07-23): the table above already existed in production
-- with total_mined as bigint (created before the economy went fractional).
-- `create table if not exists` above is a no-op against that existing
-- table, so the column type never actually got fixed just by re-running
-- this file — this ALTER is what does it. Safe/idempotent to re-run: a
-- numeric->numeric cast is a no-op.
alter table public.leaderboard alter column total_mined type numeric using total_mined::numeric;

alter table public.leaderboard enable row level security;

create policy "leaderboard: anyone can read" on public.leaderboard
  for select using (true);
create policy "leaderboard: owner can insert" on public.leaderboard
  for insert with check (auth.uid() = user_id);
create policy "leaderboard: owner can update" on public.leaderboard
  for update using (auth.uid() = user_id);
create policy "leaderboard: owner can delete" on public.leaderboard
  for delete using (auth.uid() = user_id);

-- Realtime: a table is NOT broadcast over postgres_changes just because RLS
-- allows reading it — it must also be added to the supabase_realtime
-- publication. Without this, every client's Realtime subscription in
-- game.js silently receives nothing, forever, with no error anywhere: the
-- ranking view just freezes at whatever it showed on login. This is
-- idempotent-safe to re-run (skips if already a member).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leaderboard'
  ) then
    alter publication supabase_realtime add table public.leaderboard;
  end if;
end $$;

-- ============ Estrela Michelin PIX orders (2026-07-23) ============
-- Tracks every purchase attempt end to end: created by create-pix-order
-- (status starts 'pending', then 'awaiting_payment' once Mercado Pago
-- confirms the charge was created), flipped to 'approved' by
-- mercadopago-webhook ONLY after re-verifying the payment directly against
-- Mercado Pago's own API (never trusting the webhook body alone) — see that
-- function's own comments. Regular players can read their own rows (so the
-- frontend can watch a specific order via Realtime while a QR code is
-- showing) but can never write here directly; only the two Edge Functions
-- (service role) do, which is what actually prevents a player from just
-- INSERTing their own fake "approved" row as a free-currency exploit.
create table if not exists public.michelin_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  quantity integer not null check (quantity > 0),
  amount_brl numeric not null check (amount_brl > 0),
  mp_order_id text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.michelin_orders enable row level security;

create policy "michelin_orders: owner can read" on public.michelin_orders
  for select using (auth.uid() = user_id);
-- Deliberately NO insert/update/delete policy for regular users — see the
-- table comment above.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'michelin_orders'
  ) then
    alter publication supabase_realtime add table public.michelin_orders;
  end if;
end $$;

-- ============ Anti-cheat guard ============
-- Basic sanity check, not a full server-authoritative simulation: scores can
-- only move forward, and a single sync can't leap an implausible number of
-- waves at once. This stops "edit the number in devtools" cheating; it does
-- NOT replace real server-side validation if this ever becomes competitive.
create or replace function public.leaderboard_guard()
returns trigger as $$
begin
  if TG_OP = 'UPDATE' then
    if new.total_mined < old.total_mined then
      new.total_mined := old.total_mined;
    end if;
    if new.wave < old.wave then
      new.wave := old.wave;
    end if;
    if new.wave - old.wave > 200 then
      new.wave := old.wave + 200;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists leaderboard_guard_trigger on public.leaderboard;
create trigger leaderboard_guard_trigger
  before insert or update on public.leaderboard
  for each row execute function public.leaderboard_guard();

-- ============ Anti-cheat guard: saves.state.michelinCoin (2026-07-24) ============
-- Estrela Michelin is the real-money-backed currency (bought via Pix, see
-- create-pix-order/mercadopago-webhook) — but it lives inside
-- public.saves.state, a jsonb blob the OWNER is otherwise fully free to
-- update (see "saves: owner can update"/"saves: owner can insert" above),
-- which meant nothing ever stopped a player from editing
-- state.michelinCoin in their own browser's devtools and pushing
-- themselves free currency. This mirrors leaderboard_guard's
-- clamp-only-in-one-direction pattern instead of rejecting the write
-- outright — so a player's OTHER legitimate progress in the same push
-- (heroes, wave, Food/Chef Coins, etc.) still saves normally, only
-- michelinCoin itself gets corrected back:
--   * UPDATE from a normal user session: any INCREASE is clamped back to
--     the previous value. Decreases (spending Michelin via the exchange)
--     are still allowed freely.
--   * INSERT from a normal user session: forced to 0 regardless of what's
--     submitted — RLS lets a player insert their OWN first `saves` row
--     ("saves: owner can insert") without checking state's contents at
--     all, so a first-ever save could otherwise arrive pre-loaded with any
--     michelinCoin value.
--   * Both checks are skipped entirely for the SERVICE ROLE connection
--     admin-grant-currency and mercadopago-webhook use (auth.role() =
--     'service_role') — those are the only two paths that should ever be
--     able to legitimately increase this value.
--
-- ============ Extended 2026-07-24 (urgent, real exploit confirmed) ============
-- A player ran `state.starCore = state.starCore + 67; save(); await
-- pushCloudSave();` from devtools and it worked — starCore/bcoin (Food
-- Coin/Chef Gem) had ZERO server-side protection at all, unlike
-- michelinCoin above. A full fix would mean moving the entire mining
-- simulation server-side (a much bigger project); this is a rate-of-gain
-- CEILING instead — the combined value of starCore + bcoin (Food-Coin-
-- equivalent units, bcoin*10 per EXCHANGE_RATE so a legitimate CONVERSION
-- between the two — net zero change in combined wealth — never gets
-- mistaken for a cheat) can only grow so fast per REAL elapsed second,
-- using a ceiling far above any plausible legitimate earn rate (see the
-- reference simulations in FF - Monetização e VIP.md: even a strong squad
-- earns a small fraction of a coin per second on average). Exceeding it
-- resets BOTH currencies back to their previous values entirely (blunt on
-- purpose — a partial/proportional clamp would leave room for gaming
-- whichever field the formula favors).
--
-- CRITICAL: elapsed time is measured against `old.updated_at`, which MUST
-- be a value this trigger itself controls, never the client's own
-- self-reported timestamp — pushCloudSave() in game.js sends its own
-- `updated_at` in the upsert payload today, and trusting that would let a
-- single malicious write with a fake far-future timestamp permanently
-- poison every FUTURE elapsed-time check for that account, defeating the
-- cap forever after. Fixed the same way leaderboard_guard already does it
-- below: `new.updated_at := now()` unconditionally, ignoring whatever the
-- client sent.
-- ============ Extended 2026-07-24 #2 (urgent, a SECOND real exploit
-- confirmed within minutes of the first): a player monkey-patched
-- SHOP_RARITY_WEIGHTS/buyPack() in devtools to force a guaranteed Receita
-- de Vó (top rarity) pull, then restored the real odds and pushed the
-- result. IMPORTANT LIMITATION, stated plainly: a single forced pull and a
-- single genuinely lucky pull produce an IDENTICAL saved state — there is
-- no threshold that can reject one without also occasionally rejecting the
-- other. This check can only bound the RATE of top-rarity hero gains (so
-- repeating the exploit can't fill a whole roster in one sitting) — it
-- cannot, and is not claimed to, catch a single isolated instance. The
-- real fix is moving the pack roll itself server-side (planned separately,
-- a new Edge Function mirroring create-pix-order's pattern) so the client
-- never controls the odds at all; this trigger is the stopgap until that
-- ships.
create or replace function public.saves_guard()
returns trigger as $$
declare
  old_michelin numeric;
  new_michelin numeric;
  old_wealth numeric;
  new_wealth numeric;
  elapsed_s numeric;
  max_gain numeric;
  old_top_count int;
  new_top_count int;
  hours_elapsed numeric;
  max_new_top int;
begin
  if auth.role() != 'service_role' then
    new_michelin := coalesce((new.state->>'michelinCoin')::numeric, 0);
    if TG_OP = 'INSERT' then
      if new_michelin != 0 then
        new.state := jsonb_set(new.state, '{michelinCoin}', '0');
      end if;
      -- fresh account: starCore/bcoin forced to the real defaultState()
      -- starting values (0 / 200), same reasoning as michelinCoin above —
      -- RLS lets a player insert their own first row with any state
      -- contents at all.
      new.state := jsonb_set(jsonb_set(new.state, '{starCore}', '0'), '{bcoin}', '200');
      -- a brand-new account should never start pre-loaded with rare heroes
      if jsonb_array_length(coalesce(new.state->'heroes', '[]'::jsonb)) > 0 then
        new.state := jsonb_set(new.state, '{heroes}', '[]'::jsonb);
      end if;
    elsif TG_OP = 'UPDATE' then
      old_michelin := coalesce((old.state->>'michelinCoin')::numeric, 0);
      if new_michelin > old_michelin then
        new.state := jsonb_set(new.state, '{michelinCoin}', to_jsonb(old_michelin));
      end if;

      old_wealth := coalesce((old.state->>'starCore')::numeric, 0) + coalesce((old.state->>'bcoin')::numeric, 0) * 10;
      new_wealth := coalesce((new.state->>'starCore')::numeric, 0) + coalesce((new.state->>'bcoin')::numeric, 0) * 10;
      if new_wealth > old_wealth then
        elapsed_s := greatest(extract(epoch from (now() - old.updated_at)), 0);
        max_gain := elapsed_s * 10; -- generous ceiling: 10 Food-Coin-equivalent units per real second
        if (new_wealth - old_wealth) > max_gain then
          new.state := jsonb_set(new.state, '{starCore}', to_jsonb(coalesce((old.state->>'starCore')::numeric, 0)));
          new.state := jsonb_set(new.state, '{bcoin}', to_jsonb(coalesce((old.state->>'bcoin')::numeric, 0)));
        end if;
      end if;

      old_top_count := (select count(*) from jsonb_array_elements(coalesce(old.state->'heroes', '[]'::jsonb)) h
                         where h->>'rarity' in ('COMIDA_DE_BUTECO', 'RECEITA_DE_VO'));
      new_top_count := (select count(*) from jsonb_array_elements(coalesce(new.state->'heroes', '[]'::jsonb)) h
                         where h->>'rarity' in ('COMIDA_DE_BUTECO', 'RECEITA_DE_VO'));
      if new_top_count > old_top_count then
        hours_elapsed := greatest(extract(epoch from (now() - old.updated_at)), 0) / 3600;
        -- 1 "grace" gain allowed immediately (indistinguishable from real
        -- luck — see this section's header comment), +1 more per 6 real
        -- hours elapsed. Reverts the WHOLE heroes array on purpose (same
        -- blunt-not-partial philosophy as the currency clamp above) —
        -- exceeding this in one push is already well outside anything
        -- explainable by normal play.
        max_new_top := 1 + floor(hours_elapsed / 6);
        if (new_top_count - old_top_count) > max_new_top then
          new.state := jsonb_set(new.state, '{heroes}', old.state->'heroes');
        end if;
      end if;
    end if;
  end if;
  -- Always server-controlled — see the CRITICAL note above. Applies
  -- regardless of role (service-role writes get a trustworthy timestamp
  -- out of this too, no downside).
  new.updated_at := now();
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists saves_guard_trigger on public.saves;
create trigger saves_guard_trigger
  before insert or update on public.saves
  for each row execute function public.saves_guard();
