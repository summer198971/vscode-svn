import * as path from 'path';

/**
 * svn status 文本输出解析结果
 */
export interface ParsedStatusFile {
    /** 绝对路径 */
    path: string;
    /** svn 状态字符（M/A/D/?/! 等） */
    status: string;
    /** 归一化的变更类型 */
    type: 'modified' | 'added' | 'deleted' | 'unversioned' | 'conflict' | 'missing';
    /** 相对工作副本的显示路径 */
    displayName: string;
    /** 所属 changelist 名称（未分组则为 undefined） */
    changelist?: string;
}

/**
 * 解析 `svn status` 的文本输出
 *
 * 处理内容：
 * - 常规状态行（M/A/D/?/!/C 等）
 * - changelist 分组：`--- Changelist '名称':` 头行之后的文件归入该分组
 * - 过滤树冲突详情行（> 开头）、svn:externals 提示行与占位行（issue #19）
 * - 跳过仅有 changelist 归属而无实际变更的文件（状态列为空白）
 *
 * @param statusResult svn status 命令的原始输出
 * @param folderPath 工作副本路径（用于拼出绝对路径）
 */
export function parseSvnStatusOutput(statusResult: string, folderPath: string): ParsedStatusFile[] {
    const files: ParsedStatusFile[] = [];
    let currentChangelist: string | undefined;

    const lines = statusResult.split('\n').map(line => line.replace(/\r$/, ''));
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }

        // changelist 分组头行，如：--- Changelist 'my-feature':
        const changelistHeader = line.match(/^--- Changelist '([^']+)':/);
        if (changelistHeader) {
            currentChangelist = changelistHeader[1];
            continue;
        }

        // 过滤树冲突的详细信息行
        if (line.startsWith('>')) {
            continue;
        }
        // 过滤 svn:externals 提示行（issue #19）
        if (line.startsWith('Performing status on external item')) {
            continue;
        }
        // 过滤外部链接占位行（状态字符为 'X'）以及第7列为 'X' 的外部链接定义行
        if (line[0] === 'X') {
            continue;
        }
        if (line.length > 6 && line[6] === 'X') {
            continue;
        }
        // 状态列为空白的行：文件无实际变更，仅因 changelist 归属被列出，跳过
        if (line[0] === ' ') {
            continue;
        }

        // 常规状态行：第一列为状态字符，其后为文件路径
        const status = line[0];
        const match = line.match(/^.\s+(.+)$/);
        const filePath = (match ? match[1] : line.substring(1)).trim();
        if (!filePath) {
            continue;
        }

        let type: ParsedStatusFile['type'];
        switch (status) {
            case 'M':
                type = 'modified';
                break;
            case 'A':
                type = 'added';
                break;
            case 'D':
                type = 'deleted';
                break;
            case 'C':
                type = 'conflict';
                break;
            case '!':
                type = 'missing';
                break;
            default:
                type = 'unversioned';
        }

        files.push({
            path: path.resolve(folderPath, filePath),
            status,
            type,
            displayName: filePath,
            changelist: currentChangelist
        });
    }

    return files;
}
