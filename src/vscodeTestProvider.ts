/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as ts from 'typescript';
import {
  CancellationToken,
  EventEmitter,
  Location,
  OutputChannel,
  Position,
  Range,
  RelativePattern,
  TestMessage,
  TestProvider,
  TestRunOptions,
  TestRunState,
  TestState,
  TextDocument,
  Uri,
  window,
  workspace,
  WorkspaceFolder,
} from 'vscode';
import { debounce } from './debounce';
import { MochaEvent, TestOutputScanner } from './testOutputScanner';
import { TestCase, TestRoot, TestSuite, VSCodeTest } from './testTree';
import { PlatformTestRunner } from './vscodeTestRunner';

declare const TextDecoder: typeof import('util').TextDecoder; // node in the typings yet

const TEST_FILE_PATTERN = 'src/vs/**/*.test.ts';
const MAX_BLOCKING_TARGET = 0.5;

export class VscodeTestProvider implements TestProvider<VSCodeTest> {
  private outputChannel?: OutputChannel;

  /**
   * @inheritdoc
   */
  public createWorkspaceTestHierarchy(workspaceFolder: WorkspaceFolder) {
    const root = new TestRoot(workspaceFolder);
    const pattern = new RelativePattern(workspaceFolder, TEST_FILE_PATTERN);

    const changeTestEmitter = new EventEmitter<VSCodeTest>();
    const watcher = workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(async uri => await updateTestsInFile(root, uri, changeTestEmitter));
    watcher.onDidChange(async uri => await updateTestsInFile(root, uri, changeTestEmitter));
    watcher.onDidDelete(uri => removeTestsForFile(root, uri, changeTestEmitter));

    const discoveredInitialTests = workspace.findFiles(pattern).then(async files => {
      const workers: Promise<void>[] = [];
      const startedAt = Date.now();
      let totalProcessedTime = 0;

      for (let i = 0; i < 4; i++) {
        workers.push(
          (async () => {
            while (files.length) {
              totalProcessedTime += await updateTestsInFile(root, files.pop()!, changeTestEmitter);

              // Parsing a lot of TS is slow. Throttle ourselves to avoid
              // blocking the ext host for too long.
              const duration = Date.now() - startedAt;
              const actualPercentOfTimeOnMainThread = totalProcessedTime / duration;
              const overusePercentage = actualPercentOfTimeOnMainThread - MAX_BLOCKING_TARGET;
              const delayToGetBackDownToTarget = overusePercentage * duration;
              if (delayToGetBackDownToTarget > 1) {
                await delay(delayToGetBackDownToTarget);
              }
            }
          })()
        );

        await Promise.all(workers);
      }
    });

    return {
      root,
      onDidChangeTest: changeTestEmitter.event,
      discoveredInitialTests,
      dispose: () => {
        watcher.dispose();
        root.dispose();
      },
    };
  }

  /**
   * @inheritdoc
   */
  public createDocumentTestHierarchy(document: TextDocument) {
    const folder = workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }

    const root = new TestRoot(folder);
    const changeTestEmitter = new EventEmitter<VSCodeTest>();
    const contentProvider = () => document.getText();
    const discoveredInitialTests = updateTestsInFile(
      root,
      document.uri,
      changeTestEmitter,
      contentProvider
    );

    const updateTests = debounce(700, () =>
      updateTestsInFile(root, document.uri, changeTestEmitter, contentProvider)
    );
    const changeListener = workspace.onDidChangeTextDocument(e => {
      if (e.document === document) {
        updateTests();
      }
    });

    return {
      root,
      onDidChangeTest: changeTestEmitter.event,
      discoveredInitialTests,
      dispose: () => {
        changeListener.dispose();
        updateTests.clear();
        root.dispose();
      },
    };
  }

  public async runTests(req: TestRunOptions<VSCodeTest>, cancellationToken: CancellationToken) {
    const root = req.tests[0].root;
    const runner = new PlatformTestRunner(root.workspaceFolder);

    const pending = getPendingTestMap(req.tests);
    for (const test of pending.values()) {
      test.state = new TestState(TestRunState.Running);
    }

    const output = this.getOutputChannel();
    output.appendLine('');
    output.appendLine(`Starting test run at ${new Date().toLocaleString()}`);
    output.appendLine('');

    const outcome = await scanTestOutput(
      output,
      req.debug ? await runner.debug(req.tests) : await runner.run(req.tests),
      pending,
      cancellationToken
    );
    for (const test of pending.values()) {
      test.state = new TestState(outcome);
    }

    // some error:
    if (outcome !== TestRunState.Skipped) {
      output.show();
    }
  }

  private getOutputChannel() {
    if (!this.outputChannel) {
      this.outputChannel = window.createOutputChannel('VS Code Tests');
    }

    return this.outputChannel;
  }
}

const delay = (duration: number) => new Promise<void>(r => setTimeout(r, duration));

function scanTestOutput(
  outputChannel: OutputChannel,
  scanner: TestOutputScanner,
  tests: Map<string, TestCase>,
  cancellation: CancellationToken
): Promise<TestRunState> {
  if (cancellation.isCancellationRequested) {
    scanner.dispose();
    return Promise.resolve(TestRunState.Skipped);
  }

  return new Promise<TestRunState>(resolve => {
    cancellation.onCancellationRequested(() => {
      resolve(TestRunState.Skipped);
    });

    scanner.onRunnerError(err => {
      outputChannel.appendLine(err);
      resolve(TestRunState.Errored);
    });

    scanner.onOtherOutput(str => {
      outputChannel.appendLine(str);
    });

    scanner.onMochaEvent(evt => {
      switch (evt[0]) {
        case MochaEvent.Start:
          break; // no-op
        case MochaEvent.Pass:
          {
            const tcase = tests.get(evt[1].fullTitle);
            outputChannel.appendLine(` √ ${evt[1].fullTitle}`);
            if (tcase) {
              tcase.state = new TestState(TestRunState.Passed, undefined, evt[1].duration);
              tests.delete(evt[1].fullTitle);
            }
          }
          break;
        case MochaEvent.Fail:
          {
            const tcase = tests.get(evt[1].fullTitle);
            outputChannel.appendLine(` x ${evt[1].fullTitle}`);
            if (tcase) {
              // todo: parse state to associate with a source location
              const message: TestMessage = { message: evt[1].err, location: tcase.location };
              tcase.state = new TestState(TestRunState.Failed, [message], evt[1].duration);
              tests.delete(evt[1].fullTitle);

              // todo(connor4312): temporary until there's richer test output:
              outputChannel.appendLine(evt[1].stack || evt[1].err);
              outputChannel.show();
            }
          }
          break;
        case MochaEvent.End:
          resolve(TestRunState.Skipped);
          break;
      }
    });
  }).finally(() => scanner.dispose());
}

function getPendingTestMap(tests: ReadonlyArray<VSCodeTest>) {
  const queue: Iterable<VSCodeTest>[] = [tests];
  const titleMap = new Map<string, TestCase>();
  while (queue.length) {
    for (const child of queue.pop()!) {
      if (child instanceof TestCase) {
        titleMap.set(child.fullTitle, child);
      } else {
        queue.push(child.children);
      }
    }
  }

  return titleMap;
}

let generation = 0;

function removeTestsForFile(root: TestRoot, file: Uri, changeEmitter: EventEmitter<VSCodeTest>) {
  const changes = new Set<VSCodeTest>();
  root.prune(file, generation++, changes);
  for (const change of changes) {
    changeEmitter.fire(change);
  }
}

const getContentsFromFile = async (file: Uri) => {
  const contents = await workspace.fs.readFile(file);
  return new TextDecoder('utf-8').decode(contents);
};

/**
 * Gets tests in the file by doing a full parse in TS. Returns the amount of
 * main-thread time taken.
 */
async function updateTestsInFile(
  root: TestRoot,
  file: Uri,
  changeEmitter: EventEmitter<VSCodeTest>,
  getContents: (uri: Uri) => string | Promise<string> = getContentsFromFile
) {
  try {
    const decoded = await getContents(file);
    const ast = ts.createSourceFile(
      file.path.split('/').pop()!,
      decoded,
      ts.ScriptTarget.ESNext,
      false,
      ts.ScriptKind.TS
    );

    const startedAt = Date.now();
    const thisGeneration = generation++;
    const parents: (TestRoot | TestSuite)[] = [root];
    const changedTests = new Set<VSCodeTest>();
    const traverse = (node: ts.Node) => {
      const testItem = extractTestFromNode(file, root, ast, node, changeEmitter, thisGeneration);
      if (!testItem) {
        ts.forEachChild(node, traverse);
        return;
      }

      const parent = parents[parents.length - 1];
      const [deduped, changed] = parent.addChild(testItem);
      if (changed) {
        changedTests.add(deduped);
      }

      if (deduped === testItem) {
        changedTests.add(parent);
        if (testItem instanceof TestCase) {
          testItem.connect();
        }
      }

      if (deduped instanceof TestSuite) {
        parents.push(deduped);
        ts.forEachChild(node, traverse);
        parents.pop();
      }
    };

    ts.forEachChild(ast, traverse);
    root.prune(file, thisGeneration, changedTests);

    for (const change of changedTests) {
      changeEmitter.fire(change);
    }

    return Date.now() - startedAt;
  } catch (e) {
    console.warn('Error reading tests in file', file.toString(), e);
    return 1;
  }
}

const extractTestFromNode = (
  fileUri: Uri,
  root: TestRoot,
  src: ts.SourceFile,
  node: ts.Node,
  changeEmitter: EventEmitter<VSCodeTest>,
  generation: number
) => {
  if (!ts.isCallExpression(node)) {
    return undefined;
  }

  const lhs = node.expression;
  const name = node.arguments[0];
  const func = node.arguments[1];
  if (!name || !ts.isIdentifier(lhs) || !ts.isStringLiteralLike(name)) {
    return undefined;
  }

  if (!func || !ts.isFunctionLike(func)) {
    return undefined;
  }

  const start = src.getLineAndCharacterOfPosition(name.pos);
  const end = src.getLineAndCharacterOfPosition(func.end);
  const range = new Range(
    new Position(start.line, start.character),
    new Position(end.line, end.character)
  );
  const location = new Location(fileUri, range);

  if (lhs.escapedText === 'test') {
    return new TestCase(name.text, location, generation, root, changeEmitter);
  }

  if (lhs.escapedText === 'suite') {
    return new TestSuite(name.text, location, root);
  }

  return undefined;
};
