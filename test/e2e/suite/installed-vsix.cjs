'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');
const { VSCODE_VERSION } = require('../vscode-version.cjs');

const EXTENSION_ID = 'yukiito1999.project-lanes';
const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXPECTED_EXTENSIONS_DIR_KEY = 'PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR';
const EXPECTED_VERSION_KEY = 'PROJECT_LANES_E2E_EXPECTED_VERSION';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
const UPGRADE_WORKSPACE_FIXTURE = 'workspace-bootstrap.code-workspace';
const LEGACY_PROMPT_COMMANDS = ['notifications.focusToasts', 'notification.acceptPrimaryAction'];

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

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  if (!serialized) return 'fresh';
  const phase = JSON.parse(serialized).phase;
  if (
    phase !== 'fresh' &&
    phase !== 'baseline-create-v1' &&
    phase !== 'candidate-migrate' &&
    phase !== 'candidate-restart'
  ) {
    throw new Error(`Unknown installed VSIX E2E phase: ${String(phase)}`);
  }
  return phase;
};

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
  throw new Error(`Timed out waiting for installed VSIX workspace state: ${lastError.message}`, {
    cause: lastError,
  });
};

const isCancellation = (error) => error instanceof Error && error.message.includes('Canceled');

const activateWithLegacyRemoval = async ({
  activation,
  commands,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
}) => {
  const availableCommands = new Set(await commands.getCommands(true));
  const missingCommands = LEGACY_PROMPT_COMMANDS.filter(
    (command) => !availableCommands.has(command),
  );
  if (missingCommands.length > 0) {
    throw new Error(
      `VS Code ${VSCODE_VERSION} is missing required notification commands: ${missingCommands.join(', ')}`,
    );
  }

  let settled = false;
  const observedActivation = Promise.resolve(activation).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  const deadline = now() + POLL_TIMEOUT_MS;

  while (!settled) {
    await commands.executeCommand('notifications.focusToasts');
    await commands.executeCommand('notification.acceptPrimaryAction');
    await Promise.race([observedActivation, delay(POLL_INTERVAL_MS)]);
    if (!settled && now() > deadline) {
      throw new Error('Timed out while selecting Remove Legacy Settings');
    }
  }
  await observedActivation;
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  vscodeApi = require('vscode'),
  delay,
  now,
  resolveRealPath = fs.realpathSync,
  loadNodePty = (extensionPath) =>
    createRequire(path.join(extensionPath, 'package.json'))('node-pty'),
  runRipgrep = (ripgrepPath) =>
    childProcess.spawnSync(ripgrepPath, ['--version'], {
      encoding: 'utf8',
    }),
  respondToLegacySettings = activateWithLegacyRemoval,
  log = (message) => console.log(message),
} = {}) => {
  const phase = readPhase(environment);
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

  const activation = extension.activate();
  if (phase === 'candidate-migrate') {
    await respondToLegacySettings({
      activation,
      commands: vscodeApi.commands,
      delay,
      now,
    });
  } else {
    await activation;
  }
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

  if (phase === 'fresh') {
    log(`E2E PASS: installed ${EXTENSION_ID}@${expectedVersion} activated`);
    return;
  }

  const workspaceFile = vscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${UPGRADE_WORKSPACE_FIXTURE}`);
  assert.equal(path.basename(workspaceFile.fsPath), UPGRADE_WORKSPACE_FIXTURE);
  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const anchor = deriveWorkspaceAnchor(workspaceFile);
  const activeLink =
    phase === 'baseline-create-v1' ? anchor.legacyActiveLinkPath : anchor.activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const waitForLane = (expectedTarget) =>
    waitFor(
      () => {
        const folders = vscodeApi.workspace.workspaceFolders;
        assert.equal(folders?.length, 1, 'Expected one active workspace folder');
        assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
        assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
      },
      { delay, now },
    );
  const switchTo = async (label, expectedTarget) => {
    await vscodeApi.commands.executeCommand('projectLanes.switchLane', label);
    await waitForLane(expectedTarget);
  };

  if (phase === 'baseline-create-v1') {
    try {
      await vscodeApi.commands.executeCommand('projectLanes.initializeWorkspace');
    } catch (error) {
      if (!isCancellation(error)) throw error;
    }
    await waitForLane(laneA);
    await switchTo('lane-b', laneB);
    log(`E2E PASS: baseline ${EXTENSION_ID}@${expectedVersion} created v1 state`);
    return;
  }

  const terminalConfiguration = vscodeApi.workspace.getConfiguration('terminal.integrated');
  assert.equal(
    terminalConfiguration.inspect('defaultProfile.linux')?.workspaceValue,
    undefined,
    'Candidate retained the matching legacy default profile',
  );
  assert.equal(
    terminalConfiguration.inspect('enablePersistentSessions')?.workspaceValue,
    undefined,
    'Candidate retained the matching legacy persistence override',
  );
  await waitForLane(laneB);
  assert.equal(
    path.resolve(fileSystem.realpathSync(anchor.legacyActiveLinkPath)),
    laneB,
    'Candidate changed the legacy active link during migration',
  );
  await switchTo('lane-a', laneA);
  await switchTo('lane-b', laneB);
  assert.equal(
    path.resolve(fileSystem.realpathSync(anchor.legacyActiveLinkPath)),
    laneB,
    'Candidate changed the legacy active link after migration',
  );
  log(`E2E PASS: ${phase} preserved the legacy link and namespaced workspace state`);
};

module.exports = { activateWithLegacyRemoval, run };
