-- Apply only after the preceding refund/dispute migration. No automatic hold release.
-- Lock and re-check event ownership in the same transaction as the hold write.
CREATE OR REPLACE FUNCTION public.record_verified_payment_payout_hold(
  p_payment_id uuid, p_payment_intent_id text, p_charge_id text,
  p_reason text, p_stripe_reference text, p_stripe_status text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  bill public.service_payments%ROWTYPE;
  matches integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_payment_intent_id IS NULL OR p_charge_id IS NULL THEN
    RAISE EXCEPTION 'Stripe identifiers required';
  END IF;
  SELECT * INTO bill FROM public.service_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  SELECT count(*) INTO matches FROM (
    SELECT p.id FROM public.service_payments p
    WHERE p.stripe_payment_intent_id = p_payment_intent_id
      AND p.id = p_payment_id
      AND (p.stripe_charge_id IS NULL OR p.stripe_charge_id = p_charge_id)
    UNION ALL
    SELECT part.service_payment_id FROM public.service_payment_parts part
    WHERE part.service_payment_id = p_payment_id
      AND part.stripe_payment_intent_id = p_payment_intent_id
      AND (part.stripe_charge_id IS NULL OR part.stripe_charge_id = p_charge_id)
  ) matched;
  IF matches <> 1 THEN RAISE EXCEPTION 'Risk event payment ownership changed'; END IF;
  PERFORM public.record_payment_payout_hold(p_payment_id, p_reason, p_stripe_reference, p_stripe_status);
  -- A hold cannot cancel an HTTP request already sent to Stripe. Preserve the
  -- attempt and settlement identifiers for reconciliation; escalate for recovery.
  IF bill.single_transfer_attempted_at IS NOT NULL
     OR bill.split_transfer_attempted_at IS NOT NULL
     OR bill.stripe_transfer_id IS NOT NULL THEN
    UPDATE public.service_payments SET payout_hold_reason = 'manual_review'
    WHERE id = p_payment_id;
  END IF;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_verified_payment_payout_hold(uuid,text,text,text,text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_verified_payment_payout_hold(uuid,text,text,text,text,text)
TO service_role;

-- Keep single-card and split-card attempt reservations mutually exclusive.
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
    AND stripe_payment_intent_id IS NULL
    AND single_transfer_attempted_at IS NULL
    AND stripe_transfer_id IS NULL
    AND split_transfer_attempted_at IS NULL
  RETURNING true INTO attempt_started;

  RETURN COALESCE(attempt_started, false);
END;
$function$;

-- Event delivery and concurrent handlers can arrive out of order.
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
        WHEN p_reason = 'dispute'
          AND (stripe_dispute_id IS NULL OR stripe_dispute_id = p_stripe_reference)
          AND (stripe_dispute_status IS NULL
               OR stripe_dispute_status NOT IN ('won', 'lost', 'warning_closed')
               OR p_stripe_status = stripe_dispute_status)
        THEN COALESCE(p_stripe_status, stripe_dispute_status)
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
