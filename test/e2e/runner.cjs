'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCliArgsFromVSCodeExecutablePath } = require('@vscode/test-electron');

const DEFAULT_CACHE_PATH = '/tmp/vscode-project-lanes-vscode-test-cache';
const E2E_EXPECTED_EXTENSIONS_DIR_KEY = 'PROJECT_LANES_E2E_EXPECTED_EXTENSIONS_DIR';
const E2E_EXPECTED_VERSION_KEY = 'PROJECT_LANES_E2E_EXPECTED_VERSION';
const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const E2E_RESULT_PATH_KEY = 'PROJECT_LANES_E2E_RESULT_PATH';
const E2E_RUN_KEY = 'PROJECT_LANES_E2E_RUN';
const E2E_SUITE_PATH_KEY = 'PROJECT_LANES_E2E_SUITE_PATH';
const FORCE_KILL_GRACE_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const PROJECT_LANES_EXTENSION_ID = 'yukiito1999.project-lanes';
const VSCODE_VERSION = '1.101.0';
const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
const driverDevelopmentPath = path.join(__dirname, 'driver');
const processCleanupRegistries = new WeakMap();

const createProcessCleanupRegistry = (
  processApi,
  {
    reportCleanupError = (error) => {
      console.error('E2E cleanup failed:', error);
    },
  } = {},
) => {
  const activeCleanups = new Set();
  const activeTerminations = new Set();
  const cleanupRegistry = {
    activeCleanups,
    activeTerminations,
    terminationRequested: false,
  };
  const cleanupAll = () => {
    for (const cleanup of activeCleanups) {
      try {
        cleanup();
      } catch (error) {
        reportCleanupError(error);
      }
    }
  };
  const cleanupAndReraise = () => {
    cleanupAll();
    processApi.kill(processApi.pid, 'SIGTERM');
  };

  processApi.once('exit', cleanupAll);
  processApi.once('SIGTERM', () => {
    cleanupRegistry.terminationRequested = true;
    const terminations = [...activeTerminations].map((terminate) => terminate());
    if (terminations.length === 0) {
      cleanupAndReraise();
      return;
    }
    return Promise.allSettled(terminations).then(cleanupAndReraise);
  });
  return cleanupRegistry;
};

const getProcessCleanupRegistry = (processApi) => {
  const existingRegistry = processCleanupRegistries.get(processApi);
  if (existingRegistry) return existingRegistry;

  const cleanupRegistry = createProcessCleanupRegistry(processApi);
  processCleanupRegistries.set(processApi, cleanupRegistry);
  return cleanupRegistry;
};

const buildDownloadOptions = (environment = process.env) => ({
  version: VSCODE_VERSION,
  cachePath: environment.PROJECT_LANES_VSCODE_TEST_CACHE || DEFAULT_CACHE_PATH,
});

const buildExtensionManagementRequest = ({
  vscodeExecutablePath,
  userDataDir,
  extensionsDir,
  operationArgs,
  resolveCliArgs = resolveCliArgsFromVSCodeExecutablePath,
}) => {
  const [command, ...cliArgs] = resolveCliArgs(vscodeExecutablePath, {
    reuseMachineInstall: true,
  });
  return {
    command,
    args: [
      ...cliArgs,
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      ...operationArgs,
    ],
  };
};

const assertListedExtensionVersion = (output, extensionId, expectedVersion) => {
  const expected = `${extensionId}@${expectedVersion}`;
  const listed = output.trimEnd() === '' ? [] : output.trimEnd().split(/\r?\n/);
  if (listed.length !== 1 || listed[0] !== expected) {
    throw new Error(
      `Expected installed extensions to equal ${expected}, received ${JSON.stringify(listed)}`,
    );
  }
};

const executeExtensionManagementRequest = (
  { command, args },
  { environment = process.env, spawnSync = childProcess.spawnSync } = {},
) => {
  const cliEnvironment = { ...environment };
  delete cliEnvironment.ELECTRON_RUN_AS_NODE;
  delete cliEnvironment.VSCODE_ESM_ENTRYPOINT;
  delete cliEnvironment.VSCODE_IPC_HOOK_CLI;
  cliEnvironment.DONT_PROMPT_WSL_INSTALL = '1';
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: cliEnvironment,
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `VS Code CLI failed (${command} ${args.join(' ')}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
};

const installAndVerifyExtension = (
  {
    vscodeExecutablePath,
    userDataDir,
    extensionsDir,
    extensionReference,
    extensionId,
    expectedVersion,
    resolveCliArgs,
  },
  { executeRequest = executeExtensionManagementRequest } = {},
) => {
  const buildRequest = (operationArgs) =>
    buildExtensionManagementRequest({
      vscodeExecutablePath,
      userDataDir,
      extensionsDir,
      operationArgs,
      resolveCliArgs,
    });

  executeRequest(buildRequest(['--install-extension', extensionReference, '--force']));
  const listedExtensions = executeRequest(buildRequest(['--list-extensions', '--show-versions']));
  assertListedExtensionVersion(listedExtensions, extensionId, expectedVersion);
};

const installCandidateProfiles = (
  { vscodeExecutablePath, vsixPath, candidateVersion, baselineVersion, profiles },
  { installExtension = installAndVerifyExtension } = {},
) => {
  installExtension({
    vscodeExecutablePath,
    ...profiles.fresh,
    extensionReference: vsixPath,
    extensionId: PROJECT_LANES_EXTENSION_ID,
    expectedVersion: candidateVersion,
  });
  installExtension({
    vscodeExecutablePath,
    ...profiles.upgrade,
    extensionReference: `${PROJECT_LANES_EXTENSION_ID}@${baselineVersion}`,
    extensionId: PROJECT_LANES_EXTENSION_ID,
    expectedVersion: baselineVersion,
  });
  installExtension({
    vscodeExecutablePath,
    ...profiles.upgrade,
    extensionReference: vsixPath,
    extensionId: PROJECT_LANES_EXTENSION_ID,
    expectedVersion: candidateVersion,
  });
};

const runInstalledVSIXVerification = async (
  { vscodeExecutablePath, vsixPath, candidateVersion, baselineVersion },
  {
    createRunId = () => crypto.randomUUID(),
    environment = process.env,
    fileSystem = fs,
    installProfiles = installCandidateProfiles,
    launchVSCode = launchVSCodeProcess,
    processApi = process,
    temporaryDirectory = os.tmpdir(),
    workspaceFixture = path.join(__dirname, 'fixtures', 'empty.code-workspace'),
    suitePath = path.join(__dirname, 'suite', 'installed-vsix.cjs'),
  } = {},
) => {
  const cleanupRegistry = getProcessCleanupRegistry(processApi);
  const temporaryRoot = fileSystem.mkdtempSync(
    path.join(temporaryDirectory, 'project-lanes-installed-vsix-'),
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    fileSystem.rmSync(temporaryRoot, { recursive: true, force: true });
    cleaned = true;
    cleanupRegistry.activeCleanups.delete(cleanup);
  };
  cleanupRegistry.activeCleanups.add(cleanup);

  let verificationError;
  try {
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
    const workspaceDirectory = path.join(temporaryRoot, 'workspace');
    const workspacePath = path.join(workspaceDirectory, path.basename(workspaceFixture));
    for (const profile of Object.values(profiles)) {
      fileSystem.mkdirSync(profile.userDataDir, { recursive: true });
      fileSystem.mkdirSync(profile.extensionsDir, { recursive: true });
    }
    fileSystem.mkdirSync(workspaceDirectory, { recursive: true });
    fileSystem.copyFileSync(workspaceFixture, workspacePath);

    installProfiles({
      vscodeExecutablePath,
      vsixPath,
      candidateVersion,
      baselineVersion,
      profiles,
    });

    const runId = createRunId();
    for (const [profileName, profile] of Object.entries(profiles)) {
      if (cleanupRegistry.terminationRequested) break;
      const scenario = {
        name: `installed-vsix-${profileName}`,
        suitePath,
      };
      await launchVSCode(
        buildInstalledLaunchOptions({
          vscodeExecutablePath,
          scenario,
          workspacePath,
          ...profile,
          markerPath: path.join(temporaryRoot, `${profileName}-result.json`),
          resultIdentity: {
            runId,
            scenario: scenario.name,
            phase: 'default',
          },
          expectedVersion: candidateVersion,
          environment,
        }),
      );
    }
  } catch (error) {
    verificationError = error;
  }

  try {
    cleanup();
  } catch (cleanupError) {
    if (verificationError) {
      throw new AggregateError(
        [verificationError, cleanupError],
        'Installed VSIX verification and cleanup failed',
      );
    }
    throw cleanupError;
  }
  if (verificationError) throw verificationError;
};

const buildLaunchOptions = ({
  vscodeExecutablePath,
  scenario,
  workspacePath,
  userDataDir,
  extensionsDir,
  markerPath,
  resultIdentity,
  launch,
  environment = process.env,
}) => {
  const launchEnvironment = { ...environment };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  delete launchEnvironment.VSCODE_ESM_ENTRYPOINT;
  Object.assign(launchEnvironment, {
    [E2E_RESULT_PATH_KEY]: markerPath,
    [E2E_RUN_KEY]: JSON.stringify(resultIdentity),
    [E2E_SUITE_PATH_KEY]: scenario.suitePath,
  });
  if (launch) launchEnvironment[E2E_PAYLOAD_KEY] = JSON.stringify(launch);

  const options = {
    command: vscodeExecutablePath,
    args: [
      workspacePath,
      '--disable-extensions',
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
      `--extensionDevelopmentPath=${driverDevelopmentPath}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      '--disable-workspace-trust',
    ],
    environment: launchEnvironment,
    markerPath,
  };
  return options;
};

const buildInstalledLaunchOptions = ({
  vscodeExecutablePath,
  scenario,
  workspacePath,
  userDataDir,
  extensionsDir,
  markerPath,
  resultIdentity,
  expectedVersion,
  environment = process.env,
}) => {
  const launchEnvironment = { ...environment };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  delete launchEnvironment.VSCODE_ESM_ENTRYPOINT;
  Object.assign(launchEnvironment, {
    [E2E_EXPECTED_EXTENSIONS_DIR_KEY]: extensionsDir,
    [E2E_EXPECTED_VERSION_KEY]: expectedVersion,
    [E2E_RESULT_PATH_KEY]: markerPath,
    [E2E_RUN_KEY]: JSON.stringify(resultIdentity),
    [E2E_SUITE_PATH_KEY]: scenario.suitePath,
  });

  return {
    command: vscodeExecutablePath,
    args: [
      workspacePath,
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      `--extensionDevelopmentPath=${driverDevelopmentPath}`,
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-cached-data',
      '--disable-workspace-trust',
    ],
    environment: launchEnvironment,
    markerPath,
  };
};

const parseResultMarker = (serialized, expectedIdentity) => {
  const marker = JSON.parse(serialized);
  if (
    marker.runId !== expectedIdentity.runId ||
    marker.scenario !== expectedIdentity.scenario ||
    marker.phase !== expectedIdentity.phase
  ) {
    throw new Error(
      `Unexpected E2E result identity: expected ${JSON.stringify(expectedIdentity)}, received ${JSON.stringify(
        {
          runId: marker.runId,
          scenario: marker.scenario,
          phase: marker.phase,
        },
      )}`,
    );
  }
  if (marker.status === 'FAIL') {
    throw new Error(marker.error?.message || 'E2E driver reported failure');
  }
  if (marker.status !== 'PASS') {
    throw new Error(`Unexpected E2E result status: ${String(marker.status)}`);
  }
  return marker;
};

const terminateChild = (
  child,
  {
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout,
    graceMilliseconds = FORCE_KILL_GRACE_MS,
  } = {},
) =>
  new Promise((resolve) => {
    let graceTimeout;
    let terminated = false;
    const finish = () => {
      if (terminated) return;
      terminated = true;
      if (graceTimeout !== undefined) cancelTimeout(graceTimeout);
      resolve();
    };

    child.once('close', finish);
    child.kill('SIGINT');
    if (terminated) return;
    graceTimeout = scheduleTimeout(() => {
      graceTimeout = undefined;
      child.kill('SIGKILL');
    }, graceMilliseconds);
  });

const launchVSCodeProcess = (
  { command, args, environment, markerPath, resultIdentity },
  {
    fileSystem = fs,
    spawn = childProcess.spawn,
    log = (message) => console.log(message),
    processApi = process,
    scheduleTimeout = setTimeout,
    cancelTimeout = clearTimeout,
    timeoutMilliseconds = LAUNCH_TIMEOUT_MS,
  } = {},
) => {
  if (fileSystem.existsSync(markerPath)) {
    return Promise.reject(new Error(`E2E result marker already exists: ${markerPath}`));
  }

  const expectedIdentity = resultIdentity ?? JSON.parse(environment[E2E_RUN_KEY] || 'null');
  const activeTerminations = getProcessCleanupRegistry(processApi).activeTerminations;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;

    const settle = (action) => {
      if (settled) return;
      settled = true;
      cancelTimeout(timeout);
      activeTerminations.delete(terminate);
      action();
    };

    const child = spawn(command, args, {
      env: environment,
      stdio: 'inherit',
    });
    let terminationPromise;
    const terminate = () => {
      terminationPromise ??= terminateChild(child, {
        scheduleTimeout,
        cancelTimeout,
      });
      return terminationPromise;
    };
    activeTerminations.add(terminate);
    const timeout = scheduleTimeout(async () => {
      if (settled) return;
      timedOut = true;
      await terminate();
      settle(() => reject(new Error(`VS Code launch timed out after ${timeoutMilliseconds}ms`)));
    }, timeoutMilliseconds);

    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code, signal) => {
      if (timedOut) return;
      settle(() => {
        if (code !== 0) {
          reject(
            new Error(`VS Code exited with code ${String(code)}${signal ? ` (${signal})` : ''}`),
          );
          return;
        }
        try {
          const marker = parseResultMarker(
            fileSystem.readFileSync(markerPath, 'utf8'),
            expectedIdentity,
          );
          log(marker.message);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  });
};

const runScenario = async (
  scenario,
  {
    launchVSCode,
    vscodeExecutablePath,
    createRunId = () => crypto.randomUUID(),
    fileSystem = fs,
    temporaryDirectory = os.tmpdir(),
    environment = process.env,
    processApi = process,
  },
) => {
  const cleanupRegistry = getProcessCleanupRegistry(processApi);
  const temporaryRoot = fileSystem.mkdtempSync(
    path.join(temporaryDirectory, `project-lanes-e2e-${scenario.name}-`),
  );
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    fileSystem.rmSync(temporaryRoot, { recursive: true, force: true });
    cleaned = true;
    cleanupRegistry.activeCleanups.delete(cleanup);
  };
  cleanupRegistry.activeCleanups.add(cleanup);

  let scenarioFailed = false;
  let scenarioError;
  try {
    const userDataDir = path.join(temporaryRoot, 'user-data');
    const extensionsDir = path.join(temporaryRoot, 'extensions');
    const workspaceDir = path.join(temporaryRoot, 'workspace');
    const workspacePath = path.join(workspaceDir, path.basename(scenario.workspaceFixture));

    fileSystem.mkdirSync(userDataDir);
    fileSystem.mkdirSync(extensionsDir);
    if (scenario.fixtureRoot) {
      fileSystem.cpSync(scenario.fixtureRoot, workspaceDir, { recursive: true });
    } else {
      fileSystem.mkdirSync(workspaceDir);
      fileSystem.copyFileSync(scenario.workspaceFixture, workspacePath);
    }

    const runId = createRunId();
    const launches = scenario.launches ?? [undefined];
    for (const [launchIndex, launch] of launches.entries()) {
      if (cleanupRegistry.terminationRequested) break;
      const resultIdentity = {
        runId,
        scenario: scenario.name,
        phase: launch?.phase ?? 'default',
      };
      await launchVSCode(
        buildLaunchOptions({
          vscodeExecutablePath,
          scenario,
          workspacePath,
          userDataDir,
          extensionsDir,
          markerPath: path.join(temporaryRoot, `launch-${launchIndex}.json`),
          resultIdentity,
          launch,
          environment,
        }),
      );
    }
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  }

  try {
    cleanup();
  } catch (cleanupError) {
    if (scenarioFailed) {
      throw new AggregateError(
        [scenarioError, cleanupError],
        `E2E scenario and cleanup failed: ${scenario.name}`,
      );
    }
    throw cleanupError;
  }

  if (scenarioFailed) throw scenarioError;
};

module.exports = {
  assertListedExtensionVersion,
  buildDownloadOptions,
  buildExtensionManagementRequest,
  buildInstalledLaunchOptions,
  buildLaunchOptions,
  createProcessCleanupRegistry,
  executeExtensionManagementRequest,
  installAndVerifyExtension,
  installCandidateProfiles,
  launchVSCodeProcess,
  runInstalledVSIXVerification,
  runScenario,
};
