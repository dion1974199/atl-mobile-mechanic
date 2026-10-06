CREATE TABLE public.service_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  authorized_amount numeric(10,2) NOT NULL,
  marketplace_fee_percent numeric(5,2) NOT NULL DEFAULT 15.00,
  marketplace_fee_amount numeric(10,2) NOT NULL,
  provider_amount numeric(10,2) NOT NULL,
  currency text NOT NULL DEFAULT 'usd'::text,
  payment_status text NOT NULL DEFAULT 'pending'::text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_transfer_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  stripe_transfer_group text,
  provider_transferred_at timestamp with time zone,
  transfer_status text NOT NULL DEFAULT 'not_transferred'::text,
  transfer_error text,
  paid_at timestamp with time zone,
  payment_failed_at timestamp with time zone,
  payment_error text
);

ALTER TABLE public.service_payments
  ADD CONSTRAINT service_payments_pkey PRIMARY KEY (id),
  ADD CONSTRAINT service_payments_request_id_fkey
    FOREIGN KEY (request_id) REFERENCES public.service_requests(id) ON DELETE RESTRICT,
  ADD CONSTRAINT service_payments_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD CONSTRAINT service_payments_provider_id_fkey
    FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE RESTRICT,
  ADD CONSTRAINT service_payments_request_id_key UNIQUE (request_id),
  ADD CONSTRAINT service_payments_stripe_payment_intent_id_key UNIQUE (stripe_payment_intent_id),
  ADD CONSTRAINT service_payments_authorized_amount_check
    CHECK (authorized_amount >= 0),
  ADD CONSTRAINT service_payments_marketplace_fee_amount_check
    CHECK (marketplace_fee_amount >= 0),
  ADD CONSTRAINT service_payments_marketplace_fee_percent_check
    CHECK (marketplace_fee_percent >= 0 AND marketplace_fee_percent <= 100),
  ADD CONSTRAINT service_payments_provider_amount_check
    CHECK (provider_amount >= 0),
  ADD CONSTRAINT service_payments_payment_status_check
    CHECK (payment_status = ANY (ARRAY[
      'pending'::text,
      'authorized'::text,
      'paid'::text,
      'failed'::text,
      'refunded'::text,
      'partially_refunded'::text,
      'cancelled'::text
    ])),
  ADD CONSTRAINT service_payments_transfer_status_check
    CHECK (transfer_status = ANY (ARRAY[
      'not_transferred'::text,
      'processing'::text,
      'transferred'::text,
      'failed'::text,
      'reversed'::text
    ]));

ALTER TABLE public.service_payments ENABLE ROW LEVEL SECURITY;
