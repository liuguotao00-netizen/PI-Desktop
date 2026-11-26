#!/usr/bin/env node

'use strict';

// Installs the `/stop-that-shit` and `/sts` composer templates that PI-Desktop
// reads from ~/.pi/agent/prompts. Re-running it only rewrites changed files.

const { installPromptTemplates } = require('../src/desktop/prompt-templates.cjs');

// One unwritable target must not hide the other template's result.
let failed = 0;
for (const entry of installPromptTemplates()) {
  if (entry.error) {
    failed += 1;
    process.stdout.write(`failed ${entry.file}: ${entry.error}\n`);
  } else if (entry.status === 'kept') {
    process.stdout.write(`kept   ${entry.file}\n`);
  } else {
    const kept = entry.backup ? ` (previous content saved as ${entry.backup})` : '';
    process.stdout.write(`wrote  ${entry.file}${kept}\n`);
  }
}
if (failed) process.exitCode = 1;
