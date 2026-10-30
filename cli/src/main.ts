import { readFile } from "node:fs/promises";
import { CliError, run } from "./cli";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new CliError("Expected input on stdin, but it is a terminal: pipe it in (or pass the body with --file).");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  fetch: (url, init) => fetch(url, init),
  readStdin,
  readFile: (path) =>
    readFile(path, "utf8").catch((err: Error) => {
      throw new CliError(`Could not read ${path}: ${err.message}`);
    }),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
process.exitCode = code;
