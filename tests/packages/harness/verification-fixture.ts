import dns from "node:dns/promises";
import http, { type RequestOptions, type IncomingMessage } from "node:http";
import https from "node:https";
import { Readable, Writable } from "node:stream";
import type { TestContext } from "node:test";

export type Page = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  stall?: boolean;
};

/** Install scoped DNS and HTTP fixtures that track requests, response consumption, and cancellation. */
export function webFixture(t: TestContext, pages: Page[]) {
  const requests: { url: URL; options: RequestOptions }[] = [];
  const responses: IncomingMessage[] = [];
  const chunksRead: number[] = [];
  const lookups: string[] = [];
  /** Supply a public fixture address until a test replaces the DNS resolver. */
  let resolveAddresses: (
    host: string,
  ) =>
    | { address: string; family: number }[]
    | Promise<{ address: string; family: number }[]> = () => [
    { address: "93.184.215.14", family: 4 },
  ];
  t.mock.method(dns, "lookup", async (host: string) => {
    lookups.push(host);
    return resolveAddresses(host);
  });
  /** Consume the next fixture page and construct tracked streams that honor request cancellation. */
  const request = (
    url: URL,
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    requests.push({ url, options });
    const page = pages.shift();
    if (!page) throw new Error("Unexpected fixture request");
    const index = responses.length;
    chunksRead[index] = 0;
    /** Yield response chunks while counting how many the caller actually consumes. */
    function* chunks() {
      for (const chunk of page!.chunks ?? [Buffer.from("documentation")]) {
        chunksRead[index]++;
        yield chunk;
      }
    }
    const body = page.stall
      ? new Readable({
          /** Leave the fixture stream open without producing data to exercise timeout and cancellation. */
          read() {},
        })
      : Readable.from(chunks());
    const response = Object.assign(body, {
      statusCode: page.status ?? 200,
      headers: page.headers ?? { "content-type": "text/plain; charset=utf-8" },
    }) as IncomingMessage;
    responses.push(response);
    const req = new Writable({
      /** Deliver the prepared response when the request body finishes writing. */
      final(done) {
        callback(response);
        done();
      },
    });
    /** Destroy both fixture streams when the request signal is cancelled. */
    const abort = () => {
      response.destroy(new Error("fixture cancelled"));
      req.destroy(new Error("fixture cancelled"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    response.once("close", () =>
      options.signal?.removeEventListener("abort", abort),
    );
    return req;
  };
  t.mock.method(http, "request", request);
  t.mock.method(https, "request", request);
  return {
    requests,
    responses,
    chunksRead,
    lookups,
    /** Replace the fixture DNS resolver for subsequent lookups. */
    setAddresses: (resolve: typeof resolveAddresses) => {
      resolveAddresses = resolve;
    },
  };
}
