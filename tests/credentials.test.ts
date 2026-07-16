import type { ProviderAuthReader } from "../src/models/auth-store";
import { resolveProviderCredentials } from "../src/models/credentials";

function authReader(key: string): ProviderAuthReader {
  return {
    async get() {
      return { type: "api", key };
    },
    async all() {
      return { provider: { type: "api", key } };
    }
  };
}

describe("provider credential precedence", () => {
  it("prefers an explicitly connected key over a stale environment key", async () => {
    const previous = process.env.STRONGCODE_CREDENTIAL_TEST_KEY;
    process.env.STRONGCODE_CREDENTIAL_TEST_KEY = "stale-environment-key";
    try {
      await expect(resolveProviderCredentials("provider", {
        type: "openai-compatible",
        apiKeyEnv: "STRONGCODE_CREDENTIAL_TEST_KEY",
        baseUrl: "https://provider.example/v1"
      }, { authStore: authReader("connected-key") })).resolves.toEqual({
        type: "api",
        apiKey: "connected-key",
        secret: "connected-key"
      });
    } finally {
      if (previous === undefined) delete process.env.STRONGCODE_CREDENTIAL_TEST_KEY;
      else process.env.STRONGCODE_CREDENTIAL_TEST_KEY = previous;
    }
  });

  it("uses the configured environment variable when no key is connected", async () => {
    const previous = process.env.STRONGCODE_CREDENTIAL_TEST_KEY;
    process.env.STRONGCODE_CREDENTIAL_TEST_KEY = "environment-key";
    try {
      await expect(resolveProviderCredentials("provider", {
        type: "openai-compatible",
        apiKeyEnv: "STRONGCODE_CREDENTIAL_TEST_KEY",
        baseUrl: "https://provider.example/v1"
      })).resolves.toEqual({
        type: "api",
        apiKey: "environment-key",
        secret: "environment-key"
      });
    } finally {
      if (previous === undefined) delete process.env.STRONGCODE_CREDENTIAL_TEST_KEY;
      else process.env.STRONGCODE_CREDENTIAL_TEST_KEY = previous;
    }
  });
});
