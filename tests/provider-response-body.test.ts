import { readBoundedResponseText } from "../src/models/response-body";

describe("bounded provider response bodies", () => {
  it("cancels a streaming completion response immediately after its byte cap", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      }
    });

    await expect(readBoundedResponseText({
      body,
      async text() {
        throw new Error("streaming response must not fall back to text()");
      }
    }, { maxBytes: 32, tooLargeMessage: "bounded completion" })).rejects.toThrow("bounded completion");

    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it("keeps text-only mocked fetch responses compatible while enforcing the cap", async () => {
    await expect(readBoundedResponseText({
      async text() {
        return "small mocked body";
      }
    }, { maxBytes: 64 })).resolves.toBe("small mocked body");

    await expect(readBoundedResponseText({
      async text() {
        return "x".repeat(65);
      }
    }, { maxBytes: 64, tooLargeMessage: "mock body too large" })).rejects.toThrow("mock body too large");
  });

  it("rejects an oversized declared body before reading it", async () => {
    let reads = 0;
    await expect(readBoundedResponseText({
      headers: { get: () => "65" },
      async text() {
        reads += 1;
        return "";
      }
    }, { maxBytes: 64, tooLargeMessage: "declared body too large" })).rejects.toThrow("declared body too large");
    expect(reads).toBe(0);
  });
});
