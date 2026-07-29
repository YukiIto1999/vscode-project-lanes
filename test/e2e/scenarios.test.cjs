'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../../package.json');
const { buildRunTestsOptions, createProcessCleanupRegistry, runScenario } = require('./runner.cjs');
const { resolveScenarios, scenarios } = require('./scenarios.cjs');

test('the empty-workspace scenario binds its fixture to its dedicated suite', () => {
  assert.deepEqual(scenarios, [
    {
      name: 'empty-workspace',
      workspaceFixture: path.join(__dirname, 'fixtures', 'empty.code-workspace'),
      extensionTestsPath: path.join(__dirname, 'suite', 'empty-workspace.cjs'),
    },
  ]);
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

test('the E2E package script gates scenarios on the registry unit tests', () => {
  assert.equal(
    packageJson.scripts['test:e2e'],
    'node --test test/e2e/scenarios.test.cjs && node test/e2e/run.cjs',
  );
});

test('runTests options use the pinned version, external cache, and scenario suite', () => {
  const options = buildRunTestsOptions({
    scenario: {
      extensionTestsPath: '/suite/empty-workspace.cjs',
    },
    workspacePath: '/tmp/scenario/workspace/empty.code-workspace',
    userDataDir: '/tmp/scenario/user-data',
    extensionsDir: '/tmp/scenario/extensions',
    environment: {},
  });

  assert.deepEqual(options, {
    version: '1.101.0',
    cachePath: '/tmp/vscode-project-lanes-vscode-test-cache',
    extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
    extensionTestsPath: '/suite/empty-workspace.cjs',
    launchArgs: [
      '/tmp/scenario/workspace/empty.code-workspace',
      '--disable-extensions',
      '--user-data-dir',
      '/tmp/scenario/user-data',
      '--extensions-dir',
      '/tmp/scenario/extensions',
    ],
  });
});

test('the VS Code download cache can be overridden outside the repository', () => {
  const options = buildRunTestsOptions({
    scenario: {
      extensionTestsPath: '/suite/empty-workspace.cjs',
    },
    workspacePath: '/tmp/scenario/workspace/empty.code-workspace',
    userDataDir: '/tmp/scenario/user-data',
    extensionsDir: '/tmp/scenario/extensions',
    environment: {
      PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
    },
  });

  assert.equal(options.cachePath, '/var/tmp/project-lanes-vscode-cache');
});

test('a scenario setup failure removes its temporary root', async () => {
  const removed = [];
  const temporaryRoot = '/tmp/project-lanes-e2e-empty-workspace-test';
  const fileSystem = {
    mkdtempSync() {
      return temporaryRoot;
    },
    mkdirSync() {
      throw new Error('setup failed');
    },
    rmSync(target, options) {
      removed.push({ target, options });
    },
  };

  await assert.rejects(
    runScenario(
      {
        name: 'empty-workspace',
        workspaceFixture: '/fixtures/empty.code-workspace',
        extensionTestsPath: '/suite/empty-workspace.cjs',
      },
      {
        fileSystem,
        runTests: async () => {},
        temporaryDirectory: '/tmp',
      },
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

test('a scenario passes its dedicated runTests options to VS Code', async () => {
  const temporaryRoot = '/tmp/project-lanes-e2e-empty-workspace-test';
  const scenario = {
    name: 'empty-workspace',
    workspaceFixture: '/fixtures/empty.code-workspace',
    extensionTestsPath: '/suite/empty-workspace.cjs',
  };
  const fileSystem = {
    mkdtempSync() {
      return temporaryRoot;
    },
    mkdirSync() {},
    copyFileSync() {},
    rmSync() {},
  };
  let receivedOptions;

  await runScenario(scenario, {
    fileSystem,
    runTests: async (options) => {
      receivedOptions = options;
    },
    temporaryDirectory: '/tmp',
    environment: {
      PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
    },
  });

  assert.deepEqual(
    receivedOptions,
    buildRunTestsOptions({
      scenario,
      workspacePath: path.join(
        temporaryRoot,
        'workspace',
        path.basename(scenario.workspaceFixture),
      ),
      userDataDir: path.join(temporaryRoot, 'user-data'),
      extensionsDir: path.join(temporaryRoot, 'extensions'),
      environment: {
        PROJECT_LANES_VSCODE_TEST_CACHE: '/var/tmp/project-lanes-vscode-cache',
      },
    }),
  );
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
  const fileSystem = {
    mkdtempSync() {
      temporaryRootIndex += 1;
      return `/tmp/project-lanes-e2e-exit-${temporaryRootIndex}`;
    },
    mkdirSync() {},
    copyFileSync() {},
    rmSync(target) {
      removed.push(target);
    },
  };
  const scenario = {
    name: 'empty-workspace',
    workspaceFixture: '/fixtures/empty.code-workspace',
    extensionTestsPath: '/suite/empty-workspace.cjs',
  };

  await runScenario(scenario, {
    fileSystem,
    processApi,
    runTests: async () => {},
    temporaryDirectory: '/tmp',
  });
  await runScenario(scenario, {
    fileSystem,
    processApi,
    runTests: async () => handlers.get('exit')(),
    temporaryDirectory: '/tmp',
  });

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
  const fileSystem = {
    mkdtempSync() {
      return '/tmp/project-lanes-e2e-sigterm';
    },
    mkdirSync() {},
    copyFileSync() {},
    rmSync(target) {
      removed.push(target);
    },
  };

  await runScenario(
    {
      name: 'empty-workspace',
      workspaceFixture: '/fixtures/empty.code-workspace',
      extensionTestsPath: '/suite/empty-workspace.cjs',
    },
    {
      fileSystem,
      processApi,
      runTests: async () => handlers.get('SIGTERM')(),
      temporaryDirectory: '/tmp',
    },
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
  const activeCleanups = createProcessCleanupRegistry(processApi, {
    reportCleanupError(error) {
      cleanupErrors.push(error.message);
    },
  });
  activeCleanups.add(() => {
    throw new Error('cleanup failed');
  });
  activeCleanups.add(() => {
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
  const fileSystem = {
    mkdtempSync() {
      return '/tmp/project-lanes-e2e-retry';
    },
    mkdirSync() {},
    copyFileSync() {},
    rmSync() {
      cleanupAttempts += 1;
      if (cleanupAttempts === 1) throw new Error('cleanup failed');
    },
  };

  await assert.rejects(
    runScenario(
      {
        name: 'empty-workspace',
        workspaceFixture: '/fixtures/empty.code-workspace',
        extensionTestsPath: '/suite/empty-workspace.cjs',
      },
      {
        fileSystem,
        processApi,
        runTests: async () => {},
        temporaryDirectory: '/tmp',
      },
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
  const fileSystem = {
    mkdtempSync() {
      return '/tmp/project-lanes-e2e-aggregate-error';
    },
    mkdirSync() {},
    copyFileSync() {},
    rmSync() {
      throw new Error('cleanup failed');
    },
  };

  await assert.rejects(
    runScenario(
      {
        name: 'empty-workspace',
        workspaceFixture: '/fixtures/empty.code-workspace',
        extensionTestsPath: '/suite/empty-workspace.cjs',
      },
      {
        fileSystem,
        processApi,
        runTests: async () => {
          throw new Error('scenario failed');
        },
        temporaryDirectory: '/tmp',
      },
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
      extensionTestsPath: '/suite/alpha.cjs',
    },
    {
      name: 'beta',
      workspaceFixture: '/fixtures/beta.code-workspace',
      extensionTestsPath: '/suite/beta.cjs',
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
