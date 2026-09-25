alter table public.service_requests
add column if not exists request_type text not null default 'asap',
add column if not exists scheduled_for timestamp with time zone;

drop function if exists public.get_open_mechanic_jobs();

create function public.get_open_mechanic_jobs()
returns table(
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
language sql
security definer
set search_path to 'public'
as $function$
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
        and pp.insurance_status = 'approved'
        and pp.agreement_accepted = true
        and pp.insurance_expiration_date is not null
        and pp.insurance_expiration_date >= current_date
    )
  order by sr.created_at desc;
$function$;
drop function if exists public.get_open_tire_jobs();

create function public.get_open_tire_jobs()
returns table(
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
language sql
security definer
set search_path to 'public'
as $function$
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
        and pp.insurance_status = 'approved'
        and pp.agreement_accepted = true
        and pp.insurance_expiration_date is not null
        and pp.insurance_expiration_date >= current_date
    )
  order by sr.created_at desc;
$function$;
