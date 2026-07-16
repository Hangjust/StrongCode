import { isQuestionSurfaceMode, renderQuestionSurfaceScenario } from "./question-surface-scenarios";
import { isQuestionSurfaceVisualMode, renderQuestionSurfaceVisualScenario } from "./question-surface-visual-scenarios";
import { isQuestionSurfaceLayoutMode, renderQuestionSurfaceLayoutScenario } from "./question-surface-layout-scenarios";

const mode = process.argv[2] ?? "compact";
const render = isQuestionSurfaceVisualMode(mode)
  ? renderQuestionSurfaceVisualScenario
  : isQuestionSurfaceLayoutMode(mode)
    ? renderQuestionSurfaceLayoutScenario
    : isQuestionSurfaceMode(mode)
      ? renderQuestionSurfaceScenario
      : undefined;

if (!render) throw new Error(`unknown question surface fixture mode: ${mode}`);

void render(mode).then(result => {
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
});
