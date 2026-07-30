'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'workspace-bootstrap.code-workspace';

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
  if (payload.phase !== 'bootstrap' && payload.phase !== 'restart') {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const assertWorkspaceState = ({ fileSystem, vscodeApi, activeLink, expectedTarget }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(
    path.resolve(folders[0].uri.fsPath),
    activeLink,
    `Expected workspace folder to use active link: ${activeLink}`,
  );
  assert.equal(
    path.resolve(fileSystem.realpathSync(activeLink)),
    expectedTarget,
    `Unexpected active link target: ${activeLink}`,
  );
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
  assert.equal(
    path.basename(workspaceFile.fsPath),
    WORKSPACE_FIXTURE,
    `Unexpected workspace file: ${workspaceFile.fsPath}`,
  );

  const extension = resolvedVscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  let activationCanceled = false;
  try {
    await extension.activate();
  } catch (error) {
    if (!isCancellation(error)) throw error;
    activationCanceled = true;
  }
  if (!activationCanceled) {
    assert.equal(extension.isActive, true, `Extension did not activate: ${EXTENSION_ID}`);
  }

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const waitForWorkspaceState = (expectedTarget) =>
    waitFor(
      () =>
        assertWorkspaceState({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink,
          expectedTarget,
        }),
      { delay, now },
    );

  await waitForWorkspaceState(laneA);
  if (phase === 'bootstrap') {
    log('E2E PASS: workspace bootstrap initialized lane-a');
    return;
  }

  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
  await waitForWorkspaceState(laneB);
  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-a');
  await waitForWorkspaceState(laneA);
  log('E2E PASS: workspace catalog restored after restart');
};

module.exports = { run };
