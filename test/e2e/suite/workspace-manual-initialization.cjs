'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'workspace-manual-initialization.code-workspace';
const INITIAL_WORKSPACE = `{
  "folders": [
    {
      "path": "lane-a",
    },
    {
      "path": "lane-b",
    },
  ],
  "settings": {
    "terminal.integrated.defaultProfile.linux": "bash",
    "terminal.integrated.enablePersistentSessions": true,
  },
}
`;

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

  throw new Error(`Timed out waiting for workspace state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  const phases = new Set(['manual-first', 'manual-restart', 'initialize', 'managed-restart']);
  if (!phases.has(payload.phase)) {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const assertTerminalWorkspaceValues = (vscodeApi, expectedProfile, expectedPersistence) => {
  const cfg = vscodeApi.workspace.getConfiguration('terminal.integrated');
  assert.equal(cfg.inspect('defaultProfile.linux')?.workspaceValue, expectedProfile);
  assert.equal(cfg.inspect('enablePersistentSessions')?.workspaceValue, expectedPersistence);
};

const assertUnmanaged = ({ fileSystem, vscodeApi, workspaceFile, workspaceDirectory }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.deepEqual(
    folders?.map((folder) => path.resolve(folder.uri.fsPath)),
    [path.join(workspaceDirectory, 'lane-a'), path.join(workspaceDirectory, 'lane-b')],
  );
  assert.equal(fileSystem.existsSync(path.join(workspaceDirectory, '.lanes-root')), false);
  assert.equal(fileSystem.readFileSync(workspaceFile, 'utf8'), INITIAL_WORKSPACE);
  assertTerminalWorkspaceValues(vscodeApi, 'bash', true);
};

const assertManaged = ({ fileSystem, vscodeApi, activeLink, expectedTarget }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
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
  const workspaceFile = resolvedVscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${WORKSPACE_FIXTURE}`);
  assert.equal(path.basename(workspaceFile.fsPath), WORKSPACE_FIXTURE);

  const extension = resolvedVscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  await extension.activate();
  assert.equal(extension.isActive, true, `Extension did not activate: ${EXTENSION_ID}`);

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');

  if (phase === 'manual-first' || phase === 'manual-restart') {
    assertUnmanaged({
      fileSystem,
      vscodeApi: resolvedVscodeApi,
      workspaceFile: workspaceFile.fsPath,
      workspaceDirectory,
    });
    log(`E2E PASS: ${phase} left the workspace unchanged`);
    return;
  }

  const waitForManaged = (expectedTarget) =>
    waitFor(
      () =>
        assertManaged({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink,
          expectedTarget,
        }),
      { delay, now },
    );

  if (phase === 'initialize') {
    assertUnmanaged({
      fileSystem,
      vscodeApi: resolvedVscodeApi,
      workspaceFile: workspaceFile.fsPath,
      workspaceDirectory,
    });
    try {
      await resolvedVscodeApi.commands.executeCommand('projectLanes.initializeWorkspace');
    } catch (error) {
      if (!isCancellation(error)) throw error;
    }
    await waitForManaged(laneA);
    log('E2E PASS: initialize command created the managed workspace');
    return;
  }

  await waitForManaged(laneA);
  assertTerminalWorkspaceValues(resolvedVscodeApi, 'Lane Terminal', false);
  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
  await waitForManaged(laneB);
  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-a');
  await waitForManaged(laneA);
  log('E2E PASS: manual initialization catalog restored after restart');
};

module.exports = { run };
