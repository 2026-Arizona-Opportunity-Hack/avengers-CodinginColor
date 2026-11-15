BEGIN;

-- Adapted from this repository's unapplied 012_api_limits.sql; 012 is reserved for member administration.
-- Private counters contain credential hashes only, never raw credentials or donor data.
CREATE TABLE api_rate_windows (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX api_rate_windows_expiry ON api_rate_windows(window_start);
REVOKE ALL ON api_rate_windows FROM PUBLIC, cic_runtime;

-- The migration owner owns this narrow definer; runtime can only consume a counter.
CREATE FUNCTION public.cic_consume_limit(p_bucket text, p_limit integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE v_start timestamptz := date_trunc('minute', clock_timestamp()); v_hits integer;
BEGIN
  IF p_bucket IS NULL OR length(p_bucket) > 160 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 3000 THEN
    RAISE EXCEPTION 'Invalid rate limit' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.api_rate_windows WHERE window_start < v_start - interval '1 minute';
  INSERT INTO public.api_rate_windows(bucket, window_start, hits) VALUES(p_bucket, v_start, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE
    -- Saturate above the maximum valid limit; changing a limit must never lower prior usage.
    SET hits = least(public.api_rate_windows.hits + 1, 3001)
    RETURNING hits INTO v_hits;
  RETURN v_hits <= p_limit;
END $$;
REVOKE ALL ON FUNCTION public.cic_consume_limit(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cic_consume_limit(text, integer) TO cic_runtime;

COMMIT;
