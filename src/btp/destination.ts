import type pino from "pino";
import { AppError } from "../utils/errors.js";

type DestinationBinding = {
  uri: string;
  tokenServiceUrl: string;
  clientId: string;
  clientSecret: string;
};

type DestinationTokenResponse = {
  access_token?: string;
  expires_in?: number;
};

type DestinationLookupResponse = {
  authTokens?: Array<{ value?: string }>;
};

let cachedServiceToken: { token: string; expiresAt: number } | null = null;

function parseVcapServices(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const raw = env.VCAP_SERVICES;
  if (!raw) throw new AppError(500, "InternalError", "VCAP_SERVICES missing");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AppError(500, "InternalError", "VCAP_SERVICES is not valid JSON");
  }
}

function normalizeTokenUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/oauth/token") ? trimmed : `${trimmed}/oauth/token`;
}

function getDestinationBinding(env: NodeJS.ProcessEnv): DestinationBinding {
  const vcap = parseVcapServices(env) as Record<string, any>;
  const services = vcap.destination as Array<{ credentials?: Record<string, any> }> | undefined;
  if (!services || services.length === 0) {
    throw new AppError(500, "InternalError", "Destination service binding missing");
  }

  const creds = services[0]?.credentials ?? {};
  const clientId = creds.clientid ?? creds.clientId;
  const clientSecret = creds.clientsecret ?? creds.clientSecret;
  const uri = creds.uri ?? creds.url;
  const tokenBase = creds.tokenServiceURL ?? creds.tokenServiceUrl ?? creds.uaa?.url;

  const missing: string[] = [];
  if (!clientId) missing.push("clientid");
  if (!clientSecret) missing.push("clientsecret");
  if (!uri) missing.push("uri");
  if (!tokenBase) missing.push("tokenServiceURL/uaa.url");
  if (missing.length > 0) {
    throw new AppError(500, "InternalError", "Destination binding missing fields", { missing });
  }

  return {
    uri,
    tokenServiceUrl: normalizeTokenUrl(tokenBase),
    clientId,
    clientSecret
  };
}

async function getDestinationServiceToken(binding: DestinationBinding, log?: pino.Logger): Promise<string> {
  if (cachedServiceToken && cachedServiceToken.expiresAt - Date.now() > 60_000) {
    return cachedServiceToken.token;
  }

  const auth = Buffer.from(`${binding.clientId}:${binding.clientSecret}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const res = await fetch(binding.tokenServiceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${auth}`
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(502, "InternalError", "Destination token request failed", {
      status: res.status,
      body: text.slice(0, 200)
    });
  }

  const data = (await res.json()) as DestinationTokenResponse;
  if (!data.access_token) {
    throw new AppError(502, "InternalError", "Destination token response missing access_token");
  }

  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 300;
  cachedServiceToken = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  log?.debug?.({ msg: "Destination service token cached", expiresIn });
  return data.access_token;
}

function buildDestinationConfigUrl(uri: string, destinationName: string): string {
  const base = uri.replace(/\/+$/, "");
  const prefix = base.endsWith("/destination-configuration/v1") ? base : `${base}/destination-configuration/v1`;
  return `${prefix}/destinations/${encodeURIComponent(destinationName)}`;
}

export async function getDelegatedGraphToken(
  userJwt: string,
  destinationName: string,
  log?: pino.Logger
): Promise<string> {
  if (!destinationName) {
    throw new AppError(500, "InternalError", "DESTINATION_NAME missing");
  }
  const binding = getDestinationBinding(process.env);
  const serviceToken = await getDestinationServiceToken(binding, log);
  const url = buildDestinationConfigUrl(binding.uri, destinationName);

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${serviceToken}`,
      "x-user-token": userJwt,
      accept: "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AppError(502, "InternalError", "Destination lookup failed", {
      status: res.status,
      body: text.slice(0, 200)
    });
  }

  const data = (await res.json()) as DestinationLookupResponse;
  const token = data.authTokens?.[0]?.value;
  if (!token) {
    throw new AppError(500, "InternalError", "Destination authTokens missing");
  }
  return token;
}
