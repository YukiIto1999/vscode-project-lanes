'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const REPLAY_SETTLE_MS = 1_500;
const WORKSPACE_FIXTURE = 'lane-terminal-replay.code-workspace';

const isCancellation = (error) => error instanceof Error && error.message.includes('Canceled');

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

  throw new Error(`Timed out waiting for lane terminal replay state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  if (payload.phase !== 'bootstrap' && payload.phase !== 'replay') {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * live の DA1 応答だけを読み捨て、以後 `#` までにシェルへ届いた入力を記録する probe
 * @param paths - 準備完了 marker と入力記録の path
 * @returns Lane Terminal へ送る bash command
 */
const buildProbeCommand = ({ readyPath, inputPath }) => {
  const temporaryInputPath = `${inputPath}.tmp`;
  return [
    "printf '\\033[c'",
    'IFS= read -rs -n 64 -d c -t 5 _',
    `: > ${shellQuote(readyPath)}`,
    "IFS= read -rs -n 256 -d '#' -t 60 extra",
    `printf '%s' "$extra" > ${shellQuote(temporaryInputPath)}`,
    `mv ${shellQuote(temporaryInputPath)} ${shellQuote(inputPath)}`,
  ].join('; ');
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi,
  delay,
  now,
  log = (message) => console.log(message),
} = {}) => {
  const phase = readPhase(environment);
  const resolvedVscodeApi = vscodeApi ?? require('vscode');
  const pause =
    delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const workspaceFile = resolvedVscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${WORKSPACE_FIXTURE}`);
  assert.equal(path.basename(workspaceFile.fsPath), WORKSPACE_FIXTURE);

  const extension = resolvedVscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  try {
    await extension.activate();
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const waitForActiveLane = (expectedTarget) =>
    waitFor(
      () => {
        const folders = resolvedVscodeApi.workspace.workspaceFolders;
        assert.equal(folders?.length, 1, 'Expected one active workspace folder');
        assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
        assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
      },
      { delay, now },
    );

  await waitForActiveLane(laneA);
  if (phase === 'bootstrap') {
    log('E2E PASS: lane terminal replay workspace initialized');
    return;
  }

  const findLaneTerminal = () => {
    const terminals = resolvedVscodeApi.window.terminals.filter(
      (terminal) => terminal.name === 'lane-a',
    );
    assert.equal(
      terminals.length,
      1,
      `Expected one lane-a Terminal: ${JSON.stringify(
        resolvedVscodeApi.window.terminals.map((terminal) => terminal.name),
      )}`,
    );
    return terminals[0];
  };
  let originalTerminal;
  await waitFor(
    () => {
      originalTerminal = findLaneTerminal();
    },
    { delay, now },
  );

  const readyPath = path.join(laneA, 'replay-probe-ready');
  const inputPath = path.join(laneA, 'replay-probe-input');
  originalTerminal.sendText(buildProbeCommand({ readyPath, inputPath }));
  await waitFor(
    () => {
      assert.equal(
        fileSystem.existsSync(readyPath),
        true,
        'Lane Terminal probe did not consume the live DA1 response',
      );
    },
    { delay, now },
  );

  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
  await waitForActiveLane(laneB);
  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-a');
  await waitForActiveLane(laneA);

  let reattachedTerminal;
  await waitFor(
    () => {
      reattachedTerminal = findLaneTerminal();
      assert.notEqual(reattachedTerminal, originalTerminal, 'lane-a Terminal was not re-attached');
    },
    { delay, now },
  );
  await reattachedTerminal.processId;
  await pause(REPLAY_SETTLE_MS);
  reattachedTerminal.sendText('#', false);
  await waitFor(
    () => {
      assert.equal(fileSystem.existsSync(inputPath), true, 'Lane Terminal probe did not finish');
    },
    { delay, now },
  );

  const input = fileSystem.readFileSync(inputPath, 'utf8');
  assert.equal(
    input,
    '',
    `Scrollback replay sent terminal responses to the shell: ${JSON.stringify(input)}`,
  );
  log('E2E PASS: scrollback replay did not answer terminal queries again');
};

module.exports = { buildProbeCommand, run };
