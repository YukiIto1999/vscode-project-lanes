'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const WORKSPACE_FIXTURE = 'legacy-anchor-classification.code-workspace';

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

  throw new Error(`Timed out waiting for legacy anchor classification: ${lastError.message}`, {
    cause: lastError,
  });
};

const run = async ({
  fileSystem = fs,
  vscodeApi,
  delay,
  now,
  log = (message) => console.log(message),
} = {}) => {
  const resolvedVscodeApi = vscodeApi ?? require('vscode');
  const workspaceFile = resolvedVscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${WORKSPACE_FIXTURE}`);
  assert.equal(path.basename(workspaceFile.fsPath), WORKSPACE_FIXTURE);

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
  const realLane = path.join(workspaceDirectory, 'real-lane');

  await waitFor(
    () => {
      const folders = resolvedVscodeApi.workspace.workspaceFolders;
      assert.equal(folders?.length, 1, 'Expected one active workspace folder');
      assert.equal(folders[0].name, '.lanes-root');
      assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
      assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), realLane);
    },
    { delay, now },
  );

  log('E2E PASS: legacy anchor URI excluded and same-name real lane retained');
};

module.exports = { run };
