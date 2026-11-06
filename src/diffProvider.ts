import * as vscode from 'vscode';
import * as path from 'path';
import { SvnService } from './svnService';

/**
 * SVN差异提供器，处理文件差异的显示和编码问题
 */
export class SvnDiffProvider {
  private outputChannel: vscode.OutputChannel;
  private svnService: SvnService;

  constructor(svnService: SvnService) {
    this.svnService = svnService;
    this.outputChannel = vscode.window.createOutputChannel('SVN差异');
  }

  /**
   * 获取编码配置
   * @returns 编码配置对象
   */
  private getEncodingConfig() {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    return {
      defaultFileEncoding: config.get<string>('defaultFileEncoding', 'auto'),
      forceUtf8Output: config.get<boolean>('forceUtf8Output', true),
      enableEncodingDetection: config.get<boolean>('enableEncodingDetection', true),
      encodingFallbacks: config.get<string[]>('encodingFallbacks', ['utf8', 'gbk', 'gb2312', 'big5']),
      showEncodingInfo: config.get<boolean>('showEncodingInfo', false)
    };
  }

  /**
   * 读取文件内容并处理编码
   * @param filePath 文件路径
   * @returns 文件内容
   */
  private async readFileWithEncoding(filePath: string): Promise<{ content: string, encoding: string }> {
    try {
      const fs = require('fs');
      const buffer = fs.readFileSync(filePath);
      
      // 检测编码
      const encoding = this.detectFileEncoding(buffer);
      this.outputChannel.appendLine(`[readFileWithEncoding] 检测到文件编码: ${encoding}`);
      
      // 根据检测到的编码读取文件
      let content: string;
      if (encoding === 'utf8' || encoding === 'utf8-bom') {
        content = buffer.toString('utf8');
        // 移除BOM
        if (encoding === 'utf8-bom' && content.charCodeAt(0) === 0xFEFF) {
          content = content.slice(1);
        }
      } else {
        // 对于其他编码，尝试转换为UTF-8
        content = this.convertBufferToUtf8(buffer, encoding);
      }
      
      return { content, encoding };
    } catch (error: any) {
      this.outputChannel.appendLine(`[readFileWithEncoding] 读取文件失败: ${error.message}`);
      // 回退到VSCode的默认方式
      const uri = vscode.Uri.file(filePath);
      const fileContent = await vscode.workspace.fs.readFile(uri);
      return { 
        content: Buffer.from(fileContent).toString('utf8'), 
        encoding: 'utf8' 
      };
    }
  }

  /**
   * 检测文件编码
   * @param buffer 文件缓冲区
   * @returns 编码类型
   */
  private detectFileEncoding(buffer: Buffer): string {
    const config = this.getEncodingConfig();
    
    // 如果禁用了编码检测，直接使用默认编码
    if (!config.enableEncodingDetection) {
      return config.defaultFileEncoding === 'auto' ? 'utf8' : config.defaultFileEncoding;
    }
    
    // 如果指定了非auto编码，直接使用
    if (config.defaultFileEncoding !== 'auto') {
      this.outputChannel.appendLine(`[detectFileEncoding] 使用配置的默认编码: ${config.defaultFileEncoding}`);
      return config.defaultFileEncoding;
    }

    // 检测BOM
    if (buffer.length >= 3) {
      if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        return 'utf8-bom';
      }
    }
    
    if (buffer.length >= 2) {
      if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        return 'utf16le';
      }
      if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
        return 'utf16be';
      }
    }
    
    // 尝试UTF-8解析
    try {
      const text = buffer.toString('utf8');
      if (!text.includes('\uFFFD')) {
        return 'utf8';
      }
    } catch {}
    
    // 检测中文编码
    return this.detectChineseEncoding(buffer);
  }

  /**
   * 检测中文编码
   * @param buffer 文件缓冲区
   * @returns 编码类型
   */
  private detectChineseEncoding(buffer: Buffer): string {
    const config = this.getEncodingConfig();
    const encodings = config.encodingFallbacks;
    
    for (const encoding of encodings) {
      try {
        const text = buffer.toString(encoding as BufferEncoding);
        // 检查是否包含中文字符且没有乱码
        if (/[\u4e00-\u9fff]/.test(text) && !text.includes('\uFFFD')) {
          return encoding;
        }
      } catch {
        continue;
      }
    }
    
    return 'utf8'; // 默认返回UTF-8
  }

  /**
   * 将缓冲区转换为UTF-8字符串
   * @param buffer 源缓冲区
   * @param sourceEncoding 源编码
   * @returns UTF-8字符串
   */
  private convertBufferToUtf8(buffer: Buffer, sourceEncoding: string): string {
    try {
      if (sourceEncoding === 'utf8' || sourceEncoding === 'utf8-bom') {
        return buffer.toString('utf8');
      }
      
      // 对于其他编码，先解码再编码为UTF-8
      const text = buffer.toString(sourceEncoding as BufferEncoding);
      return Buffer.from(text, sourceEncoding as BufferEncoding).toString('utf8');
    } catch (error) {
      this.outputChannel.appendLine(`[convertBufferToUtf8] 编码转换失败: ${error}`);
      // 回退到默认UTF-8
      return buffer.toString('utf8');
    }
  }

  /**
   * 获取文件与SVN版本的差异
   * @param filePath 文件路径
   * @returns 差异内容
   */
  public async getDiff(filePath: string): Promise<string> {
    this.outputChannel.appendLine(`\n[getDiff] 开始获取文件差异: ${filePath}`);
    this.outputChannel.show(true);
    
    try {
      const cwd = path.dirname(filePath);
      const fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`[getDiff] 工作目录: ${cwd}`);
      this.outputChannel.appendLine(`[getDiff] 文件名: ${fileName}`);
      
      // 尝试获取文件状态
      try {
        const status = await this.svnService.getFileStatus(filePath);
        this.outputChannel.appendLine(`[getDiff] 文件SVN状态: ${status}`);
      } catch (statusError: any) {
        this.outputChannel.appendLine(`[getDiff] 获取文件状态失败: ${statusError.message}`);
      }
      
      // 使用增强的SVN diff命令
      this.outputChannel.appendLine(`[getDiff] 执行SVN差异命令...`);
      
      // 构建diff命令，增加编码支持参数
      const diffCommand = `diff "${fileName}" --force --internal-diff -x "--ignore-space-change --ignore-eol-style"`;
      this.outputChannel.appendLine(`[getDiff] 命令: svn ${diffCommand}`);
      
      try {
        // 使用增强的SVN服务执行命令
        const diffResult = await this.svnService.executeSvnCommand(diffCommand, cwd, false);
        
        this.outputChannel.appendLine(`[getDiff] 差异命令执行成功，结果长度: ${diffResult.length} 字节`);
        if (diffResult.length > 0) {
          this.outputChannel.appendLine(`[getDiff] 差异内容前100个字符: ${diffResult.substring(0, 100).replace(/\n/g, '\\n')}`);
          return diffResult;
        } else {
          this.outputChannel.appendLine(`[getDiff] 差异结果为空，尝试内容比较方法`);
          return await this.getContentComparison(filePath, fileName, cwd);
        }
      } catch (diffError: any) {
        this.outputChannel.appendLine(`[getDiff] SVN diff命令失败: ${diffError.message}`);
        return await this.getContentComparison(filePath, fileName, cwd);
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[getDiff] 错误: ${error.message}`);
      this.outputChannel.appendLine(`[getDiff] 尝试备用方法...`);
      
      return await this.getFallbackDiff(filePath);
    }
  }

  /**
   * 通过内容比较获取差异
   * @param filePath 文件路径
   * @param fileName 文件名
   * @param cwd 工作目录
   * @returns 差异内容
   */
  private async getContentComparison(filePath: string, fileName: string, cwd: string): Promise<string> {
    try {
      this.outputChannel.appendLine(`[getContentComparison] 开始内容比较`);
      
      // 获取当前文件内容（处理编码）
      const { content: currentContent, encoding: currentEncoding } = await this.readFileWithEncoding(filePath);
      this.outputChannel.appendLine(`[getContentComparison] 当前文件编码: ${currentEncoding}, 长度: ${currentContent.length} 字符`);
      
      // 获取SVN版本内容
      this.outputChannel.appendLine(`[getContentComparison] 获取SVN版本内容...`);
      const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd, false);
      this.outputChannel.appendLine(`[getContentComparison] SVN版本内容长度: ${baseContent.length} 字符`);
      
      // 比较内容
      const isDifferent = currentContent !== baseContent;
      this.outputChannel.appendLine(`[getContentComparison] 内容比较结果: ${isDifferent ? '不同' : '相同'}`);
      
      if (isDifferent) {
        // 创建自定义差异显示
        return this.createCustomDiff(fileName, baseContent, currentContent, currentEncoding);
      } else {
        return `文件内容与SVN版本相同，没有检测到差异。`;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[getContentComparison] 内容比较失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 创建自定义差异显示
   * @param fileName 文件名
   * @param baseContent SVN版本内容
   * @param currentContent 当前内容
   * @param encoding 当前文件编码
   * @returns 差异显示字符串
   */
  private createCustomDiff(fileName: string, baseContent: string, currentContent: string, encoding: string): string {
    try {
      // 使用系统diff命令创建详细差异
      const tempDir = require('os').tmpdir();
      const fs = require('fs');
      const path = require('path');
      const { promisify } = require('util');
      const exec = promisify(require('child_process').exec);
      
      const baseFilePath = path.join(tempDir, `svn_base_${fileName}`);
      const currentFilePath = path.join(tempDir, `svn_current_${fileName}`);
      
      // 写入临时文件（确保UTF-8编码）
      fs.writeFileSync(baseFilePath, baseContent, 'utf8');
      fs.writeFileSync(currentFilePath, currentContent, 'utf8');
      
      return exec(`diff -u "${baseFilePath}" "${currentFilePath}"`, { 
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8'
      }).then((result: any) => {
        // 清理临时文件
        try { fs.unlinkSync(baseFilePath); } catch {}
        try { fs.unlinkSync(currentFilePath); } catch {}
        
        if (result.stdout) {
          return this.processDiffOutput(result.stdout, fileName, encoding);
        } else {
          return this.createSimpleDiff(fileName, baseContent, currentContent, encoding);
        }
      }).catch((diffError: any) => {
        // 清理临时文件
        try { fs.unlinkSync(baseFilePath); } catch {}
        try { fs.unlinkSync(currentFilePath); } catch {}
        
        // diff命令失败时，diffError.stdout可能仍包含有效的差异输出
        if (diffError.stdout) {
          return this.processDiffOutput(diffError.stdout, fileName, encoding);
        } else {
          return this.createSimpleDiff(fileName, baseContent, currentContent, encoding);
        }
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[createCustomDiff] 创建自定义差异失败: ${error.message}`);
      return this.createSimpleDiff(fileName, baseContent, currentContent, encoding);
    }
  }

  /**
   * 处理diff输出
   * @param diffOutput diff命令输出
   * @param fileName 文件名
   * @param encoding 文件编码
   * @returns 处理后的差异
   */
  private processDiffOutput(diffOutput: string, fileName: string, encoding: string): string {
    let processedOutput = diffOutput;
    
    // 替换临时文件路径为实际文件名
    processedOutput = processedOutput.replace(/\/tmp\/svn_base_[^\t\n]+/g, `${fileName} (SVN版本)`);
    processedOutput = processedOutput.replace(/\/tmp\/svn_current_[^\t\n]+/g, `${fileName} (工作副本)`);
    
    // 根据配置决定是否添加编码信息
    const config = this.getEncodingConfig();
    if (config.showEncodingInfo && encoding !== 'utf8') {
      const encodingInfo = `文件编码信息: ${encoding}\n\n`;
      processedOutput = encodingInfo + processedOutput;
    }
    
    return processedOutput;
  }

  /**
   * 创建简单差异显示
   * @param fileName 文件名
   * @param baseContent SVN版本内容
   * @param currentContent 当前内容
   * @param encoding 文件编码
   * @returns 简单差异显示
   */
  private createSimpleDiff(fileName: string, baseContent: string, currentContent: string, encoding: string): string {
    const config = this.getEncodingConfig();
    const encodingInfo = (config.showEncodingInfo && encoding !== 'utf8') ? ` [原始编码: ${encoding}]` : '';
    
    return `--- ${fileName} (SVN版本)${encodingInfo}\n` + 
           `+++ ${fileName} (工作副本)${encodingInfo}\n\n` + 
           `文件差异概要：\n` +
           `SVN版本大小: ${baseContent.length} 字符\n` +
           `当前版本大小: ${currentContent.length} 字符\n` +
           `大小变化: ${currentContent.length - baseContent.length > 0 ? '+' : ''}${currentContent.length - baseContent.length} 字符\n` +
           (config.showEncodingInfo ? `文件编码: ${encoding}\n` : '') +
           `\n注意：由于编码复杂性，显示简化差异信息。您可以继续提交文件。\n\n` +
           `如需查看详细差异，建议使用外部差异工具。`;
  }

  /**
   * 备用差异获取方法
   * @param filePath 文件路径
   * @returns 备用差异信息
   */
  private async getFallbackDiff(filePath: string): Promise<string> {
    try {
      const fileName = path.basename(filePath);
      const { content: currentContent, encoding } = await this.readFileWithEncoding(filePath);
      
      return `--- ${fileName} (备用差异检查)\n` + 
             `+++ ${fileName} (当前版本)\n\n` + 
             `文件信息：\n` +
             `文件编码: ${encoding}\n` +
             `文件大小: ${currentContent.length} 字符\n\n` +
             `注意：无法获取详细差异信息，可能由于编码或SVN配置问题。\n` +
             `建议检查文件编码设置或使用外部工具查看差异。\n` +
             `您仍然可以继续提交此文件。`;
    } catch (fallbackError: any) {
      this.outputChannel.appendLine(`[getFallbackDiff] 备用方法也失败: ${fallbackError.message}`);
      throw new Error(`获取差异失败: 所有方法都无法处理此文件的编码问题`);
    }
  }

  /**
   * 检查文件是否有修改
   * @param filePath 文件路径
   * @returns 是否有修改
   */
  public async hasChanges(filePath: string): Promise<boolean> {
    this.outputChannel.appendLine(`\n[hasChanges] 检查文件是否有修改: ${filePath}`);
    
    try {
      const status = await this.svnService.getFileStatus(filePath);
      this.outputChannel.appendLine(`[hasChanges] 文件SVN状态: ${status}`);
      const hasChanges = status === '已修改' || status === '已添加' || status === '已删除' || status === '已替换' || status === '冲突';
      this.outputChannel.appendLine(`[hasChanges] 基于状态判断是否有修改: ${hasChanges}`);
      return hasChanges;
    } catch (error: any) {
      this.outputChannel.appendLine(`[hasChanges] 获取状态失败: ${error.message}`);
      this.outputChannel.appendLine(`[hasChanges] 尝试备用方法...`);
      
      // 如果获取状态失败，尝试使用另一种方法检查
      try {
        // 获取文件当前内容
        this.outputChannel.appendLine(`[hasChanges] 读取当前文件内容...`);
        const currentContent = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
        const currentText = Buffer.from(currentContent).toString('utf8');
        this.outputChannel.appendLine(`[hasChanges] 当前文件内容长度: ${currentText.length} 字节`);
        
        // 获取SVN版本内容
        const cwd = path.dirname(filePath);
        const fileName = path.basename(filePath);
        this.outputChannel.appendLine(`[hasChanges] 获取SVN版本内容...`);
        const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd);
        this.outputChannel.appendLine(`[hasChanges] SVN版本内容长度: ${baseContent.length} 字节`);
        
        // 比较内容是否相同
        const isDifferent = currentText !== baseContent;
        this.outputChannel.appendLine(`[hasChanges] 内容比较结果: ${isDifferent ? '不同' : '相同'}`);
        return isDifferent;
      } catch (fallbackError: any) {
        this.outputChannel.appendLine(`[hasChanges] 备用方法也失败: ${fallbackError.message}`);
        this.outputChannel.appendLine(`[hasChanges] 假设文件有修改，让用户决定是否提交`);
        // 如果还是失败，假设有修改（让用户决定是否提交）
        return true;
      }
    }
  }

  /**
   * 显示文件差异对比
   * @param filePath 文件路径
   * @returns 是否成功显示差异
   */
  public async showDiff(filePath: string): Promise<boolean> {
    this.outputChannel.appendLine(`\n[showDiff] 开始显示文件差异: ${filePath}`);
    
    try {
      // 检查文件是否有修改
      this.outputChannel.appendLine(`[showDiff] 检查文件是否有修改...`);
      const hasChanges = await this.hasChanges(filePath);
      this.outputChannel.appendLine(`[showDiff] 文件是否有修改: ${hasChanges}`);
      
      if (!hasChanges) {
        this.outputChannel.appendLine(`[showDiff] 文件没有修改，无需提交`);
        vscode.window.showInformationMessage('文件没有修改，无需提交');
        return false;
      }

      try {
        // 获取当前文件的 URI
        const currentUri = vscode.Uri.file(filePath);
        
        // 创建临时文件用于存储 SVN 版本的内容
        const fs = require('fs');
        const os = require('os');
        const path = require('path');
        const tempDir = os.tmpdir();
        const tempFilePath = path.join(tempDir, `svn_base_${path.basename(filePath)}`);
        
        // 获取 SVN 版本的内容
        this.outputChannel.appendLine(`[showDiff] 获取 SVN 版本内容...`);
        const cwd = path.dirname(filePath);
        const fileName = path.basename(filePath);
        const baseContent = await this.svnService.executeSvnCommand(`cat "${fileName}"`, cwd);
        
        // 写入 SVN 版本内容到临时文件
        this.outputChannel.appendLine(`[showDiff] 写入 SVN 版本内容到临时文件: ${tempFilePath}`);
        fs.writeFileSync(tempFilePath, baseContent);
        
        // 创建临时文件的 URI
        const baseUri = vscode.Uri.file(tempFilePath);
        
        // 使用 VS Code 的差异编辑器显示左右对比
        this.outputChannel.appendLine(`[showDiff] 打开差异编辑器...`);
        await vscode.commands.executeCommand('vscode.diff', 
          baseUri, 
          currentUri, 
          `SVN: ${path.basename(filePath)} (左: 版本库 | 右: 工作副本)`
        );
        
        this.outputChannel.appendLine(`[showDiff] 差异显示成功`);
        return true;
      } catch (error: any) {
        // 如果显示差异失败，显示错误但仍然允许提交
        this.outputChannel.appendLine(`[showDiff] 显示差异失败: ${error.message}`);
        vscode.window.showWarningMessage(`无法显示详细差异: ${error.message}。您仍然可以继续提交。`);
        return true;
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[showDiff] 错误: ${error.message}`);
      vscode.window.showErrorMessage(`显示差异失败: ${error.message}`);
      return false;
    }
  }
} 