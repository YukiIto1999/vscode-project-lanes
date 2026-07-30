'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require('../../package.json');
const {
  buildDownloadOptions,
  buildLaunchOptions,
  createProcessCleanupRegistry,
  launchVSCodeProcess,
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
        env: { HOME: '/home/tester' },
        stdio: 'inherit',
      },
    },
  ]);
  assert.deepEqual(messages, ['E2E PASS: normal launch']);
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

test('a normal VS Code launch timeout escalates from SIGINT to SIGKILL and waits for close', async () => {
  const child = new EventEmitter();
  child.pid = 246;
  const events = [];
  child.kill = (signal) => {
    events.push(`kill-${signal}`);
    if (signal === 'SIGKILL') {
      events.push('child-close');
      child.emit('close', null, signal);
    }
  };

  await assert.rejects(
    launchVSCodeProcess(
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
          events.push(`schedule-${milliseconds}`);
          queueMicrotask(handler);
          return milliseconds;
        },
        spawn() {
          return child;
        },
      },
    ),
    /VS Code launch timed out after 120000ms/,
  );
  assert.deepEqual(events, [
    'schedule-120000',
    'kill-SIGINT',
    'schedule-5000',
    'kill-SIGKILL',
    'child-close',
  ]);
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

  assert.deepEqual(events, ['terminate', 'child-close', 'cleanup', 'reraise-246-SIGTERM']);
});

test('SIGTERM latched during a successful launch prevents the next launch before cleanup', async () => {
  const handlers = new Map();
  const events = [];
  const processApi = {
    pid: 357,
    once(event, handler) {
      handlers.set(event, handler);
    },
    kill(pid, signal) {
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
  firstChild.kill = (signal) => {
    events.push(`launch-1-kill-${signal}`);
    queueMicrotask(() => {
      events.push('launch-1-close');
      firstChild.emit('close', 0, null);
    });
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
          spawn() {
            return firstChild;
          },
        });
      },
    }),
  );

  const signalHandling = handlers.get('SIGTERM')();
  await Promise.all([runPromise, signalHandling]);

  assert.equal(launchCount, 1);
  assert.deepEqual(events, [
    'launch-1-spawn',
    'launch-1-kill-SIGINT',
    'launch-1-close',
    'cleanup',
    'reraise-357-SIGTERM',
  ]);
});

test('the driver extension activates on startup without defining an extension test path', () => {
  const manifest = require('./driver/package.json');

  assert.equal(manifest.main, './extension.cjs');
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
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
