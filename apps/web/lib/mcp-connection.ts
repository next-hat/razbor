import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { compileMcpToolSchema, discoverTools } from "@razbor/harness/mcp";

/**
 * Initializes an HTTP endpoint, discovers tools and validates their input schemas
 * within one deadline. Credentials stay server-side, redirects are rejected,
 * response streams share a 1 MiB budget,
 * and the temporary client always closes.
 */
export async function testMcpConnection(
  server: { endpoint: string; token?: string },
  cancellation: AbortSignal,
) {
  const cleanup = new AbortController();
  const signal = AbortSignal.any([
    cancellation,
    AbortSignal.timeout(15_000),
    cleanup.signal,
  ]);
  let responseBytes = 0;
  let terminationSignal: AbortSignal | undefined;
  const client = new Client({
    name: "razbor-connection-test",
    version: "0.1.0",
  });
  const endpoint = new URL(server.endpoint);
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new Error("Invalid MCP endpoint");

  /** Applies one byte budget across all JSON and SSE responses before SDK parsing. */
  async function boundedFetch(
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) {
    // Session cleanup gets its own short deadline even after discovery times out.
    const operationSignal =
      init?.method === "DELETE" && terminationSignal
        ? terminationSignal
        : init?.signal
          ? AbortSignal.any([signal, init.signal])
          : signal;
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: operationSignal,
    });
    if (!response.body) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        /** Rejects oversized streams and cancels their upstream response body. */
        transform(chunk, controller) {
          responseBytes += chunk.byteLength;
          if (responseBytes > 1024 * 1024)
            throw new Error("MCP response exceeds the connection test limit");
          controller.enqueue(chunk);
        },
      }),
      { signal: operationSignal },
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: server.token
        ? { Authorization: `Bearer ${server.token}` }
        : undefined,
      redirect: "error",
    },
    fetch: boundedFetch,
  });
  try {
    await client.connect(transport, { signal, timeout: 15_000 });
    const tools = await discoverTools(client, signal, 15_000);
    for (const tool of tools) compileMcpToolSchema(tool.inputSchema);
    const info = client.getServerVersion();
    return {
      server: info
        ? { name: info.name.slice(0, 256), version: info.version.slice(0, 256) }
        : undefined,
      tools: tools.map((tool) => ({
        name: tool.name.slice(0, 256),
        description: tool.description?.slice(0, 1000),
      })),
    };
  } finally {
    terminationSignal = AbortSignal.timeout(2000);
    await transport.terminateSession().catch(() => undefined);
    cleanup.abort();
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
