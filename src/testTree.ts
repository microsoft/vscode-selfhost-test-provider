/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { join, relative } from 'path';
import * as ts from 'typescript';
import { TextDecoder } from 'util';
import * as vscode from 'vscode';
import { extractTestFromNode } from './sourceUtils';

const textDecoder = new TextDecoder('utf-8');
const TEST_FILE_PATTERN = 'src/vs/**/*.test.ts';

export class TestRoot {
  constructor(public readonly workspaceFolder: vscode.WorkspaceFolder) {}
}

export class WorkspaceTestRoot extends TestRoot {
  public static create(workspaceFolder: vscode.WorkspaceFolder) {
    const item = vscode.test.createTestItem<WorkspaceTestRoot, TestFile>(
      { id: 'vscodetests', label: 'VS Code Tests', uri: workspaceFolder.uri },
      new WorkspaceTestRoot(workspaceFolder)
    );

    item.status = vscode.TestItemStatus.Pending;
    item.resolveHandler = token => {
      const pattern = new vscode.RelativePattern(workspaceFolder, TEST_FILE_PATTERN);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const contentChange = new vscode.EventEmitter<vscode.Uri>();

      watcher.onDidCreate(uri =>
        item.addChild(
          TestFile.create(uri, getContentFromFilesystem, contentChange.event, workspaceFolder)
        )
      );
      watcher.onDidChange(uri => contentChange.fire(uri));
      watcher.onDidDelete(uri => item.children.get(uri.toString())?.dispose());
      token.onCancellationRequested(() => {
        item.status = vscode.TestItemStatus.Pending;
        watcher.dispose();
      });

      vscode.workspace.findFiles(pattern).then(files => {
        for (const file of files) {
          item.addChild(
            TestFile.create(file, getContentFromFilesystem, contentChange.event, workspaceFolder)
          );
        }

        item.status = vscode.TestItemStatus.Resolved;
      });
    };

    return item;
  }
}

export class DocumentTestRoot extends TestRoot {
  public static create(document: vscode.TextDocument, workspaceFolder: vscode.WorkspaceFolder) {
    const item = vscode.test.createTestItem<DocumentTestRoot, TestFile>(
      { id: 'vscodetests', label: 'VS Code Tests', uri: document.uri },
      new DocumentTestRoot(workspaceFolder)
    );

    item.status = vscode.TestItemStatus.Pending;
    item.resolveHandler = token => {
      const contentChange = new vscode.EventEmitter<vscode.Uri>();
      const changeListener = vscode.workspace.onDidChangeTextDocument(e => {
        contentChange.fire(e.document.uri);
      });

      const file = TestFile.create(
        document.uri,
        () => Promise.resolve(document.getText()),
        contentChange.event,
        workspaceFolder
      );
      item.addChild(file);

      token.onCancellationRequested(() => {
        changeListener.dispose();
        item.status = vscode.TestItemStatus.Pending;
      });

      item.status = vscode.TestItemStatus.Resolved;
    };

    return item;
  }
}

const getFullLabel = (parent: vscode.TestItem<TestSuite | TestFile>, label: string): string =>
  parent.data instanceof TestSuite ? `${parent.data.fullLabel} ${label}` : label;

let generationCounter = 0;

type ContentGetter = (uri: vscode.Uri) => Promise<string>;

export const getContentFromFilesystem: ContentGetter = async uri => {
  try {
    const rawContent = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(rawContent);
  } catch (e) {
    console.warn(`Error providing tests for ${uri.fsPath}`, e);
    return '';
  }
};

export class TestFile {
  public static create(
    uri: vscode.Uri,
    contentGetter: ContentGetter,
    onContentChange: vscode.Event<vscode.Uri>,
    workspaceFolder: vscode.WorkspaceFolder
  ) {
    const item = vscode.test.createTestItem<TestFile>({
      id: `vscodetests/${uri}`,
      label: relative(join(workspaceFolder.uri.fsPath, 'src', 'vs'), uri.fsPath),
      uri,
    });

    item.data = new TestFile(workspaceFolder, contentGetter, item);
    item.status = vscode.TestItemStatus.Pending;
    item.resolveHandler = token => {
      const doRefresh = (invalidate: boolean) => {
        item.data.refresh(invalidate).then(() => {
          if (!token.isCancellationRequested) {
            item.status = vscode.TestItemStatus.Resolved;
          }
        });
      };

      const listener = onContentChange(uri => {
        if (uri.toString() === uri.toString()) {
          doRefresh(true);
        }
      });

      token.onCancellationRequested(() => {
        item.status = vscode.TestItemStatus.Pending;
        listener.dispose();
      });

      doRefresh(false);
    };

    return item;
  }

  constructor(
    public readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly getContent: ContentGetter,
    private readonly item: vscode.TestItem<TestFile>
  ) {}

  /**
   * Refreshes all tests in this file, `sourceReader` provided by the root.
   */
  public async refresh(invalidate = false) {
    try {
      const decoded = await this.getContent(this.item.uri);
      const ast = ts.createSourceFile(
        this.item.uri.path.split('/').pop()!,
        decoded,
        ts.ScriptTarget.ESNext,
        false,
        ts.ScriptKind.TS
      );

      const parents: vscode.TestItem<TestFile | TestSuite>[] = [this.item];
      const thisGeneration = generationCounter++;
      const traverse = (node: ts.Node) => {
        const parent = parents[parents.length - 1];
        const newItem = extractTestFromNode(ast, node, parent, thisGeneration);
        if (!newItem) {
          ts.forEachChild(node, traverse);
          return;
        }

        const existing = parent.children.get(newItem.id);
        if (existing) {
          // location is the only thing that changes in existing items
          existing.range = newItem.range;
          existing.data.generation = thisGeneration;
          if (invalidate) {
            existing.invalidate();
          }
        } else {
          parent.addChild(newItem);
        }

        const finalItem = existing || newItem;
        if (finalItem.data instanceof TestSuite) {
          parents.push(finalItem);
          ts.forEachChild(node, traverse);
          parents.pop();
        }
      };

      ts.forEachChild(ast, traverse);
      this.prune(thisGeneration);
    } catch (e) {
      this.item.error = String(e.stack || e.message);
    }
  }

  /**
   * Removes tests that were deleted from the source. Each test suite and case
   * has a 'generation' counter which is updated each time we discover it. This
   * is called after discovery is finished to remove any children who are no
   * longer in this generation.
   */
  private prune(thisGeneration: number) {
    const queue: vscode.TestItem<TestFile | TestSuite, TestSuite | TestCase>[] = [this.item];
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

export class TestSuite {
  public static create(
    label: string,
    range: vscode.Range,
    generation: number,
    parent: vscode.TestItem<TestSuite | TestFile>
  ) {
    const item = vscode.test.createTestItem(
      {
        id: JSON.stringify({
          label: getFullLabel(parent, label),
          uri: parent.uri,
        }),
        label,
        uri: parent.uri,
      },
      new TestSuite(generation, getFullLabel(parent, label))
    );

    item.range = range;
    return item;
  }

  constructor(public generation: number, public fullLabel: string) {}
}

export class TestCase {
  public static create(
    label: string,
    range: vscode.Range,
    generation: number,
    parent: vscode.TestItem<TestSuite | TestFile>
  ) {
    const item = vscode.test.createTestItem(
      {
        id: JSON.stringify({
          label: getFullLabel(parent, label),
          uri: parent.uri,
        }),
        label,
        uri: parent.uri,
      },
      new TestCase(generation, getFullLabel(parent, label))
    );

    item.range = range;
    return item;
  }

  constructor(public generation: number, public fullLabel: string) {}
}

export type VSCodeTest = WorkspaceTestRoot | DocumentTestRoot | TestFile | TestSuite | TestCase;
