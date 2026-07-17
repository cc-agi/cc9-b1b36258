
REVOKE ALL ON FUNCTION public.claim_next_agent_run(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_next_agent_run(uuid, text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_agent_run(uuid, text, integer) TO service_role;
