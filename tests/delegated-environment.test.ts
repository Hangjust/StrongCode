import { buildCodexProcessEnv, buildGcloudProcessEnv } from "../src/models/delegated-environment";

describe("delegated subprocess environment", () => {
  it("preserves operational values while stripping unrelated credentials", () => {
    const environment = buildCodexProcessEnv({
      CODEX_HOME: "/tmp/strongcode-codex",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json",
      HTTPS_PROXY: "http://proxy.example",
      LC_MESSAGES: "de_DE.UTF-8",
      OPENAI_API_KEY: "openai-secret",
      CUSTOM_TOKEN: "custom-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      STRONGCODE_AUTH_CONTENT: "auth-json",
      NODE_OPTIONS: "--require ./untrusted.js"
    }, {
      PATH: "/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      NPM_TOKEN: "npm-secret"
    });

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      LANG: "en_US.UTF-8",
      SYSTEMROOT: "C:\\Windows",
      CODEX_HOME: "/tmp/strongcode-codex",
      HTTPS_PROXY: "http://proxy.example",
      LC_MESSAGES: "de_DE.UTF-8"
    });
    expect(environment).not.toHaveProperty("OPENAI_API_KEY");
    expect(environment).not.toHaveProperty("CUSTOM_TOKEN");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("STRONGCODE_AUTH_CONTENT");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("GOOGLE_APPLICATION_CREDENTIALS");
  });

  it("keeps Google and Codex credential locations isolated from each other", () => {
    const environment = buildGcloudProcessEnv({
      CODEX_HOME: "/tmp/strongcode-codex",
      CLOUDSDK_CONFIG: "/tmp/gcloud",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json"
    }, { PATH: "/usr/bin", HOME: "/home/tester" });

    expect(environment).toMatchObject({
      CLOUDSDK_CONFIG: "/tmp/gcloud",
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/google.json"
    });
    expect(environment).not.toHaveProperty("CODEX_HOME");
  });
});
