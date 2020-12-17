/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
  EventEmitter,
  Location,
  TestItem,
  TestRunState,
  TestState,
  Uri,
  WorkspaceFolder,
} from 'vscode';

export class TestItemWithChildren {
  public get children() {
    return [...this.childrenByName.values()];
  }

  private readonly childrenByName = new Map<string, TestSuite | TestCase>();

  /**
   * Adds or merges in a direct child with this item.
   */
  public addChild(suiteOrCase: TestSuite | TestCase) {
    const existing = this.childrenByName.get(suiteOrCase.label);
    if (existing instanceof TestCase) {
      if (suiteOrCase instanceof TestCase) {
        existing.generation = suiteOrCase.generation;
        return existing;
      }
    } else if (existing instanceof TestSuite && suiteOrCase instanceof TestSuite) {
      return existing;
    }

    this.childrenByName.set(suiteOrCase.label, suiteOrCase);
    return suiteOrCase;
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
  public readonly state = new TestState(TestRunState.Unset);

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
  public readonly state = new TestState(TestRunState.Unset);
  public suite?: TestSuite;

  public get fullTitle(): string {
    return this.suite ? `${this.suite.fullTitle} ${this.label}` : this.label;
  }

  constructor(public readonly label: string, public readonly root: TestRoot) {
    super();
  }

  /**
   * @override
   */
  public addChild(suiteOrCase: TestSuite | TestCase) {
    const deduped = super.addChild(suiteOrCase);
    deduped.suite = this;
    return deduped;
  }
}

export class TestCase implements TestItem {
  public readonly runnable = true;
  public readonly debuggable = true;
  private _state = new TestState(TestRunState.Unset);
  public suite?: TestSuite;

  public get state() {
    return this._state;
  }

  public set state(s: TestState) {
    this._state = s;
    this.changeEmitter.fire(this);
  }

  public get fullTitle(): string {
    return this.suite ? `${this.suite.fullTitle} ${this.label}` : this.label;
  }

  constructor(
    public readonly label: string,
    public readonly location: Location,
    public generation: number,
    public readonly root: TestRoot,
    private readonly changeEmitter: EventEmitter<VSCodeTest>
  ) {}
}

export type VSCodeTest = TestRoot | TestSuite | TestCase;
