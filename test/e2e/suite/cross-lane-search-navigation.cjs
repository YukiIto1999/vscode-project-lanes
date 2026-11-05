'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const IGNORE_ALL_FILES = '*\n';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const SHARED_RELATIVE_PATH = path.join('src', 'shared.txt');
const UNSAVED_EDIT = 'unsaved lane-a edit\n';
const WORKSPACE_FIXTURE = 'cross-lane-search-navigation.code-workspace';

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
  throw new Error(`Timed out waiting for cross-lane search state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);
  const phase = JSON.parse(serialized).phase;
  if (phase !== 'bootstrap' && phase !== 'navigate') {
    throw new Error(`Unknown E2E phase: ${String(phase)}`);
  }
  return phase;
};

const textTabPaths = (vscodeApi) =>
  vscodeApi.window.tabGroups.all.flatMap((group) =>
    group.tabs
      .filter((tab) => tab.input instanceof vscodeApi.TabInputText)
      .map((tab) => path.resolve(tab.input.uri.fsPath)),
  );

const assertWorkspaceState = ({ fileSystem, vscodeApi, activeLink, expectedTarget }) => {
  const folders = vscodeApi.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Expected one active workspace folder');
  assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
  assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
};

const assertSingleLinkedEditor = ({ vscodeApi, activeLink, linkedPath, expectedText }) => {
  assert.deepEqual(
    textTabPaths(vscodeApi),
    [linkedPath],
    'Expected exactly one text tab, addressed through the active link',
  );
  const editors = vscodeApi.window.visibleTextEditors.filter(
    (editor) => editor.document.uri.scheme === 'file',
  );
  assert.deepEqual(
    editors.map((editor) => path.resolve(editor.document.uri.fsPath)),
    [linkedPath],
  );
  const [editor] = editors;
  const folder = vscodeApi.workspace.getWorkspaceFolder(editor.document.uri);
  assert.ok(folder, 'Expected the editor to belong to the active workspace folder');
  assert.equal(path.resolve(folder.uri.fsPath), activeLink);
  if (expectedText !== undefined) assert.equal(editor.document.getText(), expectedText);
};

const switchLane = async ({ vscodeApi, laneLabel }) => {
  try {
    await vscodeApi.commands.executeCommand('projectLanes.switchLane', laneLabel);
  } catch (error) {
    if (!isCancellation(error)) throw error;
  }
};

const goToOnlyFileInLanes = async ({ vscodeApi, pause, now }) => {
  let settled = false;
  const searching = Promise.resolve(
    vscodeApi.commands.executeCommand('projectLanes.goToFileInLanes'),
  ).finally(() => {
    settled = true;
  });
  const deadline = now() + POLL_TIMEOUT_MS;
  let acceptCount = 0;
  while (!settled && now() <= deadline) {
    await pause(POLL_INTERVAL_MS);
    if (settled) break;
    await vscodeApi.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    acceptCount += 1;
  }
  assert.equal(settled, true, 'Timed out waiting for Go to File in Lanes to settle');
  await searching;
  assert.ok(acceptCount > 0, 'Expected to accept the only Go to File in Lanes result');
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi,
  delay,
  now = () => Date.now(),
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
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const linkedPath = path.join(activeLink, SHARED_RELATIVE_PATH);
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
  const waitForSingleLinkedEditor = (expectedText) =>
    waitFor(
      () =>
        assertSingleLinkedEditor({
          vscodeApi: resolvedVscodeApi,
          activeLink,
          linkedPath,
          expectedText,
        }),
      { delay, now },
    );

  await waitForWorkspaceState(laneA);
  if (phase === 'bootstrap') {
    log('E2E PASS: cross-lane search workspace initialized');
    return;
  }

  const laneAText = fileSystem.readFileSync(path.join(laneA, SHARED_RELATIVE_PATH), 'utf8');
  const laneBText = fileSystem.readFileSync(path.join(laneB, SHARED_RELATIVE_PATH), 'utf8');
  const laneAIgnore = path.join(laneA, '.ignore');
  const laneBIgnore = path.join(laneB, '.ignore');

  fileSystem.writeFileSync(laneBIgnore, IGNORE_ALL_FILES);
  await resolvedVscodeApi.commands.executeCommand(
    'vscode.open',
    resolvedVscodeApi.Uri.file(linkedPath),
    { preview: false },
  );
  const document = resolvedVscodeApi.window.activeTextEditor?.document;
  assert.ok(document, 'Expected the active-link file to open in an editor');
  assert.equal(path.resolve(document.uri.fsPath), linkedPath);
  const dirtyEdit = new resolvedVscodeApi.WorkspaceEdit();
  dirtyEdit.insert(document.uri, new resolvedVscodeApi.Position(0, 0), UNSAVED_EDIT);
  assert.equal(await resolvedVscodeApi.workspace.applyEdit(dirtyEdit), true);
  assert.equal(document.isDirty, true);

  await goToOnlyFileInLanes({ vscodeApi: resolvedVscodeApi, pause, now });
  await waitForSingleLinkedEditor(`${UNSAVED_EDIT}${laneAText}`);
  assert.equal(
    path.resolve(resolvedVscodeApi.window.activeTextEditor?.document.uri.fsPath ?? ''),
    linkedPath,
  );
  assert.equal(document.isDirty, true, 'Expected the unsaved lane-a edit to stay in its editor');
  assert.equal(await document.save(), true);

  fileSystem.rmSync(laneBIgnore);
  fileSystem.writeFileSync(laneAIgnore, IGNORE_ALL_FILES);
  await goToOnlyFileInLanes({ vscodeApi: resolvedVscodeApi, pause, now });
  await waitForWorkspaceState(laneB);
  await waitForSingleLinkedEditor(laneBText);
  assert.equal(
    path.resolve(resolvedVscodeApi.window.activeTextEditor?.document.uri.fsPath ?? ''),
    linkedPath,
  );

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-a' });
  await waitForWorkspaceState(laneA);
  await waitForSingleLinkedEditor(`${UNSAVED_EDIT}${laneAText}`);

  await switchLane({ vscodeApi: resolvedVscodeApi, laneLabel: 'lane-b' });
  await waitForWorkspaceState(laneB);
  // 直前の snapshot 復元が開いた model の残留に左右されない URI だけの検証
  await waitForSingleLinkedEditor(undefined);
  log('E2E PASS: cross-lane search reused active-link editors across lane snapshots');
};

module.exports = { readPhase, run, textTabPaths };
