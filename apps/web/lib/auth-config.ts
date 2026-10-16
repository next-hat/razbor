import { readFile } from "node:fs/promises";

import { parse } from "smol-toml";
import { z } from "zod";

const secretReferenceSchema = z.union([
  z.object({ env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }).strict(),
  z.object({ file: z.string().startsWith("/") }).strict(),
]);

const roleSchema = z
  .enum(["super_admin", "admin", "user"])
  .transform((role) => (role === "admin" ? ("super_admin" as const) : role));

const oidcSchema = z
  .object({
    enabled: z.boolean().default(false),
    issuer: z.string().url(),
    client_id: z.string().min(1).max(256),
    client_secret: secretReferenceSchema.optional(),
    transaction_secret: secretReferenceSchema,
    redirect_uri: z.string().url(),
    scopes: z
      .array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/))
      .min(1)
      .default(["openid", "profile", "email", "groups"]),
    client_authentication: z
      .enum(["client_secret_basic", "client_secret_post", "none"])
      .optional(),
    allow_http: z.boolean().default(false),
    groups_claim: z
      .string()
      .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
      .default("groups"),
    default_role: roleSchema.default("user"),
    group_roles: z.record(z.string().min(1), roleSchema).default({}),
    auto_redirect: z.boolean().default(true),
  })
  .strict();

const configurationSchema = z
  .object({
    authentication: z
      .object({
        local_enabled: z.boolean().default(true),
        oidc: oidcSchema.optional(),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type OidcConfiguration = Omit<
  z.infer<typeof oidcSchema>,
  "client_secret" | "transaction_secret" | "client_authentication"
> & {
  client_secret?: string;
  transaction_secret: string;
  client_authentication: "client_secret_basic" | "client_secret_post" | "none";
};

export type AuthenticationConfiguration = {
  local_enabled: boolean;
  oidc?: OidcConfiguration;
};

let configuration: Promise<AuthenticationConfiguration> | undefined;

/** Resolve a private file or environment reference without including its value in errors. */
async function readCredential(
  reference: z.infer<typeof secretReferenceSchema>,
) {
  const value =
    "env" in reference
      ? process.env[reference.env]
      : (await readFile(reference.file, "utf8")).trimEnd();
  if (!value || value.length > 8192 || /[\r\n\0]/.test(value))
    throw new Error("Missing or invalid authentication credential.");
  return value;
}

/** Validate complete endpoint URLs, allowing HTTP callbacks only on loopback hosts. */
function validateEndpoint(
  value: string,
  allowHttp: boolean,
  callback: boolean,
) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (callback && url.pathname !== "/api/auth/oidc/callback") ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && (callback ? loopback : allowHttp)))
  )
    throw new Error("Invalid authentication endpoint.");
}

/** Read process-level authentication settings; explicit invalid configuration fails closed. */
async function loadAuthenticationConfiguration(): Promise<AuthenticationConfiguration> {
  try {
    const file = process.env.RAZBOR_CONFIG_FILE;
    const input = file ? parse(await readFile(file, "utf8")) : {};
    const { authentication } = configurationSchema.parse(input);
    const oidc = authentication.oidc;
    if (!oidc?.enabled) {
      if (!authentication.local_enabled)
        throw new Error("No authentication method enabled.");
      return { local_enabled: authentication.local_enabled };
    }
    validateEndpoint(oidc.issuer, oidc.allow_http, false);
    validateEndpoint(oidc.redirect_uri, false, true);
    if (!oidc.scopes.includes("openid"))
      throw new Error("OpenID scope required.");
    const client_secret = oidc.client_secret
      ? await readCredential(oidc.client_secret)
      : undefined;
    const transaction_secret = await readCredential(oidc.transaction_secret);
    if (Buffer.byteLength(transaction_secret, "utf8") < 32)
      throw new Error("Transaction secret too short.");
    const client_authentication =
      oidc.client_authentication ??
      (client_secret ? "client_secret_basic" : "none");
    if ((client_authentication === "none") !== !client_secret)
      throw new Error("Client authentication and credential disagree.");
    return {
      local_enabled: authentication.local_enabled,
      oidc: {
        ...oidc,
        client_secret,
        transaction_secret,
        client_authentication,
      },
    };
  } catch {
    throw new Error("Authentication configuration is unavailable or invalid.");
  }
}

/** Reuse validated server-only configuration until restart, retrying failed reads. */
export function authenticationConfig(): Promise<AuthenticationConfiguration> {
  configuration ??= loadAuthenticationConfiguration().catch(
    (error: unknown) => {
      configuration = undefined;
      throw error;
    },
  );
  return configuration;
}
