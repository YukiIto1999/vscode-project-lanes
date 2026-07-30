'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'lane-switch-transaction.code-workspace';

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

  throw new Error(`Timed out waiting for lane switch state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  const phases = new Set(['bootstrap', 'transaction', 'restart']);
  if (!phases.has(payload.phase)) {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

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
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const backgroundMarker = path.join(laneA, 'background-process-alive');
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

  if (phase === 'bootstrap') {
    await waitForWorkspaceState(laneA, 'lane-a');
    log('E2E PASS: lane switch transaction workspace initialized');
    return;
  }

  if (phase === 'restart') {
    await waitForWorkspaceState(laneB, 'lane-b');
    log('E2E PASS: lane switch transaction target persisted after restart');
    return;
  }

  await waitForWorkspaceState(laneA, 'lane-a');
  await waitFor(() => assert.ok(resolvedVscodeApi.window.activeTerminal), { delay, now });
  const sourceFile = path.join(workspaceDirectory, 'dirty-source.txt');
  fileSystem.writeFileSync(sourceFile, 'source\n');
  const sourceDocument = await resolvedVscodeApi.workspace.openTextDocument(sourceFile);
  await resolvedVscodeApi.window.showTextDocument(sourceDocument, { preview: false });

  const dirtyEdit = new resolvedVscodeApi.WorkspaceEdit();
  dirtyEdit.insert(sourceDocument.uri, new resolvedVscodeApi.Position(0, 0), 'unsaved\n');
  assert.equal(await resolvedVscodeApi.workspace.applyEdit(dirtyEdit), true);
  assert.equal(sourceDocument.isDirty, true);

  let searchSettled = false;
  const searching = resolvedVscodeApi.commands
    .executeCommand('projectLanes.goToFileInLanes')
    .finally(() => {
      searchSettled = true;
    });
  await pause(POLL_INTERVAL_MS);
  assert.equal(searchSettled, false, 'Expected cross-lane file picker to remain open');
  let acceptCount = 0;
  for (let attempt = 0; attempt < 50 && !searchSettled; attempt += 1) {
    await resolvedVscodeApi.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    acceptCount += 1;
    await pause(POLL_INTERVAL_MS);
  }
  await searching;
  assert.ok(acceptCount > 0, 'Expected to accept the lane-b file result');
  await waitForWorkspaceState(laneA, 'lane-a');
  assert.equal(resolvedVscodeApi.window.activeTextEditor?.document.uri.fsPath, sourceFile);
  assert.equal(sourceDocument.isDirty, true);
  await sourceDocument.save();

  resolvedVscodeApi.window.activeTerminal.sendText(
    `sleep 1; printf alive > ${shellQuote(backgroundMarker)}`,
  );

  const observedLabels = [];
  const folderListener = resolvedVscodeApi.workspace.onDidChangeWorkspaceFolders(() => {
    observedLabels.push(resolvedVscodeApi.workspace.workspaceFolders?.[0]?.name);
  });
  try {
    await Promise.all([
      resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b'),
      resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-a'),
      resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b'),
    ]);
  } finally {
    folderListener.dispose();
  }

  await waitForWorkspaceState(laneB, 'lane-b');
  assert.deepEqual(observedLabels, ['lane-b', 'lane-a', 'lane-b']);
  await waitFor(
    () => {
      assert.equal(fileSystem.readFileSync(backgroundMarker, 'utf8'), 'alive');
    },
    { delay, now },
  );
  log('E2E PASS: lane switch requests were serialized and background shell remained alive');
};

module.exports = { run };
