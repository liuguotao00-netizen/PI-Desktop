"use strict";

// Entry point for `node --test tests/`: pulls in every *.test.js next to it (Node 22+ loads this
// file for a directory argument). `node --test tests/*.test.js` works on every version.

const fs = require("node:fs");
const path = require("node:path");

for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js")).sort()) {
  require(path.join(__dirname, file));
}
