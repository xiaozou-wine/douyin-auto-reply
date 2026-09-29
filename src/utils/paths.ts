import path from 'node:path';

/**
 * 运行时以进程工作目录作为项目根目录；Docker 内为 /app，本地为仓库根目录。
 */
export const projectRoot = process.cwd();

export function resolveFromRoot(relativeOrAbsolutePath: string): string {
  return path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.resolve(projectRoot, relativeOrAbsolutePath);
}

export function runtimePath(...segments: string[]): string {
  return path.resolve(projectRoot, 'runtime', ...segments);
}
