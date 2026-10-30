-- ATL Mobile Mechanic: separate verified customer payments from provider transfers.
-- Created October 30, 2026.
--
-- Required payment lifecycle:
-- 1. Provider finishes work: service_requests.status = 'work_completed'.
-- 2. Customer confirms satisfactory completion.
-- 3. Stripe verifies successful customer payment.
-- 4. Database records payment_status = 'paid' independently of provider payout.
-- 5. Database finalizes the job as 'completed' after verified payment.
-- 6. Provider transfer proceeds only when payout safeguards permit.
--
-- Safety requirements:
-- - Service-role-only payment settlement functions.
-- - Verify Stripe payment identity, amount, currency, and ownership.
-- - Preserve row locking and idempotency.
-- - Never initiate duplicate Stripe transfers.
-- - Preserve refund, dispute, and manual-review payout holds.
-- - Never clear an existing payout hold automatically.
-- - Never mark an unpaid job completed.
-- - Preserve separate verification of both split-card charges.
--
-- Implementation will be added below after reviewing function dependencies.

-- Record a verified single-card charge independently of provider payout.
-- The trusted webhook must verify the Stripe PaymentIntent, charge, amount,
-- currency, metadata, and provider before invoking this function.
CREATE OR REPLACE FUNCTION public.record_verified_single_payment(
  p_payment_id uuid,
  p_payment_intent_id text,
  p_charge_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment public.service_payments%ROWTYPE;
  v_request public.service_requests%ROWTYPE;
  v_request_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_payment_intent_id IS NULL
     OR p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
     OR p_charge_id IS NULL
     OR p_charge_id !~ '^ch_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid Stripe payment identifiers';
  END IF;

  -- Lock the service request before its payment record.
  -- Obtain the request ID without locking, then revalidate after locking.
  SELECT request_id INTO v_request_id
  FROM public.service_payments
  WHERE id = p_payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  SELECT * INTO v_request
  FROM public.service_requests
  WHERE id = v_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service request not found';
  END IF;

  SELECT * INTO v_payment
  FROM public.service_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_payment.request_id IS DISTINCT FROM v_request.id THEN
    RAISE EXCEPTION 'Payment request changed during settlement';
  END IF;

  IF v_payment.stripe_payment_intent_id IS DISTINCT FROM p_payment_intent_id
     OR v_payment.currency <> 'usd'
     OR v_payment.authorized_amount <= 0
     OR v_payment.customer_id IS NULL
     OR v_payment.provider_id IS NULL
     OR EXISTS (
       SELECT 1
       FROM public.service_payment_parts
       WHERE service_payment_id = p_payment_id
     ) THEN
    RAISE EXCEPTION 'Single-card payment verification failed';
  END IF;

  IF v_payment.stripe_charge_id IS NOT NULL
     AND v_payment.stripe_charge_id <> p_charge_id THEN
    RAISE EXCEPTION 'Stripe charge mismatch';
  END IF;

  IF v_request.customer_id IS DISTINCT FROM v_payment.customer_id
     OR v_request.provider_id IS DISTINCT FROM v_payment.provider_id
     OR v_request.customer_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Customer confirmation or ownership verification failed';
  END IF;

  -- Idempotent webhook retries must not overwrite refunds or disputes.
  IF v_payment.payment_status = 'paid'
     AND v_payment.stripe_charge_id = p_charge_id
     AND v_request.status = 'completed' THEN
    RETURN true;
  END IF;

  IF v_payment.payment_status <> 'pending'
     OR v_request.status <> 'work_completed'
     OR v_payment.stripe_refund_id IS NOT NULL
     OR v_payment.stripe_dispute_id IS NOT NULL
     OR v_payment.transfer_status IN ('refund_pending', 'reversed')
     OR v_payment.payout_hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Payment requires manual settlement review';
  END IF;

  UPDATE public.service_payments
  SET payment_status = 'paid',
      stripe_charge_id = p_charge_id,
      paid_at = COALESCE(paid_at, now()),
      payment_error = NULL,
      updated_at = now()
  WHERE id = p_payment_id;

  UPDATE public.service_requests
  SET status = 'completed'
  WHERE id = v_payment.request_id
    AND status = 'work_completed';

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_verified_single_payment(uuid,text,text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_verified_single_payment(uuid,text,text)
TO service_role;
