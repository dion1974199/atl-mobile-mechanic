CREATE OR REPLACE FUNCTION public.admin_update_provider_insurance_status(
  provider_user_id uuid,
  new_insurance_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if not exists (
    select 1
    from public.app_admins a
    where a.user_id = auth.uid()
  ) then
    raise exception 'Admin access required';
  end if;

  if new_insurance_status not in (
    'pending',
    'approved',
    'rejected',
    'expired'
  ) then
    raise exception 'Invalid insurance status';
  end if;

  if new_insurance_status = 'approved'
     and exists (
       select 1
       from public.provider_profiles pp
       where pp.user_id = provider_user_id
         and (
           pp.insurance_expiration_date is null
           or pp.insurance_expiration_date < current_date
         )
     ) then
    raise exception 'Cannot approve expired insurance';
  end if;

  update public.provider_profiles
  set
    insurance_status = new_insurance_status,
    updated_at = now()
  where user_id = provider_user_id;

  if not found then
    raise exception 'Provider profile not found';
  end if;
end;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_provider_insurance_status(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_provider_insurance_status(uuid,text) TO authenticated;
