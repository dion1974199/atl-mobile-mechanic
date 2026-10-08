-- Prevent anonymous users from updating profiles.
REVOKE UPDATE ON public.profiles FROM anon;

-- Remove unrestricted profile updates for authenticated users.
REVOKE UPDATE ON public.profiles FROM authenticated;

-- Allow authenticated users to edit only contact information.
GRANT UPDATE (
  first_name,
  last_name,
  phone
) ON public.profiles TO authenticated;
