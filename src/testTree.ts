/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { join, relative } from 'path';
import * as ts from 'typescript';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { extractTestFromNode } from './sourceUtils';

const textDecoder = new TextDecoder('utf-8');

let generationCounter = 0;

type ContentGetter = (uri: vscode.Uri) => Promise<string>;

/**
 * Tries to guess which workspace folder VS Code is in.
 */
export const guessWorkspaceFolder = async () => {
  if (!vscode.workspace.workspaceFolders) {
    return undefined;
  }

  if (vscode.workspace.workspaceFolders.length < 2) {
    return vscode.workspace.workspaceFolders[0];
  }

  for (const folder of vscode.workspace.workspaceFolders) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, 'src/vs/loader.js'));
      return folder;
    } catch {
      // ignored
    }
  }

  return undefined;
};

export const getContentFromFilesystem: ContentGetter = async uri => {
  try {
    const rawContent = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(rawContent);
  } catch (e) {
    console.warn(`Error providing tests for ${uri.fsPath}`, e);
    return '';
  }
};

export class TestRoot {}

export class TestFile {
  public hasBeenRead = false;

  constructor(
    public readonly uri: vscode.Uri,
    public readonly workspaceFolder: vscode.WorkspaceFolder
  ) {}

  public getId() {
    return this.uri.toString().toLowerCase();
  }

  public getLabel() {
    return relative(join(this.workspaceFolder.uri.fsPath, 'src', 'vs'), this.uri.fsPath);
  }

  public async updateFromDisk(
    controller: vscode.TestController,
    item: vscode.TestItem,
    invalidate?: boolean
  ) {
    try {
      const content = await getContentFromFilesystem(item.uri!);
      item.error = undefined;
      this.updateFromContents(controller, content, item, invalidate);
    } catch (e) {
      item.error = e.stack;
    }
  }

  /**
   * Refreshes all tests in this file, `sourceReader` provided by the root.
   */
  public updateFromContents(
    controller: vscode.TestController,
    content: string,
    item: vscode.TestItem,
    invalidate = false
  ) {
    try {
      const ast = ts.createSourceFile(
        this.uri.path.split('/').pop()!,
        content,
        ts.ScriptTarget.ESNext,
        false,
        ts.ScriptKind.TS
      );

      const parents: vscode.TestItem<TestFile | TestSuite>[] = [item];
      const thisGeneration = generationCounter++;
      const traverse = (node: ts.Node) => {
        const parent = parents[parents.length - 1];
        const childData = extractTestFromNode(ast, node, parent.data, thisGeneration);
        if (!childData) {
          ts.forEachChild(node, traverse);
          return;
        }

        const id = `${item.uri}/${childData.fullName}`.toLowerCase();
        let child = parent.children.get(id);
        if (child) {
          // location is the only thing that changes in existing items
          child.range = childData.range;
          child.data.generation = thisGeneration;
          if (invalidate) {
            child.invalidate();
          }
        } else {
          child = controller.createTestItem(id, childData.name, parent, item.uri, childData);
          child.debuggable = true;
          child.range = childData.range;
        }

        if (child.data instanceof TestSuite) {
          parents.push(child);
          ts.forEachChild(node, traverse);
          parents.pop();
        }
      };

      ts.forEachChild(ast, traverse);
      this.prune(item, thisGeneration);
      item.error = undefined;
      this.hasBeenRead = true;
    } catch (e) {
      item.error = String(e.stack || e.message);
    }
  }

  /**
   * Removes tests that were deleted from the source. Each test suite and case
   * has a 'generation' counter which is updated each time we discover it. This
   * is called after discovery is finished to remove any children who are no
   * longer in this generation.
   */
  private prune(item: vscode.TestItem, thisGeneration: number) {
    const queue = [item];
    for (const parent of queue) {
      for (const child of parent.children.values()) {
        if (child.data.generation < thisGeneration) {
          child.dispose();
        } else if (child.data instanceof TestSuite) {
          queue.push(child);
        }
      }
    }
  }
}

export abstract class TestConstruct {
  public fullName: string;

  constructor(
    public readonly name: string,
    public readonly range: vscode.Range,
    public generation: number,
    parent?: TestConstruct
  ) {
    this.fullName = parent ? `${parent.fullName} ${name}` : name;
  }
}

export class TestSuite extends TestConstruct {}

export class TestCase extends TestConstruct {}

export type VSCodeTest = TestRoot | TestFile | TestSuite | TestCase;
