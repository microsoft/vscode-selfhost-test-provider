/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { ChildProcessWithoutNullStreams } from 'child_process';
import * as split from 'split2';
import { Disposable, EventEmitter } from 'vscode';

export const enum MochaEvent {
  Start = 'start',
  Pass = 'pass',
  Fail = 'fail',
  End = 'end',
}

export interface IStartEvent {
  total: number;
}

export interface IPassEvent {
  title: string;
  fullTitle: string;
  file: string;
  duration: number;
  currentRetry: number;
  speed: string;
}

export interface IFailEvent extends IPassEvent {
  err: string;
  stack: string | null;
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
  | [MochaEvent.Pass, IPassEvent]
  | [MochaEvent.Fail, IFailEvent]
  | [MochaEvent.End, IEndEvent];

export class TestOutputScanner implements Disposable {
  protected mochaEventEmitter = new EventEmitter<MochaEventTuple>();
  protected outputEventEmitter = new EventEmitter<string>();
  protected onErrorEmitter = new EventEmitter<string>();

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

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
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
