create or replace function public.get_provider_request_customer(request_id uuid)
returns table(first_name text, last_name text)
language sql
security definer
set search_path = 'public'
as $function$
  select
    p.first_name,
    p.last_name
  from public.service_requests sr
  join public.profiles p
    on p.id = sr.customer_id
  where sr.id = request_id
    and sr.provider_id = auth.uid()
  limit 1;
$function$;
