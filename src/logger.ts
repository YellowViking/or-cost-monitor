import * as vscode from 'vscode';

/**
 * Minimal logger for the extension, backed by an Output Channel so everything
 * is visible in the OUTPUT panel ("OpenRouter Cost Monitor") and in the
 * extension host logs.
 */
class ExtensionLogger {
  private channel: vscode.OutputChannel | undefined;
  private maxFileLines = 2000;
  private fileLines: string[] = [];

  private ensureChannel(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel('OpenRouter Cost Monitor');
    }
    return this.channel;
  }

  private append(line: string, level: 'info' | 'warn' | 'error') {
    const ts = new Date().toISOString();
    const full = `[${ts}] [${level}] ${line}`;
    // Always to console (lands in the extension host log).
    if (level === 'error') console.error(full);
    else if (level === 'warn') console.warn(full);
    else console.log(full);
    // And to the Output Channel.
    try {
      this.ensureChannel().appendLine(full);
    } catch {
      /* channel may not exist during shutdown */
    }
    // Cap in-memory ring (also written to the extension dir when requested).
    this.fileLines.push(full);
    if (this.fileLines.length > this.maxFileLines) this.fileLines.shift();
  }

  info(line: string) { this.append(line, 'info'); }
  warn(line: string) { this.append(line, 'warn'); }
  error(line: string) { this.append(line, 'error'); }

  /** Dump the in-memory ring to a file for easy grepping. */
  dumpToFile(dir: string): void {
    try {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'cost-monitor.log');
      fs.writeFileSync(f, this.fileLines.join('\n') + '\n', 'utf8');
      this.info(`wrote ${this.fileLines.length} log lines to ${f}`);
    } catch (e) {
      this.warn(`could not dump log file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export const log = new ExtensionLogger();