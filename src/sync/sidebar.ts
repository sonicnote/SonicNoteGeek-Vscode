import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface SyncSettingsAccessor {
  getSyncFolder(): string;
  isAuthenticated(): boolean;
}

export class SyncSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _settingsAccessor: SyncSettingsAccessor;

  constructor(settingsAccessor: SyncSettingsAccessor) {
    this._settingsAccessor = settingsAccessor;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.buildHtml();
    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
  }

  refresh() {
    if (this._view) {
      this._view.webview.html = this.buildHtml();
    }
  }

  private handleMessage(msg: any) {
    switch (msg.command) {
      case 'openSettings':
        vscode.commands.executeCommand('sonicnote-geek.openSyncSettings');
        break;
      case 'sync':
        vscode.commands.executeCommand('sonicnote-geek.sync');
        break;
      case 'openPanel':
        vscode.commands.executeCommand('sonicnote-geek.openTranscribePanel');
        break;
      case 'login':
        vscode.commands.executeCommand('sonicnote-geek.login');
        break;
      case 'logout':
        vscode.commands.executeCommand('sonicnote-geek.logout');
        break;
      case 'openFile': {
        const uri = vscode.Uri.file(msg.path);
        vscode.commands.executeCommand('vscode.open', uri);
        break;
      }
      case 'revealInFinder': {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        break;
      }
      case 'copyPath': {
        try {
          const content = fs.readFileSync(msg.path, 'utf-8');
          vscode.env.clipboard.writeText(content);
          vscode.window.showInformationMessage('已复制到剪贴板');
        } catch (e) {
          vscode.window.showErrorMessage(`复制失败: ${e instanceof Error ? e.message : ''}`);
        }
        break;
      }
      case 'deleteFile': {
        const fname = path.basename(msg.path);
        vscode.window.showWarningMessage(
          `确定删除 "${fname}"？`, { modal: true }, '删除'
        ).then(confirm => {
          if (confirm !== '删除') return;
          try {
            fs.unlinkSync(msg.path);
            this.refresh();
            vscode.window.showInformationMessage(`已删除: ${fname}`);
          } catch (e) {
            vscode.window.showErrorMessage(`删除失败: ${e instanceof Error ? e.message : ''}`);
          }
        });
        break;
      }
    }
  }

  private getFileList(): Array<{ name: string; path: string; mtime: number }> {
    const dir = this._settingsAccessor.getSyncFolder();
    if (!dir || !fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.md'))
        .map(f => {
          const fp = path.join(dir, f);
          const stat = fs.statSync(fp);
          return { name: f, path: fp, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {
      return [];
    }
  }

  private buildHtml(): string {
    const dir = this._settingsAccessor.getSyncFolder();
    const files = this.getFileList();
    const authed = this._settingsAccessor.isAuthenticated();

    let fileRows = '';
    if (!dir) {
      fileRows = `<div class="hint-row" onclick="post('openSettings')">⚙️ 请在设置中配置同步文件夹</div>`;
    } else if (!fs.existsSync(dir)) {
      fileRows = `<div class="hint-row">⚠️ 目录不存在: ${this.escAttr(dir)}</div>`;
    } else if (files.length === 0) {
      fileRows = `<div class="hint-row">📭 暂无 .md 文件</div>`;
    } else {
      fileRows = files.map(f => {
        const name = this.escAttr(f.name);
        const fpath = this.escAttr(f.path);
        return `<div class="file-row" data-path="${fpath}"
          onclick="post('openFile', '${fpath}')"
          oncontextmenu="showCtx(event, '${fpath}', '${name}')">
          <span class="file-icon">📄</span><span class="file-name">${name}</span>
        </div>`;
      }).join('');
    }

    const loginLabel = authed ? '✅ 已登录' : '⚠️ 未登录';
    const loginAction = authed ? 'logout' : 'login';
    const loginBtnLabel = authed ? '登出' : '🔑 登录';

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:8px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px;user-select:none}
.btn-row{display:flex;gap:8px;margin-bottom:10px}
.sidebar-btn{flex:1;padding:6px 0;border:1px solid var(--vscode-button-border,var(--vscode-button-background));border-radius:4px;background:var(--vscode-button-secondaryBackground,var(--vscode-button-background));color:var(--vscode-button-secondaryForeground,var(--vscode-button-foreground));cursor:pointer;font-size:12px;font-family:inherit;text-align:center;white-space:nowrap}
.sidebar-btn:hover{background:var(--vscode-button-secondaryHoverBackground,var(--vscode-button-hoverBackground))}
.sidebar-btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-weight:500}
.sidebar-btn.primary:hover{background:var(--vscode-button-hoverBackground)}
.status-row{display:flex;align-items:center;justify-content:space-between;padding:6px 4px;margin-bottom:2px;font-size:12px;border-radius:4px}
.status-row.logged-in{background:var(--vscode-inputValidation-infoBackground,transparent)}
.status-row.logged-out{background:var(--vscode-inputValidation-warningBackground,transparent)}
.status-label{display:flex;align-items:center;gap:4px}
.status-action{background:transparent;border:1px solid var(--vscode-button-border,var(--vscode-input-border));border-radius:3px;color:var(--vscode-foreground);cursor:pointer;padding:2px 8px;font-size:11px;font-family:inherit}
.status-action:hover{background:var(--vscode-toolbar-hoverBackground)}
.divider{border:none;border-top:1px solid var(--vscode-sideBarSectionHeader-border);margin:8px 0}
.section-title{font-size:13px;font-weight:600;color:var(--vscode-sideBarTitle-foreground);padding:4px 4px 6px}
.file-list{display:flex;flex-direction:column;gap:1px}
.file-row{display:flex;align-items:center;gap:6px;padding:4px;border-radius:3px;cursor:pointer}
.file-row:hover{background:var(--vscode-list-hoverBackground)}
.file-icon{font-size:13px;flex-shrink:0}
.file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.hint-row{padding:6px 4px;font-size:12px;color:var(--vscode-descriptionForeground);cursor:pointer}
.hint-row:hover{color:var(--vscode-foreground)}
.ctx-menu{display:none;position:fixed;z-index:1000;min-width:160px;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border);border-radius:4px;padding:4px 0;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.ctx-menu.show{display:block}
.ctx-item{display:flex;align-items:center;gap:8px;padding:4px 12px;cursor:pointer;font-size:12px;color:var(--vscode-menu-foreground)}
.ctx-item:hover{background:var(--vscode-menu-selectionBackground);color:var(--vscode-menu-selectionForeground)}
.ctx-sep{border:none;border-top:1px solid var(--vscode-menu-separatorBackground);margin:4px 0}
</style></head><body>
<div class="status-row ${authed ? 'logged-in' : 'logged-out'}">
  <span class="status-label">${loginLabel}</span>
  <button class="status-action" onclick="post('${loginAction}')">${loginBtnLabel}</button>
</div>
<hr class="divider">
<div class="btn-row">
  <button class="sidebar-btn primary" onclick="post('openSettings')">⚙️ 插件设置</button>
  <button class="sidebar-btn primary" onclick="post('sync')">🔄 文件同步</button>
  <button class="sidebar-btn primary" onclick="post('openPanel')">📄 激活页面</button>
</div>
<hr class="divider">
<div class="section-title">📁 文件目录</div>
<div class="file-list">${fileRows}</div>
<div id="ctxMenu" class="ctx-menu">
  <div class="ctx-item" onclick="ctxAction('open')"><span>📄</span> 打开文件</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" onclick="ctxAction('reveal')"><span>📂</span> 在访达中显示</div>
  <div class="ctx-item" onclick="ctxAction('copy')"><span>📋</span> 复制</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" onclick="ctxAction('delete')"><span>🗑️</span> 删除文件</div>
</div>
<script>
const V=acquireVsCodeApi();
let ctxPath='',ctxName='';
function post(cmd,path){V.postMessage({command:cmd,path:path||''})}
function showCtx(e,path,name){e.preventDefault();ctxPath=path;ctxName=name;var m=document.getElementById('ctxMenu');m.classList.add('show');m.style.removeProperty('bottom');m.style.removeProperty('top');m.style.left=e.clientX+'px';var h=m.offsetHeight,w=window.innerHeight;if(e.clientY+h>w-8){m.style.bottom=(w-e.clientY)+'px';m.style.top='auto'}else{m.style.top=e.clientY+'px';m.style.bottom='auto'}}
function ctxAction(action){
  document.getElementById('ctxMenu').classList.remove('show');
  switch(action){
    case 'open': post('openFile',ctxPath);break;
    case 'reveal': post('revealInFinder',ctxPath);break;
    case 'copy': post('copyPath',ctxPath);break;
    case 'delete': post('deleteFile',ctxPath);break;
  }
}
document.addEventListener('click',function(){document.getElementById('ctxMenu').classList.remove('show')});
</script></body></html>`;
  }

  private escAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
