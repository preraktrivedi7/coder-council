#!/usr/bin/env node
"use strict";

const args = process.argv.slice(2);
const delimiter = args.indexOf("--");
const command = delimiter >= 0 ? args[delimiter + 1] : args[0];
if (command === "ok") {
  process.stdout.write(`${JSON.stringify({ ok: true, args })}\n`);
} else if (command === "fail") {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { message: "expected failure", exitCode: 2 } })}\n`);
  process.exitCode = 2;
} else if (command === "wait") {
  process.on("SIGTERM", () => process.exit(130));
  setTimeout(() => process.stdout.write(`${JSON.stringify({ ok: true })}\n`), 30_000);
} else if (command === "large") {
  process.stdout.write(JSON.stringify({ value: "x".repeat(100_000) }));
} else {
  process.stdout.write("not-json\n");
}
