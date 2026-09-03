import * as vscode from 'vscode';
import { UsageStore } from './store';
import { toUsd, toTokens } from './api';

export type StatusMode = 'cost' | 'tokens' | 'requests' | 'session';

export class StatusBarMonitor {
  private readonly item: vscode.StatusBarItem;
  private mode: StatusMode;
  private loading = false;

  constructor(private readonly store: UsageStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'or-cost.openDashboard';
    this.item.name = 'OpenRouter Cost';
    this.item.tooltip = 'OpenRouter usage — click to open dashboard';
    this.mode = (vscode.workspace
      .getConfiguration('orCost')
      .get<StatusMode>('statusBarMode') ?? 'cost') as StatusMode;
  }

  setMode(mode: StatusMode): void {
    this.mode = mode;
    this.update();
  }

  setLoading(loading: boolean): void {
    this.loading = loading;
    this.update();
  }

  dispose(): void {
    this.item.dispose();
  }

  private isToday(): boolean {
    const now = new Date();
    const key = now.toISOString().slice(0, 10);
    return this.store.current.daily.has(key);
  }

  update(): void {
    const s = this.store.current;
    const today = s.daily.get(new Date().toISOString().slice(0, 10));
    const todayCost = today ? Array.from(today.values()).reduce((a, b) => a + b.cost, 0) : 0;
    const todayTokens = today ? Array.from(today.values()).reduce((a, b) => a + b.tokens, 0) : 0;
    const todayRequests = today ? Array.from(today.values()).reduce((a, b) => a + b.requests, 0) : 0;

    let text = '';
    switch (this.mode) {
      case 'cost':
        text = `$(server) OpenRouter: ${toUsd(this.isToday() ? todayCost : 0)}`;
        break;
      case 'tokens':
        text = `$(symbol-namespace) OR tokens: ${toTokens(todayTokens)}`;
        break;
      case 'requests':
        text = `$(link) OR reqs: ${todayRequests}`;
        break;
      case 'session':
        text = `$(server) OR session: ${toUsd(this.store.sessionCost())}`;
        break;
    }

    if (this.loading) {
      text = `$(sync~spin) ${text}`;
      this.item.tooltip = 'Refreshing usage…';
    } else if (this.store.error) {
      this.item.tooltip = `OpenRouter error: ${this.store.error}`;
    } else {
      this.item.tooltip = `OpenRouter usage (${
        this.mode === 'session' ? 'session' : 'today'
      })\nClick to open dashboard\nCost today: ${toUsd(todayCost)}\nTokens today: ${toTokens(
        todayTokens
      )}\nRequests today: ${todayRequests}\nSession total: ${toUsd(this.store.sessionCost())}`;
    }

    this.item.text = text;
    this.item.show();
  }
}