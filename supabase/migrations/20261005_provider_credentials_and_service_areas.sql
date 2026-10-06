-- Provider credentials, service areas, and membership preparation.

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS service_zip_codes text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS membership_tier text NOT NULL DEFAULT 'silver';

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS business_registration_status text NOT NULL DEFAULT 'not_provided';

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS local_business_license_status text NOT NULL DEFAULT 'not_provided';

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS ase_certification_status text NOT NULL DEFAULT 'not_provided';

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS epa_609_certification_status text NOT NULL DEFAULT 'not_provided';

ALTER TABLE public.provider_profiles
ADD COLUMN IF NOT EXISTS insurance_verification_status text NOT NULL DEFAULT 'not_provided';

-- Preserve previously approved insurance as a verified credential.
UPDATE public.provider_profiles
SET insurance_verification_status = 'verified'
WHERE insurance_status = 'approved'
  AND insurance_verification_status = 'not_provided';

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_membership_tier_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_membership_tier_check
CHECK (membership_tier = ANY (ARRAY['silver'::text, 'gold'::text]));

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_business_registration_status_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_business_registration_status_check
CHECK (business_registration_status = ANY (ARRAY['not_provided'::text, 'provided'::text, 'not_applicable'::text, 'verified'::text]));

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_local_business_license_status_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_local_business_license_status_check
CHECK (local_business_license_status = ANY (ARRAY['not_provided'::text, 'provided'::text, 'not_applicable'::text, 'verified'::text]));

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_ase_certification_status_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_ase_certification_status_check
CHECK (ase_certification_status = ANY (ARRAY['not_provided'::text, 'provided'::text, 'verified'::text]));

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_epa_609_certification_status_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_epa_609_certification_status_check
CHECK (epa_609_certification_status = ANY (ARRAY['not_provided'::text, 'provided'::text, 'verified'::text]));

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_insurance_verification_status_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_insurance_verification_status_check
CHECK (insurance_verification_status = ANY (ARRAY['not_provided'::text, 'pending'::text, 'verified'::text, 'rejected'::text]));

ALTER TABLE public.provider_profiles
DROP CONSTRAINT IF EXISTS provider_service_zip_codes_check;

ALTER TABLE public.provider_profiles
ADD CONSTRAINT provider_service_zip_codes_check
CHECK (
  cardinality(service_zip_codes) = 0
  OR array_to_string(service_zip_codes, ',') ~ '^[0-9]{5}(,[0-9]{5})*$'
);

CREATE OR REPLACE FUNCTION public.get_my_provider_profile()
RETURNS TABLE(
  id uuid,
  provider_type text,
  business_name text,
  years_experience integer,
  certifications text,
  insurance_company text,
  insurance_policy_number text,
  insurance_expiration_date date,
  background_check_status text,
  insurance_status text,
  agreement_accepted boolean,
  agreement_accepted_at timestamp with time zone,
  agreement_version text,
  approval_status text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  service_zip_codes text[],
  membership_tier text,
  business_registration_status text,
  local_business_license_status text,
  ase_certification_status text,
  epa_609_certification_status text,
  insurance_verification_status text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select
    pp.id,
    pp.provider_type,
    pp.business_name,
    pp.years_experience,
    pp.certifications,
    pp.insurance_company,
    pp.insurance_policy_number,
    pp.insurance_expiration_date,
    pp.background_check_status,
    pp.insurance_status,
    pp.agreement_accepted,
    pp.agreement_accepted_at,
    pp.agreement_version,
    pp.approval_status,
    pp.created_at,
    pp.updated_at,
    pp.service_zip_codes,
    pp.membership_tier,
    pp.business_registration_status,
    pp.local_business_license_status,
    pp.ase_certification_status,
    pp.epa_609_certification_status,
    pp.insurance_verification_status
  from public.provider_profiles pp
  where pp.user_id = auth.uid()
  limit 1;
$function$;

DROP FUNCTION IF EXISTS public.create_provider_profile(text, integer, text, text, text, date, text);
DROP FUNCTION IF EXISTS public.update_provider_profile(text, integer, text, text, text, date);

CREATE OR REPLACE FUNCTION public.update_provider_profile(
  business_name_input text,
  years_experience_input integer,
  certifications_input text,
  insurance_company_input text,
  insurance_policy_number_input text,
  insurance_expiration_date_input date,
  service_zip_codes_input text[],
  business_registration_status_input text,
  local_business_license_status_input text,
  ase_certification_status_input text,
  epa_609_certification_status_input text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if years_experience_input is not null
     and years_experience_input < 0 then
    raise exception 'Years of experience cannot be negative';
  end if;

  if not exists (
    select 1
    from public.provider_profiles
    where user_id = auth.uid()
  ) then
    raise exception 'Provider profile not found';
  end if;

  if lower(coalesce(trim(business_registration_status_input), '')) = 'verified'
     or lower(coalesce(trim(local_business_license_status_input), '')) = 'verified'
     or lower(coalesce(trim(ase_certification_status_input), '')) = 'verified'
     or lower(coalesce(trim(epa_609_certification_status_input), '')) = 'verified' then
    raise exception 'Providers cannot self-verify credentials';
  end if;

  update public.provider_profiles
  set
    business_name = nullif(trim(business_name_input), ''),
    years_experience = years_experience_input,
    certifications = nullif(trim(certifications_input), ''),
    insurance_company = nullif(trim(insurance_company_input), ''),
    insurance_policy_number = nullif(trim(insurance_policy_number_input), ''),
    insurance_expiration_date = insurance_expiration_date_input,
    service_zip_codes = coalesce(service_zip_codes_input, '{}'),
    business_registration_status =
      coalesce(nullif(trim(business_registration_status_input), ''), 'not_provided'),
    local_business_license_status =
      coalesce(nullif(trim(local_business_license_status_input), ''), 'not_provided'),
    ase_certification_status =
      coalesce(nullif(trim(ase_certification_status_input), ''), 'not_provided'),
    epa_609_certification_status =
      coalesce(nullif(trim(epa_609_certification_status_input), ''), 'not_provided'),
    updated_at = now()
  where user_id = auth.uid();
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_provider_profile(
  business_name_input text,
  years_experience_input integer,
  certifications_input text,
  insurance_company_input text,
  insurance_policy_number_input text,
  insurance_expiration_date_input date,
  agreement_version_input text,
  service_zip_codes_input text[],
  business_registration_status_input text,
  local_business_license_status_input text,
  ase_certification_status_input text,
  epa_609_certification_status_input text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  user_role text;
  new_id uuid;
begin
  if years_experience_input is not null
     and years_experience_input < 0 then
    raise exception 'Years of experience cannot be negative';
  end if;

  if lower(coalesce(trim(business_registration_status_input), '')) = 'verified'
     or lower(coalesce(trim(local_business_license_status_input), '')) = 'verified'
     or lower(coalesce(trim(ase_certification_status_input), '')) = 'verified'
     or lower(coalesce(trim(epa_609_certification_status_input), '')) = 'verified' then
    raise exception 'Providers cannot self-verify credentials';
  end if;

  select role
  into user_role
  from public.profiles
  where id = auth.uid();

  if user_role not in ('mechanic', 'tire_technician') then
    raise exception 'Only providers can create a provider profile';
  end if;

  insert into public.provider_profiles (
    user_id,
    provider_type,
    business_name,
    years_experience,
    certifications,
    insurance_company,
    insurance_policy_number,
    insurance_expiration_date,
    service_zip_codes,
    business_registration_status,
    local_business_license_status,
    ase_certification_status,
    epa_609_certification_status,
    agreement_accepted,
    agreement_accepted_at,
    agreement_version
  )
  values (
    auth.uid(),
    user_role,
    nullif(trim(business_name_input), ''),
    years_experience_input,
    nullif(trim(certifications_input), ''),
    nullif(trim(insurance_company_input), ''),
    nullif(trim(insurance_policy_number_input), ''),
    insurance_expiration_date_input,
    coalesce(service_zip_codes_input, '{}'),
    coalesce(nullif(trim(business_registration_status_input), ''), 'not_provided'),
    coalesce(nullif(trim(local_business_license_status_input), ''), 'not_provided'),
    coalesce(nullif(trim(ase_certification_status_input), ''), 'not_provided'),
    coalesce(nullif(trim(epa_609_certification_status_input), ''), 'not_provided'),
    true,
    now(),
    agreement_version_input
  )
  returning id into new_id;

  return new_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_open_mechanic_jobs()
RETURNS TABLE(
  id uuid,
  service text,
  problem_description text,
  status text,
  service_city text,
  service_zip text,
  created_at timestamp with time zone,
  request_type text,
  scheduled_for timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select
    sr.id,
    sr.service,
    sr.problem_description,
    sr.status,
    sr.service_city,
    sr.service_zip,
    sr.created_at,
    sr.request_type,
    sr.scheduled_for
  from public.service_requests sr
  where sr.status = 'open'
    and sr.service <> 'tires'
    and exists (
      select 1
      from public.profiles p
      join public.provider_profiles pp
        on pp.user_id = p.id
      where p.id = auth.uid()
        and p.role = 'mechanic'
        and pp.provider_type = 'mechanic'
        and pp.approval_status = 'approved'
        and pp.background_check_status = 'approved'
        and pp.agreement_accepted = true
        and sr.service_zip = any(pp.service_zip_codes)
    )
  order by sr.created_at desc;
$function$;

CREATE OR REPLACE FUNCTION public.get_open_tire_jobs()
RETURNS TABLE(
  id uuid,
  service text,
  problem_description text,
  status text,
  service_city text,
  service_zip text,
  vehicle_type text,
  tire_issue text,
  tire_size text,
  created_at timestamp with time zone,
  request_type text,
  scheduled_for timestamp with time zone
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select
    sr.id,
    sr.service,
    sr.problem_description,
    sr.status,
    sr.service_city,
    sr.service_zip,
    sr.vehicle_type,
    sr.tire_issue,
    sr.tire_size,
    sr.created_at,
    sr.request_type,
    sr.scheduled_for
  from public.service_requests sr
  where sr.service = 'tires'
    and sr.status = 'open'
    and exists (
      select 1
      from public.profiles p
      join public.provider_profiles pp
        on pp.user_id = p.id
      where p.id = auth.uid()
        and p.role = 'tire_technician'
        and pp.provider_type = 'tire_technician'
        and pp.approval_status = 'approved'
        and pp.background_check_status = 'approved'
        and pp.agreement_accepted = true
        and sr.service_zip = any(pp.service_zip_codes)
    )
  order by sr.created_at desc;
$function$;

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
        and pp.agreement_accepted = true
        and service_requests.service_zip = any(pp.service_zip_codes)
    );

  if not found then
    raise exception 'Provider is not approved, outside the service area, or this job is no longer available';
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
        and pp.agreement_accepted = true
        and service_requests.service_zip = any(pp.service_zip_codes)
    );

  if not found then
    raise exception 'Provider is not approved, outside the service area, or this job is no longer available';
  end if;
end;
$function$;

-- Provider RPC permissions: authenticated users only.
REVOKE ALL ON FUNCTION public.get_my_provider_profile() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_provider_profile() TO authenticated;

REVOKE ALL ON FUNCTION public.update_provider_profile(text, integer, text, text, text, date, text[], text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_provider_profile(text, integer, text, text, text, date, text[], text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.create_provider_profile(text, integer, text, text, text, date, text, text[], text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_provider_profile(text, integer, text, text, text, date, text, text[], text, text, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_open_mechanic_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_open_mechanic_jobs() TO authenticated;

REVOKE ALL ON FUNCTION public.get_open_tire_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_open_tire_jobs() TO authenticated;

REVOKE ALL ON FUNCTION public.accept_mechanic_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_mechanic_job(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.accept_tire_job(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_tire_job(uuid) TO authenticated;
