'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../../package.json');
const {
  assertListedExtensionVersion,
  buildDownloadOptions,
  buildExtensionManagementRequest,
  buildInstalledLaunchOptions,
  buildLaunchOptions,
  createProcessCleanupRegistry,
  executeExtensionManagementRequest,
  installAndVerifyExtension,
  launchVSCodeProcess,
  runInstalledVSIXVerification,
  runScenario,
} = require('./runner.cjs');
const { resolveScenarios, scenarios } = require('./scenarios.cjs');

const workspaceBootstrapScenario = {
  name: 'workspace-bootstrap',
  fixtureRoot: path.join(__dirname, 'fixtures', 'workspace-bootstrap'),
  workspaceFixture: path.join(
    __dirname,
    'fixtures',
    'workspace-bootstrap',
    'workspace-bootstrap.code-workspace',
  ),
  suitePath: path.join(__dirname, 'suite', 'workspace-bootstrap.cjs'),
  launches: [{ phase: 'bootstrap' }, { phase: 'restart' }],
};
const workspaceManualInitializationScenario = {
  name: 'workspace-manual-initialization',
  fixtureRoot: path.join(__dirname, 'fixtures', 'workspace-manual-initialization'),
  workspaceFixture: path.join(
    __dirname,
    'fixtures',
    'workspace-manual-initialization',
    'workspace-manual-initialization.code-workspace',
  ),
  suitePath: path.join(__dirname, 'suite', 'workspace-manual-initialization.cjs'),
  launches: [
    { phase: 'manual-first' },
    { phase: 'manual-restart' },
    { phase: 'initialize' },
    { phase: 'managed-restart' },
  ],
};
const laneSwitchTransactionScenario = {
  name: 'lane-switch-transaction',
  fixtureRoot: path.join(__dirname, 'fixtures', 'lane-switch-transaction'),
  workspaceFixture: path.join(
    __dirname,
    'fixtures',
    'lane-switch-transaction',
    'lane-switch-transaction.code-workspace',
  ),
  suitePath: path.join(__dirname, 'suite', 'lane-switch-transaction.cjs'),
  launches: [{ phase: 'bootstrap' }, { phase: 'transaction' }, { phase: 'restart' }],
};
const activeLaneReconciliationScenario = {
  name: 'active-lane-reconciliation',
  fixtureRoot: path.join(__dirname, 'fixtures', 'active-lane-reconciliation'),
  workspaceFixture: path.join(
    __dirname,
    'fixtures',
    'active-lane-reconciliation',
    'active-lane-reconciliation.code-workspace',
  ),
  suitePath: path.join(__dirname, 'suite', 'active-lane-reconciliation.cjs'),
  launches: [
    { phase: 'prepare-stale-cache' },
    { phase: 'reload-and-remove-link' },
    { phase: 'restore-missing-link' },
  ],
};
const missingLaneRecoveryScenario = {
  name: 'missing-lane-recovery',
  fixtureRoot: path.join(__dirname, 'fixtures', 'missing-lane-recovery'),
  workspaceFixture: path.join(
    __dirname,
    'fixtures',
    'missing-lane-recovery',
    'missing-lane-recovery.code-workspace',
  ),
  suitePath: path.join(__dirname, 'suite', 'missing-lane-recovery.cjs'),
  launches: [
    { phase: 'prepare-missing-active' },
    { phase: 'locate-and-reconcile' },
    { phase: 'restart-and-switch-recovered' },
  ],
};
const legacyAnchorClassificationScenario = {
  name: 'legacy-anchor-classification',
  fixtureRoot: path.join(__dirname, 'fixtures', 'legacy-anchor-classification'),
  workspaceFixture: path.join(
    __dirname,
    'fixtures',
    'legacy-anchor-classification',
    'legacy-anchor-classification.code-workspace',
  ),
  suitePath: path.join(__dirname, 'suite', 'legacy-anchor-classification.cjs'),
};
const emptyWorkspaceScenario = {
  name: 'empty-workspace',
  workspaceFixture: '/fixtures/empty.code-workspace',
  suitePath: '/suite/empty-workspace.cjs',
};

const createFixtureFileSystem = (temporaryRoot, overrides = {}) => ({
  mkdtempSync() {
    return temporaryRoot;
  },
  mkdirSync() {},
  copyFileSync() {},
  cpSync() {},
  rmSync() {},
  ...overrides,
});

const createScenarioDependencies = (temporaryRoot, { fileSystem = {}, ...overrides } = {}) => ({
  fileSystem: createFixtureFileSystem(temporaryRoot, fileSystem),
  launchVSCode: async () => {},
  temporaryDirectory: '/tmp',
  vscodeExecutablePath: '/vscode/code',
  ...overrides,
});

const createWindowsProcessApi = () => ({
  pid: 1,
  platform: 'win32',
  once() {},
});

const createControlledScheduler = () => {
  const scheduled = [];
  return {
    cancelTimeout() {},
    scheduleTimeout(handler, milliseconds) {
      const task = { handler, milliseconds };
      scheduled.push(task);
      return task;
    },
    scheduled,
  };
};

const startControlledScenario = ({
  child,
  createRunId,
  fileSystem,
  processApi,
  spawn = () => child,
  temporaryRoot,
}) => {
  const scheduler = createControlledScheduler();
  return {
    runPromise: runScenario(
      emptyWorkspaceScenario,
      createScenarioDependencies(temporaryRoot, {
        createRunId,
        fileSystem,
        processApi,
        launchVSCode: (options) =>
          launchVSCodeProcess(options, {
            fileSystem,
            log() {},
            processApi,
            cancelTimeout: scheduler.cancelTimeout,
            scheduleTimeout: scheduler.scheduleTimeout,
            spawn,
          }),
      }),
    ),
    scheduled: scheduler.scheduled,
  };
};

const createInstalledVerificationHarness = (
  temporaryRoot,
  { readFileSync = () => '', runId = 'installed-preserve' } = {},
) => {
  const removed = [];
  const fileSystem = {
    mkdtempSync() {
      return temporaryRoot;
    },
    mkdirSync() {},
    copyFileSync() {},
    cpSync() {},
    existsSync() {
      return false;
    },
    readFileSync,
    rmSync(target) {
      removed.push(target);
    },
  };
  return {
    fileSystem,
    removed,
    run: (launchVSCode, processApi) =>
      runInstalledVSIXVerification(
        {
          vscodeExecutablePath: '/vscode/code',
          vsixPath: '/tmp/project-lanes-0.1.14-linux-x64.vsix',
          candidateVersion: '0.1.14',
          baselineVersion: '0.1.13',
        },
        {
          createRunId: () => runId,
          fileSystem,
          installExtension() {},
          launchVSCode,
          processApi,
          temporaryDirectory: '/tmp',
        },
      ),
  };
};

const bootstrapResultIdentity = {
  runId: 'run-1',
  scenario: 'workspace-bootstrap',
  phase: 'bootstrap',
};

const createLaunchRequest = (overrides = {}) => ({
  command: '/vscode/code',
  args: [],
  environment: {},
  markerPath: '/tmp/launch-0.json',
  resultIdentity: bootstrapResultIdentity,
  ...overrides,
});

const createResultFileSystem = (result, overrides = {}) => ({
  existsSync() {
    return false;
  },
  readFileSync() {
    return JSON.stringify(result);
  },
  ...overrides,
});

test('each registered scenario binds its fixture and launch phases to its dedicated suite', () => {
  assert.deepEqual(scenarios, [
    {
      name: 'empty-workspace',
      workspaceFixture: path.join(__dirname, 'fixtures', 'empty.code-workspace'),
      suitePath: path.join(__dirname, 'suite', 'empty-workspace.cjs'),
    },
    workspaceBootstrapScenario,
    workspaceManualInitializationScenario,
    laneSwitchTransactionScenario,
    activeLaneReconciliationScenario,
    missingLaneRecoveryScenario,
    legacyAnchorClassificationScenario,
  ]);
});

test('lane switch search fixture exposes a selectable file only in lane-b', () => {
  const laneAEntries = fs
    .readdirSync(path.join(laneSwitchTransactionScenario.fixtureRoot, 'lane-a'))
    .filter((name) => !name.startsWith('.'));
  const laneBEntries = fs
    .readdirSync(path.join(laneSwitchTransactionScenario.fixtureRoot, 'lane-b'))
    .filter((name) => !name.startsWith('.'));

  assert.deepEqual(laneAEntries, []);
  assert.deepEqual(laneBEntries, ['fixture.txt']);
});

test('the active-lane reconciliation suite rejects an unknown phase', async () => {
  const { run } = require('./suite/active-lane-reconciliation.cjs');

  await assert.rejects(
    run({
      environment: {
        PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'unknown' }),
      },
    }),
    /Unknown E2E phase: unknown/,
  );
});

test('the prepare phase leaves a stale cache behind a lane-b link', async () => {
  const { run } = require('./suite/active-lane-reconciliation.cjs');
  const workspaceDirectory = '/tmp/project-lanes-active-reconciliation/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const messages = [];
  let activeTarget = laneA;

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'prepare-stale-cache' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'active-lane-reconciliation.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-a' }],
      },
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
    },
    fileSystem: {
      realpathSync(target) {
        assert.equal(target, activeLink);
        return activeTarget;
      },
    },
    replaceActiveLink(target) {
      activeTarget = target;
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.equal(activeTarget, laneB);
  assert.deepEqual(messages, ['E2E PASS: stale lane-a cache prepared behind lane-b link']);
});

test('the reload phase reconciles the link, absorbs lane-c, and removes the link for restart', async () => {
  const { run } = require('./suite/active-lane-reconciliation.cjs');
  const workspaceDirectory = '/tmp/project-lanes-active-reload/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const laneC = path.join(workspaceDirectory, 'lane-c');
  const commands = [];
  const messages = [];
  const replacedTargets = [];
  let activeTarget = laneB;
  let linkPresent = true;
  const workspace = {
    workspaceFile: {
      fsPath: path.join(workspaceDirectory, 'active-lane-reconciliation.code-workspace'),
    },
    workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-b' }],
    updateWorkspaceFolders(start, deleteCount, ...folders) {
      assert.equal(start, 1);
      assert.equal(deleteCount, 0);
      this.workspaceFolders = [...this.workspaceFolders, ...folders];
      return true;
    },
  };

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'reload-and-remove-link' }),
    },
    vscodeApi: {
      Uri: {
        file: (fsPath) => ({ fsPath }),
      },
      workspace,
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
      commands: {
        async executeCommand(command, laneId) {
          commands.push([command, laneId]);
          if (command === 'projectLanes.reloadLanes') {
            workspace.workspaceFolders = [
              {
                uri: { fsPath: activeLink },
                name: path.basename(activeTarget),
              },
            ];
          }
          if (command === 'projectLanes.switchLane' && laneId === 'lane-c') {
            activeTarget = laneC;
            workspace.workspaceFolders = [{ uri: { fsPath: activeLink }, name: 'lane-c' }];
          }
        },
      },
    },
    fileSystem: {
      existsSync(target) {
        assert.equal(target, activeLink);
        return linkPresent;
      },
      realpathSync(target) {
        assert.equal(target, activeLink);
        return activeTarget;
      },
    },
    replaceActiveLink(target) {
      replacedTargets.push(target);
      activeTarget = target;
    },
    removeActiveLink() {
      linkPresent = false;
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, [
    ['projectLanes.reloadLanes', undefined],
    ['projectLanes.reloadLanes', undefined],
    ['projectLanes.switchLane', 'lane-c'],
  ]);
  assert.equal(activeTarget, laneC);
  assert.equal(linkPresent, false);
  assert.deepEqual(replacedTargets, [laneA]);
  assert.deepEqual(messages, [
    'E2E PASS: Reload reconciled lane-a and absorbed lane-c before link removal',
  ]);
});

test('the restore phase verifies the missing link was recreated from the lane-c cache', async () => {
  const { run } = require('./suite/active-lane-reconciliation.cjs');
  const workspaceDirectory = '/tmp/project-lanes-active-restore/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneC = path.join(workspaceDirectory, 'lane-c');
  const messages = [];

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'restore-missing-link' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'active-lane-reconciliation.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-c' }],
      },
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
    },
    fileSystem: {
      realpathSync(target) {
        assert.equal(target, activeLink);
        return laneC;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(messages, ['E2E PASS: missing link restored from lane-c selection cache']);
});

test('the missing-lane recovery suite rejects an unknown phase', async () => {
  const { run } = require('./suite/missing-lane-recovery.cjs');

  await assert.rejects(
    run({
      environment: {
        PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'unknown' }),
      },
    }),
    /Unknown E2E phase: unknown/,
  );
});

test('the prepare-missing-active phase leaves a broken lane-a symlink after moving its directory', async () => {
  const { run } = require('./suite/missing-lane-recovery.cjs');
  const workspaceDirectory = '/tmp/project-lanes-missing-prepare/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const movedLaneA = path.join(workspaceDirectory, 'lane-a-moved');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const directories = new Set([laneA, laneB]);
  const messages = [];
  const renames = [];
  let activeTarget = laneA;
  let linkPresent = true;

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'prepare-missing-active' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'missing-lane-recovery.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-a' }],
      },
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
    },
    fileSystem: {
      existsSync(target) {
        if (target === activeLink) return linkPresent && directories.has(activeTarget);
        return directories.has(target);
      },
      lstatSync(target) {
        assert.equal(target, activeLink);
        assert.equal(linkPresent, true);
        return { isSymbolicLink: () => true };
      },
      readlinkSync(target) {
        assert.equal(target, activeLink);
        return activeTarget;
      },
      realpathSync(target) {
        assert.equal(target, activeLink);
        assert.equal(linkPresent, true);
        assert.equal(directories.has(activeTarget), true);
        return activeTarget;
      },
    },
    renameLaneDirectory(source, destination) {
      assert.equal(directories.delete(source), true);
      directories.add(destination);
      renames.push([source, destination]);
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(renames, [[laneA, movedLaneA]]);
  assert.equal(activeTarget, laneA);
  assert.equal(linkPresent, true);
  assert.deepEqual(messages, ['E2E PASS: active lane-a moved while its symlink remained broken']);
});

test('the locate-and-reconcile phase drives the no-argument public command through the lane picker and switches both lanes', async () => {
  const { run } = require('./suite/missing-lane-recovery.cjs');
  const workspaceDirectory = '/tmp/project-lanes-missing-locate/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const movedLaneA = path.join(workspaceDirectory, 'lane-a-moved');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const directories = new Set([movedLaneA, laneB]);
  const commands = [];
  const messages = [];
  let activeTarget = laneB;
  let relocatedLaneA = laneA;
  let completeLocate;
  const workspace = {
    workspaceFile: {
      fsPath: path.join(workspaceDirectory, 'missing-lane-recovery.code-workspace'),
    },
    workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-b' }],
  };

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'locate-and-reconcile' }),
    },
    vscodeApi: {
      workspace,
      commands: {
        async executeCommand(command, laneId) {
          commands.push([command, laneId]);
          if (command === 'projectLanes.locateFolder') {
            assert.equal(laneId, undefined);
            return new Promise((resolve) => {
              completeLocate = () => {
                relocatedLaneA = movedLaneA;
                resolve();
              };
            });
          }
          if (command === 'workbench.action.acceptSelectedQuickOpenItem') {
            assert.ok(completeLocate, 'Expected the lane picker to be open');
            completeLocate();
          }
          if (command === 'projectLanes.switchLane') {
            activeTarget = laneId === 'lane-a' ? relocatedLaneA : laneB;
            workspace.workspaceFolders = [{ uri: { fsPath: activeLink }, name: laneId }];
          }
        },
      },
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
    },
    fileSystem: {
      existsSync(target) {
        if (target === activeLink) return true;
        return directories.has(target);
      },
      realpathSync(target) {
        assert.equal(target, activeLink);
        return activeTarget;
      },
    },
    delay: async () => {},
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, [
    ['projectLanes.locateFolder', undefined],
    ['workbench.action.acceptSelectedQuickOpenItem', undefined],
    ['projectLanes.switchLane', 'lane-a'],
    ['projectLanes.switchLane', 'lane-b'],
  ]);
  assert.equal(relocatedLaneA, movedLaneA);
  assert.equal(activeTarget, laneB);
  assert.deepEqual(messages, ['E2E PASS: missing lane-a located and reconciled before restart']);
});

test('the restart-and-switch-recovered phase switches to the persisted relocated lane', async () => {
  const { run } = require('./suite/missing-lane-recovery.cjs');
  const workspaceDirectory = '/tmp/project-lanes-missing-restore/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const movedLaneA = path.join(workspaceDirectory, 'lane-a-moved');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const commands = [];
  const messages = [];
  let activeTarget = laneB;
  const workspace = {
    workspaceFile: {
      fsPath: path.join(workspaceDirectory, 'missing-lane-recovery.code-workspace'),
    },
    workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-b' }],
  };

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'restart-and-switch-recovered' }),
    },
    vscodeApi: {
      workspace,
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
      commands: {
        async executeCommand(command, laneId) {
          commands.push([command, laneId]);
          if (command === 'projectLanes.switchLane' && laneId === 'lane-a') {
            activeTarget = movedLaneA;
            workspace.workspaceFolders = [{ uri: { fsPath: activeLink }, name: 'lane-a' }];
          }
        },
      },
    },
    fileSystem: {
      realpathSync(target) {
        assert.equal(target, activeLink);
        return activeTarget;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, [['projectLanes.switchLane', 'lane-a']]);
  assert.equal(activeTarget, movedLaneA);
  assert.deepEqual(messages, ['E2E PASS: relocated lane-a persisted and switched after restart']);
});

test('the empty-workspace suite verifies activation and reports success', async () => {
  const { run } = require('./suite/empty-workspace.cjs');
  const messages = [];
  let activated = false;
  let nativeDependencyLoaded = false;

  await run({
    vscodeApi: {
      workspace: {
        workspaceFile: { fsPath: '/tmp/empty.code-workspace' },
        workspaceFolders: [],
      },
      extensions: {
        getExtension() {
          return {
            get isActive() {
              return activated;
            },
            async activate() {
              activated = true;
            },
          };
        },
      },
    },
    loadNodePty() {
      assert.equal(activated, true);
      nativeDependencyLoaded = true;
      return { spawn() {} };
    },
    log(message) {
      assert.equal(nativeDependencyLoaded, true);
      messages.push(message);
    },
  });

  assert.deepEqual(messages, ['E2E PASS: yukiito1999.project-lanes activated']);
});

test('the empty-workspace suite rejects a non-empty workspace', async () => {
  const { run } = require('./suite/empty-workspace.cjs');

  await assert.rejects(
    run({
      vscodeApi: {
        workspace: {
          workspaceFile: { fsPath: '/tmp/empty.code-workspace' },
          workspaceFolders: [{ name: 'unexpected' }],
        },
      },
    }),
    /Expected an empty workspace/,
  );
});

test('the installed VSIX suite activates the isolated candidate and loads its native module', async () => {
  const { run } = require('./suite/installed-vsix.cjs');
  const extensionsDir = '/tmp/installed/fresh/extensions';
  const extensionPath = path.join(extensionsDir, 'yukiito1999.project-lanes-0.1.13-linux-x64');
  const messages = [];
  let activated = false;
  let loadedFrom;
  let executedRipgrep;

  await run({
    environment: {
      PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR: extensionsDir,
      PROJECT_LANES_E2E_EXPECTED_VERSION: '0.1.13',
    },
    vscodeApi: {
      extensions: {
        getExtension(extensionId) {
          assert.equal(extensionId, 'yukiito1999.project-lanes');
          return {
            extensionPath,
            packageJSON: { version: '0.1.13' },
            get isActive() {
              return activated;
            },
            async activate() {
              activated = true;
            },
          };
        },
      },
    },
    loadNodePty(installedExtensionPath) {
      assert.equal(activated, true);
      loadedFrom = installedExtensionPath;
      return { spawn() {} };
    },
    resolveRealPath(value) {
      return value;
    },
    runRipgrep(ripgrepPath) {
      executedRipgrep = ripgrepPath;
      return {
        status: 0,
        stdout: 'ripgrep 14.1.1\n',
        stderr: '',
      };
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.equal(loadedFrom, extensionPath);
  assert.equal(
    executedRipgrep,
    path.join(extensionPath, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg'),
  );
  assert.deepEqual(messages, ['E2E PASS: installed yukiito1999.project-lanes@0.1.13 activated']);
});

test('the installed VSIX suite creates v1 state with the baseline then exercises legacy-label commands after upgrade', async () => {
  const { run } = require('./suite/installed-vsix.cjs');
  const extensionsDir = '/tmp/installed/upgrade/extensions';
  const workspaceDirectory = '/tmp/installed/upgrade/workspace';
  const workspaceFile = path.join(workspaceDirectory, 'workspace-bootstrap.code-workspace');
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const commands = [];
  const recreatedTargets = [];
  let activeTarget;
  let linkPresent = false;
  let version = '0.1.13';
  let activated = false;
  const workspace = {
    workspaceFile: { fsPath: workspaceFile },
    workspaceFolders: [
      { name: 'lane-a', uri: { fsPath: laneA } },
      { name: 'lane-b', uri: { fsPath: laneB } },
    ],
  };
  const vscodeApi = {
    workspace,
    extensions: {
      getExtension() {
        return {
          extensionPath: path.join(extensionsDir, `yukiito1999.project-lanes-${version}-linux-x64`),
          packageJSON: { version },
          get isActive() {
            return activated;
          },
          async activate() {
            activated = true;
            if (version === '0.1.14' && !linkPresent) {
              activeTarget = laneB;
              linkPresent = true;
              recreatedTargets.push(activeTarget);
              workspace.workspaceFolders = [
                { name: path.basename(activeTarget), uri: { fsPath: activeLink } },
              ];
            }
          },
        };
      },
    },
    commands: {
      async executeCommand(command, argument) {
        commands.push([command, argument]);
        if (command === 'projectLanes.initializeWorkspace') {
          activeTarget = laneA;
          linkPresent = true;
        } else if (command === 'projectLanes.switchLane') {
          activeTarget = argument === 'lane-a' ? laneA : laneB;
          linkPresent = true;
        }
        if (activeTarget) {
          workspace.workspaceFolders = [
            { name: path.basename(activeTarget), uri: { fsPath: activeLink } },
          ];
        }
      },
    },
  };
  const dependencies = {
    vscodeApi,
    resolveRealPath(value) {
      return value;
    },
    loadNodePty() {
      return { spawn() {} };
    },
    runRipgrep() {
      return { status: 0, stdout: 'ripgrep 14.1.1\n', stderr: '' };
    },
    fileSystem: {
      realpathSync(value) {
        assert.equal(value, activeLink);
        if (!linkPresent) throw new Error('active link is missing');
        return activeTarget;
      },
      unlinkSync(value) {
        assert.equal(value, activeLink);
        assert.equal(linkPresent, true);
        linkPresent = false;
        activeTarget = undefined;
      },
      existsSync(value) {
        assert.equal(value, activeLink);
        return linkPresent;
      },
    },
    delay: async () => {},
  };
  const environmentFor = (phase) => ({
    PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR: extensionsDir,
    PROJECT_LANES_E2E_EXPECTED_VERSION: version,
    PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase }),
  });

  await run({
    ...dependencies,
    environment: environmentFor('baseline-create-v1'),
  });
  assert.equal(linkPresent, false);
  assert.deepEqual(recreatedTargets, []);

  version = '0.1.14';
  activated = false;
  await run({
    ...dependencies,
    environment: environmentFor('candidate-migrate'),
  });
  assert.equal(linkPresent, false);
  assert.deepEqual(recreatedTargets, [laneB]);

  activated = false;
  await run({
    ...dependencies,
    environment: environmentFor('candidate-restart'),
  });

  assert.deepEqual(commands, [
    ['projectLanes.initializeWorkspace', undefined],
    ['projectLanes.switchLane', 'lane-b'],
    ['projectLanes.switchLane', 'lane-a'],
    ['projectLanes.switchLane', 'lane-b'],
    ['projectLanes.switchLane', 'lane-a'],
    ['projectLanes.switchLane', 'lane-b'],
  ]);
  assert.deepEqual(recreatedTargets, [laneB, laneB]);
  assert.equal(linkPresent, true);
  assert.equal(activeTarget, laneB);
});

test('the installed VSIX suite rejects a candidate whose manifest version is unexpected', async () => {
  const { run } = require('./suite/installed-vsix.cjs');

  await assert.rejects(
    run({
      environment: {
        PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR: '/tmp/installed/fresh/extensions',
        PROJECT_LANES_E2E_EXPECTED_VERSION: '0.1.13',
      },
      vscodeApi: {
        extensions: {
          getExtension() {
            return {
              extensionPath:
                '/tmp/installed/fresh/extensions/yukiito1999.project-lanes-0.1.12-linux-x64',
              packageJSON: { version: '0.1.12' },
              isActive: false,
              async activate() {},
            };
          },
        },
      },
      loadNodePty() {
        return { spawn() {} };
      },
      resolveRealPath(value) {
        return value;
      },
    }),
    /Unexpected installed extension version: 0\.1\.12/,
  );
});

test('the installed VSIX suite rejects a matching extension loaded outside its isolated profile', async () => {
  const { run } = require('./suite/installed-vsix.cjs');
  let activated = false;

  await assert.rejects(
    run({
      environment: {
        PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR: '/tmp/installed/fresh/extensions',
        PROJECT_LANES_E2E_EXPECTED_VERSION: '0.1.13',
      },
      vscodeApi: {
        extensions: {
          getExtension() {
            return {
              extensionPath: '/workspace/project-lanes',
              packageJSON: { version: '0.1.13' },
              get isActive() {
                return activated;
              },
              async activate() {
                activated = true;
              },
            };
          },
        },
      },
      loadNodePty() {
        return { spawn() {} };
      },
      resolveRealPath(value) {
        return value;
      },
    }),
    /Extension is outside the isolated extensions directory: \/workspace\/project-lanes/,
  );
  assert.equal(activated, false);
});

test('the E2E package script gates scenarios on the registry unit tests', () => {
  assert.equal(
    packageJson.scripts['test:e2e'],
    'node --test test/e2e/scenarios.test.cjs && node test/e2e/run.cjs',
  );
});

test('normal launch options use both development extensions without enabling test mode', () => {
  const environment = {
    ELECTRON_RUN_AS_NODE: '1',
    HOME: '/home/tester',
    VSCODE_ESM_ENTRYPOINT: 'unexpected-entrypoint',
  };
  const options = buildLaunchOptions({
    vscodeExecutablePath: '/vscode/code',
    scenario: {
      name: 'empty-workspace',
      suitePath: '/suite/empty-workspace.cjs',
    },
    workspacePath: '/tmp/scenario/workspace/empty.code-workspace',
    userDataDir: '/tmp/scenario/user-data',
    extensionsDir: '/tmp/scenario/extensions',
    markerPath: '/tmp/scenario/launch-0.json',
    resultIdentity: {
      runId: 'run-1',
      scenario: 'empty-workspace',
      phase: 'default',
    },
    environment,
  });

  assert.deepEqual(options, {
    command: '/vscode/code',
    args: [
      '/tmp/scenario/workspace/empty.code-workspace',
      '--disable-extensions',
      '--user-data-dir',
      '/tmp/scenario/user-data',
      '--extensions-dir',
      '/tmp/scenario/extensions',
      `--extensionDevelopmentPath=${path.resolve(__dirname, '..', '..')}`,
      `--extensionDevelopmentPath=${path.join(__dirname, 'driver')}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      '--disable-workspace-trust',
    ],
    environment: {
      HOME: '/home/tester',
      PROJECT_LANES_E2E_RESULT_PATH: '/tmp/scenario/launch-0.json',
      PROJECT_LANES_E2E_RUN: JSON.stringify({
        runId: 'run-1',
        scenario: 'empty-workspace',
        phase: 'default',
      }),
      PROJECT_LANES_E2E_SUITE_PATH: '/suite/empty-workspace.cjs',
    },
    markerPath: '/tmp/scenario/launch-0.json',
  });
  assert.equal(Object.hasOwn(environment, 'ELECTRON_RUN_AS_NODE'), true);
  assert.equal(Object.hasOwn(environment, 'VSCODE_ESM_ENTRYPOINT'), true);
  assert.equal(
    options.args.some((argument) => argument.includes('extensionTestsPath')),
    false,
  );
});

test('installed launch enables the profile extension and exposes only the driver as development code', () => {
  const options = buildInstalledLaunchOptions({
    vscodeExecutablePath: '/vscode/code',
    scenario: {
      name: 'installed-vsix-fresh',
      suitePath: '/suite/installed-vsix.cjs',
    },
    workspacePath: '/tmp/installed/empty.code-workspace',
    userDataDir: '/tmp/installed/fresh/user-data',
    extensionsDir: '/tmp/installed/fresh/extensions',
    markerPath: '/tmp/installed/fresh-result.json',
    resultIdentity: {
      runId: 'installed-run',
      scenario: 'installed-vsix-fresh',
      phase: 'default',
    },
    expectedVersion: '0.1.13',
    environment: {
      ELECTRON_RUN_AS_NODE: '1',
      VSCODE_ESM_ENTRYPOINT: 'unexpected-entrypoint',
    },
  });

  assert.deepEqual(options, {
    command: '/vscode/code',
    args: [
      '/tmp/installed/empty.code-workspace',
      '--user-data-dir',
      '/tmp/installed/fresh/user-data',
      '--extensions-dir',
      '/tmp/installed/fresh/extensions',
      `--extensionDevelopmentPath=${path.join(__dirname, 'driver')}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      '--disable-workspace-trust',
    ],
    environment: {
      PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR: '/tmp/installed/fresh/extensions',
      PROJECT_LANES_E2E_EXPECTED_VERSION: '0.1.13',
      PROJECT_LANES_E2E_RESULT_PATH: '/tmp/installed/fresh-result.json',
      PROJECT_LANES_E2E_RUN: JSON.stringify({
        runId: 'installed-run',
        scenario: 'installed-vsix-fresh',
        phase: 'default',
      }),
      PROJECT_LANES_E2E_SUITE_PATH: '/suite/installed-vsix.cjs',
    },
    markerPath: '/tmp/installed/fresh-result.json',
  });
  assert.equal(options.args.includes('--disable-extensions'), false);
  assert.equal(
    options.args.includes(`--extensionDevelopmentPath=${path.resolve(__dirname, '..', '..')}`),
    false,
  );
});

test('extension management CLI isolates the profile before applying the requested operation', () => {
  const resolutions = [];
  const request = buildExtensionManagementRequest({
    vscodeExecutablePath: '/vscode/code',
    userDataDir: '/tmp/installed/fresh/user-data',
    extensionsDir: '/tmp/installed/fresh/extensions',
    operationArgs: ['--install-extension', '/tmp/project-lanes.vsix', '--force'],
    resolveCliArgs(executablePath, options) {
      resolutions.push({ executablePath, options });
      return ['/vscode/bin/code', '--cli-prefix'];
    },
  });

  assert.deepEqual(resolutions, [
    {
      executablePath: '/vscode/code',
      options: { reuseMachineInstall: true },
    },
  ]);
  assert.deepEqual(request, {
    command: '/vscode/bin/code',
    args: [
      '--cli-prefix',
      '--user-data-dir',
      '/tmp/installed/fresh/user-data',
      '--extensions-dir',
      '/tmp/installed/fresh/extensions',
      '--install-extension',
      '/tmp/project-lanes.vsix',
      '--force',
    ],
  });
});

test('extension listing rejects a version mismatch and any unrelated profile extension', () => {
  assert.throws(
    () =>
      assertListedExtensionVersion(
        'yukiito1999.project-lanes@0.1.12\n',
        'yukiito1999.project-lanes',
        '0.1.13',
      ),
    /Expected installed extensions to equal yukiito1999\.project-lanes@0\.1\.13.*0\.1\.12/s,
  );
  assert.throws(
    () =>
      assertListedExtensionVersion(
        ['unrelated.publisher@1.0.0', 'yukiito1999.project-lanes@0.1.13', ''].join('\n'),
        'yukiito1999.project-lanes',
        '0.1.13',
      ),
    /unrelated\.publisher@1\.0\.0/,
  );
});

test('extension management executes without a shell and exposes stdout for version checks', () => {
  const calls = [];
  const stdout = executeExtensionManagementRequest(
    {
      command: '/vscode/bin/code',
      args: ['--list-extensions', '--show-versions'],
    },
    {
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        PATH: '/bin',
        VSCODE_ESM_ENTRYPOINT: 'unexpected-entrypoint',
        VSCODE_IPC_HOOK_CLI: '/tmp/host-session.sock',
      },
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return {
          status: 0,
          signal: null,
          stdout: 'yukiito1999.project-lanes@0.1.13\n',
          stderr: '',
        };
      },
    },
  );

  assert.equal(stdout, 'yukiito1999.project-lanes@0.1.13\n');
  assert.deepEqual(calls, [
    {
      command: '/vscode/bin/code',
      args: ['--list-extensions', '--show-versions'],
      options: {
        encoding: 'utf8',
        env: {
          DONT_PROMPT_WSL_INSTALL: '1',
          PATH: '/bin',
        },
        shell: false,
      },
    },
  ]);
});

test('extension management reports the failed CLI operation and stderr', () => {
  assert.throws(
    () =>
      executeExtensionManagementRequest(
        {
          command: '/vscode/bin/code',
          args: ['--install-extension', '/tmp/project-lanes.vsix'],
        },
        {
          spawnSync() {
            return {
              status: 1,
              signal: null,
              stdout: '',
              stderr: 'installation failed',
            };
          },
        },
      ),
    /--install-extension.*installation failed/s,
  );
});

test('extension install is followed by an exact version listing in the same isolated profile', () => {
  const requests = [];
  const outputs = ['', 'yukiito1999.project-lanes@0.1.13\n'];

  installAndVerifyExtension(
    {
      vscodeExecutablePath: '/vscode/code',
      userDataDir: '/tmp/installed/fresh/user-data',
      extensionsDir: '/tmp/installed/fresh/extensions',
      extensionReference: '/tmp/project-lanes.vsix',
      extensionId: 'yukiito1999.project-lanes',
      expectedVersion: '0.1.13',
      resolveCliArgs() {
        return ['/vscode/bin/code'];
      },
    },
    {
      executeRequest(request) {
        requests.push(request);
        return outputs.shift();
      },
    },
  );

  assert.deepEqual(requests, [
    {
      command: '/vscode/bin/code',
      args: [
        '--user-data-dir',
        '/tmp/installed/fresh/user-data',
        '--extensions-dir',
        '/tmp/installed/fresh/extensions',
        '--install-extension',
        '/tmp/project-lanes.vsix',
        '--force',
      ],
    },
    {
      command: '/vscode/bin/code',
      args: [
        '--user-data-dir',
        '/tmp/installed/fresh/user-data',
        '--extensions-dir',
        '/tmp/installed/fresh/extensions',
        '--list-extensions',
        '--show-versions',
      ],
    },
  ]);
  assert.deepEqual(outputs, []);
});

test('installed VSIX verification launches baseline before upgrading the same profile and restarts the candidate', async () => {
  const temporaryRoot = '/tmp/project-lanes-installed-vsix-test';
  const operations = [];
  const processApi = {
    pid: 741,
    once() {},
    kill() {},
  };

  await runInstalledVSIXVerification(
    {
      vscodeExecutablePath: '/vscode/code',
      vsixPath: '/tmp/project-lanes-0.1.14-linux-x64.vsix',
      candidateVersion: '0.1.14',
      baselineVersion: '0.1.13',
    },
    {
      createRunId: () => 'installed-run',
      environment: { PATH: '/bin' },
      fileSystem: {
        mkdtempSync(prefix) {
          assert.equal(prefix, '/tmp/project-lanes-installed-vsix-');
          return temporaryRoot;
        },
        mkdirSync() {},
        copyFileSync(source, destination) {
          assert.equal(source, path.join(__dirname, 'fixtures', 'empty.code-workspace'));
          assert.equal(
            destination,
            path.join(temporaryRoot, 'fresh', 'workspace', 'empty.code-workspace'),
          );
        },
        cpSync(source, destination, options) {
          assert.equal(source, path.join(__dirname, 'fixtures', 'workspace-bootstrap'));
          assert.equal(destination, path.join(temporaryRoot, 'upgrade', 'workspace'));
          assert.deepEqual(options, { recursive: true });
        },
        rmSync(target, options) {
          operations.push({ cleanup: { target, options } });
        },
      },
      installExtension(options) {
        operations.push({ install: options });
      },
      async launchVSCode(options) {
        operations.push({ launch: options });
      },
      processApi,
      temporaryDirectory: '/tmp',
    },
  );

  const profiles = {
    fresh: {
      userDataDir: path.join(temporaryRoot, 'fresh', 'user-data'),
      extensionsDir: path.join(temporaryRoot, 'fresh', 'extensions'),
    },
    upgrade: {
      userDataDir: path.join(temporaryRoot, 'upgrade', 'user-data'),
      extensionsDir: path.join(temporaryRoot, 'upgrade', 'extensions'),
    },
  };
  assert.deepEqual(operations[0], {
    install: {
      vscodeExecutablePath: '/vscode/code',
      ...profiles.fresh,
      extensionReference: '/tmp/project-lanes-0.1.14-linux-x64.vsix',
      extensionId: 'yukiito1999.project-lanes',
      expectedVersion: '0.1.14',
    },
  });
  assert.equal(operations[1].launch.args.includes('--disable-extensions'), false);
  assert.equal(
    operations[1].launch.args.includes(
      `--extensionDevelopmentPath=${path.resolve(__dirname, '..', '..')}`,
    ),
    false,
  );
  assert.equal(
    operations[1].launch.environment.PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR,
    profiles.fresh.extensionsDir,
  );
  assert.equal(
    operations[3].launch.environment.PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR,
    profiles.upgrade.extensionsDir,
  );
  const upgradeLaunches = [operations[3], operations[5], operations[6]].map(({ launch }) => launch);
  assert.deepEqual(
    upgradeLaunches.map((launch) => launch.args[0]),
    Array(3).fill(
      path.join(temporaryRoot, 'upgrade', 'workspace', 'workspace-bootstrap.code-workspace'),
    ),
  );
  assert.deepEqual(
    upgradeLaunches.map((launch) =>
      launch.args.slice(
        launch.args.indexOf('--user-data-dir'),
        launch.args.indexOf('--user-data-dir') + 4,
      ),
    ),
    Array(3).fill([
      '--user-data-dir',
      profiles.upgrade.userDataDir,
      '--extensions-dir',
      profiles.upgrade.extensionsDir,
    ]),
  );
  assert.deepEqual(
    [operations[1], operations[3], operations[5], operations[6]].map(({ launch }) => ({
      run: JSON.parse(launch.environment.PROJECT_LANES_E2E_RUN),
      payload: JSON.parse(launch.environment.PROJECT_LANES_E2E_PAYLOAD),
      version: launch.environment.PROJECT_LANES_E2E_EXPECTED_VERSION,
    })),
    [
      {
        run: {
          runId: 'installed-run',
          scenario: 'installed-vsix-fresh',
          phase: 'fresh',
        },
        payload: { phase: 'fresh' },
        version: '0.1.14',
      },
      {
        run: {
          runId: 'installed-run',
          scenario: 'installed-vsix-upgrade',
          phase: 'baseline-create-v1',
        },
        payload: { phase: 'baseline-create-v1' },
        version: '0.1.13',
      },
      {
        run: {
          runId: 'installed-run',
          scenario: 'installed-vsix-upgrade',
          phase: 'candidate-migrate',
        },
        payload: { phase: 'candidate-migrate' },
        version: '0.1.14',
      },
      {
        run: {
          runId: 'installed-run',
          scenario: 'installed-vsix-upgrade',
          phase: 'candidate-restart',
        },
        payload: { phase: 'candidate-restart' },
        version: '0.1.14',
      },
    ],
  );
  assert.deepEqual(operations[2], {
    install: {
      vscodeExecutablePath: '/vscode/code',
      ...profiles.upgrade,
      extensionReference: 'yukiito1999.project-lanes@0.1.13',
      extensionId: 'yukiito1999.project-lanes',
      expectedVersion: '0.1.13',
    },
  });
  assert.deepEqual(operations[4], {
    install: {
      vscodeExecutablePath: '/vscode/code',
      ...profiles.upgrade,
      extensionReference: '/tmp/project-lanes-0.1.14-linux-x64.vsix',
      extensionId: 'yukiito1999.project-lanes',
      expectedVersion: '0.1.14',
    },
  });
  assert.deepEqual(operations[7], {
    cleanup: {
      target: temporaryRoot,
      options: { recursive: true, force: true },
    },
  });
});

test('installed VSIX verification preserves its root when launch termination is unconfirmed', async () => {
  const handlers = new Map();
  const processApi = {
    pid: 147,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill() {},
  };
  const launchError = Object.assign(new Error('termination unconfirmed'), {
    code: 'ERR_VSCODE_PROCESS_TERMINATION_UNCONFIRMED',
  });
  const harness = createInstalledVerificationHarness(
    '/tmp/project-lanes-installed-vsix-unconfirmed',
  );

  await assert.rejects(
    harness.run(async () => {
      throw launchError;
    }, processApi),
    (error) => error === launchError,
  );
  handlers.get('exit')();

  assert.deepEqual(harness.removed, []);
});

test('a separate SIGTERM termination failure preserves the installed VSIX root', async (context) => {
  context.mock.method(console, 'error', () => {});
  const handlers = new Map();
  const failedChild = new EventEmitter();
  failedChild.pid = 174;
  const installedChild = new EventEmitter();
  installedChild.pid = 471;
  let installedGroupAlive = true;
  const processApi = {
    pid: 714,
    platform: 'linux',
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      if (pid === -failedChild.pid) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      if (pid === -installedChild.pid) {
        if (signal === 0) {
          if (installedGroupAlive) return;
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        }
        if (signal === 'SIGINT') {
          installedGroupAlive = false;
          queueMicrotask(() => installedChild.emit('close', 0, null));
        }
        return;
      }
      assert.equal(pid, processApi.pid);
      assert.equal(signal, 'SIGTERM');
    },
  };
  const failingScheduler = createControlledScheduler();
  const failedLaunch = launchVSCodeProcess(createLaunchRequest(), {
    cancelTimeout: failingScheduler.cancelTimeout,
    fileSystem: createResultFileSystem(undefined),
    processApi,
    scheduleTimeout: failingScheduler.scheduleTimeout,
    spawn() {
      return failedChild;
    },
  });
  void failedLaunch.catch(() => {});

  const harness = createInstalledVerificationHarness(
    '/tmp/project-lanes-installed-vsix-suppressed',
    {
      readFileSync() {
        return JSON.stringify({
          runId: 'installed-suppressed',
          scenario: 'installed-vsix-fresh',
          phase: 'fresh',
          status: 'PASS',
          message: 'E2E PASS: installed root remains active',
        });
      },
      runId: 'installed-suppressed',
    },
  );
  const installedScheduler = createControlledScheduler();
  let installedLaunchCount = 0;
  const verification = harness.run((options) => {
    installedLaunchCount += 1;
    return launchVSCodeProcess(options, {
      cancelTimeout: installedScheduler.cancelTimeout,
      fileSystem: harness.fileSystem,
      log() {},
      processApi,
      scheduleTimeout: installedScheduler.scheduleTimeout,
      spawn() {
        return installedChild;
      },
    });
  }, processApi);

  assert.equal(installedLaunchCount, 1);
  const signalHandling = handlers.get('SIGTERM')();
  await Promise.all([verification, signalHandling]);
  handlers.get('exit')();

  assert.deepEqual(harness.removed, []);
});

test('the installed VSIX entrypoint downloads VS Code and verifies the requested artifact', async () => {
  const { main } = require('./run-vsix.cjs');
  const calls = [];

  await main({
    argv: ['/tmp/project-lanes-linux-x64-0.1.13.vsix', '0.1.12'],
    packageMetadata: { version: '0.1.13' },
    async downloadVSCode(options) {
      calls.push({ download: options });
      return '/vscode/code';
    },
    async runVerification(options) {
      calls.push({ verification: options });
    },
  });

  assert.deepEqual(calls, [
    {
      download: {
        version: '1.101.0',
        cachePath: '/tmp/vscode-project-lanes-vscode-test-cache',
      },
    },
    {
      verification: {
        vscodeExecutablePath: '/vscode/code',
        vsixPath: '/tmp/project-lanes-linux-x64-0.1.13.vsix',
        candidateVersion: '0.1.13',
        baselineVersion: '0.1.12',
      },
    },
  ]);
});

test('the installed VSIX entrypoint requires the artifact path and previous version only', async () => {
  const { main } = require('./run-vsix.cjs');

  await assert.rejects(
    main({
      argv: ['/tmp/project-lanes-linux-x64-0.1.13.vsix'],
      packageMetadata: { version: '0.1.13' },
    }),
    /Usage: node test\/e2e\/run-vsix\.cjs <vsixPath> <previousVersion>/,
  );
  await assert.rejects(
    main({
      argv: ['/tmp/project-lanes-linux-x64-0.1.13.vsix', '0.1.12', 'unexpected'],
      packageMetadata: { version: '0.1.13' },
    }),
    /Usage: node test\/e2e\/run-vsix\.cjs <vsixPath> <previousVersion>/,
  );
});

test('the VS Code download cache can be overridden outside the repository', () => {
  assert.deepEqual(buildDownloadOptions({}), {
    version: '1.101.0',
    cachePath: '/tmp/vscode-project-lanes-vscode-test-cache',
  });
  assert.deepEqual(
    buildDownloadOptions({
      PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
    }),
    {
      version: '1.101.0',
      cachePath: '/var/tmp/project-lanes-vscode-cache',
    },
  );
});

test('a scenario setup failure removes its temporary root', async () => {
  const removed = [];
  const temporaryRoot = '/tmp/project-lanes-e2e-empty-workspace-test';

  await assert.rejects(
    runScenario(
      {
        name: 'empty-workspace',
        workspaceFixture: '/fixtures/empty.code-workspace',
        suitePath: '/suite/empty-workspace.cjs',
      },
      createScenarioDependencies(temporaryRoot, {
        fileSystem: {
          mkdirSync() {
            throw new Error('setup failed');
          },
          rmSync(target, options) {
            removed.push({ target, options });
          },
        },
      }),
    ),
    /setup failed/,
  );
  assert.deepEqual(removed, [
    {
      target: temporaryRoot,
      options: { recursive: true, force: true },
    },
  ]);
});

test('a scenario passes its dedicated normal launch options to VS Code', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-empty-workspace-test';
  const scenario = {
    name: 'empty-workspace',
    workspaceFixture: '/fixtures/empty.code-workspace',
    suitePath: '/suite/empty-workspace.cjs',
  };
  let receivedOptions;

  await runScenario(
    scenario,
    createScenarioDependencies(temporaryRoot, {
      createRunId: () => 'run-1',
      launchVSCode: async (options) => {
        receivedOptions = options;
      },
      environment: {
        PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
      },
    }),
  );

  assert.deepEqual(
    receivedOptions,
    buildLaunchOptions({
      vscodeExecutablePath: '/vscode/code',
      scenario,
      workspacePath: path.join(
        temporaryRoot,
        'workspace',
        path.basename(scenario.workspaceFixture),
      ),
      userDataDir: path.join(temporaryRoot, 'user-data'),
      extensionsDir: path.join(temporaryRoot, 'extensions'),
      markerPath: path.join(temporaryRoot, 'launch-0.json'),
      resultIdentity: {
        runId: 'run-1',
        scenario: 'empty-workspace',
        phase: 'default',
      },
      environment: {
        PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
      },
    }),
  );
});

test('normal launches reuse their workspace and profile while passing only a phase payload', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-workspace-bootstrap-test';
  const environment = {
    PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
  };
  const receivedOptions = [];

  await runScenario(
    workspaceBootstrapScenario,
    createScenarioDependencies(temporaryRoot, {
      launchVSCode: async (options) => {
        receivedOptions.push(options);
      },
      environment,
    }),
  );

  assert.equal(receivedOptions.length, 2);
  const [
    { environment: bootstrapEnvironment, markerPath: bootstrapMarkerPath, ...bootstrapOptions },
    { environment: restartEnvironment, markerPath: restartMarkerPath, ...restartOptions },
  ] = receivedOptions;
  assert.deepEqual(bootstrapOptions, restartOptions);
  assert.equal(
    bootstrapEnvironment.PROJECT_LANES_E2E_PAYLOAD,
    JSON.stringify({ phase: 'bootstrap' }),
  );
  assert.equal(restartEnvironment.PROJECT_LANES_E2E_PAYLOAD, JSON.stringify({ phase: 'restart' }));
  assert.equal(
    bootstrapEnvironment.PROJECT_LANES_E2E_SUITE_PATH,
    workspaceBootstrapScenario.suitePath,
  );
  assert.equal(
    restartEnvironment.PROJECT_LANES_E2E_SUITE_PATH,
    workspaceBootstrapScenario.suitePath,
  );
  assert.equal(bootstrapMarkerPath, path.join(temporaryRoot, 'launch-0.json'));
  assert.equal(restartMarkerPath, path.join(temporaryRoot, 'launch-1.json'));
  assert.equal(bootstrapEnvironment.PROJECT_LANES_E2E_RESULT_PATH, bootstrapMarkerPath);
  assert.equal(restartEnvironment.PROJECT_LANES_E2E_RESULT_PATH, restartMarkerPath);
  const bootstrapIdentity = JSON.parse(bootstrapEnvironment.PROJECT_LANES_E2E_RUN);
  const restartIdentity = JSON.parse(restartEnvironment.PROJECT_LANES_E2E_RUN);
  assert.equal(bootstrapIdentity.runId, restartIdentity.runId);
  assert.deepEqual(bootstrapIdentity, {
    runId: bootstrapIdentity.runId,
    scenario: 'workspace-bootstrap',
    phase: 'bootstrap',
  });
  assert.deepEqual(restartIdentity, {
    runId: bootstrapIdentity.runId,
    scenario: 'workspace-bootstrap',
    phase: 'restart',
  });
  assert.equal(
    bootstrapOptions.args[0],
    path.join(temporaryRoot, 'workspace', 'workspace-bootstrap.code-workspace'),
  );
  assert.deepEqual(bootstrapOptions.args.slice(3, 6), [
    path.join(temporaryRoot, 'user-data'),
    '--extensions-dir',
    path.join(temporaryRoot, 'extensions'),
  ]);
  assert.equal(Object.hasOwn(environment, 'PROJECT_LANES_E2E_PAYLOAD'), false);
});

test('multiple launches wait for the previous VS Code process before starting the next', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-serial-launches';
  let resolveFirstLaunch;
  const firstLaunch = new Promise((resolve) => {
    resolveFirstLaunch = resolve;
  });
  const receivedPayloads = [];
  const runPromise = runScenario(
    workspaceBootstrapScenario,
    createScenarioDependencies(temporaryRoot, {
      launchVSCode: (options) => {
        receivedPayloads.push(options.environment.PROJECT_LANES_E2E_PAYLOAD);
        return receivedPayloads.length === 1 ? firstLaunch : Promise.resolve();
      },
    }),
  );

  assert.equal(receivedPayloads.length, 1);
  resolveFirstLaunch();
  await runPromise;
  assert.equal(receivedPayloads.length, 2);
  assert.deepEqual(
    receivedPayloads.map((payload) => JSON.parse(payload).phase),
    ['bootstrap', 'restart'],
  );
});

test('a failed first launch skips the restart launch and cleans the scenario root once', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-first-launch-failure';
  const removed = [];
  let launchCount = 0;

  await assert.rejects(
    runScenario(
      workspaceBootstrapScenario,
      createScenarioDependencies(temporaryRoot, {
        fileSystem: {
          rmSync(target, options) {
            removed.push({ target, options });
          },
        },
        launchVSCode: async () => {
          launchCount += 1;
          throw new Error('bootstrap launch failed');
        },
      }),
    ),
    /bootstrap launch failed/,
  );

  assert.equal(launchCount, 1);
  assert.deepEqual(removed, [
    {
      target: temporaryRoot,
      options: { recursive: true, force: true },
    },
  ]);
});

test('an unconfirmed timeout termination preserves the scenario root across process exit', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-timeout-termination-unconfirmed';
  const child = new EventEmitter();
  child.pid = 147;
  const handlers = new Map();
  const removed = [];
  const fileSystem = createFixtureFileSystem(temporaryRoot, {
    existsSync() {
      return false;
    },
    rmSync(target) {
      removed.push(target);
    },
  });
  const processApi = {
    pid: 741,
    platform: 'linux',
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill() {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    },
  };

  const { runPromise, scheduled } = startControlledScenario({
    child,
    fileSystem,
    processApi,
    temporaryRoot,
  });
  scheduled.find((task) => task.milliseconds === 120_000).handler();

  await assert.rejects(runPromise, (error) => {
    assert.equal(error.code, 'ERR_VSCODE_PROCESS_TERMINATION_UNCONFIRMED');
    assert.match(error.message, /operation not permitted/);
    return true;
  });
  handlers.get('exit')();

  assert.deepEqual(removed, []);
});

test('a post-SIGKILL confirmation timeout preserves the scenario root across process exit', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-confirmation-timeout';
  const child = new EventEmitter();
  child.pid = 258;
  const handlers = new Map();
  const removed = [];
  const fileSystem = createFixtureFileSystem(temporaryRoot, {
    existsSync() {
      return false;
    },
    rmSync(target) {
      removed.push(target);
    },
  });
  const processApi = {
    pid: 852,
    platform: 'linux',
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      assert.equal(pid, -child.pid);
      if (signal === 'SIGINT') child.emit('close', null, signal);
    },
  };
  const { runPromise, scheduled } = startControlledScenario({
    child,
    fileSystem,
    processApi,
    temporaryRoot,
  });

  const timeoutWork = scheduled.find((task) => task.milliseconds === 120_000).handler();
  scheduled.find((task) => task.milliseconds === 5_000).handler();
  await Promise.resolve();
  assert.equal(
    scheduled.some((task) => task.milliseconds === 50),
    true,
  );
  scheduled.filter((task) => task.milliseconds === 5_000)[1].handler();
  await timeoutWork;
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.code, 'ERR_VSCODE_PROCESS_TERMINATION_UNCONFIRMED');
    assert.match(error.message, /process did not exit within 5000ms after SIGKILL/);
    return true;
  });
  handlers.get('exit')();

  assert.deepEqual(removed, []);
});

test('a failed second launch still cleans the scenario root once', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-second-launch-failure';
  const removed = [];
  let launchCount = 0;

  await assert.rejects(
    runScenario(
      workspaceBootstrapScenario,
      createScenarioDependencies(temporaryRoot, {
        fileSystem: {
          rmSync(target, options) {
            removed.push({ target, options });
          },
        },
        launchVSCode: async () => {
          launchCount += 1;
          if (launchCount === 2) throw new Error('restart launch failed');
        },
      }),
    ),
    /restart launch failed/,
  );

  assert.equal(launchCount, 2);
  assert.deepEqual(removed, [
    {
      target: temporaryRoot,
      options: { recursive: true, force: true },
    },
  ]);
});

test('a fixture tree is copied once and the first launch workspace mutation reaches restart', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-fixture-copy';
  let fixtureCopyCount = 0;
  let fileCopyCount = 0;
  let workspaceFile = 'raw lane-a and lane-b';
  let launchCount = 0;

  await runScenario(
    workspaceBootstrapScenario,
    createScenarioDependencies(temporaryRoot, {
      fileSystem: {
        copyFileSync() {
          fileCopyCount += 1;
          workspaceFile = 'raw lane-a and lane-b';
        },
        cpSync(source, destination, options) {
          fixtureCopyCount += 1;
          assert.equal(source, workspaceBootstrapScenario.fixtureRoot);
          assert.equal(destination, path.join(temporaryRoot, 'workspace'));
          assert.deepEqual(options, { recursive: true });
          workspaceFile = 'raw lane-a and lane-b';
        },
      },
      launchVSCode: async () => {
        launchCount += 1;
        if (launchCount === 1) {
          workspaceFile = 'single .lanes-root/active folder';
          return;
        }
        assert.equal(workspaceFile, 'single .lanes-root/active folder');
      },
    }),
  );

  assert.equal(launchCount, 2);
  assert.equal(fixtureCopyCount, 1);
  assert.equal(fileCopyCount, 0);
});

test('a normal VS Code launch requires process exit zero and a success marker', async () => {
  const child = new EventEmitter();
  child.pid = 321;
  const spawned = [];
  const messages = [];
  const result = launchVSCodeProcess(
    createLaunchRequest({
      args: ['/tmp/workspace.code-workspace'],
      environment: { HOME: '/home/tester' },
    }),
    {
      fileSystem: createResultFileSystem(
        {
          ...bootstrapResultIdentity,
          status: 'PASS',
          message: 'E2E PASS: normal launch',
        },
        {
          readFileSync(markerPath, encoding) {
            assert.equal(markerPath, '/tmp/launch-0.json');
            assert.equal(encoding, 'utf8');
            return JSON.stringify(this.result);
          },
          result: {
            ...bootstrapResultIdentity,
            status: 'PASS',
            message: 'E2E PASS: normal launch',
          },
        },
      ),
      log(message) {
        messages.push(message);
      },
      processApi: {
        pid: 159,
        platform: 'linux',
        once() {},
        kill(pid, signal) {
          assert.equal(pid, -child.pid);
          assert.equal(signal, 0);
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        },
      },
      spawn(command, args, options) {
        spawned.push({ command, args, options });
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
      timeoutMilliseconds: 1_000,
    },
  );

  await result;
  assert.deepEqual(spawned, [
    {
      command: '/vscode/code',
      args: ['/tmp/workspace.code-workspace'],
      options: {
        detached: true,
        env: { HOME: '/home/tester' },
        stdio: 'inherit',
      },
    },
  ]);
  assert.deepEqual(messages, ['E2E PASS: normal launch']);
});

test('a Windows normal close succeeds without process-group probing', async () => {
  const child = new EventEmitter();
  child.pid = 654;
  let markerRead = false;

  await launchVSCodeProcess(createLaunchRequest(), {
    fileSystem: createResultFileSystem(
      {
        ...bootstrapResultIdentity,
        status: 'PASS',
        message: 'E2E PASS: Windows normal close',
      },
      {
        readFileSync() {
          markerRead = true;
          return JSON.stringify({
            ...bootstrapResultIdentity,
            status: 'PASS',
            message: 'E2E PASS: Windows normal close',
          });
        },
      },
    ),
    processApi: {
      ...createWindowsProcessApi(),
      kill() {
        throw new Error('Windows normal close must not probe a process group');
      },
    },
    log() {},
    spawn(command, args, options) {
      assert.deepEqual(options, { env: {}, stdio: 'inherit' });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  });

  assert.equal(markerRead, true);
});

test('a POSIX normal close waits for the remaining process group before marker read and cleanup', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-normal-close-group';
  const child = new EventEmitter();
  child.pid = 432;
  const events = [];
  let groupAlive = true;
  const fileSystem = createFixtureFileSystem(temporaryRoot, {
    existsSync() {
      return false;
    },
    readFileSync() {
      events.push('marker-read');
      return JSON.stringify({
        runId: 'normal-close-group',
        scenario: 'empty-workspace',
        phase: 'default',
        status: 'PASS',
        message: 'E2E PASS: process group closed',
      });
    },
    rmSync() {
      events.push('cleanup');
    },
  });
  const processApi = {
    pid: 234,
    platform: 'linux',
    once() {},
    kill(pid, signal) {
      assert.equal(pid, -child.pid);
      if (signal === 0) {
        events.push(`probe-${groupAlive ? 'alive' : 'gone'}`);
        if (!groupAlive) {
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        }
        return;
      }
      events.push(`kill-${signal}`);
      if (signal === 'SIGKILL') groupAlive = false;
    },
  };
  const { runPromise, scheduled } = startControlledScenario({
    child,
    createRunId: () => 'normal-close-group',
    fileSystem,
    processApi,
    spawn() {
      events.push('spawn');
      queueMicrotask(() => {
        events.push('leader-close');
        child.emit('close', 0, null);
      });
      return child;
    },
    temporaryRoot,
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['spawn', 'leader-close', 'probe-alive', 'kill-SIGINT']);

  scheduled.find((task) => task.milliseconds === 5_000).handler();
  await runPromise;

  assert.deepEqual(events, [
    'spawn',
    'leader-close',
    'probe-alive',
    'kill-SIGINT',
    'kill-SIGKILL',
    'probe-gone',
    'marker-read',
    'cleanup',
  ]);
});

test('an unconfirmed POSIX normal-close termination preserves the scenario root', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-normal-close-unconfirmed';
  const child = new EventEmitter();
  child.pid = 543;
  const handlers = new Map();
  const removed = [];
  const fileSystem = createFixtureFileSystem(temporaryRoot, {
    existsSync() {
      return false;
    },
    readFileSync() {
      throw new Error('marker must not be read before process group termination');
    },
    rmSync(target) {
      removed.push(target);
    },
  });
  const processApi = {
    pid: 345,
    platform: 'linux',
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid) {
      assert.equal(pid, -child.pid);
    },
  };
  const { runPromise, scheduled } = startControlledScenario({
    child,
    fileSystem,
    processApi,
    spawn() {
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
    temporaryRoot,
  });

  await Promise.resolve();
  scheduled.find((task) => task.milliseconds === 5_000).handler();
  await Promise.resolve();
  scheduled.filter((task) => task.milliseconds === 5_000)[1].handler();
  await assert.rejects(runPromise, (error) => {
    assert.equal(error.code, 'ERR_VSCODE_PROCESS_TERMINATION_UNCONFIRMED');
    assert.match(error.message, /process did not exit within 5000ms after SIGKILL/);
    return true;
  });
  handlers.get('exit')();

  assert.deepEqual(removed, []);
});

test('a normal VS Code launch rejects a nonzero process exit before reading its marker', async () => {
  const child = new EventEmitter();
  child.pid = 654;
  let markerRead = false;

  await assert.rejects(
    launchVSCodeProcess(createLaunchRequest(), {
      fileSystem: createResultFileSystem(undefined, {
        readFileSync() {
          markerRead = true;
        },
      }),
      processApi: createWindowsProcessApi(),
      spawn() {
        queueMicrotask(() => child.emit('close', 9, null));
        return child;
      },
      timeoutMilliseconds: 1_000,
    }),
    /VS Code exited with code 9/,
  );
  assert.equal(markerRead, false);
});

test('a normal VS Code launch rejects a driver failure marker', async () => {
  const child = new EventEmitter();
  child.pid = 987;

  await assert.rejects(
    launchVSCodeProcess(createLaunchRequest(), {
      fileSystem: createResultFileSystem({
        ...bootstrapResultIdentity,
        status: 'FAIL',
        error: {
          message: 'restart suite failed',
          stack: 'Error: restart suite failed',
        },
      }),
      processApi: createWindowsProcessApi(),
      spawn() {
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
      timeoutMilliseconds: 1_000,
    }),
    /restart suite failed/,
  );
});

test('a normal VS Code launch rejects a marker from another run', async () => {
  const child = new EventEmitter();
  child.pid = 975;

  await assert.rejects(
    launchVSCodeProcess(createLaunchRequest(), {
      fileSystem: createResultFileSystem({
        ...bootstrapResultIdentity,
        runId: 'another-run',
        status: 'PASS',
        message: 'E2E PASS: stale result',
      }),
      processApi: createWindowsProcessApi(),
      spawn() {
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
      timeoutMilliseconds: 1_000,
    }),
    /Unexpected E2E result identity/,
  );
});

test('a normal VS Code launch rejects a duplicate marker before spawning', async () => {
  let spawned = false;

  await assert.rejects(
    launchVSCodeProcess(
      createLaunchRequest({
        markerPath: '/tmp/launch-duplicate.json',
      }),
      {
        fileSystem: {
          existsSync() {
            return true;
          },
        },
        spawn() {
          spawned = true;
        },
      },
    ),
    /E2E result marker already exists/,
  );
  assert.equal(spawned, false);
});

test('POSIX timeout keeps grace after leader close until the process group is gone', async () => {
  const child = new EventEmitter();
  child.pid = 246;
  const events = [];
  const scheduled = [];
  let groupAlive = true;
  child.kill = () => {
    throw new Error('POSIX termination must signal the process group');
  };
  const processApi = {
    pid: 135,
    platform: 'linux',
    once() {},
    kill(pid, signal) {
      assert.equal(pid, -child.pid);
      if (signal === 0) {
        events.push(`probe-${groupAlive ? 'alive' : 'gone'}`);
        if (!groupAlive) {
          const error = new Error('process group is gone');
          error.code = 'ESRCH';
          throw error;
        }
        return;
      }
      events.push(`kill-${pid}-${signal}`);
      if (signal === 'SIGINT') {
        events.push('leader-close');
        child.emit('close', null, signal);
      }
      if (signal === 'SIGKILL') {
        groupAlive = false;
      }
    },
  };

  const launch = launchVSCodeProcess(
    createLaunchRequest({
      markerPath: '/tmp/launch-timeout.json',
    }),
    {
      fileSystem: {
        existsSync() {
          return false;
        },
        readFileSync() {
          throw new Error('marker must not be read after timeout');
        },
      },
      scheduleTimeout(handler, milliseconds) {
        const task = { handler, milliseconds };
        scheduled.push(task);
        events.push(`schedule-${milliseconds}`);
        return task;
      },
      cancelTimeout(task) {
        events.push(`cancel-${task.milliseconds}`);
      },
      spawn() {
        return child;
      },
      processApi,
    },
  );
  let launchSettled = false;
  void launch.then(
    () => {
      launchSettled = true;
    },
    () => {
      launchSettled = true;
    },
  );

  const timeoutWork = scheduled.find((task) => task.milliseconds === 120_000).handler();
  await Promise.resolve();
  assert.equal(launchSettled, false);
  assert.equal(groupAlive, true);
  assert.deepEqual(events, [
    'schedule-120000',
    'kill--246-SIGINT',
    'leader-close',
    'probe-alive',
    'schedule-5000',
  ]);

  scheduled.find((task) => task.milliseconds === 5_000).handler();
  await timeoutWork;
  await assert.rejects(launch, /VS Code launch timed out after 120000ms/);
  assert.deepEqual(events, [
    'schedule-120000',
    'kill--246-SIGINT',
    'leader-close',
    'probe-alive',
    'schedule-5000',
    'kill--246-SIGKILL',
    'probe-gone',
    'cancel-120000',
  ]);
});

test('POSIX ESRCH means the group is gone but termination still waits for leader close', async () => {
  const child = new EventEmitter();
  child.pid = 753;
  const events = [];
  const processApi = {
    pid: 951,
    platform: 'linux',
    once() {},
    kill(pid, signal) {
      events.push(`kill-${pid}-${signal}`);
      if (signal === 'SIGINT') {
        queueMicrotask(() => child.emit('close', null, signal));
      }
      const error = new Error('no such process group');
      error.code = 'ESRCH';
      throw error;
    },
  };

  const launch = launchVSCodeProcess(createLaunchRequest(), {
    fileSystem: createResultFileSystem(undefined),
    processApi,
    scheduleTimeout(handler, milliseconds) {
      if (milliseconds === 120_000) queueMicrotask(handler);
      return milliseconds;
    },
    spawn() {
      return child;
    },
  });

  await assert.rejects(launch, /VS Code launch timed out/);
  assert.deepEqual(events, ['kill--753-SIGINT']);
});

test('Windows launch keeps the attached child fallback and terminates it directly', async () => {
  const child = new EventEmitter();
  child.pid = 864;
  const events = [];
  const spawned = [];
  const processApi = {
    pid: 975,
    platform: 'win32',
    once() {},
    kill() {
      throw new Error('Windows fallback must not signal a POSIX process group');
    },
  };
  child.kill = (signal) => {
    events.push(`child-kill-${signal}`);
    if (signal === 'SIGKILL') child.emit('close', null, signal);
  };

  await assert.rejects(
    launchVSCodeProcess(createLaunchRequest(), {
      fileSystem: createResultFileSystem(undefined),
      processApi,
      scheduleTimeout(handler) {
        queueMicrotask(handler);
        return events.length;
      },
      spawn(command, args, options) {
        spawned.push({ command, args, options });
        return child;
      },
    }),
    /VS Code launch timed out/,
  );

  assert.deepEqual(spawned[0]?.options, {
    env: {},
    stdio: 'inherit',
  });
  assert.deepEqual(events, ['child-kill-SIGINT', 'child-kill-SIGKILL']);
});

test('SIGTERM waits for active child termination before cleaning scenario roots', async () => {
  const handlers = new Map();
  const events = [];
  let finishTermination;
  const processApi = {
    pid: 246,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      events.push(`reraise-${pid}-${signal}`);
    },
  };
  const cleanupRegistry = createProcessCleanupRegistry(processApi);
  cleanupRegistry.activeCleanups.add(() => events.push('cleanup'));
  cleanupRegistry.activeTerminations.add(
    () =>
      new Promise((resolve) => {
        events.push('terminate');
        finishTermination = () => {
          events.push('child-close');
          resolve();
        };
      }),
  );

  const signalHandling = handlers.get('SIGTERM')();
  assert.deepEqual(events, ['terminate']);
  finishTermination();
  await signalHandling;
  handlers.get('exit')();

  assert.deepEqual(events, ['terminate', 'child-close', 'cleanup', 'reraise-246-SIGTERM']);
});

test('SIGTERM termination failure reports the error and suppresses root cleanup including exit hook', async () => {
  const handlers = new Map();
  const events = [];
  const reportedErrors = [];
  const failure = new Error('process group termination failed');
  const processApi = {
    pid: 642,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      events.push(`reraise-${pid}-${signal}`);
    },
  };
  const cleanupRegistry = createProcessCleanupRegistry(processApi, {
    reportCleanupError(error) {
      reportedErrors.push(error);
      events.push(`report-${error.message}`);
    },
  });
  cleanupRegistry.activeCleanups.add(() => events.push('cleanup'));
  cleanupRegistry.activeTerminations.add(() => Promise.reject(failure));

  await handlers.get('SIGTERM')();
  handlers.get('exit')();

  assert.deepEqual(events, ['report-VS Code process termination failed', 'reraise-642-SIGTERM']);
  assert.equal(reportedErrors[0] instanceof AggregateError, true);
  assert.equal(reportedErrors[0].code, 'ERR_VSCODE_PROCESS_TERMINATION_UNCONFIRMED');
  assert.deepEqual(reportedErrors[0].errors, [failure]);
});

test('one SIGTERM termination failure preserves every active scenario root', async (context) => {
  context.mock.method(console, 'error', () => {});
  const handlers = new Map();
  const removed = [];
  const failedChild = new EventEmitter();
  failedChild.pid = 164;
  const successfulChild = new EventEmitter();
  successfulChild.pid = 461;
  let successfulGroupAlive = true;
  const processApi = {
    pid: 614,
    platform: 'linux',
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      if (pid === -failedChild.pid) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      }
      if (pid === -successfulChild.pid) {
        if (signal === 0) {
          if (successfulGroupAlive) return;
          throw Object.assign(new Error('process group is gone'), { code: 'ESRCH' });
        }
        if (signal === 'SIGINT') {
          successfulGroupAlive = false;
          queueMicrotask(() => successfulChild.emit('close', 0, null));
        }
        return;
      }
      assert.equal(pid, processApi.pid);
      assert.equal(signal, 'SIGTERM');
    },
  };
  const createFileSystem = (temporaryRoot, runId) =>
    createFixtureFileSystem(temporaryRoot, {
      existsSync() {
        return false;
      },
      readFileSync() {
        return JSON.stringify({
          runId,
          scenario: 'empty-workspace',
          phase: 'default',
          status: 'PASS',
          message: `E2E PASS: ${runId}`,
        });
      },
      rmSync(target) {
        removed.push(target);
      },
    });
  const failedFileSystem = createFileSystem('/tmp/project-lanes-e2e-sigterm-failed', 'failed');
  const successfulFileSystem = createFileSystem(
    '/tmp/project-lanes-e2e-sigterm-successful',
    'successful',
  );
  const { runPromise: failedRun } = startControlledScenario({
    child: failedChild,
    createRunId: () => 'failed',
    fileSystem: failedFileSystem,
    processApi,
    temporaryRoot: '/tmp/project-lanes-e2e-sigterm-failed',
  });
  const { runPromise: successfulRun } = startControlledScenario({
    child: successfulChild,
    createRunId: () => 'successful',
    fileSystem: successfulFileSystem,
    processApi,
    temporaryRoot: '/tmp/project-lanes-e2e-sigterm-successful',
  });
  void failedRun;

  const signalHandling = handlers.get('SIGTERM')();
  await Promise.all([successfulRun, signalHandling]);
  handlers.get('exit')();

  assert.deepEqual(removed, []);
});

test('SIGTERM latched during a successful launch prevents the next launch before cleanup', async () => {
  const handlers = new Map();
  const events = [];
  const scheduled = [];
  let groupAlive = true;
  const processApi = {
    pid: 357,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      if (pid < 0) {
        if (signal === 0) {
          events.push(`launch-1-probe-${groupAlive ? 'alive' : 'gone'}`);
          if (groupAlive) return;
          const error = new Error('process group is gone');
          error.code = 'ESRCH';
          throw error;
        }
        events.push(`launch-1-kill-${signal}`);
        if (signal === 'SIGINT') {
          queueMicrotask(() => {
            events.push('launch-1-close');
            firstChild.emit('close', 0, null);
          });
        }
        if (signal === 'SIGKILL') groupAlive = false;
        return;
      }
      events.push(`reraise-${pid}-${signal}`);
    },
  };
  const fileSystem = createFixtureFileSystem('/tmp/project-lanes-e2e-sigterm-race', {
    existsSync() {
      return false;
    },
    readFileSync(markerPath) {
      const phase = markerPath.endsWith('launch-0.json') ? 'bootstrap' : 'restart';
      return JSON.stringify({
        runId: 'sigterm-race',
        scenario: 'workspace-bootstrap',
        phase,
        status: 'PASS',
        message: `E2E PASS: ${phase}`,
      });
    },
    rmSync() {
      events.push('cleanup');
    },
  });
  const firstChild = new EventEmitter();
  firstChild.pid = 468;
  firstChild.kill = () => {
    throw new Error('POSIX termination must signal the process group');
  };
  let launchCount = 0;
  const runPromise = runScenario(
    workspaceBootstrapScenario,
    createScenarioDependencies('/tmp/project-lanes-e2e-sigterm-race', {
      createRunId: () => 'sigterm-race',
      fileSystem,
      processApi,
      launchVSCode: (options) => {
        launchCount += 1;
        events.push(`launch-${launchCount}-spawn`);
        if (launchCount > 1) return Promise.resolve();
        return launchVSCodeProcess(options, {
          fileSystem,
          log() {},
          processApi,
          scheduleTimeout(handler, milliseconds) {
            const task = { handler, milliseconds };
            scheduled.push(task);
            return task;
          },
          cancelTimeout() {},
          spawn() {
            return firstChild;
          },
        });
      },
    }),
  );

  const signalHandling = handlers.get('SIGTERM')();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [
    'launch-1-spawn',
    'launch-1-kill-SIGINT',
    'launch-1-close',
    'launch-1-probe-alive',
  ]);

  scheduled.find((task) => task.milliseconds === 5_000).handler();
  await Promise.all([runPromise, signalHandling]);

  assert.equal(launchCount, 1);
  assert.deepEqual(events, [
    'launch-1-spawn',
    'launch-1-kill-SIGINT',
    'launch-1-close',
    'launch-1-probe-alive',
    'launch-1-kill-SIGKILL',
    'launch-1-probe-gone',
    'cleanup',
    'reraise-357-SIGTERM',
  ]);
});

test('the driver extension activates on startup without defining an extension test path', () => {
  const manifest = require('./driver/package.json');

  assert.equal(manifest.main, './extension.cjs');
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
});

test('the driver private replacement picker asserts options and returns the relocated folder URI', () => {
  const { registerReplacementPickerCommand } = require('./driver/extension.cjs');
  const workspaceDirectory = '/tmp/project-lanes-driver-picker/workspace';
  const registrations = [];
  const disposable = { dispose() {} };
  const registered = registerReplacementPickerCommand({
    resultIdentity: {
      scenario: 'missing-lane-recovery',
      phase: 'locate-and-reconcile',
    },
    vscodeApi: {
      Uri: {
        file: (fsPath) => ({ fsPath }),
      },
      commands: {
        registerCommand(command, handler) {
          registrations.push([command, handler]);
          return disposable;
        },
      },
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'missing-lane-recovery.code-workspace'),
        },
      },
    },
  });

  assert.equal(registered, disposable);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][0], 'projectLanes.e2e.pickReplacementFolder');
  assert.deepEqual(
    registrations[0][1]({
      title: 'Locate Lane Folder',
      openLabel: 'Locate Folder',
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: { fsPath: workspaceDirectory },
    }),
    { fsPath: path.join(workspaceDirectory, 'lane-a-moved') },
  );
});

test('the driver quits when a required initialization environment variable is missing', async () => {
  const { runDriver } = require('./driver/extension.cjs');
  const commands = [];

  await assert.rejects(
    runDriver({
      environment: {
        PROJECT_LANES_E2E_RUN: JSON.stringify({
          runId: 'run-driver-missing-marker',
          scenario: 'workspace-bootstrap',
          phase: 'bootstrap',
        }),
        PROJECT_LANES_E2E_SUITE_PATH: '/suite/workspace-bootstrap.cjs',
      },
      fileSystem: {
        writeFileSync() {
          throw new Error('marker must not be written without its path');
        },
      },
      loadSuite() {
        throw new Error('suite must not load after initialization fails');
      },
      vscodeApi: {
        commands: {
          async executeCommand(command) {
            commands.push(command);
          },
        },
      },
    }),
    /Missing E2E environment variable: PROJECT_LANES_E2E_RESULT_PATH/,
  );

  assert.deepEqual(commands, ['workbench.action.quit']);
});

test('the driver quits and preserves a malformed result identity error', async () => {
  const { runDriver } = require('./driver/extension.cjs');
  const commands = [];

  await assert.rejects(
    runDriver({
      environment: {
        PROJECT_LANES_E2E_RESULT_PATH: '/tmp/launch-malformed-identity.json',
        PROJECT_LANES_E2E_RUN: '{',
        PROJECT_LANES_E2E_SUITE_PATH: '/suite/workspace-bootstrap.cjs',
      },
      fileSystem: {
        writeFileSync() {
          throw new Error('marker must not be written without a valid result identity');
        },
      },
      loadSuite() {
        throw new Error('suite must not load after initialization fails');
      },
      vscodeApi: {
        commands: {
          async executeCommand(command) {
            commands.push(command);
          },
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof SyntaxError);
      return true;
    },
  );

  assert.deepEqual(commands, ['workbench.action.quit']);
});

test('the driver writes a success marker atomically before quitting VS Code', async () => {
  const { runDriver } = require('./driver/extension.cjs');
  const markerPath = '/tmp/launch-0.json';
  const files = new Map();
  const operations = [];
  const environment = {
    PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'bootstrap' }),
    PROJECT_LANES_E2E_RESULT_PATH: markerPath,
    PROJECT_LANES_E2E_RUN: JSON.stringify({
      runId: 'run-driver-1',
      scenario: 'workspace-bootstrap',
      phase: 'bootstrap',
    }),
    PROJECT_LANES_E2E_SUITE_PATH: '/suite/workspace-bootstrap.cjs',
  };

  await runDriver({
    environment,
    fileSystem: {
      linkSync(source, destination) {
        operations.push(['link', source, destination]);
        files.set(destination, files.get(source));
      },
      unlinkSync(target) {
        operations.push(['unlink', target]);
        files.delete(target);
      },
      writeFileSync(target, contents, options) {
        operations.push(['write', target, options]);
        files.set(target, contents);
      },
    },
    loadSuite(suitePath) {
      assert.equal(suitePath, '/suite/workspace-bootstrap.cjs');
      return {
        async run(options) {
          assert.equal(options.environment, environment);
          options.log('E2E PASS: driver suite');
        },
      };
    },
    processApi: { pid: 135 },
    vscodeApi: {
      commands: {
        async executeCommand(command) {
          operations.push(['command', command]);
        },
      },
    },
  });

  assert.deepEqual(operations, [
    ['write', '/tmp/launch-0.json.tmp-135', { encoding: 'utf8', flag: 'wx' }],
    ['link', '/tmp/launch-0.json.tmp-135', '/tmp/launch-0.json'],
    ['unlink', '/tmp/launch-0.json.tmp-135'],
    ['command', 'workbench.action.quit'],
  ]);
  assert.deepEqual(JSON.parse(files.get(markerPath)), {
    runId: 'run-driver-1',
    scenario: 'workspace-bootstrap',
    phase: 'bootstrap',
    status: 'PASS',
    message: 'E2E PASS: driver suite',
  });
});

test('the driver records a suite failure before quitting VS Code', async () => {
  const { runDriver } = require('./driver/extension.cjs');
  const markerPath = '/tmp/launch-1.json';
  const files = new Map();
  const commands = [];

  await runDriver({
    environment: {
      PROJECT_LANES_E2E_RESULT_PATH: markerPath,
      PROJECT_LANES_E2E_RUN: JSON.stringify({
        runId: 'run-driver-2',
        scenario: 'workspace-bootstrap',
        phase: 'restart',
      }),
      PROJECT_LANES_E2E_SUITE_PATH: '/suite/workspace-bootstrap.cjs',
    },
    fileSystem: {
      linkSync(source, destination) {
        files.set(destination, files.get(source));
      },
      unlinkSync(source) {
        files.delete(source);
      },
      writeFileSync(target, contents) {
        files.set(target, contents);
      },
    },
    loadSuite() {
      return {
        async run() {
          throw new Error('suite failed');
        },
      };
    },
    processApi: { pid: 864 },
    vscodeApi: {
      commands: {
        async executeCommand(command) {
          commands.push(command);
        },
      },
    },
  });

  const marker = JSON.parse(files.get(markerPath));
  assert.equal(marker.runId, 'run-driver-2');
  assert.equal(marker.scenario, 'workspace-bootstrap');
  assert.equal(marker.phase, 'restart');
  assert.equal(marker.status, 'FAIL');
  assert.equal(marker.error.message, 'suite failed');
  assert.match(marker.error.stack, /Error: suite failed/);
  assert.deepEqual(commands, ['workbench.action.quit']);
});

test('the driver never replaces a marker published by a concurrent writer', async () => {
  const { runDriver } = require('./driver/extension.cjs');
  const markerPath = '/tmp/launch-concurrent.json';
  const firstMarker = JSON.stringify({
    runId: 'run-concurrent',
    scenario: 'workspace-bootstrap',
    phase: 'bootstrap',
    status: 'FAIL',
    error: { message: 'first writer failed' },
  });
  const files = new Map();
  const commands = [];

  await assert.rejects(
    runDriver({
      environment: {
        PROJECT_LANES_E2E_RESULT_PATH: markerPath,
        PROJECT_LANES_E2E_RUN: JSON.stringify({
          runId: 'run-concurrent',
          scenario: 'workspace-bootstrap',
          phase: 'bootstrap',
        }),
        PROJECT_LANES_E2E_SUITE_PATH: '/suite/workspace-bootstrap.cjs',
      },
      fileSystem: {
        linkSync(source, destination) {
          if (files.has(destination)) {
            const error = new Error('marker already exists');
            error.code = 'EEXIST';
            throw error;
          }
          files.set(destination, files.get(source));
        },
        unlinkSync(target) {
          files.delete(target);
        },
        writeFileSync(target, contents) {
          files.set(target, contents);
          files.set(markerPath, firstMarker);
        },
      },
      loadSuite() {
        return {
          async run(options) {
            options.log('E2E PASS: second writer');
          },
        };
      },
      processApi: { pid: 579 },
      vscodeApi: {
        commands: {
          async executeCommand(command) {
            commands.push(command);
          },
        },
      },
    }),
    { code: 'EEXIST' },
  );

  assert.equal(files.get(markerPath), firstMarker);
  assert.equal(files.has(`${markerPath}.tmp-579`), false);
  assert.deepEqual(commands, ['workbench.action.quit']);
});

test('the driver reports publish and temporary marker cleanup failures together', async () => {
  const { runDriver } = require('./driver/extension.cjs');
  const markerPath = '/tmp/launch-cleanup-failure.json';
  const firstMarker = JSON.stringify({
    runId: 'run-cleanup-failure',
    scenario: 'workspace-bootstrap',
    phase: 'bootstrap',
    status: 'FAIL',
    error: { message: 'first writer failed' },
  });
  const publishError = Object.assign(new Error('marker already exists'), {
    code: 'EEXIST',
  });
  const cleanupError = Object.assign(new Error('temporary marker cleanup denied'), {
    code: 'EACCES',
  });
  const files = new Map();
  const commands = [];

  await assert.rejects(
    runDriver({
      environment: {
        PROJECT_LANES_E2E_RESULT_PATH: markerPath,
        PROJECT_LANES_E2E_RUN: JSON.stringify({
          runId: 'run-cleanup-failure',
          scenario: 'workspace-bootstrap',
          phase: 'bootstrap',
        }),
        PROJECT_LANES_E2E_SUITE_PATH: '/suite/workspace-bootstrap.cjs',
      },
      fileSystem: {
        linkSync() {
          throw publishError;
        },
        unlinkSync() {
          throw cleanupError;
        },
        writeFileSync(target, contents) {
          files.set(target, contents);
          files.set(markerPath, firstMarker);
        },
      },
      loadSuite() {
        return {
          async run(options) {
            options.log('E2E PASS: second writer');
          },
        };
      },
      processApi: { pid: 680 },
      vscodeApi: {
        commands: {
          async executeCommand(command) {
            commands.push(command);
          },
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [publishError, cleanupError]);
      return true;
    },
  );

  assert.equal(files.get(markerPath), firstMarker);
  assert.deepEqual(commands, ['workbench.action.quit']);
});

test('the workspace-bootstrap suite rejects a missing phase payload', async () => {
  const { run } = require('./suite/workspace-bootstrap.cjs');

  await assert.rejects(
    run({
      environment: {},
    }),
    /Missing E2E payload: PROJECT_LANES_E2E_PAYLOAD/,
  );
});

test('the workspace-bootstrap suite rejects an unknown phase', async () => {
  const { run } = require('./suite/workspace-bootstrap.cjs');

  await assert.rejects(
    run({
      environment: {
        PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'unknown' }),
      },
    }),
    /Unknown E2E phase: unknown/,
  );
});

test('the workspace-bootstrap phase accepts host cancellation after reaching lane-a', async () => {
  const { run } = require('./suite/workspace-bootstrap.cjs');
  const workspaceDirectory = '/tmp/project-lanes-e2e-bootstrap/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  let activated = false;
  const messages = [];

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'bootstrap' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'workspace-bootstrap.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-a' }],
      },
      extensions: {
        getExtension() {
          return {
            get isActive() {
              return activated;
            },
            async activate() {
              activated = true;
              throw new Error('Activating extension failed: Canceled.');
            },
          };
        },
      },
    },
    fileSystem: {
      realpathSync(linkPath) {
        assert.equal(linkPath, activeLink);
        return laneA;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(messages, ['E2E PASS: workspace bootstrap initialized lane-a']);
});

test('the legacy-anchor classification suite stops after the classified workspace state is reached', async () => {
  const { run } = require('./suite/legacy-anchor-classification.cjs');
  const workspaceDirectory = '/tmp/project-lanes-e2e-legacy-anchor/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const realLane = path.join(workspaceDirectory, 'real-lane');
  const commands = [];
  const messages = [];

  await run({
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'legacy-anchor-classification.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink }, name: '.lanes-root' }],
      },
      extensions: {
        getExtension() {
          return {
            async activate() {
              throw new Error('Activating extension failed: Canceled.');
            },
          };
        },
      },
      commands: {
        async executeCommand(command, laneId) {
          commands.push([command, laneId]);
        },
      },
    },
    fileSystem: {
      realpathSync(linkPath) {
        assert.equal(linkPath, activeLink);
        return realLane;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, []);
  assert.deepEqual(messages, [
    'E2E PASS: legacy anchor URI excluded and same-name real lane retained',
  ]);
});

test('the workspace-bootstrap restart phase switches using the restored public lane catalog', async () => {
  const { run } = require('./suite/workspace-bootstrap.cjs');
  const workspaceDirectory = '/tmp/project-lanes-e2e-restart/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const commands = [];
  const messages = [];
  let activeTarget = laneA;

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'restart' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'workspace-bootstrap.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink }, name: 'lane-a' }],
      },
      extensions: {
        getExtension() {
          return {
            isActive: true,
            async activate() {},
          };
        },
      },
      commands: {
        async executeCommand(command, laneId) {
          commands.push([command, laneId]);
          activeTarget = laneId === 'lane-a' ? laneA : laneB;
        },
      },
    },
    fileSystem: {
      realpathSync(linkPath) {
        assert.equal(linkPath, activeLink);
        return activeTarget;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, [
    ['projectLanes.switchLane', 'lane-b'],
    ['projectLanes.switchLane', 'lane-a'],
  ]);
  assert.deepEqual(messages, ['E2E PASS: workspace catalog restored after restart']);
});

test('the manual-first phase leaves folders, file, anchor, and terminal settings unchanged', async () => {
  const { run } = require('./suite/workspace-manual-initialization.cjs');
  const workspaceDirectory = '/tmp/project-lanes-e2e-manual/workspace';
  const workspaceFile = path.join(
    workspaceDirectory,
    'workspace-manual-initialization.code-workspace',
  );
  const fixtureContent = fs.readFileSync(
    workspaceManualInitializationScenario.workspaceFixture,
    'utf8',
  );
  let activated = false;
  const messages = [];

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'manual-first' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: { fsPath: workspaceFile },
        workspaceFolders: [
          { uri: { fsPath: path.join(workspaceDirectory, 'lane-a') } },
          { uri: { fsPath: path.join(workspaceDirectory, 'lane-b') } },
        ],
        getConfiguration() {
          return {
            inspect(key) {
              return {
                workspaceValue: key === 'defaultProfile.linux' ? 'bash' : true,
              };
            },
          };
        },
      },
      extensions: {
        getExtension() {
          return {
            get isActive() {
              return activated;
            },
            async activate() {
              activated = true;
            },
          };
        },
      },
    },
    fileSystem: {
      existsSync(target) {
        assert.equal(target, path.join(workspaceDirectory, '.lanes-root'));
        return false;
      },
      readFileSync(target, encoding) {
        assert.equal(target, workspaceFile);
        assert.equal(encoding, 'utf8');
        return fixtureContent;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(messages, ['E2E PASS: manual-first left the workspace unchanged']);
});

test('the initialize phase accepts host cancellation only after reaching the managed state', async () => {
  const { run } = require('./suite/workspace-manual-initialization.cjs');
  const workspaceDirectory = '/tmp/project-lanes-e2e-manual-command/workspace';
  const workspaceFile = path.join(
    workspaceDirectory,
    'workspace-manual-initialization.code-workspace',
  );
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const fixtureContent = fs.readFileSync(
    workspaceManualInitializationScenario.workspaceFixture,
    'utf8',
  );
  const workspace = {
    workspaceFile: { fsPath: workspaceFile },
    workspaceFolders: [
      { uri: { fsPath: laneA } },
      { uri: { fsPath: path.join(workspaceDirectory, 'lane-b') } },
    ],
    terminalProfile: 'bash',
    persistentSessions: true,
    getConfiguration() {
      return {
        inspect: (key) => ({
          workspaceValue:
            key === 'defaultProfile.linux'
              ? workspace.terminalProfile
              : workspace.persistentSessions,
        }),
      };
    },
  };
  const commands = [];
  const messages = [];

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'initialize' }),
    },
    vscodeApi: {
      workspace,
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
      commands: {
        async executeCommand(command) {
          commands.push(command);
          workspace.workspaceFolders = [{ uri: { fsPath: activeLink } }];
          throw new Error('Canceled');
        },
      },
    },
    fileSystem: {
      existsSync() {
        return false;
      },
      readFileSync() {
        return fixtureContent;
      },
      realpathSync(target) {
        assert.equal(target, activeLink);
        return laneA;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, ['projectLanes.initializeWorkspace']);
  assert.deepEqual(messages, ['E2E PASS: initialize command created the managed workspace']);
});

test('the managed-restart phase verifies terminal settings and restored lane switching', async () => {
  const { run } = require('./suite/workspace-manual-initialization.cjs');
  const workspaceDirectory = '/tmp/project-lanes-e2e-manual-restart/workspace';
  const activeLink = path.join(workspaceDirectory, '.lanes-root', 'active');
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const commands = [];
  const messages = [];
  let activeTarget = laneA;

  await run({
    environment: {
      PROJECT_LANES_E2E_PAYLOAD: JSON.stringify({ phase: 'managed-restart' }),
    },
    vscodeApi: {
      workspace: {
        workspaceFile: {
          fsPath: path.join(workspaceDirectory, 'workspace-manual-initialization.code-workspace'),
        },
        workspaceFolders: [{ uri: { fsPath: activeLink } }],
        getConfiguration() {
          return {
            inspect(key) {
              return {
                workspaceValue: key === 'defaultProfile.linux' ? 'Lane Terminal' : false,
              };
            },
          };
        },
      },
      extensions: {
        getExtension() {
          return { isActive: true, async activate() {} };
        },
      },
      commands: {
        async executeCommand(command, laneId) {
          commands.push([command, laneId]);
          activeTarget = laneId === 'lane-a' ? laneA : laneB;
        },
      },
    },
    fileSystem: {
      realpathSync(target) {
        assert.equal(target, activeLink);
        return activeTarget;
      },
    },
    log(message) {
      messages.push(message);
    },
  });

  assert.deepEqual(commands, [
    ['projectLanes.switchLane', 'lane-b'],
    ['projectLanes.switchLane', 'lane-a'],
  ]);
  assert.deepEqual(messages, ['E2E PASS: manual initialization catalog restored after restart']);
});

test('process exit removes active scenario roots without duplicate listeners', async () => {
  const handlers = new Map();
  const registrations = [];
  const removed = [];
  let temporaryRootIndex = 0;
  const processApi = {
    pid: 123,
    once(event, handler) {
      registrations.push(event);
      handlers.set(event, handler);
    },
    kill() {},
  };
  const fileSystem = createFixtureFileSystem('/tmp/unused', {
    mkdtempSync() {
      temporaryRootIndex += 1;
      return `/tmp/project-lanes-e2e-exit-${temporaryRootIndex}`;
    },
    rmSync(target) {
      removed.push(target);
    },
  });

  await runScenario(
    emptyWorkspaceScenario,
    createScenarioDependencies('/tmp/unused', {
      fileSystem,
      processApi,
    }),
  );
  await runScenario(
    emptyWorkspaceScenario,
    createScenarioDependencies('/tmp/unused', {
      fileSystem,
      processApi,
      launchVSCode: async () => handlers.get('exit')(),
    }),
  );

  assert.deepEqual(registrations, ['exit', 'SIGTERM']);
  assert.deepEqual(removed, ['/tmp/project-lanes-e2e-exit-1', '/tmp/project-lanes-e2e-exit-2']);
});

test('SIGTERM removes the active scenario root before re-raising the signal', async () => {
  const handlers = new Map();
  const removed = [];
  const killed = [];
  const processApi = {
    pid: 456,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      killed.push({ pid, signal });
    },
  };
  const fileSystem = createFixtureFileSystem('/tmp/project-lanes-e2e-sigterm', {
    rmSync(target) {
      removed.push(target);
    },
  });

  await runScenario(
    emptyWorkspaceScenario,
    createScenarioDependencies('/tmp/project-lanes-e2e-sigterm', {
      fileSystem,
      processApi,
      launchVSCode: async () => handlers.get('SIGTERM')(),
    }),
  );

  assert.deepEqual(removed, ['/tmp/project-lanes-e2e-sigterm']);
  assert.deepEqual(killed, [{ pid: 456, signal: 'SIGTERM' }]);
});

test('cleanup failures do not block remaining roots or SIGTERM re-raise', () => {
  const handlers = new Map();
  const cleaned = [];
  const cleanupErrors = [];
  const killed = [];
  const processApi = {
    pid: 789,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
      killed.push({ pid, signal });
    },
  };
  const cleanupRegistry = createProcessCleanupRegistry(processApi, {
    reportCleanupError(error) {
      cleanupErrors.push(error.message);
    },
  });
  cleanupRegistry.activeCleanups.add(() => {
    throw new Error('cleanup failed');
  });
  cleanupRegistry.activeCleanups.add(() => {
    cleaned.push('second root');
  });

  handlers.get('SIGTERM')();

  assert.deepEqual(cleanupErrors, ['cleanup failed']);
  assert.deepEqual(cleaned, ['second root']);
  assert.deepEqual(killed, [{ pid: 789, signal: 'SIGTERM' }]);
});

test('a failed root cleanup remains registered for process-exit retry', async () => {
  const handlers = new Map();
  let cleanupAttempts = 0;
  const processApi = {
    pid: 987,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill() {},
  };
  const fileSystem = createFixtureFileSystem('/tmp/project-lanes-e2e-retry', {
    rmSync() {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error('cleanup failed');
    },
  });

  await assert.rejects(
    runScenario(
      emptyWorkspaceScenario,
      createScenarioDependencies('/tmp/project-lanes-e2e-retry', {
        fileSystem,
        processApi,
      }),
    ),
    /cleanup failed/,
  );
  handlers.get('exit')();

  assert.equal(cleanupAttempts, 2);
});

test('scenario and cleanup failures are both reported', async () => {
  const processApi = {
    pid: 654,
    once() {},
    kill() {},
  };
  const fileSystem = createFixtureFileSystem('/tmp/project-lanes-e2e-aggregate-error', {
    rmSync() {
      throw new Error('cleanup failed');
    },
  });

  await assert.rejects(
    runScenario(
      emptyWorkspaceScenario,
      createScenarioDependencies('/tmp/project-lanes-e2e-aggregate-error', {
        fileSystem,
        processApi,
        launchVSCode: async () => {
          throw new Error('scenario failed');
        },
      }),
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((cause) => cause.message),
        ['scenario failed', 'cleanup failed'],
      );
      return true;
    },
  );
});

test('no names selects every registered scenario', () => {
  assert.deepEqual(resolveScenarios([]), scenarios);
});

test('one or more names selects only those scenarios in argument order', () => {
  const available = [
    {
      name: 'alpha',
      workspaceFixture: '/fixtures/alpha.code-workspace',
      suitePath: '/suite/alpha.cjs',
    },
    {
      name: 'beta',
      workspaceFixture: '/fixtures/beta.code-workspace',
      suitePath: '/suite/beta.cjs',
    },
  ];

  assert.deepEqual(resolveScenarios(['beta', 'alpha'], available), [available[1], available[0]]);
});

test('an unknown name fails with the unknown scenario in the message', () => {
  assert.throws(() => resolveScenarios(['missing']), /Unknown E2E scenario: missing/);
});

test('resolving an empty registry fails', () => {
  assert.throws(() => resolveScenarios([], []), /No E2E scenarios selected/);
});
