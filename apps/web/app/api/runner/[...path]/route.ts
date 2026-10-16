import { handleRunnerRequest } from "@web/lib/runner-request.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

/** Dispatches runner operations after resolving the dynamic route segments. */
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  return handleRunnerRequest(request, path);
}

export const POST = handle;

export const GET = handle;

export const DELETE = handle;
