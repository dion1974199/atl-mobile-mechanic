-- Split-payment schema prerequisites.
-- Add the transfer-attempt timestamp before defining dependent functions.
ALTER TABLE public.service_payments
ADD COLUMN IF NOT EXISTS split_transfer_attempted_at timestamptz;

-- Store the two card payments associated with a service bill.
CREATE TABLE IF NOT EXISTS public.service_payment_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_payment_id uuid NOT NULL REFERENCES public.service_payments(id),
  card_number smallint NOT NULL CHECK (card_number IN (1, 2)),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN (
      'pending', 'processing', 'succeeded',
      'failed', 'canceled', 'refunded'
    )),
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  UNIQUE (service_payment_id, card_number)
);

-- Reserve split-card PaymentIntent creation before calling Stripe.
ALTER TABLE public.service_payment_parts
ADD COLUMN IF NOT EXISTS intent_creation_reserved_at timestamptz;

-- Split-payment settlement: records a previously verified Stripe transfer.
-- Stripe transfer verification must occur in trusted server-side code.
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

  SELECT *
  INTO bill
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
     OR bill.payment_status <> 'pending'
     OR bill.stripe_transfer_id IS NOT NULL
     OR bill.stripe_payment_intent_id IS NOT NULL
     OR bill.split_transfer_attempted_at IS NULL THEN
    RAISE EXCEPTION 'Payment is not eligible for transfer completion';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.service_requests sr
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

  UPDATE public.service_payments
  SET
    payment_status = 'paid',
    stripe_transfer_id = transfer_id_input,
    transfer_status = 'transferred',
    paid_at = now(),
    provider_transferred_at = now(),
    payment_error = NULL,
    transfer_error = NULL,
    updated_at = now()
  WHERE id = payment_id_input;
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_split_payment_transfer(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.complete_split_payment_transfer(uuid, text)
TO service_role;

-- Record a failed or canceled split-card payment.
CREATE OR REPLACE FUNCTION public.record_split_payment_failure(
  part_id_input uuid,
  payment_intent_id_input text,
  failure_status_input text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  current_part public.service_payment_parts%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF failure_status_input NOT IN ('failed', 'canceled') THEN
    RAISE EXCEPTION 'Invalid failure status';
  END IF;

  -- Lock the parent before the card to avoid conflicting lock order.
  PERFORM 1
  FROM public.service_payments
  WHERE id = (
    SELECT service_payment_id
    FROM public.service_payment_parts
    WHERE id = part_id_input
  )
  FOR UPDATE;

  SELECT *
  INTO current_part
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Split-payment part not found';
  END IF;

  IF current_part.stripe_payment_intent_id
     IS DISTINCT FROM payment_intent_id_input THEN
    RAISE EXCEPTION 'Stripe PaymentIntent mismatch';
  END IF;

  IF current_part.payment_status IN (
    'processing', 'succeeded', 'refunded'
  ) THEN
    RETURN false;
  END IF;

  IF current_part.payment_status = 'canceled'
     AND failure_status_input = 'failed' THEN
    RETURN false;
  END IF;

  UPDATE public.service_payment_parts
  SET
    payment_status = failure_status_input,
    updated_at = now()
  WHERE id = part_id_input;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_split_payment_failure(uuid, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_split_payment_failure(uuid, text, text)
TO service_role;

-- Atomically authorize the first mechanic transfer attempt.
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

-- Protect successful and refunded card payment records.
CREATE OR REPLACE FUNCTION public.protect_successful_payment_part()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.payment_status = 'succeeded'
     AND NEW.payment_status NOT IN ('succeeded', 'refunded') THEN
    RAISE EXCEPTION
      'A successful card payment cannot be reset';
  END IF;

  IF OLD.payment_status = 'refunded'
     AND NEW.payment_status <> 'refunded' THEN
    RAISE EXCEPTION
      'A refunded card payment cannot be reactivated';
  END IF;

  IF OLD.payment_status IN ('succeeded', 'refunded')
     AND (
       NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
       OR NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id
       OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
       OR NEW.card_number IS DISTINCT FROM OLD.card_number
     ) THEN
    RAISE EXCEPTION
      'Stripe identifiers and amounts cannot change after successful payment';
  END IF;

  RETURN NEW;
END;
$function$;

-- Prevent deletion of successful or refunded card-payment records.
CREATE OR REPLACE FUNCTION public.prevent_payment_part_deletion()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.payment_status IN ('succeeded', 'refunded') THEN
    RAISE EXCEPTION
      'Successful or refunded card payment records cannot be deleted';
  END IF;

  RETURN OLD;
END;
$function$;

-- Prevent split-card payments when a single-card PaymentIntent exists.
CREATE OR REPLACE FUNCTION public.prevent_mixed_payment_modes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.service_payments
    WHERE id = NEW.service_payment_id
      AND stripe_payment_intent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot use split-card payments when a single-card payment exists';
  END IF;

  RETURN NEW;
END;
$function$;

-- Prevent single-card payment when split-card records already exist.
CREATE OR REPLACE FUNCTION public.prevent_single_card_after_split()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.stripe_payment_intent_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.service_payment_parts
       WHERE service_payment_id = NEW.id
     )
  THEN
    RAISE EXCEPTION
      'Cannot use single-card payment when split-card payments exist';
  END IF;

  RETURN NEW;
END;
$function$;

-- Validate split-card allocations against the authorized service bill.
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

  IF bill_status = 'paid' THEN
    RAISE EXCEPTION 'Cannot allocate cards to an already paid bill';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.service_payment_id <> OLD.service_payment_id THEN
      RAISE EXCEPTION 'Cannot move a card payment to another bill';
    END IF;

    IF OLD.payment_status = 'succeeded'
       AND (
         NEW.amount_cents <> OLD.amount_cents
         OR NEW.card_number <> OLD.card_number
       ) THEN
      RAISE EXCEPTION 'Cannot change a successful card payment allocation';
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

-- Protect successful and refunded payment records from deletion.
DROP TRIGGER IF EXISTS prevent_payment_part_deletion_trigger
ON public.service_payment_parts;

CREATE TRIGGER prevent_payment_part_deletion_trigger
BEFORE DELETE ON public.service_payment_parts
FOR EACH ROW
EXECUTE FUNCTION public.prevent_payment_part_deletion();

-- Protect successful and refunded card-payment records from modification.
DROP TRIGGER IF EXISTS protect_successful_payment_part_trigger
ON public.service_payment_parts;

CREATE TRIGGER protect_successful_payment_part_trigger
BEFORE UPDATE ON public.service_payment_parts
FOR EACH ROW
EXECUTE FUNCTION public.protect_successful_payment_part();

-- Prevent mixing single-card and split-card payment modes.
DROP TRIGGER IF EXISTS prevent_mixed_payment_modes_trigger
ON public.service_payment_parts;

CREATE TRIGGER prevent_mixed_payment_modes_trigger
BEFORE INSERT OR UPDATE ON public.service_payment_parts
FOR EACH ROW
EXECUTE FUNCTION public.prevent_mixed_payment_modes();

-- Validate split-card allocations before insertion or modification.
DROP TRIGGER IF EXISTS validate_service_payment_part_trigger
ON public.service_payment_parts;

CREATE TRIGGER validate_service_payment_part_trigger
BEFORE INSERT OR UPDATE ON public.service_payment_parts
FOR EACH ROW
EXECUTE FUNCTION public.validate_service_payment_part();

-- Prevent single-card checkout when split-card records exist.
DROP TRIGGER IF EXISTS prevent_single_card_after_split_trigger
ON public.service_payments;

CREATE TRIGGER prevent_single_card_after_split_trigger
BEFORE INSERT OR UPDATE OF stripe_payment_intent_id
ON public.service_payments
FOR EACH ROW
EXECUTE FUNCTION public.prevent_single_card_after_split();

-- Record a verified successful split-card payment.
CREATE OR REPLACE FUNCTION public.record_split_payment_success(
  part_id_input uuid,
  payment_intent_id_input text,
  charge_id_input text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  part_record public.service_payment_parts%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  -- Lock parent first to coordinate with refunds and transfers.
  PERFORM 1
  FROM public.service_payments
  WHERE id = (
    SELECT service_payment_id
    FROM public.service_payment_parts
    WHERE id = part_id_input
  )
  FOR UPDATE;

  SELECT *
  INTO part_record
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment part not found';
  END IF;

  IF payment_intent_id_input IS NULL
     OR payment_intent_id_input = ''
     OR part_record.stripe_payment_intent_id IS DISTINCT FROM payment_intent_id_input THEN
    RAISE EXCEPTION 'PaymentIntent mismatch';
  END IF;

  IF part_record.payment_status = 'succeeded' THEN
    IF part_record.stripe_charge_id IS DISTINCT FROM charge_id_input THEN
      RAISE EXCEPTION 'Existing charge does not match';
    END IF;
    RETURN;
  END IF;

  IF part_record.payment_status IN ('canceled', 'refunded') THEN
    RAISE EXCEPTION 'Cannot reactivate canceled or refunded payment';
  END IF;

  UPDATE public.service_payment_parts
  SET payment_status = 'succeeded',
      stripe_charge_id = charge_id_input,
      paid_at = now(),
      updated_at = now()
  WHERE id = part_id_input;

  -- A late charge during refund recovery must never trigger payout.
  UPDATE public.service_payments
  SET payment_status = 'partially_refunded',
      updated_at = now()
  WHERE id = part_record.service_payment_id
    AND transfer_status = 'refund_pending'
    AND payment_status = 'refunded';
END;
$function$;

REVOKE ALL ON FUNCTION public.record_split_payment_success(uuid, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_split_payment_success(uuid, text, text)
TO service_role;

-- Confirm both split-card payments succeeded before settlement.
CREATE OR REPLACE FUNCTION public.check_split_payment_ready(
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

  IF bill.stripe_payment_intent_id IS NOT NULL
     OR bill.payment_status <> 'pending'
     OR bill.transfer_status <> 'not_transferred'
     OR bill.stripe_transfer_id IS NOT NULL THEN
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

  RETURN (
    successful_count = 2
    AND successful_total = expected_total
    AND expected_total > 0
    AND bill.marketplace_fee_percent = 15.00
    AND ROUND(bill.provider_amount * 100)::bigint =
        expected_total - ROUND(expected_total * 0.15)::bigint
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.check_split_payment_ready(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_split_payment_ready(uuid)
TO service_role;

-- Atomically claim a mechanic transfer after both cards succeed.
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
     OR bill.payment_status <> 'pending' THEN
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

REVOKE ALL ON FUNCTION public.claim_split_payment_transfer(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_split_payment_transfer(uuid)
TO service_role;

-- Initialize two-card checkout only for an eligible, confirmed service bill.
CREATE OR REPLACE FUNCTION public.initialize_split_payment(
  payment_id_input uuid,
  first_card_cents bigint
)
RETURNS TABLE (
  payment_part_id uuid,
  card_number smallint,
  amount_cents bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  bill public.service_payments%ROWTYPE;
  total_cents bigint;
  approved_cents bigint;
  existing_count integer;
  existing_first bigint;
  existing_second bigint;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  SELECT * INTO bill
  FROM public.service_payments
  WHERE id = payment_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment not found';
  END IF;

  IF bill.payment_status <> 'pending'
     OR bill.stripe_payment_intent_id IS NOT NULL THEN
    RAISE EXCEPTION 'Payment is not eligible for split checkout';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_requests sr
    WHERE sr.id = bill.request_id
      AND sr.customer_id = bill.customer_id
      AND sr.provider_id = bill.provider_id
      AND sr.status = 'completed'
      AND sr.customer_confirmed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Completed and customer-confirmed job required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.repair_authorizations ra
    WHERE ra.request_id = bill.request_id
      AND ra.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'Pending repair authorizations must be resolved';
  END IF;

  SELECT COALESCE(
    SUM(ROUND(
      (COALESCE(ra.parts_amount, 0)
       + COALESCE(ra.labor_amount, 0)) * 100
    )), 0
  )::bigint
  INTO approved_cents
  FROM public.repair_authorizations ra
  WHERE ra.request_id = bill.request_id
    AND ra.status = 'approved';

  total_cents := ROUND(bill.authorized_amount * 100)::bigint;

  IF approved_cents <> total_cents OR total_cents <= 0 THEN
    RAISE EXCEPTION 'Approved repair total does not match payment bill';
  END IF;

  IF bill.currency <> 'usd'
     OR bill.marketplace_fee_percent <> 15.00
     OR ROUND(bill.marketplace_fee_amount * 100)::bigint
        <> ROUND(total_cents * 0.15)::bigint
     OR ROUND(bill.provider_amount * 100)::bigint
        <> total_cents - ROUND(total_cents * 0.15)::bigint THEN
    RAISE EXCEPTION 'Payment allocation is invalid';
  END IF;

  IF first_card_cents < 50
     OR total_cents - first_card_cents < 50 THEN
    RAISE EXCEPTION 'Each card must pay at least 50 cents';
  END IF;

  SELECT COUNT(*)::integer,
    MAX(spp.amount_cents) FILTER (WHERE spp.card_number = 1),
    MAX(spp.amount_cents) FILTER (WHERE spp.card_number = 2)
  INTO existing_count, existing_first, existing_second
  FROM public.service_payment_parts spp
  WHERE spp.service_payment_id = payment_id_input;

  IF existing_count > 0 THEN
    IF existing_count <> 2
       OR existing_first IS DISTINCT FROM first_card_cents
       OR existing_second IS DISTINCT FROM total_cents - first_card_cents THEN
      RAISE EXCEPTION 'Existing split payment amounts do not match';
    END IF;
  ELSE
    INSERT INTO public.service_payment_parts (
      service_payment_id, card_number, amount_cents,
      currency, payment_status
    )
    VALUES
      (payment_id_input, 1, first_card_cents, 'usd', 'pending'),
      (payment_id_input, 2, total_cents - first_card_cents, 'usd', 'pending');
  END IF;

  RETURN QUERY
  SELECT spp.id, spp.card_number, spp.amount_cents
  FROM public.service_payment_parts spp
  WHERE spp.service_payment_id = payment_id_input
  ORDER BY spp.card_number;
END;
$function$;

REVOKE ALL ON FUNCTION public.initialize_split_payment(uuid, bigint)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.initialize_split_payment(uuid, bigint)
TO service_role;

-- Restrict execution of the privileged allocation-validation function.
REVOKE ALL ON FUNCTION public.validate_service_payment_part()
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.validate_service_payment_part()
TO service_role;

-- Register each card's Stripe PaymentIntent without allowing replacement.
CREATE OR REPLACE FUNCTION public.register_split_payment_intent(
  part_id_input uuid,
  payment_intent_id_input text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  existing_intent text;
  current_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  IF payment_intent_id_input IS NULL
     OR payment_intent_id_input !~ '^pi_[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid Stripe PaymentIntent ID';
  END IF;

  -- Lock parent before payment part to avoid trigger lock-order deadlocks.
  PERFORM 1
  FROM public.service_payments
  WHERE id = (
    SELECT service_payment_id
    FROM public.service_payment_parts
    WHERE id = part_id_input
  )
  FOR UPDATE;

  SELECT stripe_payment_intent_id, payment_status
  INTO existing_intent, current_status
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Split-payment part not found';
  END IF;

  IF existing_intent = payment_intent_id_input THEN
    RETURN true;
  END IF;

  IF existing_intent IS NOT NULL OR current_status <> 'pending' THEN
    RAISE EXCEPTION 'PaymentIntent cannot be replaced';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.service_payment_parts
    WHERE id = part_id_input
      AND intent_creation_reserved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PaymentIntent creation reservation required';
  END IF;

  UPDATE public.service_payment_parts
  SET stripe_payment_intent_id = payment_intent_id_input,
      updated_at = now()
  WHERE id = part_id_input;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.register_split_payment_intent(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_split_payment_intent(uuid, text)
TO service_role;

-- Record a completed Stripe refund for a split-card payment.
CREATE OR REPLACE FUNCTION public.record_split_payment_refund(
  part_id_input uuid,
  payment_intent_id_input text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  current_part public.service_payment_parts%ROWTYPE;
  parent_transfer_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  -- Lock parent before card to prevent deadlocks.
  PERFORM 1
  FROM public.service_payments
  WHERE id = (
    SELECT service_payment_id
    FROM public.service_payment_parts
    WHERE id = part_id_input
  )
  FOR UPDATE;

  SELECT *
  INTO current_part
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Split-payment part not found';
  END IF;

  IF current_part.stripe_payment_intent_id
     IS DISTINCT FROM payment_intent_id_input THEN
    RAISE EXCEPTION 'Stripe PaymentIntent mismatch';
  END IF;

  IF current_part.payment_status = 'refunded' THEN
    RETURN true;
  END IF;

  IF current_part.payment_status <> 'succeeded' THEN
    RAISE EXCEPTION 'Only successful card payments can be refunded';
  END IF;

  SELECT transfer_status
  INTO parent_transfer_status
  FROM public.service_payments
  WHERE id = current_part.service_payment_id
  FOR UPDATE;

  IF parent_transfer_status IS NULL
     OR parent_transfer_status <> 'refund_pending' THEN
    RAISE EXCEPTION 'Cannot refund after mechanic transfer processing';
  END IF;

  UPDATE public.service_payment_parts
  SET payment_status = 'refunded',
      refunded_at = now(),
      updated_at = now()
  WHERE id = part_id_input;

  -- Preserve the refund hold; never release the mechanic transfer.
  UPDATE public.service_payments
  SET payment_status = CASE
        WHEN (
          SELECT COUNT(*)
          FROM public.service_payment_parts
          WHERE service_payment_id = current_part.service_payment_id
        ) = 2
        AND (
          SELECT COUNT(*)
          FROM public.service_payment_parts
          WHERE service_payment_id = current_part.service_payment_id
            AND payment_status = 'refunded'
        ) = 2 THEN 'refunded'
        ELSE 'partially_refunded'
      END,
      updated_at = now()
  WHERE id = current_part.service_payment_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_split_payment_refund(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_split_payment_refund(uuid, text)
TO service_role;

-- Reserve a split-payment refund before contacting Stripe.
-- Lock the parent payment first to coordinate with transfer claims.
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
      updated_at = now()
  WHERE id = parent_id;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_split_payment_refund(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_split_payment_refund(uuid)
TO service_role;

-- Allow refund reservations to block mechanic transfers.
ALTER TABLE public.service_payments
  DROP CONSTRAINT IF EXISTS service_payments_transfer_status_check;

ALTER TABLE public.service_payments
  ADD CONSTRAINT service_payments_transfer_status_check
  CHECK (transfer_status IN (
    'not_transferred',
    'processing',
    'transferred',
    'failed',
    'reversed',
    'refund_pending'
  ));

-- Atomically reserve creation of one Stripe PaymentIntent per split card.
CREATE OR REPLACE FUNCTION public.reserve_split_payment_intent_creation(
  part_id_input uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  current_part public.service_payment_parts%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  -- Lock the parent first to match payment-part trigger lock order.
  PERFORM 1
  FROM public.service_payments
  WHERE id = (
    SELECT service_payment_id
    FROM public.service_payment_parts
    WHERE id = part_id_input
  )
  FOR UPDATE;

  SELECT *
  INTO current_part
  FROM public.service_payment_parts
  WHERE id = part_id_input
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Split-payment part not found';
  END IF;

  IF current_part.stripe_payment_intent_id IS NOT NULL
     OR current_part.payment_status <> 'pending'
     OR current_part.intent_creation_reserved_at IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE public.service_payment_parts
  SET intent_creation_reserved_at = now(),
      updated_at = now()
  WHERE id = part_id_input;

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.reserve_split_payment_intent_creation(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_split_payment_intent_creation(uuid)
TO service_role;
