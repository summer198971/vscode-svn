import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import { SvnFilterService } from './filterService';
import { SvnAuthService } from './svnAuthService';
import { SvnAuthDialog } from './svnAuthDialog';

const exec = promisify(cp.exec);
const fsExists = promisify(fs.exists);

interface SvnStatus {
  status: string;
  filePath: string;
}

/**
 * 冲突文件信息
 */
export interface ConflictFile {
  path: string;
  displayName: string;
  conflictType: 'text' | 'tree' | 'property';
  status: string;
}

/**
 * 冲突详情
 */
export interface ConflictDetails {
  filePath: string;
  conflictType: 'text' | 'tree' | 'property';
  mineContent?: string;
  theirsContent?: string;
  baseContent?: string;
  workingContent?: string;
  conflictMarkers?: Array<{
    start: number;
    end: number;
    type: 'mine' | 'theirs' | 'both';
  }>;
}

/**
 * SVN服务类，负责执行SVN命令和管理SVN工作副本
 */
export class SvnService {
  // 存储自定义SVN工作副本路径
  private customSvnRoot: string | undefined;
  private outputChannel: vscode.OutputChannel;
  private filterService: SvnFilterService;
  private _workingCopyPath: string | undefined;
  private authService: SvnAuthService | undefined;

  constructor(context?: vscode.ExtensionContext) {
    this.outputChannel = vscode.window.createOutputChannel('SVN');
    this.filterService = new SvnFilterService();
    if (context) {
      this.authService = new SvnAuthService(context);
    }
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
   * 检测文件编码
   * @param filePath 文件路径
   * @returns 编码类型
   */
  private detectFileEncoding(filePath: string): string {
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

    try {
      const buffer = fs.readFileSync(filePath);
      
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
      
      // 尝试解析为UTF-8
      try {
        const text = buffer.toString('utf8');
        // 检查是否包含无效字符
        if (text.includes('\uFFFD')) {
          // 可能是其他编码，尝试检测
          return this.detectChineseEncoding(buffer);
        }
        return 'utf8';
      } catch {
        return this.detectChineseEncoding(buffer);
      }
    } catch (error) {
      this.outputChannel.appendLine(`[detectFileEncoding] 检测文件编码失败: ${error}`);
      return 'utf8'; // 默认使用UTF-8
    }
  }

  /**
   * 检测中文编码
   * @param buffer 文件缓冲区
   * @returns 编码类型
   */
  private detectChineseEncoding(buffer: Buffer): string {
    const config = this.getEncodingConfig();
    
    try {
      // 使用配置的备用编码列表
      const encodings = config.encodingFallbacks;
      
      for (const encoding of encodings) {
        try {
          // 使用iconv-lite库进行编码检测和转换（如果可用）
          const text = buffer.toString(encoding as BufferEncoding);
          
          // 检查是否包含常见中文字符
          const chineseRegex = /[\u4e00-\u9fff]/;
          if (chineseRegex.test(text) && !text.includes('\uFFFD')) {
            this.outputChannel.appendLine(`[detectChineseEncoding] 检测到编码: ${encoding}`);
            return encoding;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      this.outputChannel.appendLine(`[detectChineseEncoding] 编码检测失败: ${error}`);
    }
    
    return 'utf8'; // 默认返回UTF-8
  }

  /**
   * 转换文本编码为UTF-8
   * @param text 原始文本
   * @param sourceEncoding 源编码
   * @returns UTF-8编码的文本
   */
  private convertToUtf8(text: string, sourceEncoding: string): string {
    try {
      if (sourceEncoding === 'utf8' || sourceEncoding === 'utf8-bom') {
        return text;
      }
      
      // 对于非UTF-8编码，尝试重新编码
      const buffer = Buffer.from(text, sourceEncoding as BufferEncoding);
      return buffer.toString('utf8');
    } catch (error) {
      this.outputChannel.appendLine(`[convertToUtf8] 编码转换失败: ${error}`);
      return text; // 转换失败时返回原文本
    }
  }

  /**
   * 获取增强的环境变量配置
   * @returns 环境变量对象
   */
  private getEnhancedEnvironment(): NodeJS.ProcessEnv {
    const platform = os.platform();
    const baseEnv = { ...process.env };
    const config = this.getEncodingConfig();
    
    // 如果启用了强制UTF-8输出，设置相应的环境变量
    let utf8Env: Record<string, string> = {};
    
    if (config.forceUtf8Output) {
      // 基础UTF-8环境变量
      utf8Env = {
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        LC_CTYPE: 'en_US.UTF-8',
        LC_MESSAGES: 'en_US.UTF-8',
        LANGUAGE: 'en_US.UTF-8',
        SVN_EDITOR: 'echo'  // 避免交互式编辑器
      };
      
      // 根据平台添加特定配置
      if (platform === 'win32') {
        // Windows特定配置
        Object.assign(utf8Env, {
          PYTHONIOENCODING: 'utf-8',
          // 设置代码页为UTF-8
          CHCP: '65001'
        });
      } else if (platform === 'darwin') {
        // macOS特定配置
        Object.assign(utf8Env, {
          LC_COLLATE: 'en_US.UTF-8',
          LC_MONETARY: 'en_US.UTF-8',
          LC_NUMERIC: 'en_US.UTF-8',
          LC_TIME: 'en_US.UTF-8'
        });
      }
    } else {
      // 如果没有强制UTF-8输出，只设置基本的编辑器配置
      utf8Env = {
        SVN_EDITOR: 'echo'  // 避免交互式编辑器
      };
      
      this.outputChannel.appendLine(`[getEnhancedEnvironment] 强制UTF-8输出已禁用，使用系统默认编码`);
    }
    
    // 合并环境变量
    return Object.assign(baseEnv, utf8Env);
  }

  /**
   * 执行SVN命令
   * @param command SVN命令
   * @param path 工作目录
   * @param useXml 是否使用XML输出
   * @returns 命令执行结果
   */
  public async executeSvnCommand(command: string, path: string, useXml: boolean = false): Promise<string> {
    return this.executeSvnCommandWithAuth(command, path, useXml);
  }

  /**
   * 执行SVN命令（支持认证重试）
   * @param command SVN命令
   * @param path 工作目录
   * @param useXml 是否使用XML输出
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 命令执行结果
   */
  private async executeSvnCommandWithAuth(
    command: string, 
    path: string, 
    useXml: boolean = false,
    username?: string,
    password?: string
  ): Promise<string> {
    try {
      this.outputChannel.appendLine(`\n[executeSvnCommand] 执行SVN命令: svn ${command}`);
      this.outputChannel.appendLine(`[executeSvnCommand] 工作目录: ${path}`);
      
      // 步骤1: 首先尝试系统默认认证
      if (!username && !password) {
        try {
          return await this._executeCommand(command, path, useXml);
        } catch (error: any) {
          // 检查是否是认证失败
          if (this._isAuthenticationError(error)) {
            this.outputChannel.appendLine(`[executeSvnCommand] 系统默认认证失败，尝试获取保存的认证信息`);
            
            // 步骤2: 尝试使用保存的认证信息
            if (this.authService) {
              const repoUrl = await this.authService.getRepositoryRootUrl(path);
              if (repoUrl) {
                const savedCredential = await this.authService.getCredential(repoUrl);
                if (savedCredential) {
                  this.outputChannel.appendLine(`[executeSvnCommand] 找到保存的认证信息，用户名: ${savedCredential.username}`);
                  try {
                    const result = await this._executeCommand(command, path, useXml, savedCredential.username, savedCredential.password);
                    // 更新最后使用时间
                    await this.authService.updateLastUsed(repoUrl);
                    return result;
                  } catch (authError: any) {
                    if (this._isAuthenticationError(authError)) {
                      this.outputChannel.appendLine(`[executeSvnCommand] 保存的认证信息已失效，需要重新输入`);
                      // 删除失效的认证信息
                      await this.authService.removeCredential(repoUrl);
                    } else {
                      throw authError; // 不是认证错误，直接抛出
                    }
                  }
                }
              }
              
              // 步骤3: 提示用户输入认证信息
              if (this.authService.getDefaultAuthPrompt()) {
                const authResult = await SvnAuthDialog.showAuthDialog(repoUrl || path);
                if (authResult) {
                  try {
                    const result = await this._executeCommand(command, path, useXml, authResult.username, authResult.password);
                    
                    // 保存认证信息（如果用户选择保存）
                    if (authResult.saveCredentials && repoUrl && this.authService.getAutoSaveCredentials()) {
                      await this.authService.saveCredential(repoUrl, authResult.username, authResult.password);
                      SvnAuthDialog.showAuthSuccessMessage(repoUrl, authResult.username, true);
                    } else {
                      SvnAuthDialog.showAuthSuccessMessage(repoUrl || path, authResult.username, false);
                    }
                    
                    return result;
                  } catch (finalError: any) {
                    if (this._isAuthenticationError(finalError)) {
                      SvnAuthDialog.showAuthFailureMessage(repoUrl || path, '用户名或密码错误');
                    }
                    throw finalError;
                  }
                } else {
                  throw new Error('用户取消了认证操作');
                }
              }
            }
          }
          throw error; // 不是认证错误或无法处理，直接抛出原错误
        }
      } else {
        // 如果已经提供了用户名密码，直接使用
        return await this._executeCommand(command, path, useXml, username, password);
      }
    } catch (error: any) {
      this.outputChannel.appendLine(`[executeSvnCommand] 捕获到异常: ${error.message}`);
      throw error;
    }
  }

  /**
   * 实际执行SVN命令的内部方法
   */
  private async _executeCommand(
    command: string, 
    path: string, 
    useXml: boolean = false,
    username?: string,
    password?: string
  ): Promise<string> {
    // 获取增强的环境变量配置
    const env = this.getEnhancedEnvironment();
    
    this.outputChannel.appendLine(`[_executeCommand] 设置编码环境变量: LANG=${env.LANG}, LC_ALL=${env.LC_ALL}`);
    
    // 根据 useXml 参数决定是否添加 --xml 标志
    let xmlFlag = '';
    if (useXml) {
      xmlFlag = '--xml';
      this.outputChannel.appendLine(`[_executeCommand] 添加XML输出标志: ${xmlFlag}`);
    }
    
    // 对于diff命令，添加特殊处理以支持各种编码
    if (command.includes('diff')) {
      if (!command.includes('--force')) {
        command = `${command} --force`;
      }
      // 添加编码相关参数
      if (!command.includes('--internal-diff')) {
        command = `${command} --internal-diff`;
      }
      this.outputChannel.appendLine(`[_executeCommand] 为diff命令添加编码支持参数`);
    }
    
    // 对于log命令，确保使用UTF-8输出
    if (command.includes('log')) {
      if (!command.includes('--xml') && useXml) {
        // XML输出时已经包含编码信息
      }
    }
    
    // 构建完整命令，包含认证信息
    let finalCommand = `svn ${command} ${xmlFlag}`.trim();
    if (username && password) {
      finalCommand += ` --username "${username}" --password "${password}" --non-interactive --trust-server-cert`;
      this.outputChannel.appendLine(`[_executeCommand] 使用认证信息，用户名: ${username}`);
    }
    
    this.outputChannel.appendLine(`[_executeCommand] 最终命令: ${finalCommand.replace(/ --password "[^"]*"/, ' --password "***"')}`);
    
    // 执行命令
    this.outputChannel.appendLine(`[_executeCommand] 开始执行命令...`);
    return new Promise<string>((resolve, reject) => {
      const svnProcess = cp.exec(
        finalCommand, 
        { 
          cwd: path, 
          env,
          maxBuffer: 50 * 1024 * 1024, // 增加缓冲区大小到50MB
          encoding: 'utf8' as BufferEncoding  // 显式指定编码
        },
        (error, stdout, stderr) => {
          if (error) {
            this.outputChannel.appendLine(`[_executeCommand] 命令执行失败，错误码: ${error.code}`);
            if (stderr) {
              // 尝试编码转换
              const convertedStderr = this.processCommandOutput(stderr);
              this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${convertedStderr}`);
              reject(new Error(`SVN错误: ${convertedStderr}`));
            } else {
              this.outputChannel.appendLine(`[_executeCommand] 错误信息: ${error.message}`);
              reject(error);
            }
          } else {
            // 处理输出编码
            const processedOutput = this.processCommandOutput(stdout);
            
            this.outputChannel.appendLine(`[_executeCommand] 命令执行成功，输出长度: ${processedOutput.length} 字节`);
            if (processedOutput.length < 1000) {
              this.outputChannel.appendLine(`[_executeCommand] 输出内容: ${processedOutput.replace(/\n/g, '\\n')}`);
            } else {
              this.outputChannel.appendLine(`[_executeCommand] 输出内容前1000个字符: ${processedOutput.substring(0, 1000).replace(/\n/g, '\\n')}...`);
            }
            resolve(processedOutput);
          }
        }
      );
      
      // 处理实时输出
      if (svnProcess.stdout) {
        svnProcess.stdout.on('data', (data) => {
          const processedData = this.processCommandOutput(data.toString());
          this.outputChannel.appendLine(`[_executeCommand] 命令输出: ${processedData.replace(/\n/g, '\\n')}`);
        });
      }
      
      if (svnProcess.stderr) {
        svnProcess.stderr.on('data', (data) => {
          const processedData = this.processCommandOutput(data.toString());
          this.outputChannel.appendLine(`[_executeCommand] 错误输出: ${processedData.replace(/\n/g, '\\n')}`);
        });
      }
    });
  }

  /**
   * 检查是否是认证失败错误
   */
  private _isAuthenticationError(error: any): boolean {
    const errorMessage = error.message || error.toString();
    return errorMessage.includes('E170001') || 
           errorMessage.includes('Authentication failed') ||
           errorMessage.includes('authentication failed') ||
           errorMessage.includes('认证失败') ||
           errorMessage.includes('用户名或密码') ||
           errorMessage.includes('Authorization failed');
  }

  /**
   * 处理命令输出的编码
   * @param output 原始输出
   * @returns 处理后的输出
   */
  private processCommandOutput(output: string): string {
    try {
      // 检查是否包含乱码字符
      if (output.includes('\uFFFD') || this.hasGarbledText(output)) {
        this.outputChannel.appendLine(`[processCommandOutput] 检测到可能的编码问题，尝试修复`);
        
        // 尝试不同的编码解析
        return this.fixEncodingIssues(output);
      }
      
      return output;
    } catch (error) {
      this.outputChannel.appendLine(`[processCommandOutput] 处理输出编码失败: ${error}`);
      return output; // 处理失败时返回原输出
    }
  }

  /**
   * 检测是否包含乱码文本
   * @param text 文本内容
   * @returns 是否包含乱码
   */
  private hasGarbledText(text: string): boolean {
    // 检测常见的乱码模式
    const garbledPatterns = [
      /[\u00C0-\u00FF]{2,}/,  // 连续的扩展ASCII字符
      /\?{2,}/,              // 连续的问号
      /\uFFFD/,              // 替换字符
      /[\u0080-\u00FF]{3,}/  // 连续的高位字符
    ];
    
    return garbledPatterns.some(pattern => pattern.test(text));
  }

  /**
   * 修复编码问题
   * @param text 有问题的文本
   * @returns 修复后的文本
   */
  private fixEncodingIssues(text: string): string {
    try {
      // 尝试将文本重新编码
      const buffer = Buffer.from(text, 'latin1');
      
      // 尝试不同的编码
      const encodings = ['utf8', 'gbk', 'gb2312', 'big5'];
      
      for (const encoding of encodings) {
        try {
          const decoded = buffer.toString(encoding as BufferEncoding);
          
          // 检查解码结果是否包含中文字符且没有乱码
          if (/[\u4e00-\u9fff]/.test(decoded) && !decoded.includes('\uFFFD')) {
            this.outputChannel.appendLine(`[fixEncodingIssues] 使用编码 ${encoding} 成功修复`);
            return decoded;
          }
        } catch {
          continue;
        }
      }
      
      // 如果所有编码都失败，返回原文本
      this.outputChannel.appendLine(`[fixEncodingIssues] 无法修复编码问题，返回原文本`);
      return text;
    } catch (error) {
      this.outputChannel.appendLine(`[fixEncodingIssues] 修复编码失败: ${error}`);
      return text;
    }
  }

  /**
   * 检查SVN是否已安装
   * @returns 是否已安装
   */
  public async isSvnInstalled(): Promise<boolean> {
    try {
      await exec('svn --version');
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * 设置自定义SVN工作副本路径
   * @param svnRootPath SVN工作副本根目录路径
   * @returns 是否设置成功
   */
  public async setCustomSvnRoot(svnRootPath: string): Promise<boolean> {
    // 检查路径是否存在
    if (!await fsExists(svnRootPath)) {
      return false;
    }

    // 检查是否包含.svn目录
    const svnDirPath = path.join(svnRootPath, '.svn');
    if (!await fsExists(svnDirPath)) {
      return false;
    }

    // 设置自定义SVN工作副本路径
    this.customSvnRoot = svnRootPath;
    
    // 保存到配置中，以便在会话之间保持
    await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', svnRootPath, vscode.ConfigurationTarget.Workspace);
    
    return true;
  }

  /**
   * 获取自定义SVN工作副本路径
   * @returns SVN工作副本根目录路径
   */
  public getCustomSvnRoot(): string | undefined {
    if (!this.customSvnRoot) {
      // 从配置中读取
      this.customSvnRoot = vscode.workspace.getConfiguration('vscode-svn').get<string>('customSvnRoot');
    }
    return this.customSvnRoot;
  }

  /**
   * 清除自定义SVN工作副本路径
   */
  public async clearCustomSvnRoot(): Promise<void> {
    this.customSvnRoot = undefined;
    await vscode.workspace.getConfiguration('vscode-svn').update('customSvnRoot', undefined, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * 检查路径是否在SVN工作副本中
   * @param fsPath 文件系统路径
   * @returns 是否在SVN工作副本中
   */
  public async isInWorkingCopy(fsPath: string): Promise<boolean> {
    try {
      // 首先尝试直接使用svn info命令
      try {
        // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
        let targetPath = fsPath;
        if (fsPath.includes('@')) {
          targetPath = `${fsPath}@`;
        }
        
        await this.executeSvnCommand('info', targetPath);
        return true;
      } catch (error) {
        // 如果直接检查失败，并且有自定义SVN根目录，则使用自定义根目录
        if (this.getCustomSvnRoot()) {
          // 获取相对于自定义SVN根目录的路径
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          // 如果路径以..开头，说明文件不在SVN根目录下
          if (relativePath.startsWith('..')) {
            return false;
          }
          
          // 特殊处理：如果相对路径包含@符号，需要在路径后添加额外的@来转义
          let escapedPath = relativePath;
          if (relativePath.includes('@')) {
            escapedPath = `${relativePath}@`;
          }
          
          // 尝试在自定义SVN根目录下执行svn info命令
          try {
            await this.executeSvnCommand(`info "${escapedPath}"`, this.getCustomSvnRoot()!);
            return true;
          } catch (error) {
            return false;
          }
        }
        return false;
      }
    } catch (error) {
      return false;
    }
  }

  /**
   * 获取文件状态
   * @param filePath 文件路径
   * @returns 文件状态
   */
  public async getFileStatus(filePath: string): Promise<string> {
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`[getFileStatus] 获取文件状态: ${filePath}`);
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }
      
      // 如果有自定义SVN根目录，并且直接检查失败，则使用自定义根目录
      if (this.getCustomSvnRoot()) {
        try {
          const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
          if (result) {
            // 如果直接检查成功，使用直接结果
            this.outputChannel.appendLine(`[getFileStatus] 直接检查成功，状态结果: ${result.substring(0, 100).replace(/\n/g, '\\n')}`);
            return this.parseStatusCode(result);
          }
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            cwd = this.getCustomSvnRoot()!;
            fileName = relativePath;
            // 如果相对路径包含@符号，也需要转义
            if (needsEscaping && !fileName.endsWith('@')) {
              fileName = `${fileName}@`;
            }
          }
        }
      }
      
      const result = await this.executeSvnCommand(`status "${fileName}"`, cwd);
      this.outputChannel.appendLine(`[getFileStatus] 状态结果: ${result.substring(0, 100).replace(/\n/g, '\\n')}`);
      return this.parseStatusCode(result);
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileStatus] 获取状态失败: ${error.message}`);
      return '未知状态';
    }
  }

  /**
   * 解析SVN状态码
   * @param statusResult SVN状态命令结果
   * @returns 状态描述
   */
  private parseStatusCode(statusResult: string): string {
    this.outputChannel.appendLine(`[parseStatusCode] 解析状态码: ${statusResult.substring(0, 100).replace(/\n/g, '\\n')}`);
    
    if (statusResult.trim() === '') {
      return '无修改';
    }
    
    // 检查是否是XML格式的输出
    if (statusResult.includes('<?xml') && statusResult.includes('<wc-status')) {
      // 解析XML格式的状态
      const itemMatch = statusResult.match(/item="([^"]+)"/);
      if (itemMatch && itemMatch[1]) {
        const statusCode = itemMatch[1];
        this.outputChannel.appendLine(`[parseStatusCode] 从XML中提取的状态码: ${statusCode}`);
        
        switch (statusCode) {
          case 'modified': return '已修改';
          case 'added': return '已添加';
          case 'deleted': return '已删除';
          case 'replaced': return '已替换';
          case 'conflicted': return '冲突';
          case 'unversioned': return '未版本控制';
          case 'missing': return '丢失';
          case 'ignored': return '已忽略';
          case 'obstructed': return '类型变更';
          default: return `未知状态(${statusCode})`;
        }
      }
    }
    
    // 如果不是XML格式或无法解析XML，则使用原来的方式解析
    const statusCode = statusResult.trim().charAt(0);
    this.outputChannel.appendLine(`[parseStatusCode] 使用第一个字符作为状态码: ${statusCode}`);
    
    switch (statusCode) {
      case 'M': return '已修改';
      case 'A': return '已添加';
      case 'D': return '已删除';
      case 'R': return '已替换';
      case 'C': return '冲突';
      case '?': return '未版本控制';
      case '!': return '丢失';
      case 'I': return '已忽略';
      case '~': return '类型变更';
      default: return `未知状态(${statusCode})`;
    }
  }

  /**
   * 添加文件到SVN
   * @param filePath 文件路径
   */
  public async addFile(filePath: string): Promise<void> {
    // 检查文件是否应该被排除
    if (this.filterService.shouldExcludeFile(filePath)) {
      vscode.window.showWarningMessage(`文件 ${path.basename(filePath)} 在排除列表中，已跳过添加`);
      return;
    }
    
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
    // 因为在SVN中@符号用于指定版本号
    const needsEscaping = fileName.includes('@');
    if (needsEscaping) {
      fileName = `${fileName}@`;
    }
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
        await this.executeSvnCommand(infoCommand, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
          // 如果相对路径包含@符号，也需要转义
          if (needsEscaping && !fileName.endsWith('@')) {
            fileName = `${fileName}@`;
          }
        }
      }
    }
    
    await this.executeSvnCommand(`add "${fileName}"`, cwd);
  }

  /**
   * 删除文件
   * @param filePath 文件路径
   */
  public async removeFile(filePath: string): Promise<void> {
    let cwd = path.dirname(filePath);
    let fileName = path.basename(filePath);
    
    // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
    // 因为在SVN中@符号用于指定版本号
    const needsEscaping = fileName.includes('@');
    if (needsEscaping) {
      fileName = `${fileName}@`;
    }
    
    // 如果有自定义SVN根目录，检查是否需要使用它
    if (this.getCustomSvnRoot()) {
      try {
        const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
        await this.executeSvnCommand(infoCommand, cwd);
      } catch (error) {
        // 如果直接检查失败，使用自定义根目录
        const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
        if (!relativePath.startsWith('..')) {
          cwd = this.getCustomSvnRoot()!;
          fileName = relativePath;
          // 如果相对路径包含@符号，也需要转义
          if (needsEscaping && !fileName.endsWith('@')) {
            fileName = `${fileName}@`;
          }
        }
      }
    }
    
    await this.executeSvnCommand(`remove "${fileName}"`, cwd);
  }

  /**
   * 确保输出面板可见并为新操作做准备
   * @param title 操作标题
   * @private
   */
  private showOutputChannel(title: string): void {
    this.outputChannel.clear();
    this.outputChannel.show(true); // true参数表示聚焦到输出面板
    this.outputChannel.appendLine(`========== ${title}开始 ==========`);
    this.outputChannel.appendLine(`时间: ${new Date().toLocaleString()}`);
    this.outputChannel.appendLine('--------------------------------------');
  }

  /**
   * 提交文件或文件夹
   * @param fsPath 文件系统路径
   * @param message 提交信息
   */
  public async commit(fsPath: string, message: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN提交操作');
    this.outputChannel.appendLine(`提交路径: ${fsPath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);
    
    // 检查文件是否应该被排除
    if (this.filterService.shouldExcludeFile(fsPath)) {
      this.outputChannel.appendLine(`文件 ${fsPath} 被过滤器排除，跳过提交操作`);
      this.outputChannel.appendLine('========== SVN提交操作跳过 ==========');
      vscode.window.showWarningMessage(`文件 ${path.basename(fsPath)} 在排除列表中，已跳过提交`);
      return;
    }
    
    try {
      const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
      
      this.outputChannel.appendLine('正在检查文件状态...');
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', fsPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          if (!relativePath.startsWith('..')) {
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${this.getCustomSvnRoot()!}`);
            this.outputChannel.appendLine(`相对路径: ${relativePath}`);
            this.outputChannel.appendLine('正在提交文件...');
            
            // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            if (isDirectory) {
              const result = await this.executeSvnCommand(`commit "${escapedPath}" -m "${message}"`, this.getCustomSvnRoot()!);
              this.outputChannel.appendLine(result);
              this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
              return;
            } else {
              const result = await this.executeSvnCommand(`commit "${escapedPath}" -m "${message}"`, this.getCustomSvnRoot()!);
              this.outputChannel.appendLine(result);
              this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
              return;
            }
          }
        }
      }
      
      this.outputChannel.appendLine('正在提交文件...');
      if (isDirectory) {
        const result = await this.executeSvnCommand(`commit -m "${message}"`, fsPath);
        this.outputChannel.appendLine(result);
      } else {
        const cwd = path.dirname(fsPath);
        let fileName = path.basename(fsPath);
        
        // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
        if (fileName.includes('@')) {
          fileName = `${fileName}@`;
        }
        
        this.outputChannel.appendLine(`工作目录: ${cwd}`);
        this.outputChannel.appendLine(`文件名: ${fileName}`);
        const result = await this.executeSvnCommand(`commit "${fileName}" -m "${message}"`, cwd);
        this.outputChannel.appendLine(result);
      }
      
      this.outputChannel.appendLine('========== SVN提交操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN提交操作失败 ==========');
      
      // 检查是否是"out of date"错误
      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(fsPath, message);
        return; // 如果用户选择了处理，则不再抛出错误
      }
      
      throw error;
    }
  }

  /**
   * 更新工作副本
   * @param fsPath 文件系统路径
   */
  public async update(fsPath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN更新操作');
    this.outputChannel.appendLine(`更新路径: ${fsPath}`);
    
    // 检查文件或文件夹是否应该被排除
    const isDirectory = (await vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).type === vscode.FileType.Directory;
    if ((isDirectory && this.filterService.shouldExcludeFolder(fsPath)) || 
        (!isDirectory && this.filterService.shouldExcludeFile(fsPath))) {
      this.outputChannel.appendLine(`路径 ${fsPath} 被过滤器排除，跳过更新操作`);
      this.outputChannel.appendLine('========== SVN更新操作跳过 ==========');
      vscode.window.showWarningMessage(`${isDirectory ? '文件夹' : '文件'} ${path.basename(fsPath)} 在排除列表中，已跳过更新`);
      return;
    }
    
    try {
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', fsPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, fsPath);
          if (!relativePath.startsWith('..')) {
            // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${this.getCustomSvnRoot()!}`);
            this.outputChannel.appendLine(`相对路径: ${escapedPath}`);
            const result = await this.executeSvnCommand(`update "${escapedPath}"`, this.getCustomSvnRoot()!);
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN更新操作完成 ==========');
            return;
          }
        }
      }
      
      // 特殊处理：如果路径包含@符号，需要在路径后添加额外的@来转义
      let targetPath = fsPath;
      if (fsPath.includes('@') && !isDirectory) { // 只对文件应用转义，目录更新通常不需要指定路径
        targetPath = `${fsPath}@`;
        this.outputChannel.appendLine(`转义路径: ${targetPath}`);
      }
      
      this.outputChannel.appendLine('正在更新工作副本...');
      const updateCommand = isDirectory ? 'update' : `update "${targetPath}"`;
      const workingDir = isDirectory ? fsPath : path.dirname(fsPath);
      const result = await this.executeSvnCommand(updateCommand, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN更新操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN更新操作失败 ==========');
      throw error;
    }
  }

  /**
   * 恢复文件到版本库状态
   * @param filePath 文件路径
   */
  public async revertFile(filePath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN恢复操作');
    this.outputChannel.appendLine(`恢复文件: ${filePath}`);
    
    try {
      this.outputChannel.appendLine('正在恢复文件到版本库状态...');
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      let fileName = path.basename(filePath);
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        // 对于revert，我们需要处理完整路径
        filePath = `${filePath}@`;
      }
      
      const result = await this.executeSvnCommand(`revert "${filePath}"`, path.dirname(filePath));
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN恢复操作失败 ==========');
      throw new Error(`恢复文件失败: ${error.message}`);
    }
  }

  /**
   * 恢复文件夹到版本库状态（递归恢复）
   * @param folderPath 文件夹路径
   */
  public async revertFolder(folderPath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN文件夹恢复操作');
    this.outputChannel.appendLine(`恢复文件夹: ${folderPath}`);
    
    // 检查文件夹是否应该被排除
    if (this.filterService.shouldExcludeFolder(folderPath)) {
      this.outputChannel.appendLine(`文件夹 ${folderPath} 被过滤器排除，跳过恢复操作`);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作跳过 ==========');
      vscode.window.showWarningMessage(`文件夹 ${path.basename(folderPath)} 在排除列表中，已跳过恢复`);
      return;
    }
    
    try {
      let workingDir = folderPath;
      let targetPath = '.';
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', folderPath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, folderPath);
          if (!relativePath.startsWith('..')) {
            workingDir = this.getCustomSvnRoot()!;
            targetPath = relativePath || '.';
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${workingDir}`);
            this.outputChannel.appendLine(`相对路径: ${targetPath}`);
          }
        }
      }
      
      this.outputChannel.appendLine('正在恢复文件夹到版本库状态（递归）...');
      this.outputChannel.appendLine(`工作目录: ${workingDir}`);
      this.outputChannel.appendLine(`目标路径: ${targetPath}`);
      
      // 使用 -R 参数进行递归恢复
      const result = await this.executeSvnCommand(`revert -R "${targetPath}"`, workingDir);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN文件夹恢复操作失败 ==========');
      throw new Error(`恢复文件夹失败: ${error.message}`);
    }
  }

  /**
   * 获取文件日志
   * @param filePath 文件路径
   * @param limit 限制条数
   * @returns 日志信息
   */
  public async getLog(filePath: string, limit: number = 10): Promise<string> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN日志查询');
    this.outputChannel.appendLine(`文件路径: ${filePath}`);
    this.outputChannel.appendLine(`限制条数: ${limit}`);
    
    try {
      let cwd = path.dirname(filePath);
      let fileName = path.basename(filePath);
      
      this.outputChannel.appendLine(`工作目录: ${cwd}`);
      this.outputChannel.appendLine(`文件名: ${fileName}`);
      
      // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
      const needsEscaping = fileName.includes('@');
      if (needsEscaping) {
        fileName = `${fileName}@`;
      }
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          const infoCommand = needsEscaping ? `info "${fileName}"` : `info "${fileName}"`;
          await this.executeSvnCommand(infoCommand, cwd);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            cwd = this.getCustomSvnRoot()!;
            fileName = relativePath;
            // 如果相对路径包含@符号，也需要转义
            if (needsEscaping && !fileName.endsWith('@')) {
              fileName = `${fileName}@`;
            }
            this.outputChannel.appendLine(`使用自定义SVN根目录: ${cwd}`);
            this.outputChannel.appendLine(`相对路径: ${fileName}`);
          }
        }
      }
      
      this.outputChannel.appendLine('正在获取日志...');
      const result = await this.executeSvnCommand(`log "${fileName}" -l ${limit}`, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN日志查询完成 ==========');
      
      return result;
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN日志查询失败 ==========');
      throw error;
    }
  }

  /**
   * 一次性提交多个文件
   * @param files 文件路径数组
   * @param message 提交信息
   * @param basePath 基础路径（用于确定工作目录）
   */
  public async commitFiles(files: string[], message: string, basePath: string): Promise<void> {
    // 使用公共方法显示输出面板
    this.showOutputChannel('SVN批量提交操作');
    this.outputChannel.appendLine(`基础路径: ${basePath}`);
    this.outputChannel.appendLine(`提交信息: ${message}`);
    this.outputChannel.appendLine(`原始文件数量: ${files.length}`);
    
    // 应用过滤器
    const filteredFiles = this.filterService.filterFiles(files, basePath);
    const excludedFiles = files.filter(file => !filteredFiles.includes(file));
    
    this.outputChannel.appendLine(`过滤后文件数量: ${filteredFiles.length}`);
    if (excludedFiles.length > 0) {
      this.outputChannel.appendLine('被排除的文件:');
      excludedFiles.forEach((file, index) => {
        this.outputChannel.appendLine(`  ${index + 1}. ${file} (已排除)`);
      });
    }
    
    this.outputChannel.appendLine('要提交的文件列表:');
    filteredFiles.forEach((file, index) => {
      this.outputChannel.appendLine(`  ${index + 1}. ${file}`);
    });
    
    try {
      if (filteredFiles.length === 0) {
        throw new Error('没有可提交的文件（所有文件都被过滤器排除）');
      }
      
      // 检查是否使用自定义SVN根目录
      let workingDir = basePath;
      let fileArgs = '';
      
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', basePath);
        } catch (error) {
          // 如果直接检查失败，使用自定义根目录
          workingDir = this.getCustomSvnRoot()!;
          
          this.outputChannel.appendLine(`使用自定义SVN根目录: ${workingDir}`);
          this.outputChannel.appendLine('正在处理文件路径...');
          
          // 构建相对路径参数
          fileArgs = filteredFiles.map(file => {
            const relativePath = path.relative(this.getCustomSvnRoot()!, file);
            if (relativePath.startsWith('..')) {
              throw new Error(`文件 ${file} 不在SVN工作副本中`);
            }
            
            // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`  ${file} -> ${escapedPath}`);
            return `"${escapedPath}"`;
          }).join(' ');
        }
      }
      
      // 如果没有使用自定义SVN根目录，或者检查成功
      if (fileArgs === '') {
        this.outputChannel.appendLine('正在处理文件路径...');
        
        // 构建文件参数
        fileArgs = filteredFiles.map(file => {
          // 如果文件在基础路径下，使用相对路径
          if (file.startsWith(workingDir)) {
            const relativePath = path.relative(workingDir, file);
            
            // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
            let escapedPath = relativePath;
            if (relativePath.includes('@')) {
              escapedPath = `${relativePath}@`;
            }
            
            this.outputChannel.appendLine(`  ${file} -> ${escapedPath}`);
            return `"${escapedPath}"`;
          }
          
          // 否则使用绝对路径
          // 特殊处理：如果文件名包含@符号，需要在文件名后添加额外的@来转义
          let escapedPath = file;
          if (file.includes('@')) {
            escapedPath = `${file}@`;
          }
          
          this.outputChannel.appendLine(`  ${file} -> ${escapedPath} (绝对路径)`);
          return `"${escapedPath}"`;
        }).join(' ');
      }
      
      this.outputChannel.appendLine(`工作目录: ${workingDir}`);
      
      // 执行提交命令
      this.outputChannel.appendLine('正在提交文件...');
      const result = await this.executeSvnCommand(`commit ${fileArgs} -m "${message}"`, workingDir);
      this.outputChannel.appendLine(result);
      
      this.outputChannel.appendLine('========== SVN批量提交操作完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN批量提交操作失败 ==========');
      
      // 检查是否是"out of date"错误
      if (this.isOutOfDateError(error.message)) {
        await this.handleOutOfDateError(basePath, message, filteredFiles);
        return; // 如果用户选择了处理，则不再抛出错误
      }
      
      throw error;
    }
  }

  /**
   * 检查是否是"out of date"错误
   * @param errorMessage 错误消息
   * @returns 是否是"out of date"错误
   */
  private isOutOfDateError(errorMessage: string): boolean {
    return errorMessage.includes('out of date') || 
           errorMessage.includes('E155011') || 
           errorMessage.includes('E170004');
  }

  /**
   * 处理"out of date"错误
   * @param fsPath 文件系统路径
   * @param message 提交信息
   * @param files 可选的文件列表（用于批量提交）
   */
  private async handleOutOfDateError(fsPath: string, message: string, files?: string[]): Promise<void> {
    const result = await vscode.window.showWarningMessage(
      'SVN提交失败：工作副本版本过时，需要先更新到最新版本后再提交',
      {
        modal: true,
        detail: '这通常发生在其他人已经提交了对相同文件或文件夹的修改。\n\n建议先更新工作副本到最新版本，然后再重新提交。'
      },
      '自动更新并重试提交',
      '仅更新不重试',
      '取消'
    );

    if (result === '自动更新并重试提交') {
      try {
        // 先更新工作副本
        await this.update(fsPath);
        
        // 显示更新成功提示
        vscode.window.showInformationMessage('工作副本已更新到最新版本');
        
        // 询问是否继续提交
        const continueResult = await vscode.window.showInformationMessage(
          '工作副本已更新完成，是否继续提交？',
          '继续提交',
          '取消'
        );
        
        if (continueResult === '继续提交') {
          // 重新尝试提交
          if (files && files.length > 0) {
            // 批量提交
            await this.commitFiles(files, message, fsPath);
          } else {
            // 单文件提交
            await this.commit(fsPath, message);
          }
          
          vscode.window.showInformationMessage('提交成功！');
        }
      } catch (updateError: any) {
        vscode.window.showErrorMessage(`更新失败: ${updateError.message}`);
        throw updateError;
      }
    } else if (result === '仅更新不重试') {
      try {
        await this.update(fsPath);
        vscode.window.showInformationMessage('工作副本已更新到最新版本，请手动重新提交');
      } catch (updateError: any) {
        vscode.window.showErrorMessage(`更新失败: ${updateError.message}`);
        throw updateError;
      }
    } else {
      // 用户选择取消，抛出原始错误
      throw new Error('SVN提交失败：工作副本版本过时，需要先更新');
    }
  }

  /**
   * 测试SVN连接
   * @param svnUrl SVN地址
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 连接测试结果
   */
  public async testConnection(svnUrl: string, username?: string, password?: string): Promise<{ success: boolean; message: string }> {
    this.outputChannel.appendLine(`\n[testConnection] 测试SVN连接: ${svnUrl}`);
    
    try {
      // 记录认证信息
      if (username && password) {
        this.outputChannel.appendLine(`[testConnection] 使用自定义认证信息，用户名: ${username}`);
      } else {
        this.outputChannel.appendLine(`[testConnection] 使用默认认证信息`);
      }
      
      // 构建参数数组
      const args = ['info', svnUrl];
      if (username && password) {
        args.push('--username', username, '--password', password);
      }
      args.push('--non-interactive', '--trust-server-cert');
      
      this.outputChannel.appendLine(`[testConnection] 执行参数: ${JSON.stringify(args)}`);
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      const result = await new Promise<string>((resolve, reject) => {
        const svnProcess = cp.spawn('svn', args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        
        svnProcess.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        
        svnProcess.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        svnProcess.on('close', (code) => {
          if (code === 0) {
            const processedOutput = this.processCommandOutput(stdout);
            this.outputChannel.appendLine(`[testConnection] 连接测试成功`);
            resolve(processedOutput);
          } else {
            const convertedStderr = this.processCommandOutput(stderr);
            this.outputChannel.appendLine(`[testConnection] 命令执行失败，代码: ${code}`);
            this.outputChannel.appendLine(`[testConnection] 错误输出: ${convertedStderr}`);
            reject(new Error(convertedStderr));
          }
        });
        
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[testConnection] 进程错误: ${error.message}`);
          reject(error);
        });
        
        // 30秒超时
        setTimeout(() => {
          svnProcess.kill();
          reject(new Error('连接超时'));
        }, 30000);
      });
      
      // 解析结果，提取有用信息
      const lines = result.split('\n');
      let repoInfo = '';
      
      for (const line of lines) {
        if (line.includes('Repository Root:') || line.includes('仓库根:')) {
          repoInfo += line.trim() + '\n';
        } else if (line.includes('Revision:') || line.includes('修订版本:')) {
          repoInfo += line.trim() + '\n';
        } else if (line.includes('Last Changed Date:') || line.includes('最后修改日期:')) {
          repoInfo += line.trim() + '\n';
        }
      }
      
      return {
        success: true,
        message: repoInfo || '连接成功，仓库可访问'
      };
    } catch (error: any) {
      this.outputChannel.appendLine(`[testConnection] 连接测试失败: ${error.message}`);
      
      // 分析错误类型并提供友好的错误信息
      let friendlyMessage = error.message;
      
      if (error.message.includes('E170001') || error.message.includes('Authentication failed')) {
        friendlyMessage = '认证失败：用户名或密码错误';
      } else if (error.message.includes('E170013') || error.message.includes('Unable to connect')) {
        friendlyMessage = '无法连接到SVN服务器：请检查网络连接和服务器地址';
      } else if (error.message.includes('E200014') || error.message.includes('Not found')) {
        friendlyMessage = 'SVN地址不存在：请检查仓库地址是否正确';
      } else if (error.message.includes('timeout')) {
        friendlyMessage = '连接超时：服务器响应时间过长，请检查网络连接';
      } else if (error.message.includes('certificate')) {
        friendlyMessage = 'SSL证书错误：服务器证书验证失败';
      }
      
      return {
        success: false,
        message: friendlyMessage
      };
    }
  }

  /**
   * 获取SVN仓库中的文件总数
   * @param svnUrl SVN仓库地址
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @returns 文件总数，失败时返回-1
   */
  public async getRepositoryFileCount(
    svnUrl: string,
    username?: string,
    password?: string
  ): Promise<number> {
    try {
      this.outputChannel.appendLine(`[getFileCount] 正在获取仓库文件总数: ${svnUrl}`);
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      return await new Promise<number>((resolve) => {
        // 构建命令参数
        const args = ['list', '-R', svnUrl];
        if (username && password) {
          args.push('--username', username, '--password', password);
        }
        args.push('--non-interactive', '--trust-server-cert');
        
        this.outputChannel.appendLine(`[getFileCount] 执行命令参数: ${JSON.stringify(args)}`);
        
        // 执行SVN list命令
        const svnProcess = cp.spawn('svn', args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let outputBuffer = '';
        let errorBuffer = '';
        
        // 处理标准输出
        svnProcess.stdout?.on('data', (data) => {
          const output = this.processCommandOutput(data.toString());
          outputBuffer += output;
        });
        
        // 处理错误输出
        svnProcess.stderr?.on('data', (data) => {
          const error = this.processCommandOutput(data.toString());
          errorBuffer += error;
        });
        
        // 处理进程退出
        svnProcess.on('close', (code) => {
          if (code === 0) {
            // 成功获取列表，统计文件数量
            const lines = outputBuffer.split('\n').filter(line => line.trim() !== '');
            // 过滤掉目录（以/结尾的条目）
            const fileCount = lines.filter(line => !line.endsWith('/')).length;
            
            this.outputChannel.appendLine(`[getFileCount] 成功获取文件总数: ${fileCount}`);
            resolve(fileCount);
          } else {
            // 获取失败
            this.outputChannel.appendLine(`[getFileCount] 获取文件总数失败: ${errorBuffer}`);
            resolve(-1);
          }
        });
        
        // 处理进程错误
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[getFileCount] 进程错误: ${error.message}`);
          resolve(-1);
        });
        
        // 设置超时（2分钟）
        setTimeout(() => {
          svnProcess.kill();
          this.outputChannel.appendLine('[getFileCount] 获取文件总数超时');
          resolve(-1);
        }, 2 * 60 * 1000); // 2分钟超时
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[getFileCount] 获取文件总数异常: ${error.message}`);
      return -1;
    }
  }

  /**
   * 执行SVN检出操作
   * @param svnUrl SVN地址
   * @param targetDirectory 目标目录
   * @param username 用户名（可选）
   * @param password 密码（可选）
   * @param progressCallback 进度回调函数
   * @returns 检出操作结果
   */
  public async checkout(
    svnUrl: string, 
    targetDirectory: string, 
    username?: string, 
    password?: string,
    progressCallback?: (message: string, progress?: number) => void
  ): Promise<{ success: boolean; message: string }> {
    this.showOutputChannel('SVN检出操作');
    this.outputChannel.appendLine(`SVN地址: ${svnUrl}`);
    this.outputChannel.appendLine(`目标目录: ${targetDirectory}`);
    
    try {
      // 检查目标目录是否存在，如果不存在则创建
      if (!await fsExists(targetDirectory)) {
        await fs.promises.mkdir(targetDirectory, { recursive: true });
        this.outputChannel.appendLine(`创建目标目录: ${targetDirectory}`);
      }
      
      // 检查目标目录是否为空（或只包含.svn目录）
      const files = await fs.promises.readdir(targetDirectory);
      const nonSvnFiles = files.filter(file => file !== '.svn');
      
      if (nonSvnFiles.length > 0) {
        this.outputChannel.appendLine(`警告: 目标目录不为空，包含 ${nonSvnFiles.length} 个文件/文件夹`);
        // 这里可以选择是否继续，但通常SVN checkout可以在非空目录中进行
      }
      
      // 记录认证信息
      if (username && password) {
        this.outputChannel.appendLine(`使用自定义认证信息，用户名: ${username}`);
      } else {
        this.outputChannel.appendLine(`使用默认认证信息`);
      }
      
      // 先获取文件总数，用于准确计算进度
      let totalFileCount = -1;
      if (progressCallback) {
        progressCallback('正在连接SVN服务器...', 5);
        progressCallback('正在获取仓库文件信息...', 10);
        
        totalFileCount = await this.getRepositoryFileCount(svnUrl, username, password);
        if (totalFileCount > 0) {
          this.outputChannel.appendLine(`仓库包含 ${totalFileCount} 个文件`);
          progressCallback(`发现 ${totalFileCount} 个文件，准备开始检出...`, 15);
        } else {
          this.outputChannel.appendLine(`无法获取文件总数，将使用传统进度计算方式`);
          progressCallback('准备开始检出...', 15);
        }
      }
      
      // 获取增强的环境变量配置
      const env = this.getEnhancedEnvironment();
      
      return await new Promise<{ success: boolean; message: string }>((resolve, reject) => {
        // 正确解析命令参数，避免引号问题
        const args = ['checkout', svnUrl, targetDirectory];
        if (username && password) {
          args.push('--username', username, '--password', password);
        }
        args.push('--non-interactive', '--trust-server-cert');
        
        this.outputChannel.appendLine(`[checkout] 实际执行参数: ${JSON.stringify(args)}`);
        
        const svnProcess = cp.spawn('svn', args, {
          cwd: path.dirname(targetDirectory),
          env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let outputBuffer = '';
        let errorBuffer = '';
        let currentProgress = 15;  // 从15%开始，因为前面已经完成了文件总数获取
        let checkedOutFileCount = 0;  // 已检出的文件数量
        
        // 处理标准输出
        svnProcess.stdout?.on('data', (data) => {
          const output = this.processCommandOutput(data.toString());
          outputBuffer += output;
          this.outputChannel.appendLine(`[checkout] 输出: ${output.replace(/\n/g, '\\n')}`);
          
          // 解析进度信息
          if (progressCallback) {
            if (output.includes('A ') || output.includes('添加')) {
              checkedOutFileCount++;
              
              // 根据文件总数计算准确进度
              if (totalFileCount > 0) {
                // 15% - 95% 的范围用于文件检出进度
                const fileProgress = Math.min((checkedOutFileCount / totalFileCount) * 80, 80);
                currentProgress = 15 + fileProgress;
              } else {
                // 传统方式：每个文件增加1%，最大90%
                currentProgress = Math.min(currentProgress + 1, 90);
              }
              
              const match = output.match(/A\s+(.+)/);
              if (match) {
                const fileName = path.basename(match[1]);
                if (totalFileCount > 0) {
                  progressCallback(`正在检出: ${fileName} (${checkedOutFileCount}/${totalFileCount})`, Math.round(currentProgress));
                } else {
                  progressCallback(`正在检出: ${fileName}`, Math.round(currentProgress));
                }
              } else {
                if (totalFileCount > 0) {
                  progressCallback(`正在检出文件... (${checkedOutFileCount}/${totalFileCount})`, Math.round(currentProgress));
                } else {
                  progressCallback('正在检出文件...', Math.round(currentProgress));
                }
              }
            } else if (output.includes('Checked out') || output.includes('检出完成')) {
              progressCallback('检出完成', 100);
            }
          }
        });
        
        // 处理错误输出
        svnProcess.stderr?.on('data', (data) => {
          const error = this.processCommandOutput(data.toString());
          errorBuffer += error;
          this.outputChannel.appendLine(`[checkout] 错误: ${error.replace(/\n/g, '\\n')}`);
          
          // 某些SVN版本会将进度信息输出到stderr
          if (progressCallback && (error.includes('A ') || error.includes('添加'))) {
            checkedOutFileCount++;
            
            // 根据文件总数计算准确进度
            if (totalFileCount > 0) {
              // 15% - 95% 的范围用于文件检出进度
              const fileProgress = Math.min((checkedOutFileCount / totalFileCount) * 80, 80);
              currentProgress = 15 + fileProgress;
            } else {
              // 传统方式：每个文件增加1%，最大90%
              currentProgress = Math.min(currentProgress + 1, 90);
            }
            
            const match = error.match(/A\s+(.+)/);
            if (match) {
              const fileName = path.basename(match[1]);
              if (totalFileCount > 0) {
                progressCallback(`正在检出: ${fileName} (${checkedOutFileCount}/${totalFileCount})`, Math.round(currentProgress));
              } else {
                progressCallback(`正在检出: ${fileName}`, Math.round(currentProgress));
              }
            }
          }
        });
        
        // 处理进程退出
        svnProcess.on('close', (code) => {
          this.outputChannel.appendLine(`[checkout] 进程退出，代码: ${code}`);
          
          if (code === 0) {
            // 检出成功
            const successMessage = `SVN检出成功完成\n目标目录: ${targetDirectory}`;
            this.outputChannel.appendLine(successMessage);
            this.outputChannel.appendLine('========== SVN检出操作完成 ==========');
            
            if (progressCallback) {
              progressCallback('检出完成', 100);
            }
            
            resolve({
              success: true,
              message: successMessage
            });
          } else {
            // 检出失败
            let errorMessage = errorBuffer || '检出操作失败';
            
            // 分析错误类型
            if (errorBuffer.includes('E170001') || errorBuffer.includes('Authentication failed')) {
              errorMessage = '认证失败：用户名或密码错误';
            } else if (errorBuffer.includes('E170013') || errorBuffer.includes('Unable to connect')) {
              errorMessage = '无法连接到SVN服务器：请检查网络连接和服务器地址';
            } else if (errorBuffer.includes('E200014') || errorBuffer.includes('Not found')) {
              errorMessage = 'SVN地址不存在：请检查仓库地址是否正确';
            } else if (errorBuffer.includes('E155000') || errorBuffer.includes('already a working copy')) {
              errorMessage = '目标目录已经是一个SVN工作副本';
            }
            
            this.outputChannel.appendLine(`错误: ${errorMessage}`);
            this.outputChannel.appendLine('========== SVN检出操作失败 ==========');
            
            if (progressCallback) {
              progressCallback('检出失败', 0);
            }
            
            resolve({
              success: false,
              message: errorMessage
            });
          }
        });
        
        // 处理进程错误
        svnProcess.on('error', (error) => {
          this.outputChannel.appendLine(`[checkout] 进程错误: ${error.message}`);
          this.outputChannel.appendLine('========== SVN检出操作失败 ==========');
          
          if (progressCallback) {
            progressCallback('检出失败', 0);
          }
          
          resolve({
            success: false,
            message: `检出进程启动失败: ${error.message}`
          });
        });
        
        // 设置超时（30分钟）
        setTimeout(() => {
          svnProcess.kill();
          this.outputChannel.appendLine('[checkout] 检出操作超时');
          this.outputChannel.appendLine('========== SVN检出操作超时 ==========');
          
          if (progressCallback) {
            progressCallback('检出超时', 0);
          }
          
          resolve({
            success: false,
            message: '检出操作超时（30分钟），可能是文件过多或网络问题'
          });
        }, 30 * 60 * 1000); // 30分钟超时
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[checkout] 检出操作异常: ${error.message}`);
      this.outputChannel.appendLine('========== SVN检出操作失败 ==========');
      
      if (progressCallback) {
        progressCallback('检出失败', 0);
      }
      
      return {
        success: false,
        message: `检出操作失败: ${error.message}`
      };
    }
  }

  /**
   * 扫描文件夹中的冲突文件
   * @param folderPath 文件夹路径
   * @param progressCallback 进度回调函数
   * @returns 冲突文件列表
   */
  public async scanConflicts(
    folderPath: string,
    progressCallback?: (currentFile: string, progress: number) => void
  ): Promise<ConflictFile[]> {
    this.showOutputChannel('SVN冲突扫描');
    this.outputChannel.appendLine(`扫描路径: ${folderPath}`);
    
    try {
      const conflictFiles: ConflictFile[] = [];
      
      // 执行 svn status 命令查找冲突文件
      this.outputChannel.appendLine('正在执行SVN status命令查找冲突文件...');
      const statusResult = await this.executeSvnCommand('status', folderPath, false);
      
      // 解析状态输出，查找状态为 'C' 的文件
      const lines = statusResult.split('\n').map(line => line.trim()).filter(line => line);
      
      let processedCount = 0;
      const totalLines = lines.length;
      
      for (const line of lines) {
        // SVN status 输出格式：第一列是状态码，后面是文件路径
        if (line.length === 0) continue;
        
        const status = line[0];
        const match = line.match(/^.\s+(.+)$/);
        const filePath = match ? match[1].trim() : line.substring(1).trim();
        
        if (status === 'C') {
          // 找到冲突文件
          const absolutePath = path.resolve(folderPath, filePath);
          
          // 检测冲突类型
          const conflictType = await this._detectConflictType(absolutePath);
          
          conflictFiles.push({
            path: absolutePath,
            displayName: filePath,
            conflictType,
            status: '冲突'
          });
          
          this.outputChannel.appendLine(`发现冲突文件: ${filePath} (${conflictType === 'text' ? '文本冲突' : conflictType === 'tree' ? '树冲突' : '属性冲突'})`);
        }
        
        processedCount++;
        if (progressCallback) {
          const progress = Math.round((processedCount / totalLines) * 100);
          progressCallback(filePath, progress);
        }
      }
      
      this.outputChannel.appendLine(`扫描完成，共发现 ${conflictFiles.length} 个冲突文件`);
      this.outputChannel.appendLine('========== SVN冲突扫描完成 ==========');
      
      return conflictFiles;
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN冲突扫描失败 ==========');
      throw error;
    }
  }

  /**
   * 检测冲突类型
   * @param filePath 文件路径
   * @returns 冲突类型
   */
  private async _detectConflictType(filePath: string): Promise<'text' | 'tree' | 'property'> {
    try {
      // 检查是否存在冲突标记文件
      const mineFile = `${filePath}.mine`;
      const theirsFile = `${filePath}.theirs`;
      const workingFile = `${filePath}.working`;
      
      const hasMine = await fsExists(mineFile);
      const hasTheirs = await fsExists(theirsFile);
      const hasWorking = await fsExists(workingFile);
      
      // 如果存在这些文件，通常是文本冲突
      if (hasMine || hasTheirs || hasWorking) {
        return 'text';
      }
      
      // 检查文件内容中是否有冲突标记
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('<<<<<<<') && content.includes('=======') && content.includes('>>>>>>>')) {
          return 'text';
        }
      } catch {
        // 文件可能不存在或无法读取
      }
      
      // 检查是否是树冲突（通过 svn info 或 status 详细信息）
      try {
        const infoResult = await this.executeSvnCommand(`info "${filePath}"`, path.dirname(filePath), false);
        if (infoResult.includes('Tree conflict') || infoResult.includes('树冲突')) {
          return 'tree';
        }
      } catch {
        // 忽略错误
      }
      
      // 默认返回文本冲突
      return 'text';
    } catch (error) {
      this.outputChannel.appendLine(`[_detectConflictType] 检测冲突类型失败: ${error}`);
      return 'text'; // 默认返回文本冲突
    }
  }

  /**
   * 获取冲突文件详情
   * @param filePath 文件路径
   * @returns 冲突详情
   */
  public async getConflictDetails(filePath: string): Promise<ConflictDetails> {
    this.outputChannel.appendLine(`\n[getConflictDetails] 获取冲突详情: ${filePath}`);
    
    try {
      const conflictType = await this._detectConflictType(filePath);
      const details: ConflictDetails = {
        filePath,
        conflictType
      };
      
      // 如果是文本冲突，尝试读取各个版本的内容
      if (conflictType === 'text') {
        try {
          const mineFile = `${filePath}.mine`;
          const theirsFile = `${filePath}.theirs`;
          const workingFile = `${filePath}.working`;
          
          if (await fsExists(mineFile)) {
            details.mineContent = fs.readFileSync(mineFile, 'utf8');
          }
          
          if (await fsExists(theirsFile)) {
            details.theirsContent = fs.readFileSync(theirsFile, 'utf8');
          }
          
          if (await fsExists(workingFile)) {
            details.workingContent = fs.readFileSync(workingFile, 'utf8');
          }
          
          // 读取当前工作文件内容
          if (await fsExists(filePath)) {
            const currentContent = fs.readFileSync(filePath, 'utf8');
            details.baseContent = currentContent;
            
            // 检测冲突标记位置
            details.conflictMarkers = this._detectConflictMarkers(currentContent);
          }
        } catch (error: any) {
          this.outputChannel.appendLine(`[getConflictDetails] 读取冲突文件内容失败: ${error.message}`);
        }
      }
      
      return details;
    } catch (error: any) {
      this.outputChannel.appendLine(`[getConflictDetails] 获取冲突详情失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 检测冲突标记位置
   * @param content 文件内容
   * @returns 冲突标记位置数组
   */
  private _detectConflictMarkers(content: string): Array<{ start: number; end: number; type: 'mine' | 'theirs' | 'both' }> {
    const markers: Array<{ start: number; end: number; type: 'mine' | 'theirs' | 'both' }> = [];
    const lines = content.split('\n');
    
    let inConflict = false;
    let conflictStart = 0;
    let mineStart = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('<<<<<<<')) {
        inConflict = true;
        conflictStart = i;
        mineStart = i;
      } else if (line.includes('=======') && inConflict) {
        // 中间分隔符
      } else if (line.includes('>>>>>>>') && inConflict) {
        markers.push({
          start: conflictStart,
          end: i,
          type: 'both'
        });
        inConflict = false;
      }
    }
    
    return markers;
  }

  /**
   * 解决冲突（使用指定策略）
   * @param filePath 文件路径
   * @param strategy 解决策略：mine(使用本地), theirs(使用服务器), working(使用工作副本)
   */
  public async resolveConflict(filePath: string, strategy: 'mine' | 'theirs' | 'working'): Promise<void> {
    this.showOutputChannel('SVN冲突解决');
    this.outputChannel.appendLine(`解决文件: ${filePath}`);
    this.outputChannel.appendLine(`解决策略: ${strategy === 'mine' ? '使用本地版本' : strategy === 'theirs' ? '使用服务器版本' : '使用工作副本版本'}`);
    
    try {
      // 特殊处理：如果文件名包含@符号，需要转义
      let escapedPath = filePath;
      if (filePath.includes('@')) {
        escapedPath = `${filePath}@`;
      }
      
      // 将策略转换为SVN命令的正确参数
      // SVN的--accept参数值：mine-full(本地版本), theirs-full(服务器版本), working(工作副本)
      let acceptValue: string;
      switch (strategy) {
        case 'mine':
          acceptValue = 'mine-full';
          break;
        case 'theirs':
          acceptValue = 'theirs-full';
          break;
        case 'working':
          acceptValue = 'working';
          break;
        default:
          acceptValue = 'working';
      }
      
      this.outputChannel.appendLine(`SVN命令参数: --accept ${acceptValue}`);
      
      // 执行 svn resolve 命令
      const cwd = path.dirname(filePath);
      const fileName = path.basename(escapedPath);
      
      // 如果有自定义SVN根目录，检查是否需要使用它
      if (this.getCustomSvnRoot()) {
        try {
          await this.executeSvnCommand('info', filePath);
        } catch (error) {
          const relativePath = path.relative(this.getCustomSvnRoot()!, filePath);
          if (!relativePath.startsWith('..')) {
            let finalPath = relativePath;
            if (relativePath.includes('@')) {
              finalPath = `${relativePath}@`;
            }
            const result = await this.executeSvnCommand(`resolve --accept ${acceptValue} "${finalPath}"`, this.getCustomSvnRoot()!);
            this.outputChannel.appendLine(result);
            this.outputChannel.appendLine('========== SVN冲突解决完成 ==========');
            return;
          }
        }
      }
      
      const result = await this.executeSvnCommand(`resolve --accept ${acceptValue} "${fileName}"`, cwd);
      this.outputChannel.appendLine(result);
      this.outputChannel.appendLine('========== SVN冲突解决完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN冲突解决失败 ==========');
      throw error;
    }
  }

  /**
   * 标记冲突已解决
   * @param filePath 文件路径
   */
  public async markResolved(filePath: string): Promise<void> {
    this.showOutputChannel('SVN标记冲突已解决');
    this.outputChannel.appendLine(`文件: ${filePath}`);
    
    try {
      // 使用 mine 策略标记已解决（假设用户已经手动编辑了文件）
      await this.resolveConflict(filePath, 'mine');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== 标记冲突已解决失败 ==========');
      throw error;
    }
  }

  /**
   * 批量解决冲突
   * @param filePaths 文件路径数组
   * @param strategy 解决策略
   * @param progressCallback 进度回调函数
   */
  public async resolveConflicts(
    filePaths: string[],
    strategy: 'mine' | 'theirs' | 'working',
    progressCallback?: (currentFile: string, progress: number) => void
  ): Promise<void> {
    this.showOutputChannel('SVN批量解决冲突');
    this.outputChannel.appendLine(`文件数量: ${filePaths.length}`);
    this.outputChannel.appendLine(`解决策略: ${strategy === 'mine' ? '使用本地版本' : strategy === 'theirs' ? '使用服务器版本' : '使用工作副本版本'}`);
    
    try {
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        this.outputChannel.appendLine(`\n正在解决第 ${i + 1}/${filePaths.length} 个文件: ${filePath}`);
        
        if (progressCallback) {
          const progress = Math.round(((i + 1) / filePaths.length) * 100);
          progressCallback(filePath, progress);
        }
        
        try {
          await this.resolveConflict(filePath, strategy);
        } catch (error: any) {
          this.outputChannel.appendLine(`解决文件失败: ${filePath}, 错误: ${error.message}`);
          // 继续处理下一个文件
        }
      }
      
      this.outputChannel.appendLine(`\n批量解决完成，共处理 ${filePaths.length} 个文件`);
      this.outputChannel.appendLine('========== SVN批量解决冲突完成 ==========');
    } catch (error: any) {
      this.outputChannel.appendLine(`错误: ${error.message}`);
      this.outputChannel.appendLine('========== SVN批量解决冲突失败 ==========');
      throw error;
    }
  }
}
