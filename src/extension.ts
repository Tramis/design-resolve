import * as vscode from 'vscode';

// ================================================================= //
// 1. 数据结构与核心解析逻辑
// ================================================================= //

/**
 * 定义一个接口，用于存储从 .note 文件中解析出的每一条笔记的数据结构。
 */
interface NoteDefinition {
    key: string;
    value: string;
    uri: vscode.Uri;
    range: vscode.Range;
}

/**
 * 异步函数，用于查找并解析工作区中所有的 .note 文件。
 * 支持读取【键】下方的多行文本作为其值。
 * @returns {Promise<NoteDefinition[]>} 返回一个包含所有解析后笔记对象的数组。
 */
async function parseNoteFiles(): Promise<NoteDefinition[]> {
    const allNotes: NoteDefinition[] = [];
    const noteFiles = await vscode.workspace.findFiles('**/*.des');

    for (const fileUri of noteFiles) {
        const document = await vscode.workspace.openTextDocument(fileUri);
        const text = document.getText();
        
        // 正则表达式: 匹配【键】：后直到下一个【键】或文件末尾的所有内容
        const regex = /【([^】]+)】([\s\S]*?)(?=\n【|$)/g;
        
        let match;
        while ((match = regex.exec(text)) !== null) {
            const key = match[1].trim();
            const value = match[2].trim();
            const position = document.positionAt(match.index);
            const line = document.lineAt(position.line);

            if (key && value) {
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

// ================================================================= //
// 2. 动态高亮逻辑
// ================================================================= //

// 将装饰器类型定义为一个可变变量，以便在配置更改时更新它
let noteHighlightDecorationType: vscode.TextEditorDecorationType | undefined;

/**
 * 读取用户设置，并创建或更新高亮装饰器。
 */
function createOrUpdateDecorationType() {
    // 如果旧的装饰器已存在，先销毁它，释放资源
    if (noteHighlightDecorationType) {
        noteHighlightDecorationType.dispose();
    }

    // 从 VS Code 的设置中读取我们定义好的颜色值
    const config = vscode.workspace.getConfiguration('highlight-color');
    // 提供一个备用默认值，以防万一
    const color = config.get<string>('highlight.color', 'rgba(207, 174, 174, 0.82)');

    // 使用读取到的颜色，创建一个新的装饰器类型
    noteHighlightDecorationType = vscode.window.createTextEditorDecorationType({
        color: color,
        borderRadius: '2px',
    });
}

/**
 * 更新编辑器中的高亮。
 */
async function updateDecorations(activeEditor: vscode.TextEditor | undefined) {
    if (!activeEditor || activeEditor.document.languageId !== 'outline' || !noteHighlightDecorationType) {
        return;
    }

    const allNotes = await parseNoteFiles();
    const keys = allNotes.map(note => note.key);
    if (keys.length === 0) {
        activeEditor.setDecorations(noteHighlightDecorationType, []);
        return;
    }
    
    const text = activeEditor.document.getText();
    const decorationsArray: vscode.DecorationOptions[] = [];

    for (const key of keys) {
        const regex = new RegExp(key, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const startPos = activeEditor.document.positionAt(match.index);
            const endPos = activeEditor.document.positionAt(match.index + key.length);
            const decoration = { range: new vscode.Range(startPos, endPos) };
            decorationsArray.push(decoration);
        }
    }
    
    activeEditor.setDecorations(noteHighlightDecorationType, decorationsArray);
}

// ================================================================= //
// 3. 插件激活与生命周期管理
// ================================================================= //

/**
 * 插件的激活函数，当插件被激活时 VS Code 会调用此函数。
 */
export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "design-resolve" is now active!');

    // 插件激活时，立即根据用户设置创建初始的装饰器样式
    createOrUpdateDecorationType();

    // 定义我们支持的语言ID
    const selector = { language: 'outline', scheme: 'file' };

    // 将所有需要被销毁的监听器和提供器都推入 context.subscriptions
    context.subscriptions.push(

        // --- 悬浮提示提供器 (完整版) ---
        vscode.languages.registerHoverProvider(selector, {
            async provideHover(document, position, token) {
                const allNotes = await parseNoteFiles();
                const lineText = document.lineAt(position.line).text;

                for (const note of allNotes) {
                    const regex = new RegExp(note.key, 'g');
                    let match;
                    while ((match = regex.exec(lineText)) !== null) {
                        const startPos = new vscode.Position(position.line, match.index);
                        const endPos = new vscode.Position(position.line, match.index + note.key.length);
                        const hoverRange = new vscode.Range(startPos, endPos);
                        
                        if (hoverRange.contains(position)) {
                            const markdownString = new vscode.MarkdownString();
                            markdownString.appendCodeblock(note.value, 'text');
                            markdownString.appendMarkdown(`\n\n*from: \`${vscode.workspace.asRelativePath(note.uri)}\`*`);
                            return new vscode.Hover(markdownString, hoverRange);
                        }
                    }
                }
                return null;
            }
        }),

        // --- 定义跳转提供器 (完整版) ---
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

        // --- 事件监听器 ---
        vscode.window.onDidChangeActiveTextEditor(editor => {
            updateDecorations(editor);
        }),

        vscode.workspace.onDidSaveTextDocument(document => {
            if (vscode.window.activeTextEditor) {
                updateDecorations(vscode.window.activeTextEditor);
            }
        }),
        
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('design-resolve.highlight.color')) {
                createOrUpdateDecorationType();
                if (vscode.window.activeTextEditor) {
                    updateDecorations(vscode.window.activeTextEditor);
                }
            }
        })
    );

    // 为首次打开的文件更新一次高亮
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }
}

/**
 * 插件的停用函数，当插件被禁用或 VS Code 关闭时调用。
 */
export function deactivate() {
    // 插件停用时，销毁装饰器，清理样式
    if (noteHighlightDecorationType) {
        noteHighlightDecorationType.dispose();
    }
}