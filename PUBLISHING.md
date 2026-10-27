# 发布 VSCode SVN 插件到插件市场

本文档介绍如何将 VSCode SVN 插件发布到 Visual Studio Code 插件市场。

## 前提条件

1. **Microsoft 账号**：您需要一个 Microsoft 账号来访问 [Visual Studio Marketplace](https://marketplace.visualstudio.com/)。

2. **Personal Access Token (PAT)**：您需要一个 Azure DevOps PAT 来发布插件。

3. **安装 vsce**：`vsce` 是 VS Code Extension Manager，用于管理和发布 VS Code 插件。
   ```bash
   npm install -g @vscode/vsce
   ```

## 获取 Personal Access Token (PAT)

1. 访问 [Azure DevOps](https://dev.azure.com/)
2. 登录您的 Microsoft 账号
3. 点击右上角的用户图标，选择 "Personal access tokens"
4. 点击 "+ New Token"
5. 设置名称（例如 "VSCode Extension Publishing"）
6. 选择组织（通常是 "All accessible organizations"）
7. 设置过期时间（根据需要选择）
8. 在 "Scopes" 部分，选择 "Custom defined"，然后选择 "Marketplace > Manage"
9. 点击 "Create" 并复制生成的 token（这个 token 只会显示一次）

## 发布流程

### 手动发布

1. **准备 package.json**：确保 package.json 文件中包含以下字段：
   - `publisher`：您的发布者 ID
   - `name`：插件的唯一名称
   - `version`：遵循语义化版本规范的版本号
   - `engines.vscode`：支持的 VS Code 版本范围
   - `description`：插件的简短描述
   - `categories`：插件的分类
   - `icon`：插件的图标（128x128 像素的 PNG 文件）

2. **登录 vsce**：
   ```bash
   vsce login <publisher>
   ```
   系统会提示您输入之前获取的 PAT。

3. **打包插件**：
   ```bash
   vsce package
   ```
   这将创建一个 .vsix 文件。

4. **发布插件**：
   ```bash
   vsce publish
   ```
   或者指定版本：
   ```bash
   vsce publish [major|minor|patch]
   ```

### 使用自动化脚本

我们提供了一个自动化脚本 `publish.sh` 来简化发布流程：

1. 确保脚本有执行权限：
   ```bash
   chmod +x publish.sh
   ```

2. 运行脚本：
   ```bash
   ./publish.sh
   ```

3. 按照脚本提示操作：
   - 选择版本更新类型
   - 确认是否发布到插件市场
   - 输入 PAT（如果需要）
   - 确认是否提交版本更新到 Git

## 更新已发布的插件

更新插件的流程与首次发布相同，但需要确保：

1. 更新 `package.json` 中的 `version` 字段
2. 更新 `CHANGELOG.md` 文件，记录新版本的变更
3. 使用 `vsce publish` 或自动化脚本发布更新

## 常见问题

### vsce 打包报 "Extension entrypoint(s) missing"

如果项目所在目录路径中包含**形似 UUID 的段落**（如 `draft-0a8c1bd7-ff24-4f31-8d8e-e89dfa72dd86`），新版 npm（内置 `@npmcli/redact` 脱敏模块）会把 `npm list --parseable` 输出中的这段路径脱敏为 `***`。vsce 依赖该输出定位依赖目录，拿到不存在的路径后会收集不到任何文件，报错：

```
ERROR  Extension entrypoint(s) missing. Make sure these files exist
and aren't ignored by '.vscodeignore': extension/out/extension.js
```

**解决办法**：把仓库复制到不含 UUID 的普通路径下再打包，例如：

```bash
cp -R /path/to/vscode-svn /tmp/vsce-build
cd /tmp/vsce-build && vsce package
```

### 发布失败

如果发布失败，可能的原因包括：

1. **PAT 无效或过期**：重新生成 PAT
2. **版本号冲突**：确保版本号比已发布的版本高
3. **package.json 缺少必要字段**：检查是否包含所有必要字段

### 删除已发布的插件

一旦插件发布，无法完全删除，但可以：

1. 将插件标记为不推荐：
   ```bash
   vsce unpublish (publisher).(extension)
   ```

2. 删除特定版本：
   ```bash
   vsce unpublish (publisher).(extension)@(version)
   ```

## 相关资源

- [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [vsce CLI](https://github.com/microsoft/vscode-vsce)
- [Visual Studio Marketplace](https://marketplace.visualstudio.com/) 