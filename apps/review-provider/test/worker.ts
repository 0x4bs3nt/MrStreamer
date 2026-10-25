import production, { createReviewProvider, type Env } from "../src/index.ts";
import type { Bucket } from "../src/binary.ts";
import { fixture, FIXTURE_NOW } from "./fixture.ts";

// Local test entry only. Production has no fixture clock/config header capability.
const data = fixture();
export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const f = await data;
    const now = Number(request.headers.get("X-Fixture-Clock") ?? FIXTURE_NOW);
    const config = { ...env, REVIEW_LOGIN: request.headers.get("X-Fixture-Login") ?? f.login };
    if (request.headers.has("X-Fixture-Production-Entry"))
      return production.fetch(request, config, context);
    const provider = createReviewProvider(f.media, () => now);
    if (request.headers.has("X-Fixture-No-Bucket")) {
      return provider.fetch(
        request,
        { REVIEW_LOGIN: config.REVIEW_LOGIN, PUBLIC_ORIGIN: env.PUBLIC_ORIGIN ?? "" },
        context,
      );
    }
    const fault = request.headers.get("X-Fixture-R2-Fault");
    const native = env.MEDIA;
    if (fault && native) {
      // An explicit R2 test port, not a mock of a product parser/renderer/method.
      const bucket: Bucket = {
        async head(key) {
          if (fault === "reject") throw new Error("Explicit fixture R2 read refusal");
          const result = await native.head(key);
          return fault === "missing" ? null : result;
        },
        async get(key, options) {
          const result = await native.get(key, options);
          if (!result?.body) return result;
          await result.body.cancel();
          if (fault === "slow") {
            let release = () => {};
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              pull() {
                return new Promise<void>((resolve) => {
                  release = resolve;
                });
              },
              cancel() {
                release();
              },
            });
            return { size: result.size, body };
          }
          const count = fault === "long" ? result.size + 1 : Math.max(0, result.size - 1);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              if (fault === "error")
                controller.error(new Error("Explicit synthetic source failure"));
              else {
                controller.enqueue(new Uint8Array(count));
                controller.close();
              }
            },
          });
          return { size: result.size, body };
        },
      };
      return provider.fetch(request, { ...config, MEDIA: bucket }, context);
    }
    return provider.fetch(request, config, context);
  },
};
