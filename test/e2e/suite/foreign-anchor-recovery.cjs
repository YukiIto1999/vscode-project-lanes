'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const PHASES = new Set(['alpha-initialize', 'copied-recover']);
const ALPHA_WORKSPACE = 'alpha.code-workspace';
const COPIED_WORKSPACE = 'copied.code-workspace';

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

  throw new Error(`Timed out waiting for foreign anchor recovery: ${lastError.message}`, {
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

const readLinkTarget = (fileSystem, linkPath) =>
  path.resolve(path.dirname(linkPath), fileSystem.readlinkSync(linkPath));

const assertWorkspaceState = ({ fileSystem, vscodeApi, activeLink, expectedTarget, label }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(folders[0].name, label);
  assert.equal(readLinkTarget(fileSystem, activeLink), expectedTarget);
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
  assert.ok(workspaceFile, 'Workspace file not found');

  const extension = resolvedVscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  try {
    await extension.activate();
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const alphaLink = deriveWorkspaceAnchor({
    fsPath: path.join(workspaceDirectory, ALPHA_WORKSPACE),
  }).activeLinkPath;
  const copiedLink = deriveWorkspaceAnchor({
    fsPath: path.join(workspaceDirectory, COPIED_WORKSPACE),
  }).activeLinkPath;
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const waitForWorkspaceState = (activeLink, expectedTarget, label) =>
    waitFor(
      () =>
        assertWorkspaceState({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink,
          expectedTarget,
          label,
        }),
      { delay, now },
    );

  if (phase === 'alpha-initialize') {
    assert.equal(path.basename(workspaceFile.fsPath), ALPHA_WORKSPACE);
    await waitForWorkspaceState(alphaLink, path.join(workspaceDirectory, 'lane-a'), 'lane-a');
    await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
    await waitForWorkspaceState(alphaLink, laneB, 'lane-b');

    const alphaFolderPath = path.relative(workspaceDirectory, alphaLink);
    assert.ok(
      fileSystem
        .readFileSync(workspaceFile.fsPath, 'utf8')
        .includes(JSON.stringify(alphaFolderPath)),
      `Expected ${ALPHA_WORKSPACE} to reference its active link`,
    );
    fileSystem.writeFileSync(
      path.join(workspaceDirectory, COPIED_WORKSPACE),
      `${JSON.stringify(
        {
          folders: [{ name: 'lane-b', path: alphaFolderPath }],
          settings: { 'projectLanes.initializationMode': 'automatic' },
        },
        null,
        2,
      )}\n`,
    );
    log('E2E PASS: alpha workspace copied with its active link folder');
    return;
  }

  assert.equal(path.basename(workspaceFile.fsPath), COPIED_WORKSPACE);
  await waitForWorkspaceState(copiedLink, laneB, 'lane-b');
  assert.equal(readLinkTarget(fileSystem, alphaLink), laneB);
  log('E2E PASS: copied workspace recovered the lane behind the foreign active link');
};

module.exports = { run };
