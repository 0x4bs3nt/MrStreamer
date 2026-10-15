import { providerFetch } from "@mrstreamer/core/provider";
import { outcome, perFetch, type ProofCase } from "../cases.ts";

export const cases: readonly ProofCase[] = [
  {
    name: "fetch: redirect manual",
    compare: "record",
    run: (context) =>
      perFetch(context, (fetchImpl) =>
        outcome(() => fetchImpl(`${context.fixture}/redirect`, { redirect: "manual" })),
      ),
  },
  {
    name: "fetch: providerFetch follows redirects itself",
    compare: "record",
    run: async (context) => {
      return perFetch(context, (fetchImpl) =>
        outcome(() => providerFetch(fetchImpl, ["proof-secret"])(`${context.fixture}/redirect`)),
      );
    },
  },
  {
    name: "fetch: request headers reach the provider",
    compare: "record",
    run: (context) =>
      perFetch(context, (fetchImpl) =>
        outcome(() =>
          fetchImpl(`${context.fixture}/echo`, {
            headers: { "User-Agent": "Player/1.0", Referer: "https://alpha.test/" },
          }),
        ),
      ),
  },
  {
    name: "fetch: streamed body",
    compare: "record",
    run: (context) =>
      perFetch(context, async (fetchImpl) => {
        try {
          const response = await fetchImpl(`${context.fixture}/chunks`);
          const reader = response.body?.getReader();
          if (!reader) return { streamed: false, text: await response.text() };
          const decoder = new TextDecoder();
          let reads = 0;
          let text = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            reads++;
            text += decoder.decode(value, { stream: true });
          }
          return { streamed: true, multipleReads: reads > 1, text };
        } catch (error) {
          return { error: error instanceof Error ? `${error.name}: ${error.message}` : "failed" };
        }
      }),
  },
  {
    name: "fetch: abort a held request",
    compare: "record",
    run: (context) =>
      perFetch(context, async (fetchImpl) => {
        const controller = new AbortController();
        const started = Date.now();
        setTimeout(() => controller.abort(), 300);
        const result = await outcome(() =>
          fetchImpl(`${context.fixture}/hold`, { signal: controller.signal }),
        );
        return { result, settledWithinTwoSeconds: Date.now() - started < 2_000 };
      }),
  },
];
