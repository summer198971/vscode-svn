import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { AiService } from './aiService';
import { CommitLogStorage } from './commitLogStorage';

/**
 * SVN提交面板
 */
export class SvnCommitPanel {
  public static currentPanel: SvnCommitPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly filePath: string;
  private readonly svnService: SvnService;
  private readonly diffProvider: SvnDiffProvider;
  private readonly aiService: AiService;
  private readonly logStorage: CommitLogStorage;
  private disposables: vscode.Disposable[] = [];
  private hasChanges: boolean = false;
  private diffShown: boolean = false;
  private diffContent: string = '';
  // 最近一次AI生成的提交日志，用于在收到前缀后应用，避免重复调用AI
  private lastGeneratedMessage: string = '';

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    filePath: string,
    svnService: SvnService,
    diffProvider: SvnDiffProvider,
    logStorage: CommitLogStorage
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.filePath = filePath;
    this.svnService = svnService;
    this.diffProvider = diffProvider;
    this.logStorage = logStorage;
    this.aiService = new AiService();

    // 设置WebView内容
    this.updatePanelContent();

    // 当面板关闭时清理资源
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // 处理来自WebView的消息
    this.setupMessageHandlers();
  }

  /**
   * 创建或显示提交面板
   */
  public static async createOrShow(
    extensionUri: vscode.Uri,
    filePath: string,
    svnService: SvnService,
    diffProvider: SvnDiffProvider,
    logStorage: CommitLogStorage
  ): Promise<void> {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // 如果面板已经存在，检查是否是同一个文件
    if (SvnCommitPanel.currentPanel) {
      // 如果是同一个文件，只需要刷新面板
      if (SvnCommitPanel.currentPanel.filePath === filePath) {
        SvnCommitPanel.currentPanel.refreshPanel();
        SvnCommitPanel.currentPanel.panel.reveal(column);
        return;
      } else {
        // 如果是不同的文件，关闭当前面板，创建新的
        SvnCommitPanel.currentPanel.panel.dispose();
      }
    }

    // 创建新的面板
    const panel = vscode.window.createWebviewPanel(
      'svnCommit',
      `SVN提交: ${path.basename(filePath)}`,
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
        retainContextWhenHidden: true
      }
    );

    SvnCommitPanel.currentPanel = new SvnCommitPanel(
      panel,
      extensionUri,
      filePath,
      svnService,
      diffProvider,
      logStorage
    );

    // 显示差异视图
    await SvnCommitPanel.currentPanel.showDiffView();
  }

  /**
   * 显示差异视图
   */
  private async showDiffView() {
    try {
      // 获取差异内容
      this.diffContent = await this.diffProvider.getDiff(this.filePath);
      
      // 不再自动显示左右对比视图，只设置hasChanges标志
      this.hasChanges = this.diffContent.length > 0;
      this.diffShown = true;
      
      // 更新提交面板
      this.updatePanelContent();
    } catch (error: any) {
      vscode.window.showErrorMessage(`显示差异失败: ${error.message}`);
      // 假设有修改，允许提交
      this.hasChanges = true;
      this.updatePanelContent();
    }
  }

  /**
   * 使用AI生成提交日志
   */
  private async generateCommitMessage() {
    try {
      if (!this.diffContent) {
        this.diffContent = await this.diffProvider.getDiff(this.filePath);
      }
      const commitMessage = await this.aiService.generateCommitMessage(this.diffContent);
      if (commitMessage) {
        this.lastGeneratedMessage = commitMessage;
        // 获取当前前缀输入框的值
        this.panel.webview.postMessage({
          command: 'getCurrentPrefix'
        });
        
        // 前缀处理将在接收到前缀后通过消息处理
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`生成提交日志失败: ${error.message}`);
    }
  }

  /**
   * 更新WebView内容
   */
  private async updatePanelContent() {
    this.panel.title = `SVN提交: ${path.basename(this.filePath)}`;

    try {
      // 检查文件是否有修改
      const status = await this.svnService.getFileStatus(this.filePath);
      this.hasChanges = status !== '无修改';
      const statusMessage = this.getStatusMessage(status);
      
      // 更新提交面板
      this.panel.webview.html = this.getHtmlForWebview(statusMessage);
    } catch (error: any) {
      // 如果更新失败，显示错误信息
      const webview = this.panel.webview;
      webview.html = this.getHtmlForWebview(`
        <div class="error-message">
          <h3>检查文件状态失败</h3>
          <p>原因: ${error.message}</p>
          <p>您仍然可以继续提交文件。</p>
        </div>
      `);
      // 强制设置hasChanges为true，允许提交
      this.hasChanges = true;
    }
  }

  /**
   * 获取WebView的HTML内容
   */
  private getHtmlForWebview(statusMessage: string): string {
    const logs = this.logStorage.getLogs();
    const formattedLogs = logs.map((log, index) => {
      const date = new Date(log.timestamp);
      const formattedDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      return `
        <div class="history-log" onclick="selectLog(${index})">
          <div class="log-time">${formattedDate}</div>
          <div class="log-message">${log.message}</div>
        </div>
      `;
    }).join('');

    // 获取前缀历史
    const prefixes = this.logStorage.getPrefixes();
    const prefixOptions = prefixes.map(prefix => 
      `<option value="${this.escapeHtml(prefix)}">${this.escapeHtml(prefix)}</option>`
    ).join('');
    
    // 获取最新前缀
    const latestPrefix = this.logStorage.getLatestPrefix();

    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>SVN提交</title>
      <style>
        body {
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
          color: var(--vscode-foreground);
          background-color: var(--vscode-editor-background);
          padding: 10px;
          display: flex;
          flex-direction: column;
          height: 100vh;
          margin: 0;
        }
        .container {
          display: flex;
          flex: 1;
          gap: 10px;
          min-height: 0;
        }
        .left-panel {
          flex: 2;
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .right-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 200px;
          max-width: 300px;
        }
        .diff-container {
          flex: 1;
          border: 1px solid var(--vscode-panel-border);
          margin-bottom: 10px;
          padding: 10px;
          overflow: auto;
          white-space: pre;
          font-family: monospace;
          background-color: var(--vscode-editor-background);
        }
        .history-container {
          flex: 1;
          border: 1px solid var(--vscode-panel-border);
          overflow: auto;
          background-color: var(--vscode-editor-background);
        }
        .commit-container {
          border: 1px solid var(--vscode-panel-border);
          padding: 10px;
          background-color: var(--vscode-editor-background);
        }
        .prefix-container {
          margin-bottom: 10px;
          display: flex;
          gap: 5px;
          position: relative;
        }
        .prefix-input {
          flex: 1;
          background-color: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          padding: 4px;
        }
        .prefix-select {
          flex: 1;
          background-color: var(--vscode-dropdown-background);
          color: var(--vscode-dropdown-foreground);
          border: 1px solid var(--vscode-dropdown-border);
          padding: 4px;
        }
        textarea {
          width: 100%;
          min-height: 100px;
          margin-bottom: 10px;
          background-color: var(--vscode-input-background);
          color: var(--vscode-input-foreground);
          border: 1px solid var(--vscode-input-border);
          padding: 5px;
          font-family: var(--vscode-font-family);
          resize: vertical;
        }
        .button-container {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
        }
        button {
          background-color: var(--vscode-button-background);
          color: var(--vscode-button-foreground);
          border: none;
          padding: 8px 12px;
          cursor: pointer;
        }
        button:hover {
          background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .history-log {
          padding: 8px;
          border-bottom: 1px solid var(--vscode-panel-border);
          cursor: pointer;
        }
        .history-log:hover {
          background-color: var(--vscode-list-hoverBackground);
        }
        .log-time {
          font-size: 0.9em;
          color: var(--vscode-descriptionForeground);
        }
        .log-message {
          margin-top: 4px;
          word-break: break-all;
        }
        .ai-button {
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .ai-button svg {
          width: 16px;
          height: 16px;
        }
        .diff-line-add {
          color: var(--vscode-gitDecoration-addedResourceForeground);
          background-color: var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2));
        }
        .diff-line-delete {
          color: var(--vscode-gitDecoration-deletedResourceForeground);
          background-color: var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2));
        }
        .diff-line-info {
          color: var(--vscode-editorInfo-foreground);
          background-color: var(--vscode-editorInfo-background, rgba(0, 122, 204, 0.1));
          font-weight: bold;
        }
        .diff-line-header {
          color: var(--vscode-descriptionForeground);
          font-weight: bold;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
        .diff-line-index {
          color: var(--vscode-editorWarning-foreground);
          font-weight: bold;
        }
        .diff-line-context {
          color: var(--vscode-foreground);
        }
        .no-changes {
          color: var(--vscode-descriptionForeground);
          font-style: italic;
          text-align: center;
          padding: 20px;
        }
        .encoding-info {
          background-color: var(--vscode-editorWidget-background);
          border: 1px solid var(--vscode-editorWidget-border);
          padding: 8px;
          margin-bottom: 10px;
          border-radius: 3px;
          font-size: 0.9em;
          color: var(--vscode-descriptionForeground);
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="left-panel">
          <div class="diff-container">
            <div class="file-info">${this.filePath}</div>
            <div class="status-message">${statusMessage}</div>
            <div class="diff-actions">
              <button id="show-side-by-side-diff-button">显示左右对比视图</button>
            </div>
            ${this.formatDiffContent(this.diffContent)}
          </div>
          <div class="commit-container">
            <div class="prefix-container">
              <select id="prefix-select" class="prefix-select">
                <option value="">-- 选择前缀 --</option>
                ${prefixOptions}
              </select>
              <input type="text" id="prefix-input" class="prefix-input" placeholder="日志前缀" value="${this.escapeHtml(latestPrefix)}">
              <button id="apply-prefix-button">应用前缀</button>
            </div>
            <div class="message-container">
              <button id="generate-message-button" class="ai-button" ${this.hasChanges ? '' : 'disabled'}>
                <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                使用AI生成提交日志
              </button>
              <textarea id="commit-message" placeholder="请输入提交日志..."></textarea>
            </div>
            <div class="button-container">
              <button id="cancel-button">取消</button>
              <button id="commit-button" ${this.hasChanges ? '' : 'disabled'}>提交</button>
            </div>
          </div>
        </div>
        <div class="right-panel">
          <h3>历史日志</h3>
          <div class="history-container">
            ${formattedLogs}
          </div>
        </div>
      </div>

      <script>
        (function() {
          const vscode = acquireVsCodeApi();

          // 是否允许空提交信息（来自扩展配置）
          const allowEmptyCommitMessage = ${this.allowEmptyCommitMessage};

          // 获取元素
          const commitButton = document.getElementById('commit-button');
          const cancelButton = document.getElementById('cancel-button');
          const commitMessage = document.getElementById('commit-message');
          const showSideBySideDiffButton = document.getElementById('show-side-by-side-diff-button');
          const generateMessageButton = document.getElementById('generate-message-button');
          const prefixInput = document.getElementById('prefix-input');
          const prefixSelect = document.getElementById('prefix-select');
          const applyPrefixButton = document.getElementById('apply-prefix-button');
          
          // 提交按钮点击事件
          commitButton.addEventListener('click', () => {
            const message = commitMessage.value.trim();
            if (!message && !allowEmptyCommitMessage) {
              alert('请输入提交日志');
              return;
            }
            vscode.postMessage({
              command: 'commit',
              message: message
            });
          });
          
          // 取消按钮点击事件
          cancelButton.addEventListener('click', () => {
            vscode.postMessage({
              command: 'cancel'
            });
          });
          
          // 显示左右对比视图按钮点击事件
          if (showSideBySideDiffButton) {
            showSideBySideDiffButton.addEventListener('click', () => {
              vscode.postMessage({
                command: 'showSideBySideDiff'
              });
            });
          }
          
          // AI生成提交日志按钮点击事件
          if (generateMessageButton) {
            generateMessageButton.addEventListener('click', () => {
              generateMessageButton.disabled = true;
              generateMessageButton.textContent = '正在生成提交日志...';
              vscode.postMessage({
                command: 'generateCommitMessage'
              });
            });
          }

          // 前缀选择下拉框变化事件
          prefixSelect.addEventListener('change', () => {
            if (prefixSelect.value) {
              prefixInput.value = prefixSelect.value;
            }
          });

          // 应用前缀按钮点击事件
          applyPrefixButton.addEventListener('click', () => {
            const prefix = prefixInput.value.trim();
            if (prefix) {
              // 保存到前缀历史
              vscode.postMessage({
                command: 'savePrefix',
                prefix: prefix
              });
              
              const currentMessage = commitMessage.value.trim();
              
              // 检查当前日志是否已有前缀
              const lines = currentMessage.split('\\n');
              const newMessage = prefix + '\\n' + (lines.length > 1 ? lines.slice(1).join('\\n') : currentMessage);
              
              commitMessage.value = newMessage;
            }
          });
          
          // 选择历史日志
          window.selectLog = (logId) => {
            vscode.postMessage({
              command: 'selectHistoryLog',
              logId: logId
            });
          };
          
          // 监听来自扩展的消息
          window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.command) {
              case 'updateCommitMessage':
                commitMessage.value = message.message;
                if (generateMessageButton) {
                  generateMessageButton.disabled = false;
                  generateMessageButton.innerHTML = \`
                    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                      <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                    使用AI生成提交日志
                  \`;
                }
                break;
              case 'getCurrentPrefix':
                // 返回当前前缀给扩展
                vscode.postMessage({
                  command: 'applyPrefixToMessage',
                  prefix: prefixInput.value.trim()
                });
                break;
              case 'savePrefix':
                // 保存前缀到历史记录
                this.logStorage.addPrefix(message.prefix);
                break;
            }
          });
        }());
      </script>
    </body>
    </html>`;
  }

  /**
   * 格式化差异内容用于HTML显示
   * @param content 差异内容
   * @returns 格式化后的HTML字符串
   */
  private formatDiffContent(content: string): string {
    if (!content) {
      return '<div class="no-changes">无差异内容</div>';
    }

    // 确保内容是有效的UTF-8字符串
    const processedContent = this.ensureUtf8Content(content);

    return processedContent.split('\n').map(line => {
      // 转义HTML特殊字符，防止XSS攻击
      const escapedLine = this.escapeHtml(line);
      
      if (line.startsWith('+')) {
        return `<div class="diff-line-add">${escapedLine}</div>`;
      } else if (line.startsWith('-')) {
        return `<div class="diff-line-delete">${escapedLine}</div>`;
      } else if (line.startsWith('@@')) {
        return `<div class="diff-line-info">${escapedLine}</div>`;
      } else if (line.startsWith('+++') || line.startsWith('---')) {
        return `<div class="diff-line-header">${escapedLine}</div>`;
      } else if (line.startsWith('Index:')) {
        return `<div class="diff-line-index">${escapedLine}</div>`;
      } else {
        return `<div class="diff-line-context">${escapedLine}</div>`;
      }
    }).join('');
  }

  /**
   * 确保内容是有效的UTF-8编码
   * @param content 原始内容
   * @returns 处理后的UTF-8内容
   */
  private ensureUtf8Content(content: string): string {
    try {
      // 检查是否包含乱码字符
      if (content.includes('\uFFFD') || this.hasGarbledCharacters(content)) {
        // 尝试重新编码
        return this.fixContentEncoding(content);
      }
      return content;
    } catch (error) {
      console.warn('编码处理失败，使用原内容:', error);
      return content;
    }
  }

  /**
   * 检测是否包含乱码字符
   * @param content 内容
   * @returns 是否包含乱码
   */
  private hasGarbledCharacters(content: string): boolean {
    // 检测常见乱码模式
    const garbledPatterns = [
      /[\u00C0-\u00FF]{2,}/,  // 连续的扩展ASCII字符
      /\?{3,}/,              // 连续的问号（可能是编码错误导致的）
      /[\u0080-\u00FF]{3,}/  // 连续的高位字符
    ];
    
    return garbledPatterns.some(pattern => pattern.test(content));
  }

  /**
   * 修复内容编码问题
   * @param content 有问题的内容
   * @returns 修复后的内容
   */
  private fixContentEncoding(content: string): string {
    try {
      // 尝试将内容重新编码
      const buffer = Buffer.from(content, 'latin1');
      
      // 尝试常见的中文编码
      const encodings = ['utf8', 'gbk', 'gb2312', 'big5'];
      
      for (const encoding of encodings) {
        try {
          const decoded = buffer.toString(encoding as BufferEncoding);
          
          // 检查解码结果是否包含中文字符且没有乱码
          if (/[\u4e00-\u9fff]/.test(decoded) && !decoded.includes('\uFFFD')) {
            return decoded;
          }
        } catch {
          continue;
        }
      }
      
      // 如果所有编码都失败，返回原内容
      return content;
    } catch (error) {
      return content;
    }
  }

  /**
   * 转义HTML特殊字符
   * @param text 原始文本
   * @returns 转义后的文本
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 是否允许空提交信息（读取配置 vscode-svn.allowEmptyCommitMessage）
   */
  private get allowEmptyCommitMessage(): boolean {
    return vscode.workspace.getConfiguration('vscode-svn').get<boolean>('allowEmptyCommitMessage', false);
  }

  /**
   * 提交文件
   * @param message 提交信息
   */
  private async commitFile(message: string) {
    try {
      if (!message.trim() && !this.allowEmptyCommitMessage) {
        vscode.window.showErrorMessage('请输入提交信息');
        return;
      }

      // 如果文件没有修改，不允许提交
      if (!this.hasChanges) {
        vscode.window.showInformationMessage('文件没有修改，无需提交');
        this.panel.dispose();
        return;
      }

      // 提交文件
      await this.svnService.commit(this.filePath, message);
      this.logStorage.addLog(message, this.filePath);
      vscode.window.showInformationMessage(`文件已成功提交到SVN`);
      this.panel.dispose();
    } catch (error: any) {
      // 如果提交失败，尝试使用另一种方法
      try {
        // 获取文件状态
        const status = await this.svnService.getFileStatus(this.filePath);
        
        // 如果文件未在版本控制下，先添加到SVN
        if (status === '未版本控制') {
          await this.svnService.addFile(this.filePath);
        }
        
        // 再次尝试提交
        await this.svnService.commit(this.filePath, message);
        this.logStorage.addLog(message, this.filePath);
        vscode.window.showInformationMessage(`文件已成功提交到SVN`);
        this.panel.dispose();
      } catch (fallbackError: any) {
        vscode.window.showErrorMessage(`SVN提交失败: ${error.message}`);
      }
    }
  }

  private getStatusMessage(status: string): string {
    switch (status) {
      case '已修改':
        return '<span style="color: var(--vscode-gitDecoration-modifiedResourceForeground);">文件已修改</span>';
      case '未版本控制':
        return '<span style="color: var(--vscode-gitDecoration-untrackedResourceForeground);">文件未在版本控制下</span>';
      case '无修改':
        return '<span class="no-changes">文件无修改</span>';
      default:
        return `<span style="color: var(--vscode-gitDecoration-modifiedResourceForeground);">文件状态: ${status}</span>`;
    }
  }

  private async selectHistoryLog(logId: number) {
    const logs = this.logStorage.getLogs();
    const selectedLog = logs[logId];
    if (selectedLog) {
      this.panel.webview.postMessage({
        command: 'updateCommitMessage',
        message: selectedLog.message
      });
    }
  }

  private async applyPrefix(prefix: string, commitMessage: string) {
    // 如果前缀不为空，添加到日志前面并换行
    if (prefix.trim()) {
      return `${prefix.trim()}\n${commitMessage}`;
    }
    return commitMessage;
  }

  /**
   * 释放资源
   */
  private dispose() {
    SvnCommitPanel.currentPanel = undefined;

    // 清理资源
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  // 处理WebView中的消息
  private setupMessageHandlers() {
    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
        case 'commit':
          await this.commitFile(message.message);
          break;
        case 'cancel':
          this.panel.dispose();
          break;
        case 'showSideBySideDiff':
          await this.showSideBySideDiff();
          break;
        case 'generateCommitMessage':
          await this.generateCommitMessage();
          break;
        case 'selectHistoryLog':
          await this.selectHistoryLog(message.logId);
          break;
        case 'applyPrefixToMessage': {
          // 收到前缀后，应用到已生成的AI消息（不重复调用AI）
          if (this.lastGeneratedMessage) {
            const messageWithPrefix = await this.applyPrefix(message.prefix, this.lastGeneratedMessage);
            this.lastGeneratedMessage = '';
            this.panel.webview.postMessage({
              command: 'updateCommitMessage',
              message: messageWithPrefix
            });
          }
          break;
        }
        case 'savePrefix':
          // 保存前缀到历史记录
          this.logStorage.addPrefix(message.prefix);
          break;
      }
    });
  }

  // 刷新面板内容
  private async refreshPanel(): Promise<void> {
    // 重新获取差异内容
    this.diffContent = '';
    this.diffShown = false;
    await this.updatePanelContent();
    await this.showDiffView();
  }

  // 添加新方法：显示左右对比视图
  private async showSideBySideDiff() {
    try {
      await this.diffProvider.showDiff(this.filePath);
    } catch (error: any) {
      vscode.window.showErrorMessage(`显示左右对比视图失败: ${error.message}`);
    }
  }
} 