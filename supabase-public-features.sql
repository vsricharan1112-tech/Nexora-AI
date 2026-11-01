-- Durable room and mentorship data for Nexora.
-- Run in the Nexora Supabase project. All application access uses the user's JWT;
-- the public anon key alone cannot read private rows or write user-owned data.

create table if not exists public.nexora_room_members (
  room_key text not null check (room_key ~ '^[a-z0-9-]{1,80}$'),
  client_id text not null check (client_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  joined_at timestamptz not null default now(),
  primary key (room_key, client_id)
);
create index if not exists nexora_room_members_user_room_idx
  on public.nexora_room_members (user_id, room_key);

create table if not exists public.nexora_room_presence (
  room_key text not null,
  client_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  last_seen timestamptz not null default now(),
  primary key (room_key, client_id),
  foreign key (room_key, client_id)
    references public.nexora_room_members(room_key, client_id) on delete cascade
);
create index if not exists nexora_room_presence_room_seen_idx
  on public.nexora_room_presence (room_key, last_seen desc);
create index if not exists nexora_room_presence_user_id_idx
  on public.nexora_room_presence (user_id);

create table if not exists public.nexora_room_messages (
  seq bigint generated always as identity primary key,
  room_key text not null check (room_key ~ '^[a-z0-9-]{1,80}$'),
  client_id text not null check (client_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 32),
  text text not null check (char_length(text) between 1 and 240),
  created_at timestamptz not null default now()
);
create index if not exists nexora_room_messages_room_seq_idx
  on public.nexora_room_messages (room_key, seq);
create index if not exists nexora_room_messages_room_created_idx
  on public.nexora_room_messages (room_key, created_at);
create index if not exists nexora_room_messages_user_id_idx
  on public.nexora_room_messages (user_id);

create table if not exists public.nexora_mentor_applications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 70),
  email text not null check (char_length(email) between 3 and 150),
  institution text not null check (char_length(institution) between 1 and 100),
  year text not null check (char_length(year) between 1 and 50),
  topics text not null check (char_length(topics) between 1 and 180),
  bio text not null check (char_length(bio) between 1 and 320),
  availability text not null check (char_length(availability) between 1 and 120),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);
create unique index if not exists nexora_one_pending_mentor_application_per_user
  on public.nexora_mentor_applications (user_id) where status = 'pending';
create index if not exists nexora_mentor_applications_user_created_idx
  on public.nexora_mentor_applications (user_id, created_at desc);
create index if not exists nexora_mentor_applications_status_created_idx
  on public.nexora_mentor_applications (status, created_at desc);

create table if not exists public.nexora_mentors (
  id uuid primary key default gen_random_uuid(),
  application_id uuid unique references public.nexora_mentor_applications(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 70),
  email text not null check (char_length(email) between 3 and 150),
  institution text not null check (char_length(institution) between 1 and 100),
  year text not null check (char_length(year) between 1 and 50),
  topics text not null check (char_length(topics) between 1 and 180),
  bio text not null check (char_length(bio) between 1 and 320),
  availability text not null check (char_length(availability) between 1 and 120),
  status text not null default 'approved' check (status in ('approved', 'hidden')),
  created_at timestamptz not null default now()
);
create index if not exists nexora_mentors_status_name_idx
  on public.nexora_mentors (status, name);

create table if not exists public.nexora_mentor_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  mentor_id uuid references public.nexora_mentors(id) on delete set null,
  mentor_name text not null check (char_length(mentor_name) between 1 and 70),
  name text not null check (char_length(name) between 1 and 70),
  email text not null check (char_length(email) between 3 and 150),
  message text not null check (char_length(message) between 10 and 600),
  status text not null default 'pending' check (status in ('pending', 'contacted', 'closed')),
  created_at timestamptz not null default now()
);
-- Preserve account deletion behavior if a mentor account is removed.
alter table public.nexora_mentors drop constraint if exists nexora_mentors_application_id_fkey;
alter table public.nexora_mentors add constraint nexora_mentors_application_id_fkey
  foreign key (application_id) references public.nexora_mentor_applications(id) on delete cascade;
alter table public.nexora_mentor_requests add column if not exists mentor_name text not null default '';
alter table public.nexora_mentor_requests alter column mentor_id drop not null;
alter table public.nexora_mentor_requests drop constraint if exists nexora_mentor_requests_mentor_id_fkey;
alter table public.nexora_mentor_requests add constraint nexora_mentor_requests_mentor_id_fkey
  foreign key (mentor_id) references public.nexora_mentors(id) on delete set null;
create index if not exists nexora_mentor_requests_user_created_idx
  on public.nexora_mentor_requests (user_id, created_at desc);
create index if not exists nexora_mentor_requests_mentor_id_idx
  on public.nexora_mentor_requests (mentor_id);
create index if not exists nexora_mentor_requests_status_created_idx
  on public.nexora_mentor_requests (status, created_at desc);

alter table public.nexora_room_members enable row level security;
alter table public.nexora_room_presence enable row level security;
alter table public.nexora_room_messages enable row level security;
alter table public.nexora_mentor_applications enable row level security;
alter table public.nexora_mentors enable row level security;
alter table public.nexora_mentor_requests enable row level security;

drop policy if exists "Nexora members manage own memberships" on public.nexora_room_members;
create policy "Nexora members manage own memberships"
  on public.nexora_room_members for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Room members read active room presence" on public.nexora_room_presence;
create policy "Room members read active room presence"
  on public.nexora_room_presence for select to authenticated
  using (exists (
    select 1 from public.nexora_room_members m
    where m.room_key = nexora_room_presence.room_key
      and m.user_id = (select auth.uid())
  ));
drop policy if exists "Users manage own room presence" on public.nexora_room_presence;
create policy "Users manage own room presence"
  on public.nexora_room_presence for all to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.nexora_room_members m
      where m.room_key = nexora_room_presence.room_key
        and m.client_id = nexora_room_presence.client_id
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "Room members read shared room messages" on public.nexora_room_messages;
create policy "Room members read shared room messages"
  on public.nexora_room_messages for select to authenticated
  using (exists (
    select 1 from public.nexora_room_members m
    where m.room_key = nexora_room_messages.room_key
      and m.user_id = (select auth.uid())
  ));
drop policy if exists "Joined users send their own room messages" on public.nexora_room_messages;
create policy "Joined users send their own room messages"
  on public.nexora_room_messages for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.nexora_room_members m
      where m.room_key = nexora_room_messages.room_key
        and m.client_id = nexora_room_messages.client_id
        and m.user_id = (select auth.uid())
        and m.display_name = nexora_room_messages.display_name
    )
  );
drop policy if exists "Room members remove expired messages" on public.nexora_room_messages;
create policy "Room members remove expired messages"
  on public.nexora_room_messages for delete to authenticated
  using (
    created_at < now() - interval '7 days'
    and exists (
      select 1 from public.nexora_room_members m
      where m.room_key = nexora_room_messages.room_key
        and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users read own mentor applications" on public.nexora_mentor_applications;
create policy "Users read own mentor applications"
  on public.nexora_mentor_applications for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Admins read mentor applications" on public.nexora_mentor_applications;
create policy "Admins read mentor applications"
  on public.nexora_mentor_applications for select to authenticated
  using ((select auth.jwt() -> 'app_metadata' ->> 'nexora_admin') = 'true');
drop policy if exists "Users submit own mentor applications" on public.nexora_mentor_applications;
create policy "Users submit own mentor applications"
  on public.nexora_mentor_applications for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'pending');
drop policy if exists "Admins review mentor applications" on public.nexora_mentor_applications;
create policy "Admins review mentor applications"
  on public.nexora_mentor_applications for update to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'nexora_admin') = 'true')
  with check ((select auth.jwt() -> 'app_metadata' ->> 'nexora_admin') = 'true');

drop policy if exists "Anyone reads approved Nexora mentors" on public.nexora_mentors;
create policy "Anyone reads approved Nexora mentors"
  on public.nexora_mentors for select to anon, authenticated
  using (status = 'approved');
drop policy if exists "Admins manage Nexora mentors" on public.nexora_mentors;
create policy "Admins manage Nexora mentors"
  on public.nexora_mentors for all to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'nexora_admin') = 'true')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'nexora_admin') = 'true');

drop policy if exists "Users read own mentor requests" on public.nexora_mentor_requests;
create policy "Users read own mentor requests"
  on public.nexora_mentor_requests for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Admins read mentor requests" on public.nexora_mentor_requests;
create policy "Admins read mentor requests"
  on public.nexora_mentor_requests for select to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'nexora_admin') = 'true');
drop policy if exists "Users create own mentor requests" on public.nexora_mentor_requests;
create policy "Users create own mentor requests"
  on public.nexora_mentor_requests for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.nexora_mentors m
      where m.id = nexora_mentor_requests.mentor_id and m.status = 'approved'
    )
  );
drop policy if exists "Admins update mentor requests" on public.nexora_mentor_requests;
create policy "Admins update mentor requests"
  on public.nexora_mentor_requests for update to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'nexora_admin') = 'true')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'nexora_admin') = 'true');

revoke all on public.nexora_room_members, public.nexora_room_presence,
  public.nexora_room_messages, public.nexora_mentor_applications,
  public.nexora_mentors, public.nexora_mentor_requests from anon, authenticated;
grant select, insert, update, delete on public.nexora_room_members to authenticated;
grant select, insert, update, delete on public.nexora_room_presence to authenticated;
grant select, insert, delete on public.nexora_room_messages to authenticated;
grant select, insert, update on public.nexora_mentor_applications to authenticated;
grant select on public.nexora_mentors to anon, authenticated;
grant insert, update, delete on public.nexora_mentors to authenticated;
grant select, insert, update on public.nexora_mentor_requests to authenticated;
do $$
declare sequence_name text;
begin
  sequence_name := pg_get_serial_sequence('public.nexora_room_messages', 'seq');
  if sequence_name is not null then
    execute format('grant usage, select on sequence %s to authenticated', sequence_name);
  end if;
end
$$;
