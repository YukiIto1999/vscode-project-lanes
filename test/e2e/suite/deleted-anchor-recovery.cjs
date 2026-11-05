'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'deleted-anchor-recovery.code-workspace';
const PHASES = new Set(['bootstrap', 'delete-and-reload']);

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

  throw new Error(`Timed out waiting for deleted anchor recovery: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  if (!PHASES.has(payload.phase)) {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const assertWorkspaceState = ({
  fileSystem,
  vscodeApi,
  activeLink,
  expectedTarget,
  expectedLabel,
}) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(folders[0].name, expectedLabel);
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi,
  removeAnchorRoot,
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
  try {
    await extension.activate();
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const anchor = deriveWorkspaceAnchor(workspaceFile);
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const removeRoot =
    removeAnchorRoot ??
    (() => fileSystem.rmSync(anchor.rootDirectoryPath, { recursive: true, force: true }));
  const waitForWorkspaceState = (expectedTarget, expectedLabel) =>
    waitFor(
      () =>
        assertWorkspaceState({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink: anchor.activeLinkPath,
          expectedTarget,
          expectedLabel,
        }),
      { delay, now },
    );

  if (phase === 'bootstrap') {
    await waitForWorkspaceState(laneA, 'lane-a');
    log('E2E PASS: deleted anchor recovery workspace initialized');
    return;
  }

  await waitForWorkspaceState(laneA, 'lane-a');
  removeRoot();
  assert.equal(fileSystem.existsSync(anchor.rootDirectoryPath), false);

  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
  assert.equal(
    fileSystem.existsSync(anchor.rootDirectoryPath),
    false,
    'Expected a blocked switch to leave the deleted anchor untouched',
  );

  const reloading = resolvedVscodeApi.commands.executeCommand('projectLanes.reloadLanes');
  await waitForWorkspaceState(laneA, 'lane-a');
  await reloading;
  for (const directoryPath of [anchor.rootDirectoryPath, anchor.namespaceDirectoryPath]) {
    const stats = fileSystem.lstatSync(directoryPath);
    assert.equal(stats.isDirectory() && !stats.isSymbolicLink(), true);
  }

  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
  await waitForWorkspaceState(laneB, 'lane-b');
  log('E2E PASS: Reload Lanes recreated the deleted anchor and lane switching resumed');
};

module.exports = { run };
