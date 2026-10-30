-- Captures the single-card completion RPC missing from the uploaded history.
-- Reviewed against the user's exported live definition. No Stripe calls here.
ALTER TABLE public.service_payments
  ADD COLUMN IF NOT EXISTS single_transfer_attempted_at timestamptz;

CREATE OR REPLACE FUNCTION public.complete_single_payment_transfer(
  p_payment_id uuid, p_transfer_id text, p_charge_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
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
  SELECT * INTO v_payment FROM public.service_payments
  WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;

  -- Trusted server code must verify the actual Stripe transfer before calling.
  -- Completion records an already sent transfer, even if a risk hold won the
  -- race after authorization. It must never clear that hold or authorize money.
  IF v_payment.transfer_status = 'transferred'
     AND v_payment.stripe_transfer_id = p_transfer_id
     AND v_payment.stripe_charge_id = p_charge_id
     AND v_payment.payment_status = 'paid' THEN
    RETURN true;
  END IF;
  IF v_payment.payment_status <> 'pending'
     OR v_payment.transfer_status <> 'processing'
     OR v_payment.stripe_transfer_id IS NOT NULL
     OR v_payment.single_transfer_attempted_at IS NULL
     OR v_payment.split_transfer_attempted_at IS NOT NULL
     OR v_payment.stripe_payment_intent_id IS NULL
     OR (v_payment.stripe_charge_id IS NOT NULL
         AND v_payment.stripe_charge_id <> p_charge_id)
     OR EXISTS (SELECT 1 FROM public.service_payment_parts
                WHERE service_payment_id = p_payment_id) THEN
    RAISE EXCEPTION 'Payment is not eligible for transfer completion';
  END IF;
  UPDATE public.service_payments
  SET payment_status = 'paid', transfer_status = 'transferred',
      stripe_transfer_id = p_transfer_id, stripe_charge_id = p_charge_id,
      paid_at = now(), provider_transferred_at = now(), updated_at = now(),
      payout_hold_reason = CASE WHEN payout_hold_reason IS NOT NULL
                                THEN 'manual_review' ELSE NULL END,
      payment_error = CASE WHEN payout_hold_reason IS NULL THEN NULL ELSE payment_error END,
      transfer_error = CASE WHEN payout_hold_reason IS NULL THEN NULL ELSE transfer_error END
  WHERE id = p_payment_id;
  RETURN true;
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_single_payment_transfer(uuid,text,text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_single_payment_transfer(uuid,text,text)
TO service_role;

REVOKE ALL ON FUNCTION public.claim_single_payment_transfer(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_single_payment_transfer(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.begin_single_transfer_attempt(uuid)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_single_transfer_attempt(uuid) TO service_role;
