import { FileStat, FileTuple, path as pathUtils } from '@shopify/theme-check-common';
import * as path from 'node:path';
import { commands, Disposable, Range, DecorationOptions,ExtensionContext, languages, Uri, workspace, WebviewPanel, ViewColumn, window, Position } from 'vscode';
import {
  DocumentSelector,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { documentSelectors } from '../common/constants';
import LiquidFormatter from '../common/formatter';
import { vscodePrettierFormat } from './formatter';
import { execSync } from 'node:child_process';

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

let client: LanguageClient | undefined;

const fileDecorationType = window.createTextEditorDecorationType({
  before: {
    margin: '0 0 1rem 0',
    textDecoration: 'none',
  },
  rangeBehavior: 1 // DecorationRangeBehavior.ClosedOpen
});

const lineDecorationType = window.createTextEditorDecorationType({
  backgroundColor: 'rgba(173, 216, 230, 0.2)',
  border: '1px solid rgba(173, 216, 230, 0.5)',
  borderRadius: '3px',
});

class ThemePreviewPanel {
  public static currentPanel: ThemePreviewPanel | undefined;
  private readonly _panel: WebviewPanel;
  private readonly _context: ExtensionContext;
  private _disposables: Disposable[] = [];
  private static decorations = new Map<string, DecorationOptions[]>();

  private constructor(panel: WebviewPanel, context: ExtensionContext) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._context = context;
  }

  public static async createOrShow(context: ExtensionContext, url: string) {
    const column = ViewColumn.Beside;
    const profile  = getProfileContents(url);
    if (ThemePreviewPanel.currentPanel) {
      ThemePreviewPanel.currentPanel._panel.reveal(column);
      ThemePreviewPanel.currentPanel.processProfileResults(profile);
      // Clear the current html
      ThemePreviewPanel.currentPanel._panel.webview.html = '';
      ThemePreviewPanel.currentPanel._panel.webview.html = await ThemePreviewPanel.currentPanel._getInitialHtml(profile);
      return;
    }

    const panel = window.createWebviewPanel(
      'themePreview',
      'Liquid Profile',
      column,
      {
        enableScripts: true,
        // Allow files in the user's workspace (.tmp directory) to be used as local resources
        localResourceRoots: [
          ...(workspace.workspaceFolders ? workspace.workspaceFolders.map(folder => folder.uri) : []),
          Uri.file(context.asAbsolutePath(path.join('resources', 'speedscope')))
        ]
      }
    );

    ThemePreviewPanel.currentPanel = new ThemePreviewPanel(panel, context);
    ThemePreviewPanel.currentPanel._panel.webview.html = await ThemePreviewPanel.currentPanel._getInitialHtml(profile);
    ThemePreviewPanel.currentPanel.processProfileResults(profile);
  }
  
  public get panel() {
    return this._panel;
  }

  private async _getInitialHtml(profileContents: string) {
    const indexHtmlPath = Uri.file(this._context.asAbsolutePath(path.join('resources', 'speedscope', 'index.html')));
    const indexHtml = await workspace.fs.readFile(indexHtmlPath);
    let htmlContent = Buffer.from(indexHtml).toString('utf8');

    // Convert local resource paths to vscode-resource URIs
    const cssUri = this._panel.webview.asWebviewUri(Uri.file(this._context.asAbsolutePath(path.join('resources', 'speedscope', 'source-code-pro.52b1676f.css'))));
    const resetCssUri = this._panel.webview.asWebviewUri(Uri.file(this._context.asAbsolutePath(path.join('resources', 'speedscope', 'reset.8c46b7a1.css'))));
    const jsUri = this._panel.webview.asWebviewUri(Uri.file(this._context.asAbsolutePath(path.join('resources', 'speedscope', 'speedscope.6f107512.js'))));
    //const scopeUri = this._panel.webview.asWebviewUri(Uri.file(this._context.asAbsolutePath(path.join('resources', 'speedscope', 'mcliquid-profile.json'))));

    // Replace paths in HTML content
    htmlContent = htmlContent.replace('source-code-pro.52b1676f.css', cssUri.toString());
    htmlContent = htmlContent.replace('reset.8c46b7a1.css', resetCssUri.toString());
    htmlContent = htmlContent.replace('speedscope.6f107512.js', jsUri.toString());

    const tmpDir = workspace.workspaceFolders?.[0].uri.fsPath;
    const tmpFile = path.join(tmpDir!, '.tmp', 'profile.json');
    await workspace.fs.writeFile(Uri.file(tmpFile), Buffer.from(profileContents));
    const tmpUri = this._panel.webview.asWebviewUri(Uri.file(tmpFile));
    htmlContent = htmlContent.replace('__PROFILE_URL__', encodeURIComponent(tmpUri.toString()));

    // // Insert the CSP into the HTML content
    // const modifiedHtmlContent = htmlContent.replace('<head>', `<head>${csp}`);

    // console.log('[Theme Preview] Index HTML with CSP:', modifiedHtmlContent);
    // also return pageContents
    return htmlContent;
  }

  public dispose() {
    ThemePreviewPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  public async processProfileResults(profileData: string) {
    console.log('[Theme Preview] Processing profile results for decorations');
    try {
      // Clear existing decorations
      ThemePreviewPanel.decorations.clear();
      const visibleEditorsToClear = window.visibleTextEditors;
      for (const editor of visibleEditorsToClear) {
        editor.setDecorations(fileDecorationType, []);
        editor.setDecorations(lineDecorationType, []);
      }
      
      // Parse using speedscope's file format parser
      const parsedProfile = JSON.parse(profileData.toString());
      console.log('[Theme Preview] Parsed profile structure:', parsedProfile);

      const profile = parsedProfile.profiles[0];
      const frames = parsedProfile.shared.frames;
      
      // Map to store file paths and their execution times
      const fileExecutionTimes = new Map<string, number>();
      const lineExecutionTimes = new Map<string, number>();
      const openEvents = new Map<number, number>(); // frameId -> startTime

      // Process events to calculate execution times
      profile.events.forEach(event => {
        const frameId = event.frame; // index of the frame eg 24
        const frame = frames[frameId]; // shared frame 
        
        if (event.type === 'O') { // Open event
          openEvents.set(frameId, event.at);
        } else if (event.type === 'C') { // Close event
          const startTime = openEvents.get(frameId);
          if (startTime !== undefined) {
            const duration = event.at - startTime; // in nanoseconds
            
            // sum up the durations on the frameId
            if (frame.file && (frame.file.startsWith('sections/') || frame.file.startsWith('snippets/'))) {
              let current = lineExecutionTimes.get(frameId) || 0;
              lineExecutionTimes.set(frameId, current + duration); 
                          
              const liquidFile = `${frame.file}.liquid`;
              current = fileExecutionTimes.get(liquidFile) || 0;
              fileExecutionTimes.set(liquidFile, current + duration);
            }
            
            openEvents.delete(frameId);
          }
        }
      });

      console.log('[Theme Preview] Calculated file execution times:', 
        Object.fromEntries([...fileExecutionTimes.entries()].map(
          ([file, time]) => [file, `${(time / 1000000).toFixed(2)}ms`]
        ))
      );

      console.log('[Theme Preview] Calculated line execution times:', 
        Object.fromEntries([...lineExecutionTimes.entries()].map(
          ([frameId, time]) => [frameId, `${(time / 1000000).toFixed(2)}ms`]
        ))
      );

      // Create and apply decorations
      const workspaceFolders = workspace.workspaceFolders;
      if (!workspaceFolders) {
        console.error('[Theme Preview] No workspace folders found');
        return;
      }
      const rootPath = workspaceFolders[0].uri.fsPath;

      // Apply decorations
      for (const [liquidFile, duration] of fileExecutionTimes) {
        const fullPath = path.join(rootPath, liquidFile);
        try {
          const uri = Uri.file(fullPath);
          const document = await workspace.openTextDocument(uri);
          
          // Create decoration for the first line of the file
          const firstLine = document.lineAt(0);
          const decoration: DecorationOptions = {
            range: firstLine.range,
            renderOptions: {
              after: {
                contentText: ` (File) ⏱️ ${(duration / 1000000).toFixed(2)}ms`,
                color: this.getColorForDuration(duration),
              }
            }
          };

          // Store decoration for this file
          ThemePreviewPanel.decorations.set(uri.fsPath, [decoration]);
          
          const visibleEditors = window.visibleTextEditors;
          // store the paths it's been applied to in a set
          const appliedPaths = new Set<string>();
          for (const editor of visibleEditors) {
            if (editor.document.uri.fsPath === uri.fsPath && !appliedPaths.has(editor.document.uri.fsPath)) {
              console.log(`[Theme Preview] Applying file decoration for ${liquidFile} (${(duration / 1000000).toFixed(2)}ms)`);
              editor.setDecorations(fileDecorationType, [decoration]);
              appliedPaths.add(editor.document.uri.fsPath);
            }
          }

          console.log(`[Theme Preview] Created file decoration for ${liquidFile} (${(duration / 1000000).toFixed(2)}ms)`);
        } catch (err) {
          console.error(`[Theme Preview] Error creating file decoration for ${fullPath}:`, err);
        }
      }

      // Decorations for lines
      for (const [frameId, duration] of lineExecutionTimes) {
        try {
          const frame = frames[frameId];
          const uri = Uri.file(path.join(rootPath, `${frame.file}.liquid`));
          const document = await workspace.openTextDocument(uri);
          // If frame.name starts with 'variable:', then scan the line for the variable name after "variable:" and find the range immediately after the variable name to apply the decoration to
          let range: Range | undefined;
          if (frame.name.startsWith('variable:') || frame.name.startsWith('tag:')) {
            const variableName = frame.name.split('variable:')[1] || frame.name.split('tag:')[1]; 
            const line = document.lineAt(frame.line - 1);
            const variableRange = line.text.indexOf(variableName);// 7
            
            if (variableRange !== -1) {
              // Create range that covers the variable name itself using explicit positions
              range = new Range(
                new Position(line.lineNumber, variableRange),
                new Position(line.lineNumber, variableRange + variableName.length)
              );
            } else {
              // Fallback to full line if variable name not found
              range = line.range;
            }
            console.log(`[Theme Preview] Variable Range: ${range} Frame: ${frame}`);
          } else {
            const line = document.lineAt(frame.line - 1);
            console.log(`[Theme Preview] Line: ${line.range} Frame: ${frame}`);
            range = line.range;
          }
          const decoration: DecorationOptions = {
            range: range!,
            renderOptions: { after: { contentText: ` ⏱️ ${(duration / 1000000).toFixed(2)}ms` } }
          };

          // Store the decoration in a map where the key is the file path and the value is an array of decorations
          const fileDecorations = ThemePreviewPanel.decorations.get(uri.fsPath) || [];
          fileDecorations.push(decoration);
          ThemePreviewPanel.decorations.set(uri.fsPath, fileDecorations);

        } catch (err) {
          console.error(`[Theme Preview] Error creating line decoration for ${frameId}:`, err);
        }
      }

      // Apply the decoration in the editor
      const visibleEditors = window.visibleTextEditors;
      for (const editor of visibleEditors) {
        // Get stored decorations for this file
        const lineDecorations = ThemePreviewPanel.decorations.get(editor.document.uri.fsPath) || [];
        editor.setDecorations(lineDecorationType, lineDecorations);
      }

      //Add listener for active editor changes
      this._context.subscriptions.push(
        window.onDidChangeActiveTextEditor(editor => {
          if (editor) {
            const decorations = ThemePreviewPanel.decorations.get(editor.document.uri.fsPath);
            if (decorations) {
              editor.setDecorations(lineDecorationType, decorations);
            } else {
              editor.setDecorations(lineDecorationType, []);
              editor.setDecorations(fileDecorationType, []);
            }
          }
        })
      );

    } catch (error) {
      console.error('[Theme Preview] Error processing profile results:', error);
    }
  }

  private getColorForDuration(duration: number): string {
    // Convert nanoseconds to milliseconds for easier comparison
    const ms = duration / 1000000;
    if (ms < 10) return '#4caf50';      // Fast: Green
    if (ms < 50) return '#ffc107';      // Medium: Yellow
    return '#f44336';                    // Slow: Red
  }
}

function getProfileContents(url: string) {
  try {
    console.log('[Theme Preview] Attempting to load preview for URL:', url);
    const result = execSync(`shopify theme profile --url=${url}`, { stdio: 'pipe' });
    // remove all characters leading up to the first {
    const content = result.toString().replace(/^[^{]+/, '');
    console.log(`[Theme Preview] Successfully retrieved preview content ${content}`);
    return content;
  } catch (error) {
    console.error('[Theme Preview] Error loading preview:', error);
    if (error instanceof Error) {
      // If there's stderr output, it will be in error.stderr
      const errorMessage = (error as any).stderr?.toString() || error.message;
      console.error('[Theme Preview] Error details:', errorMessage);
      return `<div style="color: red; padding: 20px;">
        <h3>Error loading preview:</h3>
        <pre>${errorMessage}</pre>
      </div>`;
    }
    console.error('[Theme Preview] Unexpected error type:', typeof error);
    return '<div style="color: red; padding: 20px;">An unexpected error occurred</div>';
  }
}

export async function activate(context: ExtensionContext) {
  const runChecksCommand = 'themeCheck/runChecks';

  context.subscriptions.push(
    commands.registerCommand('shopifyLiquid.restart', () => restartServer(context)),
  );
  context.subscriptions.push(
    commands.registerCommand('shopifyLiquid.runChecks', () => {
      client!.sendRequest('workspace/executeCommand', { command: runChecksCommand });
    }),
  );
  context.subscriptions.push(
    languages.registerDocumentFormattingEditProvider(
      [{ language: 'liquid' }],
      new LiquidFormatter(vscodePrettierFormat),
    ),
  );
  context.subscriptions.push(
    commands.registerCommand('shopifyLiquid.openPreview', async () => {
      const url = await window.showInputBox({
        prompt: 'Enter the URL to profile:',
        placeHolder: 'https://mystore.myshopify.com',
      });

      if (url) {
        await ThemePreviewPanel.createOrShow(context, url);
      }
    })
  );

  await startServer(context);
}

export function deactivate() {
  return stopServer();
}

async function startServer(context: ExtensionContext) {
  const serverOptions = await getServerOptions(context);
  console.info(
    'shopify.theme-check-vscode Server options %s',
    JSON.stringify(serverOptions, null, 2),
  );
  if (!serverOptions) {
    return;
  }

  const clientOptions: LanguageClientOptions = {
    documentSelector: documentSelectors as DocumentSelector,
  };

  client = new LanguageClient(
    'shopifyLiquid',
    'Theme Check Language Server',
    serverOptions,
    clientOptions,
  );

  client.onRequest('fs/readDirectory', async (uriString: string): Promise<FileTuple[]> => {
    const results = await workspace.fs.readDirectory(Uri.parse(uriString));
    return results.map(([name, type]) => [pathUtils.join(uriString, name), type]);
  });

  client.onRequest('fs/readFile', async (uriString: string): Promise<string> => {
    const bytes = await workspace.fs.readFile(Uri.parse(uriString));
    return Buffer.from(bytes).toString('utf8');
  });

  client.onRequest('fs/stat', async (uriString: string): Promise<FileStat> => {
    return workspace.fs.stat(Uri.parse(uriString));
  });

  client.start();
}

async function stopServer() {
  try {
    if (client) {
      await Promise.race([client.stop(), sleep(1000)]);
    }
  } catch (e) {
    console.error(e);
  } finally {
    client = undefined;
  }
}

async function restartServer(context: ExtensionContext) {
  if (client) {
    await stopServer();
  }
  await startServer(context);
}

async function getServerOptions(context: ExtensionContext): Promise<ServerOptions | undefined> {
  const serverModule = context.asAbsolutePath(path.join('dist', 'node', 'server.js'));
  return {
    run: {
      module: serverModule,
      transport: TransportKind.stdio,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: {
        // --inspect=6009: runs the server in Node's Inspector mode so VS Code can attach to the server for debugging
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };
}
