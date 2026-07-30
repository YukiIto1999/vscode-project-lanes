'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'missing-lane-recovery.code-workspace';
const PHASES = new Set([
  'prepare-missing-active',
  'locate-and-reconcile',
  'restart-and-switch-recovered',
]);

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  if (!PHASES.has(payload.phase)) {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

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

  throw new Error(`Timed out waiting for missing lane recovery: ${lastError.message}`, {
    cause: lastError,
  });
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
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
  assert.equal(folders[0].name, expectedLabel);
};

const resolveLinkTarget = (fileSystem, activeLink) =>
  path.resolve(path.dirname(activeLink), fileSystem.readlinkSync(activeLink));

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi,
  renameLaneDirectory,
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
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const movedLaneA = path.join(workspaceDirectory, 'lane-a-moved');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const renameDirectory =
    renameLaneDirectory ?? ((source, destination) => fileSystem.renameSync(source, destination));
  const pause =
    delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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
      { delay: pause, now },
    );

  if (phase === 'prepare-missing-active') {
    await waitForWorkspaceState(laneA, 'lane-a');
    renameDirectory(laneA, movedLaneA);

    assert.equal(fileSystem.existsSync(laneA), false, 'Expected lane-a to be absent');
    assert.equal(fileSystem.existsSync(movedLaneA), true, 'Expected moved lane-a to exist');
    assert.equal(
      fileSystem.lstatSync(activeLink).isSymbolicLink(),
      true,
      'Expected active link to remain a symlink',
    );
    assert.equal(resolveLinkTarget(fileSystem, activeLink), laneA);
    assert.equal(fileSystem.existsSync(activeLink), false, 'Expected active link to be broken');
    log('E2E PASS: active lane-a moved while its symlink remained broken');
    return;
  }

  if (phase === 'locate-and-reconcile') {
    await waitForWorkspaceState(laneB, 'lane-b');
    assert.equal(fileSystem.existsSync(movedLaneA), true, 'Expected moved lane-a to exist');
    assert.equal(fileSystem.existsSync(laneA), false, 'Expected original lane-a to be absent');

    let locateSettled = false;
    const locating = resolvedVscodeApi.commands
      .executeCommand('projectLanes.locateFolder')
      .finally(() => {
        locateSettled = true;
      });
    await pause(POLL_INTERVAL_MS);
    assert.equal(locateSettled, false, 'Expected unavailable lane picker to remain open');
    for (let attempt = 0; attempt < 50 && !locateSettled; attempt += 1) {
      await resolvedVscodeApi.commands.executeCommand(
        'workbench.action.acceptSelectedQuickOpenItem',
      );
      await pause(POLL_INTERVAL_MS);
    }
    assert.equal(locateSettled, true, 'Expected unavailable lane picker to accept its selection');
    await locating;

    await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-a');
    await waitForWorkspaceState(movedLaneA, 'lane-a');
    await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b');
    await waitForWorkspaceState(laneB, 'lane-b');
    log('E2E PASS: missing lane-a located and reconciled before restart');
    return;
  }

  await waitForWorkspaceState(laneB, 'lane-b');
  await resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-a');
  await waitForWorkspaceState(movedLaneA, 'lane-a');
  log('E2E PASS: relocated lane-a persisted and switched after restart');
};

module.exports = { run };
