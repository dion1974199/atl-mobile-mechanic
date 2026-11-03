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
     OR v_request.status <> 'work_completed' THEN
    RAISE EXCEPTION 'Payment requires manual settlement review';
  END IF;

  -- A verified charge is recorded even if a payout hold arrived first.
  -- Existing refund/dispute references and holds are never cleared.
  -- Refunded or partially refunded payments are excluded above.
  -- A separate transfer claim must reject all payout holds and risk references.

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

-- Single-card transfer eligibility after verified customer payment.
-- Retain the existing safeguards and change only the payment-state requirement.
CREATE OR REPLACE FUNCTION public.claim_single_payment_transfer(p_payment_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_claimed boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  UPDATE public.service_payments AS p
  SET transfer_status = 'processing'
  WHERE p.id = p_payment_id
    AND p.stripe_payment_intent_id IS NOT NULL
    AND p.payment_status = 'paid'
    AND p.transfer_status = 'not_transferred'
    AND p.payout_hold_reason IS NULL
    AND p.stripe_refund_id IS NULL
    AND p.stripe_dispute_id IS NULL
    AND p.stripe_charge_id IS NOT NULL
    AND p.stripe_transfer_id IS NULL
    AND p.single_transfer_attempted_at IS NULL
    AND p.split_transfer_attempted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.service_payment_parts AS part
      WHERE part.service_payment_id = p.id
    )
    AND EXISTS (
      SELECT 1 FROM public.service_requests AS r
      WHERE r.id = p.request_id
        AND r.customer_id = p.customer_id
        AND r.provider_id = p.provider_id
        AND r.status = 'completed'
        AND r.customer_confirmed_at IS NOT NULL
    );

  v_claimed := FOUND;
  RETURN v_claimed;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_single_payment_transfer(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_single_payment_transfer(uuid)
TO service_role;

CREATE OR REPLACE FUNCTION public.begin_single_transfer_attempt(p_payment_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_claimed boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  UPDATE public.service_payments AS p
  SET single_transfer_attempted_at = now()
  WHERE p.id = p_payment_id
    AND p.stripe_payment_intent_id IS NOT NULL
    AND p.payment_status = 'paid'
    AND p.transfer_status = 'processing'
    AND p.payout_hold_reason IS NULL
    AND p.stripe_refund_id IS NULL
    AND p.stripe_dispute_id IS NULL
    AND p.stripe_charge_id IS NOT NULL
    AND p.stripe_transfer_id IS NULL
    AND p.single_transfer_attempted_at IS NULL
    AND p.split_transfer_attempted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.service_payment_parts AS part
      WHERE part.service_payment_id = p.id
    );

  v_claimed := FOUND;
  RETURN v_claimed;
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_single_transfer_attempt(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_single_transfer_attempt(uuid)
TO service_role;

-- Complete an already-verified single-card provider transfer.
-- The Stripe transfer must be independently verified by trusted server code.
CREATE OR REPLACE FUNCTION public.complete_single_payment_transfer(
  p_payment_id uuid, p_transfer_id text, p_charge_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment public.service_payments%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_transfer_id IS NULL OR p_transfer_id !~ '^tr_[A-Za-z0-9]+$'
     OR p_charge_id IS NULL OR p_charge_id !~ '^ch_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Valid Stripe transfer and charge IDs are required';
  END IF;

  SELECT * INTO v_payment
  FROM public.service_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF v_payment.transfer_status = 'transferred'
     AND v_payment.stripe_transfer_id = p_transfer_id
     AND v_payment.stripe_charge_id = p_charge_id
     AND v_payment.payment_status IN ('paid', 'partially_refunded', 'refunded') THEN
    RETURN true;
  END IF;

  IF v_payment.payment_status NOT IN ('paid', 'partially_refunded', 'refunded')
     OR v_payment.transfer_status <> 'processing'
     OR v_payment.stripe_transfer_id IS NOT NULL
     OR v_payment.single_transfer_attempted_at IS NULL
     OR v_payment.split_transfer_attempted_at IS NOT NULL
     OR v_payment.stripe_payment_intent_id IS NULL
     OR v_payment.stripe_charge_id IS DISTINCT FROM p_charge_id
     OR EXISTS (
       SELECT 1 FROM public.service_payment_parts
       WHERE service_payment_id = p_payment_id
     ) THEN
    RAISE EXCEPTION 'Payment is not eligible for transfer completion';
  END IF;

  -- A transfer may already have been sent before a risk hold arrived.
  -- Record that transfer without clearing or overriding the hold.
  UPDATE public.service_payments
  SET transfer_status = 'transferred',
      stripe_transfer_id = p_transfer_id,
      provider_transferred_at = COALESCE(provider_transferred_at, now()),
      updated_at = now(),
      payout_hold_reason = CASE
        WHEN payout_hold_reason IS NOT NULL
          OR payment_status IN ('partially_refunded', 'refunded')
          THEN 'manual_review'
        ELSE NULL
      END,
      transfer_error = CASE
        WHEN payout_hold_reason IS NULL THEN NULL
        ELSE transfer_error
      END
  WHERE id = p_payment_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_single_payment_transfer(uuid,text,text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_single_payment_transfer(uuid,text,text)
TO service_role;

-- Claim a split-card provider transfer only after full verified payment.
CREATE OR REPLACE FUNCTION public.claim_split_payment_transfer(
  payment_id_input uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  bill public.service_payments%ROWTYPE;
  successful_count integer;
  successful_total bigint;
  expected_total bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  SELECT * INTO bill
  FROM public.service_payments
  WHERE id = payment_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF bill.transfer_status <> 'not_transferred'
     OR bill.stripe_transfer_id IS NOT NULL
     OR bill.stripe_payment_intent_id IS NOT NULL
     OR bill.payment_status <> 'paid'
     OR bill.payout_hold_reason IS NOT NULL
     OR bill.stripe_refund_id IS NOT NULL
     OR bill.stripe_dispute_id IS NOT NULL
     OR bill.split_transfer_attempted_at IS NOT NULL
     OR bill.single_transfer_attempted_at IS NOT NULL THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_requests sr
    WHERE sr.id = bill.request_id
      AND sr.customer_id = bill.customer_id
      AND sr.provider_id = bill.provider_id
      AND sr.status = 'completed'
      AND sr.customer_confirmed_at IS NOT NULL
  ) THEN
    RETURN false;
  END IF;

  expected_total := ROUND(bill.authorized_amount * 100)::bigint;

  SELECT COUNT(*)::integer,
         COALESCE(SUM(amount_cents), 0)::bigint
  INTO successful_count, successful_total
  FROM public.service_payment_parts
  WHERE service_payment_id = payment_id_input
    AND payment_status = 'succeeded'
    AND stripe_payment_intent_id IS NOT NULL
    AND stripe_charge_id IS NOT NULL;

  IF successful_count <> 2
     OR successful_total <> expected_total
     OR expected_total <= 0
     OR bill.currency <> 'usd'
     OR bill.marketplace_fee_percent <> 15.00
     OR ROUND(bill.marketplace_fee_amount * 100)::bigint
        <> ROUND(expected_total * 0.15)::bigint
     OR ROUND(bill.provider_amount * 100)::bigint
        <> expected_total - ROUND(expected_total * 0.15)::bigint THEN
    RETURN false;
  END IF;

  UPDATE public.service_payments
  SET transfer_status = 'processing',
      transfer_error = NULL
  WHERE id = payment_id_input;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_split_payment_transfer(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_split_payment_transfer(uuid)
TO service_role;

-- Reserve a split-card transfer attempt after full payment.
CREATE OR REPLACE FUNCTION public.begin_split_transfer_attempt(
  payment_id_input uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  attempt_started boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  UPDATE public.service_payments
  SET split_transfer_attempted_at = now()
  WHERE id = payment_id_input
    AND transfer_status = 'processing'
    AND payment_status = 'paid'
    AND payout_hold_reason IS NULL
    AND stripe_refund_id IS NULL
    AND stripe_dispute_id IS NULL
    AND stripe_payment_intent_id IS NULL
    AND single_transfer_attempted_at IS NULL
    AND stripe_transfer_id IS NULL
    AND split_transfer_attempted_at IS NULL
  RETURNING true INTO attempt_started;

  RETURN COALESCE(attempt_started, false);
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_split_transfer_attempt(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_split_transfer_attempt(uuid)
TO service_role;

-- Record a verified split-card provider transfer without changing customer payment.
-- Trusted server code must verify the Stripe transfer before calling this RPC.
CREATE OR REPLACE FUNCTION public.complete_split_payment_transfer(
  payment_id_input uuid,
  transfer_id_input text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  bill public.service_payments%ROWTYPE;
  successful_count integer;
  successful_total bigint;
  expected_total bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF transfer_id_input IS NULL
     OR transfer_id_input !~ '^tr_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid Stripe transfer ID';
  END IF;

  SELECT * INTO bill
  FROM public.service_payments
  WHERE id = payment_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF bill.transfer_status = 'transferred'
     AND bill.payment_status = 'paid'
     AND bill.stripe_transfer_id = transfer_id_input THEN
    RETURN;
  END IF;

  IF bill.transfer_status <> 'processing'
     OR bill.payment_status <> 'paid'
     OR bill.stripe_transfer_id IS NOT NULL
     OR bill.stripe_payment_intent_id IS NOT NULL
     OR bill.split_transfer_attempted_at IS NULL
     OR bill.single_transfer_attempted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Payment is not eligible for transfer completion';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_requests sr
    WHERE sr.id = bill.request_id
      AND sr.customer_id = bill.customer_id
      AND sr.provider_id = bill.provider_id
      AND sr.status = 'completed'
      AND sr.customer_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Job completion and customer confirmation required';
  END IF;

  expected_total := ROUND(bill.authorized_amount * 100)::bigint;

  SELECT COUNT(*)::integer,
         COALESCE(SUM(amount_cents), 0)::bigint
  INTO successful_count, successful_total
  FROM public.service_payment_parts
  WHERE service_payment_id = payment_id_input
    AND payment_status = 'succeeded'
    AND stripe_payment_intent_id IS NOT NULL
    AND stripe_charge_id IS NOT NULL;

  IF successful_count <> 2
     OR successful_total <> expected_total
     OR expected_total <= 0
     OR bill.currency <> 'usd'
     OR bill.marketplace_fee_percent <> 15.00
     OR ROUND(bill.marketplace_fee_amount * 100)::bigint
        <> ROUND(expected_total * 0.15)::bigint
     OR ROUND(bill.provider_amount * 100)::bigint
        <> expected_total - ROUND(expected_total * 0.15)::bigint THEN
    RAISE EXCEPTION 'Split payment verification failed';
  END IF;

  -- Record a transfer already sent by Stripe; never clear an existing hold.
  UPDATE public.service_payments
  SET stripe_transfer_id = transfer_id_input,
      transfer_status = 'transferred',
      provider_transferred_at = COALESCE(provider_transferred_at, now()),
      payout_hold_reason = CASE
        WHEN payout_hold_reason IS NOT NULL THEN 'manual_review'
        ELSE NULL
      END,
      transfer_error = CASE
        WHEN payout_hold_reason IS NULL THEN NULL
        ELSE transfer_error
      END,
      updated_at = now()
  WHERE id = payment_id_input;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_split_payment_transfer(uuid,text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_split_payment_transfer(uuid,text)
TO service_role;

-- Split-card refund reservation after verified customer settlement.

-- Split-card refund reservation after verified customer settlement.
-- Reserve the refund before contacting Stripe, without racing a provider transfer.
CREATE OR REPLACE FUNCTION public.claim_split_payment_refund(
  part_id_input uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  parent_id uuid;
  parent_payment public.service_payments%ROWTYPE;
  current_part public.service_payment_parts%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  SELECT service_payment_id INTO parent_id
  FROM public.service_payment_parts
  WHERE id = part_id_input;

  IF parent_id IS NULL THEN
    RAISE EXCEPTION 'Split-payment part not found';
  END IF;

  SELECT * INTO parent_payment
  FROM public.service_payments
  WHERE id = parent_id
  FOR UPDATE;

  IF parent_payment.payment_status NOT IN
       ('pending', 'paid', 'partially_refunded')
     OR parent_payment.transfer_status NOT IN
       ('not_transferred', 'refund_pending')
     OR parent_payment.stripe_transfer_id IS NOT NULL
     OR parent_payment.single_transfer_attempted_at IS NOT NULL
     OR parent_payment.split_transfer_attempted_at IS NOT NULL
  THEN
    RETURN false;
  END IF;

  SELECT * INTO current_part
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF NOT FOUND
     OR current_part.service_payment_id IS DISTINCT FROM parent_id
     OR current_part.payment_status <> 'succeeded'
     OR current_part.stripe_payment_intent_id IS NULL
     OR current_part.stripe_charge_id IS NULL
  THEN
    RETURN false;
  END IF;

  UPDATE public.service_payments
  SET transfer_status = 'refund_pending',
      updated_at = now()
  WHERE id = parent_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_split_payment_refund(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_split_payment_refund(uuid)
TO service_role;

-- Allow verified split-card refunds after parent settlement.

-- Allow verified split-card refunds after parent settlement.
-- Preserve the existing allocation and successful-payment protections.
CREATE OR REPLACE FUNCTION public.validate_service_payment_part()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  bill_cents bigint;
  allocated_cents bigint;
  bill_status text;
BEGIN
  SELECT ROUND(authorized_amount * 100)::bigint, payment_status
  INTO bill_cents, bill_status
  FROM public.service_payments
  WHERE id = NEW.service_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Service payment not found';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.service_payment_id IS DISTINCT FROM OLD.service_payment_id THEN
      RAISE EXCEPTION 'Cannot move a card payment to another bill';
    END IF;

    IF OLD.payment_status IN ('succeeded', 'refunded')
       AND (
         NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
         OR NEW.card_number IS DISTINCT FROM OLD.card_number
         OR NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
         OR NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id
       ) THEN
      RAISE EXCEPTION 'Cannot change settled card payment details';
    END IF;
  END IF;

  IF bill_status = 'paid' THEN
    IF TG_OP <> 'UPDATE'
       OR OLD.payment_status <> 'succeeded'
       OR NEW.payment_status <> 'refunded'
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.card_number IS DISTINCT FROM OLD.card_number
       OR NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
       OR NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id
    THEN
      RAISE EXCEPTION 'Cannot modify card allocations on a paid bill';
    END IF;
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0)
  INTO allocated_cents
  FROM public.service_payment_parts
  WHERE service_payment_id = NEW.service_payment_id
    AND id <> NEW.id
    AND payment_status NOT IN ('canceled', 'refunded');

  IF allocated_cents + NEW.amount_cents > bill_cents THEN
    RAISE EXCEPTION 'Card allocations exceed the service bill';
  END IF;

  RETURN NEW;
END;
$function$;

-- Atomically settle both verified split-card charges.

-- Atomically settle both verified split-card charges.
-- Trusted webhook code must verify each Stripe charge before recording success.
CREATE OR REPLACE FUNCTION public.record_verified_split_payment(
  p_payment_id uuid
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
  v_count integer;
  v_total bigint;
  v_expected bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

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
    RAISE EXCEPTION 'Payment ownership changed';
  END IF;

  IF v_payment.stripe_payment_intent_id IS NOT NULL
     OR v_payment.currency <> 'usd'
     OR v_payment.authorized_amount <= 0
     OR v_payment.customer_id IS DISTINCT FROM v_request.customer_id
     OR v_payment.provider_id IS DISTINCT FROM v_request.provider_id
     OR v_request.customer_confirmed_at IS NULL THEN
    RAISE EXCEPTION 'Split-payment ownership verification failed';
  END IF;

  IF v_payment.payment_status = 'paid'
     AND v_request.status = 'completed' THEN
    RETURN true;
  END IF;

  -- Never reactivate refunded, canceled, or otherwise settled payments.
  IF v_payment.payment_status <> 'pending'
     OR v_request.status <> 'work_completed' THEN
    RETURN false;
  END IF;

  v_expected := ROUND(v_payment.authorized_amount * 100)::bigint;

  SELECT COUNT(*)::integer, COALESCE(SUM(amount_cents), 0)::bigint
  INTO v_count, v_total
  FROM public.service_payment_parts
  WHERE service_payment_id = p_payment_id
    AND payment_status = 'succeeded'
    AND stripe_payment_intent_id IS NOT NULL
    AND stripe_charge_id IS NOT NULL
    AND currency = 'usd';

  IF v_count <> 2
     OR (SELECT COUNT(*)
         FROM public.service_payment_parts
         WHERE service_payment_id = p_payment_id) <> 2
     OR v_total <> v_expected OR v_expected <= 0
     OR v_payment.marketplace_fee_percent <> 15
     OR ROUND(v_payment.marketplace_fee_amount * 100)::bigint
        <> ROUND(v_expected * 0.15)::bigint
     OR ROUND(v_payment.provider_amount * 100)::bigint
        <> v_expected - ROUND(v_expected * 0.15)::bigint THEN
    RETURN false;
  END IF;

  UPDATE public.service_payments
  SET payment_status = 'paid',
      paid_at = COALESCE(paid_at, now()),
      updated_at = now()
  WHERE id = p_payment_id;

  UPDATE public.service_requests
  SET status = 'completed'
  WHERE id = v_request.id
    AND status = 'work_completed';

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_verified_split_payment(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_verified_split_payment(uuid)
TO service_role;
