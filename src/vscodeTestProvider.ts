/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { SourceMapConsumer } from 'source-map';
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
import { extractTests } from './extractTestsTs';
import { MochaEvent, TestOutputScanner } from './testOutputScanner';
import { TestCase, TestRoot, TestSuite, VSCodeTest } from './testTree';
import { PlatformTestRunner } from './vscodeTestRunner';

declare const TextDecoder: typeof import('util').TextDecoder; // node in the typings yet

const TEST_FILE_PATTERN = 'src/vs/**/*.test.ts';
const MAX_BLOCKING_TARGET = 0.5;

export class VscodeTestProvider implements TestProvider<VSCodeTest> {
  private outputChannel?: OutputChannel;
  private queue = Promise.resolve();

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
      test.state = new TestState(TestRunState.Queued);
    }

    return (this.queue = this.queue.then(async () => {
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
    }));
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
            const { err, stack, duration, expected, actual, fullTitle } = evt[1];
            const tcase = tests.get(fullTitle);
            outputChannel.appendLine(` x ${fullTitle}`);
            if (!tcase) {
              return;
            }

            tests.delete(fullTitle);
            const testFirstLine = new Location(
              tcase.location.uri,
              new Range(
                tcase.location.range.start,
                new Position(tcase.location.range.start.line, 100)
              )
            );

            tryDeriveLocation(stack || err).then(location => {
              const message: TestMessage = {
                message: err,
                location: location ?? testFirstLine,
                actualOutput: actual,
                expectedOutput: expected,
              };

              tcase.state = new TestState(TestRunState.Failed, [message], duration);

              // todo(connor4312): temporary until there's richer test output:
              outputChannel.appendLine(stack || err);
              outputChannel.show();
            });
          }
          break;
        case MochaEvent.End:
          resolve(TestRunState.Skipped);
          break;
      }
    });
  }).finally(() => scanner.dispose());
}

async function tryDeriveLocation(stack: string) {
  const parts = /(file:\/{3}.+):([0-9]+):([0-9]+)/.exec(stack);
  if (!parts) {
    return;
  }

  const [, fileUri, line, col] = parts;
  let sourceMap: SourceMapConsumer;
  try {
    const sourceMapUri = fileUri + '.map';
    const contents = await getContentsFromFile(Uri.parse(sourceMapUri));
    sourceMap = await new SourceMapConsumer(contents, sourceMapUri);
  } catch (e) {
    console.warn(`Error parsing sourcemap for ${fileUri}: ${e.stack}`);
    return;
  }

  const position = sourceMap.originalPositionFor({
    column: Number(col) - 1,
    line: Number(line),
  });

  if (position.line === null || position.column === null || position.source === null) {
    return;
  }

  return new Location(Uri.parse(position.source), new Position(position.line - 1, position.column));
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
    const startedAt = Date.now();
    const thisGeneration = generation++;
    const changedTests = extractTests(decoded, {
      root,
      file,
      onTestCase: (name, location) =>
        new TestCase(name, location, thisGeneration, root, changeEmitter),
      onTestSuite: (name, location) => new TestSuite(name, location, root),
    });

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
