import { StrongCodeError } from "../core/errors";

export interface ProviderCredentials {
  apiKey: string;
}

export function resolveProviderCredentials(providerId: string, providerConfig: { apiKeyEnv?: string | undefined }): ProviderCredentials {
  if (!providerConfig.apiKeyEnv) {
    throw new StrongCodeError("CONFIG_ERROR", `Provider ${providerId} requires apiKeyEnv`);
  }

  const apiKey = process.env[providerConfig.apiKeyEnv];
  if (!apiKey) {
    throw new StrongCodeError("MODEL_ERROR", `Missing API key env ${providerConfig.apiKeyEnv} for provider ${providerId}`);
  }

  return { apiKey };
}
