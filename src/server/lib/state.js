const fs = require("fs");
const path = require("path");
const { ROOT } = require("./env");

const STATE_PATH = path.join(ROOT, ".blue-state.json");

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeState(next) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
}

module.exports = { readState, writeState, STATE_PATH };
