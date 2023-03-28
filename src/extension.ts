/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { FailingDeepStrictEqualAssertFixer } from './failingDeepStrictEqualAssertFixer';
import { scanTestOutput } from './testOutputScanner';
import {
  clearFileDiagnostics,
  guessWorkspaceFolder,
  itemData,
  TestCase,
  TestFile,
} from './testTree';
import { BrowserTestRunner, PlatformTestRunner, VSCodeTestRunner } from './vscodeTestRunner';

const TEST_FILE_PATTERN = 'src/**/*.{test,integrationTest}.ts';

const getWorkspaceFolderForTestFile = (uri: vscode.Uri) =>
  uri.path.endsWith('.test.ts') || uri.path.endsWith('.integrationTest.ts')
    ? vscode.workspace.getWorkspaceFolder(uri)
    : undefined;

const browserArgs: [name: string, arg: string][] = [
  ['Chrome', 'chromium'],
  ['Firefox', 'firefox'],
  ['Webkit', 'webkit'],
];

export async function activate(context: vscode.ExtensionContext) {
  const ctrl = vscode.tests.createTestController('selfhost-test-controller', 'VS Code Tests');
  const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();

  ctrl.resolveHandler = async test => {
    if (!test) {
      context.subscriptions.push(await startWatchingWorkspace(ctrl, fileChangedEmitter));
      return;
    }

    const data = itemData.get(test);
    if (data instanceof TestFile) {
      // No need to watch this, updates will be triggered on file changes
      // either by the text document or file watcher.
      await data.updateFromDisk(ctrl, test);
    }
  };

  let runQueue = Promise.resolve();
  const createRunHandler = (
    runnerCtor: { new (folder: vscode.WorkspaceFolder): VSCodeTestRunner },
    debug: boolean,
    args: string[] = []
  ) => {
    const doTestRun = async (
      req: vscode.TestRunRequest,
      cancellationToken: vscode.CancellationToken
    ) => {
      const folder = await guessWorkspaceFolder();
      if (!folder) {
        return;
      }

      const runner = new runnerCtor(folder);
      const map = await getPendingTestMap(ctrl, req.include ?? gatherTestItems(ctrl.items));
      const task = ctrl.createTestRun(req);
      for (const test of map.values()) {
        task.enqueued(test);
      }

      return (runQueue = runQueue.then(async () => {
        await scanTestOutput(
          map,
          task,
          debug ? await runner.debug(args, req.include) : await runner.run(args, req.include),
          cancellationToken
        );
      }));
    };

    return async (req: vscode.TestRunRequest, cancellationToken: vscode.CancellationToken) => {
      if (!req.continuous) {
        return doTestRun(req, cancellationToken);
      }

      const queuedFiles = new Set<vscode.Uri>();
      let debounced: NodeJS.Timer | undefined;

      const listener = fileChangedEmitter.event(uri => {
        clearTimeout(debounced);
        queuedFiles.add(uri);

        debounced = setTimeout(() => {
          const items = [...queuedFiles]
            .map(f => getOrCreateFile(ctrl, f))
            .filter((f): f is vscode.TestItem => !!f);
          queuedFiles.clear();
          doTestRun(
            new vscode.TestRunRequest(items, undefined, req.profile, true),
            cancellationToken
          );
        }, 1000);
      });

      cancellationToken.onCancellationRequested(() => {
        clearTimeout(debounced);
        listener.dispose();
      });
    };
  };

  ctrl.createRunProfile(
    'Run in Electron',
    vscode.TestRunProfileKind.Run,
    createRunHandler(PlatformTestRunner, false),
    true,
    undefined,
    true
  );

  ctrl.createRunProfile(
    'Debug in Electron',
    vscode.TestRunProfileKind.Debug,
    createRunHandler(PlatformTestRunner, true),
    true,
    undefined,
    true
  );

  for (const [name, arg] of browserArgs) {
    const cfg = ctrl.createRunProfile(
      `Run in ${name}`,
      vscode.TestRunProfileKind.Run,
      createRunHandler(BrowserTestRunner, false, [' --browser', arg]),
      undefined,
      undefined,
      true
    );

    cfg.configureHandler = () => vscode.window.showInformationMessage(`Configuring ${name}`);

    ctrl.createRunProfile(
      `Debug in ${name}`,
      vscode.TestRunProfileKind.Debug,
      createRunHandler(BrowserTestRunner, false, ['--browser', arg, '--debug-browser']),
      undefined,
      undefined,
      true
    );
  }

  function updateNodeForDocument(e: vscode.TextDocument) {
    const node = getOrCreateFile(ctrl, e.uri);
    const data = node && itemData.get(node);
    if (data instanceof TestFile) {
      data.updateFromContents(ctrl, e.getText(), node!);
    }
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument(e => updateNodeForDocument(e.document)),
    new FailingDeepStrictEqualAssertFixer()
  );
}

function getOrCreateFile(
  controller: vscode.TestController,
  uri: vscode.Uri
): vscode.TestItem | undefined {
  const folder = getWorkspaceFolderForTestFile(uri);
  if (!folder) {
    return undefined;
  }

  const data = new TestFile(uri, folder);
  const existing = controller.items.get(data.getId());
  if (existing) {
    return existing;
  }

  const file = controller.createTestItem(data.getId(), data.getLabel(), uri);
  controller.items.add(file);
  file.canResolveChildren = true;
  itemData.set(file, data);

  return file;
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach(item => items.push(item));
  return items;
}

async function startWatchingWorkspace(
  controller: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<vscode.Uri>
) {
  const workspaceFolder = await guessWorkspaceFolder();
  if (!workspaceFolder) {
    return new vscode.Disposable(() => undefined);
  }

  const pattern = new vscode.RelativePattern(workspaceFolder, TEST_FILE_PATTERN);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  watcher.onDidCreate(uri => {
    getOrCreateFile(controller, uri);
    fileChangedEmitter.fire(uri);
  });
  watcher.onDidChange(uri => fileChangedEmitter.fire(uri));
  watcher.onDidDelete(uri => {
    clearFileDiagnostics(uri);
    controller.items.delete(uri.toString());
  });

  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(controller, file);
  }

  return watcher;
}

async function getPendingTestMap(ctrl: vscode.TestController, tests: Iterable<vscode.TestItem>) {
  const queue = [tests];
  const titleMap = new Map<string, vscode.TestItem>();
  while (queue.length) {
    for (const item of queue.pop()!) {
      const data = itemData.get(item);
      if (data instanceof TestFile) {
        if (!data.hasBeenRead) {
          await data.updateFromDisk(ctrl, item);
        }
        queue.push(gatherTestItems(item.children));
      } else if (data instanceof TestCase) {
        titleMap.set(data.fullName, item);
      } else {
        queue.push(gatherTestItems(item.children));
      }
    }
  }

  return titleMap;
}
