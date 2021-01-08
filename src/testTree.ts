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
import { states } from './stateRegistry';

const locationEquals = (a: Location, b: Location) =>
  a.uri.toString() === b.uri.toString() && a.range.isEqual(b.range);

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
   * Disposes of the node and all its children.
   */
  public dispose() {
    for (const child of this.children.values()) {
      child.dispose();
    }
  }

  /**
   * Removes test cases in the file that were from a generation before the
   * given one. Returns whether it has any children left.
   */
  public prune(inFile: Uri, generation: number, changes: Set<VSCodeTest>) {
    for (const [name, child] of this.childrenByName) {
      if (child instanceof TestCase) {
        if (child.location.uri.toString() === inFile.toString() && child.generation < generation) {
          child.dispose();
          this.childrenByName.delete(name);
          changes.add((this as unknown) as VSCodeTest);
        }
      } else {
        if (!child.prune(inFile, generation, changes)) {
          child.dispose();
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
  private _state = new TestState(TestRunState.Unset);
  private disposeListener?: () => void;
  public suite?: TestSuite;

  public get state() {
    return this._state;
  }

  public set state(s: TestState) {
    if (s === this._state) {
      return;
    }

    this._state = s;
    if (this.disposeListener) {
      states.update(this.fullTitle, s);
      this.changeEmitter.fire(this); // don't fire before connection
    }
  }

  public get fullTitle(): string {
    return this.suite ? `${this.suite.fullTitle} ${this.label}` : this.label;
  }

  constructor(
    public readonly label: string,
    public location: Location,
    public generation: number,
    public readonly root: TestRoot,
    private readonly changeEmitter: EventEmitter<VSCodeTest>
  ) {
    this.label = label || '<empty>';
  }

  public connect() {
    this.state = states.current(this.fullTitle);
    this.disposeListener = states.listen(this.fullTitle, s => (this.state = s));
  }

  public dispose() {
    this.disposeListener?.();
  }
}

export type VSCodeTest = TestRoot | TestSuite | TestCase;
