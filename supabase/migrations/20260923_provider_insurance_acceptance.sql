CREATE OR REPLACE FUNCTION public.accept_mechanic_job(request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  update public.service_requests
  set
    provider_id = auth.uid(),
    status = 'accepted'
  where id = request_id
    and service <> 'tires'
    and status = 'open'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'mechanic'
    )
    and exists (
      select 1
      from public.provider_profiles pp
      where pp.user_id = auth.uid()
        and pp.provider_type = 'mechanic'
        and pp.approval_status = 'approved'
        and pp.background_check_status = 'approved'
        and pp.insurance_status = 'approved'
        and pp.agreement_accepted = true
        and pp.insurance_expiration_date is not null
        and pp.insurance_expiration_date >= current_date
    );

  if not found then
    raise exception 'Provider is not approved or this job is no longer available';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.accept_tire_job(request_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  update public.service_requests
  set
    provider_id = auth.uid(),
    status = 'accepted'
  where id = request_id
    and service = 'tires'
    and status = 'open'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'tire_technician'
    )
    and exists (
      select 1
      from public.provider_profiles pp
      where pp.user_id = auth.uid()
        and pp.provider_type = 'tire_technician'
        and pp.approval_status = 'approved'
        and pp.background_check_status = 'approved'
        and pp.insurance_status = 'approved'
        and pp.agreement_accepted = true
        and pp.insurance_expiration_date is not null
        and pp.insurance_expiration_date >= current_date
    );

  if not found then
    raise exception 'Provider is not approved or this job is no longer available';
  end if;
end;
$function$;
