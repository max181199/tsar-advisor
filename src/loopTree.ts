'use strict'

import * as vscode from 'vscode';
import {decodeLocation, encodeLocation,
  projectLink, numberHtml, styleLink,
  unavailableHtml, waitHtml} from './functions';
import * as log from './log';
import * as msg from './messages';
import {ProjectEngine, Project,
  ProjectContentProvider, ProjectContentProviderState} from './project';

/**
 * State of a loop tree content provider.
 */
class LoopTreeProviderState implements ProjectContentProviderState {
  private _provider: LoopTreeProvider;
  constructor(provider: LoopTreeProvider) { this._provider = provider; }
  response: any;
  get provider (): LoopTreeProvider { return this._provider;}
  dispose(): any {}
}

/**
 * Provides a general information about analyzed project.
 */
export class LoopTreeProvider implements ProjectContentProvider{
  static scheme = "tsar-looptree";
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  private _engine: ProjectEngine;

  constructor(engine: ProjectEngine) { this._engine = engine; }
  dispose() { this._onDidChange.dispose(); }

  /**
   * Returns new description of a project content provider state.
   */
  state(): LoopTreeProviderState {
    return new LoopTreeProviderState(this);
  }

  /**
   * Informs listeners about content changes.
   *
   * If this provider has been registered after call of this method
   * provideTextDocumentContent() will be called to update visible content.
   */
  update(project: Project) {
    this._onDidChange.fire(encodeLocation(LoopTreeProvider.scheme, project.uri));
  }

  /**
   * Returns event to subscribe for content changes.
   */
  get onDidChange(): vscode.Event<vscode.Uri> {
    return this._onDidChange.event;
  }

  /**
   * Provides html with general information about analyzed project.
   */
  public provideTextDocumentContent(uri: vscode.Uri): Thenable<string>|string {
    let prjUri = <vscode.Uri>decodeLocation(uri).shift();
    let project = this._engine.project(prjUri);
    if (project === undefined)
      return unavailableHtml(prjUri);
    let state = <LoopTreeProviderState>project.providerState(LoopTreeProvider.scheme);
    if (project.response !== undefined &&
        project.response instanceof msg.FunctionList)
      state.response = project.response;
    let response = state.response;
    return new Promise((resolve, reject) => {
      if (response !== undefined && response instanceof msg.FunctionList)
        return resolve(this._provideFunctionList(project, response));
      return resolve(waitHtml(log.FunctionList.title, project));
    });
  }

  private _provideFunctionList(project: Project, funclst: msg.FunctionList): string {
    let result = `<!DOCTYPE html><html>`;
    result += `<table><tr><th>Functions and Loops</th><th>Level</th></tr>`
    let funclen = funclst.Functions.length;
    for (let i = 0; i < funclen; i++) {
      let func = funclst.Functions[i];
      let loopslen = func.Loops.length;
      result += `<tr><td>${func.Name}</th><td>0</td></tr>`;
      for (let j = 0; j < loopslen; j++) {
        let loop = func.Loops[j];
        result += `<tr><td>`
        for (let k = 0; k < loop.Level; k++) {
          result += `&ensp;`;
        }
        result += `loop in ${func.Name} at ${loop.StartLine}:${loop.StartCol}-${loop.EndLine}:${loop.EndCol}</td>`;
        result += `<td>${loop.Level}</td></tr>`;
      }
    }
    result += `</table>`;
    result += `</html>`;
    return result;
  }
}