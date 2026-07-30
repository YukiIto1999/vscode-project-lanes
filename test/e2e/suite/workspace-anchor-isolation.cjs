'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;

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
  throw new Error(`Timed out waiting for isolated workspace anchor: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);
  const phase = JSON.parse(serialized).phase;
  if (phase !== 'alpha-initialize' && phase !== 'beta-switch' && phase !== 'alpha-reopen') {
    throw new Error(`Unknown E2E phase: ${String(phase)}`);
  }
  return phase;
};

const isCancellation = (error) => error instanceof Error && error.message.includes('Canceled');

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi = require('vscode'),
  delay,
  now,
  log = (message) => console.log(message),
} = {}) => {
  const phase = readPhase(environment);
  const workspaceFile = vscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, 'Workspace file not found');
  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const alphaWorkspace = vscodeApi.Uri.file(path.join(workspaceDirectory, 'alpha.code-workspace'));
  const betaWorkspace = vscodeApi.Uri.file(path.join(workspaceDirectory, 'beta.code-workspace'));
  const alphaAnchor = deriveWorkspaceAnchor(alphaWorkspace);
  const betaAnchor = deriveWorkspaceAnchor(betaWorkspace);
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');

  assert.match(alphaAnchor.hash, /^[0-9a-f]{64}$/);
  assert.match(betaAnchor.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(alphaAnchor.activeLinkPath, betaAnchor.activeLinkPath);
  assert.equal(alphaAnchor.rootDirectoryPath, betaAnchor.rootDirectoryPath);

  const extension = vscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  try {
    await extension.activate();
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }

  const assertLinkTarget = (anchor, expectedTarget) => {
    assert.equal(fileSystem.lstatSync(anchor.activeLinkPath).isSymbolicLink(), true);
    assert.equal(path.resolve(fileSystem.realpathSync(anchor.activeLinkPath)), expectedTarget);
  };
  const assertCurrentWorkspace = (anchor, expectedTarget) => {
    const folders = vscodeApi.workspace.workspaceFolders;
    assert.equal(folders?.length, 1);
    assert.equal(path.resolve(folders[0].uri.fsPath), anchor.activeLinkPath);
    assertLinkTarget(anchor, expectedTarget);
  };

  if (phase === 'alpha-initialize') {
    assert.equal(path.basename(workspaceFile.fsPath), 'alpha.code-workspace');
    await waitFor(() => assertCurrentWorkspace(alphaAnchor, laneA), { delay, now });
    assert.equal(fileSystem.existsSync(betaAnchor.activeLinkPath), false);
    log('E2E PASS: alpha workspace created its own anchor');
    return;
  }

  if (phase === 'beta-switch') {
    assert.equal(path.basename(workspaceFile.fsPath), 'beta.code-workspace');
    await waitFor(
      () => {
        assertCurrentWorkspace(betaAnchor, laneA);
        assertLinkTarget(alphaAnchor, laneA);
      },
      { delay, now },
    );
    try {
      await vscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
    } catch (error) {
      if (!isCancellation(error)) throw error;
    }
    await waitFor(
      () => {
        assertCurrentWorkspace(betaAnchor, laneB);
        assertLinkTarget(alphaAnchor, laneA);
      },
      { delay, now },
    );
    log('E2E PASS: beta switch left alpha anchor unchanged');
    return;
  }

  assert.equal(path.basename(workspaceFile.fsPath), 'alpha.code-workspace');
  await waitFor(
    () => {
      assertCurrentWorkspace(alphaAnchor, laneA);
      assertLinkTarget(betaAnchor, laneB);
    },
    { delay, now },
  );
  log('E2E PASS: alpha reopen restored its independent anchor');
};

module.exports = { run };
