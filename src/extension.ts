import * as vscode from 'vscode';

// 定义笔记的数据结构
interface NoteDefinition {
    key: string;
    value: string;
    uri: vscode.Uri;
    range: vscode.Range;
}

/**
 * [已修复] 异步函数，用于查找并解析工作区中所有的 .note 文件。
 * 这个版本使用了更健壮的正则表达式，可以正确处理多行值。
 * @returns {Promise<NoteDefinition[]>}
 */
async function parseNoteFiles(): Promise<NoteDefinition[]> {
    const allNotes: NoteDefinition[] = [];
    const noteFiles = await vscode.workspace.findFiles('**/*.des');

    for (const fileUri of noteFiles) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const text = document.getText();

        // 更健壮的正则表达式:
        // 【([^】]+)】：   -> 匹配并捕获【键】和冒号
        // ([\s\S]*?)       -> 非贪婪地捕获后面的所有字符（包括换行符），这是值
        // (?=\n【|$)       -> 匹配直到下一个【键】（在行首）或文件末尾为止
        const regex = /【([^】]+)】：([\s\S]*?)(?=\n【|$)/g;
        
        let match;
        while ((match = regex.exec(text)) !== null) {
            const key = match[1].trim();
            const value = match[2].trim();
            const position = document.positionAt(match.index);
            const line = document.lineAt(position.line);

            if (key && value) { // 确保键和值都不是空的
                allNotes.push({
                    key: key,
                    value: value,
                    uri: fileUri,
                    range: line.range
                });
            }
        }
    }
    return allNotes;
}

// --- 新功能：高亮相关的代码 ---

// 1. 定义我们想要的高亮样式。
const noteHighlightDecorationType = vscode.window.createTextEditorDecorationType({
    // 只改变文本颜色，使用主题颜色以适应不同主题
    // color: new vscode.ThemeColor('textLink.foreground'),
	color: '#ff8e59ff',
    
    // [可选] 当鼠标悬浮时，显示手形光标，增强“可点击”的提示
    cursor: 'pointer',
});

/**
 * [新功能] 更新编辑器中的高亮。
 */
async function updateDecorations(activeEditor: vscode.TextEditor | undefined) {
    if (!activeEditor || activeEditor.document.languageId !== 'outline') {
        // 如果没有活动编辑器，或者当前语言不是 outline，则不做任何事
        return;
    }

    const allNotes = await parseNoteFiles();
    const keys = allNotes.map(note => note.key);
    if (keys.length === 0) {
        // 如果没有找到任何笔记，清除已有高亮并返回
        activeEditor.setDecorations(noteHighlightDecorationType, []);
        return;
    }
    
    const text = activeEditor.document.getText();
    const decorationsArray: vscode.DecorationOptions[] = [];

    // 遍历所有笔记的键
    for (const key of keys) {
        // 创建一个全局正则表达式来查找所有出现的键
        const regex = new RegExp(key, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const startPos = activeEditor.document.positionAt(match.index);
            const endPos = activeEditor.document.positionAt(match.index + key.length);
            
            const decoration = {
                range: new vscode.Range(startPos, endPos),
                // hoverMessage 也可以在这里添加，但我们已经有 HoverProvider 了，所以保持简洁
            };
            decorationsArray.push(decoration);
        }
    }
    
    // 将计算出的所有高亮一次性应用到编辑器
    activeEditor.setDecorations(noteHighlightDecorationType, decorationsArray);
}


// 插件激活函数
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "note-outline-linker" is now active!');

    // 定义我们支持的语言ID
    const selector = { language: 'outline', scheme: 'file' };

    // 将所有需要被销毁的监听器和提供器都推入 context.subscriptions
    context.subscriptions.push(
        // 1. 注册悬浮提示提供器
        vscode.languages.registerHoverProvider(selector, {
            async provideHover(document, position, token) {
                const allNotes = await parseNoteFiles();
                const lineText = document.lineAt(position.line).text;

                for (const note of allNotes) {
                    // 使用贪婪匹配来查找，避免只匹配单词的一部分
                    const regex = new RegExp(note.key, 'g');
                    let match;
                    while ((match = regex.exec(lineText)) !== null) {
                        const startPos = new vscode.Position(position.line, match.index);
                        const endPos = new vscode.Position(position.line, match.index + note.key.length);
                        const hoverRange = new vscode.Range(startPos, endPos);
                        
                        if (hoverRange.contains(position)) {
                            const markdownString = new vscode.MarkdownString();
                            markdownString.appendCodeblock(note.value, 'text'); // 使用代码块样式显示值，保留换行
                            markdownString.appendMarkdown(`\n\n*来源: \`${vscode.workspace.asRelativePath(note.uri)}\`*`);
                            return new vscode.Hover(markdownString, hoverRange);
                        }
                    }
                }
                return null;
            }
        }),

        // 2. 注册定义跳转提供器
        vscode.languages.registerDefinitionProvider(selector, {
            async provideDefinition(document, position, token) {
                const allNotes = await parseNoteFiles();
                const lineText = document.lineAt(position.line).text;

                for (const note of allNotes) {
                    const regex = new RegExp(note.key, 'g');
                    let match;
                    while ((match = regex.exec(lineText)) !== null) {
                        const startPos = new vscode.Position(position.line, match.index);
                        const endPos = new vscode.Position(position.line, match.index + note.key.length);
                        const definitionRange = new vscode.Range(startPos, endPos);

                        if (definitionRange.contains(position)) {
                            return new vscode.Location(note.uri, note.range);
                        }
                    }
                }
                return null;
            }
        }),

        // 3. 注册当活动编辑器改变时的监听器
        vscode.window.onDidChangeActiveTextEditor(editor => {
            updateDecorations(editor);
        }),

        // 4. 注册当文档保存时的监听器
        vscode.workspace.onDidSaveTextDocument(document => {
            if (vscode.window.activeTextEditor) {
                updateDecorations(vscode.window.activeTextEditor);
            }
        })
    );

    // --- 首次激活时，立即为当前打开的文件更新一次高亮 ---
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }
}

// 插件停用函数
export function deactivate() {}