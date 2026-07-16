import { StrongCodeError } from "../../core/errors";
import type { ProviderAuthReader } from "../../models/auth-store";
import { QuestionBroker } from "../../questions/broker";
import { DeepSeekQuestionSimplifier } from "../../questions/simplifier";
import type { RuntimeContext } from "../../runtime/context";
import { createQuestionTool } from "../../tools/builtin/question";
import type { ToolRegistry } from "../../tools/registry";

export class QuestionRuntimeRegistrationError extends StrongCodeError {
  readonly name = "QuestionRuntimeRegistrationError";

  constructor() {
    super("CONFIG_ERROR", "The OpenTUI question runtime is already installed");
  }
}

export interface QuestionRuntimeOptions {
  readonly context: RuntimeContext;
  readonly authStore: ProviderAuthReader;
  readonly allowEnvironmentCredentials: boolean;
}

export interface QuestionRuntime {
  readonly broker: QuestionBroker;
  readonly simplifier?: DeepSeekQuestionSimplifier;
}

export function installQuestionRuntime(registry: ToolRegistry, options: QuestionRuntimeOptions): QuestionRuntime {
  if (registry.get("question")) throw new QuestionRuntimeRegistrationError();

  const broker = new QuestionBroker();
  const providerConfig = options.context.config.providers.deepseek;
  const simplifier = providerConfig === undefined
    ? undefined
    : new DeepSeekQuestionSimplifier({
        providerId: "deepseek",
        providerConfig,
        authStore: options.authStore,
        allowEnvironmentCredentials: options.allowEnvironmentCredentials
      });
  registry.register(createQuestionTool(broker));
  registry.addCloser(async () => { broker.close(); });
  return simplifier === undefined ? { broker } : { broker, simplifier };
}
