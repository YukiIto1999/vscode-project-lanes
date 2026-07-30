'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'editor-snapshot-persistence.code-workspace';

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
  throw new Error(`Timed out waiting for editor snapshot state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);
  const phase = JSON.parse(serialized).phase;
  if (phase !== 'bootstrap' && phase !== 'capture' && phase !== 'restore') {
    throw new Error(`Unknown E2E phase: ${String(phase)}`);
  }
  return phase;
};

const visibleTextTabs = (vscodeApi) =>
  vscodeApi.window.tabGroups.all.flatMap((group) =>
    group.tabs
      .filter((tab) => tab.input instanceof vscodeApi.TabInputText)
      .map((tab) => ({
        path: path.resolve(tab.input.uri.fsPath),
        viewColumn: group.viewColumn,
      })),
  );

const assertWorkspaceState = ({ fileSystem, vscodeApi, activeLink, expectedTarget }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
};

const switchLane = async ({ vscodeApi, laneLabel }) => {
  try {
    await vscodeApi.commands.executeCommand('projectLanes.switchLane', laneLabel);
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }
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
  try {
    await extension.activate();
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const firstPath = path.join(laneA, 'first.txt');
  const secondPath = path.join(laneA, 'second.txt');
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

  if (phase !== 'restore') {
    await waitForWorkspaceState(laneA);
    if (phase === 'bootstrap') {
      log('E2E PASS: editor snapshot workspace initialized');
      return;
    }

    const first = await resolvedVscodeApi.workspace.openTextDocument(firstPath);
    await resolvedVscodeApi.window.showTextDocument(first, {
      preview: false,
      viewColumn: resolvedVscodeApi.ViewColumn.One,
    });
    const second = await resolvedVscodeApi.workspace.openTextDocument(secondPath);
    await resolvedVscodeApi.window.showTextDocument(second, {
      preview: false,
      viewColumn: resolvedVscodeApi.ViewColumn.Two,
    });
    await waitFor(
      () => {
        assert.deepEqual(
          visibleTextTabs(resolvedVscodeApi)
            .filter((tab) => tab.path === firstPath || tab.path === secondPath)
            .sort((left, right) => left.path.localeCompare(right.path)),
          [
            { path: firstPath, viewColumn: resolvedVscodeApi.ViewColumn.One },
            { path: secondPath, viewColumn: resolvedVscodeApi.ViewColumn.Two },
          ],
        );
      },
      { delay, now },
    );

    await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-b' });
    await waitForWorkspaceState(laneB);
    await waitFor(
      () => {
        const paths = visibleTextTabs(resolvedVscodeApi).map((tab) => tab.path);
        assert.equal(paths.includes(firstPath), false);
        assert.equal(paths.includes(secondPath), false);
      },
      { delay, now },
    );
    log('E2E PASS: lane-a editor snapshot persisted before restart');
    return;
  }

  await waitForWorkspaceState(laneB);
  const startupPaths = visibleTextTabs(resolvedVscodeApi).map((tab) => tab.path);
  assert.equal(startupPaths.includes(firstPath), false, 'Startup must not restore inactive lane-a');
  assert.equal(
    startupPaths.includes(secondPath),
    false,
    'Startup must not restore inactive lane-a',
  );

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-a' });
  await waitForWorkspaceState(laneA);
  await waitFor(
    () => {
      const restored = visibleTextTabs(resolvedVscodeApi)
        .filter((tab) => tab.path === firstPath || tab.path === secondPath)
        .sort((left, right) => left.path.localeCompare(right.path));
      assert.deepEqual(restored, [
        { path: firstPath, viewColumn: resolvedVscodeApi.ViewColumn.One },
        { path: secondPath, viewColumn: resolvedVscodeApi.ViewColumn.Two },
      ]);
    },
    { delay, now },
  );
  log('E2E PASS: lane-a editor snapshot restored once after restart');
};

module.exports = { readPhase, run, visibleTextTabs };
