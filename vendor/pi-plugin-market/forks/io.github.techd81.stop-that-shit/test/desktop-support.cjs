'use strict';

// Shared fixtures for the PI-Desktop suites. Not a test file itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freshState } = require('../src/state-schema.cjs');
const { writeState } = require('../src/state.cjs');

function tempDataDir(prefix = 'sts-desktop-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sessionContext(sessionId, cwd = 'D:/work') {
  return { sessionId, cwd, hasUI: false, mode: 'desktop' };
}

function seedContract(dataDir, sessionId, contract = {}) {
  const state = freshState();
  state.contract = { ...state.contract, ...contract };
  writeState(sessionId, state, dataDir);
  return state;
}

function createFakePi() {
  const handlers = new Map();
  const commands = [];
  return {
    handlers,
    commands,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name, options) {
      commands.push({ name, ...options });
    }
  };
}

function emit(pi, eventName, payload, ctx) {
  const handler = pi.handlers.get(eventName);
  if (!handler) throw new Error(`no handler registered for ${eventName}`);
  return handler(payload, ctx);
}

module.exports = { createFakePi, emit, seedContract, sessionContext, tempDataDir };
