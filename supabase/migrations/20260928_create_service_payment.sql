CREATE OR REPLACE FUNCTION public.create_service_payment(request_id_input uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  request_customer_id uuid;
  request_provider_id uuid;
  approved_total numeric(10,2);
  fee_percent numeric(5,2) := 15.00;
  fee_amount numeric(10,2);
  provider_payout numeric(10,2);
  new_payment_id uuid;
begin
  select
    sr.customer_id,
    sr.provider_id
  into
    request_customer_id,
    request_provider_id
  from public.service_requests sr
  where sr.id = request_id_input;

  if not found then
    raise exception 'Service request not found';
  end if;

  if request_customer_id <> auth.uid() then
    raise exception 'Only the customer can create the payment';
  end if;

  if request_provider_id is null then
    raise exception 'Service request has no assigned provider';
  end if;

  select coalesce(sum(
    coalesce(ra.parts_amount, 0)
    + coalesce(ra.labor_amount, 0)
  ), 0)
  into approved_total
  from public.repair_authorizations ra
  where ra.request_id = request_id_input
    and ra.status = 'approved';

  if approved_total <= 0 then
    raise exception 'No approved repair amount found';
  end if;

  fee_amount :=
    round(approved_total * fee_percent / 100, 2);

  provider_payout :=
    approved_total - fee_amount;

  insert into public.service_payments (
    request_id,
    customer_id,
    provider_id,
    authorized_amount,
    marketplace_fee_percent,
    marketplace_fee_amount,
    provider_amount,
    currency,
    payment_status
  )
  values (
    request_id_input,
    request_customer_id,
    request_provider_id,
    approved_total,
    fee_percent,
    fee_amount,
    provider_payout,
    'usd',
    'pending'
  )
  returning id into new_payment_id;

  return new_payment_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.create_service_payment(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_service_payment(uuid) TO authenticated;
