CREATE TABLE public.repair_authorizations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL,
  provider_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  description text NOT NULL,
  parts_amount numeric NOT NULL DEFAULT 0,
  labor_amount numeric NOT NULL DEFAULT 0,
  total_amount numeric GENERATED ALWAYS AS (parts_amount + labor_amount) STORED,
  status text NOT NULL DEFAULT 'pending'::text,
  customer_response_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  responded_at timestamp with time zone,
  authorization_type text NOT NULL DEFAULT 'initial'::text,
  parent_authorization_id uuid,

  CONSTRAINT repair_authorizations_pkey PRIMARY KEY (id),
  CONSTRAINT repair_authorizations_request_id_fkey
    FOREIGN KEY (request_id) REFERENCES public.service_requests(id) ON DELETE CASCADE,
  CONSTRAINT repair_authorizations_provider_id_fkey
    FOREIGN KEY (provider_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT repair_authorizations_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT repair_authorizations_parent_authorization_id_fkey
    FOREIGN KEY (parent_authorization_id) REFERENCES public.repair_authorizations(id),
  CONSTRAINT repair_authorizations_status_check
    CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text])),
  CONSTRAINT repair_authorizations_authorization_type_check
    CHECK (authorization_type = ANY (ARRAY['initial'::text, 'change_order'::text]))
);

ALTER TABLE public.repair_authorizations OWNER TO postgres;

CREATE UNIQUE INDEX one_pending_repair_authorization_per_request
ON public.repair_authorizations USING btree (request_id)
WHERE (status = 'pending'::text);

ALTER TABLE public.repair_authorizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Assigned providers can view repair authorizations"
ON public.repair_authorizations
FOR SELECT
TO authenticated
USING (provider_id = auth.uid());

CREATE POLICY "Customers can view their repair authorizations"
ON public.repair_authorizations
FOR SELECT
TO authenticated
USING (customer_id = auth.uid());
