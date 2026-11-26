import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const repoRoot = resolve(join(dashboardDir, ".."));
const TAG_RE = /^v\d+\.\d+\.\d+$/;
const GIT_TIMEOUT_MS = 120_000;

let updateRunning = false;

function git(args, { timeout = GIT_TIMEOUT_MS } = {}) {
  const safeDir = repoRoot.replace(/\\/g, "/");
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["-c", `safe.directory=${safeDir}`, ...args],
      {
        cwd: repoRoot,
        timeout,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const out = String(stdout || "").trim();
        const errText = String(stderr || "").trim();
        if (err) {
          const e = new Error(errText || out || err.message);
          e.stdout = out;
          e.stderr = errText;
          reject(e);
          return;
        }
        resolvePromise({ stdout: out, stderr: errText });
      }
    );
  });
}

function readStableFile() {
  try {
    const raw = readFileSync(join(repoRoot, "STABLE"), "utf8");
    return raw.replace(/^\uFEFF/, "").trim().split(/\r?\n/)[0].trim();
  } catch {
    return "";
  }
}

/** Как процесс поднимается снова после выхода. */
export function restartMode() {
  if (process.env.pm_id != null || process.env.PM2_HOME != null) return "pm2";
  if (process.env.INVOCATION_ID) return "systemd";
  if (process.env.DASHBOARD_SUPERVISED === "1") return "loop";
  return "manual";
}

export function restartProcessSoon(delayMs = 1500) {
  const mode = restartMode();
  if (mode === "manual") return mode;
  setTimeout(() => process.exit(0), delayMs).unref?.();
  return mode;
}

async function tagExists(tag) {
  try {
    await git(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function fetchRemote() {
  await git(["fetch", "--tags", "--force", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
}

async function currentTag() {
  try {
    const { stdout } = await git(["describe", "--tags", "--exact-match", "HEAD"]);
    return stdout;
  } catch {
    try {
      const { stdout } = await git(["describe", "--tags", "--always", "HEAD"]);
      return stdout;
    } catch {
      return "";
    }
  }
}

async function isDetachedHead() {
  try {
    await git(["symbolic-ref", "-q", "HEAD"]);
    return false;
  } catch {
    return true;
  }
}

async function listStableTags(limit = 15) {
  const { stdout } = await git(["tag", "--list", "v*", "--sort=-v:refname"]);
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((t) => TAG_RE.test(t))
    .slice(0, limit);
}

async function resolveLatestStable() {
  try {
    const { stdout } = await git(["show", "origin/main:STABLE"]);
    const tag = stdout.replace(/^\uFEFF/, "").split(/\r?\n/)[0].trim();
    if (TAG_RE.test(tag) && (await tagExists(tag))) return tag;
  } catch {
    /* ниже запасной вариант */
  }
  const tags = await listStableTags(1);
  return tags[0] || "";
}

/**
 * @param {{ fetch?: boolean }} opts
 */
export async function getUpdateStatus(opts = {}) {
  const base = {
    appVersion: readStableFile(),
    restartMode: restartMode(),
    running: updateRunning,
    isGitClone: existsSync(join(repoRoot, ".git")),
    detached: false,
    current: "",
    latest: "",
    tags: [],
    updateAvailable: false,
    canUpdate: false,
    warning: "",
  };

  if (!base.isGitClone) {
    base.warning = "Папка не является git-клоном. Один раз выполните git clone из руководства (README).";
    return base;
  }

  try {
    base.detached = await isDetachedHead();
    base.current = await currentTag();
    if (opts.fetch) await fetchRemote();
    base.tags = await listStableTags();
    base.latest = await resolveLatestStable();
  } catch (err) {
    base.warning = String(err.message || err);
  }

  if (!base.detached) {
    base.warning =
      base.warning ||
      "Рабочая копия на ветке, а не на стабильном теге. Кнопка включена только на боевом клоне (detached HEAD на теге).";
  }

  base.updateAvailable = Boolean(base.latest && base.current && base.latest !== base.current);
  base.canUpdate = base.isGitClone && base.detached && !updateRunning;
  return base;
}

/**
 * @param {{ tag?: string }} opts
 */
export async function runSelfUpdate(opts = {}) {
  if (updateRunning) throw new Error("Обновление уже выполняется");
  updateRunning = true;
  const log = [];
  try {
    if (!existsSync(join(repoRoot, ".git"))) {
      throw new Error("Папка не является git-клоном. Один раз выполните git clone из руководства (README).");
    }
    if (!(await isDetachedHead())) {
      throw new Error(
        "Рабочая копия на ветке (не боевой клон на теге). Обновление по кнопке отключено, чтобы не затереть разработку."
      );
    }

    const before = await currentTag();
    log.push(`Сейчас: ${before || "неизвестно"}`);
    log.push("git fetch --tags origin …");
    await fetchRemote();

    let target = String(opts.tag || "").trim();
    if (!target) target = await resolveLatestStable();
    if (!TAG_RE.test(target)) throw new Error("Неверный тег. Ожидается вид v2.17.0");
    if (!(await tagExists(target))) throw new Error(`Тег ${target} не найден в репозитории`);

    if (before === target) {
      log.push(`Уже на ${target}. Перезапуск не нужен.`);
      return { ok: true, changed: false, from: before, to: target, log, restart: "none" };
    }

    log.push(`git checkout --force ${target} …`);
    await git(["checkout", "--force", target]);
    const after = await currentTag();
    if (after !== target) throw new Error(`После checkout тег ${after || "?"}, ожидали ${target}`);
    log.push(`Готово: ${after}. dashboard/.env и users.json не менялись.`);

    return {
      ok: true,
      changed: true,
      from: before,
      to: after,
      log,
      restart: restartMode(),
    };
  } finally {
    updateRunning = false;
  }
}
