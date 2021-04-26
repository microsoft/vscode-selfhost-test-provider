/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { AddressInfo, createServer } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestOutputScanner } from './testOutputScanner';
import {
  DocumentTestRoot,
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
  constructor(protected readonly repoLocation: vscode.WorkspaceFolder) {}

  public async run(tests: ReadonlyArray<vscode.TestItem<VSCodeTest>>) {
    const args = this.prepareArguments(tests);
    const cp = spawn(await this.binaryPath(), this.prepareArguments(tests), {
      cwd: this.repoLocation.uri.fsPath,
      stdio: 'pipe',
      env: this.getEnvironment(),
    });

    return new TestOutputScanner(cp, args);
  }

  public async debug(tests: ReadonlyArray<vscode.TestItem<VSCodeTest>>) {
    const server = this.createWaitServer();
    const args = [
      ...this.prepareArguments(tests),
      '--remote-debugging-port=9222',
      '--timeout=0',
      `--waitServer=${server.port}`,
    ];

    const cp = spawn(await this.binaryPath(), args, {
      cwd: this.repoLocation.uri.fsPath,
      stdio: 'pipe',
      env: this.getEnvironment(),
    });

    vscode.debug.startDebugging(this.repoLocation, ATTACH_CONFIG_NAME);

    let exited = false;
    let rootSession: vscode.DebugSession | undefined;
    cp.once('exit', () => {
      exited = true;
      server.dispose();
      listener.dispose();
      if (rootSession) {
        vscode.debug.stopDebugging(rootSession);
      }
    });

    const listener = vscode.debug.onDidStartDebugSession(s => {
      if (s.name === ATTACH_CONFIG_NAME && !rootSession) {
        if (exited) {
          vscode.debug.stopDebugging(rootSession);
        } else {
          rootSession = s;
        }
      }

      if (rootSession && s.configuration.__parentId === rootSession?.id) {
        server.onFound();
        listener.dispose();
      }
    });

    return new TestOutputScanner(cp, args);
  }

  private getEnvironment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      ELECTRON_ENABLE_LOGGING: '1',
    };
  }

  private prepareArguments(tests: ReadonlyArray<vscode.TestItem<VSCodeTest>>) {
    const args = [TEST_SCRIPT_PATH, ...this.getDefaultArgs(), '--reporter', 'full-json-stream'];

    const grepRe: string[] = [];
    const runPaths: string[] = [];
    for (const test of tests) {
      if (test.data instanceof WorkspaceTestRoot) {
        return args;
      } else if (test.data instanceof TestCase || test.data instanceof TestSuite) {
        grepRe.push(escapeRe(test.data.fullLabel) + (test.data instanceof TestCase ? '$' : ' '));
      } else if (test.data instanceof TestFile || test.data instanceof DocumentTestRoot) {
        runPaths.push(
          path.relative(test.data.workspaceFolder.uri.fsPath, test.uri.fsPath).replace(/\\/g, '/')
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

  private createWaitServer() {
    const onFound = new vscode.EventEmitter<void>();
    let found = false;

    const server = createServer(socket => {
      if (found) {
        socket.end();
      } else {
        onFound.event(() => socket.end());
      }
    });

    server.listen(0);

    return {
      port: (server.address() as AddressInfo).port,
      onFound: () => {
        found = true;
        onFound.fire();
      },
      dispose: () => {
        server.close();
      },
    };
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
