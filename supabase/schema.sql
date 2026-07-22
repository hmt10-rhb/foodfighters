-- Food Fighters / Bombfodase — cloud save + shared ranking
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

-- ============ Public leaderboard (small subset, safe to expose) ============
create table if not exists public.leaderboard (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null,
  wave integer not null default 1,
  total_mined bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.leaderboard enable row level security;

create policy "leaderboard: anyone can read" on public.leaderboard
  for select using (true);
create policy "leaderboard: owner can insert" on public.leaderboard
  for insert with check (auth.uid() = user_id);
create policy "leaderboard: owner can update" on public.leaderboard
  for update using (auth.uid() = user_id);

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
