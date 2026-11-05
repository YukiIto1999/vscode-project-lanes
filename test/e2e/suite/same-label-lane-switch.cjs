'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const LANE_LABEL = 'app';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'same-label-lane-switch.code-workspace';
const PHASES = new Set(['prepare-second-lane', 'switch-same-label']);

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

  throw new Error(`Timed out waiting for same-label lane switch: ${lastError.message}`, {
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

const assertWorkspaceState = ({ fileSystem, vscodeApi, activeLink, expectedTarget }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(folders[0].name, LANE_LABEL);
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi,
  replaceActiveLink,
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
  const firstLane = path.join(workspaceDirectory, 'one', LANE_LABEL);
  const secondLane = path.join(workspaceDirectory, 'two', LANE_LABEL);
  const replaceLink =
    replaceActiveLink ?? ((target) => replaceLinkAtomically(fileSystem, activeLink, target));
  const waitForWorkspaceState = (expectedTarget) =>
    waitFor(
      () =>
        assertWorkspaceState({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink,
          expectedTarget,
        }),
      { delay: pause, now },
    );

  if (phase === 'prepare-second-lane') {
    await waitForWorkspaceState(firstLane);
    replaceLink(secondLane);
    assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), secondLane);
    log('E2E PASS: second same-label lane prepared behind the active link');
    return;
  }

  await waitForWorkspaceState(secondLane);
  const folderChanges = [];
  const folderListener = resolvedVscodeApi.workspace.onDidChangeWorkspaceFolders(() => {
    folderChanges.push({
      folders: (resolvedVscodeApi.workspace.workspaceFolders ?? []).map((folder) =>
        path.resolve(folder.uri.fsPath),
      ),
      target: path.resolve(fileSystem.realpathSync(activeLink)),
    });
  });
  try {
    let switchSettled = false;
    const switching = resolvedVscodeApi.commands
      .executeCommand('projectLanes.switchLane')
      .finally(() => {
        switchSettled = true;
      });
    await pause(POLL_INTERVAL_MS);
    assert.equal(switchSettled, false, 'Expected the same-label lane picker to remain open');
    for (let attempt = 0; attempt < 50 && !switchSettled; attempt += 1) {
      await resolvedVscodeApi.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      );
      await pause(POLL_INTERVAL_MS);
    }
    assert.equal(
      switchSettled,
      true,
      'Expected the same-label lane picker to accept its selection',
    );
    await switching;
    await waitForWorkspaceState(firstLane);
  } finally {
    folderListener.dispose();
  }

  assert.ok(
    folderChanges.some(
      ({ folders, target }) =>
        folders.length === 1 && folders[0] === activeLink && target === firstLane,
    ),
    `Expected a workspace folder change after retargeting to ${firstLane}: ${JSON.stringify(
      folderChanges,
    )}`,
  );
  log('E2E PASS: same-label lane switch rebuilt the active workspace folder');
};

module.exports = { run };
