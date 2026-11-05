'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const SECOND_RELATIVE_PATH = path.join('src', 'second.txt');
const SHARED_RELATIVE_PATH = path.join('src', 'shared.txt');
const WORKSPACE_FIXTURE = 'editor-snapshot-restore.code-workspace';

const isCancellation = (error) => error instanceof Error && error.message.includes('Canceled');

const waitFor = async (
  label,
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
  throw new Error(`Timed out waiting for ${label}: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);
  const phase = JSON.parse(serialized).phase;
  if (phase !== 'bootstrap' && phase !== 'switch') {
    throw new Error(`Unknown E2E phase: ${String(phase)}`);
  }
  return phase;
};

const textTabs = (vscodeApi) =>
  vscodeApi.window.tabGroups.all.flatMap((group) =>
    group.tabs
      .filter((tab) => tab.input instanceof vscodeApi.TabInputText)
      .map((tab) => ({
        path: path.resolve(tab.input.uri.fsPath),
        viewColumn: group.viewColumn,
        preview: tab.isPreview,
      })),
  );

const assertWorkspaceState = ({ fileSystem, vscodeApi, activeLink, expectedTarget }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
};

const assertRestoredTabs = ({ vscodeApi, expectedTabs }) => {
  assert.deepEqual(
    textTabs(vscodeApi),
    expectedTabs.map(({ path: tabPath }) => ({
      path: tabPath,
      viewColumn: vscodeApi.ViewColumn.One,
      preview: false,
    })),
    'Expected every saved tab to be restored pinned and in order in the first column',
  );
  for (const { path: tabPath, text } of expectedTabs) {
    const document = vscodeApi.workspace.textDocuments.find(
      (candidate) => path.resolve(candidate.uri.fsPath) === tabPath,
    );
    assert.ok(document, `Expected a document for the restored tab: ${tabPath}`);
    assert.equal(document.getText(), text, `Expected the active lane contents for ${tabPath}`);
  }
};

const switchLane = async ({ vscodeApi, laneLabel }) => {
  try {
    await vscodeApi.commands.executeCommand('projectLanes.switchLane', laneLabel);
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }
};

const openPinned = (vscodeApi, filePath) =>
  vscodeApi.commands.executeCommand('vscode.open', vscodeApi.Uri.file(filePath), {
    preview: false,
    viewColumn: vscodeApi.ViewColumn.One,
  });

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
  const waitForWorkspaceState = (expectedTarget) =>
    waitFor(
      `active link to ${path.basename(expectedTarget)}`,
      () =>
        assertWorkspaceState({
          fileSystem,
          vscodeApi: resolvedVscodeApi,
          activeLink,
          expectedTarget,
        }),
      { delay, now },
    );
  const waitForRestoredTabs = (label, expectedTabs) =>
    waitFor(label, () => assertRestoredTabs({ vscodeApi: resolvedVscodeApi, expectedTabs }), {
      delay,
      now,
    });

  await waitForWorkspaceState(laneA);
  if (phase === 'bootstrap') {
    log('E2E PASS: editor snapshot restore workspace initialized');
    return;
  }

  const laneAShared = path.join(laneA, SHARED_RELATIVE_PATH);
  const laneBShared = path.join(laneB, SHARED_RELATIVE_PATH);
  const laneASharedText = fileSystem.readFileSync(laneAShared, 'utf8');
  const laneASecondText = fileSystem.readFileSync(path.join(laneA, SECOND_RELATIVE_PATH), 'utf8');
  const laneBSharedText = fileSystem.readFileSync(laneBShared, 'utf8');
  assert.notEqual(laneASharedText, laneBSharedText);
  assert.equal(Buffer.byteLength(laneASharedText), Buffer.byteLength(laneBSharedText));
  const sharedModifiedTime = new Date(now?.() ?? Date.now());
  fileSystem.utimesSync(laneAShared, sharedModifiedTime, sharedModifiedTime);
  fileSystem.utimesSync(laneBShared, sharedModifiedTime, sharedModifiedTime);

  const linkedShared = path.join(activeLink, SHARED_RELATIVE_PATH);
  const linkedSecond = path.join(activeLink, SECOND_RELATIVE_PATH);
  const laneATabs = [
    { path: linkedShared, text: laneASharedText },
    { path: linkedSecond, text: laneASecondText },
  ];
  const laneBTabs = [{ path: linkedShared, text: laneBSharedText }];

  await openPinned(resolvedVscodeApi, linkedShared);
  await openPinned(resolvedVscodeApi, linkedSecond);
  await waitForRestoredTabs('lane-a tabs opened through the active link', laneATabs);

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-b' });
  await waitForWorkspaceState(laneB);
  await waitForRestoredTabs('lane-b without a saved snapshot', []);
  await openPinned(resolvedVscodeApi, linkedShared);
  await waitForRestoredTabs('lane-b tab opened through the active link', laneBTabs);

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-a' });
  await waitForWorkspaceState(laneA);
  await waitForRestoredTabs('lane-a snapshot restored after the first switch back', laneATabs);

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-b' });
  await waitForWorkspaceState(laneB);
  await waitForRestoredTabs('lane-b snapshot restored after the lane-a restore', laneBTabs);

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-a' });
  await waitForWorkspaceState(laneA);
  await waitForRestoredTabs('lane-a snapshot restored after the lane-b restore', laneATabs);
  log('E2E PASS: lane snapshots restored every pinned tab with the active lane contents');
};

module.exports = { readPhase, run, textTabs };
