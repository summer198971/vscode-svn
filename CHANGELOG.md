# 更新日志

## [4.8.4] - 2024-12-30

### 🐛 重要Bug修复
- **修复单文件提交界面错误**: 解决了在扩展宿主环境中使用DOM API导致的 "document is not defined" 错误
- **改进HTML转义实现**: 将HTML转义功能从依赖DOM API改为纯JavaScript实现，提高稳定性
- **提升WebView兼容性**: 确保在所有VSCode版本中都能正常显示提交差异界面

## [4.8.3] - 2024-12-30

### 🌟 重大功能更新：编码问题完全解决

#### 🔧 智能编码检测系统
- **自动编码识别**: 新增智能文件编码检测，支持UTF-8、GBK、GB2312、Big5等常见编码格式
- **BOM标识处理**: 完善对字节顺序标记(BOM)文件的识别和处理
- **编码自动转换**: 实现编码格式自动转换，确保中文内容正确显示
- **乱码修复算法**: 添加智能乱码检测和修复机制

#### ⚙️ 全面配置选项
新增6个编码相关配置选项，让用户可以根据环境自定义编码处理：
- `vscode-svn.defaultFileEncoding`: 默认文件编码（auto/utf8/gbk/gb2312/big5/latin1）
- `vscode-svn.forceUtf8Output`: 强制SVN命令UTF-8输出（推荐开启）
- `vscode-svn.enableEncodingDetection`: 启用自动编码检测
- `vscode-svn.encodingFallbacks`: 编码检测备用列表
- `vscode-svn.showEncodingInfo`: 差异界面显示编码信息

#### 🎨 差异显示增强
- **多类型语法高亮**: 为不同类型的差异行（添加/删除/信息/头部等）提供不同颜色
- **编码信息展示**: 可选择性显示文件编码信息
- **容错显示机制**: 编码转换失败时提供备用显示方案

#### 🚀 技术架构优化
- **跨平台环境变量**: 针对Windows/macOS/Linux优化UTF-8环境配置
- **SVN命令增强**: 为diff命令添加`--force`和`--internal-diff`参数
- **性能优化**: 增加缓冲区大小，支持大文件差异对比
- **错误处理**: 完善的多层错误处理和降级机制

#### 📖 文档完善
- **详细编码指南**: 新增完整的编码问题解决指南
- **配置说明**: 提供所有编码配置选项的详细说明
- **故障排除**: 添加系统性的编码问题排查步骤

### 🎯 解决的问题
- ✅ **彻底解决中文乱码**: 不再受文件原始编码格式限制
- ✅ **差异对比优化**: SVN差异界面完美显示中文内容
- ✅ **跨平台兼容**: 统一不同操作系统下的编码处理
- ✅ **用户友好**: 提供简单配置选项，满足不同用户需求

## [4.8.0] - 2024-12-30

### 📝 文档和营销优化
- **全新插件介绍设计**: 重新设计README.md和package.json描述，突出三大核心优势
  - 🌍 **全平台支持**: 强调Windows/macOS/Linux跨平台兼容性
  - 🤖 **AI智能加持**: 突出AI提交日志生成和代码分析功能
  - 🔓 **100%开源透明**: 强调开源项目的安全性和可定制性
- **技术特点明确化**: 强调基于原生SVN命令行工具，无需TortoiseSVN等图形界面
- **安装指南优化**: 提供详细的跨平台SVN命令行工具安装指南
- **营销徽章添加**: 添加GitHub stars、issues、license等专业徽章
- **社区参与指南**: 完善开源社区参与和贡献指南
- **关键词优化**: 扩展中英文关键词，提高扩展市场搜索可见性

### 🎯 用户体验提升
- **30秒快速上手**: 新增快速开始指南，降低用户学习成本
- **可视化优势展示**: 使用丰富的表情符号和格式化文本提升阅读体验
- **差异化定位**: 明确与传统SVN工具的区别，突出轻量级高性能特点

## [4.7.5] - 2024-12-30

### 🐛 问题修复
- **文件差异查看功能优化**: 修复查看文件差异时的路径解析问题
  - 智能检测远程SSH路径和本地路径，自动选择合适的工作目录
  - 改进SVN仓库URL构建逻辑，避免路径重复导致的文件不存在错误
  - 新增多策略diff命令尝试机制，提高差异获取成功率
  - 优化错误处理和调试日志，提供更详细的问题诊断信息

### 🔧 技术改进
- **路径类型智能检测**: 区分Windows路径、远程Linux路径、本地路径
- **多策略diff命令**: 6种不同的命令策略，包括URL方式、相对路径、文件名等
- **智能URL拼接**: 检查文件路径是否已包含仓库路径部分，避免重复
- **diff输出验证**: 验证diff命令返回内容的有效性，确保获取到正确的差异信息

## [4.7.4] - 2024-12-29

### ✨ 新功能
- **智能版本冲突处理功能**: 提交时自动检测SVN "out of date"错误并引导用户解决
  - 自动检测E155011和E170004错误码，识别版本冲突情况
  - 当其他人已经提交了对相同文件或文件夹的修改时自动触发
  - 提供三种智能处理选项：
    1. **自动更新并重试提交**（推荐）：自动执行SVN更新，更新完成后询问是否继续提交
    2. **仅更新不重试**：仅执行SVN更新，更新完成后提示用户手动重新提交
    3. **取消操作**：不执行任何操作，保持当前状态
  - 友好的中文提示对话框，详细说明冲突原因和解决建议
  - 适用于单文件提交和批量文件提交场景

### 🎨 界面优化
- **模态对话框设计**: 使用模态对话框显示冲突处理选项，避免用户误操作
- **详细说明信息**: 对话框包含详细的冲突原因说明和操作建议
- **操作确认机制**: 自动更新完成后会询问用户是否继续提交，确保用户了解更新结果

### 🔧 技术改进
- 在SvnService类中新增isOutOfDateError()方法，智能识别版本冲突错误
- 新增handleOutOfDateError()方法，提供完整的冲突处理流程
- 完善的错误处理机制，确保更新失败时不会影响原有工作副本状态
- 适配单文件提交和批量提交两种场景，自动选择合适的重试策略

## [4.7.2] - 2024-12-19
- **AI分析智能过滤功能**: 
  - 自动排除二进制文件和无法分析的文件类型（图片、Office文档、压缩包等）
  - 自动排除系统文件和构建产物（node_modules、.git、build目录等）
  - 只分析当前界面显示的文件，避免分析不相关的文件
  - 在分析结果中显示详细的过滤统计信息，包括总文件数、已分析文件数、已排除文件列表
  - 提高AI分析的效率和准确性，减少无效的API调用

## [4.7.1] - 2024-12-19

### ✨ 新功能
- **AI缓存系统优化**: 
  - 缓存结果界面现在会显示明显的"💾 缓存结果"标识和具体的缓存时间
  - 实时分析结果显示"🔄 实时AI分析结果"标识，便于区分结果来源
  - 新增"🔄 重新分析"按钮，支持强制跳过缓存重新获取AI分析结果
  - 优化缓存信息显示，提供更友好的用户体验
- **SVN日志AI代码分析功能**: 在SVN日志面板的右侧详情界面中新增AI分析按钮
  - 点击"🤖 AI分析代码差异"按钮，AI会智能分析当前选中修订版本的所有代码变更
  - 提供专业的技术分析，包括修改目的、功能影响、代码质量评估等
  - 自动识别新增、修改、删除的文件，并针对不同类型的变更提供相应的分析
  - 分析结果在新窗口中显示，支持一键复制分析内容
  - 集成现有的AI服务（OpenAI/通义千问），复用已配置的API密钥

- **AI分析结果智能缓存系统**: 大幅降低AI API调用费用
  - 基于修订版本、文件差异内容和AI模型生成唯一缓存ID
  - 自动缓存分析结果30天，相同差异内容直接使用缓存
  - 缓存文件存储在用户主目录 `~/.vscode-svn-ai-cache/`
  - 支持最多1000条缓存记录，自动清理最旧的记录
  - 提供完整的缓存管理功能：统计信息、清理过期、清空所有缓存

### 🎨 界面优化
- **详情面板增强**: 在SVN日志详情面板头部添加操作按钮区域
- **按钮状态管理**: AI分析按钮支持加载状态显示，防止重复点击
- **视觉一致性**: 新按钮样式与现有界面保持一致的设计语言

### 🔧 技术改进
- 扩展SvnLogPanel类，集成AiService实例
- 添加analyzeRevisionWithAI消息处理机制
- 实现智能差异获取和AI分析逻辑
- 优化错误处理和用户反馈机制
- 增强前后端通信，支持AI分析状态同步
- **新增AiCacheService缓存服务类**：
  - 使用SHA-256算法生成唯一缓存ID
  - 实现缓存的加载、保存、过期清理机制
  - 支持缓存统计和管理功能
  - 在插件启动时自动加载缓存，关闭时保存缓存
- **集成缓存到AI分析流程**：
  - 分析前先检查缓存，命中则直接使用
  - 分析完成后自动缓存结果
  - 在分析结果界面显示缓存状态标识

## [4.7.0] - 2024-12-19

### ✨ 新功能
- **SVN日志筛选数量提示**: 在SVN日志面板中添加了详细的筛选数量和状态提示
  - 工具栏显示当前筛选结果数量，如"(筛选结果: 15 条)"或"(显示: 50 条)"
  - 日志列表顶部显示详细的筛选状态信息
  - 筛选状态包含具体的筛选条件，如"🔍 筛选条件: 作者: 张三, 日期: 2024-01-01 至 2024-01-31"
  - 非筛选状态显示为"📄 显示最新记录"或"📄 显示全部记录"
  - 支持多条件组合筛选的状态显示

### 🎨 界面优化
- **视觉提示增强**: 筛选状态下的数量信息以橙色显示，便于区分筛选和非筛选状态
- **状态信息丰富**: 提供更详细的筛选条件描述，让用户清楚了解当前的筛选状态
- **响应式设计**: 筛选状态信息自适应面板宽度，在不同屏幕尺寸下都能正常显示

### 🔧 技术改进
- 添加筛选状态跟踪机制，准确判断当前是否处于筛选状态
- 优化前后端通信，增加筛选描述信息的传递
- 改进筛选逻辑，支持复杂的多条件筛选状态管理
- 增强日志记录，便于调试和问题排查

## [4.4.4] - 2025-01-29

### ✨ 新功能
- **标签式文件后缀筛选界面**: 将文件夹提交面板中的文件后缀筛选从下拉框改为更直观的标签式界面
  - 每个标签显示后缀名和对应的文件数量，如 `.js (5)` 表示有5个JavaScript文件
  - 点击标签可切换选择状态，选中的标签会高亮显示
  - 添加"全选"和"清空"按钮，方便批量操作
  - 标签支持悬停效果和平滑过渡动画，提供更好的交互体验
  - 自动按字母顺序排列标签，便于查找

### 🎨 界面优化
- **改进用户体验**: 标签式界面比下拉框更直观，用户可以一眼看到所有可用的文件后缀
- **视觉一致性**: 与文件类型筛选的复选框风格保持一致的设计语言
- **响应式设计**: 标签容器支持自动换行，适应不同的面板宽度

### 🔧 技术改进
- 保持向后兼容性，旧的select元素仍然可用（但已隐藏）
- 使用Map数据结构统计文件数量，提高性能
- 优化事件处理逻辑，减少不必要的DOM操作

## [4.4.3] - 2025-01-29

### 🐛 修复
- **模板加载失败问题**: 修复了 `folderCommitPanel` 模板加载失败的路径问题
- **智能路径检测**: 改进了 `TemplateManager` 的路径检测逻辑，支持多种部署环境
- **构建流程优化**: 修改构建脚本，确保模板文件正确复制到打包目录

### 🔧 技术改进
- 添加了智能路径检测，优先查找 `templates/`、`out/templates/`、`src/templates/` 目录
- 修复了双重嵌套 `out/out/templates/` 路径错误
- 完善了错误处理和日志输出

本文档记录VSCode SVN插件的所有重要更改。


## 开发里程碑

### 4.4.2
- **优化文件夹提交面板逻辑**：修复了文件夹提交界面不会刷新的问题
- 当用户右键不同文件夹选择"文件夹提交"时，如果已存在提交面板且路径不同，会自动关闭旧面板并创建新面板
- 如果路径相同，则直接显示现有面板，避免重复创建
- 提升了用户体验，确保提交面板始终显示正确的文件夹内容
- 添加了详细的调试日志，便于问题诊断

### 4.4.1
- **修复SVN特殊字符处理问题**：解决了文件名中包含@符号导致SVN命令执行失败的问题
- 在所有SVN操作（添加、删除、恢复、提交、更新、日志查询等）中正确处理包含@符号的文件名
- 自动添加额外的@符号来转义文件名中的@字符，确保SVN命令能正确识别文件路径
- 增强了文件路径处理逻辑，提高了插件对特殊字符的兼容性
- 详细记录命令执行过程，便于诊断和故障排查

### 4.4.0
- **新增文件夹恢复功能**：支持将整个文件夹及其所有子文件和子文件夹恢复到SVN版本库状态
- 在文件夹右键菜单中添加"SVN: 恢复文件夹"选项
- 使用`svn revert -R`命令进行递归恢复，确保所有修改都被撤销
- 添加安全确认对话框，防止意外操作导致数据丢失
- 支持自定义SVN根目录和过滤器规则
- 修复了单文件恢复功能中缺少revert命令的问题

### 4.3.3
- **修复missing文件提交错误**：解决了提交missing文件时出现"ENOENT: no such file or directory"错误的问题
- 优化文件状态检查逻辑，对missing文件进行特殊处理，避免尝试访问已删除的文件
- 增强错误处理机制，确保missing文件能够正常提交

### 4.3.2
- **修复文件删除检测问题**：解决了当文件被直接删除（而非通过SVN删除）时，文件夹提交无法检测到删除操作的问题
- **新增missing状态文件处理**：
  - 添加对"missing"状态文件的完整支持
  - 在文件夹提交界面中添加"丢失"文件类型过滤器
  - 自动将丢失的文件标记为删除状态
  - 在提交前自动执行`svn remove`命令处理丢失的文件
- **界面优化**：
  - 为丢失状态的文件添加恢复按钮，允许用户恢复意外删除的文件
  - 改进SVN status输出解析逻辑，提高文件状态检测的准确性
  - 添加详细的调试日志，便于问题诊断
- **AI提交日志优化**：正确处理删除和丢失状态的文件，生成准确的提交信息

### 4.3.1
- **完善文件夹上传的过滤功能**：在文件夹提交面板中集成排除系统
- 文件夹上传时自动应用过滤规则，排除不需要的文件
- 在提交面板顶部显示过滤统计信息，让用户了解有多少文件被排除
- 被排除的文件不会显示在文件列表中，提升用户体验
- 修复了上传文件夹命令中排除系统未生效的问题

### 4.3.0
- 新增本地修订版本号显示功能
- 在SVN日志面板中标记尚未更新到本地的版本
- 优化了日志界面布局，避免标记遮挡提交者名称
- 添加了SVN日志面板筛选功能的支持
- 增加了本地版本与服务器版本对比功能

### 4.2.6
   - **新增文件和文件夹过滤功能**：支持配置排除文件和文件夹，这些文件和文件夹将不参与SVN操作（提交、更新、添加等）
   - 支持glob模式匹配文件名
   - 提供配置界面管理过滤规则
   - 默认排除常见的临时文件和构建目录

### 4.2.5
   - **提交前缀存储优化**：将SVN提交前缀的存储方式从项目级别改为用户/本机级别，现在所有项目都可以共享相同的前缀历史记录

### 4.2.4
   - 目录提交界面 修复状态刷新问题

### 4.2.3

1. **对比按钮功能优化**
   - 根据文件状态显示不同的按钮文本和行为
   - 修改状态(`modified`)的文件：显示"对比"按钮，点击后显示左右对比视图
   - 其他状态的文件：显示"打开"按钮，点击后直接在编辑器中打开文件

2. **恢复按钮功能添加**
   - 为修改状态(`modified`)和删除状态(`deleted`)的文件添加"恢复"按钮
   - 点击恢复按钮会弹出确认对话框
   - 确认后执行 `svn revert` 操作
   - 操作成功后自动刷新文件状态列表

3. **界面布局优化**
   - 调整了按钮的样式和布局，使用更紧凑的设计
   - 优化了文件状态显示的宽度和对齐方式
   - 添加了按钮的 tooltip 提示文本
   - 使用 grid 布局确保各列宽度合理分配

4. **文件状态显示优化**
   - 根据不同的文件状态显示不同的颜色
   - 添加了状态图标的 tooltip 提示
   - 优化了状态文本的显示效果


### 4.1.2
- 完善单个文件上传流程
- 修改了提示词 加快了生成速度
- 增加了文件夹上传功能 

### 1.0.0 - 正式版本
- [ ] 完整功能集
- [ ] 性能优化
- [ ] 用户体验改进 