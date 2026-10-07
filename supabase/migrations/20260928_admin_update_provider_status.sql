CREATE OR REPLACE FUNCTION public.admin_update_provider_status(
  provider_user_id uuid,
  new_approval_status text,
  new_background_check_status text,
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

  if new_approval_status not in (
    'pending',
    'approved',
    'suspended',
    'rejected'
  ) then
    raise exception 'Invalid approval status';
  end if;

  if new_background_check_status not in (
    'pending',
    'approved',
    'rejected'
  ) then
    raise exception 'Invalid background check status';
  end if;

  if new_insurance_status not in (
    'pending',
    'approved',
    'rejected',
    'expired'
  ) then
    raise exception 'Invalid insurance status';
  end if;

  update public.provider_profiles
  set
    approval_status = new_approval_status,
    background_check_status = new_background_check_status,
    insurance_status = new_insurance_status,
    updated_at = now()
  where user_id = provider_user_id;

  if not found then
    raise exception 'Provider profile not found';
  end if;
end;
$function$;

REVOKE ALL ON FUNCTION public.admin_update_provider_status(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_provider_status(uuid,text,text,text) TO authenticated;
