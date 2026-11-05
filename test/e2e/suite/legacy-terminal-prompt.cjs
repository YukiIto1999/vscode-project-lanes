'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'legacy-terminal-prompt.code-workspace';

const waitFor = async (
  assertion,
  {
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => Date.now(),
  },
) => {
  const deadline = now() + POLL_TIMEOUT_MS;
  let lastError;

  do {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_INTERVAL_MS);
  } while (now() <= deadline);

  throw new Error(`Timed out waiting for legacy terminal prompt state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  if (payload.phase !== 'bootstrap' && payload.phase !== 'pending-prompt') {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const isProcessAlive = (processApi, pid) => {
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  processApi = process,
  vscodeApi,
  delay,
  now,
  log = (message) => console.log(message),
} = {}) => {
  const phase = readPhase(environment);
  const resolvedVscodeApi = vscodeApi ?? require('vscode');
  const workspaceFile = resolvedVscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${WORKSPACE_FIXTURE}`);
  assert.equal(path.basename(workspaceFile.fsPath), WORKSPACE_FIXTURE);

  const extension = resolvedVscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  // 旧版設定の確認は利用者が答えるまで閉じないため、activation の完了を前提にしない
  const activation = Promise.resolve(extension.activate());
  activation.catch(() => {});

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  await waitFor(
    () => {
      const folders = resolvedVscodeApi.workspace.workspaceFolders;
      assert.equal(folders?.length, 1, 'Expected one active workspace folder');
      assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
      assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), laneA);
    },
    { delay, now },
  );
  if (phase === 'bootstrap') {
    log('E2E PASS: legacy terminal prompt workspace initialized');
    return;
  }

  const terminalConfiguration = resolvedVscodeApi.workspace.getConfiguration('terminal.integrated');
  const assertLegacyPromptPending = () => {
    assert.equal(
      terminalConfiguration.inspect('enablePersistentSessions')?.workspaceValue,
      false,
      'The legacy terminal settings prompt was answered before the scenario',
    );
  };
  assertLegacyPromptPending();

  let terminal;
  await waitFor(
    () => {
      const terminals = resolvedVscodeApi.window.terminals.filter(
        (candidate) => candidate.name === 'lane-a',
      );
      assert.equal(terminals.length, 1, 'Expected the startup lane-a Terminal');
      terminal = terminals[0];
    },
    { delay, now },
  );
  const pidPath = path.join(laneA, 'startup-shell-pid');
  const temporaryPidPath = `${pidPath}.tmp`;
  terminal.sendText(
    `printf '%s' "$$" > ${shellQuote(temporaryPidPath)} && mv ${shellQuote(temporaryPidPath)} ${shellQuote(pidPath)}`,
  );
  await waitFor(
    () => assert.equal(fileSystem.existsSync(pidPath), true, 'Startup shell PID was not written'),
    { delay, now },
  );
  const shellPid = Number(fileSystem.readFileSync(pidPath, 'utf8'));
  assert.ok(Number.isInteger(shellPid) && shellPid > 0, `Invalid startup shell PID: ${shellPid}`);
  assert.equal(isProcessAlive(processApi, shellPid), true, 'Startup shell exited early');

  terminal.dispose();
  await waitFor(
    () =>
      assert.equal(
        isProcessAlive(processApi, shellPid),
        false,
        'Closing the startup Lane Terminal left its shell running',
      ),
    { delay, now },
  );
  assertLegacyPromptPending();
  log('E2E PASS: closing Lane Terminal during the legacy prompt ended its shell');
};

module.exports = { run };
