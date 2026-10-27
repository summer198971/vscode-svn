(function() {
    const vscode = acquireVsCodeApi();

    // 是否允许空提交信息（来自扩展配置）
    const allowEmptyCommitMessage = {{ALLOW_EMPTY_COMMIT_MESSAGE}};

    // 从状态中恢复或初始化
    const previousState = vscode.getState() || { 
        selectedFiles: [],
        enabledTypes: ['modified', 'added', 'deleted', 'unversioned', 'missing'],
        selectedExtensions: []
    };
    
    let selectedFiles = new Set(previousState.selectedFiles);
    let enabledTypes = new Set(previousState.enabledTypes);
    let selectedExtensions = new Set(previousState.selectedExtensions);
    
    // 保存状态的函数
    function saveState() {
        vscode.setState({
            selectedFiles: Array.from(selectedFiles),
            enabledTypes: Array.from(enabledTypes),
            selectedExtensions: Array.from(selectedExtensions)
        });
    }
    
    // 在状态变化的地方调用 saveState
    function toggleFileType(type) {
        if (enabledTypes.has(type)) {
            enabledTypes.delete(type);
            document.getElementById(type + '-checkbox').checked = false;
        } else {
            enabledTypes.add(type);
            document.getElementById(type + '-checkbox').checked = true;
        }
        updateFileList();
        saveState();  // 保存状态
    }
    
    // 修改文件选择函数
    function toggleAllFiles(checked) {
        const visibleFiles = Array.from(document.querySelectorAll('.file-item'))
            .filter(item => item.style.display !== 'none')
            .map(item => item.getAttribute('data-path'));
        
        if (checked) {
            visibleFiles.forEach(path => selectedFiles.add(path));
        } else {
            visibleFiles.forEach(path => selectedFiles.delete(path));
        }
        updateCheckboxes();
        saveState();  // 保存状态
    }
    
    // 同样在文件项的点击事件中添加状态保存
    function initializeFileItemEvents() {
        document.querySelectorAll('.file-item').forEach(item => {
            const checkbox = item.querySelector('.file-checkbox');
            const diffButton = item.querySelector('.diff-button');
            const sideBySideButton = item.querySelector('.side-by-side-button');
            const revertButton = item.querySelector('.revert-button');
            const filePath = item.getAttribute('data-path');

            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        selectedFiles.add(filePath);
                    } else {
                        selectedFiles.delete(filePath);
                    }
                    updateSelectAllCheckbox();
                    saveState();  // 保存状态
                });
            }

            if (diffButton) {
                diffButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showDiff(filePath);
                });
            }

            if (sideBySideButton) {
                sideBySideButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showSideBySideDiff(filePath);
                });
            }

            if (revertButton) {
                revertButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    revertFile(filePath);
                });
            }

            // 双击文件项快速打开差异对比（issue #11）
            // 排除 checkbox / 操作按钮 / 链接等交互元素，避免误触发
            item.addEventListener('dblclick', (e) => {
                const target = e.target;
                if (target && target.closest && target.closest(
                    '.file-checkbox, .diff-button, .side-by-side-button, .revert-button, button, a, input'
                )) {
                    return;
                }
                // 防止双击选中文本造成视觉干扰
                if (window.getSelection) {
                    const sel = window.getSelection();
                    if (sel && sel.removeAllRanges) sel.removeAllRanges();
                }
                showDiff(filePath);
            });

            // 视觉提示：鼠标悬停时显示可双击
            item.style.cursor = item.style.cursor || 'default';
            item.title = item.title || '双击打开差异对比';
        });
    }
    
    // 在扩展筛选器变化时也保存状态
    function initializeExtensionFilter() {
        // 为新的标签式筛选添加事件监听
        const extensionTagsContainer = document.getElementById('extensionTagsContainer');
        const selectAllBtn = document.getElementById('selectAllExtensions');
        const clearAllBtn = document.getElementById('clearAllExtensions');
        
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => {
                // 选择所有后缀
                const allTags = document.querySelectorAll('.extension-tag');
                allTags.forEach(tag => {
                    const ext = tag.getAttribute('data-extension');
                    selectedExtensions.add(ext);
                    tag.classList.add('selected');
                });
                updateFileList();
                saveState();
            });
        }
        
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', () => {
                // 清除所有选择
                selectedExtensions.clear();
                document.querySelectorAll('.extension-tag').forEach(tag => {
                    tag.classList.remove('selected');
                });
                updateFileList();
                saveState();
            });
        }
        
        // 保持对旧select元素的兼容性（如果存在）
        const extensionFilter = document.getElementById('extensionFilter');
        if (extensionFilter) {
            extensionFilter.addEventListener('change', (e) => {
                selectedExtensions.clear();
                Array.from(e.target.selectedOptions).forEach(option => {
                    selectedExtensions.add(option.value);
                });
                updateFileList();
                saveState();
            });
        }
    }
    
    function initializeEventListeners() {
        // 类型过滤复选框
        document.getElementById('modified-checkbox').addEventListener('change', () => toggleFileType('modified'));
        document.getElementById('added-checkbox').addEventListener('change', () => toggleFileType('added'));
        document.getElementById('deleted-checkbox').addEventListener('change', () => toggleFileType('deleted'));
        document.getElementById('unversioned-checkbox').addEventListener('change', () => toggleFileType('unversioned'));
        document.getElementById('missing-checkbox').addEventListener('change', () => toggleFileType('missing'));

        // 全选复选框
        document.getElementById('selectAll').addEventListener('change', (e) => toggleAllFiles(e.target.checked));

        // 前缀相关
        document.getElementById('prefixSelect').addEventListener('change', updateCommitMessage);
        document.getElementById('applyPrefixButton').addEventListener('click', applyPrefix);

        // 提交按钮
        document.getElementById('submitButton').addEventListener('click', submitCommit);
        document.getElementById('generateAIButton').addEventListener('click', generateAILog);

        // 初始化页面状态
        updateFileList();
        updateCheckboxes();
    }

    function updateFileList() {
        const fileItems = document.querySelectorAll('.file-item');
        let visibleCount = 0;
        
        fileItems.forEach(item => {
            const type = item.getAttribute('data-type');
            const fileName = item.querySelector('.file-name').textContent;
            const ext = fileName.includes('.') ? 
                '.' + fileName.split('.').pop().toLowerCase() : 
                '(无后缀)';
            
            const typeMatch = enabledTypes.has(type);
            const extensionMatch = selectedExtensions.size === 0 || selectedExtensions.has(ext);
            
            if (typeMatch && extensionMatch) {
                item.style.display = '';
                visibleCount++;
            } else {
                item.style.display = 'none';
                const filePath = item.getAttribute('data-path');
                if (selectedFiles.has(filePath)) {
                    selectedFiles.delete(filePath);
                }
            }
        });
        
        updateSelectAllCheckbox();
    }

    function updateCheckboxes() {
        document.querySelectorAll('.file-item').forEach(item => {
            const filePath = item.getAttribute('data-path');
            const checkbox = item.querySelector('.file-checkbox');
            if (checkbox) {
                checkbox.checked = selectedFiles.has(filePath);
            }
        });
        updateSelectAllCheckbox();
    }

    function updateSelectAllCheckbox() {
        const visibleFiles = Array.from(document.querySelectorAll('.file-item'))
            .filter(item => item.style.display !== 'none')
            .map(item => item.getAttribute('data-path'));
        
        const allChecked = visibleFiles.length > 0 && 
            visibleFiles.every(path => selectedFiles.has(path));
        
        const selectAllCheckbox = document.getElementById('selectAll');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.disabled = visibleFiles.length === 0;
        }
    }

    function showDiff(filePath) {
        vscode.postMessage({ command: 'showDiff', file: filePath });
    }

    function showSideBySideDiff(filePath) {
        vscode.postMessage({ command: 'showSideBySideDiff', file: filePath });
    }

    function submitCommit() {
        const message = document.getElementById('commitMessage').value;
        if (!message && !allowEmptyCommitMessage) {
            vscode.postMessage({
                command: 'showError',
                text: '请输入提交信息'
            });
            return;
        }
        
        const selectedFilesList = Array.from(selectedFiles);
        if (selectedFilesList.length === 0) {
            vscode.postMessage({
                command: 'showError',
                text: '请选择要提交的文件'
            });
            return;
        }

        vscode.postMessage({
            command: 'commit',
            message: message,
            files: selectedFilesList
        });
    }

    function generateAILog() {
        vscode.postMessage({ command: 'generateAILog' });
    }

    function applyPrefix() {
        const prefix = document.getElementById('prefixInput').value.trim();
        if (prefix) {
            vscode.postMessage({
                command: 'savePrefix',
                prefix: prefix
            });
            
            const message = document.getElementById('commitMessage');
            const currentMessage = message.value.trim();
            
            const lines = currentMessage.split('\n');
            const newMessage = prefix + '\n' + (lines.length > 1 ? lines.slice(1).join('\n') : currentMessage);
            
            message.value = newMessage;
        }
    }

    function updateCommitMessage() {
        const prefix = document.getElementById('prefixSelect').value;
        if (prefix) {
            document.getElementById('prefixInput').value = prefix;
        }
    }

    function revertFile(filePath) {
        vscode.postMessage({ command: 'revertFile', file: filePath });
    }

    function updateExtensionFilter() {
        const extensions = new Map(); // 使用Map来统计每个后缀的文件数量
        
        // 遍历所有文件项，收集所有后缀及其数量
        document.querySelectorAll('.file-item').forEach(item => {
            const fileName = item.querySelector('.file-name').textContent;
            const ext = fileName.includes('.') ? 
                '.' + fileName.split('.').pop().toLowerCase() : 
                '(无后缀)';
            
            extensions.set(ext, (extensions.get(ext) || 0) + 1);
        });

        // 更新标签式界面
        const extensionTagsContainer = document.getElementById('extensionTagsContainer');
        if (extensionTagsContainer) {
            const selectedValues = Array.from(selectedExtensions);
            
            // 生成标签HTML
            const tagsHtml = Array.from(extensions.entries())
                .sort(([a], [b]) => a.localeCompare(b)) // 按后缀名排序
                .map(([ext, count]) => {
                    const isSelected = selectedValues.includes(ext);
                    const selectedClass = isSelected ? 'selected' : '';
                    return `
                        <div class="extension-tag ${selectedClass}" 
                             data-extension="${ext}" 
                             title="点击切换选择状态">
                            ${ext}
                            <span class="file-count">(${count})</span>
                        </div>
                    `;
                })
                .join('');
            
            extensionTagsContainer.innerHTML = tagsHtml;
            
            // 为每个标签添加点击事件
            extensionTagsContainer.querySelectorAll('.extension-tag').forEach(tag => {
                tag.addEventListener('click', () => {
                    const ext = tag.getAttribute('data-extension');
                    
                    if (selectedExtensions.has(ext)) {
                        selectedExtensions.delete(ext);
                        tag.classList.remove('selected');
                    } else {
                        selectedExtensions.add(ext);
                        tag.classList.add('selected');
                    }
                    
                    updateFileList();
                    saveState();
                });
            });
        }

        // 保持对旧select元素的兼容性（如果存在）
        const extensionFilter = document.getElementById('extensionFilter');
        if (extensionFilter) {
            const selectedValues = Array.from(selectedExtensions);
            extensionFilter.innerHTML = Array.from(extensions.keys())
                .sort()
                .map(ext => `<option value="${ext}" ${selectedValues.includes(ext) ? 'selected' : ''}>${ext}</option>`)
                .join('');
        }
    }

    // 监听消息
    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'setCommitMessage':
                document.getElementById('commitMessage').value = message.message;
                break;
            case 'getSelectedFiles':
                vscode.postMessage({
                    command: 'selectedFiles',
                    files: Array.from(selectedFiles)
                });
                break;
            case 'getCurrentPrefix':
                const prefixInput = document.getElementById('prefixInput');
                vscode.postMessage({
                    command: 'currentPrefix',
                    prefix: prefixInput ? prefixInput.value.trim() : ''
                });
                break;
            case 'setGeneratingStatus':
                const aiButton = document.getElementById('generateAIButton');
                if (message.status) {
                    aiButton.disabled = true;
                    aiButton.textContent = '生成中...';
                } else {
                    aiButton.disabled = false;
                    aiButton.textContent = '使用AI生成提交日志';
                }
                break;
        }
    });

    // 页面加载完成后初始化
    document.addEventListener('DOMContentLoaded', () => {
        initializeEventListeners();
        initializeFileItemEvents();
        initializeExtensionFilter();
        updateExtensionFilter();
        updateFileList();
        updateCheckboxes();
    });
})(); 