create or replace function public.get_uploading_share(
    p_intent_id uuid,
    p_view_token_hash text,
    p_manage_token_hash text
)
returns table (share_id uuid, storage_path text, expected_compressed_bytes bigint)
language sql
stable
security definer
set search_path = ''
as $$
    select s.id, s.storage_path, pi.expected_compressed_bytes
    from private.publish_intents as pi
    join private.shares as s on s.id = pi.share_id
    where pi.id = p_intent_id
      and pi.completed_at is null
      and pi.expires_at > now()
      and s.status = 'uploading'
      and s.view_token_hash = p_view_token_hash
      and s.manage_token_hash = p_manage_token_hash
      and s.deleted_at is null
    limit 1;
$$;

revoke all on function public.get_uploading_share(uuid, text, text)
    from public, anon, authenticated;
grant execute on function public.get_uploading_share(uuid, text, text)
    to service_role;
