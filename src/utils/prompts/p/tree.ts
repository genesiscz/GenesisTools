export interface TreeNode {
    text: string;
    children?: TreeNode[];
}

const BRANCH = "├─ ";
const LAST = "└─ ";
const PIPE = "│  ";
const SPACE = "   ";

export function renderTree(nodes: TreeNode[], prefix = ""): string[] {
    const lines: string[] = [];

    for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]!;
        const isLast = i === nodes.length - 1;
        const connector = isLast ? LAST : BRANCH;

        lines.push(`${prefix}${connector}${node.text}`);

        if (node.children?.length) {
            const childPrefix = prefix + (isLast ? SPACE : PIPE);
            lines.push(...renderTree(node.children, childPrefix));
        }
    }

    return lines;
}
