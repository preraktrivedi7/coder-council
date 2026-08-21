import { main } from "../src/cli.js";

const target = process.argv[2];
const commands = {
  openai: ["ask", "Reply with a brief Council live-smoke confirmation.", "--no-store"],
  kimi: ["council", "Reply with a brief Kimi live-smoke confirmation.", "--challenger", "kimi", "--no-store"],
  openrouterFree: ["council", "Reply with a brief free-route live-smoke confirmation.", "--challenger", "openrouterFree", "--no-store"],
  ollama: ["council", "Reply with a brief Ollama live-smoke confirmation.", "--challenger", "ollama", "--no-store"],
  council: ["council", "Compare two safe ways to verify this smoke test.", "--no-store"],
};
if (!commands[target]) throw new Error(`Unknown live smoke target: ${target}`);
process.exitCode = await main(commands[target]);
