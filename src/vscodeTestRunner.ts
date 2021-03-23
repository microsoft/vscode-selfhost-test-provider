/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { debug, DebugSession, WorkspaceFolder } from 'vscode';
import { TestOutputScanner } from './testOutputScanner';
import {
  DocumentTestRoot,
  idPrefix,
  TestCase,
  TestFile,
  TestSuite,
  VSCodeTest,
  WorkspaceTestRoot,
} from './testTree';

/**
 * From MDN
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions#Escaping
 */
const escapeRe = (s: string) => s.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&');

const TEST_SCRIPT_PATH = 'test/unit/electron/index.js';
const ATTACH_CONFIG_NAME = 'Attach to VS Code';

export abstract class VSCodeTestRunner {
  constructor(protected readonly repoLocation: WorkspaceFolder) {}

  public async run(tests: ReadonlyArray<VSCodeTest>) {
    const cp = spawn(await this.binaryPath(), this.prepareArguments(tests), {
      cwd: this.repoLocation.uri.fsPath,
      stdio: 'pipe',
      env: this.getEnvironment(),
    });

    return new TestOutputScanner(cp);
  }

  public async debug(tests: ReadonlyArray<VSCodeTest>) {
    const cp = spawn(
      await this.binaryPath(),
      [...this.prepareArguments(tests), '--remote-debugging-port=9222', '--timeout=0'],
      {
        cwd: this.repoLocation.uri.fsPath,
        stdio: 'pipe',
        env: this.getEnvironment(),
      }
    );

    debug.startDebugging(this.repoLocation, ATTACH_CONFIG_NAME);

    let exited = false;
    let session: DebugSession | undefined;
    cp.once('exit', () => {
      exited = true;
      if (session) {
        debug.stopDebugging(session);
      }
    });

    const listener = debug.onDidStartDebugSession(s => {
      if (s.name === ATTACH_CONFIG_NAME) {
        listener.dispose();
        if (exited) {
          debug.stopDebugging(session);
        } else {
          session = s;
        }
      }
    });

    return new TestOutputScanner(cp);
  }

  private getEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_ENABLE_LOGGING: '1',
    };
  }

  private prepareArguments(tests: ReadonlyArray<VSCodeTest>) {
    const args = [TEST_SCRIPT_PATH, ...this.getDefaultArgs(), '--reporter', 'full-json-stream'];

    const grepRe: string[] = [];
    const runPaths: string[] = [];
    for (const test of tests) {
      if (test instanceof WorkspaceTestRoot) {
        return args;
      } else if (test instanceof TestCase || test instanceof TestSuite) {
        grepRe.push(
          escapeRe(test.id.slice(idPrefix.length)) + (test instanceof TestCase ? '$' : ' ')
        );
      } else if (test instanceof TestFile || test instanceof DocumentTestRoot) {
        runPaths.push(
          path.relative(test.workspaceFolder.uri.fsPath, test.uri.fsPath).replace(/\\/g, '/')
        );
      }
    }

    if (grepRe.length) {
      args.push('--grep', `/^(${grepRe.join('|')})/`);
    }

    if (runPaths.length) {
      args.push(...runPaths.flatMap(p => ['--run', p]));
    }

    return args;
  }

  protected getDefaultArgs(): string[] {
    return [];
  }

  protected abstract binaryPath(): Promise<string>;

  protected async readProductJson() {
    const projectJson = await fs.readFile(
      path.join(this.repoLocation.uri.fsPath, 'product.json'),
      'utf-8'
    );
    try {
      return JSON.parse(projectJson);
    } catch (e) {
      throw new Error(`Error parsing product.json: ${e.message}`);
    }
  }
}

export class WindowsTestRunner extends VSCodeTestRunner {
  /** @override */
  protected async binaryPath() {
    const { nameShort } = await this.readProductJson();
    return path.join(this.repoLocation.uri.fsPath, `.build/electron/${nameShort}.exe`);
  }
}

export class PosixTestRunner extends VSCodeTestRunner {
  /** @override */
  protected async binaryPath() {
    const { applicationName } = await this.readProductJson();
    return path.join(this.repoLocation.uri.fsPath, `.build/electron/${applicationName}`);
  }
}

export class DarwinTestRunner extends PosixTestRunner {
  /** @override */
  protected getDefaultArgs() {
    return [
      ...super.getDefaultArgs(),
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=swiftshader',
    ];
  }

  /** @override */
  protected async binaryPath() {
    const { nameLong } = await this.readProductJson();
    return path.join(
      this.repoLocation.uri.fsPath,
      `.build/electron/${nameLong}.app/Contents/MacOS/Electron`
    );
  }
}

export const PlatformTestRunner =
  process.platform === 'win32'
    ? WindowsTestRunner
    : process.platform === 'darwin'
    ? DarwinTestRunner
    : PosixTestRunner;
