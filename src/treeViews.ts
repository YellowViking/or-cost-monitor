import * as vscode from 'vscode';
import { UsageStore, formatMoney, formatTokens } from './store';
import { toUsd } from './api';

export class UsageTreeProvider implements vscode.TreeDataProvider<UsageNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<UsageNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: UsageStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: UsageNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: UsageNode): Thenable<UsageNode[]> {
    const s = this.store.current;
    if (!element) {
      const today = s.daily.get(new Date().toISOString().slice(0, 10));
      const todayCost = today ? Array.from(today.values()).reduce((a, b) => a + b.cost, 0) : 0;
      const todayTokens = today ? Array.from(today.values()).reduce((a, b) => a + b.tokens, 0) : 0;
      return Promise.resolve([
        new UsageNode(
          'summary',
          `Session: ${toUsd(s.totalCost)}  ·  ${formatTokens(s.totalTokens)} tokens  ·  ${s.requestCount} requests`,
          s.totalCost,
          vscode.TreeItemCollapsibleState.None
        ),
        new UsageNode(
          'today',
          `Today: ${toUsd(todayCost)}  ·  ${formatTokens(todayTokens)} tokens`,
          todayCost,
          vscode.TreeItemCollapsibleState.None
        ),
        new UsageNode(
          'models',
          'By model',
          0,
          s.byModel.size > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        ),
      ]);
    }

    if (element.id === 'models') {
      return Promise.resolve(
        Array.from(s.byModel.entries())
          .sort((a, b) => b[1].cost - a[1].cost)
          .map(
            ([model, stats]) =>
              new UsageNode(
                `model:${model}`,
                `${model}`,
                stats.cost,
                vscode.TreeItemCollapsibleState.None,
                `Cost: ${formatMoney(stats.cost)}\nTokens: ${formatTokens(stats.tokens)}\nRequests: ${stats.requests}`
              )
          )
      );
    }
    return Promise.resolve([]);
  }
}

class UsageNode extends vscode.TreeItem {
  constructor(
    public readonly id: string,
    label: string,
    public readonly cost: number,
    collapsibleState: vscode.TreeItemCollapsibleState,
    tooltip?: string
  ) {
    super(label, collapsibleState);
    this.id = id;
    this.tooltip = tooltip;
    if (tooltip) {
      this.description = tooltip.split('\n')[0];
    }
  }
}

export class RecentRequestsProvider implements vscode.TreeDataProvider<RecentNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RecentNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly store: UsageStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: RecentNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RecentNode): Thenable<RecentNode[]> {
    if (element) return Promise.resolve([]);
    const rows = this.store.recentRows;
    if (rows.length === 0) {
      return Promise.resolve([
        new RecentNode(
          'empty',
          'No requests yet — run one through OpenRouter and it appears here',
          undefined,
          vscode.TreeItemCollapsibleState.None,
          ''
        ),
      ]);
    }
    return Promise.resolve(
      rows.map(
        (r) =>
          new RecentNode(
            r.id,
            `${r.model}  ·  ${toUsd(r.cost)}`,
            r,
            vscode.TreeItemCollapsibleState.None,
            `Tokens: ${formatTokens(r.tokens)}\nCost: ${formatMoney(r.cost)}\nProvider: ${r.provider ?? '—'}\n${new Date(
              r.timestamp
            ).toLocaleString()}`
          )
      )
    );
  }
}

class RecentNode extends vscode.TreeItem {
  constructor(
    public readonly id: string,
    label: string,
    public readonly row: NonNullable<unknown> | undefined,
    collapsibleState: vscode.TreeItemCollapsibleState,
    tooltip: string
  ) {
    super(label, collapsibleState);
    this.id = id;
    this.tooltip = tooltip;
    this.description = tooltip.split('\n')[0];
  }
}