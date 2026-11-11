/**
 * main.ts — a terminal chat over the wisdom-graph harness.
 *
 * Two ways to drive it:
 *   npm run start -w @wisdom-graph/chat                   interactive REPL on stdin
 *   … -- --script scripts/smoke.txt                       replay a file of lines as if typed
 *
 * Flags: --script <file>, --subject <id>, --client <id>. Every other knob is
 * an environment variable read by the harness (see apps/shared/src/config.ts).
 *
 * Free text is a chat turn; a line starting with `/` is a command (see
 * `HELP` in session.ts). The conversation lives on stdout, the harness logs
 * on stderr. In script mode nothing ever prompts, every line is echoed, and
 * the exit code is 1 when any command threw.
 */
import { readFileSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHarness } from "@wisdom-graph/harness";
import { HELP, Session } from "./session";

interface Flags {
  script: string | null;
  subject: string | null;
  client: string | null;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { script: null, subject: null, client: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--script" && next !== undefined) flags.script = argv[++i] ?? null;
    else if (arg === "--subject" && next !== undefined) flags.subject = argv[++i] ?? null;
    else if (arg === "--client" && next !== undefined) flags.client = argv[++i] ?? null;
    else if (arg === "--help" || arg === "-h") {
      stdout.write("usage: tsx src/main.ts [--script <file>] [--subject <id>] [--client <id>]\n\n" + HELP + "\n");
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return flags;
}

function scriptLines(file: string): string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const h = await createHarness({
    config: {
      ...(flags.subject ? { subjectId: flags.subject } : {}),
      ...(flags.client ? { clientId: flags.client } : {}),
    },
  });
  stdout.write(h.banner() + "\n");

  const rl: Interface | null = flags.script ? null : createInterface({ input: stdin, output: stdout, prompt: "you> " });
  const session = new Session(
    h,
    {
      out: (text) => stdout.write(text + "\n"),
      confirm: async (question) => {
        if (!rl) return true; // --script: never prompts; the script author asked for it
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      },
    },
    { subjectId: h.cfg.subjectId, clientId: h.cfg.clientId },
  );

  let failed = false;
  const handle = async (line: string): Promise<boolean> => {
    const text = line.trim();
    if (!text) return true;
    try {
      if (text.startsWith("/")) return await session.command(text);
      await session.ask(text);
    } catch (err) {
      failed = true;
      stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      h.logger.error({ err: err instanceof Error ? err.stack : String(err), line: text }, "chat.error");
    }
    return true;
  };

  try {
    if (flags.script) {
      for (const line of scriptLines(flags.script)) {
        stdout.write(`\n${session.subjectId}> ${line}\n`);
        if (!(await handle(line))) break;
      }
    } else if (rl) {
      stdout.write("type a message, or /help for commands\n");
      rl.on("SIGINT", () => rl.close());
      rl.prompt();
      for await (const line of rl) {
        if (!(await handle(line))) break;
        rl.prompt();
      }
      rl.close();
      stdout.write("\n");
    }
  } finally {
    await h.close();
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  },
);
