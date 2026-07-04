import * as vscode from 'vscode';
import { SonicNoteSettings, DEFAULT_SETTINGS, BUILTIN_FRONTMATTER_FIELDS } from './types';
import { SonicNoteApiClient } from './api';

export class SyncSettingsPanel {
  public static currentPanel: SyncSettingsPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private getSettings: () => SonicNoteSettings,
    private setState: (key: string, value: any) => Promise<void>,
    private onChanged: () => void,
    private apiClient: SonicNoteApiClient,
  ) {
    this._panel = panel;
    this._panel.webview.html = buildSettingsHtml();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg.command) {
        case 'getSettings': {
          const s = getSettings();
          this._panel.webview.postMessage({
            command: 'settingsData', data: s, isAuthed: apiClient.isAuthenticated(),
          });
          break;
        }
        case 'setSetting': {
          await this.saveSetting(msg.key, msg.value);
          break;
        }
        case 'login': {
          try {
            const r = await apiClient.login(msg.apiKey);
            await setState('sonicnote.token', r.token);
            await setState('sonicnote.apiKey', msg.apiKey);
            this._panel.webview.postMessage({ command: 'loginResult', success: true });
            onChanged();
          } catch (e) {
            this._panel.webview.postMessage({
              command: 'loginResult', success: false,
              error: e instanceof Error ? e.message : '登录失败'
            });
          }
          break;
        }
        case 'logout': {
          await setState('sonicnote.token', '');
          await setState('sonicnote.apiKey', '');
          this._panel.webview.postMessage({ command: 'logoutDone' });
          onChanged();
          break;
        }
        case 'selectFolder': {
          const folders = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectMany: false,
            openLabel: '选择同步文件夹',
            title: '选择录音 Markdown 文件存放目录',
          });
          if (folders && folders.length > 0) {
            const dir = folders[0].fsPath;
            await this.saveSetting('syncFolder', dir);
            this._panel.webview.postMessage({ command: 'folderSelected', path: dir });
          }
          break;
        }
      }
    }, null, this._disposables);
  }

  public static createOrShow(
    getSettings: () => SonicNoteSettings,
    setState: (key: string, value: any) => Promise<void>,
    onChanged: () => void,
    apiClient: SonicNoteApiClient,
  ) {
    if (SyncSettingsPanel.currentPanel) {
      SyncSettingsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
      SyncSettingsPanel.currentPanel._panel.webview.postMessage({ command: 'refresh' });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'sonicnote-geek-sync-settings', '妙记同步 - SonicNote Sync 设置',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    SyncSettingsPanel.currentPanel = new SyncSettingsPanel(panel, getSettings, setState, onChanged, apiClient);
  }

  public dispose() {
    SyncSettingsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private async saveSetting(key: string, value: any) {
    if (['frontmatterFields', 'customFrontmatter'].includes(key)) {
      await this.setState(`sonicnote.${key}`, value);
    } else {
      const config = vscode.workspace.getConfiguration('sonicnoteGeek.sync');
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    }
    this.onChanged();
  }
}

function buildSettingsHtml(): string {
  const builtinFields = JSON.stringify(BUILTIN_FRONTMATTER_FIELDS);
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{padding:20px;color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:13px}
h2{font-size:18px;margin-bottom:20px;padding-bottom:8px;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border)}
h3{font-size:14px;margin:20px 0 10px}
.section{margin-bottom:20px}
.setting-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--vscode-sideBarSectionHeader-border)}
.setting-label{flex:1}
.setting-label .name{font-weight:500}
.setting-label .desc{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px}
.setting-label .key{font-family:monospace;font-size:10px;color:var(--vscode-textPreformat-foreground)}
input[type="text"],input[type="password"],select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:4px 8px;font-family:var(--vscode-font-family);font-size:13px;width:200px}
select{width:auto}
input[type="checkbox"]{width:16px;height:16px;accent-color:var(--vscode-focusBorder)}
.btn{padding:6px 14px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-family:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
.btn:hover{background:var(--vscode-button-hoverBackground)}
.btn.small{padding:3px 8px;font-size:11px}
.btn.danger{background:#c62828;color:#fff}
.btn.danger:hover{background:#e53935}
.status-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.status-badge.ok{background:#2e7d32;color:#fff}
.status-badge.warn{background:#e65100;color:#fff}
.custom-row{display:flex;gap:8px;margin-bottom:6px;align-items:center}
.custom-row input{flex:1}
.toast{position:fixed;top:12px;right:12px;padding:10px 16px;border-radius:4px;font-size:13px;z-index:999;opacity:0;transition:opacity .3s}
.toast.show{opacity:1}
.toast.success{background:#2e7d32;color:#fff}
.toast.error{background:#c62828;color:#fff}
.required-tag{font-size:10px;color:var(--vscode-descriptionForeground);background:var(--vscode-textCodeBlock-background);padding:1px 6px;border-radius:3px}
.folder-right{display:flex;align-items:center;gap:8px;flex-shrink:0;max-width:60%}
.folder-path{font-family:monospace;font-size:11px;color:var(--vscode-textPreformat-foreground);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:300px;direction:rtl;text-align:left}
.folder-path:empty::after{content:'未选择';color:var(--vscode-descriptionForeground);font-family:var(--vscode-font-family);direction:ltr}
.folder-path:hover{opacity:0.7}
</style></head><body>
<h2>SonicNote Sync 同步设置</h2>
<div class="section"><h3>同步</h3>
<div class="setting-row"><div class="setting-label"><div class="name">同步文件夹</div><div class="desc">录音 Markdown 文件存放的目录</div></div><div class="folder-right"><span id="syncFolderPath" class="folder-path" onclick="selectFolder()"></span><button class="btn" onclick="selectFolder()">📁 选择</button></div></div>
<div class="setting-row"><div class="setting-label"><div class="name">包含转录内容</div><div class="desc">关闭后同步的文件中不包含逐字转录内容</div></div><input type="checkbox" id="includeTranscript" onchange="setSetting('includeTranscript',this.checked)"/></div>
<div class="setting-row"><div class="setting-label"><div class="name">启动时自动同步</div><div class="desc">每次打开 VSCode 时自动执行一次同步</div></div><input type="checkbox" id="autoSyncOnOpen" onchange="setSetting('autoSyncOnOpen',this.checked)"/></div>
<div class="setting-row"><div class="setting-label"><div class="name">定时重同步</div><div class="desc">VSCode 打开期间按指定间隔自动重新同步</div></div><select id="resyncIntervalMinutes" onchange="setSetting('resyncIntervalMinutes',parseInt(this.value)||0)"><option value="0">关闭（手动同步）</option><option value="60">每 1 小时</option><option value="180">每 3 小时</option><option value="360">每 6 小时</option><option value="1440">每 24 小时</option></select></div>
</div>
<div class="section"><h3>文件属性</h3><div class="desc" style="margin-bottom:10px;">选择同步到 Frontmatter 中的属性字段</div><div id="builtinFields"></div></div>
<div class="section"><h3>自定义属性</h3><div class="desc" style="margin-bottom:10px;">添加自定义属性到所有同步文件的 Frontmatter 中</div><div id="customFields"></div><button class="btn small" onclick="addCustomField()" style="margin-top:8px;">+ 添加</button></div>
<div class="section"><h3>账号</h3><div id="accountSection"></div></div>
<div id="toast" class="toast"></div>
<script>
const V = acquireVsCodeApi();
let currentData={},currentCustomFields=[],isAuthed=false;
const BUILTIN_FIELDS=${builtinFields};
const REQUIRED_FIELDS=['audio_id','sync_time'];
window.addEventListener('message',e=>{
 const m=e.data;
 if(m.command==='settingsData'){currentData=m.data;isAuthed=m.isAuthed;populateForm(m.data);}
 else if(m.command==='refresh'){V.postMessage({command:'getSettings'});}
 else if(m.command==='loginResult'){if(m.success){showToast('登录成功','success');isAuthed=true;renderAccountSection();V.postMessage({command:'getSettings'});}else{showToast('登录失败: '+(m.error||'未知错误'),'error');var b=document.getElementById('loginBtn');if(b){b.disabled=false;b.textContent='登录';}}}
 else if(m.command==='logoutDone'){isAuthed=false;renderAccountSection();showToast('已登出','success');}
 else if(m.command==='folderSelected'){document.getElementById('syncFolderPath').textContent=m.path;}
});
function selectFolder(){V.postMessage({command:'selectFolder'});}
function setSetting(k,v){
 currentData[k]=v;
 V.postMessage({command:'setSetting',key:k,value:v});
 showToast('已保存','success');
}
function populateForm(d){
 document.getElementById('syncFolderPath').textContent=d.syncFolder||'';
 document.getElementById('includeTranscript').checked=d.includeTranscript!==false;
 document.getElementById('autoSyncOnOpen').checked=d.autoSyncOnOpen===true;
 document.getElementById('resyncIntervalMinutes').value=String(d.resyncIntervalMinutes||0);
 renderBuiltinFields(d.frontmatterFields||{});
 currentCustomFields=d.customFrontmatter||[];
 renderCustomFields();renderAccountSection();
}
function renderBuiltinFields(f){
 var c=document.getElementById('builtinFields'),h='';
 for(var k in BUILTIN_FIELDS){
  var r=REQUIRED_FIELDS.indexOf(k)>=0;
  h+='<div class="setting-row"><div class="setting-label"><div class="name">'+BUILTIN_FIELDS[k]+(r?' <span class="required-tag">必要属性</span>':'')+'</div><div class="key">'+k+'</div></div>';
  h+=r?'<div class="required-tag">必要属性</div>':'<input type="checkbox" '+(f[k]!==false?'checked':'')+' onchange="toggleField(\\''+k+'\\',this.checked)"/>';
  h+='</div>';
 }
 c.innerHTML=h;
}
function toggleField(k,v){
 if(!currentData.frontmatterFields)currentData.frontmatterFields={};
 currentData.frontmatterFields[k]=v;
 setSetting('frontmatterFields',currentData.frontmatterFields);
}
function renderCustomFields(){
 var c=document.getElementById('customFields'),h='';
 currentCustomFields.forEach(function(f,i){
  h+='<div class="custom-row"><input type="text" placeholder="属性名" value="'+esc(f.key||'')+'" onchange="updateCustomKey('+i+',this.value)"/><input type="text" placeholder="属性值" value="'+esc(f.value||'')+'" onchange="updateCustomValue('+i+',this.value)"/><button class="btn small danger" onclick="removeCustomField('+i+')">🗑</button></div>';
 });
 c.innerHTML=h||'<div class="desc">暂无自定义属性</div>';
}
function addCustomField(){currentCustomFields.push({key:'',value:''});renderCustomFields();saveCustomFields();}
function removeCustomField(i){currentCustomFields.splice(i,1);renderCustomFields();saveCustomFields();}
function updateCustomKey(i,v){currentCustomFields[i].key=v;saveCustomFields();}
function updateCustomValue(i,v){currentCustomFields[i].value=v;saveCustomFields();}
function saveCustomFields(){setSetting('customFrontmatter',currentCustomFields);}
function renderAccountSection(){
 var c=document.getElementById('accountSection');
 if(isAuthed){
  c.innerHTML='<div class="setting-row"><div class="setting-label"><div class="name">登录状态 <span class="status-badge ok">已登录</span></div></div><button class="btn danger" onclick="doLogout()">登出</button></div>';
 }else{
  c.innerHTML='<div class="setting-row"><div class="setting-label"><div class="name">登录 <span class="status-badge warn">未登录</span></div><div class="desc">使用 API Key 登录 SonicNote（在妙记 App → 我的 → MCP Key 管理中创建）</div></div><div style="display:flex;align-items:center;gap:10px;"><input type="password" id="apiKeyInput" placeholder="sk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style="width:280px;"/><button class="btn" id="loginBtn" onclick="doLogin()">登录</button></div></div>';
 }
}
function doLogin(){
 var i=document.getElementById('apiKeyInput'),k=i?i.value.trim():'';
 if(!k){showToast('请输入 API Key','error');return;}
 document.getElementById('loginBtn').disabled=true;
 document.getElementById('loginBtn').textContent='登录中...';
 V.postMessage({command:'login',apiKey:k});
}
function doLogout(){V.postMessage({command:'logout'});}
function showToast(m,t){var o=document.getElementById('toast');o.textContent=m;o.className='toast '+t+' show';clearTimeout(o._tid);o._tid=setTimeout(function(){o.className='toast';},2000);}
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
V.postMessage({command:'getSettings'});
</script></body></html>`;
}
