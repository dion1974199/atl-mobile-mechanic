CREATE OR REPLACE FUNCTION public.get_customer_payment_statuses()
RETURNS TABLE(request_id uuid, payment_status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select
    sp.request_id,
    sp.payment_status
  from public.service_payments sp
  where sp.customer_id = auth.uid();
$function$;

REVOKE ALL ON FUNCTION public.get_customer_payment_statuses() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_customer_payment_statuses() TO authenticated;
