import { handleRunnerRequest } from "@web/lib/runner-request.js";

export const runtime = "nodejs";

export const dynamic = "force-dynamic";

// Fixed paths avoid Next.js development static-paths workers on every idle poll.
/** Routes heartbeats and unsupported methods through the shared runner boundary. */
async function handle(request: Request) {
  return handleRunnerRequest(request, ["heartbeat"]);
}

export const POST = handle;

export const GET = handle;

export const DELETE = handle;
