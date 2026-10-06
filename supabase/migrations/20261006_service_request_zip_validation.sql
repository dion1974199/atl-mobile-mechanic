ALTER TABLE public.service_requests
ADD CONSTRAINT service_requests_service_zip_format_check
CHECK (service_zip ~ '^[0-9]{5}$') NOT VALID;
