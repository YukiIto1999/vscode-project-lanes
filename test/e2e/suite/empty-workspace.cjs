'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const EXTENSION_ID = 'yukiito1999.project-lanes';
const WORKSPACE_FIXTURE = 'empty.code-workspace';

const run = async ({
  vscodeApi = require('vscode'),
  loadNodePty = () => require('node-pty'),
  log = (message) => console.log(message),
} = {}) => {
  const workspaceFile = vscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${WORKSPACE_FIXTURE}`);
  assert.equal(
    path.basename(workspaceFile.fsPath),
    WORKSPACE_FIXTURE,
    `Unexpected workspace file: ${workspaceFile.fsPath}`,
  );
  assert.equal(vscodeApi.workspace.workspaceFolders?.length, 0, 'Expected an empty workspace');

  const extension = vscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);

  await extension.activate();
  assert.equal(extension.isActive, true, `Extension did not activate: ${EXTENSION_ID}`);

  const nodePty = loadNodePty();
  assert.equal(typeof nodePty.spawn, 'function', 'node-pty native module did not load');

  log(`E2E PASS: ${EXTENSION_ID} activated`);
};

module.exports = { run };
