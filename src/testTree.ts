/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Location, TestItem, Uri, WorkspaceFolder } from 'vscode';

const locationEquals = (a: Location, b: Location) =>
  a.uri.toString() === b.uri.toString() && a.range.isEqual(b.range);

export const idPrefix = 'ms-vscode.vscode-selfhost-test-provider/';

export class TestItemWithChildren extends TestItem {
  public children: (TestSuite | TestCase)[] = [];
  /**
   * Adds or merges in a direct child with this item.
   */
  public addChild(suiteOrCase: TestSuite | TestCase): [TestSuite | TestCase, boolean] {
    const existing = this.children.find(c => c.label === suiteOrCase.label);
    if (existing instanceof TestCase) {
      if (suiteOrCase instanceof TestCase) {
        existing.generation = suiteOrCase.generation;
        const changed = !locationEquals(suiteOrCase.location, existing.location);
        existing.location = suiteOrCase.location;
        return [existing, changed];
      }
    } else if (existing instanceof TestSuite && suiteOrCase instanceof TestSuite) {
      const changed = !locationEquals(suiteOrCase.location, existing.location);
      existing.location = suiteOrCase.location;
      return [existing, changed];
    }

    this.children.push(suiteOrCase);
    return [suiteOrCase, false];
  }

  /**
   * Removes test cases in the file that were from a generation before the
   * given one. Returns whether it has any children left.
   */
  public prune(inFile: Uri, generation: number, changes: Set<VSCodeTest>) {
    this.children = this.children.filter(child => {
      if (child instanceof TestCase) {
        if (child.location.uri.toString() === inFile.toString() && child.generation < generation) {
          changes.add((this as unknown) as VSCodeTest);
          return false;
        }
      } else {
        if (!child.prune(inFile, generation, changes)) {
          changes.delete(child);
          changes.add((this as unknown) as VSCodeTest);
          return false;
        }
      }

      return true;
    });

    return this.children.length > 0;
  }
}

export class TestRoot extends TestItemWithChildren implements TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;

  public get root() {
    return this;
  }

  constructor(public readonly workspaceFolder: WorkspaceFolder, id: string) {
    super(idPrefix + id, 'VS Code Unit Tests');
  }
}

export class TestSuite extends TestItemWithChildren implements TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;

  constructor(
    public readonly label: string,
    public location: Location,
    public readonly root: TestRoot,
    public readonly parent: TestSuite | TestRoot
  ) {
    super(
      parent instanceof TestSuite ? `${parent.id} ${label}` : idPrefix + label,
      label || '<empty>'
    );
  }
}

export class TestCase extends TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;

  constructor(
    public readonly label: string,
    public location: Location,
    public generation: number,
    public readonly root: TestRoot,
    public readonly parent: TestSuite | TestRoot
  ) {
    super(
      parent instanceof TestSuite ? `${parent.id} ${label}` : idPrefix + label,
      label || '<empty>'
    );
  }
}

export type VSCodeTest = TestRoot | TestSuite | TestCase;
