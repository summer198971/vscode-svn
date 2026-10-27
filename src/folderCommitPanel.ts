import * as vscode from 'vscode';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { CommitLogStorage } from './commitLogStorage';
import { SvnFilterService } from './filterService';
import { TemplateManager } from './templateManager';
import { parseSvnStatusOutput } from './svnStatusParser';
import * as path from 'path';
import { AiService } from './aiService';

interface FileStatus {
    path: string;
    status: string;
    type: 'modified' | 'added' | 'deleted' | 'unversioned' | 'conflict' | 'missing';
    displayName: string;
    /** 所属 changelist 名称（未分组则为 undefined） */
    changelist?: string;
}

export class SvnFolderCommitPanel {
    public static currentPanel: SvnFolderCommitPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _fileStatuses: FileStatus[] = [];
    private readonly aiService: AiService;
    private outputChannel: vscode.OutputChannel;
    private readonly filterService: SvnFilterService;
    private readonly templateManager: TemplateManager;
    private _filterStats: { totalFiles: number, filteredFiles: number, excludedFiles: number } = { totalFiles: 0, filteredFiles: 0, excludedFiles: 0 };

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly folderPath: string,
        private readonly svnService: SvnService,
        private readonly diffProvider: SvnDiffProvider,
        private readonly logStorage: CommitLogStorage
    ) {
        this._panel = panel;
        this.aiService = new AiService();
        this.filterService = new SvnFilterService();
        this.templateManager = new TemplateManager(extensionUri);
        this.outputChannel = vscode.window.createOutputChannel('SVN 文件夹提交');
        
        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._setupMessageHandlers();
    }

    public static async createOrShow(
        extensionUri: vscode.Uri,
        folderPath: string,
        svnService: SvnService,
        diffProvider: SvnDiffProvider,
        logStorage: CommitLogStorage
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // 检查是否已存在面板
        if (SvnFolderCommitPanel.currentPanel) {
            // 比较文件夹路径，如果不同则关闭旧面板
            if (SvnFolderCommitPanel.currentPanel.folderPath !== folderPath) {
                console.log(`文件夹路径不同，关闭旧面板: ${SvnFolderCommitPanel.currentPanel.folderPath} -> ${folderPath}`);
                SvnFolderCommitPanel.currentPanel.dispose();
                // 注意：dispose() 方法会将 currentPanel 设置为 undefined
            } else {
                // 相同路径，直接显示现有面板
                SvnFolderCommitPanel.currentPanel._panel.reveal(column);
                return;
            }
        }

        const panel = vscode.window.createWebviewPanel(
            'svnFolderCommit',
            '提交文件夹到SVN',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri]
            }
        );

        SvnFolderCommitPanel.currentPanel = new SvnFolderCommitPanel(
            panel,
            extensionUri,
            folderPath,
            svnService,
            diffProvider,
            logStorage
        );
    }

    private async _update() {
        const webview = this._panel.webview;
        this._panel.title = `提交文件夹到SVN: ${path.basename(this.folderPath)}`;
        
        // 获取文件状态
        await this._updateFileStatuses();
        
        // 生成HTML
        webview.html = await this._getHtmlForWebview();
    }

    private _getFilterInfo(): { totalFiles: number, filteredFiles: number, excludedFiles: number } {
        return this._filterStats;
    }

    private async _updateFileStatuses() {
        try {
            this.outputChannel.appendLine(`\n[_updateFileStatuses] 开始更新文件状态`);
            this.outputChannel.appendLine(`[_updateFileStatuses] 文件夹路径: ${this.folderPath}`);
            
            // 使用原生格式获取状态
            this.outputChannel.appendLine(`[_updateFileStatuses] 执行SVN status命令（忽略 svn:externals 外部链接）...`);
            // 添加 --ignore-externals 屏蔽 svn:externals 引用的外部目录（issue #19）
            const statusResult = await this.svnService.executeSvnCommand('status --ignore-externals', this.folderPath, false);
            console.log('SVN status result:', statusResult);
            this.outputChannel.appendLine(`[_updateFileStatuses] SVN status 原始输出长度: ${statusResult.length} 字符`);
            this.outputChannel.appendLine(`[_updateFileStatuses] SVN status 原始输出:\n${statusResult}`);

            // 解析状态输出（含 changelist 分组，issue #21）
            const allFileStatuses = parseSvnStatusOutput(statusResult, this.folderPath).map(file => {
                this.outputChannel.appendLine(`[_updateFileStatuses] 解析: "${file.displayName}" 状态: "${file.status}" 类型: ${file.type}${file.changelist ? ` changelist: ${file.changelist}` : ''}`);
                return {
                    path: file.path,
                    status: this._getStatusText(file.status),
                    type: file.type,
                    displayName: file.displayName,
                    changelist: file.changelist
                };
            });

            // 应用过滤器排除不需要的文件
            this.outputChannel.appendLine(`[_updateFileStatuses] 开始应用过滤器，原始文件数量: ${allFileStatuses.length}`);
            
            // 先按文件类型分组统计
            const statusCounts = allFileStatuses.reduce((counts, file) => {
                counts[file.type] = (counts[file.type] || 0) + 1;
                return counts;
            }, {} as Record<string, number>);
            
            this.outputChannel.appendLine(`[_updateFileStatuses] 原始文件状态统计:`);
            Object.entries(statusCounts).forEach(([type, count]) => {
                this.outputChannel.appendLine(`  - ${type}: ${count} 个`);
            });
            
            const filteredFileStatuses = allFileStatuses.filter(fileStatus => {
                // 检查是否显示丢失的文件
                const config = vscode.workspace.getConfiguration('vscode-svn');
                const showMissingFiles = config.get<boolean>('showMissingFiles', true);
                
                // 如果是丢失文件且配置不显示丢失文件，则排除
                if (fileStatus.type === 'missing' && !showMissingFiles) {
                    this.outputChannel.appendLine(`[_updateFileStatuses] 丢失文件被配置排除: ${fileStatus.displayName} (${fileStatus.status})`);
                    return false;
                }
                
                // 检查文件是否应该被排除
                const shouldExclude = this.filterService.shouldExcludeFile(fileStatus.path, this.folderPath);
                if (shouldExclude) {
                    console.log(`文件被过滤器排除: ${fileStatus.displayName}`);
                    this.outputChannel.appendLine(`[_updateFileStatuses] 文件被过滤器排除: ${fileStatus.displayName} (${fileStatus.status}) - 类型: ${fileStatus.type}`);
                } else {
                    this.outputChannel.appendLine(`[_updateFileStatuses] 文件通过过滤器: ${fileStatus.displayName} (${fileStatus.status}) - 类型: ${fileStatus.type}`);
                }
                return !shouldExclude;
            });

            // 记录过滤结果
            const excludedCount = allFileStatuses.length - filteredFileStatuses.length;
            this._filterStats = {
                totalFiles: allFileStatuses.length,
                filteredFiles: filteredFileStatuses.length,
                excludedFiles: excludedCount
            };
            
            if (excludedCount > 0) {
                console.log(`过滤器排除了 ${excludedCount} 个文件`);
                this.outputChannel.appendLine(`过滤器排除了 ${excludedCount} 个文件，显示 ${filteredFileStatuses.length} 个文件`);
            }

            this._fileStatuses = filteredFileStatuses;
            console.log('Processed and filtered file statuses:', this._fileStatuses);
            this.outputChannel.appendLine(`[_updateFileStatuses] 最终文件状态列表 (${this._fileStatuses.length} 个文件):`);
            this._fileStatuses.forEach((file, index) => {
                this.outputChannel.appendLine(`  ${index + 1}. ${file.displayName} (${file.status}) - ${file.type}`);
            });
        } catch (error) {
            console.error('Error updating file statuses:', error);
            vscode.window.showErrorMessage(`更新文件状态失败: ${error}`);
            this._fileStatuses = [];
        }
    }

    /**
     * 将选中的文件加入 changelist（issue #21）
     * 未版本控制的文件不能加入 changelist，会被自动过滤并提示
     */
    private async _setChangelist(filePaths: string[], name: string): Promise<void> {
        try {
            if (filePaths.length === 0) {
                vscode.window.showInformationMessage('请先勾选要操作的文件');
                return;
            }
            if (!name) {
                vscode.window.showInformationMessage('请输入 changelist 名称');
                return;
            }

            // 未版本控制的文件不能加入 changelist
            const eligible = filePaths.filter(p => {
                const st = this._fileStatuses.find(f => f.path === p);
                return st && st.type !== 'unversioned';
            });
            const skipped = filePaths.length - eligible.length;
            if (eligible.length === 0) {
                vscode.window.showWarningMessage('未版本控制的文件不能加入 changelist，请先将其添加到版本控制（svn add）');
                return;
            }

            await this.svnService.setChangelist(eligible, name);
            if (skipped > 0) {
                vscode.window.showInformationMessage(`已将 ${eligible.length} 个文件加入 changelist「${name}」（${skipped} 个未版本控制的文件已跳过）`);
            } else {
                vscode.window.showInformationMessage(`已将 ${eligible.length} 个文件加入 changelist「${name}」`);
            }
            await this._update();
        } catch (error: any) {
            vscode.window.showErrorMessage(`加入 changelist 失败: ${error.message}`);
        }
    }

    /**
     * 将选中的文件移出 changelist（issue #21）
     */
    private async _removeFromChangelist(filePaths: string[]): Promise<void> {
        try {
            if (filePaths.length === 0) {
                vscode.window.showInformationMessage('请先勾选要操作的文件');
                return;
            }

            await this.svnService.removeFromChangelist(filePaths);
            vscode.window.showInformationMessage(`已将 ${filePaths.length} 个文件移出 changelist`);
            await this._update();
        } catch (error: any) {
            vscode.window.showErrorMessage(`移出 changelist 失败: ${error.message}`);
        }
    }

    private _getStatusText(status: string): string {
        switch (status) {
            case 'M': return '已修改';
            case 'A': return '新增';
            case 'D': return '已删除';
            case '?': return '未版本控制';
            case '!': return '丢失';
            case 'C': return '冲突';
            case 'X': return '外部定义';
            case 'I': return '已忽略';
            case '~': return '类型变更';
            case 'R': return '已替换';
            default: return `未知状态(${status})`;
        }
    }

    private async _showFileDiff(filePath: string) {
        // 创建新的webview面板显示文件差异
        const diffPanel = vscode.window.createWebviewPanel(
            'svnFileDiff',
            `文件差异: ${path.basename(filePath)}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        const diff = await this.diffProvider.getDiff(filePath);
        diffPanel.webview.html = this._getHtmlForDiffView(filePath, diff);
    }

    private async _commitFiles(files: string[], message: string) {
        try {
            this.outputChannel.appendLine(`\n========== 开始批量提交操作 ==========`);
            this.outputChannel.appendLine(`[_commitFiles] 提交信息: ${message}`);
            this.outputChannel.appendLine(`[_commitFiles] 选中文件总数: ${files.length}`);
            this.outputChannel.appendLine(`[_commitFiles] 文件列表:`);
            files.forEach((file, index) => {
                this.outputChannel.appendLine(`  ${index + 1}. ${file}`);
            });

            if (files.length === 0) {
                throw new Error('请选择要提交的文件');
            }

            // 分类文件状态
            const unversionedFiles: string[] = [];
            const missingFiles: string[] = [];
            const regularFiles: string[] = [];
            
            this.outputChannel.appendLine(`\n[_commitFiles] 开始分类文件状态...`);
            files.forEach(file => {
                const fileStatus = this._fileStatuses.find(f => f.path === file);
                this.outputChannel.appendLine(`[_commitFiles] 处理文件: ${file}`);
                this.outputChannel.appendLine(`[_commitFiles] 文件状态: ${fileStatus ? `${fileStatus.status} (${fileStatus.type})` : '未找到状态'}`);
                
                if (fileStatus?.type === 'unversioned') {
                    unversionedFiles.push(file);
                    this.outputChannel.appendLine(`[_commitFiles] -> 归类为未版本控制文件`);
                } else if (fileStatus?.type === 'missing') {
                    missingFiles.push(file);
                    this.outputChannel.appendLine(`[_commitFiles] -> 归类为丢失文件`);
                } else {
                    regularFiles.push(file);
                    this.outputChannel.appendLine(`[_commitFiles] -> 归类为常规文件 (${fileStatus?.type || 'unknown'})`);
                }
            });

            this.outputChannel.appendLine(`\n[_commitFiles] 文件分类结果:`);
            this.outputChannel.appendLine(`  - 未版本控制文件: ${unversionedFiles.length} 个`);
            this.outputChannel.appendLine(`  - 丢失文件: ${missingFiles.length} 个`);
            this.outputChannel.appendLine(`  - 常规文件: ${regularFiles.length} 个`);

            // 批量添加未版本控制的文件（如果有的话）
            if (unversionedFiles.length > 0) {
                this.outputChannel.appendLine(`\n[_commitFiles] 开始批量添加 ${unversionedFiles.length} 个未版本控制的文件`);
                unversionedFiles.forEach((file, index) => {
                    this.outputChannel.appendLine(`  ${index + 1}. ${file}`);
                });
                await this._batchAddFiles(unversionedFiles);
                this.outputChannel.appendLine(`[_commitFiles] 批量添加操作完成`);
            }

            // 批量标记丢失的文件为删除状态（如果有的话）
            if (missingFiles.length > 0) {
                this.outputChannel.appendLine(`\n[_commitFiles] 开始批量标记 ${missingFiles.length} 个丢失的文件为删除状态`);
                missingFiles.forEach((file, index) => {
                    this.outputChannel.appendLine(`  ${index + 1}. ${file}`);
                });
                await this._batchRemoveFiles(missingFiles);
                this.outputChannel.appendLine(`[_commitFiles] 批量删除操作完成`);
            }

            // 分离文件和目录
            this.outputChannel.appendLine(`\n[_commitFiles] 开始分离文件和目录...`);
            const fileEntries = await Promise.all(files.map(async file => {
                // 检查文件是否是missing状态
                const fileStatus = this._fileStatuses.find(f => f.path === file);
                if (fileStatus?.type === 'missing') {
                    // missing文件已经不存在，视为文件（非目录）
                    this.outputChannel.appendLine(`[_commitFiles] ${file} -> missing文件，视为非目录`);
                    return { path: file, isDirectory: false };
                }
                
                try {
                    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(file))).type === vscode.FileType.Directory;
                    this.outputChannel.appendLine(`[_commitFiles] ${file} -> ${isDirectory ? '目录' : '文件'}`);
                    return { path: file, isDirectory };
                } catch (error) {
                    // 如果文件不存在，视为文件（非目录）
                    this.outputChannel.appendLine(`[_commitFiles] ${file} -> 文件不存在，视为非目录`);
                    return { path: file, isDirectory: false };
                }
            }));
            
            const onlyFiles = fileEntries.filter(entry => !entry.isDirectory).map(entry => entry.path);
            const directories = fileEntries.filter(entry => entry.isDirectory).map(entry => entry.path);
            
            this.outputChannel.appendLine(`[_commitFiles] 分离结果:`);
            this.outputChannel.appendLine(`  - 文件: ${onlyFiles.length} 个`);
            this.outputChannel.appendLine(`  - 目录: ${directories.length} 个`);
            
            // 一次性批量提交所有文件和目录
            this.outputChannel.appendLine(`\n[_commitFiles] 开始执行提交操作...`);
            this.outputChannel.appendLine(`[_commitFiles] 使用批量提交模式 (commitFiles)`);
            this.outputChannel.appendLine(`[_commitFiles] 批量提交内容:`);
            this.outputChannel.appendLine(`  - 文件: ${onlyFiles.length} 个`);
            this.outputChannel.appendLine(`  - 目录: ${directories.length} 个`);
            this.outputChannel.appendLine(`[_commitFiles] 批量提交列表:`);
            files.forEach((file, index) => {
                const isDir = directories.includes(file);
                this.outputChannel.appendLine(`  ${index + 1}. ${file} ${isDir ? '(目录)' : '(文件)'}`);
            });
            
            try {
                await this.svnService.commitFiles(files, message, this.folderPath);
                this.outputChannel.appendLine(`[_commitFiles] ✅ 批量提交成功: ${files.length} 个项目`);
            } catch (error: any) {
                // 如果批量提交失败，回退到逐个提交
                this.outputChannel.appendLine(`[_commitFiles] ❌ 批量提交失败，回退到逐个提交模式`);
                this.outputChannel.appendLine(`[_commitFiles] 批量提交错误: ${error.message}`);
                
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    try {
                        this.outputChannel.appendLine(`[_commitFiles] 逐个提交第 ${i + 1}/${files.length} 个: ${file}`);
                        await this.svnService.commit(file, message);
                        this.outputChannel.appendLine(`[_commitFiles] 第 ${i + 1} 个项目提交成功`);
                    } catch (commitError: any) {
                        this.outputChannel.appendLine(`[_commitFiles] ❌ 第 ${i + 1} 个项目提交失败: ${file}`);
                        this.outputChannel.appendLine(`[_commitFiles] 错误信息: ${commitError.message}`);
                        throw commitError;
                    }
                }
                this.outputChannel.appendLine(`[_commitFiles] ✅ 逐个提交完成: ${files.length} 个项目`);
            }

            // 保存提交日志
            this.outputChannel.appendLine(`\n[_commitFiles] 保存提交日志到本地存储`);
            this.logStorage.addLog(message, this.folderPath);

            this.outputChannel.appendLine(`[_commitFiles] 提交操作全部完成`);
            this.outputChannel.appendLine(`========== 批量提交操作结束 ==========\n`);
            vscode.window.showInformationMessage('文件已成功提交到SVN');
            this._panel.dispose();
        } catch (error: any) {
            this.outputChannel.appendLine(`\n[_commitFiles] ❌ 提交操作发生错误:`);
            this.outputChannel.appendLine(`[_commitFiles] 错误类型: ${error.constructor.name}`);
            this.outputChannel.appendLine(`[_commitFiles] 错误信息: ${error.message}`);
            this.outputChannel.appendLine(`[_commitFiles] 错误堆栈: ${error.stack || '无堆栈信息'}`);
            this.outputChannel.appendLine(`========== 批量提交操作失败 ==========\n`);
            vscode.window.showErrorMessage(`提交失败: ${error.message}`);
        }
    }

    private async _generateAICommitLog(): Promise<string> {
        try {
            // 获取选中的文件路径
            const selectedFilePaths = await new Promise<string[]>((resolve) => {
                const handler = this._panel.webview.onDidReceiveMessage(message => {
                    if (message.command === 'selectedFiles') {
                        handler.dispose();
                        resolve(message.files);
                    }
                });
                this._panel.webview.postMessage({ command: 'getSelectedFiles' });
            });

            if (!selectedFilePaths || selectedFilePaths.length === 0) {
                throw new Error('请选择要生成提交日志的文件');
            }

            // 获取所有选中文件的差异信息
            const fileStatusesAndDiffs = await Promise.all(
                selectedFilePaths.map(async (filePath) => {
                    const fileStatus = this._fileStatuses.find(f => f.path === filePath);
                    if (!fileStatus) {
                        return null;
                    }

                    // 对于新增和未版本控制的文件，不需要获取差异
                    if (fileStatus.type === 'added' || fileStatus.type === 'unversioned') {
                        return {
                            path: fileStatus.displayName,
                            status: fileStatus.status,
                            diff: `新文件: ${fileStatus.displayName}`
                        };
                    }

                    // 对于删除的文件和丢失的文件
                    if (fileStatus.type === 'deleted' || fileStatus.type === 'missing') {
                        return {
                            path: fileStatus.displayName,
                            status: fileStatus.status,
                            diff: `删除文件: ${fileStatus.displayName}`
                        };
                    }

                    // 获取文件差异
                    const diff = await this.diffProvider.getDiff(filePath);
                    return {
                        path: fileStatus.displayName,
                        status: fileStatus.status,
                        diff: diff
                    };
                })
            );

            // 过滤掉无效的结果
            const validDiffs = fileStatusesAndDiffs.filter(item => item !== null);

            if (validDiffs.length === 0) {
                throw new Error('没有可用的文件差异信息');
            }

            // 格式化差异信息
            const formattedDiffs = validDiffs.map(item => 
                `文件: ${item!.path} (${item!.status})\n${item!.diff}`
            ).join('\n\n');

            // 使用 AI 生成提交日志
            const commitMessage = await this.aiService.generateCommitMessage(formattedDiffs);

            this.outputChannel.appendLine(`[generateAICommitLog] 生成的提交日志: ${commitMessage}`);
            
            return commitMessage;
        } catch (error: any) {
            vscode.window.showErrorMessage(`生成AI提交日志失败: ${error.message}`);
            return '';
        }
    }

    private _setupMessageHandlers() {
        // 添加一个标志，表示 AI 生成是否正在进行中
        let isGeneratingAILog = false;

        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'commit':
                        await this._commitFiles(message.files, message.message);
                        return;
                    case 'showError':
                        // webview 前端校验的错误提示（此前该消息无人处理，提示被静默丢弃）
                        vscode.window.showErrorMessage(message.text || '未知错误');
                        return;
                    case 'showDiff':
                        await this._showFileDiff(message.file);
                        return;
                    case 'generateAILog':
                        // 如果已经在生成中，则不再重复调用
                        if (isGeneratingAILog) {
                            this.outputChannel.appendLine(`[generateAILog] 已有 AI 生成任务正在进行中，忽略此次请求`);
                            return;
                        }

                        try {
                            isGeneratingAILog = true;
                            this._panel.webview.postMessage({ command: 'setGeneratingStatus', status: true });
                            
                            // 生成 AI 日志
                            const aiLog = await this._generateAICommitLog();
                            
                            // 应用前缀
                            if (aiLog) {
                                const messageWithPrefix = await this._applyPrefix(aiLog);
                                this._panel.webview.postMessage({ 
                                    command: 'setCommitMessage', 
                                    message: messageWithPrefix 
                                });
                            }
                        } catch (error: any) {
                            vscode.window.showErrorMessage(`生成 AI 提交日志失败: ${error.message}`);
                        } finally {
                            isGeneratingAILog = false;
                            this._panel.webview.postMessage({ command: 'setGeneratingStatus', status: false });
                        }
                        return;
                    case 'savePrefix':
                        // 保存前缀到历史记录
                        this.logStorage.addPrefix(message.prefix);
                        return;
                    case 'selectedFiles':
                        // 处理选中的文件列表
                        return;
                    case 'showSideBySideDiff':
                        // 查找文件状态
                        const fileStatus = this._fileStatuses.find(f => f.path === message.file);
                        if (fileStatus && fileStatus.type === 'modified') {
                            // 如果是修改状态，显示左右对比
                            await this.diffProvider.showDiff(message.file);
                        } else {
                            // 其他状态，直接打开文件
                            const uri = vscode.Uri.file(message.file);
                            try {
                                await vscode.commands.executeCommand('vscode.open', uri);
                            } catch (error: any) {
                                vscode.window.showErrorMessage(`打开文件失败: ${error.message}`);
                            }
                        }
                        return;
                    case 'revertFile':
                        await this._revertFile(message.file);
                        return;
                    case 'revertFiles':
                        await this._revertFiles(message.files || []);
                        return;
                    case 'deleteFile':
                        await this._deleteFile(message.file);
                        return;
                    case 'deleteFiles':
                        await this._deleteFiles(message.files || []);
                        return;
                    case 'setChangelist':
                        await this._setChangelist(message.files || [], String(message.name || '').trim());
                        return;
                    case 'removeChangelist':
                        await this._removeFromChangelist(message.files || []);
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    private async _applyPrefix(commitMessage: string): Promise<string> {
        // 获取当前前缀
        const prefix = await new Promise<string>((resolve) => {
            const handler = this._panel.webview.onDidReceiveMessage(msg => {
                if (msg.command === 'currentPrefix') {
                    handler.dispose();
                    resolve(msg.prefix);
                }
            });
            this._panel.webview.postMessage({ command: 'getCurrentPrefix' });
        });
        
        // 如果有前缀，添加到提交日志前面
        const finalMessage = prefix.trim() 
            ? `${prefix.trim()}\n${commitMessage}`
            : commitMessage;

        return finalMessage;
    }

    private async _getHtmlForWebview(): Promise<string> {
        try {
            // 准备模板变量
            const templateVariables = {
                FILTER_INFO: this._renderFilterInfo(),
                FILE_LIST: this._renderFileList(this._fileStatuses),
                PREFIX_OPTIONS: this._renderPrefixOptions(),
                LATEST_PREFIX: this.logStorage.getLatestPrefix(),
                CHANGELIST_OPTIONS: this._renderChangelistOptions(),
                ALLOW_EMPTY_COMMIT_MESSAGE: vscode.workspace.getConfiguration('vscode-svn').get<boolean>('allowEmptyCommitMessage', false) ? 'true' : 'false'
            };

            // 使用内联模板（CSS 和 JS 内嵌在 HTML 中）
            return await this.templateManager.loadInlineTemplate('folderCommitPanel', templateVariables);
        } catch (error) {
            console.error('加载模板失败，使用备用模板:', error);
            // 如果模板加载失败，返回一个简单的备用模板
            return this._getFallbackHtml();
        }
    }

    private _getFallbackHtml(): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
                <style>
                    body { padding: 20px; font-family: var(--vscode-font-family); }
                    .error { color: var(--vscode-errorForeground); }
                </style>
            </head>
            <body>
                <div class="error">
                    <h2>模板加载失败</h2>
                    <p>无法加载文件夹提交面板模板，请检查模板文件是否存在。</p>
                </div>
            </body>
            </html>
        `;
    }

    private _renderFilterInfo(): string {
        const filterInfo = this._getFilterInfo();
        const hasExcluded = filterInfo.excludedFiles > 0;
        const cssClass = hasExcluded ? 'filter-info has-excluded' : 'filter-info';
        
        if (filterInfo.totalFiles === 0) {
            return `<div class="${cssClass}">📁 没有检测到文件变更</div>`;
        }
        
        if (hasExcluded) {
            return `<div class="${cssClass}">
                🔍 文件统计: 总共 ${filterInfo.totalFiles} 个文件，显示 ${filterInfo.filteredFiles} 个，
                <strong>排除了 ${filterInfo.excludedFiles} 个文件</strong>
                <br>💡 被排除的文件不会显示在列表中，也不会被提交到SVN
            </div>`;
        } else {
            return `<div class="${cssClass}">📊 显示 ${filterInfo.filteredFiles} 个文件</div>`;
        }
    }

    private _renderFileList(files: FileStatus[]): string {
        return files.map(file => {
            // 转义文件路径中的特殊字符
            const escapedPath = file.path
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
            
            const fileName = path.basename(file.displayName);
            const filePath = path.dirname(file.displayName);
            
            const escapedFileName = fileName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const escapedFilePath = filePath.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            // changelist 标记（issue #21）
            const escapedChangelist = file.changelist ? file.changelist.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';

            // 根据状态设置不同的样式类
            let statusClass = file.type;
            if (file.status.includes('冲突')) {
                statusClass = 'conflict';
            } else if (file.status.includes('丢失')) {
                statusClass = 'missing';
            }

            // 确定是否显示恢复按钮（只在文件是已修改、已删除或丢失状态时显示）
            const showRevertButton = file.type === 'modified' || file.type === 'deleted' || file.type === 'missing';
            // 确定是否显示删除按钮（已计划删除的文件无需再删除）
            const showDeleteButton = file.type !== 'deleted';

            return `
                <div class="file-item status-${statusClass}" 
                     data-path="${escapedPath}"
                     data-type="${file.type}"
                     ${file.changelist ? `data-changelist="${escapedChangelist}"` : ''}>
                    <span class="checkbox-cell">
                        <input type="checkbox" class="file-checkbox">
                    </span>
                    <span class="file-name" title="${escapedFileName}">${escapedFileName}</span>
                    <span class="file-path" title="${escapedFilePath}">${escapedFilePath}</span>
                    <span class="file-status" title="${file.status}${file.changelist ? ' | changelist: ' + escapedChangelist : ''}">${file.status}${file.changelist ? `<span class="changelist-badge" title="changelist: ${escapedChangelist}">🏷${escapedChangelist}</span>` : ''}</span>
                    <span class="file-action">
                        ${file.type !== 'deleted' && file.type !== 'missing' ? `
                            <button class="diff-button" title="查看内联差异">差异</button>
                            <button class="side-by-side-button" title="${file.type === 'modified' ? '查看左右对比' : '打开文件'}">${file.type === 'modified' ? '对比' : '打开'}</button>
                        ` : ''}
                        ${showRevertButton ? `
                            <button class="revert-button" title="恢复文件修改">恢复</button>
                        ` : ''}
                        ${showDeleteButton ? `
                            <button class="delete-button" title="${file.type === 'unversioned' ? '删除本地文件' : '从版本控制中删除文件'}">删除</button>
                        ` : ''}
                    </span>
                </div>
            `;
        }).join('');
    }

    private _renderPrefixOptions(): string {
        const prefixes = this.logStorage.getPrefixes();
        return prefixes.map(prefix =>
            `<option value="${prefix}">${prefix}</option>`
        ).join('');
    }

    /**
     * 渲染 changelist 筛选下拉选项（issue #21）
     * 值使用特殊标记：空=全部，__ungrouped__=未分组，其余为 changelist 名称
     */
    private _renderChangelistOptions(): string {
        const names = [...new Set(
            this._fileStatuses.map(f => f.changelist).filter((c): c is string => !!c)
        )].sort((a, b) => a.localeCompare(b));

        let html = '<option value="">全部文件</option>';
        if (names.length > 0) {
            html += `<option value="__ungrouped__">未分组 (${this._fileStatuses.filter(f => !f.changelist).length})</option>`;
            html += names.map(name => {
                const count = this._fileStatuses.filter(f => f.changelist === name).length;
                const escaped = name.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                return `<option value="${escaped}">${escaped} (${count})</option>`;
            }).join('');
        }
        return html;
    }

    private _getHtmlForDiffView(filePath: string, diff: string): string {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <style>
                    .diff-content {
                        font-family: monospace;
                        white-space: pre;
                        padding: 10px;
                    }
                    .diff-added { background-color: var(--vscode-diffEditor-insertedTextBackground); }
                    .diff-removed { background-color: var(--vscode-diffEditor-removedTextBackground); }
                </style>
            </head>
            <body>
                <h2>文件差异: ${path.basename(filePath)}</h2>
                <div class="diff-content">${this._formatDiff(diff)}</div>
            </body>
            </html>
        `;
    }

    private _formatDiff(diff: string): string {
        return diff
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .split('\n')
            .map(line => {
                if (line.startsWith('+')) {
                    return `<div class="diff-added">${line}</div>`;
                } else if (line.startsWith('-')) {
                    return `<div class="diff-removed">${line}</div>`;
                }
                return `<div>${line}</div>`;
            })
            .join('');
    }

    /**
     * 批量添加文件到SVN
     * @param files 要添加的文件路径数组
     */
    private async _batchAddFiles(files: string[]): Promise<void> {
        this.outputChannel.appendLine(`\n[_batchAddFiles] 开始批量添加操作`);
        this.outputChannel.appendLine(`[_batchAddFiles] 工作目录: ${this.folderPath}`);
        this.outputChannel.appendLine(`[_batchAddFiles] 要添加的文件数量: ${files.length}`);
        
        try {
            // 构建批量添加命令
            const workingDir = this.folderPath;
            this.outputChannel.appendLine(`[_batchAddFiles] 开始构建相对路径...`);
            
            const fileArgs = files.map((file, index) => {
                const relativePath = path.relative(workingDir, file);
                // 处理@符号转义
                const escapedPath = relativePath.includes('@') ? `${relativePath}@` : relativePath;
                const quotedPath = `"${escapedPath}"`;
                
                this.outputChannel.appendLine(`[_batchAddFiles] 文件 ${index + 1}: ${file}`);
                this.outputChannel.appendLine(`[_batchAddFiles]   -> 相对路径: ${relativePath}`);
                this.outputChannel.appendLine(`[_batchAddFiles]   -> 转义路径: ${escapedPath}`);
                this.outputChannel.appendLine(`[_batchAddFiles]   -> 最终参数: ${quotedPath}`);
                
                return quotedPath;
            }).join(' ');
            
            const command = `add ${fileArgs}`;
            this.outputChannel.appendLine(`[_batchAddFiles] 执行SVN命令: svn ${command}`);
            this.outputChannel.appendLine(`[_batchAddFiles] 工作目录: ${workingDir}`);
            
            await this.svnService.executeSvnCommand(command, workingDir);
            this.outputChannel.appendLine(`[_batchAddFiles] ✅ 批量添加成功: ${files.length} 个文件`);
        } catch (error: any) {
            // 如果批量添加失败，回退到逐个添加
            this.outputChannel.appendLine(`[_batchAddFiles] ❌ 批量添加失败，开始回退到逐个添加`);
            this.outputChannel.appendLine(`[_batchAddFiles] 批量添加错误: ${error.message}`);
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                try {
                    this.outputChannel.appendLine(`[_batchAddFiles] 逐个添加第 ${i + 1}/${files.length} 个文件: ${file}`);
                    await this.svnService.addFile(file);
                    this.outputChannel.appendLine(`[_batchAddFiles] 第 ${i + 1} 个文件添加成功`);
                } catch (addError: any) {
                    this.outputChannel.appendLine(`[_batchAddFiles] ❌ 第 ${i + 1} 个文件添加失败: ${file}`);
                    this.outputChannel.appendLine(`[_batchAddFiles] 错误信息: ${addError.message}`);
                    throw addError;
                }
            }
            this.outputChannel.appendLine(`[_batchAddFiles] ✅ 逐个添加完成: ${files.length} 个文件`);
        }
    }

    /**
     * 批量删除文件（标记为删除状态）
     * @param files 要删除的文件路径数组
     */
    private async _batchRemoveFiles(files: string[]): Promise<void> {
        this.outputChannel.appendLine(`\n[_batchRemoveFiles] 开始批量删除操作`);
        this.outputChannel.appendLine(`[_batchRemoveFiles] 工作目录: ${this.folderPath}`);
        this.outputChannel.appendLine(`[_batchRemoveFiles] 要删除的文件数量: ${files.length}`);
        
        try {
            // 构建批量删除命令
            const workingDir = this.folderPath;
            this.outputChannel.appendLine(`[_batchRemoveFiles] 开始构建相对路径...`);
            
            const fileArgs = files.map((file, index) => {
                const relativePath = path.relative(workingDir, file);
                // 处理@符号转义
                const escapedPath = relativePath.includes('@') ? `${relativePath}@` : relativePath;
                const quotedPath = `"${escapedPath}"`;
                
                this.outputChannel.appendLine(`[_batchRemoveFiles] 文件 ${index + 1}: ${file}`);
                this.outputChannel.appendLine(`[_batchRemoveFiles]   -> 相对路径: ${relativePath}`);
                this.outputChannel.appendLine(`[_batchRemoveFiles]   -> 转义路径: ${escapedPath}`);
                this.outputChannel.appendLine(`[_batchRemoveFiles]   -> 最终参数: ${quotedPath}`);
                
                return quotedPath;
            }).join(' ');
            
            const command = `remove ${fileArgs}`;
            this.outputChannel.appendLine(`[_batchRemoveFiles] 执行SVN命令: svn ${command}`);
            this.outputChannel.appendLine(`[_batchRemoveFiles] 工作目录: ${workingDir}`);
            
            await this.svnService.executeSvnCommand(command, workingDir);
            this.outputChannel.appendLine(`[_batchRemoveFiles] ✅ 批量删除成功: ${files.length} 个文件`);
        } catch (error: any) {
            // 如果批量删除失败，回退到逐个删除
            this.outputChannel.appendLine(`[_batchRemoveFiles] ❌ 批量删除失败，开始回退到逐个删除`);
            this.outputChannel.appendLine(`[_batchRemoveFiles] 批量删除错误: ${error.message}`);
            
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                try {
                    this.outputChannel.appendLine(`[_batchRemoveFiles] 逐个删除第 ${i + 1}/${files.length} 个文件: ${file}`);
                    await this.svnService.removeFile(file);
                    this.outputChannel.appendLine(`[_batchRemoveFiles] 第 ${i + 1} 个文件删除成功`);
                } catch (removeError: any) {
                    this.outputChannel.appendLine(`[_batchRemoveFiles] ❌ 第 ${i + 1} 个文件删除失败: ${file}`);
                    this.outputChannel.appendLine(`[_batchRemoveFiles] 错误信息: ${removeError.message}`);
                    throw removeError;
                }
            }
            this.outputChannel.appendLine(`[_batchRemoveFiles] ✅ 逐个删除完成: ${files.length} 个文件`);
        }
    }

    private async _revertFile(filePath: string): Promise<void> {
        await this._revertFiles([filePath]);
    }

    /**
     * 批量恢复文件（丢弃本地修改）
     */
    private async _revertFiles(filePaths: string[]): Promise<void> {
        try {
            if (filePaths.length === 0) {
                return;
            }
            const detail = filePaths.length <= 3
                ? filePaths.map(f => path.basename(f)).join('、')
                : `${path.basename(filePaths[0])} 等 ${filePaths.length} 个文件`;
            const result = await vscode.window.showWarningMessage(
                `确定要恢复「${detail}」的本地修改吗？此操作不可撤销。`,
                { modal: true },
                '确定恢复',
                '取消'
            );

            if (result === '确定恢复') {
                await this.svnService.revertFiles(filePaths);
                vscode.window.showInformationMessage(`已成功恢复 ${filePaths.length} 个文件`);
                // 刷新文件状态列表
                await this._update();
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`恢复文件失败: ${error.message}`);
        }
    }

    /**
     * 删除单个文件
     */
    private async _deleteFile(filePath: string): Promise<void> {
        await this._deleteFiles([filePath]);
    }

    /**
     * 批量删除文件
     * 版本控制中的文件执行 svn delete --force（同时删除本地文件）；
     * 未版本控制的文件直接移到系统回收站
     */
    private async _deleteFiles(filePaths: string[]): Promise<void> {
        try {
            if (filePaths.length === 0) {
                return;
            }

            // 分类：未版本控制的文件走本地删除，其余走 svn delete
            const unversionedFiles: string[] = [];
            const versionedFiles: string[] = [];
            filePaths.forEach(filePath => {
                const fileStatus = this._fileStatuses.find(f => f.path === filePath);
                if (fileStatus?.type === 'unversioned') {
                    unversionedFiles.push(filePath);
                } else {
                    versionedFiles.push(filePath);
                }
            });

            const detail = filePaths.length <= 3
                ? filePaths.map(f => path.basename(f)).join('、')
                : `${path.basename(filePaths[0])} 等 ${filePaths.length} 个文件`;
            const tips: string[] = [];
            if (versionedFiles.length > 0) {
                tips.push(`${versionedFiles.length} 个文件将从版本控制中删除（计划删除，提交后生效）`);
            }
            if (unversionedFiles.length > 0) {
                tips.push(`${unversionedFiles.length} 个未版本控制的文件将移到系统回收站`);
            }
            const result = await vscode.window.showWarningMessage(
                `确定要删除「${detail}」吗？\n${tips.join('；')}。`,
                { modal: true, detail: '删除操作会连同本地文件一起删除（未版本控制文件移入回收站）。' },
                '确定删除',
                '取消'
            );

            if (result !== '确定删除') {
                return;
            }

            if (versionedFiles.length > 0) {
                await this.svnService.removeFiles(versionedFiles);
            }
            if (unversionedFiles.length > 0) {
                for (const filePath of unversionedFiles) {
                    await vscode.workspace.fs.delete(vscode.Uri.file(filePath), { useTrash: true });
                }
            }

            vscode.window.showInformationMessage(`已成功删除 ${filePaths.length} 个文件`);
            // 刷新文件状态列表
            await this._update();
        } catch (error: any) {
            vscode.window.showErrorMessage(`删除文件失败: ${error.message}`);
        }
    }

    public dispose() {
        SvnFolderCommitPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const disposable = this._disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
} 