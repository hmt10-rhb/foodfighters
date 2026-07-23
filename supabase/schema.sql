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
