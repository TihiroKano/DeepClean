// shot-leak-gate.mjs 的类型侧写。走 .d.mts 而不是给 tsconfig.node.json 开 allowJs：
// 后者是一个全局编译开关，为了一个测试把它打开，代价是让整棵 scripts/ 里的 JS 都进 program。
export declare const MAX_SHOT_WIDTH: number

export declare function readPngSize(path: string): { w: number; h: number }

export interface ShotLeakOffender {
  name: string
  w: number
  h: number
}

export declare function scanShots(dir: string, limit: number, root?: string): ShotLeakOffender[]

export declare const ALLOW_LIST: Record<string, string>

export declare function repoRoot(): string

export declare function offenders(limit?: number): ShotLeakOffender[]
