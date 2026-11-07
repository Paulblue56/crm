-- CRM cloud workspace, one private JSON workspace per authenticated user.
create table if not exists public.crm_workspaces (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{"companies":[],"payroll":[],"invoices":[],"activities":[]}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.crm_workspaces enable row level security;
revoke all on public.crm_workspaces from anon;
grant select, insert, update, delete on public.crm_workspaces to authenticated;

drop policy if exists "Users can view their own CRM workspace" on public.crm_workspaces;
create policy "Users can view their own CRM workspace"
  on public.crm_workspaces for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can create their own CRM workspace" on public.crm_workspaces;
create policy "Users can create their own CRM workspace"
  on public.crm_workspaces for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update their own CRM workspace" on public.crm_workspaces;
create policy "Users can update their own CRM workspace"
  on public.crm_workspaces for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "Users can delete their own CRM workspace" on public.crm_workspaces;
create policy "Users can delete their own CRM workspace"
  on public.crm_workspaces for delete to authenticated using ((select auth.uid()) = user_id);
