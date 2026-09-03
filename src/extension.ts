import * as vscode from 'vscode';
import { UsageStore } from './store';
import { StatusBarMonitor, StatusMode } from './statusBar';
import { UsageTreeProvider, RecentRequestsProvider } from './treeViews';
import { DashboardPanel } from './dashboard';
import {
  getKeyInfo,
  OpenRouterApiError,
} from './api';
import { GenerationData } from './types';
import { readOpenRouterKeyFromVscodeSecrets } from './secretReader';
import { OpenRouterProxy } from './proxy';
import { OpenRouterChatProvider, MODELS as PROVIDER_MODELS } from './chatProvider';
import { log } from './logger';

const API_KEY_SECRET = 'orCost.apiKey';

interface OrCostState {
  store: UsageStore;
  statusBar: StatusBarMonitor;
  usageTree: UsageTreeProvider;
  recentTree: RecentRequestsProvider;
  pollTimer: NodeJS.Timeout | undefined;
  syncing: boolean;
  proxy: OpenRouterProxy | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // --- 1. Secure API key handling ------------------------------------------
  async function getApiKey(): Promise<string | undefined> {
    // 1) Prefer our own secret storage (set via "OpenRouter: Set API Key").
    const fromSecret = await context.secrets.get(API_KEY_SECRET);
    if (fromSecret) return fromSecret;
    // 2) Reuse the key the user already configured in VS Code's chat language
    //    models (chatLanguageModels.json → secret://chat.lm.secret.XXXX).
    const fromVscodeSecrets = await readOpenRouterKeyFromVscodeSecrets();
    if (fromVscodeSecrets) return fromVscodeSecrets;
    // 3) Fall back to the (rarely-used) machine setting.
    const fromSetting = vscode.workspace.getConfiguration('orCost').get<string>('apiKey');
    return fromSetting || undefined;
  }

  function hasApiKey(): Promise<boolean> {
    return getApiKey().then((k) => !!k);
  }

  async function promptForApiKey(): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
      prompt: 'OpenRouter API key (sk-or-v1-...)',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v?.startsWith('sk-or-v1-') || v?.startsWith('sk-or-') ? undefined : 'Looks off — keys usually start with sk-or-v1-'),
    });
    if (!value) return undefined;
    await context.secrets.store(API_KEY_SECRET, value);
    await vscode.window.showInformationMessage('OpenRouter API key saved (secret storage).');
    state.statusBar.setLoading(false);
    await refreshNow();
    return value;
  }

  async function clearApiKey(): Promise<void> {
    await context.secrets.delete(API_KEY_SECRET);
    await vscode.window.showInformationMessage('OpenRouter API key cleared.');
  }

  // --- 2. Store + UI -------------------------------------------------------
  const store = new UsageStore(context.workspaceState);
  const statusBar = new StatusBarMonitor(store);
  const usageTree = new UsageTreeProvider(store);
  const recentTree = new RecentRequestsProvider(store);

  const state: OrCostState = {
    store,
    statusBar,
    usageTree,
    recentTree,
    pollTimer: undefined,
    syncing: false,
    proxy: undefined,
  };

  statusBar.update();
  await vscode.commands.executeCommand('setContext', 'orCost.hasKey', await hasApiKey());

  // --- 3. Polling ----------------------------------------------------------
  /** Verify the API key by hitting GET /key (works with a regular key). */
  async function testKey(apiKey: string): Promise<boolean> {
    try {
      await getKeyInfo(apiKey);
      return true;
    } catch {
      return false;
    }
  }

  async function refreshNow(): Promise<void> {
    const key = await getApiKey();
    if (!key) {
      statusBar.setLoading(false);
      statusBar.update();
      return;
    }
    if (state.syncing) return;
    state.syncing = true;
    statusBar.setLoading(true);

    try {
      // The proxy captures per-prompt usage in real time; this poll just
      // verifies the key is valid (GET /key) and refreshes the UI. It does NOT
      // call the generation-list endpoint (no such public list exists — it
      // returns 400 with a required `id`).
      const authOk = await testKey(key);
      if (!authOk) {
        store.setError('API key rejected by OpenRouter');
        vscode.window.showWarningMessage('OpenRouter monitor: API key rejected. Run "OpenRouter: Set API Key".');
      } else {
        store.clearError();
      }
      usageTree.refresh();
      recentTree.refresh();
      DashboardPanel.current()?.refresh();
    } catch (e) {
      const message =
        e instanceof OpenRouterApiError
          ? `${e.status} ${e.message}${e.detail ? ` — ${e.detail}` : ''}`
          : e instanceof Error
            ? e.message
            : String(e);
      store.setError(message);
      vscode.window.showWarningMessage(`OpenRouter monitor: ${message}`);
    } finally {
      state.syncing = false;
      statusBar.setLoading(false);
      statusBar.update();
    }
  }

  function schedulePoll(seconds: number): void {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(() => { void refreshNow(); }, Math.max(5, seconds) * 1000);
  }

  // --- 3b. Proxy + Chat Provider (usage capture) ---------------------------
  async function startProxyAndProvider(apiKey: string): Promise<void> {
    if (state.proxy) return;
    const proxy = new OpenRouterProxy({
      apiKey,
      onGeneration: (g) => {
        // Convert captured completion into the store's GenerationData shape.
        const data: GenerationData = {
          id: g.id || `captured-${Date.now()}`,
          model: g.model || '(unknown)',
          ended_at: new Date((g.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
          usage: {
            total_tokens: g.usage?.total_tokens ?? 0,
            prompt_tokens: g.usage?.prompt_tokens ?? 0,
            completion_tokens: g.usage?.completion_tokens ?? 0,
            reasoning_tokens: g.usage?.reasoning_tokens,
            cost: g.usage?.cost,
          },
        };
        store.merge([data]);
        usageTree.refresh();
        recentTree.refresh();
        DashboardPanel.current()?.refresh();
        statusBar.update();
      },
      onError: (e) => {
        store.setError(`proxy: ${e.message}`);
        statusBar.update();
      },
    });
    const port = await proxy.start(0);
    state.proxy = proxy;

    // Register the chat provider only if the proposed API is available.
    const lmAny = vscode.lm as unknown as {
      registerLanguageModelChatProvider?: (vendor: string, provider: unknown) => vscode.Disposable;
    };
    if (typeof lmAny.registerLanguageModelChatProvider === 'function') {
      const provider = new OpenRouterChatProvider({ proxyBaseUrl: `http://127.0.0.1:${port}/api/v1`, apiKey });
      context.subscriptions.push(
        lmAny.registerLanguageModelChatProvider('or-cost-openrouter', provider)
      );
      void vscode.window.showInformationMessage(
        `OpenRouter Cost Monitor: proxy on :${port}, "${PROVIDER_MODELS.map((m) => m.id).join(', ')}" available as chat model.`
      );
      store.clearError();
      statusBar.update();
    } else {
      void vscode.window.showWarningMessage(
        'OpenRouter Cost Monitor: the proposed LanguageModelChatProvider API is not available in this build, so no chat provider is registered. Proxy is running for direct API usage tracking only.'
      );
    }
  }

  // --- 4. Commands ---------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('or-cost.openDashboard', () => {
      DashboardPanel.show(store);
    }),
    vscode.commands.registerCommand('or-cost.refresh', async () => {
      await refreshNow();
    }),
    vscode.commands.registerCommand('or-cost.pickApiKey', async () => {
      await promptForApiKey();
      await vscode.commands.executeCommand('setContext', 'orCost.hasKey', await hasApiKey());
    }),
    vscode.commands.registerCommand('or-cost.clearApiKey', async () => {
      await clearApiKey();
      await vscode.commands.executeCommand('setContext', 'orCost.hasKey', await hasApiKey());
    }),
    vscode.commands.registerCommand('or-cost.resetSession', async () => {
      store.resetSession();
      usageTree.refresh();
      recentTree.refresh();
      DashboardPanel.current()?.refresh();
      statusBar.update();
      await vscode.window.showInformationMessage('Session tracking reset.');
    }),
    vscode.commands.registerCommand('or-cost.togglePolling', async () => {
      const cfg = vscode.workspace.getConfiguration('orCost');
      const interval = cfg.get<number>('pollIntervalSeconds', 30);
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = undefined;
        await vscode.window.showInformationMessage('Auto-refresh paused.');
      } else {
        schedulePoll(interval);
        await vscode.window.showInformationMessage('Auto-refresh resumed.');
      }
    })
  );

  // --- 5. Settings change handling -----------------------------------------
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('orCost.pollIntervalSeconds')) {
        const seconds = vscode.workspace.getConfiguration('orCost').get<number>('pollIntervalSeconds', 30);
        if (state.pollTimer) schedulePoll(seconds);
      }
      if (e.affectsConfiguration('orCost.statusBarMode')) {
        statusBar.setMode(vscode.workspace.getConfiguration('orCost').get<StatusMode>('statusBarMode', 'cost'));
        statusBar.update();
      }
    })
  );

  // --- 6. Views ------------------------------------------------------------
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('orCost.usage', usageTree),
    vscode.window.registerTreeDataProvider('orCost.recent', recentTree)
  );

  // --- Kick off tracing -----------------------------------------------------
  log.info('OpenRouter Cost Monitor activating');
  context.subscriptions.push(
    vscode.commands.registerCommand('or-cost.dumpLog', () => {
      log.dumpToFile(context.logUri.fsPath);
      void vscode.window.showInformationMessage(`Log written to ${context.logUri.fsPath}`);
    })
  );

  // --- 7. Kick off ---------------------------------------------------------
  const hasKey = await hasApiKey();
  if (!hasKey) {
    const choice = await vscode.window.showInformationMessage(
      'OpenRouter Cost Monitor: set your API key to start tracking usage.',
      'Set API Key',
      'Later'
    );
    if (choice === 'Set API Key') {
      await promptForApiKey();
    } else {
      statusBar.setLoading(false);
      statusBar.update();
    }
  } else {
    const key = await getApiKey();
    if (key) {
      // Start the proxy + chat provider so every chat prompt is captured.
      try {
        await startProxyAndProvider(key);
      } catch (e) {
        store.setError('proxy start failed: ' + (e instanceof Error ? e.message : e));
      }
    }
    schedulePoll(vscode.workspace.getConfiguration('orCost').get<number>('pollIntervalSeconds', 30));
    void refreshNow();
  }
}

export async function deactivate(): Promise<void> {
  // The proxy server is disposed via context.subscriptions; nothing else to do.
}