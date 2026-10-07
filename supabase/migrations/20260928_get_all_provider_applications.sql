CREATE OR REPLACE FUNCTION public.get_all_provider_applications()
RETURNS TABLE(
  user_id uuid,
  provider_type text,
  business_name text,
  years_experience integer,
  certifications text,
  insurance_company text,
  insurance_expiration_date date,
  background_check_status text,
  insurance_status text,
  approval_status text,
  created_at timestamp with time zone
)
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

  return query
  select
    pp.user_id,
    pp.provider_type,
    pp.business_name,
    pp.years_experience,
    pp.certifications,
    pp.insurance_company,
    pp.insurance_expiration_date,
    pp.background_check_status,
    pp.insurance_status,
    pp.approval_status,
    pp.created_at
  from public.provider_profiles pp
  order by pp.created_at desc;
end;
$function$;

REVOKE ALL ON FUNCTION public.get_all_provider_applications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_all_provider_applications() TO authenticated;
