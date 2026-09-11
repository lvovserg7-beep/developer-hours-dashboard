import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { dashboardDir, DATA_DIR, saveSettings } from "./settings.mjs";
import { resolvedList, resolvedPromptBlock } from "./resolved.mjs";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(DATA_DIR, "cq-agent-board.json");
const PROMPT_PATH = join(agentDir, "prompt.md");

async function loadSdk() {
  try {
    return await import("@cursor/sdk");
  } catch {
    throw new Error("Нет пакета @cursor/sdk. В папке dashboard/cq-agent выполните: npm install");
  }
}

function buildPrompt(settings, digestPath) {
  const base = existsSync(PROMPT_PATH) ? readFileSync(PROMPT_PATH, "utf8") : "";
  const qs = (settings.questions || []).filter((q) => q.enabled);
  const list = qs
    .map((q, i) => `${i + 1}. ${q.text}${q.section ? ` [секция: ${q.section}]` : " [секция: customAnswers]"}`)
    .join("\n");
  const closed = resolvedPromptBlock(resolvedList(settings));
  return `${base}

## Вопросы этого прогона
${list || "(список пуст — не анализировать)"}

## Закрытые пункты
Эти темы уже решены. Не включай их в снимок и не поднимай снова, даже если формулировка чуть другая:
${closed}

Файл дайджеста чатов (JSON): ${digestPath}
Куда записать снимок доски (JSON): ${OUT_PATH}

После анализа запиши файл снимка. Не коммить. Не печатай полную переписку.
`;
}

export async function runCursorAgent(settings, digestPath) {
  const apiKey = settings.cursorApiKey || process.env.CURSOR_API_KEY || "";
  if (!apiKey) throw new Error("Нет CURSOR_API_KEY: укажите ключ в панели или в окружении");
  const enabled = (settings.questions || []).filter((q) => q.enabled);
  if (!enabled.length) throw new Error("Нет включённых вопросов анализа");

  const { Agent } = await loadSdk();
  const prompt = buildPrompt(settings, digestPath);
  const repoRoot = join(dashboardDir, "..");
  const opts = {
    apiKey,
    model: { id: "composer-2.5" },
    local: { cwd: repoRoot },
  };

  let agentId = settings.agentId || "";
  let agent;
  if (agentId) {
    try {
      agent = await Agent.resume(agentId, opts);
    } catch (err) {
      console.warn("cq-agent resume failed, creating a new agent:", err.message || err);
      agent = await Agent.create(opts);
    }
  } else {
    agent = await Agent.create(opts);
  }

  let result;
  try {
    const run = await agent.send(prompt);
    result = await run.wait();
    agentId = agent.agentId || agent.agent_id || agentId;
  } finally {
    if (agent && typeof agent[Symbol.asyncDispose] === "function") await agent[Symbol.asyncDispose]();
    else if (agent && typeof agent.close === "function") await agent.close();
  }

  if (result?.status === "error") {
    throw new Error(`Агент Cursor завершился с ошибкой (${result.id || "без id"})`);
  }

  if (agentId && agentId !== settings.agentId) {
    saveSettings({ ...settings, agentId });
    settings.agentId = agentId;
  }

  if (!existsSync(OUT_PATH)) {
    throw new Error(`Агент не записал снимок ${OUT_PATH}`);
  }
  const board = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  return { board, agentId };
}

export { OUT_PATH };
