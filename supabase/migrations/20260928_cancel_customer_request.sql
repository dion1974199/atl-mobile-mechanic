CREATE OR REPLACE FUNCTION public.cancel_customer_request(request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  update public.service_requests
  set status = 'cancelled'
  where id = request_id
    and customer_id = auth.uid()
    and status = 'open'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'customer'
    );

  if not found then
    raise exception 'Unable to cancel request';
  end if;
end;
$function$;

REVOKE ALL ON FUNCTION public.cancel_customer_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_customer_request(uuid) TO authenticated;
