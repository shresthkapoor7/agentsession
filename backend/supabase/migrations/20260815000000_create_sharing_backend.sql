create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create table private.shares (
    id uuid primary key default gen_random_uuid(),
    view_token_hash text not null unique check (view_token_hash ~ '^[0-9a-f]{64}$'),
    manage_token_hash text not null unique check (manage_token_hash ~ '^[0-9a-f]{64}$'),
    display_name text not null check (char_length(display_name) between 1 and 80),
    provider text not null check (provider in ('codex', 'claude')),
    visibility text not null check (visibility in ('public', 'password')),
    password_hash text,
    storage_path text not null unique check (storage_path ~ '^shares/[0-9a-f]{2}/[0-9a-f-]{36}\.bin$'),
    status text not null default 'uploading'
        check (status in ('uploading', 'ready', 'revoked', 'expired')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    deleted_at timestamptz,
    schema_version smallint not null check (schema_version > 0),
    processed_tokens bigint not null default 0 check (processed_tokens >= 0),
    cached_tokens bigint not null default 0 check (cached_tokens >= 0),
    generated_tokens bigint not null default 0 check (generated_tokens >= 0),
    reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
    tasks_count integer not null default 0 check (tasks_count >= 0),
    tools_count integer not null default 0 check (tools_count >= 0),
    patches_count integer not null default 0 check (patches_count >= 0),
    model_summary jsonb not null default '[]'::jsonb check (jsonb_typeof(model_summary) = 'array'),
    compressed_bytes bigint check (compressed_bytes between 1 and 26214400),
    constraint password_matches_visibility check (
        (visibility = 'public' and password_hash is null)
        or (visibility = 'password' and password_hash is not null)
    ),
    constraint expiry_is_fixed check (expires_at = created_at + interval '21 days')
);

create index shares_cleanup_idx on private.shares (expires_at, status);

create table private.publish_intents (
    id uuid primary key default gen_random_uuid(),
    share_id uuid not null unique references private.shares (id) on delete cascade,
    expected_compressed_bytes bigint not null check (
        expected_compressed_bytes between 1 and 26214400
    ),
    request_ip_hash text not null check (request_ip_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null default (now() + interval '10 minutes'),
    completed_at timestamptz,
    check (expires_at > created_at),
    check (completed_at is null or completed_at >= created_at)
);

create index publish_intents_cleanup_idx
    on private.publish_intents (expires_at)
    where completed_at is null;

create table private.rate_limit_buckets (
    scope text not null,
    subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
    window_start timestamptz not null,
    value bigint not null check (value > 0),
    primary key (scope, subject_hash, window_start)
);

create index rate_limit_buckets_cleanup_idx on private.rate_limit_buckets (window_start);

alter table private.shares enable row level security;
alter table private.publish_intents enable row level security;
alter table private.rate_limit_buckets enable row level security;

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'session-transcripts',
    'session-transcripts',
    false,
    26214400,
    array['application/octet-stream']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.consume_rate_limit(
    p_scope text,
    p_subject_hash text,
    p_limit bigint,
    p_window_seconds integer,
    p_cost bigint default 1
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_window_start timestamptz;
    v_rows integer;
begin
    if p_scope = ''
        or p_subject_hash !~ '^[0-9a-f]{64}$'
        or p_limit < 1
        or p_window_seconds < 1
        or p_cost < 1
        or p_cost > p_limit then
        return false;
    end if;

    v_window_start := to_timestamp(
        floor(extract(epoch from clock_timestamp()) / p_window_seconds) * p_window_seconds
    );

    insert into private.rate_limit_buckets (scope, subject_hash, window_start, value)
    values (p_scope, p_subject_hash, v_window_start, p_cost)
    on conflict (scope, subject_hash, window_start) do update
    set value = private.rate_limit_buckets.value + excluded.value
    where private.rate_limit_buckets.value + excluded.value <= p_limit;

    get diagnostics v_rows = row_count;
    return v_rows = 1;
end;
$$;

create or replace function public.create_publish_intent(
    p_view_token_hash text,
    p_manage_token_hash text,
    p_display_name text,
    p_provider text,
    p_visibility text,
    p_password_hash text,
    p_storage_path text,
    p_schema_version smallint,
    p_expected_compressed_bytes bigint,
    p_request_ip_hash text,
    p_metrics jsonb default '{}'::jsonb
)
returns table (intent_id uuid, share_id uuid, intent_expires_at timestamptz, share_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_share_id uuid;
    v_intent_id uuid;
    v_intent_expires_at timestamptz;
    v_share_expires_at timestamptz;
begin
    v_share_expires_at := now() + interval '21 days';
    v_intent_expires_at := now() + interval '10 minutes';

    insert into private.shares (
        view_token_hash,
        manage_token_hash,
        display_name,
        provider,
        visibility,
        password_hash,
        storage_path,
        expires_at,
        schema_version,
        processed_tokens,
        cached_tokens,
        generated_tokens,
        reasoning_tokens,
        tasks_count,
        tools_count,
        patches_count,
        model_summary
    )
    values (
        p_view_token_hash,
        p_manage_token_hash,
        p_display_name,
        p_provider,
        p_visibility,
        p_password_hash,
        p_storage_path,
        v_share_expires_at,
        p_schema_version,
        coalesce((p_metrics ->> 'processed_tokens')::bigint, 0),
        coalesce((p_metrics ->> 'cached_tokens')::bigint, 0),
        coalesce((p_metrics ->> 'generated_tokens')::bigint, 0),
        coalesce((p_metrics ->> 'reasoning_tokens')::bigint, 0),
        coalesce((p_metrics ->> 'tasks')::integer, 0),
        coalesce((p_metrics ->> 'tools')::integer, 0),
        coalesce((p_metrics ->> 'patches')::integer, 0),
        coalesce(p_metrics -> 'models', '[]'::jsonb)
    )
    returning id into v_share_id;

    insert into private.publish_intents (
        share_id,
        expected_compressed_bytes,
        request_ip_hash,
        expires_at
    )
    values (
        v_share_id,
        p_expected_compressed_bytes,
        p_request_ip_hash,
        v_intent_expires_at
    )
    returning id into v_intent_id;

    return query select v_intent_id, v_share_id, v_intent_expires_at, v_share_expires_at;
end;
$$;

create or replace function public.complete_publish_intent(
    p_intent_id uuid,
    p_view_token_hash text,
    p_manage_token_hash text,
    p_actual_compressed_bytes bigint
)
returns table (share_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
    return query
    with completed_intent as (
        update private.publish_intents as pi
        set completed_at = now()
        from private.shares as s
        where pi.id = p_intent_id
          and pi.share_id = s.id
          and pi.completed_at is null
          and pi.expires_at > now()
          and pi.expected_compressed_bytes = p_actual_compressed_bytes
          and s.status = 'uploading'
          and s.view_token_hash = p_view_token_hash
          and s.manage_token_hash = p_manage_token_hash
        returning pi.share_id
    ), ready_share as (
        update private.shares as s
        set status = 'ready', compressed_bytes = p_actual_compressed_bytes
        from completed_intent as ci
        where s.id = ci.share_id
        returning s.id, s.expires_at
    )
    select ready_share.id, ready_share.expires_at from ready_share;
end;
$$;

create or replace function public.get_share_by_view_hash(p_view_token_hash text)
returns table (
    share_id uuid,
    display_name text,
    provider text,
    visibility text,
    password_hash text,
    storage_path text,
    expires_at timestamptz,
    schema_version smallint,
    processed_tokens bigint,
    cached_tokens bigint,
    generated_tokens bigint,
    reasoning_tokens bigint,
    tasks_count integer,
    tools_count integer,
    patches_count integer,
    model_summary jsonb,
    compressed_bytes bigint
)
language sql
stable
security definer
set search_path = ''
as $$
    select
        s.id,
        s.display_name,
        s.provider,
        s.visibility,
        s.password_hash,
        s.storage_path,
        s.expires_at,
        s.schema_version,
        s.processed_tokens,
        s.cached_tokens,
        s.generated_tokens,
        s.reasoning_tokens,
        s.tasks_count,
        s.tools_count,
        s.patches_count,
        s.model_summary,
        s.compressed_bytes
    from private.shares as s
    where s.view_token_hash = p_view_token_hash
      and s.status = 'ready'
      and s.expires_at > now()
      and s.deleted_at is null
    limit 1;
$$;

create or replace function public.claim_share_revocation(p_manage_token_hash text)
returns table (share_id uuid, storage_path text)
language sql
security definer
set search_path = ''
as $$
    update private.shares as s
    set status = 'revoked', deleted_at = now()
    where s.manage_token_hash = p_manage_token_hash
      and s.status in ('uploading', 'ready')
      and s.deleted_at is null
    returning s.id, s.storage_path;
$$;

create or replace function public.claim_expired_shares(p_limit integer default 100)
returns table (share_id uuid, storage_path text)
language sql
security definer
set search_path = ''
as $$
    with candidates as (
        select s.id
        from private.shares as s
        left join private.publish_intents as pi on pi.share_id = s.id
        where s.status in ('uploading', 'ready')
          and (
              s.expires_at <= now()
              or (s.status = 'uploading' and pi.expires_at <= now())
          )
        order by least(s.expires_at, coalesce(pi.expires_at, s.expires_at))
        for update of s skip locked
        limit least(greatest(p_limit, 1), 500)
    )
    update private.shares as s
    set status = 'expired', deleted_at = now()
    from candidates as c
    where s.id = c.id
    returning s.id, s.storage_path;
$$;

create or replace function public.list_pending_deletions(p_limit integer default 100)
returns table (share_id uuid, storage_path text)
language sql
stable
security definer
set search_path = ''
as $$
    select s.id, s.storage_path
    from private.shares as s
    where s.status in ('revoked', 'expired')
      and s.deleted_at is not null
    order by s.deleted_at
    limit least(greatest(p_limit, 1), 500);
$$;

create or replace function public.delete_share_metadata(p_share_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_rows integer;
begin
    delete from private.shares
    where id = p_share_id
      and status in ('revoked', 'expired')
      and deleted_at is not null;
    get diagnostics v_rows = row_count;
    return v_rows = 1;
end;
$$;

create or replace function public.purge_old_rate_limits()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_rows bigint;
begin
    delete from private.rate_limit_buckets
    where window_start < now() - interval '2 days';
    get diagnostics v_rows = row_count;
    return v_rows;
end;
$$;

revoke all on function public.consume_rate_limit(text, text, bigint, integer, bigint)
    from public, anon, authenticated;
revoke all on function public.create_publish_intent(
    text, text, text, text, text, text, text, smallint, bigint, text, jsonb
) from public, anon, authenticated;
revoke all on function public.complete_publish_intent(uuid, text, text, bigint)
    from public, anon, authenticated;
revoke all on function public.get_share_by_view_hash(text)
    from public, anon, authenticated;
revoke all on function public.claim_share_revocation(text)
    from public, anon, authenticated;
revoke all on function public.claim_expired_shares(integer)
    from public, anon, authenticated;
revoke all on function public.list_pending_deletions(integer)
    from public, anon, authenticated;
revoke all on function public.delete_share_metadata(uuid)
    from public, anon, authenticated;
revoke all on function public.purge_old_rate_limits()
    from public, anon, authenticated;

grant execute on function public.consume_rate_limit(text, text, bigint, integer, bigint)
    to service_role;
grant execute on function public.create_publish_intent(
    text, text, text, text, text, text, text, smallint, bigint, text, jsonb
) to service_role;
grant execute on function public.complete_publish_intent(uuid, text, text, bigint)
    to service_role;
grant execute on function public.get_share_by_view_hash(text)
    to service_role;
grant execute on function public.claim_share_revocation(text)
    to service_role;
grant execute on function public.claim_expired_shares(integer)
    to service_role;
grant execute on function public.list_pending_deletions(integer)
    to service_role;
grant execute on function public.delete_share_metadata(uuid)
    to service_role;
grant execute on function public.purge_old_rate_limits()
    to service_role;
