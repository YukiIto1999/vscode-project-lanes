'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deriveWorkspaceAnchor } = require('../workspace-anchor.cjs');

const E2E_PAYLOAD_KEY = 'PROJECT_LANES_E2E_PAYLOAD';
const EXTENSION_ID = 'yukiito1999.project-lanes';
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 12_000;
/** 旧版設定の確認で主操作を選んでから、設定の反映を待つ上限 */
const ACCEPT_SETTLE_TIMEOUT_MS = 3_000;
const WORKSPACE_FIXTURE = 'legacy-terminal-prompt.code-workspace';

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

  throw new Error(`Timed out waiting for legacy terminal prompt state: ${lastError.message}`, {
    cause: lastError,
  });
};

const readPhase = (environment) => {
  const serialized = environment[E2E_PAYLOAD_KEY];
  assert.ok(serialized, `Missing E2E payload: ${E2E_PAYLOAD_KEY}`);

  const payload = JSON.parse(serialized);
  if (payload.phase !== 'bootstrap' && payload.phase !== 'pending-prompt') {
    throw new Error(`Unknown E2E phase: ${String(payload.phase)}`);
  }
  return payload.phase;
};

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

const waitForSettlement = async (promise, message, timing) => {
  let settled = false;
  const observed = Promise.resolve(promise).finally(() => {
    settled = true;
  });
  observed.catch(() => {});
  await waitFor(() => assert.equal(settled, true, message), timing);
  return observed;
};

const isProcessAlive = (processApi, pid) => {
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
};

const run = async ({
  environment = process.env,
  fileSystem = fs,
  processApi = process,
  vscodeApi,
  delay,
  now,
  log = (message) => console.log(message),
} = {}) => {
  const phase = readPhase(environment);
  const resolvedVscodeApi = vscodeApi ?? require('vscode');
  const workspaceFile = resolvedVscodeApi.workspace.workspaceFile;
  assert.ok(workspaceFile, `Workspace file not found: ${WORKSPACE_FIXTURE}`);
  assert.equal(path.basename(workspaceFile.fsPath), WORKSPACE_FIXTURE);

  const extension = resolvedVscodeApi.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `Extension not found: ${EXTENSION_ID}`);
  // 旧版設定の確認は利用者が答えるまで閉じないため、確認前の状態は activation の完了を待たずに検証する
  const activation = Promise.resolve(extension.activate());
  activation.catch(() => {});

  const workspaceDirectory = path.dirname(workspaceFile.fsPath);
  const activeLink = deriveWorkspaceAnchor(workspaceFile).activeLinkPath;
  const laneA = path.join(workspaceDirectory, 'lane-a');
  const laneB = path.join(workspaceDirectory, 'lane-b');
  const waitForActiveLane = (expectedTarget) =>
    waitFor(
      () => {
        const folders = resolvedVscodeApi.workspace.workspaceFolders;
        assert.equal(folders?.length, 1, 'Expected one active workspace folder');
        assert.equal(path.resolve(folders[0].uri.fsPath), activeLink);
        assert.equal(path.resolve(fileSystem.realpathSync(activeLink)), expectedTarget);
      },
      { delay, now },
    );
  // extension host の再起動で suite が再実行された場合も追えるよう、進行を workspace 内へ追記する
  const progressPath = path.join(workspaceDirectory, `.e2e-progress-${phase}`);
  const mark = (step) => {
    try {
      fileSystem.appendFileSync(
        progressPath,
        `${new Date().toISOString()} pid=${processApi.pid} ${step}\n`,
      );
    } catch {
      // 進行記録は失敗時の診断用で、検証結果を左右させない
    }
  };
  const withProgress = (error) => {
    let progress = '';
    try {
      progress = fileSystem.readFileSync(progressPath, 'utf8');
    } catch {
      return error;
    }
    if (!(error instanceof Error)) return error;
    error.message = `${error.message}\nE2E progress:\n${progress}`;
    return error;
  };
  const describeState = () => {
    try {
      const terminal = resolvedVscodeApi.workspace.getConfiguration('terminal.integrated');
      const folders = (resolvedVscodeApi.workspace.workspaceFolders ?? []).map(
        (folder) => `${folder.name}=${path.relative(workspaceDirectory, folder.uri.fsPath)}`,
      );
      return `folders=[${folders.join(', ')}] persistentSessions=${String(
        terminal.inspect('enablePersistentSessions')?.workspaceValue,
      )} defaultProfile=${String(terminal.inspect('defaultProfile.linux')?.workspaceValue)}`;
    } catch (error) {
      return `state unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  mark(`suite started ${describeState()}`);

  try {
    await waitForActiveLane(laneA);
    mark('lane-a active');
    if (phase === 'bootstrap') {
      // 初期化後の extension host 再起動をこの launch 内で済ませ、確認待ちの launch へ持ち越さない
      try {
        await activation;
      } catch (error) {
        if (!isCancellation(error)) throw error;
      }
      await waitForActiveLane(laneA);
      log('E2E PASS: legacy terminal prompt workspace initialized');
      return;
    }

    const terminalConfiguration =
      resolvedVscodeApi.workspace.getConfiguration('terminal.integrated');
    const assertLegacyPromptPending = () => {
      assert.equal(
        terminalConfiguration.inspect('enablePersistentSessions')?.workspaceValue,
        false,
        'The legacy terminal settings prompt was answered before the scenario',
      );
    };
    assertLegacyPromptPending();

    let terminal;
    await waitFor(
      () => {
        const terminals = resolvedVscodeApi.window.terminals.filter(
          (candidate) => candidate.name === 'lane-a',
        );
        assert.equal(terminals.length, 1, 'Expected the startup lane-a Terminal');
        terminal = terminals[0];
      },
      { delay, now },
    );
    mark('startup terminal found');
    const pidPath = path.join(laneA, 'startup-shell-pid');
    const temporaryPidPath = `${pidPath}.tmp`;
    terminal.sendText(
      `printf '%s' "$$" > ${shellQuote(temporaryPidPath)} && mv ${shellQuote(temporaryPidPath)} ${shellQuote(pidPath)}`,
    );
    await waitFor(
      () => assert.equal(fileSystem.existsSync(pidPath), true, 'Startup shell PID was not written'),
      { delay, now },
    );
    const shellPid = Number(fileSystem.readFileSync(pidPath, 'utf8'));
    assert.ok(Number.isInteger(shellPid) && shellPid > 0, `Invalid startup shell PID: ${shellPid}`);
    assert.equal(isProcessAlive(processApi, shellPid), true, 'Startup shell exited early');

    terminal.dispose();
    await waitFor(
      () =>
        assert.equal(
          isProcessAlive(processApi, shellPid),
          false,
          'Closing the startup Lane Terminal left its shell running',
        ),
      { delay, now },
    );
    mark('startup terminal closed');
    assertLegacyPromptPending();

    await waitForSettlement(
      activation,
      'Extension activation waited for the legacy settings answer',
      { delay, now },
    );
    assertLegacyPromptPending();
    await waitForSettlement(
      resolvedVscodeApi.commands.executeCommand('projectLanes.switchLane', 'lane-b'),
      'Switch Lane waited for the legacy settings answer',
      { delay, now },
    );
    await waitForActiveLane(laneB);
    mark('switched to lane-b');
    assertLegacyPromptPending();

    const pause =
      delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const clock = now ?? (() => Date.now());
    const deadline = clock() + POLL_TIMEOUT_MS;
    const isLegacyPending = () =>
      terminalConfiguration.inspect('enablePersistentSessions')?.workspaceValue === false;
    let acceptCount = 0;
    while (isLegacyPending()) {
      if (clock() > deadline) throw new Error('Timed out while selecting Remove Legacy Settings');
      await resolvedVscodeApi.commands.executeCommand('notifications.focusToasts');
      await resolvedVscodeApi.commands.executeCommand('notification.acceptPrimaryAction');
      acceptCount += 1;
      mark(`accepted primary action #${acceptCount}`);
      // 選択の反映前に押し直すと、後続の別通知の主操作まで実行し得るため反映を待ってから再試行
      const settleDeadline = Math.min(clock() + ACCEPT_SETTLE_TIMEOUT_MS, deadline);
      while (isLegacyPending() && clock() <= settleDeadline) await pause(POLL_INTERVAL_MS);
    }
    mark('legacy settings removed');
    await waitFor(
      () => {
        assert.equal(
          terminalConfiguration.inspect('enablePersistentSessions')?.workspaceValue,
          undefined,
          'Remove Legacy Settings kept the persistence override',
        );
        assert.equal(
          terminalConfiguration.inspect('defaultProfile.linux')?.workspaceValue,
          'Lane Terminal',
          'Remove Legacy Settings did not reacquire the Lane Terminal default profile',
        );
      },
      { delay, now },
    );
    log(
      'E2E PASS: the legacy prompt left Lane Terminal close, activation, and lane commands responsive',
    );
  } catch (error) {
    throw withProgress(error);
  }
};

module.exports = { run };
