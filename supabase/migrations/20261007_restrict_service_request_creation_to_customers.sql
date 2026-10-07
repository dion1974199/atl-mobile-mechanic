DROP POLICY IF EXISTS "Customers can create their own service requests"
ON public.service_requests;

CREATE POLICY "Customers can create their own service requests"
ON public.service_requests
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = customer_id
  AND EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role = 'customer'
  )
);
