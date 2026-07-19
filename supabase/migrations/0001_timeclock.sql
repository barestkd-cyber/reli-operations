-- RELI Ops — Time Clock
-- ---------------------------------------------------------------------------
-- Design notes:
--   * A web app cannot collect background GPS. It doesn't need to. Location is
--     stamped at clock-in and clock-out; the "forgot to clock out" case is
--     handled by auto-close rules + a review queue, not by tracking.
--   * Geofence distance is computed SERVER-SIDE (Edge Function) and stored.
--     Never trust a client-supplied "on site" flag.
--   * Out-of-range does NOT block the punch. Indoor GPS is unreliable
--     (50-100m+ inside a building) and a blocked cleaner is a phone call to
--     Mike. It records, flags, and lets a human decide.
-- Apply with:  supabase db push
-- ---------------------------------------------------------------------------

create extension if not exists pgcrypto;

-- ── Job sites ──────────────────────────────────────────────────────────────
create table if not exists public.job_sites (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  address     text        default '',
  lat         double precision not null,
  lng         double precision not null,
  radius_m    integer     not null default 200,   -- generous on purpose: indoor GPS drifts
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

-- ── Time entries ───────────────────────────────────────────────────────────
create table if not exists public.time_entries (
  id                 uuid primary key default gen_random_uuid(),
  staff_id           uuid not null references auth.users(id) on delete cascade,
  site_id            uuid references public.job_sites(id) on delete set null,

  clock_in_at        timestamptz not null default now(),
  clock_in_lat       double precision,
  clock_in_lng       double precision,
  clock_in_accuracy_m  double precision,   -- GPS accuracy the device reported
  clock_in_distance_m  double precision,   -- server-computed distance to site

  clock_out_at       timestamptz,
  clock_out_lat      double precision,
  clock_out_lng      double precision,
  clock_out_accuracy_m double precision,
  clock_out_distance_m double precision,

  -- 'open' | 'closed' | 'auto_closed' | 'needs_review'
  status             text not null default 'open',
  -- how the punch happened: 'mobile' | 'auto' | 'admin'
  clock_in_source    text not null default 'mobile',
  clock_out_source   text,

  flags              text[] not null default '{}',
  notes              text default '',

  -- audit trail for any manual correction
  original_clock_out_at timestamptz,
  edited_by          uuid references auth.users(id),
  edited_at          timestamptz,

  created_at         timestamptz not null default now()
);

create index if not exists time_entries_staff_idx  on public.time_entries (staff_id, clock_in_at desc);
create index if not exists time_entries_open_idx   on public.time_entries (status) where status = 'open';
create index if not exists time_entries_review_idx on public.time_entries (status)
  where status in ('auto_closed','needs_review');

-- One open shift per person. This is what makes double clock-in impossible.
create unique index if not exists time_entries_one_open_per_staff
  on public.time_entries (staff_id) where status = 'open';

-- ── Settings (tunable without a redeploy) ──────────────────────────────────
create table if not exists public.timeclock_settings (
  id                 boolean primary key default true check (id),
  max_shift_hours    numeric not null default 10,   -- auto-close beyond this
  grace_minutes      integer not null default 60,   -- past scheduled end
  geofence_default_m integer not null default 200
);
insert into public.timeclock_settings (id) values (true) on conflict do nothing;

-- ── Who is an admin? (reuses the existing profiles.role) ───────────────────
create or replace function public.is_ops_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.role in ('admin','owner') from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

-- ── RLS ────────────────────────────────────────────────────────────────────
alter table public.job_sites          enable row level security;
alter table public.time_entries       enable row level security;
alter table public.timeclock_settings enable row level security;

-- Everyone signed in can see the sites they might work at.
drop policy if exists job_sites_read on public.job_sites;
create policy job_sites_read on public.job_sites
  for select to authenticated using (true);

drop policy if exists job_sites_admin on public.job_sites;
create policy job_sites_admin on public.job_sites
  for all to authenticated using (public.is_ops_admin()) with check (public.is_ops_admin());

-- A cleaner sees only their own entries; admins see everything.
drop policy if exists time_entries_read on public.time_entries;
create policy time_entries_read on public.time_entries
  for select to authenticated
  using (staff_id = auth.uid() or public.is_ops_admin());

-- Cleaners never write directly — the Edge Function does, so the geofence
-- check can't be bypassed. Only admins get a direct write path (corrections).
drop policy if exists time_entries_admin_write on public.time_entries;
create policy time_entries_admin_write on public.time_entries
  for all to authenticated
  using (public.is_ops_admin()) with check (public.is_ops_admin());

drop policy if exists settings_read on public.timeclock_settings;
create policy settings_read on public.timeclock_settings
  for select to authenticated using (true);
drop policy if exists settings_admin on public.timeclock_settings;
create policy settings_admin on public.timeclock_settings
  for all to authenticated using (public.is_ops_admin()) with check (public.is_ops_admin());

-- ── The "forgot to clock out" handler ──────────────────────────────────────
-- Two rules, both conservative — they never silently inflate hours:
--   1. Shift ran past max_shift_hours  -> close it AT clock_in + max hours.
--   2. Person clocked in somewhere new -> close the old shift at that moment.
-- Everything it touches is flagged and lands in the review queue.
create or replace function public.close_stale_shifts()
returns integer language plpgsql security definer set search_path = public as $$
declare
  max_h numeric;
  n     integer := 0;
begin
  select max_shift_hours into max_h from public.timeclock_settings where id;

  -- Rule 2 first: a newer clock-in proves they left the earlier site.
  with newer as (
    select e.id,
           (select min(e2.clock_in_at)
              from public.time_entries e2
             where e2.staff_id = e.staff_id
               and e2.clock_in_at > e.clock_in_at) as next_in
      from public.time_entries e
     where e.status = 'open'
  )
  update public.time_entries t
     set clock_out_at     = n.next_in,
         status           = 'auto_closed',
         clock_out_source = 'auto',
         flags            = array_append(t.flags, 'auto_closed_next_shift')
    from newer n
   where t.id = n.id and n.next_in is not null;
  get diagnostics n = row_count;

  -- Rule 1: ran too long to be real.
  update public.time_entries
     set clock_out_at     = clock_in_at + (max_h || ' hours')::interval,
         status           = 'auto_closed',
         clock_out_source = 'auto',
         flags            = array_append(flags, 'auto_closed_max_hours')
   where status = 'open'
     and now() > clock_in_at + (max_h || ' hours')::interval;

  return n;
end;
$$;

-- Schedule it every 15 minutes (requires pg_cron on the project).
-- select cron.schedule('close-stale-shifts', '*/15 * * * *',
--                      $$select public.close_stale_shifts()$$);

-- ── Review queue: what Mike actually looks at before payroll ───────────────
create or replace view public.timeclock_review as
select e.*,
       s.name as site_name,
       round(extract(epoch from (coalesce(e.clock_out_at, now()) - e.clock_in_at))/3600.0, 2) as hours
  from public.time_entries e
  left join public.job_sites s on s.id = e.site_id
 where e.status in ('auto_closed','needs_review')
    or e.flags <> '{}'
 order by e.clock_in_at desc;
