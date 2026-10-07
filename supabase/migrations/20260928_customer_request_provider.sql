CREATE OR REPLACE FUNCTION public.get_customer_request_provider(request_id uuid)
RETURNS TABLE(first_name text, last_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select
    p.first_name,
    p.last_name
  from public.service_requests sr
  join public.profiles p
    on p.id = sr.provider_id
  where sr.id = request_id
    and sr.customer_id = auth.uid()
    and sr.provider_id is not null
  limit 1;
$function$;

REVOKE ALL ON FUNCTION public.get_customer_request_provider(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_request_provider(uuid) TO authenticated;
