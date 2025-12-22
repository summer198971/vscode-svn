import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';
import { SvnDiffProvider } from './diffProvider';
import { SvnCommitPanel } from './commitPanel';
import { SvnUpdatePanel } from './updatePanel';
import { CommitLogStorage } from './commitLogStorage';
import { SvnFolderCommitPanel } from './folderCommitPanel';
import { SvnLogPanel } from './svnLogPanel';
import { SvnFilterService } from './filterService';
import { AiCacheService } from './aiCacheService';
import { AiService } from './aiService';
import { SvnCheckoutPanel } from './checkoutPanel';
import { SvnCheckoutConfigPanel } from './checkoutConfigPanel';
import { SvnAuthService } from './svnAuthService';
import { SvnAuthDialog } from './svnAuthDialog';
import { SvnConflictPanel } from './conflictPanel';

// SVN服务实例
let svnService: SvnService;
let diffProvider: SvnDiffProvider;
let logStorage: CommitLogStorage;
let filterService: SvnFilterService;

/**
 * 上传文件到SVN
 * @param filePath 文件路径
 */
async function uploadFileToSvn(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 获取文件状态
    const status = await svnService.getFileStatus(filePath);
    
    // 如果文件未在版本控制下，先添加到SVN
    if (status === '未版本控制') {
      await svnService.addFile(filePath);
      vscode.window.showInformationMessage(`文件已添加到SVN`);
    }
    
    // 提交文件
    const commitMessage = await vscode.window.showInputBox({
      prompt: '请输入提交信息',
      placeHolder: '描述您所做的更改'
    });
    
    if (commitMessage === undefined) {
      // 用户取消了操作
      return;
    }
    
    await svnService.commit(filePath, commitMessage);
    vscode.window.showInformationMessage(`文件已成功上传到SVN`);
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN上传失败: ${error.message}`);
  }
}

/**
 * 上传文件夹到SVN
 * @param folderPath 文件夹路径
 */
async function uploadFolderToSvn(folderPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中。');
      return;
    }

    // 检查文件夹是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(folderPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件夹不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );

      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(folderPath)) {
          vscode.window.showErrorMessage('文件夹仍不在SVN工作副本中，请检查设置的路径是否正确。');
          return;
        }
      } else {
        return;
      }
    }

    // 显示文件夹提交面板
    await SvnFolderCommitPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      folderPath,
      svnService,
      diffProvider,
      logStorage
    );
  } catch (error: any) {
    vscode.window.showErrorMessage('上传文件夹到SVN失败: ' + error.message);
  }
}

// 新UI界面和用户交互的占位函数
async function showFolderStatusUI(folderPath: string, fileStatuses: string[]): Promise<void> {
  // 需要实现显示文件夹状态的UI界面
  return Promise.resolve();
}

async function getUserCommitChoices(): Promise<{ selectedFiles: string[], commitMessage: string }> {
  // 需要实现获取用户的文件选择和提交信息的功能
  return Promise.resolve({ selectedFiles: [], commitMessage: '' });
}

/**
 * 提交文件到SVN（显示差异）
 * @param filePath 文件路径
 */
async function commitFileWithDiff(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 获取文件状态
    const status = await svnService.getFileStatus(filePath);
    
    // 如果文件未在版本控制下，先添加到SVN
    if (status === '未版本控制') {
      const addToSvn = await vscode.window.showQuickPick(['是', '否'], {
        placeHolder: '文件未在SVN版本控制下，是否添加到SVN？'
      });
      
      if (addToSvn === '是') {
        await svnService.addFile(filePath);
        vscode.window.showInformationMessage(`文件已添加到SVN`);
      } else {
        return;
      }
    }
    
    // 显示提交面板
    await SvnCommitPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      filePath,
      svnService,
      diffProvider,
      logStorage
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 设置SVN工作副本根目录
 * @param folderUri 文件夹URI（可选）
 */
async function setSvnWorkingCopyRoot(folderUri?: vscode.Uri): Promise<void> {
  try {
    let svnRootPath: string | undefined;
    
    // 如果没有提供文件夹URI，则让用户选择
    if (!folderUri) {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: '选择SVN工作副本根目录',
        title: '选择包含.svn目录的SVN工作副本根目录'
      });
      
      if (!folders || folders.length === 0) {
        return;
      }
      
      svnRootPath = folders[0].fsPath;
    } else {
      svnRootPath = folderUri.fsPath;
    }
    
    // 设置自定义SVN工作副本路径
    const success = await svnService.setCustomSvnRoot(svnRootPath);
    
    if (success) {
      vscode.window.showInformationMessage(`已成功设置SVN工作副本路径: ${svnRootPath}`);
    } else {
      vscode.window.showErrorMessage(`设置SVN工作副本路径失败，请确保选择的目录是有效的SVN工作副本（包含.svn目录）`);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`设置SVN工作副本路径失败: ${error.message}`);
  }
}

/**
 * 清除SVN工作副本根目录设置
 */
async function clearSvnWorkingCopyRoot(): Promise<void> {
  try {
    await svnService.clearCustomSvnRoot();
    vscode.window.showInformationMessage('已清除SVN工作副本路径设置');
  } catch (error: any) {
    vscode.window.showErrorMessage(`清除SVN工作副本路径设置失败: ${error.message}`);
  }
}

/**
 * 更新文件
 * @param filePath 文件路径
 */
async function updateFile(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 检查文件是否有本地修改
    const status = await svnService.getFileStatus(filePath);
    if (status !== '无修改' && status !== '未知状态') {
      const result = await vscode.window.showWarningMessage(
        `文件有本地修改 (${status})，更新可能会导致冲突。是否继续？`,
        '继续',
        '取消'
      );
      
      if (result !== '继续') {
        return;
      }
    }
    
    // 更新文件
    await svnService.update(filePath);
    vscode.window.showInformationMessage(`文件已成功更新`);
    
    // 刷新编辑器内容
    const documents = vscode.workspace.textDocuments;
    for (const doc of documents) {
      if (doc.uri.fsPath === filePath) {
        // 如果文件已打开，重新加载内容
        const edit = new vscode.WorkspaceEdit();
        const content = await vscode.workspace.fs.readFile(doc.uri);
        const text = Buffer.from(content).toString('utf8');
        
        edit.replace(
          doc.uri,
          new vscode.Range(
            new vscode.Position(0, 0),
            doc.lineAt(doc.lineCount - 1).range.end
          ),
          text
        );
        
        await vscode.workspace.applyEdit(edit);
        break;
      }
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN更新失败: ${error.message}`);
  }
}

/**
 * 更新目录或工作区
 * @param fsPath 文件系统路径
 */
async function updateDirectory(fsPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查目录是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(fsPath)) {
      const result = await vscode.window.showErrorMessage(
        '该目录不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(fsPath)) {
          vscode.window.showErrorMessage('目录仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 显示更新面板
    await SvnUpdatePanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      fsPath,
      svnService
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN更新失败: ${error.message}`);
  }
}

/**
 * 恢复文件到版本库状态
 * @param filePath 文件路径
 */
async function revertFile(filePath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(filePath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(filePath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 获取文件状态
    const status = await svnService.getFileStatus(filePath);
    
    // 如果文件未修改，提示用户
    if (status === '正常') {
      vscode.window.showInformationMessage('文件未修改，无需恢复');
      return;
    }

    // 确认是否要恢复文件
    const confirm = await vscode.window.showWarningMessage(
      '确定要恢复文件到版本库状态吗？这将丢失所有本地修改。',
      '确定',
      '取消'
    );

    if (confirm !== '确定') {
      return;
    }

    // 恢复文件
    await svnService.revertFile(filePath);
    vscode.window.showInformationMessage('文件已成功恢复到版本库状态');
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 恢复文件夹到版本库状态
 * @param folderPath 文件夹路径
 */
async function revertFolder(folderPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件夹是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(folderPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件夹不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(folderPath)) {
          vscode.window.showErrorMessage('文件夹仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 确认是否要恢复文件夹
    const confirm = await vscode.window.showWarningMessage(
      `确定要恢复文件夹 "${path.basename(folderPath)}" 及其所有子文件和子文件夹到版本库状态吗？这将丢失所有本地修改，此操作不可撤销。`,
      { modal: true },
      '确定',
      '取消'
    );

    if (confirm !== '确定') {
      return;
    }

    // 恢复文件夹
    await svnService.revertFolder(folderPath);
    vscode.window.showInformationMessage('文件夹已成功恢复到版本库状态');
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 查看SVN日志
 * @param fsPath 文件或文件夹路径
 */
async function viewSvnLog(fsPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(fsPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(fsPath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 打开SVN日志面板
    await SvnLogPanel.createOrShow(vscode.Uri.file(__dirname), fsPath, svnService);
  } catch (error: any) {
    vscode.window.showErrorMessage(`查看SVN日志失败: ${error.message}`);
  }
}

/**
 * 显示文件或文件夹的本地修订版本号
 * @param fsPath 文件或文件夹路径
 */
async function showLocalRevision(fsPath: string): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }
    
    // 检查文件是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(fsPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );
      
      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(fsPath)) {
          vscode.window.showErrorMessage('文件仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }
    
    // 获取SVN信息
    try {
      // 使用SVN info命令获取版本信息
      const infoCommand = `info --xml "${fsPath}"`;
      const infoXml = await svnService.executeSvnCommand(infoCommand, require('path').dirname(fsPath), false);
      
      // 从XML中提取版本号
      const revisionMatch = /<commit\s+revision="([^"]+)">/.exec(infoXml) || 
                           /<entry\s+[^>]*?revision="([^"]+)"/.exec(infoXml);
      
      if (revisionMatch && revisionMatch[1]) {
        const localRevision = revisionMatch[1];
        
        // 显示本地版本号
        vscode.window.showInformationMessage(`本地修订版本号: ${localRevision}`);
      } else {
        vscode.window.showInformationMessage('未能获取本地修订版本号');
      }
    } catch (error: any) {
      vscode.window.showErrorMessage(`获取SVN信息失败: ${error.message}`);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN操作失败: ${error.message}`);
  }
}

/**
 * 配置过滤规则
 */
async function configureFilter(): Promise<void> {
  try {
    const config = filterService.getExcludeConfig();
    
    // 显示配置选项
    const option = await vscode.window.showQuickPick([
      '配置排除文件模式',
      '配置排除文件夹',
      '查看当前配置',
      '重置为默认配置'
    ], {
      placeHolder: '选择要配置的选项'
    });
    
    if (!option) {
      return;
    }
    
    switch (option) {
      case '配置排除文件模式':
        await configureExcludeFiles();
        break;
      case '配置排除文件夹':
        await configureExcludeFolders();
        break;
      case '查看当前配置':
        filterService.showExcludeInfo();
        break;
      case '重置为默认配置':
        await resetFilterConfig();
        break;
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`配置过滤规则失败: ${error.message}`);
  }
}

/**
 * 配置排除文件模式
 */
async function configureExcludeFiles(): Promise<void> {
  const config = filterService.getExcludeConfig();
  const currentFiles = config.files.join(', ');
  
  const input = await vscode.window.showInputBox({
    prompt: '输入要排除的文件模式（支持glob模式，用逗号分隔）',
    value: currentFiles,
    placeHolder: '例如: *.log, *.tmp, node_modules, .DS_Store'
  });
  
  if (input !== undefined) {
    const files = input.split(',').map(f => f.trim()).filter(f => f.length > 0);
    await filterService.updateExcludeConfig(files, config.folders);
    vscode.window.showInformationMessage('文件排除模式已更新');
  }
}

/**
 * 配置排除文件夹
 */
async function configureExcludeFolders(): Promise<void> {
  const config = filterService.getExcludeConfig();
  const currentFolders = config.folders.join(', ');
  
  const input = await vscode.window.showInputBox({
    prompt: '输入要排除的文件夹名称（用逗号分隔）',
    value: currentFolders,
    placeHolder: '例如: node_modules, .git, .vscode, dist, build'
  });
  
  if (input !== undefined) {
    const folders = input.split(',').map(f => f.trim()).filter(f => f.length > 0);
    await filterService.updateExcludeConfig(config.files, folders);
    vscode.window.showInformationMessage('文件夹排除列表已更新');
  }
}

/**
 * 重置过滤配置为默认值
 */
async function resetFilterConfig(): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    '确定要重置过滤配置为默认值吗？',
    '确定',
    '取消'
  );
  
  if (confirm === '确定') {
    const defaultFiles = ['*.log', '*.tmp', 'node_modules', '.DS_Store', 'Thumbs.db'];
    const defaultFolders = ['node_modules', '.git', '.vscode', 'dist', 'build', 'out', 'target'];
    
    await filterService.updateExcludeConfig(defaultFiles, defaultFolders);
    vscode.window.showInformationMessage('过滤配置已重置为默认值');
  }
}

/**
 * 显示过滤信息
 */
async function showFilterInfo(): Promise<void> {
  filterService.showExcludeInfo();
}

/**
 * 显示AI缓存统计信息
 */
async function showAICacheStats(): Promise<void> {
  try {
    const cacheService = AiCacheService.getInstance();
    const stats = cacheService.getCacheStats();
    
    const message = `AI缓存统计信息:
    
📊 缓存条目数: ${stats.totalEntries}
💾 缓存文件大小: ${stats.cacheSize}
📅 最旧条目: ${stats.oldestEntry}
📅 最新条目: ${stats.newestEntry}

缓存位置: ~/.vscode-svn-ai-cache/
过期时间: 30天`;
    
    const action = await vscode.window.showInformationMessage(
      message,
      '清理过期缓存',
      '清空所有缓存',
      '关闭'
    );
    
    if (action === '清理过期缓存') {
      await cleanExpiredAICache();
    } else if (action === '清空所有缓存') {
      await clearAICache();
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`获取缓存统计失败: ${error.message}`);
  }
}

/**
 * 清空AI缓存
 */
async function clearAICache(): Promise<void> {
  try {
    const confirm = await vscode.window.showWarningMessage(
      '确定要清空所有AI分析缓存吗？这将删除所有已保存的分析结果。',
      '确定',
      '取消'
    );
    
    if (confirm === '确定') {
      const cacheService = AiCacheService.getInstance();
      cacheService.clearAllCache();
      vscode.window.showInformationMessage('AI缓存已清空');
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`清空缓存失败: ${error.message}`);
  }
}

/**
 * 清理过期AI缓存
 */
async function cleanExpiredAICache(): Promise<void> {
  try {
    const cacheService = AiCacheService.getInstance();
    const removedCount = cacheService.cleanExpiredCache();
    
    if (removedCount > 0) {
      vscode.window.showInformationMessage(`已清理 ${removedCount} 条过期缓存记录`);
    } else {
      vscode.window.showInformationMessage('没有发现过期的缓存记录');
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`清理过期缓存失败: ${error.message}`);
  }
}

/**
 * 配置AI服务
 */
async function configureAI(): Promise<void> {
  try {
    // 使用AI服务类的配置引导功能
    const aiService = new AiService();
    const result = await aiService.configureAI();
    
    if (result) {
      vscode.window.showInformationMessage(
        '🎉 AI服务配置完成！\n\n现在可以使用AI功能生成SVN提交日志了。',
        { modal: true }
      );
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`❌ 配置AI服务失败: ${error.message}`);
  }
}

/**
 * SVN检出功能
 * @param folderUri 文件夹URI（可选）
 */
async function checkoutFromSvn(folderUri?: vscode.Uri): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    // 确定检出目标目录
    let targetDirectory: string;
    if (folderUri) {
      targetDirectory = folderUri.fsPath;
    } else {
      // 如果没有选择文件夹，使用当前工作区
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        targetDirectory = vscode.workspace.workspaceFolders[0].uri.fsPath;
      } else {
        vscode.window.showErrorMessage('请选择一个文件夹或打开工作区');
        return;
      }
    }

    // 显示检出配置面板
    await SvnCheckoutConfigPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      targetDirectory,
      svnService
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`SVN检出失败: ${error.message}`);
  }
}

/**
 * 扫描并解决冲突
 * @param folderUri 文件夹URI（可选）
 */
async function scanAndResolveConflicts(folderUri?: vscode.Uri): Promise<void> {
  try {
    // 检查SVN是否已安装
    if (!await svnService.isSvnInstalled()) {
      vscode.window.showErrorMessage('未检测到SVN命令行工具，请确保已安装SVN并添加到系统PATH中');
      return;
    }

    // 确定文件夹路径
    let folderPath: string;
    if (folderUri) {
      folderPath = folderUri.fsPath;
    } else {
      // 如果没有选择文件夹，使用当前工作区
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
      } else {
        vscode.window.showErrorMessage('请选择一个文件夹或打开工作区');
        return;
      }
    }

    // 检查文件夹是否在SVN工作副本中
    if (!await svnService.isInWorkingCopy(folderPath)) {
      const result = await vscode.window.showErrorMessage(
        '该文件夹不在SVN工作副本中',
        '设置SVN工作副本路径',
        '取消'
      );

      if (result === '设置SVN工作副本路径') {
        await setSvnWorkingCopyRoot();
        // 重新检查
        if (!await svnService.isInWorkingCopy(folderPath)) {
          vscode.window.showErrorMessage('文件夹仍不在SVN工作副本中，请检查设置的路径是否正确');
          return;
        }
      } else {
        return;
      }
    }

    // 显示冲突处理面板
    await SvnConflictPanel.createOrShow(
      vscode.extensions.getExtension('vscode-svn')?.extensionUri || vscode.Uri.file(__dirname),
      folderPath,
      svnService
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(`扫描冲突失败: ${error.message}`);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('VSCode SVN 扩展已激活');
  
  // 初始化SVN服务
  svnService = new SvnService(context);
  diffProvider = new SvnDiffProvider(svnService);
  logStorage = new CommitLogStorage(context);
  filterService = new SvnFilterService();
  // AI缓存服务使用单例模式，无需在此初始化
  
  // 注册上传文件命令
  const uploadFileCommand = vscode.commands.registerCommand('vscode-svn.uploadFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能上传本地文件');
      return;
    }
    
    await uploadFileToSvn(fileUri.fsPath);
  });
  
  // 注册上传文件夹命令
  const uploadFolderCommand = vscode.commands.registerCommand('vscode-svn.uploadFolder', async (folderUri?: vscode.Uri) => {
    if (!folderUri) {
      // 如果没有通过右键菜单选择文件夹，则使用当前工作区文件夹
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有打开的工作区');
        return;
      }
    }
    
    if (folderUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能上传本地文件夹');
      return;
    }
    
    await uploadFolderToSvn(folderUri.fsPath);
  });
  
  // 注册提交文件命令（显示差异）
  const commitFileCommand = vscode.commands.registerCommand('vscode-svn.commitFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能提交本地文件');
      return;
    }
    
    await commitFileWithDiff(fileUri.fsPath);
  });
  
  // 注册设置SVN工作副本路径命令
  const setSvnRootCommand = vscode.commands.registerCommand('vscode-svn.setSvnRoot', async (folderUri?: vscode.Uri) => {
    await setSvnWorkingCopyRoot(folderUri);
  });
  
  // 注册清除SVN工作副本路径命令
  const clearSvnRootCommand = vscode.commands.registerCommand('vscode-svn.clearSvnRoot', async () => {
    await clearSvnWorkingCopyRoot();
  });
  
  // 注册更新文件命令
  const updateFileCommand = vscode.commands.registerCommand('vscode-svn.updateFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能更新本地文件');
      return;
    }
    
    await updateFile(fileUri.fsPath);
  });
  
  // 注册更新目录命令
  const updateDirectoryCommand = vscode.commands.registerCommand('vscode-svn.updateDirectory', async (folderUri?: vscode.Uri) => {
    if (!folderUri) {
      // 如果没有通过右键菜单选择文件夹，则使用当前工作区文件夹
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有打开的工作区');
        return;
      }
    }
    
    if (folderUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能更新本地文件夹');
      return;
    }
    
    await updateDirectory(folderUri.fsPath);
  });
  
  // 注册更新工作区命令
  const updateWorkspaceCommand = vscode.commands.registerCommand('vscode-svn.updateWorkspace', async () => {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
      vscode.window.showErrorMessage('没有打开的工作区');
      return;
    }
    
    // 使用第一个工作区文件夹
    const workspaceFolder = vscode.workspace.workspaceFolders[0];
    
    if (workspaceFolder.uri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能更新本地工作区');
      return;
    }
    
    await updateDirectory(workspaceFolder.uri.fsPath);
  });
  
  // 注册恢复文件命令
  const revertFileCommand = vscode.commands.registerCommand('vscode-svn.revertFile', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能恢复本地文件');
      return;
    }
    
    await revertFile(fileUri.fsPath);
  });

  // 注册恢复文件夹命令
  const revertFolderCommand = vscode.commands.registerCommand('vscode-svn.revertFolder', async (folderUri?: vscode.Uri) => {
    if (!folderUri) {
      // 如果没有通过右键菜单选择文件夹，则使用当前工作区文件夹
      if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        folderUri = vscode.workspace.workspaceFolders[0].uri;
      } else {
        vscode.window.showErrorMessage('没有打开的工作区');
        return;
      }
    }
    
    if (folderUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能恢复本地文件夹');
      return;
    }
    
    await revertFolder(folderUri.fsPath);
  });
  
  // 注册查看SVN日志命令
  const viewLogCommand = vscode.commands.registerCommand('vscode-svn.viewLog', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件或文件夹');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能查看本地文件或文件夹的SVN日志');
      return;
    }
    
    await viewSvnLog(fileUri.fsPath);
  });
  
  // 注册显示本地修订版本号命令
  const showLocalRevisionCommand = vscode.commands.registerCommand('vscode-svn.showLocalRevision', async (fileUri?: vscode.Uri) => {
    if (!fileUri) {
      // 如果没有通过右键菜单选择文件，则使用当前活动编辑器中的文件
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        fileUri = activeEditor.document.uri;
      } else {
        vscode.window.showErrorMessage('没有选择文件或文件夹');
        return;
      }
    }
    
    if (fileUri.scheme !== 'file') {
      vscode.window.showErrorMessage('只能查看本地文件或文件夹的本地修订版本号');
      return;
    }
    
    await showLocalRevision(fileUri.fsPath);
  });
  
  // 注册配置过滤规则命令
  const configureFilterCommand = vscode.commands.registerCommand('vscode-svn.configureFilter', async () => {
    await configureFilter();
  });
  
  // 注册显示过滤信息命令
  const showFilterInfoCommand = vscode.commands.registerCommand('vscode-svn.showFilterInfo', async () => {
    await showFilterInfo();
  });
  
  // 注册显示AI缓存统计命令
  const showAICacheStatsCommand = vscode.commands.registerCommand('vscode-svn.showAICacheStats', async () => {
    await showAICacheStats();
  });
  
  // 注册清空AI缓存命令
  const clearAICacheCommand = vscode.commands.registerCommand('vscode-svn.clearAICache', async () => {
    await clearAICache();
  });
  
  // 注册清理过期AI缓存命令
  const cleanExpiredAICacheCommand = vscode.commands.registerCommand('vscode-svn.cleanExpiredAICache', async () => {
    await cleanExpiredAICache();
  });
  
  // 注册配置AI服务命令
  const configureAICommand = vscode.commands.registerCommand('vscode-svn.configureAI', async () => {
    await configureAI();
  });
  
  // 注册SVN检出命令
  const checkoutCommand = vscode.commands.registerCommand('vscode-svn.checkout', async (folderUri?: vscode.Uri) => {
    await checkoutFromSvn(folderUri);
  });

  // 认证管理命令
  const manageCredentialsCommand = vscode.commands.registerCommand('vscode-svn.manageCredentials', async () => {
    await manageCredentials(context);
  });

  const clearCredentialsCommand = vscode.commands.registerCommand('vscode-svn.clearCredentials', async () => {
    await clearCredentials(context);
  });

  // 注册扫描并解决冲突命令
  const scanAndResolveConflictsCommand = vscode.commands.registerCommand('vscode-svn.scanAndResolveConflicts', async (folderUri?: vscode.Uri) => {
    await scanAndResolveConflicts(folderUri);
  });
  
  context.subscriptions.push(
    uploadFileCommand,
    uploadFolderCommand,
    commitFileCommand,
    setSvnRootCommand,
    clearSvnRootCommand,
    updateFileCommand,
    updateDirectoryCommand,
    updateWorkspaceCommand,
    revertFileCommand,
    revertFolderCommand,
    viewLogCommand,
    showLocalRevisionCommand,
    configureFilterCommand,
    showFilterInfoCommand,
    showAICacheStatsCommand,
    clearAICacheCommand,
    cleanExpiredAICacheCommand,
    configureAICommand,
    checkoutCommand,
    manageCredentialsCommand,
    clearCredentialsCommand,
    scanAndResolveConflictsCommand
  );
}

/**
 * 管理SVN认证信息
 */
async function manageCredentials(context: vscode.ExtensionContext): Promise<void> {
  try {
    const authService = new SvnAuthService(context);
    const credentials = await authService.getAllCredentials();
    
    // 创建认证管理面板
    const panel = SvnAuthDialog.createAuthManagementPanel(
      context.extensionUri,
      credentials
    );
    
    // 处理来自webview的消息
    panel.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
        case 'testCredential':
          try {
            const credential = credentials[message.url];
            if (credential) {
              const result = await authService.validateCredential(
                message.url,
                credential.username,
                credential.password
              );
              
              panel.webview.postMessage({
                command: 'testResult',
                url: message.url,
                success: result.valid,
                message: result.valid ? '认证信息有效' : result.error
              });
            }
          } catch (error: any) {
            panel.webview.postMessage({
              command: 'testResult',
              url: message.url,
              success: false,
              message: `测试失败: ${error.message}`
            });
          }
          break;
          
        case 'deleteCredential':
          try {
            await authService.removeCredential(message.url);
            vscode.window.showInformationMessage('认证信息已删除');
            // 刷新面板
            const updatedCredentials = await authService.getAllCredentials();
            panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
              context.extensionUri,
              updatedCredentials
            ).webview.html;
          } catch (error: any) {
            vscode.window.showErrorMessage(`删除失败: ${error.message}`);
          }
          break;
          
        case 'clearAllCredentials':
          try {
            await authService.clearAllCredentials();
            vscode.window.showInformationMessage('所有认证信息已清除');
            // 刷新面板
            panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
              context.extensionUri,
              {}
            ).webview.html;
          } catch (error: any) {
            vscode.window.showErrorMessage(`清除失败: ${error.message}`);
          }
          break;
          
        case 'addCredential':
          // 显示添加认证信息对话框
          const authResult = await SvnAuthDialog.showAuthDialog('手动添加');
          if (authResult) {
            const url = await vscode.window.showInputBox({
              prompt: '请输入SVN仓库URL',
              placeHolder: 'http://svn.example.com/repo',
              validateInput: (value) => {
                if (!value || value.trim() === '') {
                  return 'URL不能为空';
                }
                return null;
              }
            });
            
            if (url) {
              try {
                await authService.saveCredential(
                  url.trim(),
                  authResult.username,
                  authResult.password,
                  '手动添加'
                );
                vscode.window.showInformationMessage('认证信息已保存');
                // 刷新面板
                const updatedCredentials = await authService.getAllCredentials();
                panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
                  context.extensionUri,
                  updatedCredentials
                ).webview.html;
              } catch (error: any) {
                vscode.window.showErrorMessage(`保存失败: ${error.message}`);
              }
            }
          }
          break;
          
        case 'refreshCredentials':
          // 刷新认证信息列表
          const refreshedCredentials = await authService.getAllCredentials();
          panel.webview.html = SvnAuthDialog.createAuthManagementPanel(
            context.extensionUri,
            refreshedCredentials
          ).webview.html;
          break;
      }
    });
    
  } catch (error: any) {
    vscode.window.showErrorMessage(`打开认证管理面板失败: ${error.message}`);
  }
}

/**
 * 清除所有SVN认证信息
 */
async function clearCredentials(context: vscode.ExtensionContext): Promise<void> {
  try {
    const choice = await vscode.window.showWarningMessage(
      '确认清除所有保存的SVN认证信息？此操作不可恢复！',
      '确认清除',
      '取消'
    );
    
    if (choice === '确认清除') {
      const authService = new SvnAuthService(context);
      await authService.clearAllCredentials();
      vscode.window.showInformationMessage('所有SVN认证信息已清除');
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(`清除认证信息失败: ${error.message}`);
  }
}

export function deactivate() {
  console.log('VSCode SVN 扩展已停用');
  
  // 释放AI缓存服务单例
  AiCacheService.destroyInstance();
} 