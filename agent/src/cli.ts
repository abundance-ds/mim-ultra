import { createInterface } from "readline";
import { type CoreMessage } from "ai";
import { runAgent, systemPrompt } from "./agent.js";
import {
  recordExactPromptTokens,
  setContextRuntime,
  updateContextSnapshot,
} from "./context.js";

const messages: CoreMessage[] = [];

setContextRuntime({
  getMessages: () => messages,
  getSystemPrompt: () => systemPrompt,
});

async function send(text: string) {
  messages.push({ role: "user", content: text });

  const stats = updateContextSnapshot(messages, systemPrompt);
  const result = runAgent(messages);

  process.stdout.write("\n");
  for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
  }
  process.stdout.write("\n");

  const response = await result.response;
  for (const msg of response.messages) {
    messages.push(msg as CoreMessage);
  }

  const usage = await result.usage;
  recordExactPromptTokens(usage.promptTokens);
  const nextStats = updateContextSnapshot(messages, systemPrompt);
  process.stderr.write(
    `[${messages.length} msgs | prompt=${usage.promptTokens} out=${usage.completionTokens} ctx=${nextStats.contextTokens}]\n`
  );
}

async function oneShot(task: string) {
  await send(task);
}

async function repl() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const prompt = () =>
    new Promise<string | null>((resolve) => {
      rl.question("\n> ", resolve);
      rl.once("close", () => resolve(null));
    });

  process.stderr.write("mim agent (interactive). ctrl-c to exit.\n");

  while (true) {
    const line = await prompt();
    if (line === null) break;
    if (!line.trim()) continue;
    await send(line.trim());
  }
}

const task = process.argv.slice(2).join(" ");
if (task && task !== "--serve") {
  oneShot(task).catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (task !== "--serve") {
  repl().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
