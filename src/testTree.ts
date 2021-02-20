/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Location, TestItem, Uri, WorkspaceFolder } from 'vscode';

const locationEquals = (a: Location, b: Location) =>
  a.uri.toString() === b.uri.toString() && a.range.isEqual(b.range);

export const idPrefix = 'ms-vscode.vscode-selfhost-test-provider/';

export class TestItemWithChildren {
  public get children() {
    return [...this.childrenByName.values()];
  }

  private readonly childrenByName = new Map<string, TestSuite | TestCase>();

  /**
   * Adds or merges in a direct child with this item.
   */
  public addChild(suiteOrCase: TestSuite | TestCase): [TestSuite | TestCase, boolean] {
    const existing = this.childrenByName.get(suiteOrCase.label);
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

    this.childrenByName.set(suiteOrCase.label, suiteOrCase);
    return [suiteOrCase, false];
  }

  /**
   * Removes test cases in the file that were from a generation before the
   * given one. Returns whether it has any children left.
   */
  public prune(inFile: Uri, generation: number, changes: Set<VSCodeTest>) {
    for (const [name, child] of this.childrenByName) {
      if (child instanceof TestCase) {
        if (child.location.uri.toString() === inFile.toString() && child.generation < generation) {
          this.childrenByName.delete(name);
          changes.add((this as unknown) as VSCodeTest);
        }
      } else {
        if (!child.prune(inFile, generation, changes)) {
          this.childrenByName.delete(name);
          changes.delete(child);
          changes.add((this as unknown) as VSCodeTest);
        }
      }
    }

    return this.childrenByName.size > 0;
  }
}

export class TestRoot extends TestItemWithChildren implements TestItem {
  public readonly label = 'VS Code Unit Tests';
  public readonly runnable = true;
  public readonly debuggable = true;

  public get id() {
    return idPrefix;
  }

  public get root() {
    return this;
  }

  constructor(public readonly workspaceFolder: WorkspaceFolder) {
    super();
  }
}

export class TestSuite extends TestItemWithChildren implements TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;
  public suite?: TestSuite;

  public get id(): string {
    return this.suite ? `${this.suite.id} ${this.label}` : idPrefix + this.label;
  }

  constructor(
    public readonly label: string,
    public location: Location,
    public readonly root: TestRoot
  ) {
    super();
  }

  /**
   * @override
   */
  public addChild(suiteOrCase: TestSuite | TestCase) {
    const deduped = super.addChild(suiteOrCase);
    deduped[0].suite = this;
    return deduped;
  }
}

export class TestCase implements TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;
  public suite?: TestSuite;

  public get id(): string {
    return this.suite ? `${this.suite.id} ${this.label}` : idPrefix + this.label;
  }

  constructor(
    public readonly label: string,
    public location: Location,
    public generation: number,
    public readonly root: TestRoot
  ) {
    this.label = label || '<empty>';
  }
}

export type VSCodeTest = TestRoot | TestSuite | TestCase;
