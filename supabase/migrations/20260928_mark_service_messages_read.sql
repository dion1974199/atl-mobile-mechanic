CREATE OR REPLACE FUNCTION public.mark_service_messages_read(request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  update public.service_messages sm
  set read_at = now()
  where sm.request_id = mark_service_messages_read.request_id
    and sm.sender_id <> auth.uid()
    and sm.read_at is null
    and exists (
      select 1
      from public.service_requests sr
      where sr.id = sm.request_id
        and (
          sr.customer_id = auth.uid()
          or sr.provider_id = auth.uid()
        )
    );
end;
$function$;

REVOKE ALL ON FUNCTION public.mark_service_messages_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_service_messages_read(uuid) TO authenticated;
