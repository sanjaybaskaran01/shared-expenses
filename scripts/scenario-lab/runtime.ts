import { createServer } from "node:net";
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedScenarioAuthUsers, seedScenarioDatabase } from "./sandbox";

interface LoggedProcess {
  process: ReturnType<typeof Bun.spawn>;
  logs: Promise<void>[];
}

export interface ScenarioRuntime {
  apiUrl: string;
  webUrl: string;
  databasePath: string;
  attachmentsPath: string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local scenario port"));
        return;
      }
      const { port } = address;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function pipeToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<void> {
  const writer = Bun.file(path).writer();
  try {
    const reader = stream.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      writer.write(next.value);
    }
  } finally {
    await writer.end();
  }
}

function spawnLogged(
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined>; outputDirectory: string; name: string },
): LoggedProcess {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    process,
    logs: [
      pipeToFile(process.stdout, join(options.outputDirectory, `${options.name}.log`)),
      pipeToFile(process.stderr, join(options.outputDirectory, `${options.name}.error.log`)),
    ],
  };
}

async function waitForHttp(url: string, process: LoggedProcess, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exited = await Promise.race([
      process.process.exited.then((code) => ({ exited: true as const, code })),
      Bun.sleep(1).then(() => ({ exited: false as const })),
    ]);
    if (exited.exited) throw new Error(`${label} exited before becoming ready (code ${exited.code})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (response.ok) return;
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(150);
  }
  throw new Error(`${label} did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function stopProcess(process: LoggedProcess): Promise<void> {
  if (process.process.exitCode === null) process.process.kill("SIGTERM");
  const stopped = await Promise.race([
    process.process.exited.then(() => true),
    Bun.sleep(3_000).then(() => false),
  ]);
  if (!stopped && process.process.exitCode === null) process.process.kill("SIGKILL");
  await process.process.exited.catch(() => undefined);
  await Promise.allSettled(process.logs);
}

async function buildScenarioServer(
  bun: string,
  repositoryRoot: string,
  outputDirectory: string,
): Promise<string> {
  const runtimeDirectory = join(outputDirectory, "sandbox-server");
  const serverDirectory = join(runtimeDirectory, "server");
  const migrationsDirectory = join(runtimeDirectory, "migrations");
  const serverEntry = join(serverDirectory, "index.js");
  await Promise.all([
    mkdir(serverDirectory, { recursive: true, mode: 0o700 }),
    cp(join(repositoryRoot, "apps/server/migrations"), migrationsDirectory, { recursive: true }),
  ]);
  const build = Bun.spawn([
    bun,
    "build",
    join(repositoryRoot, "apps/server/src/index.ts"),
    "--outfile",
    serverEntry,
    "--target",
    "bun",
  ], {
    cwd: repositoryRoot,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not bundle the scenario API:\n${stderr || stdout}`);
  }
  return serverEntry;
}

export async function startScenarioRuntime(repositoryRoot: string, outputDirectory: string): Promise<ScenarioRuntime> {
  const root = resolve(repositoryRoot);
  const output = resolve(outputDirectory);
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  const databasePath = join(output, "sandbox.sqlite");
  const attachmentsPath = join(output, "attachments");
  await mkdir(output, { recursive: true, mode: 0o700 });
  await mkdir(attachmentsPath, { recursive: true, mode: 0o700 });
  await seedScenarioDatabase({ databasePath });

  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun is required for the scenario sandbox");
  const serverEntry = await buildScenarioServer(bun, root, output);
  const server = spawnLogged([bun, serverEntry], {
    cwd: root,
    outputDirectory: output,
    name: "api",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEV_AUTH_BYPASS: "true",
      BETTER_AUTH_SECRET: "scenario-lab-development-secret",
      HOST: "127.0.0.1",
      PORT: String(apiPort),
      DATABASE_PATH: databasePath,
      ATTACHMENTS_PATH: attachmentsPath,
      WEB_ORIGIN: webUrl,
      PUBLIC_API_URL: apiUrl,
      SMTP_USER: "scenario",
      SMTP_APP_PASSWORD: "scenario",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: "9",
      SMTP_SECURE: "false",
      SMTP_FROM: "Tallied Scenario <scenario@example.com>",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    },
  });

  let web: LoggedProcess | undefined;
  try {
    await waitForHttp(`${apiUrl}/health`, server, "Scenario API");
    seedScenarioAuthUsers(databasePath);
    web = spawnLogged([bun, "run", "dev", "--", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
      cwd: join(root, "apps/web"),
      outputDirectory: output,
      name: "web",
      env: { ...process.env, VITE_API_URL: apiUrl },
    });
    await waitForHttp(webUrl, web, "Scenario web app");
  } catch (error) {
    if (web) await stopProcess(web);
    await stopProcess(server);
    throw error;
  }

  return {
    apiUrl,
    webUrl,
    databasePath,
    attachmentsPath,
    async stop() {
      await Promise.all([stopProcess(web!), stopProcess(server)]);
    },
  };
}
