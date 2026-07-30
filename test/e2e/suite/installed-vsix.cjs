'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const EXTENSION_ID = 'yukiito1999.project-lanes';
const EXPECTED_EXTENSIONS_DIR_KEY = 'PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR';
const EXPECTED_VERSION_KEY = 'PROJECT_LANES_E2E_EXPECTED_VERSION';

const requiredEnvironmentValue = (environment, key) => {
  const value = environment[key];
  if (!value) throw new Error(`Missing E2E environment variable: ${key}`);
  return value;
};

const isDescendant = (parentPath, candidatePath) => {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
};

const run = async ({
  environment = process.env,
  vscodeApi = require('vscode'),
  resolveRealPath = fs.realpathSync,
  loadNodePty = (extensionPath) =>
    createRequire(path.join(extensionPath, 'package.json'))('node-pty'),
  runRipgrep = (ripgrepPath) =>
    childProcess.spawnSync(ripgrepPath, ['--version'], {
      encoding: 'utf8',
    }),
  log = (message) => console.log(message),
} = {}) => {
  const expectedExtensionsDir = resolveRealPath(
    requiredEnvironmentValue(environment, EXPECTED_EXTENSIONS_DIR_KEY),
  );
  const expectedVersion = requiredEnvironmentValue(environment, EXPECTED_VERSION_KEY);
  const extension = vscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  assert.equal(
    extension.packageJSON.version,
    expectedVersion,
    `Unexpected installed extension version: ${String(extension.packageJSON.version)}`,
  );

  const installedExtensionPath = resolveRealPath(extension.extensionPath);
  assert.equal(
    isDescendant(expectedExtensionsDir, installedExtensionPath),
    true,
    `Extension is outside the isolated extensions directory: ${installedExtensionPath}`,
  );

  await extension.activate();
  assert.equal(extension.isActive, true, `Extension did not activate: ${EXTENSION_ID}`);

  const nodePty = loadNodePty(installedExtensionPath);
  assert.equal(typeof nodePty.spawn, 'function', 'node-pty native module did not load');

  const ripgrepPath = path.join(
    installedExtensionPath,
    'node_modules',
    '@vscode',
    'ripgrep-linux-x64',
    'bin',
    'rg',
  );
  const ripgrep = runRipgrep(ripgrepPath);
  if (ripgrep.error) throw ripgrep.error;
  assert.equal(ripgrep.status, 0, `Bundled ripgrep failed: ${ripgrep.stderr || ripgrep.stdout}`);
  assert.match(ripgrep.stdout, /^ripgrep \d+\./, 'Bundled ripgrep did not report its version');

  log(`E2E PASS: installed ${EXTENSION_ID}@${expectedVersion} activated`);
};

module.exports = { run };
