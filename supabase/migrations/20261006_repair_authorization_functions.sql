CREATE OR REPLACE FUNCTION public.create_repair_authorization(request_id uuid, work_description text, parts_cost numeric, labor_cost numeric)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  new_id uuid;
  approved_parent_id uuid;
  new_type text;
begin
  select ra.id
  into approved_parent_id
  from public.repair_authorizations ra
  where ra.request_id = create_repair_authorization.request_id
    and ra.status = 'approved'
  order by ra.responded_at desc nulls last, ra.created_at desc
  limit 1;

  if approved_parent_id is null then
    new_type := 'initial';
  else
    new_type := 'change_order';
  end if;

  insert into public.repair_authorizations (
    request_id,
    provider_id,
    customer_id,
    description,
    parts_amount,
    labor_amount,
    authorization_type,
    parent_authorization_id
  )
  select
    sr.id,
    auth.uid(),
    sr.customer_id,
    work_description,
    greatest(coalesce(parts_cost, 0), 0),
    greatest(coalesce(labor_cost, 0), 0),
    new_type,
    approved_parent_id
  from public.service_requests sr
  where sr.id = create_repair_authorization.request_id
    and sr.provider_id = auth.uid()
    and sr.status in ('accepted', 'on_the_way', 'in_progress')
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and (
          (sr.service = 'tires' and p.role = 'tire_technician')
          or
          (sr.service <> 'tires' and p.role = 'mechanic')
        )
    )
  returning id into new_id;

  if new_id is null then
    raise exception 'Unable to create repair authorization';
  end if;

  return new_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.respond_to_repair_authorization(authorization_id uuid, new_status text, response_note text DEFAULT NULL::text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if new_status not in ('approved', 'declined') then
    raise exception 'Invalid authorization response';
  end if;

  update public.repair_authorizations
  set
    status = new_status,
    customer_response_note = response_note,
    responded_at = now()
  where id = authorization_id
    and customer_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Unable to respond to repair authorization';
  end if;
end;
$function$;

REVOKE ALL ON FUNCTION public.create_repair_authorization(uuid, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_repair_authorization(uuid, text, numeric, numeric) TO authenticated;

REVOKE ALL ON FUNCTION public.respond_to_repair_authorization(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_repair_authorization(uuid, text, text) TO authenticated;
