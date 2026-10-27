import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http'

/**
 * AI服务类，用于生成SVN提交日志
 */
export class AiService {
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('SVN AI 生成提交日志');
  }

  /**
   * 检查AI配置是否完整
   */
  private checkAiConfig(): { apiUrl: string; modelId: string; apiKey: string } | null {
    const config = vscode.workspace.getConfiguration('vscode-svn');
    const apiUrl = config.get<string>('aiApiUrl') || '';
    const modelId = config.get<string>('aiModelId') || '';
    const apiKey = config.get<string>('aiApiKey') || '';

    if (!apiUrl || !modelId || !apiKey) {
      return null;
    }

    return { apiUrl, modelId, apiKey };
  }

  /**
   * 配置引导 - 引导用户设置AI配置
   */
  public async configureAI(): Promise<{ apiUrl: string; modelId: string; apiKey: string } | null> {
    // 使用更显眼的警告消息框，并提供更详细的说明
    const choice = await vscode.window.showWarningMessage(
      '🤖 AI功能需要配置\n\n' +
      '要使用AI生成提交日志功能，需要先配置AI服务信息：\n' +
      '• API访问地址\n' +
      '• 模型ID\n' +
      '• API密钥\n\n' +
      '支持OpenAI、通义千问、文心一言等多种AI服务',
      { modal: true }, // 设置为模态对话框，更加显眼
      '🚀 立即配置',
      '📖 查看配置说明',
      '❌ 取消'
    );

    if (choice === '📖 查看配置说明') {
      // 显示配置说明
      await this.showConfigurationGuide();
      // 再次询问是否配置
      const retryChoice = await vscode.window.showInformationMessage(
        '查看完配置说明后，是否现在开始配置AI服务？',
        { modal: true },
        '🚀 开始配置',
        '❌ 取消'
      );
      if (retryChoice !== '🚀 开始配置') {
        return null;
      }
    } else if (choice !== '🚀 立即配置') {
      return null;
    }

    // 显示配置进度提示
    await vscode.window.showInformationMessage(
      '🚀 开始AI服务配置\n\n接下来将分3步完成配置：\n1️⃣ API访问地址\n2️⃣ 模型ID\n3️⃣ API密钥',
      { modal: true },
      '✅ 开始第一步'
    );

    // 配置API地址
    const apiUrl = await vscode.window.showInputBox({
      title: '🔗 第1步：配置API访问地址',
      prompt: '请输入AI服务的API访问地址（完整的URL）',
      placeHolder: '例如: https://api.openai.com/v1/chat/completions',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return 'API地址不能为空';
        }
        if (!value.startsWith('http://') && !value.startsWith('https://')) {
          return 'API地址必须以 http:// 或 https:// 开头';
        }
        return null;
      }
    });

    if (!apiUrl) {
      vscode.window.showWarningMessage('❌ 配置已取消：API地址不能为空');
      return null;
    }

    // 配置模型ID
    const modelId = await vscode.window.showInputBox({
      title: '🤖 第2步：配置AI模型ID',
      prompt: '请输入AI模型ID或名称',
      placeHolder: '例如: gpt-3.5-turbo、qwen-turbo、ernie-bot',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return '模型ID不能为空';
        }
        return null;
      }
    });

    if (!modelId) {
      vscode.window.showWarningMessage('❌ 配置已取消：模型ID不能为空');
      return null;
    }

    // 配置API密钥
    const apiKey = await vscode.window.showInputBox({
      title: '🔑 第3步：配置API密钥',
      prompt: '请输入AI服务的API密钥（将安全保存到VSCode设置中）',
      password: true,
      placeHolder: 'sk-... 或其他格式的API密钥',
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim() === '') {
          return 'API密钥不能为空';
        }
        if (value.length < 10) {
          return 'API密钥长度似乎太短，请检查是否完整';
        }
        return null;
      }
    });

    if (!apiKey) {
      vscode.window.showWarningMessage('❌ 配置已取消：API密钥不能为空');
      return null;
    }

    // 保存配置
    const config = vscode.workspace.getConfiguration('vscode-svn');
    try {
      await config.update('aiApiUrl', apiUrl, vscode.ConfigurationTarget.Global);
      await config.update('aiModelId', modelId, vscode.ConfigurationTarget.Global);
      await config.update('aiApiKey', apiKey, vscode.ConfigurationTarget.Global);
      
      // 询问是否测试连接
      const testChoice = await vscode.window.showInformationMessage(
        '✅ AI配置已保存成功！\n\n是否要测试AI服务连接？',
        { modal: true },
        '🧪 测试连接',
        '✅ 稍后测试'
      );

      if (testChoice === '🧪 测试连接') {
        const testResult = await this.testAiConnection({ apiUrl, modelId, apiKey });
        if (!testResult) {
          // 测试失败，用户可能已经重新配置，返回null表示需要重新获取配置
          return null;
        }
      }
      
      return { apiUrl, modelId, apiKey };
    } catch (error: any) {
      vscode.window.showErrorMessage(`❌ 保存AI配置失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 显示配置说明指南
   */
  private async showConfigurationGuide(): Promise<void> {
    const configGuide = `
🤖 AI服务配置指南

支持的AI服务：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔹 OpenAI GPT
   • API地址: https://api.openai.com/v1/chat/completions
   • 模型ID: gpt-3.5-turbo 或 gpt-4
   • API密钥: sk-...（从OpenAI官网获取）

🔹 通义千问（推荐使用兼容模式）
   • API地址: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
   • 模型ID: qwen-turbo / qwen-plus / qwen-max
   • API密钥: sk-...（从阿里云百炼控制台获取）

🔹 通义千问（原生接口，已自动适配）
   • API地址: https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation
   • 模型ID: qwen-turbo 或 qwen-plus
   • API密钥: sk-...

🔹 文心一言
   • API地址: https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions
   • 模型ID: ernie-bot 或 ernie-bot-turbo
   • API密钥: 从百度智能云控制台获取

🔹 本地AI服务（如Ollama）
   • API地址: http://localhost:11434/v1/chat/completions
   • 模型ID: llama2 或其他本地模型名称
   • API密钥: 可以为空或任意字符串

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 配置提示：
   • 确保API地址格式正确，包含完整的协议和路径
   • 模型ID必须是服务商支持的模型名称
   • API密钥需要有相应的访问权限
   • 本地服务需要确保服务已启动且可访问
`;

    await vscode.window.showInformationMessage(
      configGuide,
      { modal: true },
      '✅ 我已了解'
    );
  }

  /**
   * 测试AI服务连接
   */
  private async testAiConnection(config: { apiUrl: string; modelId: string; apiKey: string }): Promise<boolean> {
    try {
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '🧪 正在测试AI服务连接...',
        cancellable: false
      }, async (progress) => {
        progress.report({ increment: 50 });
        
        // 发送一个简单的测试请求
        const testPrompt = '请回复"连接测试成功"';
        const response = await this.callAiApi(testPrompt, config);
        
        progress.report({ increment: 50 });
        
        if (response && response.trim().length > 0) {
          vscode.window.showInformationMessage(
            `🎉 AI服务连接测试成功！\n\n测试响应: ${response.substring(0, 100)}${response.length > 100 ? '...' : ''}`,
            { modal: true }
          );
          return true;
        } else {
          // 响应为空，询问是否重新配置
          const choice = await vscode.window.showWarningMessage(
            '⚠️ AI服务连接成功，但响应为空\n\n可能原因：\n• 模型ID不正确\n• API密钥权限不足\n• 服务配置有误',
            { modal: true },
            '🔧 重新配置',
            '✅ 忽略继续'
          );
          
          if (choice === '🔧 重新配置') {
            await this.handleConfigurationRetry();
            return false;
          }
          return true;
        }
      });
    } catch (error: any) {
      // 测试失败，询问是否重新配置
      const choice = await vscode.window.showErrorMessage(
        `❌ AI服务连接测试失败\n\n错误信息: ${error.message}\n\n请检查：\n• API地址是否正确\n• 模型ID是否支持\n• API密钥是否有效\n• 网络连接是否正常`,
        { modal: true },
        '🔧 重新配置',
        '📖 查看配置说明',
        '❌ 取消'
      );
      
      if (choice === '🔧 重新配置') {
        await this.handleConfigurationRetry();
      } else if (choice === '📖 查看配置说明') {
        await this.showConfigurationGuide();
        // 显示配置说明后，询问是否重新配置
        const retryChoice = await vscode.window.showInformationMessage(
          '查看完配置说明后，是否重新配置AI服务？',
          { modal: true },
          '🔧 重新配置',
          '❌ 取消'
        );
        if (retryChoice === '🔧 重新配置') {
          await this.handleConfigurationRetry();
        }
      }
      return false;
    }
  }

  /**
   * 处理配置重试 - 重新开启配置引导
   */
  private async handleConfigurationRetry(): Promise<void> {
    const retryChoice = await vscode.window.showWarningMessage(
      '🔄 重新配置AI服务\n\n将清除当前配置并重新开始配置流程',
      { modal: true },
      '🚀 开始重新配置',
      '❌ 取消'
    );

    if (retryChoice === '🚀 开始重新配置') {
      // 清除当前配置
      const config = vscode.workspace.getConfiguration('vscode-svn');
      try {
        await config.update('aiApiUrl', '', vscode.ConfigurationTarget.Global);
        await config.update('aiModelId', '', vscode.ConfigurationTarget.Global);
        await config.update('aiApiKey', '', vscode.ConfigurationTarget.Global);
        
        // 重新开启配置引导
        const newConfig = await this.configureAI();
        if (newConfig) {
          vscode.window.showInformationMessage(
            '🎉 AI服务重新配置完成！',
            { modal: true }
          );
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`❌ 清除配置失败: ${error.message}`);
      }
    }
  }

  /**
   * 生成SVN提交日志
   * @param diffContent SVN差异内容
   * @returns 生成的提交日志
   */
  public async generateCommitMessage(diffContent: string): Promise<string> {
    // 根据配置选择AI来源：editor=编辑器内置AI（Language Model API），custom=自定义API（默认）
    const provider = vscode.workspace.getConfiguration('vscode-svn').get<string>('aiProvider', 'custom');
    if (provider === 'editor') {
      return this.generateCommitMessageFromEditor(diffContent);
    }

    try {
      // 检查配置
      let aiConfig = this.checkAiConfig();
      
      // 如果配置不完整，引导用户配置
      if (!aiConfig) {
        aiConfig = await this.configureAI();
        if (!aiConfig) {
          return '';
        }
      }

      // 准备发送给AI的提示
      const prompt = this.preparePrompt(diffContent);
      this.outputChannel.appendLine(`[generateCommitMessage] 使用AI服务: ${aiConfig.apiUrl}`);
      this.outputChannel.appendLine(`[generateCommitMessage] 使用模型: ${aiConfig.modelId}`);
      
      // 显示进度提示
      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在生成SVN提交日志...',
        cancellable: false
      }, async (progress) => {
        progress.report({ increment: 30 });
        
        const response = await this.callAiApi(prompt, aiConfig!);
        
        progress.report({ increment: 70 });
        
        return response;
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[generateCommitMessage] AI调用失败: ${error.message}`);
      
      // AI调用失败，询问是否重新配置
      const choice = await vscode.window.showErrorMessage(
        `❌ AI生成提交日志失败\n\n错误信息: ${error.message}\n\n可能原因：\n• AI服务配置错误\n• 网络连接问题\n• API配额不足\n• 模型不支持`,
        { modal: true },
        '🔧 重新配置AI',
        '🔄 重试',
        '❌ 取消'
      );
      
      if (choice === '🔧 重新配置AI') {
        await this.handleConfigurationRetry();
        // 重新配置后，重新尝试生成（最多重试一次）
        const newConfig = this.checkAiConfig();
        if (newConfig) {
          try {
            const prompt = this.preparePrompt(diffContent);
            return await this.callAiApi(prompt, newConfig);
          } catch (retryError: any) {
            vscode.window.showErrorMessage(`重试后仍然失败: ${retryError.message}`);
            return '';
          }
        }
      } else if (choice === '🔄 重试') {
        // 直接重试一次
        try {
          const aiConfig = this.checkAiConfig();
          if (aiConfig) {
            const prompt = this.preparePrompt(diffContent);
            return await this.callAiApi(prompt, aiConfig);
          } else {
            vscode.window.showErrorMessage('AI配置不完整，无法重试');
            return '';
          }
        } catch (retryError: any) {
          vscode.window.showErrorMessage(`重试失败: ${retryError.message}`);
          return '';
        }
      }
      
      return '';
    }
  }

  /**
   * 使用编辑器内置AI生成提交日志（通过 Language Model API）
   * 适用于 Qoder、Trae、VS Code Copilot 等内置AI模型的编辑器，无需配置API地址和密钥
   * @param diffContent SVN差异内容
   * @returns 生成的提交日志
   */
  private async generateCommitMessageFromEditor(diffContent: string): Promise<string> {
    try {
      // 运行时特性检测：老版本编辑器可能没有 vscode.lm API
      const lm = (vscode as any).lm;
      if (!lm || typeof lm.selectChatModels !== 'function') {
        throw new Error('当前编辑器不支持内置AI（缺少 Language Model API）。请将配置 vscode-svn.aiProvider 改回 custom 并配置API信息');
      }

      const models = await lm.selectChatModels({});
      if (!models || models.length === 0) {
        throw new Error('当前编辑器没有可用的内置AI模型。请确认已在编辑器中登录AI服务；或改回 custom 方式并配置API信息');
      }

      // 多个模型时让用户选择
      let model = models[0];
      if (models.length > 1) {
        const items: (vscode.QuickPickItem & { model: any })[] = models.map((m: any, index: number) => ({
          label: m.name || m.family || `模型${index + 1}`,
          description: `${m.vendor || ''} ${m.family || ''} ${m.id || ''}`.trim(),
          model: m
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: '选择用于生成提交日志的编辑器内置AI模型'
        });
        if (!picked) {
          return '';
        }
        model = picked.model;
      }

      this.outputChannel.appendLine(`[generateCommitMessageFromEditor] 使用编辑器内置模型: ${model.family || model.name || 'unknown'}`);

      return await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在使用编辑器内置AI生成SVN提交日志...',
        cancellable: true
      }, async (progress, token) => {
        progress.report({ increment: 20 });

        const prompt = this.preparePrompt(diffContent);
        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const response = await model.sendRequest(messages, {}, token);

        // 聚合流式返回的文本
        let result = '';
        let lastReport = 20;
        for await (const chunk of response.text) {
          result += chunk;
          if (token.isCancellationRequested) {
            break;
          }
          // 进度按内容长度缓慢推进，避免一直停在20%
          if (result.length > lastReport * 40) {
            lastReport = Math.min(90, lastReport + 10);
            progress.report({ increment: 10 });
          }
        }

        const trimmed = result.trim();
        this.outputChannel.appendLine(`[generateCommitMessageFromEditor] 生成完成，内容长度: ${trimmed.length}`);
        return trimmed;
      });
    } catch (error: any) {
      this.outputChannel.appendLine(`[generateCommitMessageFromEditor] 失败: ${error.message}`);
      vscode.window.showErrorMessage(
        `使用编辑器内置AI生成提交日志失败: ${error.message}`,
        '查看说明'
      ).then(choice => {
        if (choice === '查看说明') {
          vscode.window.showInformationMessage(
            '编辑器内置AI说明\n\n'
            + '• 该方式通过编辑器的 Language Model API 调用编辑器自带的AI模型（如 Qoder 的通义千问），无需在插件中配置API地址和密钥\n'
            + '• 需要编辑器版本支持且已登录编辑器内置的AI服务\n'
            + '• 如不可用，可将设置 vscode-svn.aiProvider 改回 custom，使用自定义API配置'
          );
        }
      });
      return '';
    }
  }

  /**
   * 准备发送给AI的提示
   * @param diffContent SVN差异内容
   * @returns 格式化的提示
   */
  private preparePrompt(diffContent: string): string {
    // 限制差异内容长度，避免超出AI模型限制
    const maxDiffLength = 50000;
    
    this.outputChannel.appendLine(`[preparePrompt] 差异内容长度: ${diffContent.length}`);
    
    let truncatedDiff = diffContent;
    if (diffContent.length > maxDiffLength) {
      truncatedDiff = diffContent.substring(0, maxDiffLength) + '\n...(内容已截断，完整差异过长)';
      this.outputChannel.appendLine(`[preparePrompt] 差异内容已截断到 ${maxDiffLength} 字符`);
    }
    
    return `你是一个专业的SVN提交日志生成助手。请根据以下SVN差异内容，生成一个详细的提交日志。

要求：
1. 按文件名分段落输出，每个文件的修改内容单独一段
2. 每个文件段落的格式如下：
   - 第一行：文件名
   - 第二行开始：总结重点，分点说明修改内容，简答易懂，每个要点一行

3. 分析要点应包含：
   - 修改了什么功能或内容
   - 修改的目的或原因
   - 可能产生的影响
   - 忽略无用的修改分析，例如只是一些换行、空格等

4. 对于每个文件的修改，要根据实际意义换行显示，使日志更易读
5. 使用中文，内容简单清晰

SVN差异内容:
${truncatedDiff}

提交日志:
`;
  }

  /**
   * 调用AI API
   * @param prompt 提示内容
   * @param config AI配置
   * @returns AI生成的回复
   */
  /**
   * 判断是否为 DashScope（阿里云通义千问）原生接口
   * 原生接口路径形如：/api/v1/services/aigc/text-generation/generation
   * 兼容模式接口（compatible-mode）使用标准 OpenAI 格式，不在此列
   */
  private isDashScopeNativeApi(apiUrl: string): boolean {
    try {
      const url = new URL(apiUrl);
      const host = url.hostname.toLowerCase();
      const pathname = url.pathname.toLowerCase();
      const isDashScopeHost = host.endsWith('dashscope.aliyuncs.com') || host.endsWith('dashscope-intl.aliyuncs.com');
      if (!isDashScopeHost) {
        return false;
      }
      // compatible-mode 走标准 OpenAI 格式
      if (pathname.includes('/compatible-mode/')) {
        return false;
      }
      // 原生 aigc 接口（包括 text-generation、multimodal-generation 等）
      return pathname.includes('/services/aigc/') || pathname.endsWith('/generation');
    } catch {
      return false;
    }
  }

  private callAiApi(prompt: string, config: { apiUrl: string; modelId: string; apiKey: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      // 解析URL，根据接口类型选择请求体格式
      const url = new URL(config.apiUrl);
      const isDashScopeNative = this.isDashScopeNativeApi(config.apiUrl);

      // 系统消息 / 用户消息
      const systemPrompt = '你是一个专业的代码提交信息生成助手。请根据提供的代码差异生成简洁、准确的中文提交信息。';

      // 构建请求体：
      // - DashScope 原生接口（/api/v1/services/aigc/text-generation/generation）使用 input.messages + parameters 格式
      // - 其它（OpenAI 兼容、百炼 compatible-mode、文心、OpenAI、deepseek 等）使用 OpenAI Chat Completions 格式
      let requestData: string;
      if (isDashScopeNative) {
        requestData = JSON.stringify({
          model: config.modelId,
          input: {
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt }
            ]
          },
          parameters: {
            temperature: 0.7,
            max_tokens: 2000,
            result_format: 'message'
          }
        });
        this.outputChannel.appendLine('[callAiApi] 检测到 DashScope 原生接口，使用 input.messages 请求格式');
      } else {
        requestData = JSON.stringify({
          model: config.modelId,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 2000
        });
      }

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Length': Buffer.byteLength(requestData)
        }
      };

      const requestModule = url.protocol === 'https:' ? https : http;
      const req = requestModule.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const response = JSON.parse(data);
              
              // 尝试解析不同格式的响应
              let content = '';
              if (response.choices && response.choices[0] && response.choices[0].message) {
                // OpenAI Chat Completions 格式（OpenAI、百炼 compatible-mode、deepseek 等）
                content = (response.choices[0].message.content || '').trim();
              } else if (response.output && response.output.choices && response.output.choices[0] &&
                         response.output.choices[0].message) {
                // DashScope 原生接口 + result_format=message 格式
                content = (response.output.choices[0].message.content || '').trim();
              } else if (response.output && typeof response.output.text === 'string') {
                // DashScope 原生接口 + 默认 text 格式
                content = response.output.text.trim();
              } else if (response.result) {
                // 其它可能的格式（如部分代理）
                content = (typeof response.result === 'string' ? response.result : JSON.stringify(response.result)).trim();
              } else {
                throw new Error('无法解析AI响应格式');
              }
              
              this.outputChannel.appendLine(`[callAiApi] AI响应成功，内容长度: ${content.length}`);
              resolve(content);
            } else {
              this.outputChannel.appendLine(`AI API调用失败 - 状态码: ${res.statusCode}`);
              this.outputChannel.appendLine(`响应数据: ${data}`);
              reject(new Error(`AI API调用失败: ${res.statusCode} - ${data}`));
            }
          } catch (error: any) {
            this.outputChannel.appendLine(`AI API响应解析失败: ${error.message}`);
            this.outputChannel.appendLine(`响应数据: ${data}`);
            reject(new Error(`AI API响应解析失败: ${error.message}`));
          }
        });
      });

      req.on('error', (error: any) => {
        this.outputChannel.appendLine(`AI API网络请求失败: ${error.message}`);
        reject(new Error(`AI API网络请求失败: ${error.message}`));
      });

      req.write(requestData);
      req.end();
    });
  }
} 
