#!/usr/bin/env node
import { main } from "../src/cli.js";
import { CouncilError, EXIT_CODES } from "../src/errors.js";
import { redactText } from "../src/security.js";

const controller = new AbortController();
let interrupts = 0;
const onInterrupt = () => {
  interrupts += 1;
  if (interrupts > 1) process.exit(EXIT_CODES.CANCELLED);
  controller.abort(new CouncilError("Cancelled by user", EXIT_CODES.CANCELLED));
};
process.on("SIGINT", onInterrupt);

main(process.argv.slice(2), { signal: controller.signal })
  .catch((error) => {
    const code = Number.isInteger(error?.exitCode) ? error.exitCode : 6;
    const message = redactText(error?.message || String(error));
    if (process.argv.slice(2).some((argument) => argument === "--json" || argument.startsWith("--json="))) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { name: error?.name || "Error", message, exitCode: code } })}\n`);
    } else process.stderr.write(`Coder Council error: ${message}\n`);
    process.exitCode = code;
  })
  .finally(() => process.off("SIGINT", onInterrupt));
