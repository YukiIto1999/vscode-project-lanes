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
const FORCE_KILL_CONFIRMATION_MS = 5_000;
const FORCE_KILL_GRACE_MS = 5_000;
const LAUNCH_TIMEOUT_MS = 120_000;
const PROCESS_GROUP_PROBE_MS = 50;
const PROCESS_TERMINATION_UNCONFIRMED_CODE = 'ERR_VSCODE_PROCESS_TERMINATION_UNCONFIRMED';
const PROJECT_LANES_EXTENSION_ID = 'yukiito1999.project-lanes';
const VSCODE_VERSION = '1.101.0';
const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
const driverDevelopmentPath = path.join(__dirname, 'driver');
const processCleanupRegistries = new WeakMap();

const identifyProcessTerminationUnconfirmed = (error) =>
  Object.assign(error, { code: PROCESS_TERMINATION_UNCONFIRMED_CODE });

const createProcessTerminationUnconfirmedError = (cause) =>
  identifyProcessTerminationUnconfirmed(
    new Error(
      `VS Code process termination failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    ),
  );

const isProcessTerminationUnconfirmedError = (error) =>
  error?.code === PROCESS_TERMINATION_UNCONFIRMED_CODE;

const preserveRootWhenCleanupIsUnsafe = (error, cleanupRegistry, cleanup) => {
  if (!cleanupRegistry.cleanupSuppressed && !isProcessTerminationUnconfirmedError(error)) {
    return false;
  }
  cleanupRegistry.activeCleanups.delete(cleanup);
  return true;
};

const waitForTerminationCleanupDecision = async (cleanupRegistry) => {
  if (cleanupRegistry.terminationCompletion) {
    await cleanupRegistry.terminationCompletion;
  }
};

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
    cleanupSuppressed: false,
    terminationCompletion: undefined,
    terminationRequested: false,
  };
  const cleanupAll = () => {
    if (cleanupRegistry.cleanupSuppressed) return;
    for (const cleanup of activeCleanups) {
      try {
        cleanup();
        activeCleanups.delete(cleanup);
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
    const completeTermination = async () => {
      const terminations = [...activeTerminations].map((terminate) => {
        try {
          return terminate();
        } catch (error) {
          return Promise.reject(error);
        }
      });
      if (terminations.length === 0) {
        cleanupAndReraise();
        return;
      }
      const results = await Promise.allSettled(terminations);
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (failures.length > 0) {
        cleanupRegistry.cleanupSuppressed = true;
        reportCleanupError(
          identifyProcessTerminationUnconfirmed(
            new AggregateError(failures, 'VS Code process termination failed'),
          ),
        );
        processApi.kill(processApi.pid, 'SIGTERM');
        return;
      }
      cleanupAndReraise();
    };
    cleanupRegistry.terminationCompletion = completeTermination();
    return cleanupRegistry.terminationCompletion;
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

const runInstalledVSIXVerification = async (
  { vscodeExecutablePath, vsixPath, candidateVersion, baselineVersion },
  {
    createRunId = () => crypto.randomUUID(),
    environment = process.env,
    fileSystem = fs,
    installExtension = installAndVerifyExtension,
    launchVSCode = launchVSCodeProcess,
    processApi = process,
    temporaryDirectory = os.tmpdir(),
    freshWorkspaceFixture = path.join(__dirname, 'fixtures', 'empty.code-workspace'),
    upgradeFixtureRoot = path.join(__dirname, 'fixtures', 'workspace-bootstrap'),
    upgradeWorkspaceFixture = path.join(
      __dirname,
      'fixtures',
      'workspace-bootstrap',
      'workspace-bootstrap.code-workspace',
    ),
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
    for (const profile of Object.values(profiles)) {
      fileSystem.mkdirSync(profile.userDataDir, { recursive: true });
      fileSystem.mkdirSync(profile.extensionsDir, { recursive: true });
    }
    const freshWorkspaceDirectory = path.join(temporaryRoot, 'fresh', 'workspace');
    const freshWorkspacePath = path.join(
      freshWorkspaceDirectory,
      path.basename(freshWorkspaceFixture),
    );
    const upgradeWorkspaceDirectory = path.join(temporaryRoot, 'upgrade', 'workspace');
    const upgradeWorkspacePath = path.join(
      upgradeWorkspaceDirectory,
      path.basename(upgradeWorkspaceFixture),
    );
    fileSystem.mkdirSync(freshWorkspaceDirectory, { recursive: true });
    fileSystem.copyFileSync(freshWorkspaceFixture, freshWorkspacePath);
    fileSystem.cpSync(upgradeFixtureRoot, upgradeWorkspaceDirectory, { recursive: true });

    const install = (profile, extensionReference, expectedVersion) =>
      installExtension({
        vscodeExecutablePath,
        ...profile,
        extensionReference,
        extensionId: PROJECT_LANES_EXTENSION_ID,
        expectedVersion,
      });
    const runId = createRunId();
    const launch = async ({ profileName, profile, workspacePath, phase, expectedVersion }) => {
      if (cleanupRegistry.terminationRequested) return;
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
          markerPath: path.join(temporaryRoot, `${profileName}-${phase}-result.json`),
          resultIdentity: {
            runId,
            scenario: scenario.name,
            phase,
          },
          launch: { phase },
          expectedVersion,
          environment,
        }),
      );
    };

    install(profiles.fresh, vsixPath, candidateVersion);
    await launch({
      profileName: 'fresh',
      profile: profiles.fresh,
      workspacePath: freshWorkspacePath,
      phase: 'fresh',
      expectedVersion: candidateVersion,
    });

    install(profiles.upgrade, `${PROJECT_LANES_EXTENSION_ID}@${baselineVersion}`, baselineVersion);
    await launch({
      profileName: 'upgrade',
      profile: profiles.upgrade,
      workspacePath: upgradeWorkspacePath,
      phase: 'baseline-create-v1',
      expectedVersion: baselineVersion,
    });

    install(profiles.upgrade, vsixPath, candidateVersion);
    await launch({
      profileName: 'upgrade',
      profile: profiles.upgrade,
      workspacePath: upgradeWorkspacePath,
      phase: 'candidate-migrate',
      expectedVersion: candidateVersion,
    });
    await launch({
      profileName: 'upgrade',
      profile: profiles.upgrade,
      workspacePath: upgradeWorkspacePath,
      phase: 'candidate-restart',
      expectedVersion: candidateVersion,
    });
  } catch (error) {
    verificationError = error;
  }

  await waitForTerminationCleanupDecision(cleanupRegistry);
  if (preserveRootWhenCleanupIsUnsafe(verificationError, cleanupRegistry, cleanup)) {
    if (verificationError) throw verificationError;
    return;
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
  launch,
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
  if (launch) launchEnvironment[E2E_PAYLOAD_KEY] = JSON.stringify(launch);

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
    childAlreadyClosed = false,
    confirmationMilliseconds = FORCE_KILL_CONFIRMATION_MS,
    graceMilliseconds = FORCE_KILL_GRACE_MS,
    probeMilliseconds = PROCESS_GROUP_PROBE_MS,
    probeProcessGroup,
    signalProcess = (signal) => child.kill(signal),
  } = {},
) =>
  new Promise((resolve, reject) => {
    let confirmationTimeout;
    let graceTimeout;
    let probeTimeout;
    let childClosed = childAlreadyClosed;
    let groupGone = probeProcessGroup === undefined;
    let killSent = false;
    let settled = false;

    const cancelTimers = () => {
      if (confirmationTimeout !== undefined) cancelTimeout(confirmationTimeout);
      if (graceTimeout !== undefined) cancelTimeout(graceTimeout);
      if (probeTimeout !== undefined) cancelTimeout(probeTimeout);
    };
    const finish = () => {
      if (settled || !childClosed || !groupGone) return;
      settled = true;
      cancelTimers();
      child.removeListener?.('close', onClose);
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cancelTimers();
      child.removeListener?.('close', onClose);
      reject(error);
    };
    const scheduleProbe = () => {
      if (settled || probeTimeout !== undefined) return;
      probeTimeout = scheduleTimeout(() => {
        probeTimeout = undefined;
        observeGroup();
      }, probeMilliseconds);
    };
    const observeGroup = () => {
      if (settled || probeProcessGroup === undefined || groupGone) return;
      try {
        groupGone = !probeProcessGroup();
      } catch (error) {
        fail(error);
        return;
      }
      finish();
      if (!settled && killSent && !groupGone) scheduleProbe();
    };
    const onClose = () => {
      childClosed = true;
      observeGroup();
      finish();
    };
    const sendSignal = (signal) => {
      try {
        if (signalProcess(signal) === 'gone') groupGone = true;
      } catch (error) {
        fail(error);
      }
    };
    const escalate = () => {
      graceTimeout = undefined;
      killSent = true;
      sendSignal('SIGKILL');
      observeGroup();
      finish();
      if (settled) return;
      confirmationTimeout = scheduleTimeout(() => {
        confirmationTimeout = undefined;
        fail(
          new Error(
            `VS Code process did not exit within ${confirmationMilliseconds}ms after SIGKILL`,
          ),
        );
      }, confirmationMilliseconds);
    };

    if (!childAlreadyClosed) child.once('close', onClose);
    sendSignal('SIGINT');
    finish();
    if (settled || (probeProcessGroup !== undefined && groupGone)) return;
    graceTimeout = scheduleTimeout(escalate, graceMilliseconds);
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
  const usePosixProcessGroup = (processApi.platform ?? process.platform) !== 'win32';

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
      ...(usePosixProcessGroup ? { detached: true } : {}),
      env: environment,
      stdio: 'inherit',
    });
    const signalProcess = usePosixProcessGroup
      ? (signal) => {
          try {
            processApi.kill(-child.pid, signal);
            return 'sent';
          } catch (error) {
            if (error?.code === 'ESRCH') return 'gone';
            throw error;
          }
        }
      : (signal) => {
          child.kill(signal);
          return 'sent';
        };
    const probeProcessGroup = usePosixProcessGroup
      ? () => {
          try {
            processApi.kill(-child.pid, 0);
            return true;
          } catch (error) {
            if (error?.code === 'ESRCH') return false;
            throw error;
          }
        }
      : undefined;
    let terminationRequested = false;
    let terminationPromise;
    const terminate = ({ childAlreadyClosed = false } = {}) => {
      terminationRequested = true;
      terminationPromise ??= terminateChild(child, {
        scheduleTimeout,
        cancelTimeout,
        childAlreadyClosed,
        probeProcessGroup,
        signalProcess,
      });
      return terminationPromise;
    };
    activeTerminations.add(terminate);
    const timeout = scheduleTimeout(async () => {
      if (settled) return;
      timedOut = true;
      try {
        await terminate();
      } catch (error) {
        settle(() => reject(createProcessTerminationUnconfirmedError(error)));
        return;
      }
      settle(() => reject(new Error(`VS Code launch timed out after ${timeoutMilliseconds}ms`)));
    }, timeoutMilliseconds);

    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', async (code, signal) => {
      const terminationWasRequested = terminationRequested;
      if (terminationWasRequested) {
        // A fast child can close while terminateChild is still assigning its promise.
        if (terminationPromise === undefined) await Promise.resolve();
        try {
          await terminationPromise;
        } catch {
          return;
        }
      } else if (usePosixProcessGroup) {
        try {
          if (probeProcessGroup()) await terminate({ childAlreadyClosed: true });
        } catch (error) {
          settle(() => reject(createProcessTerminationUnconfirmedError(error)));
          return;
        }
      }
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

  await waitForTerminationCleanupDecision(cleanupRegistry);
  if (preserveRootWhenCleanupIsUnsafe(scenarioError, cleanupRegistry, cleanup)) {
    if (scenarioFailed) throw scenarioError;
    return;
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
  launchVSCodeProcess,
  runInstalledVSIXVerification,
  runScenario,
};
