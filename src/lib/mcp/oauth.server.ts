import { createHash, randomBytes } from "node:crypto";
import { CC6 } from "./config";

// --- Discovery -----------------------------------------------------------

export interface DiscoveryMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

let discoveryCache: { at: number; value: DiscoveryMetadata } | null = null;

export async function discover(): Promise<DiscoveryMetadata> {
  if (discoveryCache && Date.now() - discoveryCache.at < 60 * 60 * 1000) {
    return discoveryCache.value;
  }
  const url = `${CC6.issuer}/.well-known/oauth-authorization-server`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OAuth discovery failed: ${res.status} ${await res.text()}`);
  }
  const value = (await res.json()) as DiscoveryMetadata;
  discoveryCache = { at: Date.now(), value };
  return value;
}

// --- Dynamic Client Registration ---------------------------------------

export interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  token_endpoint_auth_method?: string;
}

export async function registerClient(redirectUri: string): Promise<ClientRegistration> {
  const meta = await discover();
  if (!meta.registration_endpoint) {
    throw new Error("Upstream OAuth server does not support Dynamic Client Registration");
  }
  const res = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CC6.clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    throw new Error(`DCR failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as ClientRegistration;
}

// --- PKCE ---------------------------------------------------------------

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function generateState(): string {
  return base64url(randomBytes(24));
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Authorize URL ------------------------------------------------------

export async function buildAuthorizeUrl(params: {
  client: ClientRegistration;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): Promise<string> {
  const meta = await discover();
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.client.client_id);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", CC6.scope);
  return url.toString();
}

// --- Token endpoint -----------------------------------------------------

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at: number; // epoch ms
  scope?: string;
}

export async function exchangeCode(params: {
  client: ClientRegistration;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenSet> {
  const meta = await discover();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.client.client_id,
    code_verifier: params.codeVerifier,
  });
  if (params.client.client_secret) body.set("client_secret", params.client.client_secret);
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return normalizeTokenResponse(await res.json());
}

export async function refreshTokens(params: {
  client: ClientRegistration;
  refreshToken: string;
}): Promise<TokenSet> {
  const meta = await discover();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.client.client_id,
  });
  if (params.client.client_secret) body.set("client_secret", params.client.client_secret);
  const res = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  return normalizeTokenResponse(await res.json());
}

function normalizeTokenResponse(raw: unknown): TokenSet {
  const r = raw as Record<string, unknown>;
  const expiresIn = typeof r.expires_in === "number" ? r.expires_in : 3600;
  return {
    access_token: String(r.access_token),
    refresh_token: typeof r.refresh_token === "string" ? r.refresh_token : undefined,
    token_type: typeof r.token_type === "string" ? r.token_type : "Bearer",
    expires_at: Date.now() + (expiresIn - 30) * 1000,
    scope: typeof r.scope === "string" ? r.scope : undefined,
  };
}
