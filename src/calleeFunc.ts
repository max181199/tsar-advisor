//===--- calleeFunc.ts ------- Call Graph Provider ---------- TypeScript --===//
//
//                           TSAR Advisor (SAPFOR)
//
// This file implements provider to show call graph or its subgraph which
// produces some traits of analyzed project.
//
//===----------------------------------------------------------------------===//

'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import { UpdateUriFunc, headHtml } from './functions';
import {
  gotoExpansionLocLink,
  resolveLocation,
  FileListProviderState,
  FileListProvider
} from './fileList';
import * as log from './log';
import * as msg from './messages';
import {Project} from './project';
import {ProjectWebviewProviderState,
  ProjectWebviewProvider} from './webviewProvider';

import * as PureFunction from './components/pure_function_call_graph/index'
import * as StoreToJSON from './components/store_to_json'


interface Target {
  FuncID: number;
  LoopID: number;
  Attr: msg.StatementAttr [];
}

interface Data {
  Target: Target,
  Complete: boolean,
  Functions: Map<number, msg.Function>,
  CallGraph: Map<msg.Function|msg.Loop, msg.CalleeFuncInfo[]>
  Controll : {
    type : 'node' | 'edge' | null,
    id   : number | null,
    show : {
      common : boolean,
      node : boolean,
      edge : boolean
    },
    isUserFunc : boolean
  }
}

export class CalleeFuncProviderState extends ProjectWebviewProviderState<CalleeFuncProvider> {
  actual(request: any): boolean {
    if (request instanceof msg.FunctionList)
      return this.data !== undefined &&
             this.data.Functions !== undefined;
    return false;
  }

  get active(): boolean { return super.active }

  set active(is: boolean) {
    if (!is && this._data !== undefined) {
      let data = this._data as Data;
      data.Target = undefined;
      data.CallGraph = undefined;
      data.Complete = false;
    }
    super.active = is;
  }

  save_controll_func(data : any) {
    (this._data as Data) = {
      ...this._data,
      Controll : {
        id : data.id !== undefined ? data.id : this._data.Controll.id,
        type : data.type !== undefined ? data.type : this._data.Controll.type,
        show : data.show !== undefined ? {...this._data.Controll.show, ...data.show} : this._data.Controll.show,
        isUserFunc : data.isUserFunc !== undefined ? data.isUserFunc : this._data.Controll.isUserFunc
      }
    }
    return;
  }

  get_controll_func() {
    return (this._data as Data).Controll;
  }

  get_data() {
    return (this._data as Data)
  }

  onResponse(response: any, project: Project): Thenable<Data|undefined> {
    return new Promise(resolve => {
      if (response === undefined) {
        if (this.data !== undefined && this.data.Complete)
          return resolve(this.data);
        return resolve(undefined);
      }
      // Remember list of functions for further usage.
      if (response instanceof msg.FunctionList) {
        // We receive a new list of functions, so dropout a constructed graph
        // because it may be out of data.
        this.active = false;
        project.component_store.save(['global', 'function_list'], response.Functions)
        let functions = new Map<number, msg.Function>();
        for (let f of response.Functions)
          functions.set(f.ID, f);
        let data:Data = {
          Target: undefined,
          Functions: functions,
          Complete: false,
          CallGraph: undefined,
          Controll : {
            id : null,
            type : null,
            show : {
              common : true,
              edge : false,
              node : false,
            },
            isUserFunc : false
          }
        };
        this._data = data;
        return resolve(undefined);
      }
      if (response instanceof msg.CalleeFuncList) {
        // We should build call graph however there is no information about
        // functions. So, let us send corresponding requests to the server.
        if (this._data === undefined ||
            (this._data as Data).Functions === undefined) {
          let data:Data = {
            Target: {
              FuncID: response.FuncID,
              LoopID: response.LoopID,
              Attr: response.Attr
            },
            Complete: false,
            Functions: undefined,
            CallGraph: new Map<msg.Function|msg.Loop, msg.CalleeFuncInfo[]>(),
            Controll : {
              id : null,
              type : null,
              show : {
                common : true,
                edge : false,
                node : false,
              },
              isUserFunc : false
            }
          };
          this._data = data;
          vscode.commands.executeCommand('tsar.function.list', project.uri);
          vscode.commands.executeCommand('tsar.loop.tree',
            project.uri.with({query: JSON.stringify({ID: data.Target.FuncID})}));
          // It is also necessary to repeat current request to remember list of callees.
          let request = new msg.CalleeFuncList();
          Object.assign(request, data.Target);
          project.send(request);
          return resolve(undefined);
        }
        // List of functions is available, so try to build call graph.
        let info = this._data as Data;
        let targetObj:msg.Function|msg.Loop = info.Functions.get(response.FuncID);
        if (info.Target === undefined) {
          info.Target = {
            FuncID: response.FuncID,
            LoopID: response.LoopID,
            Attr: response.Attr
          }
          info.CallGraph = new Map<msg.Function|msg.Loop, msg.CalleeFuncInfo[]>();
          if (response.LoopID)
            targetObj = targetObj.Loops.find(l=> { return l.ID == response.LoopID});
          if (targetObj === undefined) {
            // We should build a call graph for a loop. However, there is no description
            // of a required loop. So, let us send a corresponding request to the server.
            vscode.commands.executeCommand('tsar.loop.tree',
              project.uri.with({query: JSON.stringify({ID: this._data.target.FuncID})}));
            // It is also necessary to repeat current request to remember list of callees.
            let request = new msg.CalleeFuncList();
            Object.assign(request, info.Target);
            return resolve(undefined);
          }
        }
        if (!info.CallGraph.has(targetObj))
          info.CallGraph.set(targetObj, response.Functions);
        for (let callees of info.CallGraph.values())
          for (let callee of callees)
            if (callee.Kind == msg.StatementKind.Call && callee.CalleeID &&
                !info.CallGraph.has(info.Functions.get(callee.CalleeID))) {
              let request = new msg.CalleeFuncList;
              request.FuncID = callee.CalleeID;
              request.Attr = info.Target.Attr;
              request.LoopID = 0;
              project.send(request);
              return resolve(undefined);
            }
        info.Complete = true;
        return resolve(this._data);
      }
      resolve(undefined);
    });
  }
}

function isFunction(obj: msg.Function|msg.Loop): obj is msg.Function {
    return (obj as msg.Function).Loops !== undefined;
}

export class CalleeFuncProvider extends ProjectWebviewProvider {
  static scheme = "tsar-calleefunc";

  public scheme(): string { return CalleeFuncProvider.scheme; }

  public state(): CalleeFuncProviderState {
    return new CalleeFuncProviderState(this);
  }

  protected _title(): string { return log.CallGraph.title; }

  protected _needToHandle(response: any): boolean {
    return response instanceof msg.CalleeFuncList ||
      response instanceof msg.FunctionList;
  }

  protected _provideContent(project: Project, info: Data, asWebvwieUri: UpdateUriFunc): string {
    let state = project.providerState(
      CalleeFuncProvider.scheme) as CalleeFuncProviderState;
    let filesState = project.providerState(FileListProvider.scheme) as
      FileListProviderState;
    let panel = state.panel;
    // Implement Go To command. Note, that identifier for a function
    // must be a number represented as a string. The first symbol
    // for other identifiers must be '.'. For such objects Go To
    // command is not supported at this moment.


    panel.webview.onDidReceiveMessage(message => {
      switch(message.command) {
        case 'goto':
          if ((<string>message.func).startsWith('.', 0))
            break;
          let f = info.Functions.get(Number(message.func));
          vscode.commands.executeCommand('tsar.open-project',
            project.uri.with({
              query: JSON.stringify(resolveLocation(project, f.StartLocation))
            }));
            break;
          case 'save_controll' :
            state.save_controll_func(message.data);
            break;
          default:
            project.component_store.script_save_into_global_store(message.command, message.path, message.data)
            break;
      }
    }, null, state.disposables);


    panel.onDidChangeViewState(e => {
      const panel = e.webviewPanel;
      if (!panel.visible)
        return;
      panel.webview.postMessage(project.component_store.script_restore_message())
      panel.webview.postMessage({
        ...state.get_controll_func(),
        command: 'restore_controll',
      });
    }, null, state.disposables);


    //project.component_store.subscribe(PureFunction.id(), CalleeFuncProvider.scheme)

    let targetFunc = info.Functions.get(info.Target.FuncID);
    let targetObj:msg.Function|msg.Loop = targetFunc;
    let gotoTarget = '';
    if (info.Target.LoopID) {
      targetObj = targetFunc.Loops.find(l=> { return l.ID == info.Target.LoopID});
      gotoTarget = `loop at ${gotoExpansionLocLink(project, targetObj.StartLocation)} in `;
    }
    gotoTarget += `<var>${targetFunc.Name}</var> declared at ` +
      gotoExpansionLocLink(project, targetFunc.StartLocation);
    // Build array of nodes and edges.
    let nodes = '';
    let edges = '';
    let edgeNumber = 0; // use to set id of a new edge
    let numberOfCallees = 0, numberOfCalls = 0;
    let stmtNodes = []; // nodes for statements like goto, break, etc.
    info.CallGraph.forEach((callees, caller) => {
       let callerID = `${caller.ID}`;
       if (caller == targetObj) {
         if (caller == targetFunc) {
           nodes += `{id: '${targetFunc.ID}', label: '${targetFunc.Name}'`;
         } else {
           callerID = `.${targetFunc.ID}.${targetObj.ID}`;
           nodes += `{id: '${callerID}', label: 'loop'`;
         }
         nodes += ',color: "darkorange"';
       } else {
        ++numberOfCallees;
        let f = caller as msg.Function;
        nodes += `{id: '${callerID}', label: '${f.Name}'`;
        if (!f.User)
          nodes += ',color: "lightgrey"';
        else if (f.Traits.Parallel === 'Yes')
          nodes += ',color: "lightgreen"';
        else
          nodes += ',color: "lightcoral"';
       }
       nodes += "},";
       for (let callee of callees) {
         ++edgeNumber;
         let calleeID = `${callee.CalleeID}`;
         // Create node for statement like goto, break etc. if a node is not exist.
         if (callee.Kind != msg.StatementKind.Call || !callee.CalleeID) {
           calleeID = '.' + msg.StatementKind[callee.Kind];
           stmtNodes[callee.Kind] = `{id: '${calleeID}',` +
             `label: '${msg.StatementKind[callee.Kind].toLocaleLowerCase()}', color: "lightsalmon"},`;
         }
         edges += `{id: ${edgeNumber}, from: '${callerID}', to: '${calleeID}'`;
         // Add property to Go To a corresponding statement in a source code from webview.
         if (!isFunction(caller) || caller.User) {
          if (callee.StartLocation.length > 0) {
            edges += `,location: [`;
            for (let loc of callee.StartLocation) {
              if (numberOfCalls >= 0)
                ++numberOfCalls;
              let resolvedLoc = resolveLocation(project, loc);
              let goto = encodeURI('command:tsar.open-project?' +
                JSON.stringify(project.uri.with({
                  query: JSON.stringify(resolvedLoc)
                })));
              edges += `
                {
                  Goto: '${goto}',
                  Filename: '${path.basename(resolvedLoc.Path)}',
                  Line: ${loc.Line},
                  Column: ${loc.Column}
                },`;
            }
            // Remove last comma.
            edges = edges.substr(0, edges.length - 1);
            edges += ']';
          } else {
            numberOfCalls = -1;
          }
        }
        edges += '},';
       }
    });
    for (let n of stmtNodes)
      if (n)
        nodes += n;
    // Remove last comma.
    nodes = nodes.substr(0, nodes.length - 1);
    edges = edges.substr(0, edges.length - 1);
    let subtitle = '';
    if (info.Target.Attr) {
      if (info.Target.Attr.length == 1) {
        switch (info.Target.Attr[0]) {
          case msg.StatementAttr.InOut: subtitle = log.CallGraph.io; break;
          case msg.StatementAttr.Exit: subtitle = log.CallGraph.exit; break;
          case msg.StatementAttr.UnsafeCFG: subtitle = log.CallGraph.unsafeCFG; break;
        }
      } else if (info.Target.Attr.length > 0) {
        subtitle = log.CallGraph.unsafeCFG
        for (let attr of info.Target.Attr)
          if (attr != msg.StatementAttr.UnsafeCFG && attr != msg.StatementAttr.MayNoReturn &&
              attr != msg.StatementAttr.MayReturnTwice && attr != msg.StatementAttr.MayUnwind) {
              subtitle = '';
              break;
          }
       }
    }

    return `
      <!doctype html>
      <html lang="en">
        ${headHtml(asWebvwieUri, {bootstrap: true, visNetwork: true})}
        <body class="bg-white">
          <div class="container-fluid" style="height : 100%; width : 100%; min-width : 800px; min-height : 400px">
            <div class="row" style="height : 100%;">
              <div class="col-8 pt-2 pb-3 d-flex flex-column" style="height : 100%;">
                <div>
                  <h4>${this._title().replace('{0}', gotoTarget)}</h4>
                  <h6>${subtitle}</h5>
                </div>
                <div id="callGraph" class="flex-fill bg-white" style="width : 100%; overflow-y : hidden; overflow-x : hidden; border : 1px solid lightgrey"></div>
              </div>
              <div class="col-4" class="bg-white">
                <div class="accordion accordion_border mt-3 mb-3" id="callInfo">
                  <div class="card show_1" id="callInfoCommon">
                    <div class="card-header" id="callInfoCommonHeader">
                      <h1 class="mb-0">
                          <button id="callButtonCommon" class="btn btn-link btn-block text-left collapsed cst_link" type="button" data-toggle="collapse" data-target="#callInfoCommonCollapse" aria-expanded="true" aria-controls="callInfoCommonCollapse">
                            Graph
                          </button>
                      </h1>
                    </div>
                    <div id="callInfoCommonCollapse" class="collapse show overflow-auto  " aria-labelledby="callInfoCommonHeader" >
                      <div class="card-body p-0 m-0 " >
                        <ul class="list-group list-group-flush" style="width : 100%">
                          <li class="list-group-item">Total number of callees: <span class="blue">${numberOfCallees}</span></li>
                          <li class="list-group-item">Total number of calls from UD functions: <span class="blue">
                            ${numberOfCalls < 0 ? '--' : numberOfCalls}</span></li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <div class="card d-none"  id="callInfoNode">
                    <div class="card-header" id="callInfoNodeHeader">
                      <h2 class="mb-0">
                        <button
                          id="callButtonNode"
                          class="btn btn-link btn-block text-left collapsed cst_link"
                          type="button"
                          data-toggle="collapse"
                          data-target="#callInfoNodeCollapse"
                          aria-expanded="false"
                          aria-controls="callInfoNodeCollapse"
                        >
                          Generate Configuration
                        </button>
                      </h2>
                    </div>
                    <div id="callInfoNodeCollapse" class="collapse overflow-auto " aria-labelledby="callInfoNodeHeader" >
                      <div class="card-body p-0 m-0 overflow-auto ">
                        <ul class="list-group list-group-flush" style="width : 100%">
                          <li class="list-group-item">
                            ${PureFunction.template({id : '_call_graph_pure_function'})}
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>
                  <div class="card d-none" id="callInfoEdge">
                    <div class="card-header" id="callInfoEdgeHeader">
                      <h2 class="mb-0">
                        <button id="callButtonEdge" class="btn btn-link btn-block text-left collapsed cst_link" type="button" data-toggle="collapse" data-target="#callInfoEdgeCollapse" aria-expanded="false" aria-controls="callInfoEdgeCollapse">
                          ${log.CallGraph.callList}
                        </button>
                      </h2>
                    </div>
                    <div id="callInfoEdgeCollapse" class="collapse overflow-auto " aria-labelledby="callInfoEdgeHeader" >
                      <div id="callInfoEdgeBody" class="card-body p-0 m-0 overflow-auto">
                      </div>
                    </div>
                  </div>
                </div>
                <script>
                  $('.collapsed').on('click', function(e){
                    let el = [...document.querySelectorAll('.card.show'), ...document.querySelectorAll('.card.show_1')].filter(el => !el.classList.contains('d-none'))
                    if (el.length <= 1 && e.target.ariaExpanded == 'true') e.stopPropagation();
                  })
                  $('.collapse').on('show.bs.collapse', function(){
                    if ($(this).parents('.card').attr('id') == 'callInfoCommon'){
                      vscode.postMessage({ command: 'save_controll', data: { show : {common : true} }});
                    } else if ($(this).parents('.card').attr('id') == 'callInfoEdge') {
                      vscode.postMessage({ command: 'save_controll', data: { show : {edge : true} }});
                    } else {
                      vscode.postMessage({ command: 'save_controll', data: { show : {node : true} }});
                    }
                    if ($(this).parents('.card').attr('id') == 'callInfoCommon'){
                      $(this).parents('.card').addClass('show_1')
                    } else {$(this).parents('.card').addClass('show')}
                  })
                  $('.collapse').on('hide.bs.collapse', function(){
                    if ($(this).parents('.card').attr('id') == 'callInfoCommon'){
                      vscode.postMessage({ command: 'save_controll', data: { show : {common : false} }});
                    } else if ($(this).parents('.card').attr('id') == 'callInfoEdge') {
                      vscode.postMessage({ command: 'save_controll', data: { show : {edge : false} }});
                    } else {
                      vscode.postMessage({ command: 'save_controll', data: { show : {node : false} }});
                    }
                    let el = document.getElementsByClassName('.show')
                    $(this).parents('.card').removeClass('show')
                    $(this).parents('.card').removeClass('show_1')
                  })
                </script>
              </div>
            </div>
          </div>
          <script type="text/javascript">

            const vscode = acquireVsCodeApi();

            window.addEventListener('message', event => {
              const message = event.data;
              switch (message.command) {
                ${
                  project.component_store.script_load_from_global_store([
                    PureFunction.className()
                  ])
                }
                case "restore_controll":

                    //console.log('MESSAGE',message)

                    if (message.type === null){
                      $('#callInfoEdge').addClass('d-none')
                      $('#callInfoEdgeCollapse').addClass('d-none')
                      $('#callInfoNode').addClass('d-none')
                      $('#callInfoNodeCollapse').addClass('d-none')
                      ${PureFunction.api_template.set_func('_call_graph_pure_function', ' -1')}
                    }

                    if (message.type === 'node'){
                      $('#callInfoEdge').addClass('d-none')
                      $('#callInfoEdgeCollapse').addClass('d-none')
                      if (message.isUserFunc){
                        $('#callInfoNode').removeClass('d-none')
                        $('#callInfoNodeCollapse').removeClass('d-none')
                        ${PureFunction.api_template.set_func('_call_graph_pure_function', 'message.id || -1')}
                      } else {
                        $('#callInfoNode').addClass('d-none')
                        $('#callInfoNodeCollapse').addClass('d-none')
                        ${PureFunction.api_template.set_func('_call_graph_pure_function', ' -1')}
                      }
                    }

                    if (message.type === 'edge'){
                      $('#callInfoEdge').removeClass('d-none')
                      $('#callInfoEdgeCollapse').removeClass('d-none')
                      $('#callInfoNode').addClass('d-none')
                      $('#callInfoNodeCollapse').addClass('d-none')
                      ${PureFunction.api_template.set_func('_call_graph_pure_function', '-1')}
                    }

                    if (message.show.common){
                      $('#callInfoCommon').addClass('show_1');
                      $('#callInfoCommonCollapse').addClass('show')
                      $('#callButtonCommon').addClass('collapsed')
                      $('#callButtonCommon').attr("aria-expanded","true");
                    } else {
                      $('#callInfoCommon').removeClass('show_1');
                      $('#callInfoCommonCollapse').removeClass('show')
                      $('#callButtonCommon').removeClass('collapsed')
                      $('#callButtonCommon').attr("aria-expanded","false");
                    }

                    if (message.show.edge){
                      $('#callInfoEdge').addClass('show');
                      $('#callInfoEdgeCollapse').addClass('show')
                      $('#callButtonEdge').addClass('collapsed')
                      $('#callButtonEdge').attr("aria-expanded","true");
                    } else {
                      $('#callInfoEdge').removeClass('show_1');
                      $('#callInfoEdgeCollapse').removeClass('show')
                      $('#callButtonEdge').removeClass('collapsed')
                      $('#callButtonEdge').attr("aria-expanded","false");
                    }

                    if (message.show.node){
                      $('#callInfoNode').addClass('show');
                      $('#callInfoNodeCollapse').addClass('show')
                      $('#callButtonNode').addClass('collapsed')
                      $('#callButtonNode').attr("aria-expanded","true");
                    } else {
                      $('#callInfoNode').removeClass('show_1');
                      $('#callInfoNodeCollapse').removeClass('show')
                      $('#callButtonNode').removeClass('collapsed')
                      $('#callButtonNode').attr("aria-expanded","false");
                    }

                break;
              }
            });

            var nodes = new vis.DataSet([${nodes}]);
            var edges = new vis.DataSet([${edges}]);

            const function_type = ${
              JSON.stringify(
                [...(state.data as Data).Functions.values()]
                .reduce((prev, cur) => {
                  return {...prev, [cur.ID] : cur.User}
                }, {}),
                null,
                2
              )
            }

            var container = document.getElementById('callGraph');
            var data = {
              nodes: nodes,
              edges: edges
            };
            var options = {
              autoResize: false,
              edges:{
                arrows: {
                  to: {
                    enabled: true,
                    type: "arrow"
                  }
                }
              }
            };

            var network = new vis.Network(container, data, options);

            window.addEventListener('resize', function(event){
              var container = document.getElementById('callGraph');
              let w = container.clientWidth + 2 + 'px'
              let h = container.clientHeight + 2 + 'px'
              network.setSize(w,h)
              network.redraw()
            });

            network.on('doubleClick', selected => {
              if (!selected.nodes || selected.nodes.length == 0)
                return;
              let nodeID = selected.nodes[0];
              vscode.postMessage({ command: 'goto', func: nodeID});
            });


            network.on('click', selected => {

              if (!selected.nodes && !selected.edges){
                $('#callInfoEdge').addClass('d-none')
                $('#callInfoNode').addClass('d-none')
                $('.accordion').addClass('accordion_border')
                return;
              }

              if (selected.nodes && selected.nodes.length > 0) {

                $('#callInfoCommon').addClass('show_1');
                $('#callInfoCommonCollapse').addClass('show')

                $('#callInfoEdge').addClass('d-none')
                $('#callInfoEdge').removeClass('show')

                if (function_type[selected.nodes[0]]){
                  $('#callInfoNode').removeClass('d-none')
                  $('#callInfoNodeCollapse').removeClass('d-none')
                  $('#callInfoNode').addClass('show');
                  $('#callInfoNodeCollapse').addClass('show')
                  $('#callButtonNode').addClass('collapsed')
                  ${PureFunction.api_template.set_func('_call_graph_pure_function', 'selected.nodes[0] || -1')}
                } else {
                  $('#callInfoNode').removeClass('show')
                  $('#callInfoNodeCollapse').removeClass('show')
                  $('#callInfoNode').addClass('d-none');
                  $('#callInfoNodeCollapse').addClass('d-none')
                  $('#callButtonNode').removeClass('collapsed')
                  ${PureFunction.api_template.set_func('_call_graph_pure_function', '-1')}
                }

                $('.accordion').addClass('accordion_border')
                vscode.postMessage({ command: 'save_controll', data: { type : 'node', id : selected.nodes[0], show : {node : true}, isUserFunc : function_type[selected.nodes[0]] }});
                return;
              }

              if (!selected.edges || selected.edges.length != 1) return;

              ${PureFunction.api_template.set_func('_call_graph_pure_function', '-1')}

              let e = edges.get(selected.edges[0]);
              if (!e.location) return;
              vscode.postMessage({ command: 'save_controll', data: { type : 'edge', id : selected.edges[0]}});
              $('#callInfoEdge').removeClass('d-none')
              $('#callInfoNode').addClass('d-none')
              if (!$('#callInfoEdge').hasClass('show')) {$('#callInfoCommon').addClass('show_1'); $('#callInfoCommonCollapse').addClass('show') }
              $('.accordion').removeClass('accordion_border')

              const from = nodes.get(e.from);
              const to = nodes.get(e.to);
              let html = '<ul class="list-group list-group-flush" style="width : 100%">'
              html +=      '<li class="list-group-item">From  <span class="blue">' + from.label + '</span> to  <span class="blue">' + to.label + '</span></li>'
              for (let loc in e.location) {
                html +=      '<li class="list-group-item">'
                html +=         '<a class="source-link" title="${log.Command.gotoCode}" href="' + e.location[loc].Goto + '">'
                html +=             e.location[loc].Filename + ':' + e.location[loc].Line + ':' + e.location[loc].Column
                html +=         '</a>';
                html +=      '</li>'
              }
              html +=    '</ul>'
              $('#callInfoEdgeBody').html(html)
              return;
            });
          </script>
          ${PureFunction.script(project.component_store.get())}
          ${PureFunction.style()}
        </body>
      </html>`;
  }
}
