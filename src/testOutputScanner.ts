/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import styles from 'ansi-styles';
import { ChildProcessWithoutNullStreams } from 'child_process';
import { decode as base64Decode } from 'js-base64';
import { SourceMapConsumer } from 'source-map';
import * as split from 'split2';
import * as vscode from 'vscode';
import { attachTestMessageMetadata } from './metadata';
import { getContentFromFilesystem } from './testTree';

export const enum MochaEvent {
  Start = 'start',
  TestStart = 'testStart',
  Pass = 'pass',
  Fail = 'fail',
  End = 'end',
}

export interface IStartEvent {
  total: number;
}

export interface ITestStartEvent {
  title: string;
  fullTitle: string;
  file: string;
  currentRetry: number;
  speed: string;
}

export interface IPassEvent extends ITestStartEvent {
  duration: number;
}

export interface IFailEvent extends IPassEvent {
  err: string;
  stack: string | null;
  expected?: string;
  actual?: string;
  expectedJSON?: unknown;
  actualJSON?: unknown;
}

export interface IEndEvent {
  suites: number;
  tests: number;
  passes: number;
  pending: number;
  failures: number;
  start: string /* ISO date */;
  end: string /* ISO date */;
}

export type MochaEventTuple =
  | [MochaEvent.Start, IStartEvent]
  | [MochaEvent.TestStart, ITestStartEvent]
  | [MochaEvent.Pass, IPassEvent]
  | [MochaEvent.Fail, IFailEvent]
  | [MochaEvent.End, IEndEvent];

export class TestOutputScanner implements vscode.Disposable {
  protected mochaEventEmitter = new vscode.EventEmitter<MochaEventTuple>();
  protected outputEventEmitter = new vscode.EventEmitter<string>();
  protected onErrorEmitter = new vscode.EventEmitter<string>();

  /**
   * Fired when a mocha event comes in.
   */
  public readonly onMochaEvent = this.mochaEventEmitter.event;

  /**
   * Fired when other output from the process comes in.
   */
  public readonly onOtherOutput = this.outputEventEmitter.event;

  /**
   * Fired when the process encounters an error, or exits.
   */
  public readonly onRunnerError = this.onErrorEmitter.event;

  constructor(private readonly process: ChildProcessWithoutNullStreams, private args?: string[]) {
    process.stdout.pipe(split()).on('data', this.processData);
    process.stderr.pipe(split()).on('data', this.processData);
    process.on('error', e => this.onErrorEmitter.fire(e.message));
    process.on('exit', code => this.onErrorEmitter.fire(`Test process exited with code ${code}`));
  }

  /**
   * @override
   */
  public dispose() {
    try {
      this.process.kill();
    } catch {
      // ignored
    }
  }

  protected readonly processData = (data: string) => {
    if (this.args) {
      this.outputEventEmitter.fire(`./scripts/test ${this.args.join(' ')}`);
      this.args = undefined;
    }

    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed instanceof Array && parsed.length === 2 && typeof parsed[0] === 'string') {
        this.mochaEventEmitter.fire(parsed as MochaEventTuple);
      } else {
        this.outputEventEmitter.fire(data);
      }
    } catch {
      this.outputEventEmitter.fire(data);
    }
  };
}

export async function scanTestOutput(
  tests: Map<string, vscode.TestItem>,
  task: vscode.TestRun,
  scanner: TestOutputScanner,
  cancellation: vscode.CancellationToken
): Promise<void> {
  const exitBlockers: Set<Promise<unknown>> = new Set();
  const enqueueExitBlocker = <T>(prom: Promise<T>): Promise<T> => {
    exitBlockers.add(prom);
    prom.finally(() => exitBlockers.delete(prom));
    return prom;
  };

  let lastTest: vscode.TestItem | undefined;
  let ranAnyTest = false;

  try {
    if (cancellation.isCancellationRequested) {
      return;
    }

    await new Promise<void>(resolve => {
      cancellation.onCancellationRequested(() => {
        resolve();
      });

      let currentTest: vscode.TestItem | undefined;

      const defaultAppend = (str: string) => task.appendOutput(str + crlf, undefined, currentTest);

      scanner.onRunnerError(err => {
        defaultAppend(err);
        resolve();
      });

      scanner.onOtherOutput(str => {
        const match = spdlogRe.exec(str);
        if (!match) {
          return defaultAppend(str);
        }

        enqueueExitBlocker(
          getSourceLocation(match[2], Number(match[3]))
            .then(location => task.appendOutput(match[1] + crlf, location, currentTest))
            .catch(() => defaultAppend(str))
        );
      });

      scanner.onMochaEvent(evt => {
        switch (evt[0]) {
          case MochaEvent.Start:
            break; // no-op
          case MochaEvent.TestStart:
            currentTest = tests.get(evt[1].fullTitle);
            ranAnyTest = true;
            break;
          case MochaEvent.Pass:
            {
              const title = evt[1].fullTitle;
              const tcase = tests.get(title);
              task.appendOutput(` ${styles.green.open}√${styles.green.close} ${title}\r\n`);
              if (tcase) {
                lastTest = tcase;
                task.passed(tcase, evt[1].duration);
                tests.delete(title);
              }
            }
            break;
          case MochaEvent.Fail:
            {
              const {
                err,
                stack,
                duration,
                expected,
                expectedJSON,
                actual,
                actualJSON,
                fullTitle: id,
              } = evt[1];
              let tcase = tests.get(id);
              // report failures on hook to the last-seen test, or first test if none run yet
              if (!tcase && id.includes('hook for')) {
                tcase = lastTest ?? tests.values().next().value;
              }

              task.appendOutput(`${styles.red.open} x ${id}${styles.red.close}\r\n`);
              const rawErr = stack || err;
              if (rawErr) {
                task.appendOutput(forceCRLF(rawErr));
              }

              if (!tcase) {
                return;
              }

              tests.delete(id);
              const testFirstLine =
                tcase.range &&
                new vscode.Location(
                  tcase.uri!,
                  new vscode.Range(
                    tcase.range.start,
                    new vscode.Position(tcase.range.start.line, 100)
                  )
                );

              enqueueExitBlocker(
                tryDeriveLocation(rawErr).then(location => {
                  const message = new vscode.TestMessage(tryMakeMarkdown(err));
                  message.location = location ?? testFirstLine;
                  message.actualOutput = String(actual);
                  message.expectedOutput = String(expected);
                  attachTestMessageMetadata(message, { expectedValue: expectedJSON, actualValue: actualJSON });
                  task.failed(tcase!, message, duration);
                })
              );
            }
            break;
          case MochaEvent.End:
            resolve();
            break;
        }
      });
    });
    await Promise.all([...exitBlockers]);

    // no tests? Possible crash, show output:
    if (!ranAnyTest) {
      await vscode.commands.executeCommand('testing.showMostRecentOutput');
    }
  } catch (e) {
    task.appendOutput((e as Error).stack || (e as Error).message);
  } finally {
    scanner.dispose();
    task.end();
  }
}

const spdlogRe = /"(.+)", source: (file:\/\/\/.*?)+ \(([0-9]+)\)/;
const crlf = '\r\n';

const forceCRLF = (str: string) => str.replace(/(?<!\r)\n/gm, '\r\n');

const tryMakeMarkdown = (message: string) => {
  const lines = message.split('\n');
  const start = lines.findIndex(l => l.includes('+ actual'));
  if (start === -1) {
    return message;
  }

  lines.splice(start, 1, '```diff');
  lines.push('```');
  return new vscode.MarkdownString(lines.join('\n'));
};

const inlineSourcemapRe = /^\/\/# sourceMappingURL=data:application\/json;base64,(.+)/m;
const sourceMapBiases = [
  SourceMapConsumer.GREATEST_LOWER_BOUND,
  SourceMapConsumer.LEAST_UPPER_BOUND,
];

async function getSourceLocation(fileUri: string, line: number, col = 1) {
  let sourceMap: SourceMapConsumer;
  try {
    const contents = await getContentFromFilesystem(vscode.Uri.parse(fileUri));
    const sourcemapMatch = inlineSourcemapRe.exec(contents);
    if (!sourcemapMatch) {
      return;
    }

    const decoded = base64Decode(sourcemapMatch[1]);
    sourceMap = await new SourceMapConsumer(decoded, fileUri);
  } catch (e) {
    console.warn(`Error parsing sourcemap for ${fileUri}: ${(e as Error).stack}`);
    return;
  }

  for (const bias of sourceMapBiases) {
    const position = sourceMap.originalPositionFor({ column: col - 1, line: line, bias });
    if (position.line !== null && position.column !== null && position.source !== null) {
      return new vscode.Location(
        vscode.Uri.parse(position.source),
        new vscode.Position(position.line - 1, position.column)
      );
    }
  }

  return undefined;
}

async function tryDeriveLocation(stack: string) {
  const parts = /(file:\/{3}.+):([0-9]+):([0-9]+)/.exec(stack);
  if (!parts) {
    return;
  }

  const [, fileUri, line, col] = parts;
  return getSourceLocation(fileUri, Number(line), Number(col));
}
