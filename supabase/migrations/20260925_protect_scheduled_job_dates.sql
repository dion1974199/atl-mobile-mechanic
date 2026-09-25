create or replace function public.update_tire_job_status(
  request_id uuid,
  new_status text
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  current_status text;
  current_request_type text;
  current_scheduled_for timestamptz;
begin
  select status, request_type, scheduled_for
  into current_status, current_request_type, current_scheduled_for
  from public.service_requests
  where id = request_id
    and provider_id = auth.uid()
    and service = 'tires'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'tire_technician'
    );

  if current_status is null then
    raise exception 'Tire job not found or not assigned to you';
  end if;

  if current_request_type = 'scheduled'
     and current_scheduled_for is not null
     and new_status in ('on_the_way', 'in_progress', 'completed')
     and current_date < current_scheduled_for::date then
    raise exception 'This scheduled job cannot begin before the scheduled service date';
  end if;

  if new_status = 'in_progress' then
    if not exists (
      select 1
      from public.repair_authorizations ra
      where ra.request_id = update_tire_job_status.request_id
        and ra.authorization_type = 'initial'
        and ra.status = 'approved'
    ) then
      raise exception 'Customer must approve the repair authorization before work can begin';
    end if;
  end if;

  if new_status = 'completed' then
    if exists (
      select 1
      from public.repair_authorizations ra
      where ra.request_id = update_tire_job_status.request_id
        and ra.status = 'pending'
    ) then
      raise exception 'Customer must respond to the pending authorization before the job can be completed';
    end if;
  end if;

  if not (
    (current_status = 'accepted' and new_status = 'on_the_way')
    or
    (current_status = 'on_the_way' and new_status = 'in_progress')
    or
    (current_status = 'in_progress' and new_status = 'completed')
  ) then
    raise exception 'Invalid tire job status change';
  end if;

  update public.service_requests
  set status = new_status
  where id = request_id
    and provider_id = auth.uid()
    and service = 'tires';
end;
$function$;


create or replace function public.update_mechanic_job_status(
  request_id uuid,
  new_status text
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  current_status text;
  current_request_type text;
  current_scheduled_for timestamptz;
begin
  select status, request_type, scheduled_for
  into current_status, current_request_type, current_scheduled_for
  from public.service_requests
  where id = request_id
    and provider_id = auth.uid()
    and service <> 'tires'
    and exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
        and p.role = 'mechanic'
    );

  if current_status is null then
    raise exception 'Job not found or not assigned to you';
  end if;

  if current_request_type = 'scheduled'
     and current_scheduled_for is not null
     and new_status in ('on_the_way', 'in_progress', 'completed')
     and current_date < current_scheduled_for::date then
    raise exception 'This scheduled job cannot begin before the scheduled service date';
  end if;

  if new_status = 'in_progress' then
    if not exists (
      select 1
      from public.repair_authorizations ra
      where ra.request_id = update_mechanic_job_status.request_id
        and ra.authorization_type = 'initial'
        and ra.status = 'approved'
    ) then
      raise exception 'Customer must approve the repair authorization before work can begin';
    end if;
  end if;

  if new_status = 'completed' then
    if exists (
      select 1
      from public.repair_authorizations ra
      where ra.request_id = update_mechanic_job_status.request_id
        and ra.status = 'pending'
    ) then
      raise exception 'Customer must respond to the pending authorization before the job can be completed';
    end if;
  end if;

  if not (
    (current_status = 'accepted' and new_status = 'on_the_way')
    or
    (current_status = 'on_the_way' and new_status = 'in_progress')
    or
    (current_status = 'in_progress' and new_status = 'completed')
  ) then
    raise exception 'Invalid job status change';
  end if;

  update public.service_requests
  set status = new_status
  where id = request_id
    and provider_id = auth.uid();
end;
$function$;
