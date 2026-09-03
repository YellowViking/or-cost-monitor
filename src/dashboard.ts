import * as vscode from 'vscode';
import { UsageStore } from './store';
import { toUsd, toTokens } from './api';

export class DashboardPanel {
  public static readonly viewType = 'orCost.dashboard';
  private static instance: DashboardPanel | undefined;

  public static show(store: UsageStore): DashboardPanel {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return DashboardPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'OpenRouter Dashboard',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    DashboardPanel.instance = new DashboardPanel(panel, store);
    return DashboardPanel.instance;
  }

  public static current(): DashboardPanel | undefined {
    return DashboardPanel.instance;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly store: UsageStore;
  private disposed = false;

  private constructor(panel: vscode.WebviewPanel, store: UsageStore) {
    this.panel = panel;
    this.store = store;
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => {
      this.disposed = true;
      DashboardPanel.instance = undefined;
    });
  }

  /** Re-render whenever the store changes externally. */
  refresh(): void {
    if (this.disposed) return;
    this.panel.title = 'OpenRouter Dashboard';
    this.panel.webview.html = this.render();
    this.panel.webview.postMessage({ type: 'refresh' });
    void this.panel.webview.html; // keep messages in sync; html already updated
  }

  private render(): string {
    const s = this.store.current;
    const todayKey = new Date().toISOString().slice(0, 10);
    const today = s.daily.get(todayKey);
    const todayCost = today ? Array.from(today.values()).reduce((a, b) => a + b.cost, 0) : 0;
    const todayTokens = today ? Array.from(today.values()).reduce((a, b) => a + b.tokens, 0) : 0;
    const todayRequests = today ? Array.from(today.values()).reduce((a, b) => a + b.requests, 0) : 0;

    const modelRows = Array.from(s.byModel.entries())
      .sort((a, b) => b[1].cost - a[1].cost)
      .slice(0, 20)
      .map(
        ([model, st]) => `<tr>
          <td>${escapeHtml(model)}</td>
          <td>${toUsd(st.cost)}</td>
          <td>${toTokens(st.tokens)}</td>
          <td>${st.requests}</td>
        </tr>`
      )
      .join('');

    const recentRows = this.store.recentRows
      .slice(0, 15)
      .map(
        (r) => `<tr>
          <td>${escapeHtml(r.model)}</td>
          <td>${toUsd(r.cost)}</td>
          <td>${toTokens(r.tokens)}</td>
          <td>${new Date(r.timestamp).toLocaleString()}</td>
        </tr>`
      )
      .join('');

    const lastFetched = this.store.lastFetched
      ? new Date(this.store.lastFetched).toLocaleTimeString()
      : '—';
    const error = this.store.error
      ? `<div class="error">⚠ ${escapeHtml(this.store.error)}</div>`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); padding: 1rem 1.2rem; color: var(--vscode-foreground); }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  .sub { opacity: .75; margin-bottom: 1rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .8rem; margin-bottom: 1.25rem; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: .7rem .9rem; background: var(--vscode-editor-background); }
  .card .k { font-size: .75rem; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
  .card .v { font-size: 1.15rem; font-weight: 600; margin-top: .2rem; }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; margin-bottom: 1.5rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--vscode-panel-border); }
  th { opacity: .75; }
  .error { color: var(--vscode-errorForeground); margin-bottom: 1rem; }
  .foot { opacity: .6; font-size: .75rem; }
  @media (prefers-color-scheme: dark) { .card { background: #1e1e1e; } }
</style>
</head>
<body>
  <h1>OpenRouter Usage</h1>
  <div class="sub">Auto-refresh · last fetched ${lastFetched} · <span id="live"></span></div>
  ${error}

  <div class="cards">
    <div class="card"><div class="k">Today spend</div><div class="v">${toUsd(todayCost)}</div></div>
    <div class="card"><div class="k">Session spend</div><div class="v">${toUsd(s.totalCost)}</div></div>
    <div class="card"><div class="k">Today tokens</div><div class="v">${toTokens(todayTokens)}</div></div>
    <div class="card"><div class="k">Requests today</div><div class="v">${todayRequests}</div></div>
  </div>

  <h2>By model (session)</h2>
  <table>
    <tr><th>Model</th><th>Cost</th><th>Tokens</th><th>Requests</th></tr>
    ${modelRows || '<tr><td colspan="4">No usage yet.</td></tr>'}
  </table>

  <h2>Recent requests</h2>
  <table>
    <tr><th>Model</th><th>Cost</th><th>Tokens</th><th>When</th></tr>
    ${recentRows || '<tr><td colspan="4">No requests yet.</td></tr>'}
  </table>

  <div class="foot">Costs reflect provider pricing + caching discounts as billed by OpenRouter. Poll interval: ${vscode.workspace
    .getConfiguration('orCost')
    .get('pollIntervalSeconds', 30)}s.</div>
  <script>
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}