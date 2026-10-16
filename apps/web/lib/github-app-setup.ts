import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server.js";
import { z } from "zod";

import { convertGithubAppManifest } from "@razbor/forge-adapters";
import { publicIdSchema } from "@razbor/contracts";
import { publicId } from "@razbor/database/ids";
import { saveGithubApp } from "@razbor/database/github-apps";
import { webhookSettingsSchema } from "@razbor/database";

import {
  assertSameOrigin,
  authErrorResponse,
  requireApiUser,
  requestOrigin,
  requestSessionToken,
} from "@web/lib/auth.js";
import { managementJson } from "@web/lib/management-request.js";
import { reviewDatabase } from "@web/lib/review.js";

const cookieName = "razbor_github_manifest";

const cookiePath = "/api/github-apps/manifest";

const transactionSchema = z
  .object({
    id: publicIdSchema("githubApp"),
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expires: z.number().int(),
    origin: z.string().url(),
    webUrl: z.string().url(),
    apiUrl: z.string().url(),
    callbackBase: webhookSettingsSchema.shape.callback_base,
    contextId: publicIdSchema("context"),
  })
  .strict();

/** Resolve GitHub's cloud API or an explicitly selected Enterprise Server without changing credential origins. */
function githubLocation(value = "https://github.com") {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(url.pathname)
  )
    throw new Error("Invalid GitHub instance URL");
  const webUrl = url.href.replace(/\/$/, "");
  const cloud =
    !url.port &&
    (url.hostname === "github.com" ||
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/.test(url.hostname));
  if (cloud && url.pathname !== "/")
    throw new Error("Invalid GitHub cloud URL");
  return {
    webUrl,
    apiUrl: cloud
      ? url.hostname === "github.com"
        ? "https://api.github.com"
        : `https://api.${url.hostname}`
      : `${webUrl}/api/v3`,
  };
}

/** Bind the transaction to the initiating opaque session with a domain-separated MAC. */
function transactionMac(payload: string, session: string) {
  return createHmac("sha256", session)
    .update(`${cookieName}.${payload}`)
    .digest();
}

/** Set or consume the short-lived HTTP-only manifest transaction cookie. */
function setTransactionCookie(
  response: NextResponse,
  origin: string,
  value = "",
) {
  response.cookies.set(cookieName, value, {
    httpOnly: true,
    secure: new URL(origin).protocol === "https:",
    sameSite: "lax",
    path: cookiePath,
    maxAge: value ? 600 : 0,
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
}

/** Return a safe failure without logging provider codes, credentials or raw responses. */
export function githubAppSetupError(error: unknown) {
  return (
    authErrorResponse(error) ??
    Response.json(
      {
        error:
          "GitHub App setup is unavailable. Check the instance and callback URLs, then try again.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    )
  );
}

/** Prepare a private, user-owned App manifest; creation remains an explicit confirmation on GitHub. */
export async function startGithubAppSetup(request: Request) {
  try {
    const user = await requireApiUser(request, { resource: "repository" });
    assertSameOrigin(request);
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        organization: z
          .string()
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/)
          .optional(),
        instanceUrl: z.string().url().max(2048).optional(),
        callbackBase: webhookSettingsSchema.shape.callback_base,
      })
      .strict()
      .parse(await managementJson(request));
    const origin = requestOrigin(request);
    const session = requestSessionToken(request)!;
    const transaction = transactionSchema.parse({
      id: publicId("githubApp"),
      state: randomBytes(32).toString("base64url"),
      expires: Date.now() + 600000,
      origin,
      ...githubLocation(input.instanceUrl),
      callbackBase: input.callbackBase.replace(/\/$/, ""),
      contextId: user.context.id,
    });
    const action = new URL(
      input.organization
        ? `${transaction.webUrl}/organizations/${input.organization}/settings/apps/new`
        : `${transaction.webUrl}/settings/apps/new`,
    );
    action.searchParams.set("state", transaction.state);
    const manifest = {
      name: input.name,
      url: origin,
      public: false,
      hook_attributes: {
        url: `${transaction.callbackBase}/webhooks/github-app/${transaction.id}`,
        active: true,
      },
      redirect_url: `${origin}/api/github-apps/manifest/callback`,
      setup_url: `${origin}/repos/new?githubApp=${transaction.id}`,
      setup_on_update: true,
      default_permissions: {
        contents: "read",
        pull_requests: "write",
        issues: "write",
      },
      default_events: [
        "pull_request",
        "issue_comment",
        "pull_request_review_comment",
        "push",
      ],
    };
    const payload = Buffer.from(JSON.stringify(transaction)).toString(
      "base64url",
    );
    const response = NextResponse.json({ action: action.href, manifest });
    setTransactionCookie(
      response,
      origin,
      `${payload}.${transactionMac(payload, session).toString("base64url")}`,
    );
    return response;
  } catch (error) {
    return githubAppSetupError(error);
  }
}

/** Verify the initiating session, origin, expiry and CSRF state before exchanging the one-use manifest code. */
export async function finishGithubAppSetup(request: Request) {
  let origin: string;
  try {
    origin = requestOrigin(request);
  } catch (error) {
    return githubAppSetupError(error);
  }
  try {
    const user = await requireApiUser(request, { resource: "repository" });
    const session = requestSessionToken(request)!;
    const cookies = (request.headers.get("cookie") ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.startsWith(`${cookieName}=`));
    if (cookies.length !== 1) throw new Error("Missing manifest transaction");
    const value = cookies[0]!.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{43}$/.test(value))
      throw new Error("Invalid manifest transaction");
    const [payload, signature] = value.split(".") as [string, string];
    const supplied = Buffer.from(signature, "base64url");
    const expected = transactionMac(payload, session);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      throw new Error("Invalid manifest signature");
    const transaction = transactionSchema.parse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
    const url = new URL(request.url);
    if (
      transaction.origin !== origin ||
      transaction.contextId !== user.context.id ||
      transaction.expires <= Date.now() ||
      transaction.expires > Date.now() + 600000 ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("state") !== transaction.state ||
      url.searchParams.getAll("code").length !== 1
    )
      throw new Error("Expired manifest transaction");
    const converted = await convertGithubAppManifest(
      {
        type: "github",
        apiUrl: transaction.apiUrl,
        webUrl: transaction.webUrl,
        allowHttp: false,
      },
      url.searchParams.get("code")!,
    );
    await saveGithubApp(
      await reviewDatabase(),
      {
        publicId: transaction.id,
        externalId: converted.id,
        name: converted.name,
        slug: converted.slug,
        apiUrl: transaction.apiUrl,
        webUrl: transaction.webUrl,
        appUrl: converted.htmlUrl,
        callbackBase: transaction.callbackBase,
        privateKey: converted.privateKey,
        webhookSecret: converted.webhookSecret,
      },
      session,
      transaction.contextId,
    );
    const response = NextResponse.redirect(
      new URL(`/repos/new?githubApp=${transaction.id}`, origin),
      303,
    );
    setTransactionCookie(response, origin);
    return response;
  } catch {
    const response = NextResponse.redirect(
      new URL("/repos/new?githubAppError=1", origin),
      303,
    );
    setTransactionCookie(response, origin);
    return response;
  }
}
