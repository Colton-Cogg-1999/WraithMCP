#!/usr/bin/env node
import { createCli } from "./cli.js";

const cli = createCli();
cli.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`wraith error: ${message}`);
  process.exit(1);
});
