/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { VSCodeTestController } from './vscodeTestProvider';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.test.registerTestController(new VSCodeTestController()));
}
