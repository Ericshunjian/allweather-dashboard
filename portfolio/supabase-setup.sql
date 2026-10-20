-- Run this file once in the Supabase SQL Editor.
-- The browser uploads only the AES-GCM encrypted vault bundle.

create table if not exists public.portfolio_vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vault jsonb not null,
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.portfolio_vaults enable row level security;

revoke all on table public.portfolio_vaults from anon;
grant select, insert, update on table public.portfolio_vaults to authenticated;

drop policy if exists "portfolio vault owner can read" on public.portfolio_vaults;
create policy "portfolio vault owner can read"
on public.portfolio_vaults
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "portfolio vault owner can insert" on public.portfolio_vaults;
create policy "portfolio vault owner can insert"
on public.portfolio_vaults
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "portfolio vault owner can update" on public.portfolio_vaults;
create policy "portfolio vault owner can update"
on public.portfolio_vaults
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create or replace function public.set_portfolio_vault_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_portfolio_vault_updated_at on public.portfolio_vaults;
create trigger set_portfolio_vault_updated_at
before update on public.portfolio_vaults
for each row execute function public.set_portfolio_vault_updated_at();
