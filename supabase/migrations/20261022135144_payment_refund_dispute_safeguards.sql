-- Required before single-card transfer functions are defined.
ALTER TABLE public.service_payments
  ADD COLUMN IF NOT EXISTS single_transfer_attempted_at timestamptz;

-- Track refund and dispute activity independently of payout status.
-- A non-null hold prevents new mechanic transfer claims.
ALTER TABLE public.service_payments
  ADD COLUMN IF NOT EXISTS payout_hold_reason text,
  ADD COLUMN IF NOT EXISTS payout_hold_at timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_dispute_id text,
  ADD COLUMN IF NOT EXISTS stripe_dispute_status text,
  ADD COLUMN IF NOT EXISTS stripe_refund_id text;

ALTER TABLE public.service_payments
  ADD CONSTRAINT service_payments_payout_hold_reason_check
  CHECK (
    payout_hold_reason IS NULL
    OR payout_hold_reason IN ('refund', 'dispute', 'manual_review')
  );

-- Prevent new single-card payouts when a refund, dispute, or manual hold exists.
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
    AND p.payment_status = 'pending'
    AND p.transfer_status = 'not_transferred'
    AND p.payout_hold_reason IS NULL
    AND p.stripe_transfer_id IS NULL
    AND p.single_transfer_attempted_at IS NULL
    AND p.split_transfer_attempted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.service_payment_parts AS part
      WHERE part.service_payment_id = p.id
    )
    AND EXISTS (
      SELECT 1
      FROM public.service_requests AS r
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

-- Block transfer attempts when a payout hold has been recorded.
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
    AND p.payment_status = 'pending'
    AND p.transfer_status = 'processing'
    AND p.payout_hold_reason IS NULL
    AND p.stripe_transfer_id IS NULL
    AND p.single_transfer_attempted_at IS NULL
    AND p.split_transfer_attempted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.service_payment_parts AS part
      WHERE part.service_payment_id = p.id
    );

  v_claimed := FOUND;
  RETURN v_claimed;
END;
$function$;

-- Block split-card transfer attempts when a payout hold exists.
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
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.service_payments
  SET split_transfer_attempted_at = now()
  WHERE id = payment_id_input
    AND transfer_status = 'processing'
    AND payment_status = 'pending'
    AND payout_hold_reason IS NULL
    AND stripe_transfer_id IS NULL
    AND split_transfer_attempted_at IS NULL
  RETURNING true INTO attempt_started;

  RETURN COALESCE(attempt_started, false);
END;
$function$;


-- Prevent held split-card payments from claiming mechanic payouts.
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

  SELECT *
  INTO bill
  FROM public.service_payments
  WHERE id = payment_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF bill.transfer_status <> 'not_transferred'
     OR bill.stripe_transfer_id IS NOT NULL
     OR bill.stripe_payment_intent_id IS NOT NULL
     OR bill.payment_status <> 'pending'
     OR bill.payout_hold_reason IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Require completed work and customer satisfaction confirmation.
  IF NOT EXISTS (
    SELECT 1
    FROM public.service_requests sr
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

-- Atomically reserve a payout hold when Stripe reports refund or dispute activity.
-- Never automatically release a hold; simultaneous issues require manual review.
CREATE OR REPLACE FUNCTION public.record_payment_payout_hold(
  p_payment_id uuid,
  p_reason text,
  p_stripe_reference text DEFAULT NULL,
  p_stripe_status text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_payment public.service_payments%ROWTYPE;
  v_reason text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF p_reason NOT IN ('refund', 'dispute', 'manual_review') OR p_reason IS NULL THEN
    RAISE EXCEPTION 'Invalid payout hold reason';
  END IF;

  IF p_reason IN ('refund', 'dispute')
     AND NULLIF(btrim(p_stripe_reference), '') IS NULL THEN
    RAISE EXCEPTION 'Stripe reference is required for refund or dispute holds';
  END IF;

  SELECT *
  INTO v_payment
  FROM public.service_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  v_reason := CASE
    WHEN v_payment.payout_hold_reason = 'manual_review' THEN 'manual_review'
    WHEN v_payment.payout_hold_reason IS NOT NULL
         AND v_payment.payout_hold_reason <> p_reason THEN 'manual_review'
    WHEN p_reason = 'dispute'
         AND v_payment.stripe_dispute_id IS NOT NULL
         AND p_stripe_reference IS NOT NULL
         AND v_payment.stripe_dispute_id <> p_stripe_reference THEN 'manual_review'
    WHEN p_reason = 'refund'
         AND v_payment.stripe_refund_id IS NOT NULL
         AND p_stripe_reference IS NOT NULL
         AND v_payment.stripe_refund_id <> p_stripe_reference THEN 'manual_review'
    ELSE p_reason
  END;

  UPDATE public.service_payments
  SET payout_hold_reason = v_reason,
      payout_hold_at = COALESCE(payout_hold_at, now()),
      stripe_dispute_id = CASE
        WHEN p_reason = 'dispute' THEN COALESCE(stripe_dispute_id, p_stripe_reference)
        ELSE stripe_dispute_id
      END,
      stripe_dispute_status = CASE
        WHEN p_reason = 'dispute' THEN COALESCE(p_stripe_status, stripe_dispute_status)
        ELSE stripe_dispute_status
      END,
      stripe_refund_id = CASE
        WHEN p_reason = 'refund' THEN COALESCE(stripe_refund_id, p_stripe_reference)
        ELSE stripe_refund_id
      END
  WHERE id = p_payment_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_payment_payout_hold(uuid, text, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_payment_payout_hold(uuid, text, text, text)
TO service_role;

-- Synchronize split-card refund reservations with payout holds.
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

  IF parent_payment.payment_status NOT IN ('pending', 'partially_refunded')
     OR parent_payment.transfer_status NOT IN (
       'not_transferred', 'refund_pending'
     )
     OR parent_payment.stripe_transfer_id IS NOT NULL THEN
    RETURN false;
  END IF;

  SELECT * INTO current_part
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF current_part.payment_status <> 'succeeded'
     OR current_part.stripe_payment_intent_id IS NULL
     OR current_part.stripe_charge_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.service_payments
  SET transfer_status = 'refund_pending',
      payout_hold_reason = CASE
        WHEN payout_hold_reason IS NULL THEN 'refund'
        WHEN payout_hold_reason = 'refund' THEN 'refund'
        ELSE 'manual_review'
      END,
      payout_hold_at = COALESCE(payout_hold_at, now()),
      updated_at = now()
  WHERE id = parent_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_split_payment_refund(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_split_payment_refund(uuid)
TO service_role;
