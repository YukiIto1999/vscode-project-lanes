'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'active-lane-reconciliation.code-workspace';
const PHASES = new Set(['prepare-stale-cache', 'reload-and-remove-link', 'restore-missing-link']);

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

  throw new Error(`Timed out waiting for active lane reconciliation: ${lastError.message}`, {
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

const replaceLinkAtomically = (fileSystem, activeLink, target) => {
  const stagingLink = `${activeLink}.e2e-${crypto.randomUUID()}`;
  fileSystem.symlinkSync(target, stagingLink, 'dir');
  try {
    fileSystem.renameSync(stagingLink, activeLink);
  } catch (error) {
    try {
      fileSystem.unlinkSync(stagingLink);
    } catch (cleanupError) {
      if (cleanupError?.code !== 'ENOENT') {
        throw new AggregateError(
          [error, cleanupError],
          'E2E active link replacement and cleanup failed',
        );
      }
    }
    throw error;
  }
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
  replaceActiveLink,
  removeActiveLink,
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
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const laneC = path.join(workspaceDirectory, 'lane-c');
  const replaceLink =
    replaceActiveLink ?? ((target) => replaceLinkAtomically(fileSystem, activeLink, target));
  const removeLink = removeActiveLink ?? (() => fileSystem.unlinkSync(activeLink));
  const waitForWorkspaceState = (expectedTarget, expectedLabel) =>
    waitFor(
      () =>
        assertWorkspaceState({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink,
          expectedTarget,
          expectedLabel,
        }),
      { delay, now },
    );

  if (phase === 'prepare-stale-cache') {
    await waitForWorkspaceState(laneA, 'lane-a');
    replaceLink(laneB);
    assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), laneB);
    assert.equal(resolvedVscodeApi.workspace.workspaceFolders?.[0]?.name, 'lane-a');
    log('E2E PASS: stale lane-a cache prepared behind lane-b link');
    return;
  }

  if (phase === 'restore-missing-link') {
    await waitForWorkspaceState(laneC, 'lane-c');
    log('E2E PASS: missing link restored from lane-c selection cache');
    return;
  }

  await waitForWorkspaceState(laneB, 'lane-b');
  replaceLink(laneA);
  await resolvedVscodeApi.commands.executeCommand('projectLanes.reloadLanes');
  await waitForWorkspaceState(laneA, 'lane-a');

  const accepted = resolvedVscodeApi.workspace.updateWorkspaceFolders(1, 0, {
    uri: resolvedVscodeApi.Uri.file(laneC),
    name: 'lane-c',
  });
  assert.equal(accepted, true, 'Expected lane-c workspace folder addition to be accepted');
  await resolvedVscodeApi.commands.executeCommand('projectLanes.reloadLanes');
  await waitForWorkspaceState(laneA, 'lane-a');

  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-c');
  await waitForWorkspaceState(laneC, 'lane-c');
  removeLink();
  assert.equal(fileSystem.existsSync(activeLink), false, 'Expected active link to be removed');
  log('E2E PASS: Reload reconciled lane-a and absorbed lane-c before link removal');
};

module.exports = { run };
