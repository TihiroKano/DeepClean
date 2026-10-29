// glass-inventory.mjs 的类型侧写（同 shot-leak-gate：走 .d.mts，不给 tsconfig.node.json 开 allowJs）。
export interface CssRule {
  selector: string
  body: string
  media: string | null
}

export interface GlassPageRow {
  view: string
  component: string | null
  file: string | null
  skeleton: string[]
  own: string[]
  imported: string[]
  total: number
}

export interface GlassInventory {
  classes: string[]
  rows: GlassPageRow[]
  unused: string[]
  definedIn: string[]
}

export declare const GLASS_CSS: string[]

export declare function splitRules(css: string, inside?: string): CssRule[]

export declare function glassClasses(rules: CssRule[]): string[]

export declare function pageMap(appSrc: string): { view: string; component: string | null }[]

export declare function build(): GlassInventory
