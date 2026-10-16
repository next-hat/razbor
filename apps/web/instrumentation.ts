/**
 * Starts the Node-only runner broker outside production builds and retries failed
 * startup until shutdown.
 */
export async function register() {
  // Keep the Node-only broker import inside a positive runtime branch so Next
  // removes it entirely when compiling its Edge instrumentation entry.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    const { runnerBroker } = await import("@web/lib/runner-broker.js");
    // Scheduling and recovery do not require an open browser or online runner.
    /**
     * Starts or reuses the process broker, reporting startup failures without stopping
     * later retries.
     */
    const start = () => {
      void runnerBroker().catch(() =>
        console.error("Runner broker startup unavailable; will retry"),
      );
    };
    start();
    const retry = setInterval(start, 5000).unref();
    process.once("SIGTERM", () => clearInterval(retry));
    process.once("SIGINT", () => clearInterval(retry));
  }
}
