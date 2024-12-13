import { FileStat, FileTuple, path as pathUtils } from '@shopify/theme-check-common';
import * as path from 'node:path';
import { commands, Disposable, DecorationOptions,ExtensionContext, languages, Uri, workspace, WebviewPanel, ViewColumn, window } from 'vscode';
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
const THEME_ACCESS_PASSWORD = 'shptka_4881ef372849f7a07617f7498a15bce4';

const decorationType = window.createTextEditorDecorationType({
  after: {
    margin: '0 0 0 1rem',
    textDecoration: 'none',
  },
  rangeBehavior: 1 // DecorationRangeBehavior.ClosedOpen
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
    this._panel.webview.html = this._getInitialHtml();
    this._context = context;

    this._panel.webview.onDidReceiveMessage(
      message => {
        switch (message.command) {
          case 'loadUrl':
            this._panel.webview.html = this.getPageContentsFromURL(message.url);
            this.processProfileResults();
            return;
        }
      }
    );
  }

  private getPageContentsFromURL(url: string) {
    try {
      console.log('[Theme Preview] Attempting to load preview for URL:', url);
      const result = execSync(`shopify theme info --password=${THEME_ACCESS_PASSWORD} --store=${url}`, { stdio: 'pipe' });
      console.log('[Theme Preview] Successfully retrieved preview content');
      return result.toString();
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

  public static createOrShow(context: ExtensionContext) {
    const column = ViewColumn.Beside;

    if (ThemePreviewPanel.currentPanel) {
      ThemePreviewPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = window.createWebviewPanel(
      'themePreview',
      'Theme Preview',
      column,
      {
        enableScripts: true
      }
    );

    ThemePreviewPanel.currentPanel = new ThemePreviewPanel(panel, context);
  }
  
  public get panel() {
    return this._panel;
  }

  private _getInitialHtml() {
    return `
      <!DOCTYPE html>
      <html>
        <body>
          <div style="padding: 20px;">
            <input type="text" id="urlInput" placeholder="Enter preview URL in format: https://example.myshopify.com" style="width: 80%; padding: 5px;">
            <button id="loadButton">Load Preview</button>
          </div>
          <div id="previewContainer"></div>
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('loadButton').addEventListener('click', () => {
              const url = document.getElementById('urlInput').value;
              vscode.postMessage({ command: 'loadUrl', url });
            });
          </script>
        </body>
      </html>
    `;
  }

  private _getWebviewContent(url: string) {
    return `
      <!DOCTYPE html>
      <html>
        <p>Displaying preview for ${url}</p>
        <body style="margin: 0; padding: 0; height: 100vh;">
          <iframe src="${url}" style="width: 100%; height: 100%; border: none;"></iframe>
        </body>
      </html>
    `;
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

  private async processProfileResults() {
    console.log('[Theme Preview] Processing profile results for decorations');
    try {
      // Clear existing decorations
      ThemePreviewPanel.decorations.clear();
      const activeEditor = window.activeTextEditor;
      if (activeEditor) {
        activeEditor.setDecorations(decorationType, []);
      }

      const profilePath = Uri.file(this._context.asAbsolutePath(`resources/mcliquid-profile.json`));
      const profileData = await workspace.fs.readFile(profilePath);
      
      // Parse using speedscope's file format parser
      const parsedProfile = JSON.parse(profileData.toString());
      console.log('[Theme Preview] Parsed profile structure:', parsedProfile);

      const profile = parsedProfile.profiles[0];
      const frames = parsedProfile.shared.frames;
      
      // Map to store file paths and their execution times
      const fileExecutionTimes = new Map<string, number>();
      const openEvents = new Map<number, number>(); // frameId -> startTime

      // Process events to calculate execution times
      profile.events.forEach(event => {
        const frameId = event.frame; // index of the frame
        const frame = frames[frameId];
        
        if (event.type === 'O') { // Open event
          openEvents.set(frameId, event.at);
        } else if (event.type === 'C') { // Close event
          const startTime = openEvents.get(frameId);
          if (startTime !== undefined) {
            const duration = event.at - startTime; // in nanoseconds
            
            // Only process liquid files
            if (frame.file && (frame.file.startsWith('sections/') || frame.file.startsWith('snippets/'))) {
              const liquidFile = `${frame.file}.liquid`;
              const current = fileExecutionTimes.get(liquidFile) || 0;
              fileExecutionTimes.set(liquidFile, current + duration);
            }
            
            openEvents.delete(frameId);
          }
        }
      });

      console.log('[Theme Preview] Calculated execution times:', 
        Object.fromEntries([...fileExecutionTimes.entries()].map(
          ([file, time]) => [file, `${(time / 1000000).toFixed(2)}ms`]
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
                contentText: `⏱️ ${(duration / 1000000).toFixed(2)}ms`,
                color: this.getColorForDuration(duration),
              }
            }
          };

          // Store decoration for this file
          ThemePreviewPanel.decorations.set(uri.fsPath, [decoration]);
          
          // Apply decoration if this is the active editor
          const editor = window.activeTextEditor;
          if (editor && editor.document.uri.fsPath === uri.fsPath) {
            editor.setDecorations(decorationType, [decoration]);
          }

          console.log(`[Theme Preview] Created decoration for ${liquidFile} (${(duration / 1000000).toFixed(2)}ms)`);
        } catch (err) {
          console.error(`[Theme Preview] Error creating decoration for ${fullPath}:`, err);
        }
      }

      // Add listener for active editor changes
      this._context.subscriptions.push(
        window.onDidChangeActiveTextEditor(editor => {
          if (editor) {
            const decorations = ThemePreviewPanel.decorations.get(editor.document.uri.fsPath);
            if (decorations) {
              editor.setDecorations(decorationType, decorations);
            } else {
              editor.setDecorations(decorationType, []);
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
    commands.registerCommand('shopifyLiquid.openPreview', () => {
      ThemePreviewPanel.createOrShow(context);
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
