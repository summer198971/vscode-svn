import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService, ConflictFile } from './svnService';
import { TemplateManager } from './templateManager';

/**
 * SVN冲突处理面板
 */
export class SvnConflictPanel {
    public static currentPanel: SvnConflictPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _conflictFiles: ConflictFile[] = [];
    private _isScanning: boolean = false;
    private _isResolving: boolean = false;
    private readonly templateManager: TemplateManager;
    private outputChannel: vscode.OutputChannel;

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly folderPath: string,
        private readonly svnService: SvnService
    ) {
        this._panel = panel;
        this.templateManager = new TemplateManager(extensionUri);
        this.outputChannel = vscode.window.createOutputChannel('SVN冲突处理');
        
        // 设置初始状态
        this._update('scanning');

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setupMessageHandlers();
        
        // 自动开始扫描
        this._startScan();
    }

    public static async createOrShow(
        extensionUri: vscode.Uri,
        folderPath: string,
        svnService: SvnService
    ): Promise<void> {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 如果已经有面板，直接显示
        if (SvnConflictPanel.currentPanel) {
            SvnConflictPanel.currentPanel._panel.reveal(column);
            // 重新扫描
            await SvnConflictPanel.currentPanel._startScan();
            return;
        }

        // 创建新面板
        const panel = vscode.window.createWebviewPanel(
            'svnConflictPanel',
            'SVN冲突文件处理',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'out', 'templates'),
                    vscode.Uri.joinPath(extensionUri, 'media')
                ],
                retainContextWhenHidden: true
            }
        );

        SvnConflictPanel.currentPanel = new SvnConflictPanel(panel, extensionUri, folderPath, svnService);
    }

    public dispose() {
        SvnConflictPanel.currentPanel = undefined;

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private async _update(state: 'scanning' | 'list' | 'resolving' | 'completed') {
        const webview = this._panel.webview;
        this._panel.webview.html = await this._getHtmlForWebview(webview, state);
    }

    private async _getHtmlForWebview(webview: vscode.Webview, state: string): Promise<string> {
        try {
            let html = await this.templateManager.loadTemplate('conflictPanel', webview);
            
            // 替换资源路径
            html = html.replace(
                /{{cspSource}}/g,
                webview.cspSource
            );

            // 替换数据（转义特殊字符）
            html = html.replace(/{{folderPath}}/g, this.folderPath.replace(/\\/g, '/'));
            html = html.replace(/{{folderName}}/g, path.basename(this.folderPath));
            html = html.replace(/{{state}}/g, state);
            
            // 转义JSON字符串中的特殊字符
            const conflictFilesJson = JSON.stringify(this._conflictFiles)
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r');
            html = html.replace(/{{conflictFiles}}/g, conflictFilesJson);
            html = html.replace(/{{conflictCount}}/g, this._conflictFiles.length.toString());

            return html;
        } catch (error: any) {
            this.outputChannel.appendLine(`加载模板失败: ${error.message}`);
            // 返回简单的错误页面
            return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>错误</title>
</head>
<body>
    <h1>加载冲突处理面板失败</h1>
    <p>错误信息: ${error.message}</p>
</body>
</html>`;
        }
    }

    private _setupMessageHandlers() {
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'startScan':
                        await this._startScan();
                        break;
                    
                    case 'resolveConflict':
                        await this._resolveConflict(message.filePath, message.strategy);
                        break;
                    
                    case 'markResolved':
                        await this._markResolved(message.filePath);
                        break;
                    
                    case 'resolveAll':
                        await this._resolveAll(message.strategy);
                        break;
                    
                    case 'refresh':
                        await this._startScan();
                        break;
                    
                    case 'viewDiff':
                        await this._viewDiff(message.filePath);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    /**
     * 开始扫描冲突
     */
    private async _startScan() {
        if (this._isScanning) {
            return;
        }

        this._isScanning = true;
        this._conflictFiles = [];
        await this._update('scanning');

        try {
            // 发送扫描开始消息
            this._panel.webview.postMessage({
                command: 'scanStarted',
                folderPath: this.folderPath
            });

            // 执行扫描
            this._conflictFiles = await this.svnService.scanConflicts(
                this.folderPath,
                (currentFile, progress) => {
                    // 发送进度更新
                    this._panel.webview.postMessage({
                        command: 'scanProgress',
                        currentFile: path.basename(currentFile),
                        progress
                    });
                }
            );

            this._isScanning = false;

            // 发送扫描完成消息
            this._panel.webview.postMessage({
                command: 'scanCompleted',
                conflictFiles: this._conflictFiles,
                count: this._conflictFiles.length
            });

            // 更新界面
            if (this._conflictFiles.length > 0) {
                await this._update('list');
            } else {
                await this._update('completed');
            }
        } catch (error: any) {
            this._isScanning = false;
            this.outputChannel.appendLine(`扫描冲突失败: ${error.message}`);
            
            // 发送错误消息
            this._panel.webview.postMessage({
                command: 'scanError',
                error: error.message
            });

            vscode.window.showErrorMessage(`扫描冲突失败: ${error.message}`);
        }
    }

    /**
     * 解决单个冲突
     */
    private async _resolveConflict(filePath: string, strategy: 'mine' | 'theirs' | 'working') {
        if (this._isResolving) {
            return;
        }

        try {
            this._isResolving = true;
            
            // 发送解决开始消息
            this._panel.webview.postMessage({
                command: 'resolveStarted',
                filePath
            });

            await this.svnService.resolveConflict(filePath, strategy);

            // 从列表中移除已解决的文件
            this._conflictFiles = this._conflictFiles.filter(f => f.path !== filePath);

            // 发送解决完成消息
            this._panel.webview.postMessage({
                command: 'resolveCompleted',
                filePath,
                remainingCount: this._conflictFiles.length
            });

            // 如果所有冲突都已解决，更新状态
            if (this._conflictFiles.length === 0) {
                await this._update('completed');
            } else {
                await this._update('list');
            }

            vscode.window.showInformationMessage(`冲突已解决: ${path.basename(filePath)}`);
        } catch (error: any) {
            this.outputChannel.appendLine(`解决冲突失败: ${error.message}`);
            
            // 发送错误消息
            this._panel.webview.postMessage({
                command: 'resolveError',
                filePath,
                error: error.message
            });

            vscode.window.showErrorMessage(`解决冲突失败: ${error.message}`);
        } finally {
            this._isResolving = false;
        }
    }

    /**
     * 标记冲突已解决
     */
    private async _markResolved(filePath: string) {
        try {
            await this.svnService.markResolved(filePath);

            // 从列表中移除
            this._conflictFiles = this._conflictFiles.filter(f => f.path !== filePath);

            // 发送消息
            this._panel.webview.postMessage({
                command: 'resolveCompleted',
                filePath,
                remainingCount: this._conflictFiles.length
            });

            // 更新界面
            if (this._conflictFiles.length === 0) {
                await this._update('completed');
            } else {
                await this._update('list');
            }

            vscode.window.showInformationMessage(`冲突已标记为已解决: ${path.basename(filePath)}`);
        } catch (error: any) {
            this.outputChannel.appendLine(`标记冲突已解决失败: ${error.message}`);
            vscode.window.showErrorMessage(`标记冲突已解决失败: ${error.message}`);
        }
    }

    /**
     * 批量解决冲突
     */
    private async _resolveAll(strategy: 'mine' | 'theirs' | 'working') {
        if (this._conflictFiles.length === 0) {
            return;
        }

        // 确认操作
        const strategyText = strategy === 'mine' ? '本地版本' : strategy === 'theirs' ? '服务器版本' : '工作副本版本';
        const confirm = await vscode.window.showWarningMessage(
            `确定要使用${strategyText}解决所有 ${this._conflictFiles.length} 个冲突文件吗？`,
            { modal: true },
            '确定',
            '取消'
        );

        if (confirm !== '确定') {
            return;
        }

        if (this._isResolving) {
            return;
        }

        try {
            this._isResolving = true;
            await this._update('resolving');

            // 发送批量解决开始消息
            this._panel.webview.postMessage({
                command: 'resolveAllStarted',
                count: this._conflictFiles.length
            });

            const filePaths = this._conflictFiles.map(f => f.path);
            
            await this.svnService.resolveConflicts(
                filePaths,
                strategy,
                (currentFile, progress) => {
                    // 发送进度更新
                    this._panel.webview.postMessage({
                        command: 'resolveProgress',
                        currentFile: path.basename(currentFile),
                        progress
                    });
                }
            );

            // 清空列表
            this._conflictFiles = [];

            // 发送批量解决完成消息
            this._panel.webview.postMessage({
                command: 'resolveAllCompleted'
            });

            await this._update('completed');
            vscode.window.showInformationMessage(`所有冲突已解决！`);
        } catch (error: any) {
            this.outputChannel.appendLine(`批量解决冲突失败: ${error.message}`);
            
            // 发送错误消息
            this._panel.webview.postMessage({
                command: 'resolveError',
                error: error.message
            });

            vscode.window.showErrorMessage(`批量解决冲突失败: ${error.message}`);
            
            // 重新扫描以更新列表
            await this._startScan();
        } finally {
            this._isResolving = false;
        }
    }

    /**
     * 查看冲突对比
     */
    private async _viewDiff(filePath: string) {
        try {
            // 打开文件在编辑器中
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document);

            // 显示信息提示
            vscode.window.showInformationMessage(
                `文件已打开，请手动编辑解决冲突标记（<<<<<<<、=======、>>>>>>>），然后点击"标记已解决"`
            );
        } catch (error: any) {
            this.outputChannel.appendLine(`打开文件失败: ${error.message}`);
            vscode.window.showErrorMessage(`打开文件失败: ${error.message}`);
        }
    }
}

